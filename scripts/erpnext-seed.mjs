#!/usr/bin/env node
/**
 * SYNTHETIC DEMO DATA seed for a disposable local ERPNext (frappe_docker pwd.yml).
 * Creates the Namma Kirana company, masters and ~90 days of submitted transactions through the
 * documented Frappe REST API, then a least-privilege API user for Agent Town.
 *
 * Idempotent: every document carries the marker NAMMAOPS-SEED and is skipped if it exists.
 * Deterministic: a fixed seed produces the same data on every run.
 * Admin credentials are read from the environment and never printed.
 *
 *   ERPNEXT_URL=http://127.0.0.1:8080 ERPNEXT_ADMIN_PASSWORD=... node scripts/erpnext-seed.mjs [--dry-run]
 *
 * Hosted site (token mode, existing company; never runs the setup wizard):
 *   ERPNEXT_URL=... ERPNEXT_API_KEY=... ERPNEXT_API_SECRET=... NAMMAOPS_SEED_COMPANY=NammaOPs \
 *   NAMMAOPS_SEED_ABBR=N NAMMAOPS_SEED_WAREHOUSE="Stores - N" node scripts/erpnext-seed.mjs [--dry-run]
 * A dry run with credentials reads the site and reports what it would create; it writes nothing.
 * --create-api-user also creates the least-privilege nammaops.api user (off by default).
 */
