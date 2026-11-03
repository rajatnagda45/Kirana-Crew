#!/usr/bin/env node
/**
 * NammaOps ERPNext adapter: a narrow, READ-ONLY MCP server in front of the pinned
 * @hvgllc/hvgerp-mcp 3.7.0. Agents never see hvgerp's 135 tools; the governance gateway only sees
 * the business tools below, which return the same shapes as the test fixture so the workflows are
 * identical for fixture and live data.
 *
 * Safety is enforced here in code, not in prompts:
 *   - only hvgerp tools the server itself marks readOnlyHint=true are ever called, and only the
 *     ones named in HVGERP_READS;
 *   - the generic erpnext_doc_get / erpnext_doc_list are limited to named DocTypes;
 *   - there is no create, update, submit or cancel tool. Purchase-order drafts and submission are
 *     deliberately not offered here (they are disabled in the live binding).
 *
 * Credentials (ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET) arrive in this process's
 * environment only, are passed to the hvgerp child, and are never returned or logged.
 *
 *   node lib/mcp/hvgerp-adapter-server.mjs
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const HVGERP_VERSION = "3.7.0";
const HVGERP_CATEGORIES = "sales,inventory,purchasing,accounting,operations";
/** The only hvgerp tools this adapter will ever call. */
export const HVGERP_READS = Object.freeze([
  "erpnext_item_list",
  "erpnext_item_get",
  "erpnext_warehouse_list",
  "erpnext_stock_balance",
  "erpnext_stock_ledger_list",
  "erpnext_supplier_list",
  "erpnext_supplier_quotation_list",
  "erpnext_customer_list",
  "erpnext_sales_invoice_list",
  "erpnext_sales_invoice_get",
  "erpnext_purchase_invoice_list",
  "erpnext_purchase_order_list",
  "erpnext_purchase_order_get",
  "erpnext_gl_entry_list",
  "erpnext_financial_report",
  "erpnext_doc_get",
  "erpnext_doc_list",
]);
/** Generic reads are limited to these DocTypes. */
export const DOC_GET_TYPES = Object.freeze(["Supplier Quotation", "POS Invoice"]);
export const DOC_LIST_TYPES = Object.freeze([
  "Stock Ledger Entry",
  "POS Invoice",
  "Item Price",
  "Bin",
  "Batch",
  "Sales Invoice",
  "Purchase Invoice",
]);
/** Fields the adapter may request per generic-listed DocType (no free-form field access). */
export const DOC_LIST_FIELDS = Object.freeze({
  Bin: ["item_code", "warehouse", "actual_qty", "valuation_rate", "stock_value"],
  Batch: ["name", "item", "batch_qty", "expiry_date", "manufacturing_date", "disabled"],
  "Sales Invoice": [
    "name",
    "customer",
    "posting_date",
    "due_date",
    "grand_total",
    "outstanding_amount",
  ],
  "Purchase Invoice": [
    "name",
    "supplier",
    "posting_date",
    "due_date",
    "grand_total",
    "outstanding_amount",
  ],
});
const SKIPPED_INVOICE_STATUS = new Set(["Draft", "Cancelled"]);
const CONCURRENCY = 8;
const CACHE_MS = 60_000;

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const CODE = { type: "string", pattern: "^[A-Za-z0-9 _.-]{1,64}$" };
const obj = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const read = { readOnlyHint: true };
const period = obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]);

