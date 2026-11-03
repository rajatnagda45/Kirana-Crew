#!/usr/bin/env node
/**
 * Read-only checks for NammaOps Kirana Seed v2 on the live ERPNext site.
 *   node --env-file=.env.local scripts/check-seed-v2.mjs
 */
const RAW = (process.env.ERPNEXT_URL ?? "").replace(/\/$/, "");
const BASE = /^https?:\/\//.test(RAW) ? RAW : `https://${RAW}`;
const AUTH = `token ${process.env.ERPNEXT_API_KEY}:${process.env.ERPNEXT_API_SECRET}`;
const COMPANY = process.env.NAMMAOPS_SEED_COMPANY ?? "NammaOPs";
const q = (v) => encodeURIComponent(JSON.stringify(v));
async function get(path) {
  const r = await fetch(BASE + path, {
    headers: { Authorization: AUTH, Accept: "application/json" },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path.split("?")[0]} -> ${r.status}`);
  return j.data ?? j.message;
}
const list = (dt, fields, filters = []) =>
  get(
    `/api/resource/${encodeURIComponent(dt)}?fields=${q(fields)}&filters=${q(filters)}&limit_page_length=0`,
  );
const r2 = (v) => Math.round(v * 100) / 100;
const results = [];
const check = (name, ok, detail) => results.push({ ok: Boolean(ok), name, detail });

const invoices = await list(
  "Sales Invoice",
  [
    "name",
    "customer",
    "posting_date",
    "grand_total",
    "rounded_total",
    "outstanding_amount",
    "status",
  ],
  [
    ["docstatus", "=", 1],
    ["company", "=", COMPANY],
  ],
);
const payments = await list(
  "Payment Entry",
  ["name", "party", "posting_date", "paid_amount", "mode_of_payment", "reference_no"],
  [
    ["docstatus", "=", 1],
    ["company", "=", COMPANY],
    ["payment_type", "=", "Receive"],
  ],
);
const customers = await list("Customer", [
  "name",
  "customer_group",
  "customer_primary_address",
  "customer_primary_contact",
]);
const addresses = await list("Address", ["name", "address_title", "city", "pincode", "phone"]);

const total = (rows, k) => r2(rows.reduce((s, r) => s + Number(r[k] || 0), 0));
const billed = r2(invoices.reduce((s, i) => s + Number(i.rounded_total || i.grand_total), 0));
const outstanding = total(invoices, "outstanding_amount");
const received = total(payments, "paid_amount");
check("paid + outstanding = billed", Math.abs(billed - (received + outstanding)) < 1, {
  billed,
  received,
  outstanding,
});
check(
  "no negative outstanding",
  invoices.every((i) => Number(i.outstanding_amount) >= 0),
);
const walkOpen = invoices.filter(
  (i) => i.customer === "Walk-in Customer" && i.outstanding_amount > 0,
);
check("walk-in sales are all paid", walkOpen.length === 0, { open: walkOpen.length });
const udhaar = invoices.filter(
  (i) => i.customer !== "Walk-in Customer" && i.outstanding_amount > 0,
);
check("some genuine udhaar remains", udhaar.length > 0, {
  open_invoices: udhaar.length,
  amount: total(udhaar, "outstanding_amount"),
});
check(
  "no Synthetic Customer names left",
  !customers.some((c) => /^Synthetic Customer/.test(c.name)),
);
const named = customers.filter((c) => c.name !== "Walk-in Customer");
check(
  "every named customer has primary address and contact",
  named.every((c) => c.customer_primary_address && c.customer_primary_contact),
  { named: named.length },
);
check(
  "addresses are Bengaluru 560xxx with non-dialable phones",
  addresses.every(
    (a) =>
      a.city === "Bengaluru" &&
      /^560\d{3}$/.test(a.pincode) &&
      /^\+91 80 0000 \d{4}$/.test(a.phone ?? ""),
  ),
  { addresses: addresses.length },
);
const d1031 = invoices.filter((i) => i.posting_date === "2026-10-31");
check(
  "2026-10-31 unchanged: 6 invoices, 15745",
  d1031.length === 6 && total(d1031, "grand_total") === 15745,
  { n: d1031.length, total: total(d1031, "grand_total") },
);
const latest = invoices
  .map((i) => i.posting_date)
  .sort()
  .at(-1);
check("data is current", latest >= "2026-11-03", { latest });
const modes = {};
for (const p of payments)
  modes[p.mode_of_payment] = r2((modes[p.mode_of_payment] ?? 0) + p.paid_amount);

for (const r of results)
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  ${JSON.stringify(r.detail)}` : ""}`,
  );
console.log("payment mix (₹):", JSON.stringify(modes));
console.log(
  "status mix:",
  JSON.stringify(invoices.reduce((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {})),
);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
