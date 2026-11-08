#!/usr/bin/env node
/**
 * NammaOps ERPNext adapter: a narrow MCP server in front of the pinned @hvgllc/hvgerp-mcp 3.7.0.
 * Agents never see hvgerp's 135 tools; the governance gateway only sees the business tools below,
 * which return the same shapes as the test fixture so the workflows are identical for fixture and
 * live data.
 *
 * It is READ-ONLY except for one owner-approved path, customer bills (2026-11-08). Safety is
 * enforced here in code, not in prompts:
 *   - reads: only hvgerp tools the server itself marks readOnlyHint=true are ever called, and only
 *     the ones named in HVGERP_READS, exactly as before;
 *   - the generic erpnext_doc_get / erpnext_doc_list are limited to named DocTypes;
 *   - writes: a separate frozen allowlist, HVGERP_WRITES, reachable only from
 *     create_sales_invoice_draft and submit_sales_invoice with the fixed rules documented there.
 *     There is no cancel, return, delete, payment or generic update tool. Purchase-order writes
 *     are not offered (they are disabled in the live binding).
 *
 * Credentials (ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET) arrive in this process's
 * environment only, are passed to the hvgerp child, and are never returned or logged.
 *
 *   node lib/mcp/hvgerp-adapter-server.mjs
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
  "erpnext_purchase_invoice_get",
  "erpnext_purchase_order_list",
  "erpnext_purchase_order_get",
  "erpnext_gl_entry_list",
  "erpnext_financial_report",
  "erpnext_doc_get",
  "erpnext_doc_list",
]);
/**
 * The ONLY hvgerp tools this adapter may ever use to change ERPNext, kept apart from the read path
 * above (which is unchanged: every read is still verified read-only). Each is reachable from exactly
 * one adapter tool and with fixed arguments:
 *   erpnext_sales_invoice_create  <- create_sales_invoice_draft (a DRAFT, docstatus 0)
 *   erpnext_doc_update            <- the same tool, once, on the draft it just created, setting only
 *                                    update_stock and set_warehouse (see STOCK_FIELDS)
 *   erpnext_sales_invoice_submit  <- submit_sales_invoice (a draft the owner approved by PIN)
 * No cancel, return, delete, payment or any other write is reachable, and nothing else can use
 * erpnext_doc_update. Enabled by the owner on 2026-11-08 for customer bills only.
 */
export const HVGERP_WRITES = Object.freeze([
  "erpnext_sales_invoice_create",
  "erpnext_doc_update",
  "erpnext_sales_invoice_submit",
]);
/** The only fields the draft-fixing update may set, and the only document type it may touch. */
export const STOCK_FIELDS = Object.freeze(["update_stock", "set_warehouse"]);
/** Bounds on one bill: a typo cannot create a huge invoice, and a stale date is refused. */
export const BILL_LIMITS = Object.freeze({ maxLines: 20, maxQty: 50, maxBackdateDays: 7 });
/** Generic reads are limited to these DocTypes. */
export const DOC_GET_TYPES = Object.freeze(["Supplier Quotation", "POS Invoice"]);
export const DOC_LIST_TYPES = Object.freeze([
  "Customer",
  "Price List",
  "Stock Ledger Entry",
  "POS Invoice",
  "Item Price",
  "Bin",
  "Batch",
  "Sales Invoice",
  "Purchase Invoice",
  "Payment Entry",
]);
/** Fields the adapter may request per generic-listed DocType (no free-form field access). */
export const DOC_LIST_FIELDS = Object.freeze({
  Customer: ["name", "disabled"],
  "Price List": ["name", "selling", "enabled", "currency"],
  "Payment Entry": [
    "name",
    "payment_type",
    "posting_date",
    "base_paid_amount",
    "base_received_amount",
    "docstatus",
  ],
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
/** Submitted-document details kept per process; oldest dropped beyond this. */
const IMMUTABLE_MAX = 5000;

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
    "get_purchase_order",
    "One purchase order (any status, including drafts) with its lines.",
    obj({ name: CODE }, ["name"]),
  ],
  [
    "get_payment_summary",
    "Submitted Payment Entries received and paid in a date range (company currency).",
    period,
  ],
  [
    "list_gst_lines",
    "Item-level GST lines (HSN, rate, taxable value, CGST/SGST/IGST) from submitted sales, POS and purchase invoices. Indicative, not a filing.",
    period,
  ],
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
  [
    "get_sales_invoice",
    "One sales invoice (a draft included) with its lines, as ERPNext holds it.",
    obj({ name: CODE }, ["name"]),
  ],
  [
    "get_selling_prices",
    "Selling price list rates for the shop's single selling price list.",
    obj({ item_code: CODE }),
  ],
].map(([name, description, inputSchema]) => ({
  name,
  description: `${description} Read-only.`,
  inputSchema,
  annotations: read,
}));

