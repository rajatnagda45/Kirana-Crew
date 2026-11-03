#!/usr/bin/env node
/**
 * NammaOps Kirana Seed v2: makes the seeded ERPNext site behave like a Bangalore kirana store.
 * SYNTHETIC DEMO DATA, derived from two public CSVs (artifacts/):
 *   - Ecommerce_Sales_Data_2024_2025.csv: customer NAMES (City = Bangalore rows only; the names in
 *     that Kaggle file are generated, not real people) and the PAYMENT-MODE mix.
 *   - retail_sales_dataset.csv: QUANTITY per invoice line (1..4).
 * Neither CSV has addresses or phones, so those are generated and labelled synthetic:
 *   - addresses use real South-Bangalore localities and their pincodes, with invented house/street
 *     numbers;
 *   - phones are NON-DIALABLE (+91 80 0000 NNNN: Bangalore STD code with an unallocated 0000
 *     exchange), so no real person's number is ever written; emails use the reserved example.com.
 *
 * Steps (all idempotent; every document carries the marker NAMMAOPS-SEED-V2):
 *   1. Ledgers + Mode of Payment for UPI and card collections.
 *   2. Rename the 20 "Synthetic Customer NN" to Bangalore names (rename_doc keeps invoice links),
 *      add 30 more (8 commercial), each with an Address and a Contact.
 *   3. Payment Entries for existing invoices: walk-in sales paid the same day; named customers
 *      settle most credit (udhaar) over 0..25 days, a few partly, the newest often still open.
 *   4. Sales from the day after the last seeded day up to today, same payment rules.
 *   5. Credit limits on named customers.
 * Submitted history is never edited, so the posted totals for earlier days (e.g. the 2026-10-31
 * figures asserted by check-nammaops-live.mjs) do not change.
 *
 *   node --env-file=.env.local scripts/erpnext-seed-v2.mjs                 # dry run: reads, writes nothing
 *   node --env-file=.env.local scripts/erpnext-seed-v2.mjs --apply         # writes
 * Options: --data-dir ../artifacts  NAMMAOPS_SEED_TODAY=YYYY-MM-DD (default: today, Asia/Kolkata)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RAW_URL = (process.env.ERPNEXT_URL ?? "").replace(/\/$/, "");
const URL_BASE = /^https?:\/\//.test(RAW_URL) ? RAW_URL : `https://${RAW_URL}`;
const TOKEN =
  process.env.ERPNEXT_API_KEY && process.env.ERPNEXT_API_SECRET
    ? `token ${process.env.ERPNEXT_API_KEY}:${process.env.ERPNEXT_API_SECRET}`
    : null;
if (!RAW_URL || !TOKEN) throw new Error("Set ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET.");
const APPLY = process.argv.includes("--apply");
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const DATA_DIR = resolve(flag("--data-dir", "../artifacts"));
const MARK = "NAMMAOPS-SEED-V2";
const COMPANY = process.env.NAMMAOPS_SEED_COMPANY ?? "NammaOPs";
const ABBR = process.env.NAMMAOPS_SEED_ABBR ?? "N";
const WAREHOUSE = process.env.NAMMAOPS_SEED_WAREHOUSE ?? `Stores - ${ABBR}`;
const TODAY =
  process.env.NAMMAOPS_SEED_TODAY ??
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const NOW_HHMM = new Date().toLocaleTimeString("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
});
const DEBTORS = `Debtors - ${ABBR}`;
const ACCOUNTS = {
  Cash: `Cash - ${ABBR}`,
  UPI: `UPI Collections - ${ABBR}`,
  "Credit Card": `Card Settlements - ${ABBR}`,
};

// ---- deterministic helpers ---------------------------------------------------------------
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
const random = rng(20261103);
/** A stable per-key random value, so re-runs make the same decision for the same invoice. */
const keyed = (key) => {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return rng(h >>> 0);
};
const pick = (list, r = random) => list[Math.floor(r() * list.length)];
const day = (iso, n) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const r2 = (v) => Math.round(v * 100) / 100;

