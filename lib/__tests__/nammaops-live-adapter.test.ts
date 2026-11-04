import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaskDatabase } from "../server/task-db.mjs";
import { AgentProfiles } from "../server/agent-profiles.mjs";
import { AgentTasks } from "../server/agent-tasks.mjs";
import { Specializations } from "../server/developer-config.mjs";
import { McpServers } from "../server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  WORKFLOW_PRINCIPALS,
} from "../server/mcp-governance.mjs";
import { createNammaOps } from "../server/nammaops/index.mjs";
import { loadBinding } from "../server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../server/nammaops/workforce.mjs";
import {
  ADAPTER_TOOLS,
  HVGERP_READS,
  DOC_LIST_FIELDS,
  createAdapter,
  createAdapterServer,
} from "../mcp/hvgerp-adapter-server.mjs";

// UNIT/FIXTURE ONLY. hvgerp-mcp is replaced by an in-memory double that answers in the response
// shapes captured from the real pinned 3.7.0 server. Nothing here talks to ERPNext.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const list = (data: Any[], extra: Any = {}) => ({
  doctype: "X",
  count: data.length,
  returned: data.length,
  has_more: false,
  data,
  ...extra,
});

function fakeHvgerp({ pageLimit = Infinity }: { pageLimit?: number } = {}) {
  const calls: Array<{ name: string; arguments: Any }> = [];
  const invoices: Any[] = [
    sinv("SINV-1", "2026-11-01", 1, "Overdue", [["RICE", 2, 800]]),
    sinv("SINV-2", "2026-11-01", 1, "Paid", [["MILK", 10, 300]]),
    sinv("SINV-3", "2026-11-01", 0, "Draft", [["MILK", 99, 9999]]),
    sinv("SINV-4", "2026-11-01", 2, "Cancelled", [["MILK", 98, 9998]]),
    sinv("SINV-5", "2026-10-31", 1, "Overdue", [["SUGAR", 5, 250]]),
  ];
  function sinv(name: string, date: string, docstatus: number, status: string, lines: Any[]) {
    return {
      name,
      posting_date: date,
      docstatus,
      status,
      customer: "Walk-in Customer",
      grand_total: lines.reduce((sum, [, , amount]) => sum + amount, 0),
      items: lines.map(([item_code, qty, amount]) => ({
        item_code,
        qty,
        amount,
        rate: amount / qty,
      })),
    };
  }
  const ledger = [
    {
      item_code: "MILK",
      posting_date: "2026-10-30",
      qty_after_transaction: 40,
      actual_qty: -2,
      voucher_type: "Sales Invoice",
    },
    {
      item_code: "MILK",
      posting_date: "2026-10-31",
      qty_after_transaction: 0,
      actual_qty: -40,
      voucher_type: "Sales Invoice",
    },
    {
      item_code: "RICE",
      posting_date: "2026-11-01",
      qty_after_transaction: 14,
      actual_qty: -2,
      voucher_type: "Sales Invoice",
    },
  ];
  const handlers: Record<string, (args: Any) => Any> = {
    erpnext_item_list: () =>
      list([
        {
          name: "MILK",
          item_code: "MILK",
          item_name: "Toned Milk",
          item_group: "Dairy",
          stock_uom: "Nos",
        },
        {
          name: "RICE",
          item_code: "RICE",
          item_name: "Sona Rice 5kg",
          item_group: "Staples",
          stock_uom: "Bag",
        },
        {
          name: "SUGAR",
          item_code: "SUGAR",
          item_name: "Sugar 1kg",
          item_group: "Staples",
          stock_uom: "Nos",
        },
      ]),
    erpnext_item_get: ({ name }) => ({
      data: {
        name,
        reorder_levels:
          name === "MILK"
            ? [
                { warehouse: "Stores", warehouse_reorder_level: 30, warehouse_reorder_qty: 60 },
                { warehouse: "Shop", warehouse_reorder_level: 10, warehouse_reorder_qty: 20 },
              ]
            : name === "RICE"
              ? [{ warehouse: "Stores", warehouse_reorder_level: 10, warehouse_reorder_qty: 25 }]
              : [],
      },
    }),
    erpnext_warehouse_list: () =>
      list([
        { name: "Stores", company: "Shop Co" },
        { name: "Shop", company: "Shop Co" },
      ]),
    erpnext_stock_balance: () =>
      list([
        {
          item_code: "MILK",
          warehouse: "Stores",
          actual_qty: 20,
          reserved_qty: 0,
          projected_qty: 20,
        },
        {
          item_code: "RICE",
          warehouse: "Stores",
          actual_qty: 14,
          reserved_qty: 0,
          projected_qty: 14,
        },
        {
          item_code: "SUGAR",
          warehouse: "Stores",
          actual_qty: 30,
          reserved_qty: 0,
          projected_qty: 30,
        },
      ]),
    erpnext_sales_invoice_list: ({ date_from, date_to }) => {
      const rows = invoices.filter(
        (row) => row.posting_date >= date_from && row.posting_date <= date_to,
      );
      const page = rows.slice(0, pageLimit);
      return list(
        page.map(({ name, posting_date, status, grand_total }) => ({
          name,
          posting_date,
          status,
          grand_total,
        })),
        { count: rows.length, has_more: rows.length > pageLimit },
      );
    },
    erpnext_sales_invoice_get: ({ name }) => ({ data: invoices.find((row) => row.name === name) }),
    erpnext_supplier_list: () => list([{ name: "Alpha Traders" }, { name: "Beta Dairy" }]),
    erpnext_supplier_quotation_list: () =>
      list([
        { name: "SQ-1", supplier: "Alpha Traders", status: "Submitted" },
        { name: "SQ-2", supplier: "Beta Dairy", status: "Submitted" },
      ]),
    erpnext_customer_list: () => list([{ name: "Walk-in Customer" }]),
    erpnext_gl_entry_list: () => list([{ account: "Sales - X", credit: 1100, debit: 0 }]),
    erpnext_purchase_invoice_list: () => list([{ name: "PINV-1", grand_total: 500 }]),
    erpnext_purchase_order_list: () =>
      list([
        { name: "PO-1", status: "Draft" }, // submitted but labelled Draft (docstatus 1)
        { name: "PO-2", status: "Draft" }, // a real draft
        { name: "PO-3", status: "Completed" },
      ]),
    erpnext_purchase_order_get: ({ name }) => ({
      data: {
        name,
        supplier: "Alpha Traders",
        docstatus: name === "PO-1" ? 1 : 0,
        schedule_date: "2026-11-03",
        items: [{ item_code: "SUGAR", qty: 20, received_qty: 5 }],
      },
    }),
    erpnext_financial_report: () => ({
      report_summary: [
        { label: "Total Income", value: 1100 },
        { label: "Total Expense", value: 700 },
        { label: "Net Profit", value: 400 },
      ],
    }),
    erpnext_doc_get: ({ doctype, name }) => ({
      data:
        doctype === "Supplier Quotation"
          ? {
              name,
              docstatus: 1,
              supplier: name === "SQ-1" ? "Alpha Traders" : "Beta Dairy",
              valid_till: "2026-11-30",
              items: [
                {
                  item_code: "MILK",
                  rate: name === "SQ-1" ? 24 : 23.5,
                  qty: 60,
                  lead_time_days: name === "SQ-1" ? 1 : 2,
                },
              ],
            }
          : { name },
    }),
    erpnext_doc_list: ({ doctype, filters = [] }) => {
      if (doctype === "POS Invoice") return list([]);
      if (doctype === "Item Price")
        return list([{ item_code: "MILK", price_list: "Standard Buying", price_list_rate: 25 }]);
      if (doctype === "Bin")
        return list([
          { item_code: "MILK", warehouse: "Stores - X", actual_qty: 10, stock_value: 250 },
          { item_code: "MILK", warehouse: "Back - X", actual_qty: 10, stock_value: 230 },
        ]);
      if (doctype === "Batch")
        return list([{ name: "B1", item: "MILK", batch_qty: 6, expiry_date: "2026-11-04" }]);
      if (doctype === "Sales Invoice")
        return list([
          {
            name: "SINV-1",
            customer: "Lakshmi",
            posting_date: "2026-10-01",
            due_date: "2026-10-31",
            grand_total: 500,
            outstanding_amount: 200,
          },
        ]);
      if (doctype === "Purchase Invoice")
        return list([
          {
            name: "PINV-1",
            supplier: "Dairy",
            posting_date: "2026-10-01",
            due_date: null,
            grand_total: 900,
            outstanding_amount: 900,
          },
        ]);
      const from = filters.find((row: Any) => row[1] === ">=")?.[2] ?? "0000";
      const to = filters.find((row: Any) => row[1] === "<=")?.[2] ?? "9999";
      return list(ledger.filter((row) => row.posting_date >= from && row.posting_date <= to));
    },
  };
  const readOnly = new Set(Object.keys(handlers));
  return {
    calls,
    asReadOnly: readOnly,
    listTools: async () => ({
      tools: [
        ...HVGERP_READS.map((name) => ({ name, annotations: { readOnlyHint: true } })),
        { name: "erpnext_doc_submit", annotations: { destructiveHint: true } },
        { name: "erpnext_purchase_order_create", annotations: {} },
      ],
    }),
    callTool: async ({ name, arguments: args }: Any) => {
      calls.push({ name, arguments: args });
      const handler = handlers[name];
      if (!handler) return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
      return { content: [{ type: "text", text: JSON.stringify(handler(args ?? {})) }] };
    },
  };
}

