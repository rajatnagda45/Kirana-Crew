/**
 * Stage 1 (intelligence) workflows: receivables_report, expiry_check, purchase_status,
 * supplier_performance, customer_insights and store_health_report.
 *
 * They run on the existing Workflows runner: every ERP read is a governed call made inside a
 * specialist step under that agent's own identity, results are computed deterministically, and
 * the Manager consolidates. Nothing here writes to ERP.
 */
import {
  aggregateSales,
  analyseStock,
  resolveProducts,
  stockByItem,
  matchCustomer,
} from "./calculations.mjs";
import { addDays } from "./forecast.mjs";
import { ageing, daysBetween, round } from "./dashboards.mjs";

export const V2_INTENTS = [
  "receivables_report",
  "expiry_check",
  "purchase_status",
  "supplier_performance",
  "customer_insights",
  "store_health_report",
  "business_report",
  "billing_summary",
  "payments_summary",
  "gst_summary",
  "purchase_order_lookup",
  "prepare_bill",
];
/** Asking for a new bill (a write), as opposed to asking about existing bills (a report). */
const BILL_REQUEST =
  /\b(?:create|make|generate|raise|prepare|issue|write|draw up)\s+(?:(?:a|an|the|new|one|me)\s+)*(?:customer(?:'s)?\s+)?(?:bill|bil|invoice|invoce)\b/;

const WORD_NUMBERS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  half: 0.5,
};
/** Unit words: mass and volume convert against a pack size; the rest just mean "that many". */
const MASS = {
  kg: 1000,
  kgs: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogram: 1000,
  kilograms: 1000,
  g: 1,
  gm: 1,
  gms: 1,
  gram: 1,
  grams: 1,
};
const VOLUME = { l: 1000, ltr: 1000, litre: 1000, liter: 1000, litres: 1000, liters: 1000, ml: 1 };
const COUNT_WORDS =
  "(?:packets?|packs?|pieces?|pcs|nos|units?|bottles?|tins?|boxes|box|bags?|cartons?|dozens?)";
const NOT_A_NAME = new Set([
  "which",
  "who",
  "that",
  "the",
  "a",
  "an",
  "one",
  "has",
  "have",
  "this",
  "said",
  "of",
  "to",
]);

/**
 * Reads "create bill of customer which has taken 1 kg toor dal and one packet of milk" (or
 * "bill for Lakshmi Stores: 2 kg sugar, 3 biscuits") into a customer, if one was named, and lines.
 * A line with no quantity keeps `quantity: undefined`: the workflow asks, it never guesses.
 */
export function parseBillRequest(raw) {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let customer;
  const named =
    /\b(?:customer|client)\s+(?:named\s+|called\s+|name\s+is\s+)?([A-Za-z][A-Za-z0-9'.&-]*(?: [A-Za-z][A-Za-z0-9'.&-]*){0,4}?)(?=\s+(?:who|which|that|has|have|having|taken|took|bought|with)\b|\s*[:,]|$)/i.exec(
      text,
    ) ??
    /\b(?:for|to)\s+((?:[A-Z][A-Za-z0-9'.&-]*)(?: [A-Z][A-Za-z0-9'.&-]*){0,4})(?=\s+(?:who|which|that|has|have|having|taken|took|bought|with)\b|\s*[:,]|$)/.exec(
      text,
    );
  if (named && !NOT_A_NAME.has(named[1].toLowerCase())) customer = named[1].trim();
  const marker = /\b(?:taken|took|bought|purchased|buys?|buying|having|with|for)\b[:\s]*|:\s*/gi;
  // The item list starts after the LAST marker that is followed by a quantity ("for Lakshmi Stores:
  // 2 rice" starts at the colon, not at "for"; "who bought 2 rice" at "bought").
  let tail = null;
  for (const m of [...text.matchAll(marker)].reverse()) {
    const rest = text.slice(m.index + m[0].length);
    if (/\d|\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(rest)) {
      tail = rest;
      break;
    }
  }
  if (!tail) return { customer, lines: [] };
  // "with item 1 kg kabuli channa 1 handwash": drop the filler word, and when the list starts with a
  // quantity, a number followed by a product word starts the next item ("... channa | 1 handwash").
  // A size inside a name ("toor dal 1 kg") has no product word after it, so it is not split.
  tail = tail.replace(/^(?:items?|products?)\b\s*[:-]?\s*/i, "");
  if (/^\d/.test(tail))
    tail = tail.replace(
      /(?<=[a-z])\s+(?=\d+(?:\.\d+)?\s*(?:(?:kgs?|gms?|g|ml|ltr|litres?|l)\s+)?(?!(?:kgs?|gms?|g|ml|ltr|litres?|l)\b)[a-z]{3,})/gi,
      " , ",
    );
  const lines = [];
  for (const part of tail.split(/\s*(?:,|&|;|\band\b|\bplus\b)\s*/i)) {
    const segment = part
      .replace(/[.?!]+$/g, "")
      .replace(/\b(?:please|only)\b/gi, "")
      .trim();
    if (!segment) continue;
    const m = new RegExp(
      `^(?:(\\d+(?:\\.\\d+)?|${Object.keys(WORD_NUMBERS).join("|")})\\s*)?(?:(${[...Object.keys(MASS), ...Object.keys(VOLUME)].join("|")})\\b\\s*)?(?:of\\s+)?(?:${COUNT_WORDS}\\s+(?:of\\s+)?)?(.+)$`,
      "i",
    ).exec(segment);
    if (!m) continue;
    const said = m[1];
    const quantity =
      said === undefined ? undefined : (WORD_NUMBERS[said.toLowerCase()] ?? Number(said));
    const product = m[3].trim();
    if (!product || /^\d+$/.test(product)) continue;
    lines.push({
      product: product.slice(0, 60),
      ...(quantity > 0 ? { quantity } : {}),
      ...(m[2] ? { unit: m[2].toLowerCase() } : {}),
    });
  }
  return { customer, lines };
}

/**
 * "kabuli chana handwash" -> "kabuli chana" + "handwash" when the whole phrase names no item but
 * its words split cleanly into phrases that each name exactly one. The quantity stays with the
 * first product (it was said before the run of names); the others are asked.
 */
export function splitRunTogether(lines, items) {
  const names = (phrase) => {
    const found = resolveProducts([phrase], items);
    return found.clarifications.length
      ? null
      : new Set(found.resolved.map((row) => row.item.item_code));
  };
  const out = [];
  for (const line of lines) {
    const words = line.product.split(/\s+/);
    const whole = resolveProducts([line.product], items).clarifications[0];
    if (words.length < 2 || whole?.reason !== "unknown") {
      out.push(line);
      continue;
    }
    // Longest phrase first, so "kabuli chana" is not read as just "kabuli".
    const segment = (from) => {
      if (from === words.length) return [];
      for (let end = words.length; end > from; end -= 1) {
        const phrase = words.slice(from, end).join(" ");
        if (names(phrase)?.size !== 1) continue;
        const rest = segment(end);
        if (rest) return [phrase, ...rest];
      }
      return null;
    };
    const phrases = segment(0);
    if (!phrases || phrases.length < 2) out.push(line);
    else
      phrases.forEach((phrase, index) =>
        out.push(index === 0 ? { ...line, product: phrase } : { product: phrase }),
      );
  }
  return out;
}

export const isWeightOrVolume = (unit) => Object.hasOwn(MASS, unit) || Object.hasOwn(VOLUME, unit);

const NUMBER_ONLY = new RegExp(
  `^(?:about\\s+|around\\s+)?(\\d+(?:\\.\\d+)?|${Object.keys(WORD_NUMBERS).join("|")})\\s*(?:${COUNT_WORDS}|packs?)?\\s*[.!]?$`,
  "i",
);

/**
 * The owner's short reply to the question Frank just asked ("2", "Toned Milk", "Lakshmi Stores"),
 * merged into the bill request that was waiting. Returns the completed request, or null when the
 * message is not an answer to that question: a new request is never taken for one.
 * @param {{intent: any, clarifications: any[]} | null} pending the bill request waiting for an answer
 */