/** Customer names are free text (spaces, dots, apostrophes); control characters and markup are not. */
const CUSTOMER = { type: "string", minLength: 1, maxLength: 140, pattern: "^[^<>\\u0000-\\u001f]+$" };
/**
 * The bill-writing tools. Listed apart from ADAPTER_TOOLS so the "every tool is read-only" property
 * of the read tools stays checkable on its own. They write only what section HVGERP_WRITES says.
 */
export const ADAPTER_WRITE_TOOLS = [
  {
    name: "create_sales_invoice_draft",
    description:
      "Create a DRAFT sales invoice (docstatus 0) for an existing customer. The caller gives only the customer, the lines (item_code and qty) and optionally the date. The company, price list, currency, warehouse and every rate come from ERPNext itself and cannot be chosen. Draft only: nothing is posted to accounts or stock until it is submitted.",
    inputSchema: obj(
      {
        customer: CUSTOMER,
        posting_date: DATE,
        items: {
          type: "array",
          minItems: 1,
          maxItems: BILL_LIMITS.maxLines,
          items: obj(
            { item_code: CODE, qty: { type: "number", exclusiveMinimum: 0, maximum: BILL_LIMITS.maxQty } },
            ["item_code", "qty"],
          ),
        },
      },
      ["customer", "items"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "submit_sales_invoice",
    description:
      "Submit one draft sales invoice created by create_sales_invoice_draft (posts it to accounts and stock). Only a draft that updates stock and is not a return is accepted. Needs the owner's approval.",
    inputSchema: obj({ name: CODE }, ["name"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

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
 * @param {{client: {callTool: Function, listTools: Function}, now?: () => number,
 *   cacheMs?: number, concurrency?: number}} deps
 *   `client` is an MCP client connected to hvgerp-mcp (or a test double with the same surface).
 *   `cacheMs`: how long reference data (items, company) is reused. `concurrency`: the most hvgerp
 *   requests in flight at once across every tool call of this process.
 */
export function createAdapter({
  client,
  now = Date.now,
  cacheMs = CACHE_MS,
  concurrency = CONCURRENCY,
}) {
  let verified;
  // Process-wide limit on hvgerp requests: parallel tool calls each fan out (mapLimit, window
  // halves), so without a shared cap the one stdio pipe to hvgerp could carry dozens at once.
  let inFlight = 0;
  const waiting = [];
  const slot = async () => {
    if (inFlight >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    inFlight += 1;
  };
  const release = () => {
    inFlight -= 1;
    waiting.shift()?.();
  };
  /**
   * Per tool call counters (hvgerp round trips, cache hits/misses, window splits). Tool calls can
   * overlap on the one stdio pipe, so they are attributed through async context, not a global.
   * @type {AsyncLocalStorage<{hv_calls:number, cache_hits:number, cache_misses:number, splits:number}>}
   */
  const traced = new AsyncLocalStorage();
  const count = (field) => {
    const stats = traced.getStore();
    if (stats) stats[field] += 1;
  };
  /** Every hvgerp call goes through here. */
  async function hv(name, args = {}) {
    if (!HVGERP_READS.includes(name)) throw new Error(`${name} is not an allowed ERPNext read.`);
    count("hv_calls");
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
    // A fresh hvgerp child is slow when its very first requests arrive together (measured
    // 2026-11-08: two concurrent first reads ~1.3 s vs ~0.45 s serial; after one request,
    // concurrent reads are fast). So the first request runs alone and the rest wait for it.
    if (!warmed) {
      if (warming) await warming;
      else {
        let opened;
        warming = new Promise((resolve) => (opened = resolve));
        try {
          return parse(name, await send(name, args));
        } finally {
          warmed = true;
          opened();
        }
      }
    }
    return parse(name, await send(name, args));
  }
  let warmed = false;
  /** @type {Promise<void> | null} */
  let warming = null;
  async function send(name, args) {
    await slot();
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      release();
    }
  }
  function parse(name, result) {
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

  // ---- Writes: a separate path, never mixed with `hv` ------------------------------------------
  let writesVerified;
  /** The only way to change ERPNext. Allowlisted by name; hvgerp must still describe it as a write. */
  async function hvWrite(name, args) {
    if (!HVGERP_WRITES.includes(name)) throw new Error(`${name} is not an allowed ERPNext write.`);
    writesVerified ??= (async () => {
      const listed = (await client.listTools()).tools;
      for (const wanted of HVGERP_WRITES) {
        const tool = listed.find((row) => row.name === wanted);
        if (!tool) throw new Error(`hvgerp-mcp does not report ${wanted}.`);
        if (tool.annotations?.readOnlyHint === true)
          throw new Error(`hvgerp-mcp now marks ${wanted} read-only; this adapter was reviewed for a write.`);
      }
    })();
    await writesVerified;
    // The one update this adapter may ever make: stock fields on a Sales Invoice, nothing else.
    if (name === "erpnext_doc_update") {
      const keys = Object.keys(args.data ?? {});
      if (
        args.doctype !== "Sales Invoice" ||
        keys.length === 0 ||
        keys.some((key) => !STOCK_FIELDS.includes(key))
      )
        throw new Error("erpnext_doc_update may only set update_stock and set_warehouse on a Sales Invoice.");
    }
    return parse(name, await send(name, args));
  }

  /** The invoice as the rest of NammaOps sees it (also what an approval fingerprints). */
  const invoiceView = (doc) => ({
    name: doc.name,
    customer: doc.customer,
    posting_date: doc.posting_date ?? null,
    docstatus: doc.docstatus,
    status: doc.status ?? null,
    update_stock: Number(doc.update_stock ?? 0),
    set_warehouse: doc.set_warehouse ?? null,
    currency: doc.currency ?? null,
    grand_total: round(doc.grand_total ?? 0),
    items: (doc.items ?? []).map((line) => ({
      item_code: line.item_code,
      item_name: line.item_name ?? null,
      qty: Number(line.qty),
      rate: Number(line.rate ?? 0),
      amount: round(line.amount ?? Number(line.qty) * Number(line.rate ?? 0)),
    })),
  });
  const readInvoice = async (name) => {
    const { data: doc } = await hv("erpnext_sales_invoice_get", { name });
    if (!doc?.name) throw new Error(`Sales invoice ${name} not found.`);
    return doc;
  };

  // Reference data, reused for `cacheMs`. The promise is stored, so concurrent callers share one
  // load instead of each fetching the full 1+N item list; a failed load is dropped, never served.
  const cache = new Map();
  const cached = async (key, load) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) {
      count("cache_hits");
      return hit.value;
    }
    count("cache_misses");
    const entry = { at: now(), value: null };
    entry.value = load().then(
      (value) => {
        entry.at = now(); // the TTL runs from when the data was read
        return value;
      },
      (error) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    );
    cache.set(key, entry);
    return entry.value;
  };
  // Submitted documents do not change in line content, so their detail is kept for the process
  // (bounded: the oldest entries are dropped first).
  const immutable = new Map();
  const detail = async (tool, args, key) => {
    count(immutable.has(key) ? "cache_hits" : "cache_misses");
    if (!immutable.has(key)) {
      if (immutable.size >= IMMUTABLE_MAX) immutable.delete(immutable.keys().next().value);
      immutable.set(
        key,
        hv(tool, args).catch((error) => (immutable.delete(key), Promise.reject(error))),
      );
    }
    return immutable.get(key);
  };

  /** A date window split in half until the server returns it complete. */
  async function windowed(load, from, to) {
    try {
      return await load(from, to);
    } catch (error) {
      if (!/partial list/.test(error.message)) throw error;
      if (from >= to) throw new Error(`More records on ${from} than ERPNext returns in one call.`);
      count("splits");
      const middle = dayAfter(from, daysBetween(from, to) >> 1);
      // Both halves are read together; the result keeps chronological (left, right) order.
      const [left, right] = await Promise.all([
        windowed(load, from, middle),
        windowed(load, dayAfter(middle, 1), to),
      ]);
      return [...left, ...right];
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

  /** Full submitted documents (docstatus 1) of one kind in a date range: sales, pos or purchase. */
  const submittedDocs = async (kind, from, to) => {
    const docs = await windowed(
      async (a, b) => {
        if (kind === "purchase") {
          const listed = await hv("erpnext_purchase_invoice_list", {
            limit: 500,
            date_from: a,
            date_to: b,
          });
          return complete("erpnext_purchase_invoice_list", listed)
            .filter((row) => !SKIPPED_INVOICE_STATUS.has(row.status))
            .map((row) => row.name);
        }
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
      kind === "purchase"
        ? (await detail("erpnext_purchase_invoice_get", { name }, `pinv:${name}`)).data
        : kind === "pos"
          ? (await detail("erpnext_doc_get", { doctype: "POS Invoice", name }, `pos:${name}`)).data
          : (await detail("erpnext_sales_invoice_get", { name }, `sinv:${name}`)).data,
    );
    return full.filter((doc) => doc?.docstatus === 1);
  };

  const invoices = async (kind, from, to) =>
    (await submittedDocs(kind, from, to)).map((doc) => ({
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

  /**
   * One GST line per invoice item, straight from the item's own ERPNext tax fields. Party GSTIN,
   * party type and place of supply are only reported when the invoice carries them; otherwise they
   * are null (unknown), never guessed.
   */
  const gstLines = (docs, direction) =>
    docs.flatMap((doc) => {
      const gstin = (direction === "outward" ? doc.billing_address_gstin : doc.supplier_gstin) || null;
      return (doc.items ?? []).map((line) => {
        const cess = round(Number(line.cess_amount ?? 0) + Number(line.cess_non_advol_amount ?? 0));
        const place = doc.place_of_supply || null;
        // Unknown or zero extras are left out (not sent as null) to keep a busy day's response
        // well inside the gateway's response cap; `data_gaps` names what was never available.
        return {
          direction,
          document: doc.name,
          posting_date: doc.posting_date,
          ...((doc.customer ?? doc.supplier) ? { party: doc.customer ?? doc.supplier } : {}),
          ...(gstin ? { party_type: "B2B", gstin } : {}),
          ...(place ? { place_of_supply: place } : {}),
          item_code: line.item_code,
          qty: Number(line.qty ?? 0),
          hsn_code: line.gst_hsn_code || null,
          gst_treatment: line.gst_treatment ?? null,
          gst_rate: round(
            Number(line.igst_rate ?? 0) + Number(line.cgst_rate ?? 0) + Number(line.sgst_rate ?? 0),
          ),
          taxable_value: round(line.taxable_value ?? 0),
          cgst: round(Number(line.cgst_amount ?? 0)),
          sgst: round(Number(line.sgst_amount ?? 0)),
          igst: round(Number(line.igst_amount ?? 0)),
          ...(cess ? { cess } : {}),
          ...(doc.is_return ? { is_return: true } : {}),
        };
      });
    });

  /** The shop's single enabled selling price list; more or fewer is refused rather than guessed. */
  const sellingPriceList = () =>
    cached("selling_price_list", async () => {
      const rows = complete(
        "erpnext_doc_list",
        await hv("erpnext_doc_list", {
          doctype: "Price List",
          fields: DOC_LIST_FIELDS["Price List"],
          filters: [
            ["selling", "=", 1],
            ["enabled", "=", 1],
          ],
          limit: 50,
        }),
      );
      if (rows.length !== 1)
        throw new Error(`Expected exactly one enabled selling price list, found ${rows.length}.`);
      return rows[0];
    });
  /** The shop floor warehouse a bill takes stock from: the company's single "Stores" warehouse. */
  const stockWarehouse = () =>
    cached("stock_warehouse", async () => {
      const owner = await company();
      const rows = complete("erpnext_warehouse_list", await hv("erpnext_warehouse_list", { limit: 200 })).filter(
        (row) => row.company === owner && /^stores\b/i.test(row.name),
      );
      if (rows.length !== 1)
        throw new Error(`Expected exactly one Stores warehouse for ${owner}, found ${rows.length}.`);
      return rows[0].name;
    });
  /** Live selling rate for one item: the price-list rate, else the item's own standard rate. */
  const sellingRate = async (code, priceList) => {
    const [{ data: item }, prices] = await Promise.all([
      hv("erpnext_item_get", { name: code }),
      hv("erpnext_doc_list", {
        doctype: "Item Price",
        fields: ["item_code", "price_list", "price_list_rate"],
        filters: [
          ["selling", "=", 1],
          ["price_list", "=", priceList],
          ["item_code", "=", code],
        ],
        limit: 5,
      }),
    ]);
    if (!item?.name || Number(item.disabled) || !Number(item.is_stock_item))
      throw new Error(`${code} is not an active stock item; no bill was created.`);
    const listed = Number(complete("erpnext_doc_list", prices)[0]?.price_list_rate);
    const rate = listed > 0 ? listed : Number(item.standard_rate);
    if (!(rate > 0)) throw new Error(`${code} has no selling price; no bill was created.`);
    return { rate, item_name: item.item_name ?? code };
  };

  const handlers = {
    async get_sales_invoice(args) {
      return { invoice: invoiceView(await readInvoice(args.name)) };
    },
    async get_selling_prices(args) {
      const priceList = await sellingPriceList();
      const payload = await hv("erpnext_doc_list", {
        doctype: "Item Price",
        fields: ["item_code", "price_list", "price_list_rate"],
        filters: [
          ["selling", "=", 1],
          ["price_list", "=", priceList.name],
          ...(args.item_code ? [["item_code", "=", args.item_code]] : []),
        ],
        limit: 5000,
      });
      return {
        price_list: priceList.name,
        currency: priceList.currency ?? null,
        prices: complete("erpnext_doc_list", payload).map((row) => ({
          item_code: row.item_code,
          rate: Number(row.price_list_rate),
        })),
      };
    },
    /**
     * A DRAFT bill. Everything that decides money comes from ERPNext, not from the caller: the
     * customer must already exist, each rate is the live selling price, and the company, price list,
     * currency and warehouse are the shop's single ones. It is then set to update stock (as every
     * invoice in this ERP is), and read back to confirm. It is never submitted here.
     */
    async create_sales_invoice_draft(args) {
      const today = new Date(now()).toISOString().slice(0, 10);
      const date = args.posting_date ?? today;
      const earliest = dayAfter(today, -BILL_LIMITS.maxBackdateDays);
      const latest = dayAfter(today, 1);
      if (date < earliest || date > latest)
        throw new Error(`The bill date must be between ${earliest} and ${latest}; no bill was created.`);
      const wanted = new Map();
      for (const line of args.items)
        wanted.set(line.item_code, round((wanted.get(line.item_code) ?? 0) + line.qty));
      for (const [code, qty] of wanted)
        if (!(qty > 0) || qty > BILL_LIMITS.maxQty)
          throw new Error(`${code}: quantity must be above 0 and at most ${BILL_LIMITS.maxQty}.`);
      const customers = complete(
        "erpnext_doc_list",
        await hv("erpnext_doc_list", {
          doctype: "Customer",
          fields: DOC_LIST_FIELDS.Customer,
          filters: [["name", "=", args.customer]],
          limit: 1,
        }),
      );
      if (!customers.length)
        throw new Error(`Customer "${args.customer}" does not exist in ERPNext; no bill was created.`);
      if (Number(customers[0].disabled))
        throw new Error(`Customer "${args.customer}" is disabled; no bill was created.`);
      const [priceList, warehouse, owner] = await Promise.all([
        sellingPriceList(),
        stockWarehouse(),
        company(),
      ]);
      const codes = [...wanted.keys()];
      const rates = await mapLimit(codes, (code) => sellingRate(code, priceList.name));
      const lines = codes.map((code, index) => ({
        item_code: code,
        qty: wanted.get(code),
        rate: rates[index].rate,
        warehouse,
      }));
      const created = await hvWrite("erpnext_sales_invoice_create", {
        customer: args.customer,
        items: lines,
        posting_date: date,
        due_date: date,
        company: owner,
        selling_price_list: priceList.name,
        ...(priceList.currency ? { currency: priceList.currency } : {}),
        set_warehouse: warehouse,
      });
      const made = created?.data ?? created?.invoice ?? created;
      const draftName = made?.name;
      if (!draftName)
        throw new Error(
          "ERPNext did not say which draft it created. Check ERPNext for a new draft sales invoice before trying again; nothing was submitted.",
        );
      try {
        await hvWrite("erpnext_doc_update", {
          doctype: "Sales Invoice",
          name: draftName,
          data: { update_stock: 1, set_warehouse: warehouse },
        });
      } catch (error) {
        throw new Error(
          `Draft ${draftName} was created but could not be set to update stock (${String(error.message).slice(0, 160)}). It was not submitted: fix or remove it in ERPNext.`,
        );
      }
      const doc = await readInvoice(draftName);
      const sold = new Map((doc.items ?? []).map((row) => [row.item_code, Number(row.qty)]));
      if (
        doc.docstatus !== 0 ||
        !Number(doc.update_stock) ||
        doc.customer !== args.customer ||
        sold.size !== wanted.size ||
        [...wanted].some(([code, qty]) => sold.get(code) !== qty)
      )
        throw new Error(
          `Draft ${draftName} does not match what was asked for. It was not submitted: check it in ERPNext.`,
        );
      return { invoice: invoiceView(doc) };
    },
    /** Submits one draft this adapter's create tool made. Anything else is refused untouched. */
    async submit_sales_invoice(args) {
      const before = await readInvoice(args.name);
      if (before.docstatus !== 0)
        throw new Error(`Sales invoice ${args.name} is not a draft; nothing was submitted.`);
      if (!Number(before.update_stock) || Number(before.is_return))
        throw new Error(
          `Sales invoice ${args.name} is not one of the bills created here (it must update stock and not be a return); nothing was submitted.`,
        );
      await hvWrite("erpnext_sales_invoice_submit", { name: args.name });
      return { invoice: invoiceView(await readInvoice(args.name)) };
    },
    list_items: async () => ({ items: await items() }),
    async get_purchase_order(args) {
      const { data: po } = await hv("erpnext_purchase_order_get", { name: args.name });
      if (!po?.name) throw new Error(`Purchase order ${args.name} not found.`);
      return {
        purchase_order: {
          name: po.name,
          supplier: po.supplier,
          transaction_date: po.transaction_date ?? null,
          schedule_date: po.schedule_date ?? null,
          items: (po.items ?? []).map((line) => ({
            item_code: line.item_code,
            qty: Number(line.qty),
            rate: Number(line.rate ?? 0),
            amount: Number(line.amount ?? Number(line.qty) * Number(line.rate ?? 0)),
            received_qty: Number(line.received_qty ?? 0),
          })),
          docstatus: po.docstatus,
          status: po.status,
          grand_total: Number(po.grand_total ?? 0),
        },
      };
    },
    async get_payment_summary(args) {
      const rows = await windowed(
        async (a, b) =>
          complete(
            "erpnext_doc_list",
            await hv("erpnext_doc_list", {
              doctype: "Payment Entry",
              fields: DOC_LIST_FIELDS["Payment Entry"],
              filters: [
                ["posting_date", ">=", a],
                ["posting_date", "<=", b],
                ["docstatus", "=", 1],
              ],
              limit: 5000,
            }),
          ),
        args.from_date,
        args.to_date,
      );
      const total = (type, field) =>
        round(
          rows.filter((row) => row.payment_type === type).reduce((sum, r) => sum + Number(r[field] ?? 0), 0),
        );
      return {
        received: total("Receive", "base_received_amount"),
        paid: total("Pay", "base_paid_amount"),
        count: rows.length,
      };
    },
    async list_gst_lines(args) {
      const [sales, pos, purchases] = await Promise.all([
        submittedDocs("sales", args.from_date, args.to_date),
        submittedDocs("pos", args.from_date, args.to_date),
        submittedDocs("purchase", args.from_date, args.to_date),
      ]);
      const lines = [
        ...gstLines([...sales, ...pos], "outward"),
        ...gstLines(purchases, "inward"),
      ];
      // Fields the invoices did not carry at all in this period, so a reader knows they are unknown.
      const data_gaps = lines.length
        ? ["gstin", "place_of_supply"].filter((field) => lines.every((row) => row[field] === undefined))
        : [];
      return { company_state: null, data_gaps, lines };
    },
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
      // Sales and POS invoices are independent reads; sales lines still come first.
      const [sales, pos] = await Promise.all([
        invoices("sales", args.from_date, args.to_date),
        invoices("pos", args.from_date, args.to_date),
      ]);
      const docs = [...sales, ...pos];
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
      // The customer list does not depend on the invoices, so both are read together.
      const [payload, customerList] = await Promise.all([
        hv("erpnext_doc_list", {
          doctype: "Sales Invoice",
          fields: DOC_LIST_FIELDS["Sales Invoice"],
          filters: [
            ["docstatus", "=", 1],
            ["outstanding_amount", ">", 0],
            ["posting_date", "<=", args.as_of],
          ],
          limit: 5000,
        }),
        handlers.list_customers(),
      ]);
      return {
        as_of: args.as_of,
        invoices: complete("erpnext_doc_list", payload).map((row) => ({
          ...row,
          due_date: row.due_date ?? row.posting_date,
          grand_total: Number(row.grand_total),
          outstanding_amount: Number(row.outstanding_amount),
        })),
        // Credit limits live in a child table this adapter does not read; reported as unknown.
        customers: customerList.customers.map((row) => ({
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
    tools: [...ADAPTER_TOOLS, ...ADAPTER_WRITE_TOOLS],
    async call(name, args = {}) {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool ${name}.`);
      const stats = { hv_calls: 0, cache_hits: 0, cache_misses: 0, splits: 0 };
      const started = performance.now();
      const data = await traced.run(stats, () => handler(args));
      const body = {
        source: "erpnext_live",
        retrieved_at: new Date(now()).toISOString(),
        ...data,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(body) }],
        structuredContent: body,
        // Timing metadata travels outside the business payload, so results stay byte-identical.
        _meta: { nammaops: { ...stats, adapter_ms: Math.round(performance.now() - started) } },
      };
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
  // cacheMs / concurrency keep their code defaults: this child receives only the ERPNext
  // credentials in its environment, and its exact command line is pinned by the stdio allowlist.
  const adapter = createAdapter({ client: await connectHvgerp() });
  await createAdapterServer(adapter).connect(new StdioServerTransport());
}
