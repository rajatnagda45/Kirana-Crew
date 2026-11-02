#!/usr/bin/env node
/**
 * Phase G1: authenticated READ-ONLY verification of the pinned hvgerp-mcp against the seeded
 * ERPNext site. Only tools whose own annotation is readOnlyHint=true and whose name is not a write
 * verb can be called; anything else throws before a request is made. Prints shapes and counts,
 * never credentials.
 *
 *   node scripts/erpnext-mcp-verify-read.mjs [--out=file.json]
 */
import { writeFileSync } from "node:fs";
import { connectHvgerp, erpnextEnv } from "./erpnext-mcp-discover.mjs";

const COMPANY = process.env.NAMMAOPS_SEED_COMPANY ?? "NammaOPs";
const WAREHOUSE = process.env.NAMMAOPS_SEED_WAREHOUSE ?? "Stores - N";
const WRITE_VERB = /(create|update|submit|cancel|delete|insert|save|amend|fix|upload|call)/;

const { client, connect, stderr } = connectHvgerp("sales,inventory,purchasing,accounting");
await connect();
const listed = (await client.listTools()).tools;
const byName = new Map(listed.map((tool) => [tool.name, tool]));

const log = [];
/** The only way this script talks to the server. */
async function read(name, args = {}) {
  const tool = byName.get(name);
  if (!tool) throw new Error(`${name} was not reported by listTools().`);
  if (tool.annotations?.readOnlyHint !== true || WRITE_VERB.test(name))
    throw new Error(`Refusing ${name}: not marked read-only by the server.`);
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((part) => part.text ?? "").join("");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  log.push({ name, args, isError: !!result.isError, ms: Date.now() - started });
  return { isError: !!result.isError, data, structured: result.structuredContent, text };
}

