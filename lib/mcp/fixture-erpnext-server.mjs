#!/usr/bin/env node
/**
 * TEST FIXTURE. An ERPNext-shaped MCP server for building NammaOps without a live ERPNext.
 * Business data is read from a JSON file on every call (edit it to simulate ERPNext changes);
 * purchase orders persist to a separate state file. Every result carries `source: "fixture"`.
 * Tool names here are this fixture's own; the real ERPNext MCP server is bound separately.
 *
 *   node lib/mcp/fixture-erpnext-server.mjs [--data <file>] [--state <file>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const CODE = { type: "string", pattern: "^[A-Za-z0-9 _.-]{1,64}$" };
const obj = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const read = { readOnlyHint: true };

export const FIXTURE_ERP_TOOLS = [
  {
    name: "list_items",
    description: "Fixture: list items with reorder settings.",
    inputSchema: obj(),
    annotations: read,
  },
  {
    name: "get_stock_balance",
    description: "Fixture: actual quantity per item and warehouse.",
    inputSchema: obj({ item_code: CODE }),
    annotations: read,
  },
  {
    name: "list_warehouses",
    description: "Fixture: list warehouses.",
    inputSchema: obj(),
    annotations: read,
  },
  {
    name: "get_stock_ledger",
    description: "Fixture: stock ledger entries for an item.",
    inputSchema: obj({ item_code: CODE }, ["item_code"]),
    annotations: read,
  },
  {
    name: "list_suppliers",
    description: "Fixture: list suppliers.",
    inputSchema: obj(),
    annotations: read,
  },
  {
    name: "list_supplier_quotations",
    description: "Fixture: supplier quotation lines, optionally for one item.",
    inputSchema: obj({ item_code: CODE }),
    annotations: read,
  },
  {
    name: "get_item_prices",
    description: "Fixture: buying price list rates, optionally for one item.",
    inputSchema: obj({ item_code: CODE }),
    annotations: read,
  },
  {
    name: "create_purchase_order",
    description: "Fixture: create a DRAFT purchase order (docstatus 0).",
    inputSchema: obj(
      {
        supplier: CODE,
        schedule_date: DATE,
        items: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: obj(
            {
              item_code: CODE,
              qty: { type: "number", exclusiveMinimum: 0 },
              rate: { type: "number", minimum: 0 },
            },
            ["item_code", "qty", "rate"],
          ),
        },
      },
      ["supplier", "items"],
    ),
    annotations: { readOnlyHint: false },
  },
  {
    name: "get_purchase_order",
    description: "Fixture: read one purchase order.",
    inputSchema: obj({ name: CODE }, ["name"]),
    annotations: read,
  },
  {
    name: "submit_purchase_order",
    description: "Fixture: submit a draft purchase order to the supplier (docstatus 0 -> 1).",
    inputSchema: obj({ name: CODE }, ["name"]),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "list_sales_invoices",
    description: "Fixture: submitted sales invoices in a date range.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "list_pos_invoices",
    description: "Fixture: submitted POS invoices in a date range.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "list_customers",
    description: "Fixture: list customers.",
    inputSchema: obj(),
    annotations: read,
  },
  {
    name: "get_profit_and_loss",
    description: "Fixture: posted profit and loss for a period.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "get_general_ledger",
    description: "Fixture: general ledger entries in a period.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "list_purchase_invoices",
    description: "Fixture: purchase invoices in a period.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "list_sales_lines",
    description: "Fixture: item-level lines from submitted sales and POS invoices in a date range.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "list_stock_ledger",
    description:
      "Fixture: stock ledger entries with the balance after each transaction, in a date range.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "list_open_purchase_orders",
    description: "Fixture: submitted purchase orders not yet fully received.",
    inputSchema: obj(),
    annotations: read,
  },
  {
    name: "get_payment_summary",
    description: "Fixture: payments received and paid in a period.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
  {
    name: "get_item_valuation",
    description:
      "Fixture: per-item group, HSN code, GST slab, valuation rate and retail/wholesale selling rates.",
    inputSchema: obj({ item_code: CODE }),
    annotations: read,
  },
  {
    name: "list_batches",
    description: "Fixture: stock batches with quantity and expiry date.",
    inputSchema: obj({ item_code: CODE }),
    annotations: read,
  },
  {
    name: "list_receivables",
    description:
      "Fixture: submitted sales invoices with an outstanding amount on a date, plus customer credit limits.",
    inputSchema: obj({ as_of: DATE }, ["as_of"]),
    annotations: read,
  },
  {
    name: "list_payables",
    description: "Fixture: submitted purchase invoices with an outstanding amount on a date.",
    inputSchema: obj({ as_of: DATE }, ["as_of"]),
    annotations: read,
  },
  {
    name: "list_gst_lines",
    description:
      "Fixture: item-level GST lines (HSN, slab, taxable value, CGST/SGST/IGST) for outward and inward supplies in a date range. Indicative, not a filing.",
    inputSchema: obj({ from_date: DATE, to_date: DATE }, ["from_date", "to_date"]),
    annotations: read,
  },
];

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * GST lines for one document. Line amounts are tax-inclusive (Indian retail MRP); the taxable
 * value is backed out of the slab. Same state means CGST + SGST, different state means IGST.
 */