// ---- CSV-derived inputs ------------------------------------------------------------------
function csv(file) {
  const [head, ...rows] = readFileSync(resolve(DATA_DIR, file), "utf8").trim().split(/\r?\n/);
  const keys = head.split(",");
  return rows.map((row) => Object.fromEntries(row.split(",").map((v, i) => [keys[i], v])));
}
const ecommerce = csv("Ecommerce_Sales_Data_2024_2025.csv").filter((r) => r.City === "Bangalore");
const retail = csv("retail_sales_dataset.csv");
const NAMES = [...new Set(ecommerce.map((r) => r["Customer Name"]))];
// Payment modes from the Bangalore rows, mapped to what a kirana counter takes.
const MODE_MAP = {
  COD: "Cash",
  UPI: "UPI",
  "Net Banking": "UPI",
  "Debit Card": "Credit Card",
  "Credit Card": "Credit Card",
};
const MODES = ecommerce.map((r) => MODE_MAP[r["Payment Mode"]]).filter(Boolean);
const QTYS = retail.map((r) => Number(r.Quantity)).filter((n) => n >= 1);

// South-Bangalore neighbourhood around the store (real localities and pincodes).
const LOCALITIES = [
  ["Jayanagar 4th Block", "560011"],
  ["Jayanagar 9th Block", "560069"],
  ["Basavanagudi", "560004"],
  ["JP Nagar 2nd Phase", "560078"],
  ["BTM Layout 2nd Stage", "560076"],
  ["Banashankari 2nd Stage", "560070"],
  ["Wilson Garden", "560027"],
  ["Hanumanthanagar", "560019"],
  ["Padmanabhanagar", "560070"],
  ["Kumaraswamy Layout", "560078"],
];
const BUSINESS = [
  "Darshini",
  "Tea Stall",
  "Caterers",
  "PG Hostel",
  "Bakery",
  "Juice Centre",
  "Tiffin Centre",
  "Condiments",
];