/** Direct, read-only REST cross-check (GET only) using the same credentials. */
const env = erpnextEnv();
async function rest(path) {
  const response = await fetch(`${env.ERPNEXT_URL}${path}`, {
    headers: { Authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}` },
  });
  return (await response.json()).message;
}
const count = (doctype, filters = []) =>
  rest(
    `/api/method/frappe.client.get_count?doctype=${encodeURIComponent(doctype)}&filters=${encodeURIComponent(JSON.stringify(filters))}`,
  );

const rowsOf = (payload) =>
  Array.isArray(payload)
    ? payload
    : (payload?.data ?? payload?.items ?? payload?.rows ?? payload?.results ?? []);
const shape = (payload) =>
  Array.isArray(payload)
    ? `array(${payload.length})`
    : typeof payload === "object" && payload
      ? `{${Object.keys(payload).join(",")}}`
      : typeof payload;
const out = {};
const show = (label, value) => {
  out[label] = value;
  console.log(
    `\n## ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 1)}`,
  );
};

// 1. Identity: must be the key's user, never Administrator.
const who = await read("erpnext_whoami");
show("whoami", {
  isError: who.isError,
  shape: shape(who.data),
  user: who.data?.user ?? who.data?.name ?? who.data?.email ?? who.data?.user_id,
  roles: who.data?.roles,
  isAdministrator: JSON.stringify(who.data).includes('"Administrator"'),
});

// 2. Items
const items = await read("erpnext_item_list", { limit: 100 });
const itemRows = rowsOf(items.data);
show("items", {
  isError: items.isError,
  shape: shape(items.data),
  returned: itemRows.length,
  seeded_NK: itemRows.filter((row) => String(row.item_code).startsWith("NK-")).length,
  restCount_NK: await count("Item", [["item_code", "like", "NK-%"]]),
  sample: itemRows.slice(0, 2),
});

// 3. Warehouses
const warehouses = await read("erpnext_warehouse_list", { limit: 50, company: COMPANY });
show("warehouses", {
  isError: warehouses.isError,
  names: rowsOf(warehouses.data).map((row) => row.name),
});

// 4. Stock balance (Bin)
const balances = await read("erpnext_stock_balance", { limit: 100, warehouse: WAREHOUSE });
const binRows = rowsOf(balances.data);
show("stock_balance", {
  isError: balances.isError,
  shape: shape(balances.data),
  returned: binRows.length,
  restBins: await count("Bin", [["warehouse", "=", WAREHOUSE]]),
  sample: binRows.slice(0, 3),
});

// 5. Sales invoices
const invoices = await read("erpnext_sales_invoice_list", {
  limit: 500,
  date_from: "2026-10-31",
  date_to: "2026-10-31",
});
const invoiceRows = rowsOf(invoices.data);
show("sales_invoices_2026-10-31", {
  isError: invoices.isError,
  shape: shape(invoices.data),
  returned: invoiceRows.length,
  restCount: await count("Sales Invoice", [
    ["posting_date", "=", "2026-10-31"],
    ["docstatus", "=", 1],
  ]),
  statuses: [...new Set(invoiceRows.map((row) => row.status))],
  sample: invoiceRows.slice(0, 1),
});
const total = await read("erpnext_sales_invoice_list", {
  limit: 1000,
  date_from: "2026-08-01",
  date_to: "2026-11-01",
});
show("sales_invoices_all", {
  isError: total.isError,
  returned: rowsOf(total.data).length,
  restCount_submitted: await count("Sales Invoice", [["docstatus", "=", 1]]),
  note: "Equal counts mean the limit/pagination is not hiding rows.",
});

// 6. Procurement
const suppliers = await read("erpnext_supplier_list", { limit: 50 });
const quotations = await read("erpnext_supplier_quotation_list", { limit: 50 });
const orders = await read("erpnext_purchase_order_list", { limit: 50 });
show("procurement", {
  suppliers: {
    isError: suppliers.isError,
    n: rowsOf(suppliers.data).length,
    shape: shape(suppliers.data),
    sample: rowsOf(suppliers.data).slice(0, 1),
  },
  supplier_quotations: {
    isError: quotations.isError,
    n: rowsOf(quotations.data).length,
    restCount: await count("Supplier Quotation"),
    sample: rowsOf(quotations.data).slice(0, 1),
  },
  purchase_orders: {
    isError: orders.isError,
    n: rowsOf(orders.data).length,
    restCount: await count("Purchase Order"),
    sample: rowsOf(orders.data).slice(0, 1),
  },
});

// 7. Stock ledger for one item/warehouse (the tool requires both)
const ledger = await read("erpnext_stock_ledger_list", {
  item_code: "NK-MILK-500",
  warehouse: WAREHOUSE,
  limit: 5,
});
show("stock_ledger NK-MILK-500", {
  isError: ledger.isError,
  shape: shape(ledger.data),
  n: rowsOf(ledger.data).length,
  sample: rowsOf(ledger.data).slice(0, 2),
});

// 8. Accounting: posted GL and the standard P&L report
const gl = await read("erpnext_gl_entry_list", {
  limit: 5,
  company: COMPANY,
  date_from: "2026-10-31",
  date_to: "2026-10-31",
});
show("gl_entries", {
  isError: gl.isError,
  shape: shape(gl.data),
  n: rowsOf(gl.data).length,
  restCount: await count("GL Entry", [["company", "=", COMPANY]]),
  sample: rowsOf(gl.data).slice(0, 1),
});
console.log(
  `\n## financial_report description\n${byName.get("erpnext_financial_report").description}`,
);
const pnl = await read("erpnext_financial_report", {
  report: "Profit and Loss Statement",
  filters: {
    company: COMPANY,
    filter_based_on: "Date Range",
    period_start_date: "2026-10-31",
    period_end_date: "2026-10-31",
    periodicity: "Monthly",
    accumulated_values: 0,
  },
  limit: 50,
});
show("profit_and_loss_2026-10-31", {
  isError: pnl.isError,
  shape: shape(pnl.data),
  text: pnl.isError ? pnl.text.slice(0, 400) : undefined,
  summary: pnl.data?.summary ?? pnl.data?.report_summary,
  columns: pnl.data?.columns?.length,
  rows: pnl.data?.rows?.length ?? rowsOf(pnl.data?.result).length,
  keys: pnl.data && typeof pnl.data === "object" ? Object.keys(pnl.data) : undefined,
});

show(
  "calls",
  log
    .map((row) => `${row.isError ? "ERR" : "ok "} ${String(row.ms).padStart(5)}ms ${row.name}`)
    .join("\n"),
);
const out_path = process.argv.find((item) => item.startsWith("--out="))?.split("=")[1];
if (out_path) writeFileSync(out_path, JSON.stringify(out, null, 2));
await client.close();
const secrets = [env.ERPNEXT_API_KEY, env.ERPNEXT_API_SECRET];
if (secrets.some((secret) => stderr.join("").includes(secret)))
  console.error("WARNING: server stderr contained a credential value (not printed).");