export const ADAPTER_TOOLS = [
  ["list_items", "Items with per-item reorder levels (live ERPNext).", obj()],
  ["get_stock_balance", "Stock balance per item and warehouse.", obj({ item_code: CODE })],
  ["list_warehouses", "Warehouses.", obj()],
  [
    "get_stock_ledger",
    "Recent stock ledger entries for one item.",
    obj({ item_code: CODE }, ["item_code"]),
  ],
  ["list_suppliers", "Suppliers.", obj()],
  ["list_supplier_quotations", "Submitted supplier quotation lines.", obj({ item_code: CODE })],
  ["get_item_prices", "Buying price list rates.", obj({ item_code: CODE })],
  ["list_sales_invoices", "Submitted sales invoices with lines in a date range.", period],
  ["list_pos_invoices", "Submitted POS invoices with lines in a date range.", period],
  ["list_customers", "Customers.", obj()],
  ["get_profit_and_loss", "Posted Profit and Loss summary from ERPNext's standard report.", period],
  ["get_general_ledger", "Posted general ledger entries.", period],
  ["list_purchase_invoices", "Purchase invoices in a date range.", period],
  ["list_sales_lines", "Submitted sales lines in a date range.", period],
  ["list_stock_ledger", "Non-cancelled stock ledger entries in a date range.", period],
  ["list_open_purchase_orders", "Submitted purchase orders with pending quantities.", obj()],
  [
    "get_item_valuation",
    "Per-item group and moving-average valuation rate from Bins.",
    obj({ item_code: CODE }),
  ],
  ["list_batches", "Enabled batches with quantity and expiry date.", obj({ item_code: CODE })],
  [
    "list_receivables",
    "Submitted sales invoices with an outstanding amount on a date.",
    obj({ as_of: DATE }, ["as_of"]),
  ],
  [
    "list_payables",
    "Submitted purchase invoices with an outstanding amount on a date.",
    obj({ as_of: DATE }, ["as_of"]),
  ],
].map(([name, description, inputSchema]) => ({
  name,
  description: `${description} Read-only.`,
  inputSchema,
  annotations: read,
}));

const round = (value) => Math.round(Number(value) * 100) / 100;
const dayAfter = (day, days = 1) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Runs `work` over `items` with bounded concurrency, preserving order. */
async function mapLimit(items, work, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index], index);
      }
    }),
  );
  return out;
}

/**
 * @param {{client: {callTool: Function, listTools: Function}, now?: () => number}} deps
 *   `client` is an MCP client connected to hvgerp-mcp (or a test double with the same surface).
 */