export function applyBillAnswer(pending, message) {
  const ask = pending?.clarifications?.[0];
  const intent = pending?.intent;
  const text = String(message ?? "").trim();
  if (!ask || intent?.action !== "prepare_bill" || !text || text.length > 80) return null;
  // "how many bills today" or "create a bill for ..." is a new request, not an answer.
  if (parseV2(text.toLowerCase())) return null;
  const lines = (intent.lines ?? []).map((line) => ({ ...line }));
  const said = NUMBER_ONLY.exec(text);
  const number = said ? (WORD_NUMBERS[said[1].toLowerCase()] ?? Number(said[1])) : null;
  const lineFor = () => lines.find((line) => line.product === ask.requested);
  switch (ask.reason) {
    case "missing_quantity":
    case "unit_mismatch": {
      // For a weight that was not a whole pack the answer is the number of packs.
      if (!(number > 0)) return null;
      let line = lineFor();
      if (!line) {
        // The question was about a product split out of a run-together line ("kabuli chana
        // handwash"): split that line the same way, and give the answer to the new product.
        const wanted = String(ask.requested).toLowerCase();
        const host = lines.find((row) => row.product.toLowerCase().includes(wanted));
        if (!host) return null;
        const at = host.product.toLowerCase().indexOf(wanted);
        const before = host.product.slice(0, at).trim();
        const after = host.product.slice(at + wanted.length).trim();
        line = { product: String(ask.requested) };
        lines.splice(
          lines.indexOf(host),
          1,
          ...(before ? [{ ...host, product: before }] : []),
          line,
          ...(after ? [{ product: after }] : []),
        );
      }
      line.quantity = number;
      delete line.unit;
      return { ...intent, lines };
    }
    case "ambiguous":
    case "unknown": {
      const line = lineFor();
      if (said || !line) return null;
      line.product = text.replace(/[.?!]+$/, "").slice(0, 60);
      return { ...intent, lines };
    }
    case "ambiguous_customer":
    case "unknown_customer": {
      if (said) return null;
      const next = { ...intent, lines };
      if (/^(walk[- ]?in( customer)?|default|none|no name|anyone|no one)\b/i.test(text))
        delete next.customer;
      else next.customer = text.replace(/[.?!]+$/, "").slice(0, 140);
      return next;
    }
    case "missing_items": {
      const parsed = parseBillRequest(`bill taken ${text}`);
      return parsed.lines.length ? { ...intent, lines: parsed.lines } : null;
    }
    default:
      return null;
  }
}

/** "Toor Dal 1kg" -> {base: 1000, kind: "mass"}; "Toned Milk 500ml" -> {base: 500, kind: "volume"}. */
function packSizeOf(itemName) {
  const m = /(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|ml|ltr|l|litre|liter)\b/i.exec(
    String(itemName ?? ""),
  );
  if (!m) return null;
  const unit = m[2].toLowerCase();
  return unit in MASS
    ? { base: Number(m[1]) * MASS[unit], kind: "mass" }
    : { base: Number(m[1]) * VOLUME[unit], kind: "volume" };
}
/** ERPNext purchase order ids look like PUR-ORD-2026-00004 (the fixture uses PUR-ORD-FX-0001). */
export const PO_NAME = /\bpur-ord-[a-z0-9-]{3,50}\b/i;
/** Item groups treated as perishable when prioritising expiry. */
const PERISHABLE = /dairy|bakery|bread|milk|curd|egg|fruit|vegetable|meat|fish|fresh/i;
const sum = (rows, pick) => round(rows.reduce((total, row) => total + Number(pick(row) || 0), 0));