function gstLines(doc, { masters, ownState, partyState, partyType, gstin, direction }) {
  return (doc.items ?? []).map((line) => {
    const master = masters.get(line.item_code);
    const rate = Number(master?.gst_rate ?? 0);
    const gross = Number(line.amount ?? 0);
    const taxable = round2((gross * 100) / (100 + rate));
    const tax = round2(gross - taxable);
    const interState = Boolean(partyState) && partyState !== ownState;
    return {
      direction,
      document: doc.name,
      posting_date: doc.posting_date,
      party: doc.customer ?? doc.supplier ?? null,
      party_type: partyType,
      ...(gstin ? { gstin } : {}),
      place_of_supply: partyState ?? ownState,
      item_code: line.item_code,
      qty: Number(line.qty ?? 0),
      hsn_code: master?.hsn_code ?? null,
      gst_rate: rate,
      taxable_value: taxable,
      cgst: interState ? 0 : round2(tax / 2),
      sgst: interState ? 0 : round2(tax - round2(tax / 2)),
      igst: interState ? tax : 0,
    };
  });
}

const between = (date, from, to) => date >= from && date <= to;
const nextDay = (day, n = 1) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Deterministic PRNG so the generated history is identical on every run. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Expands `demand_history` into daily POS invoices and stock ledger entries. Stock never goes
 * negative; during a stockout window nothing can be sold; a final reconciliation sets each
 * item's balance to its current bin quantity so history and today's stock agree.
 */
export function generateHistory(data) {
  const spec = data.demand_history;
  if (!spec) return { invoices: [], ledger: [] };
  const random = rng(spec.seed ?? 1);
  const price = (code) => data.item_prices.find((row) => row.item_code === code)?.rate ?? 50;
  const items = new Map(data.items.map((item) => [item.item_code, item]));
  const invoices = new Map();
  const ledger = [];
  const entry = (code, day, type, qty, balance) =>
    ledger.push({
      item_code: code,
      posting_date: day,
      voucher_type: type,
      actual_qty: qty,
      qty_after_transaction: balance,
    });
  for (const [code, profile] of Object.entries(spec.profiles)) {
    const item = items.get(code);
    if (!item) continue;
    const refill = (item.reorder_qty ?? 20) * 2;
    let balance = refill;
    let pendingReceipt = false;
    let started = false;
    for (let day = spec.start; day <= spec.end; day = nextDay(day)) {
      if (profile.launched && day < profile.launched) continue;
      if (!started) {
        entry(code, day, "Stock Reconciliation", balance, balance);
        started = true;
      }
      const inStockout =
        profile.stockout && between(day, profile.stockout.from, profile.stockout.to);
      if (pendingReceipt && !inStockout) {
        balance += refill;
        entry(code, day, "Purchase Receipt", refill, balance);
        pendingReceipt = false;
      }
      if (inStockout) {
        if (balance > 0) {
          entry(code, day, "Stock Reconciliation", -balance, 0);
          balance = 0;
        }
        pendingReceipt = true;
        continue;
      }
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      let factor = dow === 0 || dow === 6 ? (profile.weekend ?? 1) : 1;
      if (profile.promo && between(day, profile.promo.from, profile.promo.to))
        factor *= profile.promo.factor;
      const qty = Math.min(balance, Math.round(profile.base * factor * (0.75 + random() * 0.5)));
      if (qty > 0) {
        balance -= qty;
        entry(code, day, "Sales Invoice", -qty, balance);
        const invoice = invoices.get(day) ?? {
          name: `HIST-POS-${day}`,
          posting_date: day,
          customer: "Walk-in Customer",
          docstatus: 1,
          is_pos: true,
          synthetic: true,
          items: [],
        };
        invoice.items.push({ item_code: code, qty, amount: qty * price(code) });
        invoices.set(day, invoice);
      }
      if (balance <= (item.reorder_level ?? 0)) pendingReceipt = true;
    }
    const current = data.bins
      .filter((bin) => bin.item_code === code)
      .reduce((sum, bin) => sum + bin.actual_qty, 0);
    entry(code, nextDay(spec.end), "Stock Reconciliation", current - balance, current);
  }
  for (const invoice of invoices.values())
    invoice.grand_total = invoice.items.reduce((sum, row) => sum + row.amount, 0);
  return { invoices: [...invoices.values()], ledger };
}