export function createAdapter({ client, now = Date.now }) {
  let verified;
  /** Every hvgerp call goes through here. */
  async function hv(name, args = {}) {
    if (!HVGERP_READS.includes(name)) throw new Error(`${name} is not an allowed ERPNext read.`);
    verified ??= (async () => {
      const listed = (await client.listTools()).tools;
      for (const wanted of HVGERP_READS) {
        const tool = listed.find((row) => row.name === wanted);
        if (!tool) throw new Error(`hvgerp-mcp does not report ${wanted}.`);
        if (tool.annotations?.readOnlyHint !== true)
          throw new Error(`hvgerp-mcp does not mark ${wanted} read-only; refusing to use it.`);
      }
    })();
    await verified;
    if (name === "erpnext_doc_get" && !DOC_GET_TYPES.includes(args.doctype))
      throw new Error(`erpnext_doc_get is not allowed for ${args.doctype}.`);
    if (name === "erpnext_doc_list" && !DOC_LIST_TYPES.includes(args.doctype))
      throw new Error(`erpnext_doc_list is not allowed for ${args.doctype}.`);
    if (name === "erpnext_doc_list" && DOC_LIST_FIELDS[args.doctype]) {
      const extra = (args.fields ?? []).filter(
        (field) => !DOC_LIST_FIELDS[args.doctype].includes(field),
      );
      if (extra.length)
        throw new Error(`erpnext_doc_list may not read ${extra.join(", ")} on ${args.doctype}.`);
    }
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content ?? []).map((part) => part.text ?? "").join("");
    if (result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${name} returned a non-JSON result.`);
    }
  }
  /** A list result must be complete; a truncated one is an error, never silently short. */
  const complete = (name, payload) => {
    if (payload?.has_more === true)
      throw new Error(`${name} returned a partial list (${payload.returned} of ${payload.count}).`);
    return payload?.data ?? [];
  };

  const cache = new Map();
  const cached = async (key, load) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await load();
    cache.set(key, { at: now(), value });
    return value;
  };
  // Submitted documents do not change in line content, so their detail is kept for the process.
  const immutable = new Map();
  const detail = async (tool, args, key) => {
    if (!immutable.has(key))
      immutable.set(
        key,
        hv(tool, args).catch((error) => (immutable.delete(key), Promise.reject(error))),
      );
    return immutable.get(key);
  };

  /** A date window split in half until the server returns it complete. */
  async function windowed(load, from, to) {
    try {
      return await load(from, to);
    } catch (error) {
      if (!/partial list/.test(error.message)) throw error;
      if (from >= to) throw new Error(`More records on ${from} than ERPNext returns in one call.`);
      const middle = dayAfter(from, daysBetween(from, to) >> 1);
      return [
        ...(await windowed(load, from, middle)),
        ...(await windowed(load, dayAfter(middle, 1), to)),
      ];
    }
  }

  const items = () =>
    cached("items", async () => {
      const listed = complete(
        "erpnext_item_list",
        await hv("erpnext_item_list", { limit: 1000, is_stock_item: true }),
      );
      return mapLimit(listed, async (row) => {
        const full = (await hv("erpnext_item_get", { name: row.name })).data ?? {};
        const levels = full.reorder_levels ?? [];
        const level = levels.reduce(
          (sum, entry) => sum + Number(entry.warehouse_reorder_level || 0),
          0,
        );
        const qty = levels.reduce(
          (sum, entry) => sum + Number(entry.warehouse_reorder_qty || 0),
          0,
        );
        return {
          item_code: row.item_code,
          item_name: row.item_name,
          stock_uom: row.stock_uom,
          aliases: row.item_group ? [row.item_group] : [],
          item_group: row.item_group,
          ...(levels.length ? { reorder_level: level, reorder_qty: qty } : {}),
        };
      });
    });

  const invoices = async (kind, from, to) => {
    const docs = await windowed(
      async (a, b) => {
        if (kind === "pos") {
          const listed = await hv("erpnext_doc_list", {
            doctype: "POS Invoice",
            fields: ["name", "docstatus"],
            filters: [
              ["posting_date", ">=", a],
              ["posting_date", "<=", b],
              ["docstatus", "=", 1],
            ],
            limit: 1000,
          });
          return complete("erpnext_doc_list", listed).map((row) => row.name);
        }
        const listed = await hv("erpnext_sales_invoice_list", {
          limit: 1000,
          date_from: a,
          date_to: b,
        });
        return complete("erpnext_sales_invoice_list", listed)
          .filter((row) => !SKIPPED_INVOICE_STATUS.has(row.status))
          .map((row) => row.name);
      },
      from,
      to,
    );
    const full = await mapLimit(docs, async (name) =>
      kind === "pos"
        ? (await detail("erpnext_doc_get", { doctype: "POS Invoice", name }, `pos:${name}`)).data
        : (await detail("erpnext_sales_invoice_get", { name }, `sinv:${name}`)).data,
    );
    return full
      .filter((doc) => doc?.docstatus === 1)
      .map((doc) => ({
        name: doc.name,
        posting_date: doc.posting_date,
        customer: doc.customer,
        grand_total: Number(doc.grand_total),
        docstatus: 1,
        is_pos: kind === "pos",
        is_return: !!doc.is_return,
        items: (doc.items ?? []).map((line) => ({
          item_code: line.item_code,
          qty: Number(line.qty),
          amount: Number(line.amount ?? Number(line.qty) * Number(line.rate)),
        })),
      }));
  };

  const handlers = {
    list_items: async () => ({ items: await items() }),
    async get_stock_balance(args) {
      const payload = await hv("erpnext_stock_balance", {
        limit: 1000,
        ...(args.item_code ? { item_code: args.item_code } : {}),
      });
      return {
        bins: complete("erpnext_stock_balance", payload).map((bin) => ({
          item_code: bin.item_code,
          warehouse: bin.warehouse,
          actual_qty: Number(bin.actual_qty),
          reserved_qty: Number(bin.reserved_qty ?? 0),
          projected_qty: Number(bin.projected_qty ?? 0),
        })),
      };
    },
    async list_warehouses() {
      const payload = await hv("erpnext_warehouse_list", { limit: 200 });
      return {
        warehouses: complete("erpnext_warehouse_list", payload).map((row) => ({ name: row.name })),
      };
    },
    async get_stock_ledger(args) {
      const payload = await hv("erpnext_doc_list", {
        doctype: "Stock Ledger Entry",
        fields: [
          "item_code",
          "warehouse",
          "posting_date",
          "voucher_type",
          "voucher_no",
          "actual_qty",
          "qty_after_transaction",
        ],
        filters: [
          ["item_code", "=", args.item_code],
          ["is_cancelled", "=", 0],
        ],
        order_by: "posting_date desc, posting_time desc, creation desc",
        limit: 200,
      });
      return { entries: payload.data ?? [], truncated: payload.has_more === true };
    },
    async list_suppliers() {
      const payload = await hv("erpnext_supplier_list", { limit: 500 });
      return {
        suppliers: complete("erpnext_supplier_list", payload).map((row) => ({ name: row.name })),
      };
    },
    async list_supplier_quotations(args) {
      const headers = complete(
        "erpnext_supplier_quotation_list",
        await hv("erpnext_supplier_quotation_list", { limit: 500, status: "Submitted" }),
      );
      const docs = await mapLimit(headers, (row) =>
        detail(
          "erpnext_doc_get",
          { doctype: "Supplier Quotation", name: row.name },
          `sq:${row.name}`,
        ),
      );
      const quotations = docs.flatMap(({ data: doc }) =>
        doc?.docstatus === 1
          ? (doc.items ?? []).map((line) => ({
              name: doc.name,
              supplier: doc.supplier,
              item_code: line.item_code,
              rate: Number(line.rate),
              quoted_qty: Number(line.qty),
              ...(Number.isFinite(Number(line.lead_time_days)) && line.lead_time_days !== null
                ? { lead_time_days: Number(line.lead_time_days) }
                : {}),
              valid_till: doc.valid_till ?? undefined,
            }))
          : [],
      );
      return {
        quotations: quotations.filter((row) => !args.item_code || row.item_code === args.item_code),
      };
    },
    async get_item_prices(args) {
      const payload = await hv("erpnext_doc_list", {
        doctype: "Item Price",
        fields: ["item_code", "price_list", "price_list_rate"],
        filters: [
          ["buying", "=", 1],
          ...(args.item_code ? [["item_code", "=", args.item_code]] : []),
        ],
        limit: 1000,
      });
      return {
        prices: complete("erpnext_doc_list", payload).map((row) => ({
          item_code: row.item_code,
          price_list: row.price_list,
          rate: Number(row.price_list_rate),
        })),
      };
    },
    list_sales_invoices: async (args) => ({
      invoices: await invoices("sales", args.from_date, args.to_date),
    }),
    list_pos_invoices: async (args) => ({
      invoices: await invoices("pos", args.from_date, args.to_date),
    }),
    async list_sales_lines(args) {
      const docs = [
        ...(await invoices("sales", args.from_date, args.to_date)),
        ...(await invoices("pos", args.from_date, args.to_date)),
      ];
      return {
        lines: docs.flatMap((doc) =>
          doc.items.map((line) => ({
            item_code: line.item_code,
            qty: line.qty,
            posting_date: doc.posting_date,
            document: doc.name,
          })),
        ),
      };
    },
    async list_stock_ledger(args) {
      const rows = await windowed(
        async (a, b) => {
          const payload = await hv("erpnext_doc_list", {
            doctype: "Stock Ledger Entry",
            fields: [
              "item_code",
              "posting_date",
              "voucher_type",
              "actual_qty",
              "qty_after_transaction",
            ],
            filters: [
              ["posting_date", ">=", a],
              ["posting_date", "<=", b],
              ["is_cancelled", "=", 0],
            ],
            order_by: "posting_date asc, posting_time asc, creation asc",
            limit: 20000,
          });
          return complete("erpnext_doc_list", payload);
        },
        args.from_date,
        args.to_date,
      );
      return { entries: rows };
    },
    async list_open_purchase_orders() {
      const headers = complete(
        "erpnext_purchase_order_list",
        await hv("erpnext_purchase_order_list", { limit: 500 }),
      ).filter((row) => !["Cancelled", "Completed", "Closed"].includes(row.status));
      const docs = await mapLimit(headers, (row) =>
        hv("erpnext_purchase_order_get", { name: row.name }),
      );
      // docstatus, not the status label, decides whether an order is submitted.
      return {
        purchase_orders: docs
          .map(({ data: po }) => po)
          .filter((po) => po?.docstatus === 1)
          .map((po) => ({
            name: po.name,
            supplier: po.supplier,
            schedule_date: po.schedule_date ?? null,
            transaction_date: po.transaction_date ?? null,
            items: (po.items ?? []).map((line) => ({
              item_code: line.item_code,
              ordered_qty: Number(line.qty),
              received_qty: Number(line.received_qty ?? 0),
              pending_qty: round(Number(line.qty) - Number(line.received_qty ?? 0)),
              rate: Number(line.rate ?? 0),
            })),
          })),
      };
    },
    async list_customers() {
      const payload = await hv("erpnext_customer_list", { limit: 1000 });
      return {
        customers: complete("erpnext_customer_list", payload).map((row) => ({ name: row.name })),
      };
    },
    async get_profit_and_loss(args) {
      const report = await hv("erpnext_financial_report", {
        report: "Profit and Loss Statement",
        filters: {
          company: await company(),
          filter_based_on: "Date Range",
          period_start_date: args.from_date,
          period_end_date: args.to_date,
          periodicity: "Monthly",
          accumulated_values: 0,
        },
        limit: 200,
      });
      const figure = (label) => report.report_summary?.find((row) => row.label === label)?.value;
      const [income, expense, net] = [
        figure("Total Income"),
        figure("Total Expense"),
        figure("Net Profit"),
      ];
      if (![income, expense, net].every((value) => Number.isFinite(Number(value))))
        throw new Error(
          "The Profit and Loss report did not return income, expense and net profit.",
        );
      if (Number(income) === 0 && Number(expense) === 0)
        throw new Error("No posted profit and loss data for this period.");
      return {
        period: { from_date: args.from_date, to_date: args.to_date },
        income: round(income),
        expense: round(expense),
        net_profit: round(net),
        report: "Profit and Loss Statement",
      };
    },
    async get_general_ledger(args) {
      const payload = await hv("erpnext_gl_entry_list", {
        limit: 200,
        date_from: args.from_date,
        date_to: args.to_date,
        company: await company(),
      });
      return { entries: payload.data ?? [], truncated: payload.has_more === true };
    },
    async list_purchase_invoices(args) {
      const payload = await hv("erpnext_purchase_invoice_list", {
        limit: 500,
        date_from: args.from_date,
        date_to: args.to_date,
      });
      return { invoices: complete("erpnext_purchase_invoice_list", payload) };
    },
    async get_item_valuation(args) {
      const [listed, bins] = await Promise.all([
        items(),
        hv("erpnext_doc_list", {
          doctype: "Bin",
          fields: DOC_LIST_FIELDS.Bin,
          filters: args.item_code ? [["item_code", "=", args.item_code]] : [],
          limit: 5000,
        }).then((payload) => complete("erpnext_doc_list", payload)),
      ]);
      const groups = new Map(listed.map((row) => [row.item_code, row.item_group ?? null]));
      const totals = new Map();
      for (const bin of bins) {
        const row = totals.get(bin.item_code) ?? { qty: 0, value: 0 };
        row.qty += Number(bin.actual_qty || 0);
        row.value += Number(bin.stock_value || 0);
        totals.set(bin.item_code, row);
      }
      // Quantity-weighted valuation across warehouses; GST slab and selling rates are not read live.
      return {
        valuations: [...totals].map(([item_code, row]) => ({
          item_code,
          item_group: groups.get(item_code) ?? null,
          valuation_rate: row.qty > 0 ? round(row.value / row.qty) : null,
          hsn_code: null,
          gst_rate: null,
        })),
      };
    },
    async list_batches(args) {
      const payload = await hv("erpnext_doc_list", {
        doctype: "Batch",
        fields: DOC_LIST_FIELDS.Batch,
        filters: [["disabled", "=", 0], ...(args.item_code ? [["item", "=", args.item_code]] : [])],
        limit: 5000,
      });
      return {
        batches: complete("erpnext_doc_list", payload).map((row) => ({
          batch_no: row.name,
          item_code: row.item,
          qty: Number(row.batch_qty ?? 0),
          expiry_date: row.expiry_date ?? null,
        })),
      };
    },
    async list_receivables(args) {
      const payload = await hv("erpnext_doc_list", {
        doctype: "Sales Invoice",
        fields: DOC_LIST_FIELDS["Sales Invoice"],
        filters: [
          ["docstatus", "=", 1],
          ["outstanding_amount", ">", 0],
          ["posting_date", "<=", args.as_of],
        ],
        limit: 5000,
      });
      return {
        as_of: args.as_of,
        invoices: complete("erpnext_doc_list", payload).map((row) => ({
          ...row,
          due_date: row.due_date ?? row.posting_date,
          grand_total: Number(row.grand_total),
          outstanding_amount: Number(row.outstanding_amount),
        })),
        // Credit limits live in a child table this adapter does not read; reported as unknown.
        customers: (await handlers.list_customers()).customers.map((row) => ({
          name: row.name,
          customer_group: null,
          credit_limit: null,
        })),
      };
    },
    async list_payables(args) {
      const payload = await hv("erpnext_doc_list", {
        doctype: "Purchase Invoice",
        fields: DOC_LIST_FIELDS["Purchase Invoice"],
        filters: [
          ["docstatus", "=", 1],
          ["outstanding_amount", ">", 0],
          ["posting_date", "<=", args.as_of],
        ],
        limit: 5000,
      });
      return {
        as_of: args.as_of,
        invoices: complete("erpnext_doc_list", payload).map((row) => ({
          ...row,
          due_date: row.due_date ?? row.posting_date,
          grand_total: Number(row.grand_total),
          outstanding_amount: Number(row.outstanding_amount),
        })),
      };
    },
  };

  // The ERPNext company comes from the warehouse list (one company on this site) so it is never
  // hard-coded; more than one company is refused rather than guessed.
  const company = () =>
    cached("company", async () => {
      const warehouses = complete(
        "erpnext_warehouse_list",
        await hv("erpnext_warehouse_list", { limit: 200 }),
      );
      const names = [...new Set(warehouses.map((row) => row.company).filter(Boolean))];
      if (names.length !== 1)
        throw new Error(`Expected exactly one ERPNext company, found ${names.length}.`);
      return names[0];
    });

  return {
    tools: ADAPTER_TOOLS,
    async call(name, args = {}) {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool ${name}.`);
      const body = {
        source: "erpnext_live",
        retrieved_at: new Date(now()).toISOString(),
        ...(await handler(args)),
      };
      return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
    },
  };
}

