#!/usr/bin/env node
/**
 * SYNTHETIC DEMO DATA: adds product categories (Pulses, Spices, Personal Care) to the seeded
 * NammaOps ERPNext store, with items, reorder levels, current stock and supplier quotations.
 * Additive and idempotent: it never edits or deletes existing records, every document carries
 * the marker NAMMAOPS-SEED, and anything that already exists is skipped. It does not create sales
 * history, so the new products have no demand forecast until sales are recorded.
 *
 *   node --env-file=.env.local scripts/erpnext-seed-expansion.mjs [--dry-run]
 *
 * Needs ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET. Company and warehouse are read from
 * the existing seeded item NK-DAL-1KG unless NAMMAOPS_SEED_WAREHOUSE is set. Secrets are never
 * printed. A dry run reads the site and reports what it would create; it writes nothing.
 */
const RAW_URL = (process.env.ERPNEXT_URL ?? "").replace(/\/$/, "");
const URL_BASE = /^https?:\/\//.test(RAW_URL) ? RAW_URL : `https://${RAW_URL}`;
const TOKEN =
  process.env.ERPNEXT_API_KEY && process.env.ERPNEXT_API_SECRET
    ? `token ${process.env.ERPNEXT_API_KEY}:${process.env.ERPNEXT_API_SECRET}`
    : null;
const DRY = process.argv.includes("--dry-run");
const MARK = "NAMMAOPS-SEED";
const TODAY = process.env.NAMMAOPS_SEED_TODAY ?? new Date().toISOString().slice(0, 10);
if (!RAW_URL || !TOKEN) throw new Error("Set ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET.");

const day = (offset) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

// [code, name, group, buy, sell, daily base demand, stock on hand, HSN (verified in site master)]
// Stock is set so most items are healthy and a few sit at or below their reorder level.
const PRODUCTS = [
  ["NK-MOONG-1KG", "Moong Dal 1kg", "Pulses", 118, 140, 4, 60, "07133100"],
  ["NK-CHANA-1KG", "Chana Dal 1kg", "Pulses", 92, 110, 4, 55, "07132000"],
  ["NK-URAD-1KG", "Urad Dal 1kg", "Pulses", 125, 150, 3, 8, "071339"],
  ["NK-MASOOR-1KG", "Masoor Dal 1kg", "Pulses", 98, 120, 3, 40, "07134000"],
  ["NK-RAJMA-1KG", "Rajma 1kg", "Pulses", 140, 170, 2, 30, "07133300"],
  ["NK-KABULI-1KG", "Kabuli Chana 1kg", "Pulses", 130, 155, 2, 5, "07132000"],
  ["NK-TURMERIC-200", "Turmeric Powder 200g", "Spices", 42, 55, 3, 45, "09103030"],
  ["NK-CHILLI-200", "Red Chilli Powder 200g", "Spices", 55, 70, 3, 40, "09042211"],
  ["NK-CORIANDER-200", "Coriander Powder 200g", "Spices", 38, 50, 2, 6, "09092200"],
  ["NK-GARAM-100", "Garam Masala 100g", "Spices", 60, 78, 2, 28, "09109100"],
  ["NK-MUSTARD-100", "Mustard Seeds 100g", "Spices", 18, 25, 2, 30, "120750"],
  ["NK-CUMIN-100", "Cumin Seeds 100g", "Spices", 45, 60, 2, 26, "09093129"],
  ["NK-SHAMPOO-180", "Shampoo 180ml", "Personal Care", 140, 175, 2, 24, "33051090"],
  ["NK-HAIROIL-200", "Coconut Hair Oil 200ml", "Personal Care", 85, 105, 2, 4, "33059011"],
  ["NK-HANDWASH-200", "Hand Wash 200ml", "Personal Care", 70, 90, 2, 22, "34013019"],
  ["NK-FACEWASH-100", "Face Wash 100g", "Personal Care", 110, 140, 1, 15, "34013011"],
].map(([code, name, group, buy, sell, base, stock, hsn]) => ({
  code,
  name,
  group,
  buy,
  sell,
  base,
  stock,
  hsn,
}));
const GROUPS = [...new Set(PRODUCTS.map((product) => product.group))];
// Existing seeded suppliers and their lead times (days), by category.
const SUPPLIER = {
  Pulses: [
    ["Mysuru Agro Supplies", 3],
    ["Bengaluru Wholesale Traders", 1],
  ],
  Spices: [
    ["Mysuru Agro Supplies", 3],
    ["Bengaluru Wholesale Traders", 1],
  ],
  "Personal Care": [["Kaveri Household Goods", 4]],
};