// ---- HTTP (same retry policy as erpnext-seed.mjs) ----------------------------------------
let requests = 0;
const counts = {};
async function api(method, path, body) {
  if (!APPLY && method !== "GET") return { data: { name: `DRY-${requests++}` } };
  let response;
  for (let attempt = 0; ; attempt += 1) {
    requests += 1;
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
    const transient = response.status === 429 || response.status === 0 || response.status >= 502;
    if (!transient || attempt >= 5 || (method !== "GET" && response.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
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
const q = (v) => encodeURIComponent(JSON.stringify(v));
const list = async (doctype, fields, filters = [], extra = "") =>
  (
    await api(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}?fields=${q(fields)}&filters=${q(filters)}&limit_page_length=0${extra}`,
    )
  ).data;
const exists = async (doctype, filters) =>
  (
    await api(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}?filters=${q(filters)}&limit_page_length=1`,
    )
  ).data.length > 0;
function note(doctype) {
  counts[doctype] = (counts[doctype] ?? 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total % 25 === 0)
    console.error(`progress: ${total} ${APPLY ? "written" : "planned"} ${JSON.stringify(counts)}`);
}
/** Create unless a document matching `filters` exists. Returns the created/existing doc name. */
async function ensure(doctype, filters, doc) {
  for (let attempt = 0; ; attempt += 1) {
    const found = await api(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}?filters=${q(filters)}&limit_page_length=1`,
    );
    if (found.data.length) return { name: found.data[0].name, created: false };
    try {
      const created = await api("POST", `/api/resource/${encodeURIComponent(doctype)}`, doc);
      note(doctype);
      return { name: created.data.name, created: true, doc: created.data };
    } catch (error) {
      if (!(error.status === 0 || error.status >= 502) || attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

// ---- 1. ledgers and modes ----------------------------------------------------------------
async function ledgers() {
  for (const [mode, account] of Object.entries(ACCOUNTS)) {
    if (mode === "Cash") continue;
    await ensure("Account", [["name", "=", account]], {
      account_name: account.replace(` - ${ABBR}`, ""),
      parent_account: `Bank Accounts - ${ABBR}`,
      account_type: "Bank",
      company: COMPANY,
      is_group: 0,
    });
  }
  await ensure("Mode of Payment", [["name", "=", "UPI"]], {
    mode_of_payment: "UPI",
    type: "Bank",
    enabled: 1,
    accounts: [{ company: COMPANY, default_account: ACCOUNTS.UPI }],
  });
}

// ---- 2. customers ------------------------------------------------------------------------
function profile(index, name, group) {
  const r = keyed(`customer:${name}`);
  const [locality, pincode] = LOCALITIES[index % LOCALITIES.length];
  const [first, ...rest] = name.split(" ");
  const slug = name
    .toLowerCase()
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return {
    name,
    group,
    first,
    last: rest.join(" "),
    line1: `#${10 + Math.floor(r() * 290)}, ${1 + Math.floor(r() * 18)}th Cross`,
    line2: `${1 + Math.floor(r() * 12)}th Main, ${locality}`,
    pincode,
    // Non-dialable synthetic number: +91 80 (Bangalore) 0000 (unallocated exchange) NNNN.
    phone: `+91 80 0000 ${String(1000 + index).slice(-4)}`,
    email: `${slug}@example.com`,
    credit:
      group === "Commercial"
        ? 25000 + Math.floor(r() * 8) * 5000
        : 3000 + Math.floor(r() * 15) * 500,
  };
}

async function customers() {
  const existing = new Set((await list("Customer", ["name"])).map((row) => row.name));
  const profiles = [];
  // 20 renamed + 22 individuals + 8 businesses, names in CSV order.
  for (let i = 0; i < 42; i += 1) profiles.push(profile(i, NAMES[i], "Individual"));
  for (let i = 0; i < BUSINESS.length; i += 1) {
    const surname = NAMES[42 + i].split(" ").slice(-1)[0];
    profiles.push(profile(42 + i, `${surname} ${BUSINESS[i]}`, "Commercial"));
  }
  for (let i = 0; i < profiles.length; i += 1) {
    const p = profiles[i];
    const old = i < 20 ? `Synthetic Customer ${String(i + 1).padStart(2, "0")}` : null;
    if (old && existing.has(old) && !existing.has(p.name)) {
      if (APPLY)
        await api("POST", "/api/method/frappe.client.rename_doc", {
          doctype: "Customer",
          old_name: old,
          new_name: p.name,
          merge: 0,
        });
      note("Customer rename");
      existing.add(p.name);
    } else if (!existing.has(p.name)) {
      await ensure("Customer", [["name", "=", p.name]], {
        customer_name: p.name,
        customer_type: p.group === "Commercial" ? "Company" : "Individual",
        customer_group: p.group,
        territory: "India",
        customer_details: `${MARK}: synthetic Bangalore customer (name from public CSV).`,
      });
      existing.add(p.name);
    }
    if (APPLY)
      await api("PUT", `/api/resource/Customer/${encodeURIComponent(p.name)}`, {
        customer_name: p.name,
        customer_type: p.group === "Commercial" ? "Company" : "Individual",
        customer_group: p.group,
        customer_details: `${MARK}: synthetic Bangalore customer (name from public CSV; address and phone generated, phone non-dialable).`,
      });
    const address = await ensure("Address", [["address_title", "=", p.name]], {
      address_title: p.name,
      address_type: "Billing",
      address_line1: p.line1,
      address_line2: p.line2,
      city: "Bengaluru",
      state: "Karnataka",
      pincode: p.pincode,
      country: "India",
      phone: p.phone,
      email_id: p.email,
      is_primary_address: 1,
      links: [{ link_doctype: "Customer", link_name: p.name }],
    });
    const contact = await ensure(
      "Contact",
      [
        ["first_name", "=", p.first],
        ["last_name", "=", p.last],
        ["company_name", "=", p.name],
      ],
      {
        first_name: p.first,
        last_name: p.last,
        company_name: p.name,
        is_primary_contact: 1,
        email_ids: [{ email_id: p.email, is_primary: 1 }],
        phone_nos: [{ phone: p.phone, is_primary_mobile_no: 1 }],
        links: [{ link_doctype: "Customer", link_name: p.name }],
      },
    );
    if (APPLY)
      await api("PUT", `/api/resource/Customer/${encodeURIComponent(p.name)}`, {
        customer_primary_address: address.name,
        customer_primary_contact: contact.name,
      });
  }
  return profiles;
}

// ---- 3/4. payments and new sales ---------------------------------------------------------
const payModeFor = (key) => pick(MODES, keyed(`mode:${key}`));

/** The settlement plan for one invoice: [] (open) or [{date, amount}] (full or partial). */
function settlement(inv) {
  const r = keyed(`pay:${inv.name}`);
  const outstanding = Number(inv.outstanding_amount);
  if (outstanding <= 0) return [];
  if (inv.customer === "Walk-in Customer") return [{ date: inv.posting_date, amount: outstanding }];
  const age = daysBetween(inv.posting_date, TODAY);
  const roll = r();
  const later = (max) => {
    const d = day(inv.posting_date, 1 + Math.floor(r() * max));
    return d > TODAY ? TODAY : d;
  };
  if (age > 30) {
    if (roll < 0.82) return [{ date: later(25), amount: outstanding }];
    if (roll < 0.93) return [{ date: later(20), amount: r2(outstanding * (0.4 + r() * 0.3)) }];
    return [];
  }
  if (age >= 8) {
    if (roll < 0.55) return [{ date: later(Math.min(age, 20)), amount: outstanding }];
    if (roll < 0.7)
      return [{ date: later(Math.min(age, 10)), amount: r2(outstanding * (0.3 + r() * 0.4)) }];
    return [];
  }
  if (roll < 0.25) return [{ date: later(Math.max(1, age)), amount: outstanding }];
  return [];
}

async function pay(inv) {
  for (const [i, part] of settlement(inv).entries()) {
    const mode = payModeFor(`${inv.name}:${i}`);
    const reference = `${MARK}-PAY-${inv.name}-${i + 1}`;
    await ensure("Payment Entry", [["reference_no", "=", reference]], {
      payment_type: "Receive",
      company: COMPANY,
      posting_date: part.date,
      mode_of_payment: mode,
      party_type: "Customer",
      party: inv.customer,
      paid_from: DEBTORS,
      paid_to: ACCOUNTS[mode],
      paid_amount: part.amount,
      received_amount: part.amount,
      source_exchange_rate: 1,
      target_exchange_rate: 1,
      reference_no: reference,
      reference_date: part.date,
      remarks: `${MARK}: ${inv.customer === "Walk-in Customer" ? "counter payment" : "udhaar settlement"} for ${inv.name}`,
      references: [
        {
          reference_doctype: "Sales Invoice",
          reference_name: inv.name,
          allocated_amount: part.amount,
        },
      ],
      docstatus: 1,
    });
  }
}

async function payExisting() {
  const invoices = await list(
    "Sales Invoice",
    ["name", "customer", "posting_date", "outstanding_amount"],
    [
      ["docstatus", "=", 1],
      ["outstanding_amount", ">", 0],
      ["company", "=", COMPANY],
    ],
    "&order_by=posting_date%20asc",
  );
  for (const inv of invoices) await pay(inv);
  return invoices.length;
}

async function newSales(profiles) {
  const last = (
    await list(
      "Sales Invoice",
      ["posting_date"],
      [
        ["docstatus", "=", 1],
        ["company", "=", COMPANY],
      ],
      "&order_by=posting_date%20desc&limit_page_length=1",
    )
  )[0]?.posting_date;
  const items = await list(
    "Item",
    ["item_code", "standard_rate"],
    [
      ["disabled", "=", 0],
      ["is_stock_item", "=", 1],
      ["standard_rate", ">", 0],
    ],
  );
  const bins = await list("Bin", ["item_code", "actual_qty"], [["warehouse", "=", WAREHOUSE]]);
  const stock = new Map(bins.map((b) => [b.item_code, Number(b.actual_qty)]));
  // A weighted repeat pool: the first fifth of named customers make most named purchases.
  const regulars = profiles.slice(0, Math.ceil(profiles.length / 5));
  const named = () => (random() < 0.6 ? pick(regulars) : pick(profiles));
  const created = [];
  for (let date = day(last, 1); date <= TODAY; date = day(date, 1)) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isToday = date === TODAY;
    let invoices = 5 + Math.floor(random() * 3) + (dow === 0 || dow === 6 ? 2 : 0);
    if (isToday)
      invoices = Math.max(2, Math.round((invoices * (Number(NOW_HHMM.slice(0, 2)) - 8)) / 13));
    for (let n = 1; n <= invoices; n += 1) {
      const customer = random() < 0.72 ? null : named();
      const business = customer?.group === "Commercial";
      const lines = [];
      const basket = business ? 5 + Math.floor(random() * 5) : 2 + Math.floor(random() * 5);
      for (const item of [...items].sort(() => random() - 0.5)) {
        if (lines.length >= basket) break;
        const qty = pick(QTYS) * (business ? 3 : 1);
        if ((stock.get(item.item_code) ?? 0) < qty) continue;
        stock.set(item.item_code, stock.get(item.item_code) - qty);
        lines.push({
          item_code: item.item_code,
          qty,
          rate: item.standard_rate,
          warehouse: WAREHOUSE,
        });
      }
      if (!lines.length) continue;
      const latest = isToday ? Math.max(9, Number(NOW_HHMM.slice(0, 2)) - 1) : 21;
      const hour = 8 + Math.floor(random() * (latest - 8));
      const remarks = `${MARK} sale ${date} #${n}`;
      const result = await ensure("Sales Invoice", [["remarks", "=", remarks]], {
        company: COMPANY,
        customer: customer?.name ?? "Walk-in Customer",
        posting_date: date,
        posting_time: `${String(hour).padStart(2, "0")}:${String(Math.floor(random() * 60)).padStart(2, "0")}:00`,
        set_posting_time: 1,
        due_date: customer ? day(date, business ? 30 : 15) : date,
        update_stock: 1,
        set_warehouse: WAREHOUSE,
        remarks,
        items: lines,
        docstatus: 1,
      });
      created.push(result.name);
    }
  }
  return { from: day(last, 1), created: created.length };
}

async function payNew() {
  const invoices = await list(
    "Sales Invoice",
    ["name", "customer", "posting_date", "outstanding_amount"],
    [
      ["docstatus", "=", 1],
      ["outstanding_amount", ">", 0],
      ["remarks", "like", `${MARK} sale%`],
    ],
  );
  for (const inv of invoices) await pay(inv);
}

/**
 * ERPNext refuses a credit limit below the customer's current outstanding, so the limit is the
 * planned one or the outstanding plus 20 % headroom (rounded up to ₹500), whichever is higher.
 */
async function creditLimits(profiles) {
  const open = await list(
    "Sales Invoice",
    ["customer", "outstanding_amount"],
    [
      ["docstatus", "=", 1],
      ["outstanding_amount", ">", 0],
      ["company", "=", COMPANY],
    ],
  );
  const owed = new Map();
  for (const row of open)
    owed.set(row.customer, (owed.get(row.customer) ?? 0) + Number(row.outstanding_amount));
  for (const p of profiles) {
    const limit = Math.max(p.credit, Math.ceil(((owed.get(p.name) ?? 0) * 1.2) / 500) * 500);
    if (APPLY)
      await api("PUT", `/api/resource/Customer/${encodeURIComponent(p.name)}`, {
        credit_limits: [{ company: COMPANY, credit_limit: limit, bypass_credit_limit_check: 0 }],
      });
    note("Credit limit");
  }
}

// ---- run ---------------------------------------------------------------------------------
console.error(
  `${APPLY ? "APPLY" : "DRY RUN"} against ${new URL(URL_BASE).host}, company ${COMPANY}, today ${TODAY} ${NOW_HHMM} IST`,
);
console.error(
  `CSV: ${NAMES.length} Bangalore names, ${MODES.length} payment modes, ${QTYS.length} quantities`,
);
await ledgers();
const profiles = await customers();
const existingPaid = await payExisting();
const sales = await newSales(profiles);
await payNew();
await creditLimits(profiles);
console.log(
  JSON.stringify(
    {
      mode: APPLY ? "applied" : "dry-run (nothing written)",
      today: TODAY,
      customers: profiles.length,
      existing_invoices_considered: existingPaid,
      new_sales_from: sales.from,
      new_sales_invoices: sales.created,
      documents: counts,
      requests,
    },
    null,
    2,
  ),
);
