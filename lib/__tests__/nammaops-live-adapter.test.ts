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
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { VoiceService } from "../server/voice.mjs";
import { runVoiceAgentTool } from "../voice/agent-actions";
import { NAMMAOPS_BUSINESS_TOOL } from "../voice/config";
import {
  ADAPTER_TOOLS,
  ADAPTER_WRITE_TOOLS,
  HVGERP_WRITES,
  STOCK_FIELDS,
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

/** Live-shaped selling rates and customers for the bill flow (the fake ERP). */
const SELLING: Record<string, number> = { MILK: 30, RICE: 420, SUGAR: 48 };
const CUSTOMERS = [
  { name: "Walk-in Customer", disabled: 0 },
  { name: "Lakshmi Stores", disabled: 0 },
  { name: "Closed Shop", disabled: 1 },
];
/** The adapter's clock in tests: a bill's date window is relative to it, so it must not drift. */
const NOW = () => Date.parse("2026-11-01T10:00:00Z");

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
        // ERPNext (India Compliance) puts the GST of each line on the line itself. RICE is taxed
        // at 5% (CGST 2.5 + SGST 2.5); everything else is nil-rated.
        gst_hsn_code: item_code === "RICE" ? "1006" : "0401",
        gst_treatment: item_code === "RICE" ? "Taxable" : "Nil-Rated",
        taxable_value: item_code === "RICE" ? amount : 0,
        cgst_rate: item_code === "RICE" ? 2.5 : 0,
        sgst_rate: item_code === "RICE" ? 2.5 : 0,
        igst_rate: 0,
        cgst_amount: item_code === "RICE" ? amount * 0.025 : 0,
        sgst_amount: item_code === "RICE" ? amount * 0.025 : 0,
        igst_amount: 0,
      })),
    };
  }
  const paymentEntries: Any[] = [
    {
      name: "PE-1",
      payment_type: "Receive",
      posting_date: "2026-11-01",
      base_received_amount: 500,
      base_paid_amount: 500,
      docstatus: 1,
    },
    {
      name: "PE-2",
      payment_type: "Receive",
      posting_date: "2026-11-01",
      base_received_amount: 250.5,
      base_paid_amount: 250.5,
      docstatus: 1,
    },
    {
      name: "PE-3",
      payment_type: "Pay",
      posting_date: "2026-11-01",
      base_received_amount: 300,
      base_paid_amount: 300,
      docstatus: 1,
    },
    {
      name: "PE-4",
      payment_type: "Receive",
      posting_date: "2026-11-01",
      base_received_amount: 9999,
      base_paid_amount: 9999,
      docstatus: 0,
    },
    {
      name: "PE-5",
      payment_type: "Receive",
      posting_date: "2026-10-01",
      base_received_amount: 70,
      base_paid_amount: 70,
      docstatus: 1,
    },
  ];
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
        item_name:
          name === "SUGAR" ? "Sugar 1kg" : name === "RICE" ? "Sona Rice 5kg" : "Toned Milk 500ml",
        is_stock_item: name === "SERVICE" ? 0 : 1,
        disabled: name === "RETIRED" ? 1 : 0,
        standard_rate: name === "NOPRICE" ? 0 : (SELLING[name] ?? 10),
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
    erpnext_purchase_invoice_get: ({ name }) => ({
      data: {
        name,
        docstatus: 1,
        supplier: "Alpha Traders",
        posting_date: "2026-11-01",
        items: [
          {
            item_code: "SUGAR",
            qty: 10,
            gst_hsn_code: "1701",
            gst_treatment: "Taxable",
            taxable_value: 500,
            igst_rate: 0,
            cgst_rate: 2.5,
            sgst_rate: 2.5,
            cgst_amount: 12.5,
            sgst_amount: 12.5,
            igst_amount: 0,
          },
        ],
      },
    }),
    erpnext_purchase_order_list: () =>
      list([
        { name: "PO-1", status: "Draft" }, // submitted but labelled Draft (docstatus 1)
        { name: "PO-2", status: "Draft" }, // a real draft
        { name: "PO-3", status: "Completed" },
      ]),
    erpnext_purchase_order_get: ({ name }) => {
      if (name === "PO-MISSING")
        throw new Error(
          `[FrappeClient] GET /api/resource/Purchase%20Order/${name} failed: DoesNotExistError: Purchase Order ${name} not found (HTTP 404)`,
        );
      return {
        data: {
          name,
          supplier: "Alpha Traders",
          docstatus: name === "PO-1" ? 1 : 0,
          status: "Draft",
          transaction_date: "2026-10-30",
          schedule_date: "2026-11-03",
          grand_total: 500,
          items: [{ item_code: "SUGAR", qty: 20, received_qty: 5, rate: 25, amount: 500 }],
        },
      };
    },
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
      if (doctype === "Payment Entry") {
        const from = filters.find((row: Any) => row[1] === ">=")?.[2] ?? "0000";
        const to = filters.find((row: Any) => row[1] === "<=")?.[2] ?? "9999";
        const submitted = filters.some((row: Any) => row[0] === "docstatus" && row[2] === 1);
        return list(
          paymentEntries.filter(
            (row) =>
              row.posting_date >= from &&
              row.posting_date <= to &&
              (!submitted || row.docstatus === 1),
          ),
        );
      }
      if (doctype === "Price List")
        return list([{ name: "Standard Selling", selling: 1, enabled: 1, currency: "INR" }]);
      if (doctype === "Customer") {
        const wanted = filters.find((row: Any) => row[0] === "name")?.[2];
        return list(
          CUSTOMERS.filter((row) => row.name === wanted).map(({ name, disabled }) => ({
            name,
            disabled,
          })),
        );
      }
      if (doctype === "Item Price") {
        if (filters.some((row: Any) => row[0] === "selling")) {
          const code = filters.find((row: Any) => row[0] === "item_code")?.[2];
          return list(
            SELLING[code]
              ? [
                  {
                    item_code: code,
                    price_list: "Standard Selling",
                    price_list_rate: SELLING[code],
                  },
                ]
              : [],
          );
        }
        return list([{ item_code: "MILK", price_list: "Standard Buying", price_list_rate: 25 }]);
      }
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
  // The three ERPNext writes the bill flow may use. `behaviour` lets a test make ERPNext misbehave.
  const behaviour: { createShape: "data" | "bare" | "nameless"; failUpdate: boolean } = {
    createShape: "data",
    failUpdate: false,
  };
  let drafts = 0;
  const writeHandlers: Record<string, (args: Any) => Any> = {
    erpnext_sales_invoice_create: (args) => {
      drafts += 1;
      const items = args.items.map((row: Any) => ({
        item_code: row.item_code,
        item_name: row.item_code,
        qty: row.qty,
        rate: row.rate,
        amount: row.qty * row.rate,
        warehouse: row.warehouse,
      }));
      const doc = {
        name: `SINV-NEW-${drafts}`,
        customer: args.customer,
        posting_date: args.posting_date,
        docstatus: 0,
        status: "Draft",
        update_stock: 0,
        set_warehouse: args.set_warehouse ?? null,
        currency: args.currency,
        company: args.company,
        selling_price_list: args.selling_price_list,
        grand_total: items.reduce((sum: number, row: Any) => sum + row.amount, 0),
        items,
      };
      invoices.push(doc);
      return behaviour.createShape === "data"
        ? { data: doc }
        : behaviour.createShape === "bare"
          ? doc
          : { data: { customer: doc.customer } };
    },
    erpnext_doc_update: ({ doctype, name, data }) => {
      if (behaviour.failUpdate) throw new Error("PermissionError: cannot update");
      const doc = invoices.find((row) => row.name === name);
      if (doctype !== "Sales Invoice" || !doc) throw new Error(`${doctype} ${name} not found`);
      Object.assign(doc, data);
      return { data: doc };
    },
    erpnext_sales_invoice_submit: ({ name }) => {
      const doc = invoices.find((row) => row.name === name);
      if (!doc) throw new Error(`Sales Invoice ${name} not found`);
      doc.docstatus = 1;
      doc.status = "Unpaid";
      return { data: doc };
    },
  };
  const readOnly = new Set(Object.keys(handlers));
  return {
    calls,
    behaviour,
    invoices,
    asReadOnly: readOnly,
    listTools: async () => ({
      tools: [
        ...HVGERP_READS.map((name) => ({ name, annotations: { readOnlyHint: true } })),
        { name: "erpnext_doc_submit", annotations: { destructiveHint: true } },
        { name: "erpnext_purchase_order_create", annotations: {} },
        { name: "erpnext_sales_invoice_create", annotations: { readOnlyHint: false } },
        { name: "erpnext_doc_update", annotations: { readOnlyHint: false, destructiveHint: true } },
        {
          name: "erpnext_sales_invoice_submit",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    }),
    callTool: async ({ name, arguments: args }: Any) => {
      calls.push({ name, arguments: args });
      const handler = handlers[name] ?? writeHandlers[name];
      if (!handler) return { isError: true, content: [{ type: "text", text: `unknown ${name}` }] };
      try {
        return { content: [{ type: "text", text: JSON.stringify(handler(args ?? {})) }] };
      } catch (error: Any) {
        return { isError: true, content: [{ type: "text", text: String(error.message) }] };
      }
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
        transaction_date: "2026-10-30",
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
          : tool.name === "get_purchase_order"
            ? { name: "PO-1" }
            : tool.name === "get_sales_invoice"
              ? { name: "SINV-1" }
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
          "Payment Entry",
          "Price List",
          "Customer",
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

  it("reads one purchase order in any state, and says plainly when it does not exist", async () => {
    const adapter = createAdapter({ client: fakeHvgerp() as Any });
    const { purchase_order: po, source } = parse(
      await adapter.call("get_purchase_order", { name: "PO-1" }),
    );
    expect(source).toBe("erpnext_live");
    expect(po).toMatchObject({
      name: "PO-1",
      supplier: "Alpha Traders",
      docstatus: 1,
      status: "Draft",
      grand_total: 500,
      items: [{ item_code: "SUGAR", qty: 20, rate: 25, amount: 500, received_qty: 5 }],
    });
    // A draft is readable too: this is a read, not a submit.
    expect(
      parse(await adapter.call("get_purchase_order", { name: "PO-2" })).purchase_order.docstatus,
    ).toBe(0);
    await expect(adapter.call("get_purchase_order", { name: "PO-MISSING" })).rejects.toThrow(
      /not found/,
    );
  });

  it("sums only submitted payment entries in the period, received and paid separately", async () => {
    const hv: Any = fakeHvgerp();
    const adapter = createAdapter({ client: hv });
    const day = parse(
      await adapter.call("get_payment_summary", { from_date: "2026-11-01", to_date: "2026-11-01" }),
    );
    // PE-4 is a draft and PE-5 is another day: neither counts.
    expect(day).toMatchObject({ source: "erpnext_live", received: 750.5, paid: 300, count: 3 });
    const month = parse(
      await adapter.call("get_payment_summary", { from_date: "2026-10-01", to_date: "2026-11-01" }),
    );
    expect(month).toMatchObject({ received: 820.5, paid: 300, count: 4 });
    const none = parse(
      await adapter.call("get_payment_summary", { from_date: "2020-01-01", to_date: "2020-01-31" }),
    );
    expect(none).toMatchObject({ received: 0, paid: 0, count: 0 });
    const listed = hv.calls.filter((call: Any) => call.name === "erpnext_doc_list");
    expect(listed.every((call: Any) => call.arguments.doctype === "Payment Entry")).toBe(true);
    expect(
      listed.every((call: Any) =>
        call.arguments.filters.some((row: Any) => row[0] === "docstatus" && row[2] === 1),
      ),
    ).toBe(true);
  });

  it("builds GST lines from each invoice line's own tax fields and reports unknowns as null", async () => {
    const hv: Any = fakeHvgerp();
    const adapter = createAdapter({ client: hv });
    const gst = parse(
      await adapter.call("list_gst_lines", { from_date: "2026-10-31", to_date: "2026-11-01" }),
    );
    expect(gst.source).toBe("erpnext_live");
    // Draft and cancelled invoices are skipped, as for the other invoice reads.
    const outward = gst.lines.filter((row: Any) => row.direction === "outward");
    expect(outward.map((row: Any) => row.document).sort()).toEqual(["SINV-1", "SINV-2", "SINV-5"]);
    expect(outward.find((row: Any) => row.document === "SINV-1")).toMatchObject({
      item_code: "RICE",
      hsn_code: "1006",
      gst_treatment: "Taxable",
      gst_rate: 5,
      taxable_value: 800,
      cgst: 20,
      sgst: 20,
      igst: 0,
    });
    expect(outward.find((row: Any) => row.document === "SINV-2")).toMatchObject({
      gst_treatment: "Nil-Rated",
      gst_rate: 0,
      taxable_value: 0,
      cgst: 0,
    });
    const inward = gst.lines.filter((row: Any) => row.direction === "inward");
    expect(inward).toHaveLength(1);
    expect(inward[0]).toMatchObject({
      document: "PINV-1",
      cgst: 12.5,
      sgst: 12.5,
      taxable_value: 500,
    });
    // Nothing is guessed: party GSTIN and place of supply were not on these invoices, so those
    // fields are absent (not sent as null or defaulted) and named in data_gaps.
    for (const line of outward) {
      expect(line).not.toHaveProperty("gstin");
      expect(line).not.toHaveProperty("party_type");
      expect(line).not.toHaveProperty("place_of_supply");
      expect(line).not.toHaveProperty("cess");
      expect(line).not.toHaveProperty("is_return");
    }
    expect(gst.company_state).toBeNull();
    expect(gst.data_gaps).toEqual(["gstin", "place_of_supply"]);
    // Only the reviewed read tools were used.
    for (const call of hv.calls) expect(HVGERP_READS).toContain(call.name);
  });
});

describe("customer bill writes (unit, fake hvgerp)", () => {
  const writeNames = () => [...HVGERP_WRITES];
  const adapterFor = (hv: Any) => createAdapter({ client: hv, now: NOW });
  const draft = (adapter: Any, args: Any = {}) =>
    adapter.call("create_sales_invoice_draft", {
      customer: "Walk-in Customer",
      posting_date: "2026-11-01",
      items: [{ item_code: "MILK", qty: 1 }],
      ...args,
    });
  const writesMade = (hv: Any) => hv.calls.filter((call: Any) => writeNames().includes(call.name));
  const noWrites = (hv: Any) => expect(writesMade(hv)).toEqual([]);

  it("keeps the write allowlist tiny and apart from the read path", () => {
    expect([...HVGERP_WRITES]).toEqual([
      "erpnext_sales_invoice_create",
      "erpnext_doc_update",
      "erpnext_sales_invoice_submit",
    ]);
    expect([...STOCK_FIELDS]).toEqual(["update_stock", "set_warehouse"]);
    // No write tool is ever reachable through the read allowlist.
    for (const name of HVGERP_WRITES) expect(HVGERP_READS).not.toContain(name);
    expect(ADAPTER_WRITE_TOOLS.map((tool) => tool.name)).toEqual([
      "create_sales_invoice_draft",
      "submit_sales_invoice",
    ]);
    // The read tools are still all read-only and name no write.
    expect(ADAPTER_TOOLS.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(ADAPTER_WRITE_TOOLS.every((tool) => tool.annotations.readOnlyHint === false)).toBe(true);
    // No rate, price list, warehouse or account can be passed in.
    const props = Object.keys((ADAPTER_WRITE_TOOLS[0].inputSchema as Any).properties);
    expect(props.sort()).toEqual(["customer", "items", "posting_date"]);
    const line = (ADAPTER_WRITE_TOOLS[0].inputSchema as Any).properties.items.items.properties;
    expect(Object.keys(line).sort()).toEqual(["item_code", "qty"]);
  });

  it("creates a DRAFT with rates, company, price list, currency and warehouse taken from ERPNext", async () => {
    const hv: Any = fakeHvgerp();
    const out = parse(
      await draft(adapterFor(hv), {
        items: [
          { item_code: "MILK", qty: 2 },
          { item_code: "RICE", qty: 1, rate: 1 }, // a caller-supplied rate is ignored
        ],
      }),
    );
    expect(out.source).toBe("erpnext_live");
    expect(out.invoice).toMatchObject({
      docstatus: 0,
      status: "Draft",
      customer: "Walk-in Customer",
      update_stock: 1,
      set_warehouse: "Stores",
      grand_total: 480, // 2 x 30 + 1 x 420, from the selling prices
    });
    expect(out.invoice.items.map((row: Any) => [row.item_code, row.qty, row.rate])).toEqual([
      ["MILK", 2, 30],
      ["RICE", 1, 420],
    ]);
    const [create, update, ...more] = writesMade(hv);
    expect(more).toEqual([]);
    expect(create).toMatchObject({
      name: "erpnext_sales_invoice_create",
      arguments: {
        customer: "Walk-in Customer",
        posting_date: "2026-11-01",
        company: "Shop Co",
        selling_price_list: "Standard Selling",
        currency: "INR",
        set_warehouse: "Stores",
        items: [
          { item_code: "MILK", qty: 2, rate: 30, warehouse: "Stores" },
          { item_code: "RICE", qty: 1, rate: 420, warehouse: "Stores" },
        ],
      },
    });
    // The one follow-up write sets exactly the two stock fields, on exactly this draft.
    expect(update).toMatchObject({
      name: "erpnext_doc_update",
      arguments: {
        doctype: "Sales Invoice",
        name: "SINV-NEW-1",
        data: { update_stock: 1, set_warehouse: "Stores" },
      },
    });
    expect(Object.keys(update.arguments.data).sort()).toEqual(["set_warehouse", "update_stock"]);
    // It never submits.
    expect(hv.calls.some((call: Any) => call.name === "erpnext_sales_invoice_submit")).toBe(false);
    for (const call of hv.calls) expect([...HVGERP_READS, ...HVGERP_WRITES]).toContain(call.name);
  });

  it("merges a repeated item into one line, and falls back to the item's standard rate", async () => {
    const hv: Any = fakeHvgerp();
    const out = parse(
      await draft(adapterFor(hv), {
        items: [
          { item_code: "MILK", qty: 1 },
          { item_code: "MILK", qty: 2 },
        ],
      }),
    );
    expect(out.invoice.items).toHaveLength(1);
    expect(out.invoice.items[0]).toMatchObject({ item_code: "MILK", qty: 3, rate: 30 });
    // GHEE has no selling price row, so its own standard rate (10 in this fake) is used.
    const hv2: Any = fakeHvgerp();
    const fallback = parse(
      await draft(adapterFor(hv2), { items: [{ item_code: "GHEE", qty: 1 }] }),
    );
    expect(fallback.invoice.items[0]).toMatchObject({ item_code: "GHEE", rate: 10 });
  });

  it("refuses, writing nothing, an unknown or disabled customer", async () => {
    for (const customer of ["Nobody Ltd", "Closed Shop"]) {
      const hv: Any = fakeHvgerp();
      await expect(draft(adapterFor(hv), { customer })).rejects.toThrow(/does not exist|disabled/);
      noWrites(hv);
    }
  });

  it("refuses, writing nothing, bad items, quantities and dates", async () => {
    const cases: Array<[Any, RegExp]> = [
      [{ items: [{ item_code: "RETIRED", qty: 1 }] }, /not an active stock item/],
      [{ items: [{ item_code: "SERVICE", qty: 1 }] }, /not an active stock item/],
      [{ items: [{ item_code: "NOPRICE", qty: 1 }] }, /no selling price/],
      [{ items: [{ item_code: "MILK", qty: 51 }] }, /at most 50/],
      [
        {
          items: [
            { item_code: "MILK", qty: 30 },
            { item_code: "MILK", qty: 30 },
          ],
        },
        /at most 50/,
      ],
      [{ items: [{ item_code: "MILK", qty: 0 }] }, /above 0/],
      [{ posting_date: "2026-10-20" }, /must be between/],
      [{ posting_date: "2026-11-09" }, /must be between/],
    ];
    for (const [args, message] of cases) {
      const hv: Any = fakeHvgerp();
      await expect(draft(adapterFor(hv), args)).rejects.toThrow(message);
      noWrites(hv);
    }
    // The edges are allowed: 7 days back, and tomorrow (a timezone's slack).
    const hv: Any = fakeHvgerp();
    await expect(draft(adapterFor(hv), { posting_date: "2026-10-25" })).resolves.toBeTruthy();
    await expect(draft(adapterFor(hv), { posting_date: "2026-11-02" })).resolves.toBeTruthy();
  });

  it("accepts either shape ERPNext may answer a create with, and says so when it names no draft", async () => {
    const bare: Any = fakeHvgerp();
    bare.behaviour.createShape = "bare";
    expect(parse(await draft(adapterFor(bare))).invoice.name).toBe("SINV-NEW-1");
    const nameless: Any = fakeHvgerp();
    nameless.behaviour.createShape = "nameless";
    await expect(draft(adapterFor(nameless))).rejects.toThrow(/did not say which draft/);
    // It did create something, so it must not go on to update or submit an unknown document.
    expect(writesMade(nameless).map((call: Any) => call.name)).toEqual([
      "erpnext_sales_invoice_create",
    ]);
  });

  it("names the draft, and does not submit it, when it could not be set to update stock", async () => {
    const hv: Any = fakeHvgerp();
    hv.behaviour.failUpdate = true;
    await expect(draft(adapterFor(hv))).rejects.toThrow(
      /Draft SINV-NEW-1 was created but could not be set to update stock.*not submitted/,
    );
    expect(hv.calls.some((call: Any) => call.name === "erpnext_sales_invoice_submit")).toBe(false);
  });

  it("submits only a draft that updates stock, and checks it before and after", async () => {
    const hv: Any = fakeHvgerp();
    const adapter = adapterFor(hv);
    const { invoice } = parse(await draft(adapter));
    const done = parse(await adapter.call("submit_sales_invoice", { name: invoice.name }));
    expect(done.invoice).toMatchObject({ name: invoice.name, docstatus: 1, status: "Unpaid" });
    // Already submitted: refused, nothing more is written.
    const before = writesMade(hv).length;
    await expect(adapter.call("submit_sales_invoice", { name: invoice.name })).rejects.toThrow(
      /not a draft/,
    );
    // An unknown invoice, and a draft this adapter did not make (no stock update): refused.
    await expect(adapter.call("submit_sales_invoice", { name: "SINV-404" })).rejects.toThrow(
      /not found/,
    );
    hv.invoices.push({
      name: "SINV-OTHER",
      customer: "x",
      docstatus: 0,
      update_stock: 0,
      items: [],
    });
    await expect(adapter.call("submit_sales_invoice", { name: "SINV-OTHER" })).rejects.toThrow(
      /not one of the bills created here/,
    );
    expect(writesMade(hv)).toHaveLength(before);
  });

  it("offers no other write: no update, cancel, delete or generic tool", async () => {
    const adapter = adapterFor(fakeHvgerp() as Any);
    for (const name of [
      "erpnext_doc_update",
      "erpnext_doc_delete",
      "cancel_sales_invoice",
      "erpnext_sales_invoice_cancel",
    ])
      await expect(adapter.call(name, { name: "SINV-1" })).rejects.toThrow(/Unknown tool/);
  });

  it("refuses to write if hvgerp now describes a write tool as read-only", async () => {
    const hv: Any = fakeHvgerp();
    const real = hv.listTools;
    hv.listTools = async () => ({
      tools: (await real()).tools.map((tool: Any) =>
        tool.name === "erpnext_doc_update"
          ? { ...tool, annotations: { readOnlyHint: true } }
          : tool,
      ),
    });
    await expect(draft(adapterFor(hv))).rejects.toThrow(/now marks erpnext_doc_update read-only/);
    noWrites(hv);
  });

  it("reads one invoice and the selling prices, read-only", async () => {
    const hv: Any = fakeHvgerp();
    const adapter = adapterFor(hv);
    expect(
      parse(await adapter.call("get_sales_invoice", { name: "SINV-1" })).invoice,
    ).toMatchObject({
      name: "SINV-1",
      docstatus: 1,
    });
    await expect(adapter.call("get_sales_invoice", { name: "SINV-404" })).rejects.toThrow(
      /not found/,
    );
    const prices = parse(await adapter.call("get_selling_prices", { item_code: "MILK" }));
    expect(prices).toMatchObject({
      price_list: "Standard Selling",
      currency: "INR",
      prices: [{ item_code: "MILK", rate: 30 }],
    });
    noWrites(hv);
  });
});

describe("NammaOps workflows over the live binding (fixture double for hvgerp)", () => {
  async function liveSetup() {
    const db = new TaskDatabase(":memory:") as Any;
    const hv: Any = fakeHvgerp();
    const adapterServer = createAdapterServer(createAdapter({ client: hv, now: NOW }));
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
    // The purchase-order writes stay off in live; every read, and the owner-enabled bill writes, are bound.
    expect(report.disabled.map((row: Any) => row.business_capability).sort()).toEqual([
      "erp.po.create_draft",
      "erp.po.submit",
    ]);
    const grants = runtime.governance.grants();
    const granted = grants.map((row: Any) => row.capability_id);
    // No purchase-order write is granted to anyone.
    expect(granted.join(" ")).not.toMatch(/create_purchase_order|submit_purchase_order/);
    // The only live write grants: Frank may draft a bill, and only the bill-submit principal may submit.
    const draft = grants.filter((row: Any) =>
      /create_sales_invoice_draft$/.test(row.capability_id),
    );
    const submit = grants.filter((row: Any) => /submit_sales_invoice$/.test(row.capability_id));
    expect(draft.map((row: Any) => row.subject)).toEqual([
      expect.stringMatching(/^specialization:spec_kirana-counter-billing/),
    ]);
    expect(submit.map((row: Any) => row.subject)).toEqual(["agent:nammaops-bill-submit"]);
    const status = runtime.nammaops.binding.status();
    expect(status).toHaveLength(29);
    expect(
      status
        .filter((row: Any) => row.state === "unbound")
        .map((row: Any) => row.business_capability),
    ).toEqual(["erp.po.create_draft", "erp.po.submit"]);
    expect(
      status.filter((row: Any) => row.risk === "READ").every((row: Any) => row.tool !== null),
    ).toBe(true);
    expect(status.filter((row: Any) => row.tool !== null)).toHaveLength(27);
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

  it("records timing on each audited invocation without changing the audit fields or result", async () => {
    const { runtime } = await liveSetup();
    const view = await runtime.nammaops.workflows.start({
      intent: { action: "stock_check", products: ["milk"] },
    }).done;
    expect(view.status).toBe("completed");
    const rows = runtime.mcpGateway
      .invocations()
      .filter((row: Any) => row.correlation_id === view.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Audit evidence is intact.
      expect(row).toMatchObject({ status: "completed", decision: "ALLOW", operation: "READ" });
      expect(row.invocation_id).toMatch(/^inv/);
      expect(row.args_fingerprint).toBeTruthy();
      // Timing is additive metadata, and never leaks into the business payload.
      expect(row.timing.duration_ms).toBeGreaterThanOrEqual(0);
      expect(row.timing.tool_ms).toBeGreaterThanOrEqual(0);
      expect(row.timing.adapter.hv_calls).toBeGreaterThanOrEqual(0);
      expect(row.result.structuredContent).not.toHaveProperty("_meta");
    }
  });

  describe("the three newly bound reads: payments, GST and one purchase order", () => {
    const ask = (runtime: Any, intent: Any) => runtime.nammaops.workflows.start({ intent }).done;
    const invocationsOf = (runtime: Any, view: Any) =>
      runtime.mcpGateway.invocations().filter((row: Any) => row.correlation_id === view.id);

    it("payments_summary runs as Finance through governance and returns real submitted totals", async () => {
      const { runtime } = await liveSetup();
      const view = await ask(runtime, { action: "payments_summary", date: "2026-11-01" });
      expect(view.status).toBe("completed");
      expect(view.result).toMatchObject({
        kind: "payments_summary",
        received: 750.5,
        paid: 300,
        net: 450.5,
        payments: 3,
        period: { from_date: "2026-11-01", to_date: "2026-11-01" },
      });
      const rows = invocationsOf(runtime, view);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "completed",
        decision: "ALLOW",
        operation: "READ",
        agent_id: "nammaops-finance",
        capability_id: "mcp.erpnext-live.get_payment_summary",
      });
      expect(rows[0].invocation_id).toMatch(/^inv/);
      expect(view.tasks.find((task: Any) => task.role === "finance").evidence[0]).toMatchObject({
        business_capability: "erp.payments.summary",
      });
      // No date means the month so far.
      const monthToDate = await ask(runtime, { action: "payments_summary" });
      expect(monthToDate.result.period).toMatchObject({
        from_date: "2026-11-01",
        to_date: "2026-11-01",
      });
    });

    it("gst_summary runs as Finance, reports nothing it was not given, and is labelled indicative", async () => {
      const { runtime } = await liveSetup();
      const view = await ask(runtime, { action: "gst_summary", date: "2026-11-01" });
      expect(view.status).toBe("completed");
      expect(view.result).toMatchObject({
        kind: "gst_summary",
        indicative: true,
        outward: { lines: 2, taxable_value: 800, cgst: 20, sgst: 20, igst: 0, tax: 40 },
        inward: { lines: 1, taxable_value: 500, tax: 25 },
        net_tax: 15,
      });
      expect(view.result.slabs.map((slab: Any) => slab.gst_rate)).toEqual([0, 5]);
      expect(view.result.notes.join(" ")).toMatch(/GSTIN/);
      expect(view.result.notes.join(" ")).toMatch(/place of supply/i);
      const rows = invocationsOf(runtime, view);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(row).toMatchObject({
          agent_id: "nammaops-finance",
          capability_id: "mcp.erpnext-live.list_gst_lines",
          decision: "ALLOW",
          operation: "READ",
        });
    });

    it("gst_summary reads one day per governed call, so no response nears the gateway cap", async () => {
      const { runtime, hv } = await liveSetup();
      const view = await ask(runtime, {
        action: "gst_summary",
        date: "2026-10-30",
        to: "2026-11-01",
      });
      expect(view.status).toBe("completed");
      // Three days, three audited calls (a week-sized slice returned too many lines on a real store).
      expect(invocationsOf(runtime, view)).toHaveLength(3);
      const windows = hv.calls
        .filter((call: Any) => call.name === "erpnext_sales_invoice_list")
        .map((call: Any) => [call.arguments.date_from, call.arguments.date_to])
        .sort();
      expect(windows).toEqual([
        ["2026-10-30", "2026-10-30"],
        ["2026-10-31", "2026-10-31"],
        ["2026-11-01", "2026-11-01"],
      ]);
    });

    it("purchase_order_lookup runs as Procurement; a missing order is a clear answer, a missing number is refused", async () => {
      const { runtime, hv } = await liveSetup();
      const found = await ask(runtime, { action: "purchase_order_lookup", po_name: "PO-1" });
      expect(found.result).toMatchObject({
        kind: "purchase_order_lookup",
        found: true,
        name: "PO-1",
        supplier: "Alpha Traders",
        state: "submitted",
        erp_status: "Draft", // ERPNext labels it Draft although docstatus is 1; both are shown
        total: 500,
        lines: 1,
      });
      expect(invocationsOf(runtime, found)[0]).toMatchObject({
        agent_id: "nammaops-procurement",
        capability_id: "mcp.erpnext-live.get_purchase_order",
        operation: "READ",
      });
      const draft = await ask(runtime, { action: "purchase_order_lookup", po_name: "PO-2" });
      expect(draft.result.state).toBe("draft");
      const missing = await ask(runtime, {
        action: "purchase_order_lookup",
        po_name: "PO-MISSING",
      });
      expect(missing.status).toBe("completed");
      expect(missing.result).toMatchObject({ found: false, name: "PO-MISSING" });
      expect(() =>
        runtime.nammaops.workflows.start({ intent: { action: "purchase_order_lookup" } }),
      ).toThrow(/Which purchase order/);
      // Reading a draft never writes: nothing but read tools reached ERPNext.
      expect(hv.calls.some((call: Any) => /create|submit|update|cancel/.test(call.name))).toBe(
        false,
      );
    });

    it("keeps specialist grants: another specialist is denied each new read", async () => {
      const { runtime } = await liveSetup();
      const call = (agent: string, id: string, args: Any) =>
        runtime.nammaops.binding.call(agent, id, args, { correlationId: "t" });
      const period = { from_date: "2026-11-01", to_date: "2026-11-01" };
      await expect(call("nammaops-sales", "erp.gst.summary", period)).rejects.toThrow(/denied/);
      await expect(call("nammaops-inventory", "erp.payments.summary", period)).rejects.toThrow(
        /denied/,
      );
      await expect(call("nammaops-finance", "erp.po.get", { name: "PO-1" })).rejects.toThrow(
        /denied/,
      );
      await expect(call("nammaops-manager", "erp.gst.summary", period)).rejects.toThrow(/denied/);
      await expect(call("nammaops-manager", "erp.payments.summary", period)).rejects.toThrow(
        /denied/,
      );
      await expect(call("nammaops-manager", "erp.po.get", { name: "PO-1" })).rejects.toThrow(
        /denied/,
      );
      // The owners of each read are allowed.
      await expect(call("nammaops-finance", "erp.gst.summary", period)).resolves.toBeTruthy();
      await expect(
        call("nammaops-procurement", "erp.po.get", { name: "PO-1" }),
      ).resolves.toBeTruthy();
    });

    it("keeps both live writes disabled: no tool, no PIN, no approval can reach them", async () => {
      const { runtime, hv } = await liveSetup();
      const call = (agent: string, id: string, args: Any) =>
        runtime.nammaops.binding.call(agent, id, args);
      await expect(
        call("nammaops-procurement", "erp.po.create_draft", {
          supplier: "Alpha Traders",
          items: [{ item_code: "SUGAR", qty: 1, rate: 1 }],
        }),
      ).rejects.toThrow(/erp\.po\.create_draft is not enabled in this deployment/);
      await expect(call("nammaops-po-submit", "erp.po.submit", { name: "PO-2" })).rejects.toThrow(
        /erp\.po\.submit is not enabled in this deployment/,
      );
      const status = runtime.nammaops.binding.status();
      for (const id of ["erp.po.create_draft", "erp.po.submit"])
        expect(status.find((row: Any) => row.business_capability === id)).toMatchObject({
          tool: null,
          state: "unbound",
          availability: "unavailable",
        });
      expect(hv.calls.some((entry: Any) => /create|submit/.test(entry.name))).toBe(false);
      // The adapter has no write tool to bind, whatever the binding file said.
      expect(ADAPTER_TOOLS.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    });

    describe("through the text chat and the Live Voice tool, with the same specialists", () => {
      const roleSeat = (runtime: Any, role: string) =>
        runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`).seat_id;
      const text = (runtime: Any, role: string, message: string, taskId: string) =>
        answerDirect(runtime, {
          taskId,
          message,
          seatId: roleSeat(runtime, role),
          sessionKey: "agent:main:dm-live-test",
        }) as Promise<Any>;
      /** Gemini's tool call is simulated; the client allowlist and VoiceService.action are the real ones. */
      const voiceFor = (runtime: Any, name: string, seatId = "seat-0") => {
        const callId = `voice_${name.toLowerCase()}`;
        const db = Object.create(runtime.db);
        db.getSeat = (id: string) =>
          id === seatId
            ? { seatId, assigned: true, binding: { revision: 1, agentId: "main" } }
            : null;
        db.saveRecord("voiceCall", callId, {
          seatId,
          name,
          agentId: "main",
          sessionKey: `agent:main:${seatId}`,
          bindingRevision: 1,
          gatewayId: "gw",
          createdAt: new Date().toISOString(),
        });
        const service = new VoiceService({ gatewayId: "gw", db, nammaops: runtime.nammaops });
        let n = 0;
        return (args: Any) =>
          runVoiceAgentTool("nammaops_business_query", args, (tool: string, parameters: Any) =>
            service.action({ tool, callId, actionId: `act_${++n}`, args: parameters }),
          ) as Promise<Any>;
      };

      it("the voice tool declaration offers the three intents and the purchase order number", () => {
        expect(NAMMAOPS_BUSINESS_TOOL.parameters.properties.intent.enum).toEqual(
          expect.arrayContaining(["payments_summary", "gst_summary", "purchase_order_lookup"]),
        );
        expect(NAMMAOPS_BUSINESS_TOOL.parameters.properties).toHaveProperty("po_name");
      });

      it("text chat: Erin answers GST and payments, Dave answers a named purchase order", async () => {
        const { runtime } = await liveSetup();
        const gst: Any = await text(runtime, "finance", "what is our gst for 2026-11-01", "t-gst");
        expect(gst.answered).toMatchObject({ intent: "gst_summary" });
        expect(runtime.db.getMessage("dm_reply_t-gst").content).toMatch(/GST/);
        const gstView = runtime.nammaops.workflows.view(gst.answered.workflowId);
        expect(gstView.result).toMatchObject({ kind: "gst_summary", net_tax: 15 });

        const pay: Any = await text(runtime, "finance", "payments received on 2026-11-01", "t-pay");
        expect(pay.answered).toMatchObject({ intent: "payments_summary" });
        expect(runtime.nammaops.workflows.view(pay.answered.workflowId).result).toMatchObject({
          received: 750.5,
          paid: 300,
        });

        const named: Any = await text(
          runtime,
          "procurement",
          "what is the status of purchase order PUR-ORD-2026-00004",
          "t-po2",
        );
        expect(named.answered).toMatchObject({ intent: "purchase_order_lookup" });
        const poView = runtime.nammaops.workflows.view(named.answered.workflowId);
        expect(poView.intent).toMatchObject({
          action: "purchase_order_lookup",
          po_name: "PUR-ORD-2026-00004",
        });
        expect(poView.result).toMatchObject({ found: true, supplier: "Alpha Traders" });
        expect(runtime.db.getMessage("dm_reply_t-po2").content).toMatch(/PUR-ORD-2026-00004/);
      });

      it("text chat: a question for another department is handed to its owner, not answered by the asker", async () => {
        const { runtime } = await liveSetup();
        const out: Any = await text(runtime, "inventory", "what is our gst for 2026-11-01", "t-h1");
        expect(out.answered).toMatchObject({ intent: "gst_summary" });
        expect(runtime.db.getMessage("dm_reply_t-h1").content).toMatch(
          /^Erin \(Finance\) covers this/,
        );
        // The read still ran as Finance, never as Inventory.
        const view = runtime.nammaops.workflows.view(out.answered.workflowId);
        expect(view.tasks.map((task: Any) => task.role)).toContain("finance");
        expect(view.tasks.find((task: Any) => task.role === "inventory")).toBeUndefined();
      });

      it("live voice tool: runs the same governed workflows as text and relays the live source", async () => {
        const { runtime } = await liveSetup();
        const erin = voiceFor(runtime, "Erin", "seat-4");
        const gst = await erin({ intent: "gst_summary", day: "2026-11-01" });
        expect(gst.status).toBe("completed");
        expect(gst.facts.join(" ")).toMatch(/Net GST/);
        expect(gst.facts.join(" ")).toMatch(/Indicative only/);
        expect(gst.limitations.join(" ")).toMatch(/Data source: Live ERPNext Cloud/);
        expect(gst.limitations.join(" ")).toMatch(/GSTIN/);
        // The ERP read is Finance's; the Manager only consolidates and reads nothing.
        const readers = (answer: Any) =>
          answer.evidence.filter((row: Any) => row.capabilities.length > 0);
        expect(readers(gst)).toEqual([
          expect.objectContaining({ department: "finance", capabilities: ["erp.gst.summary"] }),
        ]);
        expect(readers(gst)[0].invocation_ids.length).toBeGreaterThan(0);

        const payments = await erin({ intent: "payments_summary" });
        expect(payments.status).toBe("completed");
        expect(payments.facts.join(" ")).toMatch(/₹75[01] received and ₹300 paid out/);

        const dave = voiceFor(runtime, "Dave", "seat-3");
        const po = await dave({ intent: "purchase_order_lookup", po_name: "po-1" });
        expect(po.status).toBe("completed");
        expect(po.facts.join(" ")).toMatch(/Purchase order PO-1 for Alpha Traders is submitted/);
        expect(po.documents).toEqual(["PO-1"]);
        expect(readers(po)).toEqual([
          expect.objectContaining({ department: "procurement", capabilities: ["erp.po.get"] }),
        ]);
        const missing = await dave({ intent: "purchase_order_lookup", po_name: "PO-MISSING" });
        expect(missing.status).toBe("no_data");
        expect(missing.facts.join(" ")).toMatch(/was not found/);
        const noNumber = await dave({ intent: "purchase_order_lookup" });
        expect(noNumber.status).toBe("unavailable");
        expect(noNumber.limitations.join(" ")).toMatch(/Which purchase order/);

        // Every invocation behind those answers ran under a specialist's own identity.
        const agents = new Set(
          runtime.mcpGateway
            .invocations()
            .filter((row: Any) =>
              /get_payment_summary|list_gst_lines|get_purchase_order/.test(row.capability_id),
            )
            .map((row: Any) => row.agent_id),
        );
        expect([...agents].sort()).toEqual(["nammaops-finance", "nammaops-procurement"]);
      });

      it("live voice tool: refuses a PIN or any unknown argument, and cannot approve or write", async () => {
        const { runtime, hv } = await liveSetup();
        const erin = voiceFor(runtime, "Erin", "seat-4");
        await expect(erin({ intent: "gst_summary", pin: "4826" })).rejects.toThrow();
        await expect(erin({ intent: "submit_purchase_order", po_name: "PO-2" })).rejects.toThrow();
        expect(hv.calls.some((entry: Any) => /create|submit/.test(entry.name))).toBe(false);
      });
    });
  });
});