const RAW_URL = (process.env.ERPNEXT_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const URL_BASE = /^https?:\/\//.test(RAW_URL) ? RAW_URL : `https://${RAW_URL}`;
const ADMIN_PASSWORD = process.env.ERPNEXT_ADMIN_PASSWORD;
// Token mode (hosted site): an existing user's API key/secret; no Administrator login, no wizard.
const TOKEN =
  process.env.ERPNEXT_API_KEY && process.env.ERPNEXT_API_SECRET
    ? `token ${process.env.ERPNEXT_API_KEY}:${process.env.ERPNEXT_API_SECRET}`
    : null;
const DRY = process.argv.includes("--dry-run");
const CREATE_API_USER = process.argv.includes("--create-api-user");
const MARK = "NAMMAOPS-SEED";
const TODAY = process.env.NAMMAOPS_SEED_TODAY ?? new Date().toISOString().slice(0, 10);
const COMPANY = process.env.NAMMAOPS_SEED_COMPANY ?? "Namma Kirana";
const ABBR = process.env.NAMMAOPS_SEED_ABBR ?? "NK";
const WAREHOUSE = process.env.NAMMAOPS_SEED_WAREHOUSE ?? `Main Store - ${ABBR}`;
const DAYS = 90;

if (!ADMIN_PASSWORD && !TOKEN && !DRY)
  throw new Error(
    "Set ERPNEXT_API_KEY/ERPNEXT_API_SECRET, or ERPNEXT_ADMIN_PASSWORD (local only).",
  );

const day = (offset) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
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
const random = rng(20261101);

// ---- Catalogue (synthetic) -------------------------------------------------------------
const GROUPS = ["Dairy", "Staples", "Cooking Oil", "Snacks", "Beverages", "Household"];
const PRODUCTS = [
  ["NK-MILK-500", "Toned Milk 500ml", "Dairy", 25, 32, 38, 1.35],
  ["NK-CURD-400", "Curd 400g", "Dairy", 30, 40, 14, 1.4],
  ["NK-PANEER-200", "Paneer 200g", "Dairy", 80, 95, 5, 1.6],
  ["NK-BUTTER-100", "Butter 100g", "Dairy", 52, 60, 4, 1.2],
  ["NK-GHEE-200", "Ghee 200ml", "Dairy", 120, 140, 2, 1.1],
  ["NK-RICE-5KG", "Sona Masoori Rice 5kg", "Staples", 340, 385, 4, 1.5],
  ["NK-ATTA-5KG", "Wheat Atta 5kg", "Staples", 230, 265, 4, 1.3],
  ["NK-DAL-1KG", "Toor Dal 1kg", "Staples", 115, 140, 5, 1.1],
  ["NK-SUGAR-1KG", "Sugar 1kg", "Staples", 42, 50, 6, 1.1],
  ["NK-SALT-1KG", "Iodised Salt 1kg", "Staples", 18, 25, 3, 1.0],
  ["NK-RAVA-500", "Rava 500g", "Staples", 30, 38, 3, 1.2],
  ["NK-POHA-500", "Poha 500g", "Staples", 32, 40, 3, 1.3],
  ["NK-OIL-SUN-1L", "Sunflower Oil 1L", "Cooking Oil", 138, 155, 5, 1.2],
  ["NK-OIL-GND-1L", "Groundnut Oil 1L", "Cooking Oil", 175, 195, 2, 1.2],
  ["NK-OIL-COCO-500", "Coconut Oil 500ml", "Cooking Oil", 110, 130, 1, 1.0],
  ["NK-OIL-MUS-1L", "Mustard Oil 1L", "Cooking Oil", 150, 170, 1, 1.0],
  ["NK-BISC-GLU", "Glucose Biscuits", "Snacks", 8, 10, 20, 1.5],
  ["NK-BISC-CRM", "Cream Biscuits", "Snacks", 25, 30, 8, 1.6],
  ["NK-CHIPS-50", "Potato Chips 50g", "Snacks", 16, 20, 12, 1.8],
  ["NK-NAMKEEN-200", "Mixture Namkeen 200g", "Snacks", 45, 55, 4, 1.5],
  ["NK-NOODLES-70", "Instant Noodles 70g", "Snacks", 12, 14, 15, 1.4],
  ["NK-CHOC-40", "Chocolate Bar 40g", "Snacks", 32, 40, 6, 1.7],
  ["NK-TEA-250", "Tea Powder 250g", "Beverages", 120, 140, 4, 1.1],
  ["NK-COFFEE-200", "Filter Coffee 200g", "Beverages", 150, 175, 3, 1.1],
  ["NK-SODA-750", "Soda 750ml", "Beverages", 30, 40, 6, 1.9],
  ["NK-JUICE-1L", "Mango Drink 1L", "Beverages", 85, 99, 3, 1.7],
  ["NK-WATER-1L", "Mineral Water 1L", "Beverages", 14, 20, 15, 1.6],
  ["NK-HORLICKS-500", "Malt Drink 500g", "Beverages", 230, 260, 1, 1.0],
  ["NK-SOAP-100", "Bath Soap 100g", "Household", 28, 35, 6, 1.2],
  ["NK-DETERG-1KG", "Detergent Powder 1kg", "Household", 95, 115, 3, 1.3],
  ["NK-DISH-500", "Dishwash Liquid 500ml", "Household", 80, 99, 2, 1.2],
  ["NK-PASTE-150", "Toothpaste 150g", "Household", 85, 99, 3, 1.1],
  ["NK-AGARBATTI", "Incense Sticks", "Household", 35, 45, 2, 1.0],
  ["NK-MATCH-10", "Matchbox Pack of 10", "Household", 18, 20, 3, 1.0],
  ["NK-TISSUE", "Tissue Paper Roll", "Household", 30, 40, 1, 1.0],
  ["NK-NEW-MILLET", "Millet Flakes 500g", "Staples", 90, 110, 1, 1.0],
].map(([code, name, group, buy, sell, base, weekend]) => ({
  code,
  name,
  group,
  buy,
  sell,
  base,
  weekend,
}));
// GST HSN codes (India Compliance validates them; all verified present in the site's HSN master).
const HSN = {
  "NK-MILK-500": "04012000",
  "NK-CURD-400": "040390",
  "NK-PANEER-200": "040610",
  "NK-BUTTER-100": "04051000",
  "NK-GHEE-200": "040590",
  "NK-RICE-5KG": "100630",
  "NK-ATTA-5KG": "11010000",
  "NK-DAL-1KG": "071360",
  "NK-SUGAR-1KG": "170199",
  "NK-SALT-1KG": "250100",
  "NK-RAVA-500": "110311",
  "NK-POHA-500": "11041900",
  "NK-OIL-SUN-1L": "151219",
  "NK-OIL-GND-1L": "150890",
  "NK-OIL-COCO-500": "15131100",
  "NK-OIL-MUS-1L": "151491",
  "NK-BISC-GLU": "19053100",
  "NK-BISC-CRM": "19053100",
  "NK-CHIPS-50": "20052000",
  "NK-NAMKEEN-200": "210690",
  "NK-NOODLES-70": "190230",
  "NK-CHOC-40": "18063200",
  "NK-TEA-250": "090230",
  "NK-COFFEE-200": "090121",
  "NK-SODA-750": "220210",
  "NK-JUICE-1L": "220299",
  "NK-WATER-1L": "220110",
  "NK-HORLICKS-500": "190190",
  "NK-SOAP-100": "340111",
  "NK-DETERG-1KG": "340220",
  "NK-DISH-500": "340220",
  "NK-PASTE-150": "330610",
  "NK-AGARBATTI": "33074100",
  "NK-MATCH-10": "360500",
  "NK-TISSUE": "48181000",
  "NK-NEW-MILLET": "190410",
};
const PROMO = { code: "NK-OIL-SUN-1L", from: day(-21), to: day(-15), factor: 2.2 };
const STOCKOUT = { code: "NK-DAL-1KG", from: day(-14), to: day(-9) };
const LAUNCH = { code: "NK-NEW-MILLET", from: day(-7) };
const SUPPLIERS = [
  ["Bengaluru Wholesale Traders", 1],
  ["Mysuru Agro Supplies", 3],
  ["City Dairy Distributors", 1],
  ["Hubli Snacks and Beverages", 2],
  ["Kaveri Household Goods", 4],
];
const CUSTOMERS = [
  "Walk-in Customer",
  ...Array.from({ length: 20 }, (_, i) => `Synthetic Customer ${String(i + 1).padStart(2, "0")}`),
];

// ---- REST helpers -----------------------------------------------------------------------
let cookie = "";
const counts = {};
let requests = 0;
async function api(method, path, body) {
  // A dry run with credentials still reads the site (so it reports exactly what would be created);
  // it never writes. Without credentials it reads nothing.
  if (DRY && (method !== "GET" || (!TOKEN && !ADMIN_PASSWORD)))
    return { data: method === "GET" ? [] : { name: `DRY-${requests}` } };
  let response;
  for (let attempt = 0; ; attempt += 1) {
    requests += 1;
    response = await fetch(`${URL_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(TOKEN ? { Authorization: TOKEN } : { Cookie: cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((error) => ({
      ok: false,
      status: 0,
      statusText: String(error),
      headers: new Headers(),
      json: async () => ({}),
    }));
    // Hosted sites throttle. GETs back off on 429/5xx/network errors; a POST is retried here only
    // on 429 (nothing created). Other POST failures go back to `ensure`, which re-checks first.
    const transient = response.status === 429 || response.status === 0 || response.status >= 502;
    if (!transient || attempt >= 5 || (method !== "GET" && response.status !== 429)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
  }
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json.exception ?? json._server_messages ?? json.message ?? response.statusText;
    const error = new Error(
      `${method} ${path.split("?")[0]} -> ${response.status}: ${String(message).slice(0, 300)}`,
    );
    error.status = response.status;
    throw error;
  }
  return json;
}
const q = (value) => encodeURIComponent(JSON.stringify(value));
const exists = async (doctype, filters) =>
  (
    await api(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}?filters=${q(filters)}&limit_page_length=1`,
    )
  ).data.length > 0;
const planned = {};
async function ensure(doctype, filters, doc) {
  for (let attempt = 0; ; attempt += 1) {
    if (await exists(doctype, filters)) return "exists";
    if (DRY) {
      planned[doctype] = (planned[doctype] ?? 0) + 1;
      return "planned";
    }
    try {
      await api("POST", `/api/resource/${encodeURIComponent(doctype)}`, doc);
      break;
    } catch (error) {
      // Timeout/gateway error: the document may have been saved, so loop to re-check its marker.
      if (!(error.status === 0 || error.status >= 502) || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
    }
  }
  counts[doctype] = (counts[doctype] ?? 0) + 1;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total % 25 === 0) console.error(`progress: ${total} created ${JSON.stringify(counts)}`);
  return "created";
}

// ---- Steps ------------------------------------------------------------------------------
async function login() {
  await api("POST", "/api/method/login", { usr: "Administrator", pwd: ADMIN_PASSWORD });
}

async function setupCompany() {
  if (await exists("Company", [["name", "=", COMPANY]])) return;
  if (TOKEN)
    throw new Error(`Company ${COMPANY} not found; token mode never runs the setup wizard.`);
  await api("POST", "/api/method/frappe.desk.page.setup_wizard.setup_wizard.setup_complete", {
    args: {
      language: "English",
      country: "India",
      timezone: "Asia/Kolkata",
      currency: "INR",
      full_name: "Namma Kirana Owner (synthetic)",
      email: "owner@nammakirana.invalid",
      password: ADMIN_PASSWORD,
      company_name: COMPANY,
      company_abbr: ABBR,
      chart_of_accounts: "Standard",
      fy_start_date:
        `${TODAY.slice(0, 4)}-04-01` > TODAY
          ? `${Number(TODAY.slice(0, 4)) - 1}-04-01`
          : `${TODAY.slice(0, 4)}-04-01`,
      fy_end_date:
        `${TODAY.slice(0, 4)}-04-01` > TODAY
          ? `${TODAY.slice(0, 4)}-03-31`
          : `${Number(TODAY.slice(0, 4)) + 1}-03-31`,
      setup_demo: 0,
    },
  });
}

async function masters() {
  await ensure("Warehouse", [["name", "=", WAREHOUSE]], {
    warehouse_name: WAREHOUSE.replace(` - ${ABBR}`, ""),
    company: COMPANY,
  });
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
      gst_hsn_code: HSN[product.code],
      standard_rate: product.sell,
      description: `${product.name}. SYNTHETIC DEMO DATA (${MARK}).`,
      reorder_levels: [
        {
          warehouse: WAREHOUSE,
          warehouse_reorder_level: Math.max(2, Math.round(product.base * 3)),
          warehouse_reorder_qty: Math.max(5, Math.round(product.base * 7)),
          material_request_type: "Purchase",
        },
      ],
    });
  for (const [name, lead] of SUPPLIERS)
    await ensure("Supplier", [["name", "=", name]], {
      supplier_name: name,
      supplier_group: "All Supplier Groups",
      supplier_details: `Lead time ${lead} day(s). SYNTHETIC DEMO DATA (${MARK}).`,
    });
  for (const name of CUSTOMERS)
    await ensure("Customer", [["name", "=", name]], {
      customer_name: name,
      customer_type: "Individual",
      // Hosted ERPNext rejects group nodes here; both leaf values exist in a standard India setup.
      customer_group: process.env.NAMMAOPS_SEED_CUSTOMER_GROUP ?? "Individual",
      territory: process.env.NAMMAOPS_SEED_TERRITORY ?? "India",
    });
}