/** Owner wording for the new workflows; checked before the original five. */
export function parseV2(lower) {
  // Asking for a NEW bill is a write for Frank; asking about bills ("bills today") is a report.
  if (BILL_REQUEST.test(lower)) return { action: "prepare_bill" };
  // A named purchase order, a GST question or a payments question is specific: it wins over the
  // broader wording below ("monthly GST report" is the GST summary, not the business report).
  const poName = PO_NAME.exec(lower)?.[0];
  if (poName) return { action: "purchase_order_lookup", po_name: poName.toUpperCase() };
  if (/\b(gst|gstr|hsn|cgst|sgst|igst|input tax|output tax)\b/.test(lower))
    return { action: "gst_summary" };
  if (
    (/\bpayments?\b/.test(lower) ||
      /\b(?:money|amount|cash)\s+(?:received|collected|paid)\b/.test(lower) ||
      /\bhow much\b.*\b(?:received|collected)\b/.test(lower)) &&
    // Money still owed is udhaar (receivables), not a payments summary.
    !/\b(udhaar|udhar|unpaid|not paid|owe[sd]?|dues?|outstanding|overdue|pending)\b/.test(lower)
  )
    return { action: "payments_summary" };
  if (
    /\b(problems?|issues?|health|biggest|what('s| is) wrong|how is my (shop|store))\b/.test(lower)
  )
    return { action: "store_health_report" };
  // A weekly or monthly report is Grace's. A period word is required, so a bare "report" stays
  // the daily report.
  if (
    /\b(weekly|monthly|week|month|\d{1,2} days?)\b/.test(lower) &&
    /\b(report|summary|review|overview|how (?:did|was|is|has))\b/.test(lower) &&
    // Bills are Frank's; "sales summary for the last 3 days" is Carol's, not the owner's report.
    !/\b(bills?|billing|invoices?)\b/.test(lower) &&
    (!/\b(sales?|sold|sell|selling|revenue|profit)\b/.test(lower) ||
      /\b(weekly|monthly|business|store|shop) (?:report|review|summary)\b/.test(lower))
  )
    return { action: "business_report" };
  if (
    /\b(udhaar|udhar|credit|receivables?|outstanding|dues?|owes?|owed|collect|not paid|unpaid)\b/.test(
      lower,
    )
  )
    return { action: "receivables_report" };
  if (/\b(expir\w*|expiry|best before|shelf life)\b/.test(lower)) return { action: "expiry_check" };
  const productsAfter = (re) =>
    ((re.exec(lower) ?? [])[1] ?? "")
      .split(/,|\band\b|&/)
      .map((part) => part.replace(/\b(the|our|my|of|deliveries|delivery|orders?)\b/g, "").trim())
      .filter(Boolean);
  if (
    /\bsuppliers?\b|\bvendors?\b/.test(lower) &&
    /\b(delay\w*|late|performance|reliab\w*|on.time|slow)\b/.test(lower)
  )
    return {
      action: "supplier_performance",
      products: productsAfter(
        /\b(?:delaying|delay|for|of|our)\s+(?:our\s+)?([a-z ,&]+?)\s*(?:deliver\w*|orders?)?[.?!]*$/,
      ),
    };
  if (
    /\b(purchase orders?|po status|deliver\w*|received|pending orders?|orders? (status|pending))\b/.test(
      lower,
    )
  )
    return { action: "purchase_status" };
  if (
    /\bcustomers?\b/.test(lower) &&
    /\b(every week|weekly|regular|loyal|inactive|stopped|best|top|high.value|frequent\w*|insights?|which)\b/.test(
      lower,
    )
  )
    return { action: "customer_insights" };
  // Counter billing is Frank's: how many bills, how big, how they were paid. Udhaar, stock and
  // supplier wording was already routed above.
  if (/\b(bills?|billing|invoices?|receipts?|cash memos?)\b/.test(lower))
    return { action: "billing_summary" };
  return null;
}

async function readSlices(call, businessId, from, to, key, { days = 7, batch = Infinity } = {}) {
  // Slices are read together (in batches when `batch` is set); the adapter limits its own
  // concurrency. A slice's response must stay under the governed gateway's response cap, so a
  // read that returns one row per invoice line uses day-sized slices.
  const slices = [];
  for (let start = from; start <= to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    slices.push({ from_date: start, to_date: end < to ? end : to });
  }
  const parts = [];
  for (let at = 0; at < slices.length; at += batch)
    parts.push(
      ...(await Promise.all(
        slices
          .slice(at, at + batch)
          .map(async (range) => (await call(businessId, range))[key] ?? []),
      )),
    );
  return parts.flat();
}

// ---- Finance: udhaar ---------------------------------------------------------------------
async function receivablesReport(wf, workflowId, intent, workforce) {
  const asOf = wf.today();
  const finance = await wf.step(
    workflowId,
    workforce,
    "finance",
    "Read receivables and age the udhaar",
    async ({ call }) => {
      const data = await call("erp.receivables.aging", { as_of: asOf });
      const aged = ageing(data.invoices ?? [], asOf);
      const limits = new Map((data.customers ?? []).map((c) => [c.name, c]));
      const byCustomer = new Map();
      for (const row of aged.rows) {
        const entry = byCustomer.get(row.customer) ?? {
          customer: row.customer,
          outstanding: 0,
          invoices: [],
          oldest_days_overdue: 0,
          partially_paid: 0,
        };
        entry.outstanding = round(entry.outstanding + Number(row.outstanding_amount));
        entry.oldest_days_overdue = Math.max(entry.oldest_days_overdue, row.days_overdue);
        const partial = Number(row.outstanding_amount) < Number(row.grand_total);
        if (partial) entry.partially_paid += 1;
        entry.invoices.push({
          invoice: row.name,
          posting_date: row.posting_date,
          due_date: row.due_date,
          grand_total: Number(row.grand_total),
          outstanding: Number(row.outstanding_amount),
          days_overdue: row.days_overdue,
          partially_paid: partial,
        });
        byCustomer.set(row.customer, entry);
      }
      const customers = [...byCustomer.values()].map((c) => {
        const limit = limits.get(c.customer)?.credit_limit ?? null;
        return {
          ...c,
          credit_limit: limit,
          over_limit: limit ? c.outstanding > limit : false,
          // Older and larger dues first; anything not yet due waits.
          priority: c.oldest_days_overdue > 0 ? round(c.outstanding * c.oldest_days_overdue) : 0,
        };
      });
      customers.sort((a, b) => b.priority - a.priority || b.outstanding - a.outstanding);
      return {
        aged,
        customers,
        summary: `${customers.length} customer(s) owe ${aged.total}; ${customers.filter((c) => c.oldest_days_overdue > 30).length} have an invoice overdue by more than 30 days.`,
      };
    },
  );
  // Only invoices that are themselves more than 30 days past due count towards this figure.
  const rows = finance.aged.rows;
  let periodNew;
  if (intent.focus === "new") {
    const from = intent.date ?? addDays(asOf, -7);
    const to = intent.to ?? (intent.date ? intent.date : addDays(asOf, -1));
    const inPeriod = rows.filter((r) => r.posting_date >= from && r.posting_date <= to);
    const byName = new Map();
    for (const r of inPeriod)
      byName.set(r.customer, round((byName.get(r.customer) ?? 0) + Number(r.outstanding_amount)));
    periodNew = {
      from_date: from,
      to_date: to,
      amount: sum(inPeriod, (r) => r.outstanding_amount),
      invoices: inPeriod.length,
      customers: [...byName]
        .map(([customer, amount]) => ({ customer, amount }))
        .sort((a, b) => b.amount - a.amount),
    };
  }
  let dueSoon;
  if (intent.focus === "due_soon") {
    const limit = addDays(asOf, 7);
    const soon = rows.filter((r) => r.due_date >= asOf && r.due_date <= limit);
    const byName = new Map();
    for (const r of soon) {
      const cur = byName.get(r.customer) ?? {
        customer: r.customer,
        amount: 0,
        due_date: r.due_date,
      };
      cur.amount = round(cur.amount + Number(r.outstanding_amount));
      if (r.due_date < cur.due_date) cur.due_date = r.due_date;
      byName.set(r.customer, cur);
    }
    dueSoon = {
      days: 7,
      amount: sum(soon, (r) => r.outstanding_amount),
      customers: [...byName.values()].sort((a, b) => a.due_date.localeCompare(b.due_date)),
    };
  }
  const over30Rows = finance.aged.rows.filter((r) => r.days_overdue > 30);
  const over30 = {
    customers: new Set(over30Rows.map((r) => r.customer)).size,
    amount: sum(over30Rows, (r) => r.outstanding_amount),
  };
  return {
    status: "completed",
    result: {
      kind: "receivables_report",
      as_of: asOf,
      ...(periodNew ? { period_new: periodNew } : {}),
      ...(dueSoon ? { due_soon: dueSoon } : {}),
      total_outstanding: finance.aged.total,
      overdue: round(finance.aged.total - finance.aged.totals["Not due"]),
      buckets: finance.aged.totals,
      overdue_over_30_days: over30,
      partial_payments: finance.customers.reduce((n, c) => n + c.partially_paid, 0),
      collection_priority: finance.customers
        .filter((c) => c.priority > 0)
        .map(({ invoices, ...c }) => ({ ...c, invoices: invoices.length })),
      customers: finance.customers,
      sources: { capability: "erp.receivables.aging" },
    },
  };
}

// ---- Inventory: expiry -------------------------------------------------------------------
async function expiryCheck(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const inventory = await wf.step(
    workflowId,
    workforce,
    "inventory",
    "Read batches and value stock at risk of expiry",
    async ({ call }) => {
      const [{ batches }, { valuations }, { items }] = await Promise.all([
        call("erp.batches.list", {}),
        call("erp.items.valuation", {}),
        call("erp.items.list", {}),
      ]);
      const masters = new Map(valuations.map((v) => [v.item_code, v]));
      const names = new Map(items.map((i) => [i.item_code, i.item_name]));
      const rows = (batches ?? [])
        .filter((b) => Number(b.qty) > 0 && b.expiry_date)
        .map((b) => {
          const master = masters.get(b.item_code) ?? {};
          const days = daysBetween(today, b.expiry_date);
          const rate = Number(master.valuation_rate);
          const group =
            master.item_group ?? items.find((i) => i.item_code === b.item_code)?.item_group ?? null;
          return {
            batch_no: b.batch_no,
            item_code: b.item_code,
            item_name: names.get(b.item_code) ?? b.item_code,
            item_group: group,
            perishable: PERISHABLE.test(`${group ?? ""} ${names.get(b.item_code) ?? ""}`),
            qty: Number(b.qty),
            expiry_date: b.expiry_date,
            days_left: days,
            value_at_risk: Number.isFinite(rate) ? round(Number(b.qty) * rate) : null,
            window:
              days < 0
                ? "expired"
                : days <= 7
                  ? "7_days"
                  : days <= 15
                    ? "15_days"
                    : days <= 30
                      ? "30_days"
                      : "later",
          };
        })
        .filter((row) => row.window !== "later")
        // Perishables first, then soonest expiry, then value.
        .sort(
          (a, b) =>
            Number(b.perishable) - Number(a.perishable) ||
            a.days_left - b.days_left ||
            (b.value_at_risk ?? 0) - (a.value_at_risk ?? 0),
        );
      return {
        rows,
        tracked: (batches ?? []).length,
        summary: `${(batches ?? []).length} batch(es) read; ${rows.length} expired or expiring within 30 days.`,
      };
    },
  );
  const windows = {};
  for (const key of ["expired", "7_days", "15_days", "30_days"]) {
    const rows = inventory.rows.filter((r) => r.window === key);
    windows[key] = {
      batches: rows.length,
      qty: sum(rows, (r) => r.qty),
      value: sum(rows, (r) => r.value_at_risk),
    };
  }
  return {
    status: "completed",
    result: {
      kind: "expiry_check",
      as_of: today,
      batches_tracked: inventory.tracked,
      windows,
      value_at_risk: sum(inventory.rows, (r) => r.value_at_risk),
      unvalued_batches: inventory.rows.filter((r) => r.value_at_risk === null).length,
      items: inventory.rows,
      ...(inventory.tracked
        ? {}
        : { note: "No batch-tracked stock was returned by ERP, so expiry cannot be checked." }),
    },
  };
}

// ---- Procurement: purchase lifecycle -----------------------------------------------------
function purchaseLines(open, today) {
  return (open ?? []).flatMap((po) =>
    po.items.map((line) => ({
      purchase_order: po.name,
      supplier: po.supplier,
      item_code: line.item_code,
      ordered_qty: line.ordered_qty ?? null,
      received_qty: line.received_qty ?? null,
      pending_qty: Number(line.pending_qty),
      expected: po.schedule_date,
      days_late:
        po.schedule_date && Number(line.pending_qty) > 0
          ? Math.max(0, daysBetween(po.schedule_date, today))
          : 0,
      rate: line.rate ?? null,
    })),
  );
}

async function purchaseStatus(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const procurement = await wf.step(
    workflowId,
    workforce,
    "procurement",
    "Track open purchase orders, deliveries and supplier bills",
    async ({ call }) => {
      const [{ purchase_orders }, payables, { items }] = await Promise.all([
        call("erp.po.open", {}),
        call("erp.payables.aging", { as_of: today }),
        call("erp.items.list", {}),
      ]);
      const names = new Map(items.map((i) => [i.item_code, i.item_name]));
      const lines = purchaseLines(purchase_orders, today).map((l) => ({
        ...l,
        item_name: names.get(l.item_code) ?? l.item_code,
      }));
      const aged = ageing(payables.invoices ?? [], today);
      return {
        lines,
        aged,
        summary: `${purchase_orders.length} open purchase order(s), ${lines.filter((l) => l.days_late > 0).length} late line(s); ${aged.rows.length} unpaid supplier bill(s).`,
      };
    },
  );
  const late = procurement.lines
    .filter((l) => l.days_late > 0)
    .sort((a, b) => b.days_late - a.days_late);
  return {
    status: "completed",
    result: {
      kind: "purchase_status",
      as_of: today,
      open_orders: new Set(procurement.lines.map((l) => l.purchase_order)).size,
      lines: procurement.lines,
      delayed: late,
      partially_received: procurement.lines.filter((l) => l.received_qty > 0 && l.pending_qty > 0)
        .length,
      payables: {
        total: procurement.aged.total,
        overdue: round(procurement.aged.total - procurement.aged.totals["Not due"]),
        bills: procurement.aged.rows.map((r) => ({
          bill: r.name,
          supplier: r.supplier,
          due_date: r.due_date,
          outstanding: Number(r.outstanding_amount),
          days_overdue: r.days_overdue,
        })),
      },
    },
  };
}

async function supplierPerformance(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const from = addDays(today, -89);
  const procurement = await wf.step(
    workflowId,
    workforce,
    "procurement",
    "Score suppliers on delivery, price and dues",
    async ({ call }) => {
      const [{ suppliers }, { quotations }, { purchase_orders }, payables, { items }] =
        await Promise.all([
          call("erp.suppliers.list", {}),
          call("erp.supplier_quotations.list", {}),
          call("erp.po.open", {}),
          call("erp.payables.aging", { as_of: today }),
          call("erp.items.list", {}),
        ]);
      let focus = null;
      if (intent.products?.length) {
        const { resolved, clarifications } = resolveProducts(intent.products, items);
        if (clarifications.length)
          return { clarifications, summary: "Product needs clarification." };
        focus = new Set(resolved.map((r) => r.item.item_code));
      }
      const bills = await readSlices(call, "erp.purchase_invoices.list", from, today, "invoices");
      const lines = purchaseLines(purchase_orders, today).filter(
        (l) => !focus || focus.has(l.item_code),
      );
      const quotes = quotations.filter((q) => !focus || focus.has(q.item_code));
      const scores = suppliers.map((s) => {
        const own = lines.filter((l) => l.supplier === s.name);
        const late = own.filter((l) => l.days_late > 0);
        // Price variance: invoiced rate vs the supplier's own quotation for the same item.
        const variances = [];
        for (const bill of bills.filter((b) => b.supplier === s.name))
          for (const line of bill.items ?? []) {
            if (focus && !focus.has(line.item_code)) continue;
            const quote = quotes.find(
              (q) => q.supplier === s.name && q.item_code === line.item_code,
            );
            if (quote && Number(quote.rate) > 0)
              variances.push(
                round(((Number(line.rate) - Number(quote.rate)) / Number(quote.rate)) * 100, 1),
              );
          }
        const owed = (payables.invoices ?? []).filter((b) => b.supplier === s.name);
        return {
          supplier: s.name,
          quoted_lead_time_days: s.lead_time_days ?? null,
          on_time_rate: s.on_time_rate ?? null,
          open_lines: own.length,
          late_lines: late.length,
          max_days_late: late.length ? Math.max(...late.map((l) => l.days_late)) : 0,
          late_items: [...new Set(late.map((l) => l.item_code))],
          price_variance_pct: variances.length
            ? round(variances.reduce((a, b) => a + b, 0) / variances.length, 1)
            : null,
          quotations: quotes.filter((q) => q.supplier === s.name).length,
          outstanding: sum(owed, (b) => b.outstanding_amount),
        };
      });
      const relevant = focus ? scores.filter((s) => s.open_lines || s.quotations) : scores;
      relevant.sort(
        (a, b) =>
          b.late_lines - a.late_lines ||
          b.max_days_late - a.max_days_late ||
          (a.on_time_rate ?? 1) - (b.on_time_rate ?? 1),
      );
      return {
        scores: relevant,
        focus: focus ? [...focus] : null,
        summary: `${relevant.length} supplier(s) scored; ${relevant.filter((s) => s.late_lines).length} with late deliveries.`,
      };
    },
  );
  if (procurement.clarifications)
    return { status: "needs_clarification", clarifications: procurement.clarifications };
  return {
    status: "completed",
    result: {
      kind: "supplier_performance",
      as_of: today,
      products: procurement.focus,
      suppliers: procurement.scores,
      delaying: procurement.scores.filter((s) => s.late_lines > 0),
      price_basis:
        "Invoiced rate vs the same supplier's quotation for the same item, last 90 days.",
    },
  };
}

// ---- Sales: customer intelligence --------------------------------------------------------
async function customerInsights(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const from = addDays(today, -83); // 12 full weeks
  const sales = await wf.step(
    workflowId,
    workforce,
    "sales",
    "Analyse named-customer purchase history",
    async ({ call }) => {
      const [invoices, { customers }, { items }] = await Promise.all([
        readSlices(call, "erp.sales_invoices.list", from, today, "invoices"),
        call("erp.customers.list", {}),
        call("erp.items.list", {}),
      ]);
      const names = new Map(items.map((i) => [i.item_code, i.item_name]));
      const named = invoices.filter((i) => i.customer && i.customer !== "Walk-in Customer");
      const returns = invoices.filter((i) => i.is_return || Number(i.grand_total) < 0);
      const stats = new Map();
      for (const inv of named) {
        const s = stats.get(inv.customer) ?? {
          customer: inv.customer,
          invoices: 0,
          sales: 0,
          weeks: new Set(),
          last: null,
          products: new Map(),
        };
        s.invoices += 1;
        s.sales = round(s.sales + Number(inv.grand_total));
        s.weeks.add(Math.floor(daysBetween(from, inv.posting_date) / 7));
        s.last = !s.last || inv.posting_date > s.last ? inv.posting_date : s.last;
        for (const line of inv.items ?? [])
          s.products.set(line.item_code, (s.products.get(line.item_code) ?? 0) + Number(line.qty));
        stats.set(inv.customer, s);
      }
      const rows = [...stats.values()].map((s) => ({
        customer: s.customer,
        invoices: s.invoices,
        sales: s.sales,
        average_bill: round(s.sales / s.invoices),
        active_weeks: s.weeks.size,
        last_purchase: s.last,
        days_since_last: daysBetween(s.last, today),
        favourite_products: [...s.products]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([code, qty]) => ({ item: names.get(code) ?? code, qty })),
      }));
      rows.sort((a, b) => b.sales - a.sales);
      return {
        rows,
        customers: customers.length,
        returns: returns.map((r) => ({
          invoice: r.name,
          customer: r.customer,
          amount: Number(r.grand_total),
        })),
        summary: `${rows.length} named customer(s) bought in the last 12 weeks.`,
      };
    },
  );
  const rows = sales.rows;
  const weekly = rows.filter((r) => r.active_weeks >= 8);
  const regular = rows.filter((r) => r.invoices >= 3);
  const inactive = regular.filter((r) => r.days_since_last > 21);
  const cutoff = rows.length ? rows[Math.max(0, Math.ceil(rows.length * 0.2) - 1)].sales : 0;
  return {
    status: "completed",
    result: {
      kind: "customer_insights",
      period: { from_date: from, to_date: today },
      named_customers: sales.customers,
      buying_customers: rows.length,
      weekly_buyers: weekly,
      regular_customers: regular.length,
      inactive_regulars: inactive,
      high_value: rows.filter((r) => r.sales >= cutoff).slice(0, 10),
      customers: rows,
      returns: {
        count: sales.returns.length,
        amount: sum(sales.returns, (r) => r.amount),
        invoices: sales.returns,
      },
      discounts: {
        status: "not_available",
        reason: "Invoice discounts are not returned by the governed sales tools.",
      },
      definitions: {
        weekly: "Bought in at least 8 of the last 12 weeks.",
        regular: "At least 3 invoices in 12 weeks.",
        inactive: "A regular with no purchase in the last 21 days.",
        high_value: "Top 20% of named customers by sales.",
      },
    },
  };
}

// ---- Manager: store health ---------------------------------------------------------------
async function storeHealthReport(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const yesterday = addDays(today, -1);
  const week = { from_date: addDays(today, -7), to_date: yesterday };
  // The four specialist checks are independent (each optional, each its own governed task), so
  // they run together; the slowest one bounds the report instead of the sum of all four.
  const [sales, inventory, finance, procurement] = await Promise.all([
    wf.step(
      workflowId,
      workforce,
      "sales",
      "Compare yesterday's sales with the past week",
      async ({ call }) => {
        const read = async (period) => [
          ...((await call("erp.sales_invoices.list", period)).invoices ?? []),
          ...((await call("erp.pos_invoices.list", period)).invoices ?? []),
        ];
        const recent = await read(week);
        const yday = sum(
          recent.filter((i) => i.posting_date === yesterday),
          (i) => i.grand_total,
        );
        const prior = recent.filter((i) => i.posting_date < yesterday);
        const average = round(sum(prior, (i) => i.grand_total) / 6);
        return { yday, average, summary: `Yesterday ${yday} vs 6-day average ${average}.` };
      },
      { optional: true },
    ),
    wf.step(
      workflowId,
      workforce,
      "inventory",
      "Check low stock and near expiry",
      async ({ call }) => {
        const [{ items }, { bins }, { valuations }, { batches }] = await Promise.all([
          call("erp.items.list", {}),
          call("erp.stock.balance", {}),
          call("erp.items.valuation", {}),
          call("erp.batches.list", {}),
        ]);
        const { rows, low } = analyseStock(items, stockByItem(bins));
        const rate = new Map(valuations.map((v) => [v.item_code, Number(v.valuation_rate)]));
        const out = rows.filter((r) => r.available <= 0);
        const expiring = (batches ?? []).filter(
          (b) => Number(b.qty) > 0 && b.expiry_date && daysBetween(today, b.expiry_date) <= 7,
        );
        const expired = expiring.filter((b) => daysBetween(today, b.expiry_date) < 0);
        const value = (list) =>
          round(list.reduce((s, b) => s + Number(b.qty) * (rate.get(b.item_code) || 0), 0));
        return {
          low,
          out,
          batches_tracked: (batches ?? []).length,
          expired_value: value(expired),
          expiring_value: value(expiring.filter((b) => !expired.includes(b))),
          summary: `${low.length} low, ${out.length} out of stock; ${expiring.length} batch(es) expired or expiring within 7 days.`,
        };
      },
      { optional: true },
    ),
    wf.step(
      workflowId,
      workforce,
      "finance",
      "Check udhaar and the past week's profit",
      async ({ call }) => {
        const data = await call("erp.receivables.aging", { as_of: today });
        const aged = ageing(data.invoices ?? [], today);
        const limits = new Map((data.customers ?? []).map((c) => [c.name, c.credit_limit]));
        const over30 = aged.rows.filter((r) => r.days_overdue > 30);
        const owed = new Map();
        for (const r of aged.rows)
          owed.set(r.customer, (owed.get(r.customer) ?? 0) + Number(r.outstanding_amount));
        const overLimit = [...owed]
          .filter(([c, v]) => limits.get(c) && v > limits.get(c))
          .map(([c]) => c);
        let pnl = null;
        try {
          pnl = await call("erp.pnl", week);
        } catch {
          pnl = null; // No posted P&L for the week is reported as unknown, not as zero.
        }
        return {
          total: aged.total,
          over30: {
            customers: new Set(over30.map((r) => r.customer)).size,
            amount: sum(over30, (r) => r.outstanding_amount),
          },
          overLimit,
          pnl,
          summary: `Udhaar ${aged.total}; ${sum(over30, (r) => r.outstanding_amount)} overdue >30 days.`,
        };
      },
      { optional: true },
    ),
    wf.step(
      workflowId,
      workforce,
      "procurement",
      "Check supplier deliveries",
      async ({ call }) => {
        const { purchase_orders } = await call("erp.po.open", {});
        const late = purchaseLines(purchase_orders, today).filter((l) => l.days_late > 0);
        return { late, summary: `${late.length} purchase order line(s) delivered late.` };
      },
      { optional: true },
    ),
  ]);
  const problems = [];
  const add = (area, severity, title, detail, impact = 0) =>
    problems.push({ area, severity, title, detail, impact: round(impact) });
  if (inventory.ok) {
    if (inventory.out.length)
      add(
        "inventory",
        3,
        `${inventory.out.length} item(s) out of stock`,
        inventory.out
          .slice(0, 5)
          .map((r) => r.item_name)
          .join(", "),
      );
    if (inventory.expired_value > 0)
      add(
        "inventory",
        3,
        "Expired stock on the shelf",
        `Value ${inventory.expired_value}; remove and write off.`,
        inventory.expired_value,
      );
    if (inventory.low.length)
      add(
        "inventory",
        2,
        `${inventory.low.length} item(s) at or below reorder level`,
        inventory.low
          .slice(0, 5)
          .map((r) => `${r.item_name} (${r.available})`)
          .join(", "),
      );
    if (inventory.expiring_value > 0)
      add(
        "inventory",
        2,
        "Stock expiring within 7 days",
        `Value ${inventory.expiring_value}; sell first or discount.`,
        inventory.expiring_value,
      );
  }
  if (finance.ok) {
    if (finance.over30.amount > 0)
      add(
        "finance",
        finance.over30.amount > 10000 ? 3 : 2,
        "Udhaar overdue more than 30 days",
        `${finance.over30.customers} customer(s) owe ${finance.over30.amount}.`,
        finance.over30.amount,
      );
    if (finance.overLimit.length)
      add("finance", 3, "Customers over their credit limit", finance.overLimit.join(", "));
    if (finance.pnl && finance.pnl.net_profit < 0)
      add(
        "finance",
        3,
        "Loss over the past week",
        `Posted net profit ${finance.pnl.net_profit}.`,
        -finance.pnl.net_profit,
      );
  }
  if (procurement.ok && procurement.late.length)
    add(
      "procurement",
      2,
      "Late supplier deliveries",
      procurement.late
        .slice(0, 4)
        .map((l) => `${l.supplier}: ${l.item_code} ${l.days_late} day(s) late`)
        .join("; "),
    );
  if (sales.ok && sales.average > 0 && sales.yday < sales.average * 0.7)
    add(
      "sales",
      2,
      "Sales dropped yesterday",
      `${sales.yday} vs average ${sales.average} (${round((1 - sales.yday / sales.average) * 100, 0)}% lower).`,
      sales.average - sales.yday,
    );
  problems.sort((a, b) => b.severity - a.severity || b.impact - a.impact);
  const checks = { sales, inventory, finance, procurement };
  const unchecked = Object.entries(checks)
    .filter(([, s]) => !s.ok)
    .map(([area, s]) => ({ area, reason: s.error }));
  // No batch data means expiry was not checked, which is not the same as "nothing expiring".
  if (inventory.ok && !inventory.batches_tracked)
    unchecked.push({ area: "expiry", reason: "No batch-tracked stock was returned by ERP." });
  return {
    status: unchecked.length ? "partial" : "completed",
    result: {
      kind: "store_health_report",
      as_of: today,
      problems: problems.slice(0, 5),
      all_problems: problems.length,
      unchecked,
      snapshot: {
        sales_yesterday: sales.ok ? sales.yday : null,
        sales_average: sales.ok ? sales.average : null,
        low_stock: inventory.ok ? inventory.low.length : null,
        out_of_stock: inventory.ok ? inventory.out.length : null,
        udhaar: finance.ok ? finance.total : null,
        net_profit_7_days: finance.ok && finance.pnl ? finance.pnl.net_profit : null,
        late_deliveries: procurement.ok ? procurement.late.length : null,
      },
    },
  };
}

// ---- Reports (Grace): the owner's weekly or monthly business report ---------------------------------
const dayTotals = (invoices, from, to) => {
  const days = new Map();
  for (let day = from; day <= to; day = addDays(day, 1))
    days.set(day, { date: day, total: 0, transactions: 0 });
  for (const invoice of invoices) {
    const row = days.get(invoice.posting_date);
    if (!row) continue;
    row.total = round(row.total + Number(invoice.grand_total ?? 0));
    row.transactions += 1;
  }
  return [...days.values()];
};

/**
 * Sales for the period against the period just before it, posted profit, udhaar and stock, all
 * read under Grace's own identity. Anything she cannot read is listed, never estimated.
 */
async function businessReport(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const yesterday = addDays(today, -1);
  // Default: the last 7 complete days. A single named day is a one-day report.
  const from = intent.date ?? addDays(today, -7);
  const to = intent.to ?? (intent.date ? intent.date : yesterday);
  const length = daysBetween(from, to) + 1;
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(from, -length);
  const reports = await wf.step(
    workflowId,
    workforce,
    "reports",
    `Compile the business report for ${from} to ${to}`,
    async ({ call }) => {
      const notes = [];
      const sold = async (a, b) => {
        const [sales, pos] = await Promise.all([
          readSlices(call, "erp.sales_invoices.list", a, b, "invoices"),
          readSlices(call, "erp.pos_invoices.list", a, b, "invoices"),
        ]);
        return [...sales, ...pos];
      };
      const settle = (promise) =>
        promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      // Independent reads start together; each keeps its own error handling below.
      const priorRead = sold(priorFrom, priorTo).then(
        (rows) => ({ rows }),
        (error) => ({ error }),
      );
      const pnlRead = settle(call("erp.pnl", { from_date: from, to_date: to }));
      const udhaarRead = settle(call("erp.receivables.aging", { as_of: to }));
      const stockRead = settle(call("erp.stock.balance", {}));
      const [{ items }, invoices] = await Promise.all([call("erp.items.list", {}), sold(from, to)]);
      const totals = aggregateSales(invoices, items);
      let previous = null;
      try {
        const priorResult = await priorRead;
        if (priorResult.error) throw priorResult.error;
        const prior = aggregateSales(priorResult.rows, items);
        previous = {
          from_date: priorFrom,
          to_date: priorTo,
          total_sales: prior.total_sales,
          transaction_count: prior.transaction_count,
          change_pct: prior.total_sales
            ? round(((totals.total_sales - prior.total_sales) / prior.total_sales) * 100, 1)
            : null,
        };
      } catch (error) {
        notes.push(`The previous period could not be read: ${String(error.message).slice(0, 120)}`);
      }
      let profit = { status: "unverified" };
      try {
        const { value: pnl, error } = await pnlRead;
        if (error) throw error;
        profit = {
          status: "verified",
          net_profit: pnl.net_profit,
          income: pnl.income,
          expense: pnl.expense,
          source: "Profit and Loss report",
        };
      } catch (error) {
        profit = { status: "unverified", reason: String(error.message).slice(0, 160) };
      }
      let udhaar = { status: "unavailable" };
      try {
        const { value: data, error } = await udhaarRead;
        if (error) throw error;
        const aged = ageing(data.invoices ?? [], to);
        udhaar = {
          status: "available",
          total: aged.total,
          overdue: round(aged.total - aged.totals["Not due"]),
        };
      } catch (error) {
        notes.push(`Udhaar could not be read: ${String(error.message).slice(0, 120)}`);
      }
      let stock = { status: "unavailable" };
      try {
        const { value, error } = await stockRead;
        if (error) throw error;
        const { rows, low } = analyseStock(items, stockByItem(value.bins));
        stock = {
          status: "available",
          products: rows.length,
          low: low.length,
          out: rows.filter((r) => r.available <= 0).length,
          low_items: low.slice(0, 5).map((r) => r.item_name),
        };
      } catch (error) {
        notes.push(`Stock could not be read: ${String(error.message).slice(0, 120)}`);
      }
      return {
        totals,
        previous,
        profit,
        udhaar,
        stock,
        notes,
        by_day: dayTotals(invoices, from, to),
        summary: `${totals.transaction_count} bill(s), total ${totals.total_sales}.`,
      };
    },
  );
  const unavailable = [
    reports.profit.status !== "verified" ? "profit" : null,
    reports.udhaar.status !== "available" ? "udhaar" : null,
    reports.stock.status !== "available" ? "stock" : null,
    reports.previous ? null : "previous period",
  ].filter(Boolean);
  return {
    status: unavailable.length ? "partial" : "completed",
    result: {
      kind: "business_report",
      period: { from_date: from, to_date: to, days: length },
      sales: {
        total_sales: reports.totals.total_sales,
        transaction_count: reports.totals.transaction_count,
        average_bill: reports.totals.transaction_count
          ? round(reports.totals.total_sales / reports.totals.transaction_count)
          : 0,
        top_products: reports.totals.top_products,
        by_day: reports.by_day,
      },
      previous: reports.previous,
      profit: reports.profit,
      udhaar: reports.udhaar,
      stock: reports.stock,
      unavailable,
      notes: reports.notes,
    },
  };
}

// ---- Billing (Frank): the counter's bills ------------------------------------------------------
/**
 * Bills raised in the period: count, total, average, biggest, POS against invoice, named
 * customers against walk-ins, and returns. Read under Frank's own identity. The unpaid balance
 * comes from the receivables ledger, never from guessing at payment status.
 */
async function billingSummary(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const from = intent.date ?? today;
  const to = intent.to ?? from;
  const billing = await wf.step(
    workflowId,
    workforce,
    "billing",
    `Read the bills raised ${from === to ? `on ${from}` : `from ${from} to ${to}`}`,
    async ({ call }) => {
      const [invoices, pos] = await Promise.all([
        readSlices(call, "erp.sales_invoices.list", from, to, "invoices"),
        readSlices(call, "erp.pos_invoices.list", from, to, "invoices"),
      ]);
      const bills = [...invoices, ...pos];
      const notes = [];
      let unpaid = { status: "unavailable" };
      try {
        const data = await call("erp.receivables.aging", { as_of: to });
        const names = new Set(bills.map((b) => b.name));
        const open = (data.invoices ?? []).filter((row) => names.has(row.name));
        unpaid = {
          status: "available",
          bills: open.length,
          amount: round(open.reduce((t, r) => t + Number(r.outstanding_amount ?? 0), 0)),
        };
      } catch (error) {
        notes.push(`Unpaid balances could not be read: ${String(error.message).slice(0, 120)}`);
      }
      return { bills, unpaid, notes };
    },
  );
  const sales = billing.bills.filter((b) => !(b.is_return || Number(b.grand_total) < 0));
  const returned = billing.bills.filter((b) => b.is_return || Number(b.grand_total) < 0);
  const total = sum(sales, (b) => b.grand_total);
  const named = sales.filter((b) => b.customer && b.customer !== "Walk-in Customer");
  const biggest = [...sales].sort((a, b) => b.grand_total - a.grand_total)[0] ?? null;
  const units = sales.reduce(
    (t, b) => t + (b.items ?? []).reduce((n, line) => n + Number(line.qty ?? 0), 0),
    0,
  );
  return {
    status: billing.unpaid.status === "available" ? "completed" : "partial",
    result: {
      kind: "billing_summary",
      period: { from_date: from, to_date: to, days: daysBetween(from, to) + 1 },
      bills: sales.length,
      total,
      average_bill: sales.length ? round(total / sales.length) : 0,
      items_per_bill: sales.length ? round(units / sales.length, 1) : 0,
      biggest: biggest
        ? { name: biggest.name, customer: biggest.customer ?? null, amount: biggest.grand_total }
        : null,
      pos_bills: sales.filter((b) => b.is_pos).length,
      invoice_bills: sales.filter((b) => !b.is_pos).length,
      named_customer_bills: named.length,
      walk_in_bills: sales.length - named.length,
      returns: {
        count: returned.length,
        amount: round(Math.abs(sum(returned, (b) => b.grand_total))),
      },
      unpaid: billing.unpaid,
      notes: billing.notes,
    },
  };
}

// ---- Finance (Erin): payments and GST ---------------------------------------------------------
const monthStart = (day) => `${day.slice(0, 7)}-01`;
const periodLabel = (from, to) => (from === to ? `on ${from}` : `from ${from} to ${to}`);

/**
 * Payments received and paid in a period, from submitted Payment Entries. Read under Finance's own
 * identity (erp.payments.summary). With no date the period is the month so far.
 */
async function paymentsSummary(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const from = intent.date ?? monthStart(today);
  const to = intent.to ?? (intent.date ? intent.date : today);
  const { data } = await wf.step(
    workflowId,
    workforce,
    "finance",
    `Read payments received and paid ${periodLabel(from, to)}`,
    async ({ call }) => ({
      data: await call("erp.payments.summary", { from_date: from, to_date: to }),
    }),
  );
  const received = round(Number(data.received ?? 0));
  const paid = round(Number(data.paid ?? 0));
  return {
    status: "completed",
    result: {
      kind: "payments_summary",
      period: { from_date: from, to_date: to, days: daysBetween(from, to) + 1 },
      received,
      paid,
      net: round(received - paid),
      payments: Number(data.count ?? 0),
    },
  };
}

/**
 * GST position from the tax fields ERPNext holds on each submitted invoice line (HSN, taxable
 * value, CGST, SGST, IGST). Indicative, not a filing. Facts ERPNext did not return (party GSTIN,
 * place of supply) are listed as unavailable, never guessed.
 */
async function gstSummary(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const from = intent.date ?? monthStart(today);
  const to = intent.to ?? (intent.date ? intent.date : today);
  // wf.step spreads what its work returns, so the rows travel inside an object.
  const { lines } = await wf.step(
    workflowId,
    workforce,
    "finance",
    `Read GST lines ${periodLabel(from, to)}`,
    async ({ call }) => ({
      // One row per invoice line: a day at a time, four days in flight.
      lines: await readSlices(call, "erp.gst.summary", from, to, "lines", { days: 1, batch: 4 }),
    }),
  );
  const totals = (rows) => ({
    lines: rows.length,
    taxable_value: sum(rows, (l) => l.taxable_value),
    cgst: sum(rows, (l) => l.cgst),
    sgst: sum(rows, (l) => l.sgst),
    igst: sum(rows, (l) => l.igst),
    tax: sum(rows, (l) => Number(l.cgst) + Number(l.sgst) + Number(l.igst)),
    nil_rated_lines: rows.filter((l) => Number(l.gst_rate) === 0).length,
  });
  const outward = lines.filter((l) => l.direction === "outward");
  const inward = lines.filter((l) => l.direction === "inward");
  const slabs = [...new Set(outward.map((l) => Number(l.gst_rate)))]
    .sort((a, b) => a - b)
    .map((rate) => ({
      gst_rate: rate,
      ...totals(outward.filter((l) => Number(l.gst_rate) === rate)),
    }));
  const out = totals(outward);
  const inw = totals(inward);
  const notes = [];
  if (lines.length && lines.every((l) => !l.gstin))
    notes.push("Customer and supplier GSTIN were not available, so B2B and B2C are not split.");
  if (lines.length && lines.every((l) => !l.place_of_supply))
    notes.push("Place of supply was not available, so inter-state supply is not identified.");
  return {
    status: "completed",
    result: {
      kind: "gst_summary",
      period: { from_date: from, to_date: to, days: daysBetween(from, to) + 1 },
      indicative: true,
      outward: out,
      inward: inw,
      net_tax: round(out.tax - inw.tax),
      slabs,
      notes,
    },
  };
}

/** One purchase order, in any state (a draft included), read under Procurement's identity. */
async function purchaseOrderLookup(wf, workflowId, intent, workforce) {
  const name = intent.po_name;
  // wf.step spreads what its work returns, so the order (or its absence) travels inside an object.
  const { po } = await wf.step(
    workflowId,
    workforce,
    "procurement",
    `Read purchase order ${name}`,
    async ({ call }) => {
      try {
        return { po: (await call("erp.po.get", { name })).purchase_order };
      } catch (error) {
        if (/does ?not ?exist|not found/i.test(String(error.message))) return { po: null };
        throw error;
      }
    },
  );
  if (!po)
    return {
      status: "completed",
      result: { kind: "purchase_order_lookup", name, found: false },
    };
  const STATE = { 0: "draft", 1: "submitted", 2: "cancelled" };
  return {
    status: "completed",
    result: {
      kind: "purchase_order_lookup",
      name: po.name,
      found: true,
      supplier: po.supplier,
      state: STATE[po.docstatus] ?? "unknown",
      erp_status: po.status ?? null,
      transaction_date: po.transaction_date ?? null,
      schedule_date: po.schedule_date ?? null,
      lines: (po.items ?? []).length,
      total: round(Number(po.grand_total ?? 0)),
      items: (po.items ?? []).slice(0, 10).map((line) => ({
        item_code: line.item_code,
        qty: Number(line.qty),
        rate: Number(line.rate ?? 0),
        amount: Number(line.amount ?? 0),
        received_qty: Number(line.received_qty ?? 0),
      })),
    },
  };
}

// ---- Billing (Frank): a draft customer bill for the owner to approve -------------------------
const WALK_IN = "Walk-in Customer";
const norm = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Frank prepares a DRAFT bill. It confirms what it understood (product, quantity, customer) before
 * anything is created: an unclear product or a missing or odd quantity is asked, never guessed, and
 * rates always come from the live selling prices. The draft is not a bill until the owner approves
 * it with their PIN (see OwnerApprovals); nothing is posted to accounts or stock before that.
 */
async function prepareBill(wf, workflowId, intent, workforce) {
  const lines = intent.lines ?? [];
  if (!lines.length)
    return {
      status: "needs_clarification",
      clarifications: [{ requested: "the items", reason: "missing_items" }],
    };
  const noQuantity = lines.filter((line) => !(Number(line.quantity) > 0));
  if (noQuantity.length)
    return {
      status: "needs_clarification",
      clarifications: noQuantity.map((line) => ({
        requested: line.product,
        reason: "missing_quantity",
      })),
    };
  const prepared = await wf.step(
    workflowId,
    workforce,
    "billing",
    "Prepare a draft bill",
    async ({ call }) => {
      const [{ items }, { customers }] = await Promise.all([
        call("erp.items.list", {}),
        call("erp.customers.list", {}),
      ]);
      const asks = [];
      // Customer: the one named, else the walk-in customer; never a new one. Everyday slips
      // ("rohan" for "Rohan", "Laxshmi" for "Lakshmi") are tolerated, but ambiguity asks.
      let customer = WALK_IN;
      let defaulted = true;
      if (intent.customer) {
        defaulted = false;
        const near = matchCustomer(intent.customer, customers);
        if (near.length === 1) customer = near[0].name;
        else
          asks.push({
            requested: intent.customer,
            reason: near.length ? "ambiguous_customer" : "unknown_customer",
            options: near.map((row) => row.name).slice(0, 6),
          });
      } else if (!customers.some((row) => row.name === WALK_IN))
        asks.push({ requested: "the customer", reason: "unknown_customer", options: [] });
      // Products: each must be exactly one item; a category or a vague name asks which.
      // "kabuli chana handwash" is two products run together: split it into the items it names.
      const wanted = splitRunTogether(lines, items);
      const { resolved, clarifications } = resolveProducts(
        wanted.map((line) => line.product),
        items,
      );
      asks.push(...clarifications);
      const billLines = [];
      for (const line of wanted) {
        // A product that only appeared after the split has no quantity yet: ask, never assume.
        if (!(Number(line.quantity) > 0)) {
          asks.push({ requested: line.product, reason: "missing_quantity" });
          continue;
        }
        const matches = resolved.filter((row) => row.requested === line.product);
        if (matches.length > 1) {
          asks.push({
            requested: line.product,
            reason: "ambiguous",
            options: matches.map((row) => row.item.item_name),
          });
          continue;
        }
        if (matches.length !== 1) continue; // already asked by resolveProducts
        const item = matches[0].item;
        let qty = Number(line.quantity);
        let understood = `${qty} x ${item.item_name}`;
        // Only a weight or volume ("1 kg", "1 l") is converted to packs. Anything else the language
        // model passes as a unit ("packet", "piece", "box") just means "that many".
        const unit = String(line.unit ?? "").toLowerCase();
        if (isWeightOrVolume(unit)) {
          const said = Object.hasOwn(MASS, unit)
            ? { base: qty * MASS[unit], kind: "mass" }
            : { base: qty * VOLUME[unit], kind: "volume" };
          const pack = packSizeOf(item.item_name);
          const packs = pack && pack.kind === said.kind ? said.base / pack.base : null;
          if (!(packs > 0) || !Number.isInteger(packs)) {
            asks.push({
              requested: line.product,
              reason: "unit_mismatch",
              question: pack
                ? `${item.item_name} is sold in packs, so ${qty} ${line.unit} is not a whole number of packs. How many packs of ${item.item_name}?`
                : `How many units of ${item.item_name}? It is not sold by ${line.unit}.`,
            });
            continue;
          }
          understood = `${packs} x ${item.item_name} (you said ${qty} ${line.unit})`;
          qty = packs;
        }
        billLines.push({ item_code: item.item_code, item_name: item.item_name, qty, understood });
      }
      if (asks.length) return { clarifications: asks, summary: "The bill needs clarification." };
      // The same pending bill (same customer and lines) is reused, not drafted twice.
      const sameLines = (rows) =>
        JSON.stringify([...rows].map((row) => [row.item_code, Number(row.qty)]).sort());
      const duplicate = wf.approvals
        .list()
        .find(
          (row) =>
            row.kind === "sales_invoice" &&
            row.status === "pending" &&
            row.customer === customer &&
            sameLines(row.items) === sameLines(billLines),
        );
      if (duplicate)
        return {
          reused: duplicate.id,
          customer,
          defaulted,
          billLines,
          summary: "That bill is already waiting for approval.",
        };
      const created = await call("erp.sales_invoice.create_draft", {
        customer,
        posting_date: wf.today(),
        items: billLines.map((row) => ({ item_code: row.item_code, qty: row.qty })),
      });
      const confirmed = await call("erp.sales_invoice.get", { name: created.invoice.name });
      return {
        invoice: confirmed.invoice,
        customer,
        defaulted,
        billLines,
        summary: `Draft bill ${confirmed.invoice.name} for ${customer}, total ${confirmed.invoice.grand_total}.`,
      };
    },
  );
  if (prepared.clarifications)
    return { status: "needs_clarification", clarifications: prepared.clarifications };
  const approval = prepared.reused
    ? wf.approvals.get(prepared.reused)
    : wf.approvals.requestBill({ workflowId, invoice: prepared.invoice });
  if (!prepared.reused)
    wf.save(
      workflowId,
      {},
      {
        type: "BILL_DRAFT_CREATED",
        agent: "billing",
        detail: `${prepared.invoice.name} for ${prepared.customer}, total ${prepared.invoice.grand_total}; awaiting owner approval ${approval.id}`,
        document: prepared.invoice.name,
      },
    );
  const total = approval.total;
  const priced = new Map(
    (prepared.invoice?.items ?? approval.items).map((row) => [row.item_code, row]),
  );
  return {
    status: "awaiting_approval",
    result: {
      kind: "prepare_bill",
      bill: approval.erp_document_name,
      customer: prepared.customer,
      customer_defaulted: prepared.defaulted,
      lines: prepared.billLines.map((row) => {
        const price = priced.get(row.item_code);
        const rate = Number(price?.rate ?? 0);
        return {
          item_code: row.item_code,
          item_name: row.item_name ?? price?.item_name ?? row.item_code,
          qty: row.qty,
          rate,
          amount: round(rate * row.qty),
          understood: row.understood,
        };
      }),
      total,
      already_pending: Boolean(prepared.reused),
      approvals: [approval.id],
    },
  };
}

export const V2_RUNNERS = {
  prepare_bill: prepareBill,
  payments_summary: paymentsSummary,
  gst_summary: gstSummary,
  purchase_order_lookup: purchaseOrderLookup,
  receivables_report: receivablesReport,
  expiry_check: expiryCheck,
  purchase_status: purchaseStatus,
  supplier_performance: supplierPerformance,
  customer_insights: customerInsights,
  store_health_report: storeHealthReport,
  business_report: businessReport,
  billing_summary: billingSummary,
};

const inr = (v) => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** Numbers an optional model reply must reproduce exactly. */
export function keyFiguresV2(result) {
  switch (result.kind) {
    case "receivables_report":
      return {
        total_outstanding: result.total_outstanding,
        overdue_30_amount: result.overdue_over_30_days.amount,
      };
    case "expiry_check":
      return { batches_at_risk: result.items.length, value_at_risk: result.value_at_risk };
    case "purchase_status":
      return { open_orders: result.open_orders, delayed_lines: result.delayed.length };
    case "supplier_performance":
      return { suppliers_scored: result.suppliers.length, delaying: result.delaying.length };
    case "customer_insights":
      return {
        buying_customers: result.buying_customers,
        weekly_buyers: result.weekly_buyers.length,
      };
    case "store_health_report":
      return { problems: result.problems.length };
    case "billing_summary":
      return { bills: result.bills, total: result.total, returns: result.returns.count };
    case "prepare_bill":
      return { total: result.total, lines: result.lines.length };
    case "payments_summary":
      return { received: result.received, paid: result.paid, payments: result.payments };
    case "gst_summary":
      return {
        outward_tax: result.outward.tax,
        inward_tax: result.inward.tax,
        net_tax: result.net_tax,
      };
    case "purchase_order_lookup":
      return result.found ? { total: result.total, lines: result.lines } : { found: false };
    case "business_report":
      return {
        total_sales: result.sales.total_sales,
        transaction_count: result.sales.transaction_count,
        change_pct: result.previous?.change_pct ?? null,
        udhaar: result.udhaar.total ?? null,
      };
    default:
      return null;
  }
}

/** Deterministic owner-facing summary. */
export function summarizeV2(result) {
  switch (result.kind) {
    case "prepare_bill": {
      const what = result.lines
        .map((row) => `${row.qty} x ${row.item_name} at ${inr(row.rate)} = ${inr(row.amount)}`)
        .join("; ");
      return `${result.already_pending ? "This bill is already waiting: " : "I prepared a draft bill "}${result.bill} for ${result.customer}${result.customer_defaulted ? " (no customer was named, so Walk-in Customer)" : ""}: ${what}. Total ${inr(result.total)}. It is only a draft: nothing is billed, and stock and accounts are unchanged, until the owner approves it with their PIN. Please check the products and quantities.`;
    }
    case "payments_summary": {
      const { from_date: a, to_date: b } = result.period;
      return `Payments ${periodLabel(a, b)}: ${inr(result.received)} received and ${inr(result.paid)} paid out across ${result.payments} payment(s), net ${inr(result.net)}.`;
    }
    case "gst_summary": {
      const { from_date: a, to_date: b } = result.period;
      const o = result.outward;
      const i = result.inward;
      if (!o.lines && !i.lines) return `No GST lines were found ${periodLabel(a, b)}.`;
      const charged = o.tax
        ? `Output GST ${inr(o.tax)} on ${inr(o.taxable_value)} taxable value (CGST ${inr(o.cgst)}, SGST ${inr(o.sgst)}, IGST ${inr(o.igst)}).`
        : `No GST was charged on ${o.lines} outward line(s); ${o.nil_rated_lines} are nil-rated.`;
      const bought = i.tax
        ? `Input GST ${inr(i.tax)} on ${inr(i.taxable_value)} of purchases.`
        : `No GST was paid on ${i.lines} inward line(s).`;
      return `GST ${periodLabel(a, b)}: ${charged} ${bought} Net GST ${inr(result.net_tax)}. Indicative only, not a filing.`;
    }
    case "purchase_order_lookup": {
      if (!result.found) return `Purchase order ${result.name} was not found in ERPNext.`;
      const label =
        result.erp_status && result.erp_status.toLowerCase() !== result.state
          ? `${result.state} (ERPNext status ${result.erp_status})`
          : result.state;
      return `Purchase order ${result.name} for ${result.supplier} is ${label}: ${result.lines} line(s), total ${inr(result.total)}${result.schedule_date ? `, due ${result.schedule_date}` : ""}.`;
    }
    case "receivables_report": {
      const top = result.collection_priority
        .slice(0, 3)
        .map((c) => `${c.customer} ${inr(c.outstanding)} (${c.oldest_days_overdue} days)`);
      return `Udhaar pending ${inr(result.total_outstanding)}, ${inr(result.overdue)} overdue. ${result.overdue_over_30_days.customers} customer(s) have not paid for more than 30 days (${inr(result.overdue_over_30_days.amount)}).${top.length ? ` Collect first: ${top.join("; ")}.` : ""}${result.partial_payments ? ` ${result.partial_payments} invoice(s) are partly paid.` : ""}`;
    }
    case "expiry_check": {
      if (!result.batches_tracked) return result.note;
      const w = result.windows;
      const first = result.items
        .slice(0, 3)
        .map(
          (r) => `${r.item_name} ${r.qty} (${r.days_left < 0 ? "expired" : `${r.days_left} days`})`,
        );
      return `Expired ${w.expired.batches} batch(es) worth ${inr(w.expired.value)}; within 7 days ${w["7_days"].batches} (${inr(w["7_days"].value)}), 15 days ${w["15_days"].batches} (${inr(w["15_days"].value)}), 30 days ${w["30_days"].batches} (${inr(w["30_days"].value)}). Total at risk ${inr(result.value_at_risk)}.${first.length ? ` Act on: ${first.join("; ")}.` : ""}`;
    }
    case "purchase_status":
      return `${result.open_orders} open purchase order(s); ${result.delayed.length} line(s) late${
        result.delayed.length
          ? ` (${result.delayed
              .slice(0, 3)
              .map((l) => `${l.supplier}: ${l.item_name} ${l.days_late} days`)
              .join("; ")})`
          : ""
      }; ${result.partially_received} partly received. Supplier bills unpaid ${inr(result.payables.total)}, ${inr(result.payables.overdue)} overdue.`;
    case "supplier_performance":
      return result.delaying.length
        ? `${result.delaying.map((s) => `${s.supplier} is late on ${s.late_lines} line(s), up to ${s.max_days_late} day(s)${s.on_time_rate !== null ? `, on-time rate ${Math.round(s.on_time_rate * 100)}%` : ""}`).join("; ")}.`
        : `No late deliveries${result.products ? ` for ${result.products.join(", ")}` : ""} among ${result.suppliers.length} supplier(s).`;
    case "customer_insights":
      return `${result.buying_customers} named customer(s) bought in 12 weeks; ${result.weekly_buyers.length} buy every week${
        result.weekly_buyers.length
          ? ` (${result.weekly_buyers
              .slice(0, 4)
              .map((c) => c.customer)
              .join(", ")})`
          : ""
      }. Top customers: ${
        result.high_value
          .slice(0, 3)
          .map((c) => `${c.customer} ${inr(c.sales)}`)
          .join(", ") || "none"
      }. ${result.inactive_regulars.length} regular(s) inactive for 3+ weeks${
        result.inactive_regulars.length
          ? ` (${result.inactive_regulars
              .slice(0, 3)
              .map((c) => c.customer)
              .join(", ")})`
          : ""
      }. Returns: ${result.returns.count}.`;
    case "store_health_report":
      return result.problems.length
        ? `Top ${result.problems.length} problem(s): ${result.problems.map((p, i) => `${i + 1}. ${p.title} — ${p.detail}`).join(" ")}${result.unchecked.length ? ` Not checked: ${result.unchecked.map((u) => u.area).join(", ")}.` : ""}`
        : `No problems found in sales, stock, expiry, udhaar or deliveries.${result.unchecked.length ? ` Not checked: ${result.unchecked.map((u) => u.area).join(", ")}.` : ""}`;
    case "billing_summary": {
      const span =
        result.period.from_date === result.period.to_date
          ? result.period.from_date
          : `${result.period.from_date} to ${result.period.to_date}`;
      if (!result.bills && !result.returns.count) return `No bills were raised for ${span}.`;
      const parts = [
        `${result.bills} bill(s) for ${span}, total ${inr(result.total)}, average ${inr(result.average_bill)} with ${result.items_per_bill} item(s) a bill.`,
      ];
      if (result.biggest)
        parts.push(
          `Biggest bill ${result.biggest.name}${result.biggest.customer ? ` for ${result.biggest.customer}` : ""}: ${inr(result.biggest.amount)}.`,
        );
      parts.push(
        `${result.pos_bills} counter (POS) and ${result.invoice_bills} invoice bill(s); ${result.named_customer_bills} to named customers and ${result.walk_in_bills} walk-in.`,
      );
      if (result.returns.count)
        parts.push(`${result.returns.count} return(s) worth ${inr(result.returns.amount)}.`);
      parts.push(
        result.unpaid.status === "available"
          ? result.unpaid.bills
            ? `${result.unpaid.bills} of these bill(s) are still unpaid: ${inr(result.unpaid.amount)}.`
            : "All of these bills are paid."
          : "Whether they are paid could not be read.",
      );
      return parts.join(" ");
    }
    case "business_report": {
      const { period, sales, previous, profit, udhaar, stock } = result;
      const span =
        period.from_date === period.to_date
          ? period.from_date
          : `${period.from_date} to ${period.to_date}`;
      const parts = [
        `Report for ${span}: sales ${inr(sales.total_sales)} from ${sales.transaction_count} bill(s)${sales.transaction_count ? `, average ${inr(sales.average_bill)}` : ""}.`,
      ];
      if (previous)
        parts.push(
          previous.change_pct === null
            ? `The previous ${period.days} day(s) had no sales to compare with.`
            : `That is ${Math.abs(previous.change_pct)}% ${previous.change_pct >= 0 ? "up from" : "down from"} the previous ${period.days} day(s) (${inr(previous.total_sales)}).`,
        );
      if (sales.top_products?.length)
        parts.push(
          `Top sellers: ${sales.top_products
            .slice(0, 3)
            .map((p) => p.item_name ?? p.name ?? p.item)
            .join(", ")}.`,
        );
      parts.push(
        profit.status === "verified"
          ? `Posted profit ${inr(profit.net_profit)}.`
          : "Profit is not verified in the accounts, so I am not giving one.",
      );
      if (udhaar.status === "available")
        parts.push(`Udhaar pending ${inr(udhaar.total)}, ${inr(udhaar.overdue)} overdue.`);
      if (stock.status === "available")
        parts.push(`${stock.low} product(s) low and ${stock.out} out of stock.`);
      if (result.unavailable.length)
        parts.push(`Could not read: ${result.unavailable.join(", ")}.`);
      return parts.join(" ");
    }
    default:
      return null;
  }
}