/** The stdio MCP server wrapped around an adapter. */
export function createAdapterServer(adapter) {
  const server = new Server(
    { name: "nammaops-hvgerp-adapter", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: adapter.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await adapter.call(request.params.name, request.params.arguments ?? {});
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: String(error.message).slice(0, 400) }],
      };
    }
  });
  return server;
}

/** Starts the pinned hvgerp-mcp child with credentials from this process's environment. */
export async function connectHvgerp(env = process.env) {
  const missing = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"].filter(
    (key) => !env[key],
  );
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}.`);
  const url = /^https?:\/\//.test(env.ERPNEXT_URL) ? env.ERPNEXT_URL : `https://${env.ERPNEXT_URL}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve("node_modules/@hvgllc/hvgerp-mcp/hvgerp-mcp.mjs"),
      `--categories=${HVGERP_CATEGORIES}`,
    ],
    env: {
      ...getDefaultEnvironment(),
      ERPNEXT_URL: url.replace(/\/$/, ""),
      ERPNEXT_API_KEY: env.ERPNEXT_API_KEY,
      ERPNEXT_API_SECRET: env.ERPNEXT_API_SECRET,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "nammaops-adapter", version: "1.0.0" });
  await client.connect(transport);
  const version = client.getServerVersion()?.version;
  if (version !== HVGERP_VERSION) {
    await client.close();
    throw new Error(`hvgerp-mcp is ${version}; this adapter is reviewed for ${HVGERP_VERSION}.`);
  }
  return client;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const adapter = createAdapter({ client: await connectHvgerp() });
  await createAdapterServer(adapter).connect(new StdioServerTransport());
}