const parse = (result: Any) => JSON.parse(result.content[0].text);

describe("hvgerp adapter (unit, fake hvgerp)", () => {
  it("offers only read tools and no create, update, submit or cancel", () => {
    expect(ADAPTER_TOOLS.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(ADAPTER_TOOLS.map((tool) => tool.name).join(" ")).not.toMatch(
      /create|update|submit|cancel|delete/,
    );
    expect(HVGERP_READS.join(" ")).not.toMatch(/create|update|submit|cancel|delete/);
  });

  it("refuses to run if hvgerp does not mark a needed tool read-only", async () => {
    const hv: Any = fakeHvgerp();
    hv.listTools = async () => ({
      tools: HVGERP_READS.map((name) => ({
        name,
        annotations: name === "erpnext_doc_get" ? {} : { readOnlyHint: true },
      })),
    });
    const adapter = createAdapter({ client: hv });
    await expect(adapter.call("list_warehouses")).rejects.toThrow(
      /does not mark erpnext_doc_get read-only/,
    );
    expect(hv.calls).toEqual([]);
  });

  it("returns items with summed reorder levels and honest gaps", async () => {
    const hv: Any = fakeHvgerp();
    const { items } = parse(await createAdapter({ client: hv }).call("list_items"));
    expect(items.find((row: Any) => row.item_code === "MILK")).toMatchObject({
      reorder_level: 40,
      reorder_qty: 80,
      aliases: ["Dairy"],
    });
    // No reorder row means no reorder level: it is not defaulted to zero.
    expect(items.find((row: Any) => row.item_code === "SUGAR").reorder_level).toBeUndefined();
  });

  it("skips draft and cancelled invoices, labels the source, and caches submitted details", async () => {
    const hv: Any = fakeHvgerp();
    const adapter = createAdapter({ client: hv });
    const first = parse(
      await adapter.call("list_sales_invoices", { from_date: "2026-11-01", to_date: "2026-11-01" }),
    );
    expect(first.source).toBe("erpnext_live");
    expect(first.invoices.map((row: Any) => row.name)).toEqual(["SINV-1", "SINV-2"]);
    expect(first.invoices[0]).toMatchObject({
      is_pos: false,
      grand_total: 800,
      items: [{ item_code: "RICE", qty: 2, amount: 800 }],
    });
    await adapter.call("list_sales_invoices", { from_date: "2026-11-01", to_date: "2026-11-01" });
    expect(hv.calls.filter((call: Any) => call.name === "erpnext_sales_invoice_get")).toHaveLength(
      2,
    );
  });

  it("splits a date window when ERPNext returns a partial list, and never returns a short one", async () => {
    const hv: Any = fakeHvgerp({ pageLimit: 4 });
    const adapter = createAdapter({ client: hv });
    const lines = parse(
      await adapter.call("list_sales_lines", { from_date: "2026-10-31", to_date: "2026-11-01" }),
    );
    expect(lines.lines.map((row: Any) => row.document).sort()).toEqual([
      "SINV-1",
      "SINV-2",
      "SINV-5",
    ]);
    const stuck: Any = fakeHvgerp({ pageLimit: 1 });
    await expect(
      createAdapter({ client: stuck }).call("list_sales_invoices", {
        from_date: "2026-11-01",
        to_date: "2026-11-01",
      }),
    ).rejects.toThrow(/More records on 2026-11-01/);
  });

  it("counts a submitted order by docstatus even when its label says Draft", async () => {
    const out = parse(
      await createAdapter({ client: fakeHvgerp() as Any }).call("list_open_purchase_orders"),
    );
    expect(out.purchase_orders).toEqual([
      {
        name: "PO-1",
        supplier: "Alpha Traders",
        schedule_date: "2026-11-03",
        transaction_date: null,
        items: [
          {
            item_code: "SUGAR",
            ordered_qty: expect.any(Number),
            received_qty: expect.any(Number),
            pending_qty: 15,
            rate: expect.any(Number),
          },
        ],
      },
    ]);
    // Ordered and received quantities reconcile with the pending quantity.
    const [line] = out.purchase_orders[0].items;
    expect(line.ordered_qty - line.received_qty).toBe(line.pending_qty);
  });

  it("reads quotation rates, lead times and validity from the quotation document", async () => {
    const out = parse(
      await createAdapter({ client: fakeHvgerp() as Any }).call("list_supplier_quotations", {
        item_code: "MILK",
      }),
    );
    expect(out.quotations).toEqual([
      {
        name: "SQ-1",
        supplier: "Alpha Traders",
        item_code: "MILK",
        rate: 24,
        quoted_qty: 60,
        lead_time_days: 1,
        valid_till: "2026-11-30",
      },
      {
        name: "SQ-2",
        supplier: "Beta Dairy",
        item_code: "MILK",
        rate: 23.5,
        quoted_qty: 60,
        lead_time_days: 2,
        valid_till: "2026-11-30",
      },
    ]);
    expect(out.quotations[0].available_qty).toBeUndefined();
  });

  it("takes profit only from the posted report and refuses when nothing is posted", async () => {
    const hv: Any = fakeHvgerp();
    const adapter = createAdapter({ client: hv });
    expect(
      parse(
        await adapter.call("get_profit_and_loss", {
          from_date: "2026-11-01",
          to_date: "2026-11-01",
        }),
      ),
    ).toMatchObject({
      income: 1100,
      expense: 700,
      net_profit: 400,
    });
    expect(
      hv.calls.find((call: Any) => call.name === "erpnext_financial_report").arguments.filters
        .company,
    ).toBe("Shop Co");
    const empty: Any = fakeHvgerp();
    const original = empty.callTool;
    empty.callTool = async (call: Any) =>
      call.name === "erpnext_financial_report"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  report_summary: [
                    { label: "Total Income", value: 0 },
                    { label: "Total Expense", value: 0 },
                    { label: "Net Profit", value: 0 },
                  ],
                }),
              },
            ],
          }
        : original(call);
    await expect(
      createAdapter({ client: empty }).call("get_profit_and_loss", {
        from_date: "2026-11-01",
        to_date: "2026-11-01",
      }),
    ).rejects.toThrow(/No posted profit and loss data/);
  });

  it("only ever calls allowlisted read tools on allowlisted document types", async () => {
    const hv: Any = fakeHvgerp();
    const adapter = createAdapter({ client: hv });
    for (const tool of ADAPTER_TOOLS) {
      const args =
        tool.name === "get_stock_ledger"
          ? { item_code: "MILK" }
          : ["list_receivables", "list_payables"].includes(String(tool.name))
            ? { as_of: "2026-11-01" }
            : { from_date: "2026-10-31", to_date: "2026-11-01" };
      await adapter.call(tool.name, args);
    }
    expect(hv.calls.length).toBeGreaterThan(10);
    for (const call of hv.calls) {
      expect(HVGERP_READS).toContain(call.name);
      if (call.name === "erpnext_doc_get")
        expect(["Supplier Quotation", "POS Invoice"]).toContain(call.arguments.doctype);
      if (call.name === "erpnext_doc_list") {
        expect([
          "Stock Ledger Entry",
          "POS Invoice",
          "Item Price",
          "Bin",
          "Batch",
          "Sales Invoice",
          "Purchase Invoice",
        ]).toContain(call.arguments.doctype);
        // The dashboard doctypes may only be read through their reviewed field lists.
        const allowed = (DOC_LIST_FIELDS as Record<string, readonly string[]>)[
          call.arguments.doctype
        ];
        if (allowed)
          for (const field of call.arguments.fields ?? []) expect(allowed).toContain(field);
      }
    }
    await expect(
      adapter.call("list_receivables", { as_of: "2026-11-01" }).then(parse),
    ).resolves.toMatchObject({
      invoices: [{ name: "SINV-1", outstanding_amount: 200, due_date: "2026-10-31" }],
    });
    await expect(adapter.call("get_item_valuation", {}).then(parse)).resolves.toMatchObject({
      valuations: [{ item_code: "MILK", valuation_rate: 24 }],
    });
    await expect(adapter.call("erpnext_doc_submit", {})).rejects.toThrow(/Unknown tool/);
  });
});