const supplierFor = (product) =>
  product.group === "Dairy"
    ? "City Dairy Distributors"
    : product.group === "Snacks" || product.group === "Beverages"
      ? "Hubli Snacks and Beverages"
      : product.group === "Household"
        ? "Kaveri Household Goods"
        : random() < 0.5
          ? "Bengaluru Wholesale Traders"
          : "Mysuru Agro Supplies";

async function transactions() {
  const stock = new Map(PRODUCTS.map((product) => [product.code, product.base * 10]));
  // Frappe 16 refuses Text-field filters on Stock Reconciliation; match purpose + date instead.
  await ensure(
    "Stock Reconciliation",
    [
      ["company", "=", COMPANY],
      ["purpose", "=", "Opening Stock"],
      ["posting_date", "=", day(-DAYS - 1)],
      ["docstatus", "<", 2],
    ],
    {
      company: COMPANY,
      purpose: "Opening Stock",
      posting_date: day(-DAYS - 1),
      set_posting_time: 1,
      remarks: `${MARK} opening stock. SYNTHETIC DEMO DATA.`,
      // ERPNext requires an Asset/Liability difference account for an opening entry.
      expense_account: `Temporary Opening - ${ABBR}`,
      items: PRODUCTS.filter((product) => product.code !== LAUNCH.code).map((product) => ({
        item_code: product.code,
        warehouse: WAREHOUSE,
        qty: stock.get(product.code),
        valuation_rate: product.buy,
      })),
      docstatus: 1,
    },
  );
  let purchaseCount = 0;
  for (let offset = -DAYS; offset < 0; offset += 1) {
    const date = day(offset);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    // Replenish anything below a week of base demand (not during the stockout window).
    const refill = PRODUCTS.filter(
      (product) =>
        !(product.code === LAUNCH.code && date < LAUNCH.from) &&
        !(product.code === STOCKOUT.code && date >= STOCKOUT.from && date <= STOCKOUT.to) &&
        stock.get(product.code) < product.base * 3,
    );
    const bySupplier = new Map();
    for (const product of refill) {
      const supplier = supplierFor(product);
      bySupplier.set(supplier, [...(bySupplier.get(supplier) ?? []), product]);
    }
    for (const [supplier, products] of bySupplier) {
      purchaseCount += 1;
      const marker = `${MARK} purchase ${date} ${supplier}`;
      await ensure("Purchase Invoice", [["remarks", "=", marker]], {
        company: COMPANY,
        supplier,
        posting_date: date,
        set_posting_time: 1,
        update_stock: 1,
        set_warehouse: WAREHOUSE,
        remarks: marker,
        items: products.map((product) => ({
          item_code: product.code,
          qty: product.base * 55,
          rate: product.buy,
          warehouse: WAREHOUSE,
        })),
        docstatus: 1,
      });
      for (const product of products)
        stock.set(product.code, stock.get(product.code) + product.base * 55);
    }
    // 4-6 invoices per day, weekend uplift, one promo, one stockout window.
    const invoices = 4 + Math.floor(random() * 3) + (dow === 0 || dow === 6 ? 1 : 0);
    for (let n = 0; n < invoices; n += 1) {
      const lines = [];
      for (const product of PRODUCTS) {
        if (product.code === LAUNCH.code && date < LAUNCH.from) continue;
        if (product.code === STOCKOUT.code && date >= STOCKOUT.from && date <= STOCKOUT.to)
          continue;
        let rate = product.base / invoices;
        if (dow === 0 || dow === 6) rate *= product.weekend;
        if (product.code === PROMO.code && date >= PROMO.from && date <= PROMO.to)
          rate *= PROMO.factor;
        const qty = Math.min(stock.get(product.code), Math.round(rate * (0.5 + random())));
        if (qty > 0) {
          lines.push({ item_code: product.code, qty, rate: product.sell, warehouse: WAREHOUSE });
          stock.set(product.code, stock.get(product.code) - qty);
        }
      }
      if (!lines.length) continue;
      const marker = `${MARK} sale ${date} #${n + 1}`;
      await ensure("Sales Invoice", [["remarks", "=", marker]], {
        company: COMPANY,
        customer: n === 0 ? CUSTOMERS[1 + Math.floor(random() * 20)] : "Walk-in Customer",
        posting_date: date,
        set_posting_time: 1,
        due_date: date,
        update_stock: 1,
        set_warehouse: WAREHOUSE,
        remarks: marker,
        items: lines,
        docstatus: 1,
      });
    }
  }
  // Supplier quotations with price differences, and 4 open purchase orders.
  for (const [index, product] of PRODUCTS.slice(0, 16).entries()) {
    const [name, lead] = SUPPLIERS[index % 2];
    const marker = `${MARK} quotation ${product.code}`;
    await ensure("Supplier Quotation", [["terms", "=", marker]], {
      company: COMPANY,
      supplier: name,
      transaction_date: day(-5),
      valid_till: day(25),
      terms: marker,
      items: [
        {
          item_code: product.code,
          qty: product.base * 14,
          rate: Math.round(product.buy * (0.96 + random() * 0.08)),
          lead_time_days: lead,
          warehouse: WAREHOUSE,
        },
      ],
      docstatus: 1,
    });
  }
  for (const product of PRODUCTS.filter((item) =>
    ["NK-SUGAR-1KG", "NK-ATTA-5KG", "NK-CHIPS-50", "NK-SOAP-100"].includes(item.code),
  )) {
    const marker = `${MARK} open order ${product.code}`;
    await ensure("Purchase Order", [["terms", "=", marker]], {
      company: COMPANY,
      supplier: supplierFor(product),
      transaction_date: day(-1),
      schedule_date: day(2),
      set_warehouse: WAREHOUSE,
      terms: marker,
      items: [
        {
          item_code: product.code,
          qty: product.base * 10,
          rate: product.buy,
          schedule_date: day(2),
          warehouse: WAREHOUSE,
        },
      ],
      docstatus: 1,
    });
  }
  return purchaseCount;
}