/** @param {{dataPath?: string, statePath?: string}} [options] */
export function createFixtureErpServer({ dataPath, statePath } = {}) {
  const dataFile = resolve(dataPath ?? "config/nammaops/fixture-data.json");
  const stateFile = resolve(statePath ?? join(tmpdir(), "nammaops-fixture-po-state.json"));
  const data = () => JSON.parse(readFileSync(dataFile, "utf8"));
  const state = () =>
    existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { purchase_orders: [] };
  const save = (value) => writeFileSync(stateFile, JSON.stringify(value, null, 2));
  const ok = (value) => {
    const body = { source: "fixture", ...value };
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  };
  const error = (text) => ({ isError: true, content: [{ type: "text", text }] });

  const server = new Server(
    { name: "nammaops-fixture-erpnext", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FIXTURE_ERP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const d = data();
    switch (name) {
      case "list_items":
        return ok({ items: d.items });
      case "get_stock_balance":
        return ok({
          bins: d.bins.filter((bin) => !args.item_code || bin.item_code === args.item_code),
        });
      case "list_warehouses":
        return ok({ warehouses: d.warehouses });
      case "get_stock_ledger":
        return ok({ entries: d.stock_ledger.filter((row) => row.item_code === args.item_code) });
      case "list_suppliers":
        return ok({ suppliers: d.suppliers });
      case "list_supplier_quotations":
        return ok({
          quotations: d.supplier_quotations.filter(
            (row) => !args.item_code || row.item_code === args.item_code,
          ),
        });
      case "get_item_prices":
        return ok({
          prices: d.item_prices.filter(
            (row) => !args.item_code || row.item_code === args.item_code,
          ),
        });
      case "create_purchase_order": {
        if (!d.suppliers.some((row) => row.name === args.supplier))
          return error(`Unknown supplier ${args.supplier}.`);
        const s = state();
        const po = {
          name: `PUR-ORD-FX-${String(s.purchase_orders.length + 1).padStart(4, "0")}`,
          supplier: args.supplier,
          schedule_date: args.schedule_date ?? null,
          items: args.items.map(({ item_code, qty, rate }) => ({
            item_code,
            qty,
            rate,
            amount: Math.round(qty * rate * 100) / 100,
          })),
          docstatus: 0,
          status: "Draft",
        };
        po.grand_total = Math.round(po.items.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
        s.purchase_orders.push(po);
        save(s);
        return ok({ purchase_order: po });
      }
      case "get_purchase_order": {
        const po = state().purchase_orders.find((row) => row.name === args.name);
        return po ? ok({ purchase_order: po }) : error(`Purchase order ${args.name} not found.`);
      }
      case "submit_purchase_order": {
        const s = state();
        const po = s.purchase_orders.find((row) => row.name === args.name);
        if (!po) return error(`Purchase order ${args.name} not found.`);
        if (po.docstatus !== 0) return error(`Purchase order ${args.name} is already submitted.`);
        po.docstatus = 1;
        po.status = "To Receive and Bill";
        save(s);
        return ok({ purchase_order: po });
      }
      case "list_sales_invoices":
      case "list_pos_invoices": {
        const pos = name === "list_pos_invoices";
        return ok({
          invoices: [...d.sales_invoices, ...generateHistory(d).invoices].filter(
            (row) =>
              row.docstatus === 1 &&
              Boolean(row.is_pos) === pos &&
              between(row.posting_date, args.from_date, args.to_date),
          ),
        });
      }
      case "list_sales_lines": {
        const lines = [];
        for (const invoice of [...d.sales_invoices, ...generateHistory(d).invoices])
          if (
            invoice.docstatus === 1 &&
            between(invoice.posting_date, args.from_date, args.to_date)
          )
            for (const line of invoice.items)
              lines.push({
                item_code: line.item_code,
                qty: line.qty,
                posting_date: invoice.posting_date,
                document: invoice.name,
              });
        return ok({ lines });
      }
      case "list_stock_ledger":
        return ok({
          entries: [...d.stock_ledger, ...generateHistory(d).ledger].filter(
            (row) =>
              row.qty_after_transaction !== undefined &&
              between(row.posting_date, args.from_date, args.to_date),
          ),
        });
      case "list_open_purchase_orders": {
        const submitted = state().purchase_orders.filter(
          (po) => po.docstatus === 1 && !po.received,
        );
        return ok({
          purchase_orders: [...(d.open_purchase_orders ?? []), ...submitted].map((po) => ({
            name: po.name,
            supplier: po.supplier,
            schedule_date: po.schedule_date ?? null,
            transaction_date: po.transaction_date ?? null,
            items: po.items.map((row) => ({
              item_code: row.item_code,
              ordered_qty: Number(row.qty),
              received_qty: Number(row.received_qty ?? 0),
              pending_qty: Number(row.qty) - Number(row.received_qty ?? 0),
              rate: row.rate ?? null,
            })),
          })),
        });
      }
      case "list_customers":
        return ok({ customers: d.customers });
      case "get_profit_and_loss": {
        const rows = (d.profit_and_loss ?? []).filter((row) =>
          between(row.date, args.from_date, args.to_date),
        );
        if (!rows.length) return error("No posted profit and loss data for this period.");
        const sum = (key) =>
          Math.round(rows.reduce((total, row) => total + row[key], 0) * 100) / 100;
        return ok({
          period: { from_date: args.from_date, to_date: args.to_date },
          income: sum("income"),
          expense: sum("expense"),
          net_profit: sum("net_profit"),
        });
      }
      case "get_general_ledger":
        return ok({
          entries: (d.general_ledger ?? []).filter((row) =>
            between(row.posting_date, args.from_date, args.to_date),
          ),
        });
      case "list_purchase_invoices":
        return ok({
          invoices: (d.purchase_invoices ?? []).filter((row) =>
            between(row.posting_date, args.from_date, args.to_date),
          ),
        });
      case "get_payment_summary": {
        const rows = (d.payments ?? []).filter((row) =>
          between(row.posting_date, args.from_date, args.to_date),
        );
        const total = (type) =>
          rows.filter((row) => row.payment_type === type).reduce((s, r) => s + r.amount, 0);
        return ok({ received: total("Receive"), paid: total("Pay"), count: rows.length });
      }
      case "get_item_valuation":
        return ok({
          valuations: (d.item_master ?? []).filter(
            (row) => !args.item_code || row.item_code === args.item_code,
          ),
        });
      case "list_batches":
        return ok({
          batches: (d.batches ?? []).filter(
            (row) => !args.item_code || row.item_code === args.item_code,
          ),
        });
      case "list_receivables":
        return ok({
          as_of: args.as_of,
          invoices: d.sales_invoices
            .filter(
              (row) =>
                row.docstatus === 1 &&
                row.posting_date <= args.as_of &&
                Number(row.outstanding_amount ?? 0) > 0,
            )
            .map(({ name, customer, posting_date, due_date, grand_total, outstanding_amount }) => ({
              name,
              customer,
              posting_date,
              due_date: due_date ?? posting_date,
              grand_total,
              outstanding_amount,
            })),
          customers: d.customers.map(({ name, customer_group, credit_limit }) => ({
            name,
            customer_group: customer_group ?? null,
            credit_limit: credit_limit ?? null,
          })),
        });
      case "list_payables":
        return ok({
          as_of: args.as_of,
          invoices: (d.purchase_invoices ?? [])
            .filter(
              (row) =>
                row.docstatus === 1 &&
                row.posting_date <= args.as_of &&
                Number(row.outstanding_amount ?? 0) > 0,
            )
            .map(({ name, supplier, posting_date, due_date, grand_total, outstanding_amount }) => ({
              name,
              supplier,
              posting_date,
              due_date: due_date ?? posting_date,
              grand_total,
              outstanding_amount,
            })),
        });
      case "list_gst_lines": {
        const masters = new Map((d.item_master ?? []).map((row) => [row.item_code, row]));
        const ownState = d.company_state ?? null;
        const customers = new Map(d.customers.map((row) => [row.name, row]));
        const suppliers = new Map(d.suppliers.map((row) => [row.name, row]));
        const lines = [];
        for (const invoice of [...d.sales_invoices, ...generateHistory(d).invoices]) {
          if (
            invoice.docstatus !== 1 ||
            !between(invoice.posting_date, args.from_date, args.to_date)
          )
            continue;
          const customer = customers.get(invoice.customer);
          lines.push(
            ...gstLines(invoice, {
              masters,
              ownState,
              partyState: customer?.state,
              partyType: customer?.gstin ? "B2B" : "B2C",
              gstin: customer?.gstin,
              direction: "outward",
            }),
          );
        }
        for (const bill of d.purchase_invoices ?? []) {
          if (bill.docstatus !== 1 || !between(bill.posting_date, args.from_date, args.to_date))
            continue;
          const supplier = suppliers.get(bill.supplier);
          lines.push(
            ...gstLines(bill, {
              masters,
              ownState,
              partyState: supplier?.state,
              partyType: supplier?.gstin ? "B2B" : "Unregistered",
              gstin: supplier?.gstin,
              direction: "inward",
            }),
          );
        }
        return ok({ company_state: ownState, lines });
      }
      default:
        return error(`Unknown tool ${name}`);
    }
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flag = (key) => {
    const index = process.argv.indexOf(key);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  await createFixtureErpServer({ dataPath: flag("--data"), statePath: flag("--state") }).connect(
    new StdioServerTransport(),
  );
}