describe("NammaOps workflows over the live binding (fixture double for hvgerp)", () => {
  async function liveSetup() {
    const db = new TaskDatabase(":memory:") as Any;
    const hv: Any = fakeHvgerp();
    const adapterServer = createAdapterServer(createAdapter({ client: hv }));
    const transportFactory = () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void adapterServer.connect(serverSide);
      return clientSide;
    };
    const binding = loadBinding("config/nammaops/binding.hvgerp.json");
    const servers = new McpServers(db, {
      policy: { stdio: [binding.server.connection], http: [], cwd: process.cwd() },
      transportFactory: transportFactory as Any,
    });
    cleanup.push(
      () => db.close(),
      () => servers.close(),
    );
    const owner: Any = {
      gatewayId: "gw",
      gateway: { provider: "openclaw", status: "connected" },
      db,
      resolve: (seatId: string) => ({
        seat: { seatId, binding: { revision: 1 } },
        agentId: "backend",
        sessionKey: `agent:backend:${seatId}`,
      }),
      submit: vi.fn(),
    };
    const runtime: Any = {
      db,
      gateway: owner.gateway,
      seatOwner: () => owner,
      taskOwner: () => owner,
      estop: { status: () => ({ engaged: false }) },
      rosterSeats: () =>
        ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((seatId) => ({
          seatId,
          assigned: true,
          binding: { available: true },
        })),
    };
    runtime.profiles = new AgentProfiles(runtime);
    runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
    runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
    runtime.mcpServers = servers;
    runtime.capabilities = new CapabilityRegistry(db, servers);
    runtime.governance = new Governance(db, runtime.capabilities, {
      identity: (agentId: string) => {
        if (WORKFLOW_PRINCIPALS.has(agentId)) return { agentId, specializationId: null };
        const profile = runtime.profiles.get(agentId);
        return profile ? { agentId, specializationId: profile.specialization_id ?? null } : null;
      },
    });
    runtime.mcpGateway = new ToolGateway({
      db,
      servers,
      registry: runtime.capabilities,
      governance: runtime.governance,
    });
    runtime.nammaops = createNammaOps(
      runtime,
      { NAMMAOPS_OWNER_PIN: "4826", NAMMAOPS_REASONING: "off" },
      { binding, workforce: loadWorkforce(), today: () => "2026-11-01" },
    );
    const report = await runtime.nammaops.setup({});
    return { runtime, hv, report };
  }

  it("sets up with writes disabled (not as errors) and grants no write capability", async () => {
    const { runtime, report } = await liveSetup();
    expect(report.blockers).toEqual([]);
    expect(report.disabled.map((row: Any) => row.business_capability).sort()).toEqual([
      "erp.gst.summary",
      "erp.payments.summary",
      "erp.po.create_draft",
      "erp.po.get",
      "erp.po.submit",
    ]);
    const granted = runtime.governance.grants().map((row: Any) => row.capability_id);
    expect(granted.join(" ")).not.toMatch(/create_purchase_order|submit/);
    expect(
      runtime.nammaops.binding.status().filter((row: Any) => row.state === "unbound"),
    ).toHaveLength(5);
  });

  it("answers stock, sales, profit and supplier questions from live-shaped data, labelled as live", async () => {
    const { runtime } = await liveSetup();
    const ask = (intent: Any) => runtime.nammaops.workflows.start({ intent }).done;
    const stock = await ask({ action: "stock_check", products: ["milk", "rice"] });
    expect(stock.status).toBe("completed");
    expect(
      stock.result.low.map((row: Any) => [row.item_code, row.available, row.reorder_level]),
    ).toEqual([["MILK", 20, 40]]);
    const report = await ask({ action: "daily_report", date: "2026-11-01" });
    expect(report.result).toMatchObject({ total_sales: 1100, transaction_count: 2 });
    expect(report.result.profit).toMatchObject({ status: "verified", net_profit: 400 });
    const compare = await ask({ action: "supplier_comparison", products: ["milk"] });
    expect(compare.result.items[0].choice).toMatchObject({ supplier: "Beta Dairy", rate: 23.5 }); // lower rate wins
    expect(runtime.nammaops.voice.source).toBe("erpnext_live");
    expect(
      runtime.nammaops.voice.contract({ status: "completed", intent: "check_stock" })
        .limitations[0],
    ).toMatch(/Live ERPNext Cloud/);
  });

  it("cannot create or submit a purchase order on live data", async () => {
    const { runtime, hv } = await liveSetup();
    const view = await runtime.nammaops.workflows.start({ intent: { action: "prepare_reorder" } })
      .done;
    expect(view.status).toBe("blocked");
    expect(view.error).toMatch(/erp\.po\.create_draft is not enabled in this deployment/);
    expect(runtime.nammaops.approvals.list()).toEqual([]);
    expect(hv.calls.some((call: Any) => /create|submit/.test(call.name))).toBe(false);
  });
});