/** A dedicated, least-privilege user for Agent Town. Its key/secret are printed nowhere. */
async function apiUser() {
  const email = "nammaops.api@nammakirana.invalid";
  await ensure("User", [["name", "=", email]], {
    email,
    first_name: "NammaOps API",
    user_type: "System User",
    send_welcome_email: 0,
    roles: ["Stock User", "Sales User", "Purchase User", "Accounts User"].map((role) => ({ role })),
  });
  if (DRY) return { email, keys: "dry-run" };
  const keys = await api("POST", "/api/method/frappe.core.doctype.user.user.generate_keys", {
    user: email,
  });
  const secret = keys.message?.api_secret;
  const user = await api("GET", `/api/resource/User/${encodeURIComponent(email)}`);
  const { writeFileSync } = await import("node:fs");
  const out = process.env.NAMMAOPS_ERP_CREDENTIALS_FILE ?? ".env.erpnext.local";
  writeFileSync(
    out,
    `ERPNEXT_URL=${URL_BASE}\nERPNEXT_API_KEY=${user.data.api_key}\nERPNEXT_API_SECRET=${secret}\n`,
    { mode: 0o600 },
  );
  return { email, keys: `written to ${out} (gitignored *.local)` };
}

async function verify() {
  const count = async (doctype, filters = []) =>
    (
      await api(
        "GET",
        `/api/method/frappe.client.get_count?doctype=${encodeURIComponent(doctype)}&filters=${q(filters)}`,
      )
    ).message;
  const out = {};
  for (const doctype of [
    "Item",
    "Supplier",
    "Customer",
    "Sales Invoice",
    "Purchase Invoice",
    "Supplier Quotation",
    "Purchase Order",
    "Stock Ledger Entry",
    "GL Entry",
  ])
    out[doctype] = await count(doctype, doctype === "Item" ? [["item_code", "like", "NK-%"]] : []);
  return out;
}

const started = Date.now();
if (!DRY && !TOKEN) await login();
await setupCompany();
await masters();
const purchases = await transactions();
const user = CREATE_API_USER ? await apiUser() : "skipped (pass --create-api-user)";
const verified = DRY ? { planned } : await verify();
console.log(
  JSON.stringify(
    {
      label: "SYNTHETIC DEMO DATA",
      url: URL_BASE,
      created: counts,
      purchase_batches: purchases,
      api_user: user,
      verified,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2,
  ),
);