const counts = {};
const planned = {};
async function api(method, path, body) {
  let response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(`${URL_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: TOKEN,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((error) => ({
      ok: false,
      status: 0,
      statusText: String(error),
      json: async () => ({}),
    }));
    // Hosted sites throttle: back off on 429 for any call, and on network/5xx errors for reads.
    const transient = response.status === 429 || response.status === 0 || response.status >= 502;
    if (!transient || attempt >= 5 || (method !== "GET" && response.status !== 429)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json.exception ?? json._server_messages ?? json.message ?? response.statusText;
    throw Object.assign(
      new Error(
        `${method} ${path.split("?")[0]} -> ${response.status}: ${String(message).slice(0, 300)}`,
      ),
      { status: response.status },
    );
  }
  return json;
}
const q = (value) => encodeURIComponent(JSON.stringify(value));
const list = async (doctype, filters, fields = ["name"]) =>
  (
    await api(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}?filters=${q(filters)}&fields=${q(fields)}&limit_page_length=500`,
    )
  ).data;
async function ensure(doctype, filters, doc) {
  if ((await list(doctype, filters)).length) return "exists";
  if (DRY) {
    planned[doctype] = (planned[doctype] ?? 0) + 1;
    return "planned";
  }
  await api("POST", `/api/resource/${encodeURIComponent(doctype)}`, doc);
  counts[doctype] = (counts[doctype] ?? 0) + 1;
  return "created";
}

async function context() {
  let warehouse = process.env.NAMMAOPS_SEED_WAREHOUSE;
  if (!warehouse) {
    const [bin] = await list("Bin", [["item_code", "=", "NK-DAL-1KG"]], ["warehouse"]);
    if (!bin) throw new Error("Seeded item NK-DAL-1KG has no stock; set NAMMAOPS_SEED_WAREHOUSE.");
    warehouse = bin.warehouse;
  }
  const { data: wh } = await api("GET", `/api/resource/Warehouse/${encodeURIComponent(warehouse)}`);
  return { warehouse, company: wh.company };
}

const started = Date.now();
const { warehouse, company } = await context();

for (const group of GROUPS)
  await ensure("Item Group", [["name", "=", group]], {
    item_group_name: group,
    parent_item_group: "All Item Groups",
  });

for (const product of PRODUCTS)
  await ensure("Item", [["name", "=", product.code]], {
    item_code: product.code,
    item_name: product.name,
    item_group: product.group,
    stock_uom: "Nos",
    is_stock_item: 1,
    gst_hsn_code: product.hsn,
    standard_rate: product.sell,
    valuation_rate: product.buy,
    description: `${product.name}. SYNTHETIC DEMO DATA (${MARK}).`,
    reorder_levels: [
      {
        warehouse,
        warehouse_reorder_level: Math.max(2, product.base * 3),
        warehouse_reorder_qty: Math.max(5, product.base * 7),
        material_request_type: "Purchase",
      },
    ],
  });

// Current stock, once: only items with no stock record in this warehouse yet.
const stocked = new Set(
  (
    await list(
      "Bin",
      [
        ["warehouse", "=", warehouse],
        ["item_code", "in", PRODUCTS.map((product) => product.code)],
      ],
      ["item_code", "actual_qty"],
    )
  )
    .filter((bin) => Number(bin.actual_qty) !== 0)
    .map((bin) => bin.item_code),
);
const toStock = PRODUCTS.filter((product) => !stocked.has(product.code));
if (toStock.length) {
  if (DRY) planned["Stock Reconciliation"] = 1;
  else {
    await api("POST", "/api/resource/Stock%20Reconciliation", {
      company,
      purpose: "Stock Reconciliation",
      posting_date: TODAY,
      set_posting_time: 1,
      posting_time: "08:00:00",
      remarks: `${MARK} expansion stock. SYNTHETIC DEMO DATA.`,
      items: toStock.map((product) => ({
        item_code: product.code,
        warehouse,
        qty: product.stock,
        valuation_rate: product.buy,
      })),
      docstatus: 1,
    });
    counts["Stock Reconciliation"] = 1;
  }
}

// One submitted quotation per item and supplier, so supplier comparison and reorder can rank.
for (const product of PRODUCTS)
  for (const [index, [supplier, lead]] of SUPPLIER[product.group].entries()) {
    const marker = `${MARK} quotation ${product.code} ${supplier}`;
    await ensure("Supplier Quotation", [["terms", "=", marker]], {
      company,
      supplier,
      transaction_date: day(-2),
      valid_till: day(28),
      terms: marker,
      items: [
        {
          item_code: product.code,
          qty: product.base * 14,
          // Deterministic spread: the faster supplier is about 3% dearer.
          rate: Math.round(product.buy * (index === 0 ? 0.98 : 1.01)),
          lead_time_days: lead,
          warehouse,
        },
      ],
      docstatus: 1,
    });
  }

const verify = DRY
  ? { planned }
  : Object.fromEntries(
      (
        await list(
          "Bin",
          [
            ["warehouse", "=", warehouse],
            ["item_code", "in", PRODUCTS.map((product) => product.code)],
          ],
          ["item_code", "actual_qty"],
        )
      ).map((bin) => [bin.item_code, Number(bin.actual_qty)]),
    );
console.log(
  JSON.stringify(
    {
      label: "SYNTHETIC DEMO DATA",
      url: URL_BASE,
      company,
      warehouse,
      dry_run: DRY,
      created: counts,
      [DRY ? "would_create" : "stock_now"]: verify,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2,
  ),
);
