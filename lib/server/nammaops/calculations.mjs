/**
 * Deterministic NammaOps business calculations. Inputs are values returned by ERP tools; nothing
 * here invents data, and every function says what it could not determine.
 */

const round = (value) => Math.round(value * 100) / 100;
const norm = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const singular = (text) => text.replace(/(?:es|s)$/, "");

/**
 * Everyday words for a group of products that ERP may file under a broader item group (pulses sit
 * under Staples, for example). A match here selects the recorded items whose name contains one of
 * the listed words; it never invents a product.
 */
export const PRODUCT_GROUP_WORDS = Object.freeze({
  pulses: ["dal", "daal", "moong", "chana", "rajma", "urad", "toor", "masoor", "lentil"],
  pulse: ["dal", "daal", "moong", "chana", "rajma", "urad", "toor", "masoor", "lentil"],
  dal: ["dal", "daal"],
  daal: ["dal", "daal"],
  lentil: ["dal", "daal", "masoor", "lentil"],
});

/** Spellings shops use for the same word: transliteration varies (channa, chana; dhal, dal; tur, toor). */
const SPELLINGS = Object.freeze({
  dhal: "dal",
  daal: "dal",
  dall: "dal",
  tur: "toor",
  tuvar: "toor",
  thuvar: "toor",
  arhar: "toor",
  chhana: "chana",
  channa: "chana",
  chhole: "chole",
  mung: "moong",
  masur: "masoor",
  udad: "urad",
  ghi: "ghee",
  aata: "atta",
  rajmah: "rajma",
  kabli: "kabuli",
  kabuly: "kabuli",
});
/** One word in a common spelling, with doubled letters collapsed ("channa" -> "chana"). */
const foldWord = (word) => (SPELLINGS[word] ?? word).replace(/(.)\1+/g, "$1");
const fold = (text) => norm(text).split(" ").map(foldWord).join(" ");
/** True when two words differ by at most one letter (one slip in a long word). */
const withinOne = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};
/**
 * Items whose names match `wanted` once spelling variants are folded together, else once every
 * word of the request is within one letter of a word of the name (long words only). The caller
 * still treats several matches as ambiguous.
 */
function spellingMatches(wanted, items, labelsOf) {
  const target = fold(wanted);
  const direct = items.filter((item) =>
    labelsOf(item).some((label) => {
      const folded = fold(label);
      return folded === target || folded.split(" ").includes(target) || folded.includes(target);
    }),
  );
  if (direct.length) return direct;
  const words = target.split(" ");
  return items.filter((item) =>
    labelsOf(item).some((label) => {
      const labelWords = fold(label).split(" ");
      return words.every((word) =>
        labelWords.some(
          (other) =>
            other === word || (word.length >= 5 && other.length >= 5 && withinOne(word, other)),
        ),
      );
    }),
  );
}

/** ERP item group -> item names, as recorded. Items without a group are listed as "Other". */
export function catalogue(items) {
  const groups = {};
  for (const item of items) (groups[item.item_group || "Other"] ??= []).push(item.item_name);
  return groups;
}

/**
 * Customer named in a bill request -> the recorded customer rows, tolerating everyday slips
 * ("rohan" for "Rohan", "Laxshmi Stores" for "Lakshmi Stores"). Exact name wins (folded), then
 * the same tolerant match the products use, and finally a single slip across the whole name
 * (so the short "Rohan" still answers "rohn"). Empty when nothing is close enough.
 * @param {string} name @param {Array<{ name: string }>} customers
 */
export function matchCustomer(name, customers) {
  const target = fold(name);
  if (!target) return [];
  const exact = customers.filter((row) => fold(row.name) === target);
  if (exact.length) return exact;
  const near = spellingMatches(target, customers, (row) => [row.name]);
  if (near.length) return near;
  // A customer name is often just one word, so the word-level rule (5+ letters) is too strict.
  return target.length >= 4 ? customers.filter((row) => withinOne(fold(row.name), target)) : [];
}

/**
 * Resolve spoken product names to ERP items. A category (ERP item group) name selects every item
 * in it. Otherwise exact name, code or alias wins, then a unique partial match. Several
 * candidates means the owner must clarify; none means unknown, and the clarification carries the
 * recorded categories so the speaker can offer real alternatives instead of guessing.
 */
export function resolveProducts(names, items) {
  const resolved = [];
  const clarifications = [];
  for (const raw of names) {
    const wanted = norm(raw);
    if (!wanted) continue;
    const inGroup = items.filter(
      (item) => item.item_group && singular(norm(item.item_group)) === singular(wanted),
    );
    if (inGroup.length) {
      for (const item of inGroup) resolved.push({ requested: raw, item });
      continue;
    }
    const wordsFor = PRODUCT_GROUP_WORDS[wanted] ?? PRODUCT_GROUP_WORDS[singular(wanted)];
    if (wordsFor) {
      const hits = items.filter((item) =>
        norm(item.item_name)
          .split(" ")
          .some((word) => wordsFor.includes(word)),
      );
      if (hits.length) {
        for (const item of hits) resolved.push({ requested: raw, item });
        continue;
      }
    }
    const labels = (item) => [item.item_name, item.item_code, ...(item.aliases ?? [])].map(norm);
    const exact = items.filter((item) => labels(item).includes(wanted));
    const found = exact.length
      ? exact
      : items.filter((item) =>
          labels(item).some((label) => label.split(" ").includes(wanted) || label.includes(wanted)),
        );
    // Only when nothing matched as typed: tolerate the spelling variants and slips of real shops
    // ("kabuli channa" for "Kabuli Chana"). It never overrides an exact or partial match.
    const partial = found.length ? found : spellingMatches(wanted, items, labels);
    if (partial.length === 1) resolved.push({ requested: raw, item: partial[0] });
    else
      clarifications.push({
        requested: raw,
        reason: partial.length ? "ambiguous" : "unknown",
        options: partial.map((item) => item.item_name),
        ...(partial.length ? {} : { categories: catalogue(items) }),
      });
  }
  return { resolved, clarifications };
}

/** Total quantity per item across warehouses, from stock balance rows. */
export function stockByItem(bins) {
  const totals = new Map();
  for (const bin of bins) {
    const row = totals.get(bin.item_code) ?? { qty: 0, warehouses: [] };
    row.qty = round(row.qty + Number(bin.actual_qty ?? 0));
    row.warehouses.push({ warehouse: bin.warehouse, qty: Number(bin.actual_qty ?? 0) });
    totals.set(bin.item_code, row);
  }
  return totals;
}

/**
 * Low stock is `available <= reorder_level`. Recommended quantity brings stock back above the
 * reorder level and is at least the item's reorder quantity.
 */
export function analyseStock(items, stock) {
  const rows = items.map((item) => {
    const level = Number(item.reorder_level);
    const known = Number.isFinite(level) && level > 0;
    const available = stock.get(item.item_code)?.qty ?? 0;
    const low = known && available <= level;
    const shortage = known ? Math.max(0, round(level - available)) : null;
    // The quantity rule is unchanged; these fields only expose its inputs so a recommendation can
    // show its working. The target is the stock the refill aims at (twice the reorder level).
    const reorderQty = Number(item.reorder_qty) || 0;
    const refill = known ? round(level * 2 - available) : 0;
    return {
      item_code: item.item_code,
      item_name: item.item_name,
      item_group: item.item_group ?? null,
      uom: item.stock_uom ?? null,
      available,
      reorder_level: known ? level : null,
      status: !known ? "no_reorder_level" : low ? "low" : "ok",
      shortage,
      recommended_qty: low ? Math.max(reorderQty, refill) : 0,
      target_stock: known ? level * 2 : null,
      reorder_qty: reorderQty,
      refill_qty: low ? refill : null,
      quantity_basis: low ? (reorderQty >= refill ? "reorder_quantity" : "refill_to_target") : null,
      warehouses: stock.get(item.item_code)?.warehouses ?? [],
    };
  });
  return { rows, low: rows.filter((row) => row.status === "low") };
}

/**
 * Rank supplier quotations for one item. Quotes that cannot cover the quantity, or are expired,
 * are not suitable. Among suitable quotes: lowest rate, then shortest lead time, then reliability.
 * Missing facts are listed, never assumed.
 */
export function rankSuppliers(itemCode, qty, quotations, suppliers, today) {
  const considered = quotations
    .filter((row) => row.item_code === itemCode)
    .map((row) => {
      const supplier = suppliers.find((item) => item.name === row.supplier) ?? {};
      const missing = [];
      const lead = row.lead_time_days ?? supplier.lead_time_days;
      if (row.available_qty === undefined) missing.push("availability");
      if (lead === undefined) missing.push("lead time");
      if (supplier.on_time_rate === undefined) missing.push("delivery reliability");
      const reasons = [];
      if (row.available_qty !== undefined && row.available_qty < qty)
        reasons.push(`only ${row.available_qty} available`);
      if (row.valid_till && today && row.valid_till < today) reasons.push("quotation expired");
      return {
        supplier: row.supplier,
        quotation: row.name,
        rate: Number(row.rate),
        available_qty: row.available_qty ?? null,
        lead_time_days: lead ?? null,
        on_time_rate: supplier.on_time_rate ?? null,
        suitable: reasons.length === 0,
        not_suitable_because: reasons,
        missing,
      };
    });
  const suitable = considered
    .filter((row) => row.suitable)
    .sort(
      (a, b) =>
        a.rate - b.rate ||
        (a.lead_time_days ?? 99) - (b.lead_time_days ?? 99) ||
        (b.on_time_rate ?? 0) - (a.on_time_rate ?? 0),
    );
  return {
    item_code: itemCode,
    qty,
    choice: suitable[0] ?? null,
    considered,
    criteria:
      "Suitable = can supply the quantity and quotation still valid; then lowest rate, shortest lead time, best on-time rate.",
    blocker: considered.length
      ? suitable.length
        ? null
        : "No supplier quotation can cover this quantity."
      : "No supplier quotation for this item.",
  };
}

/** Group chosen supplier lines into one draft purchase order per supplier. */
export function groupOrders(rankings) {
  const orders = new Map();
  for (const ranking of rankings) {
    if (!ranking.choice) continue;
    const order = orders.get(ranking.choice.supplier) ?? {
      supplier: ranking.choice.supplier,
      items: [],
    };
    order.items.push({ item_code: ranking.item_code, qty: ranking.qty, rate: ranking.choice.rate });
    orders.set(ranking.choice.supplier, order);
  }
  return [...orders.values()].map((order) => ({
    ...order,
    expected_total: round(order.items.reduce((sum, row) => sum + row.qty * row.rate, 0)),
  }));
}

/** Sales totals and top products from submitted invoices. */
export function aggregateSales(invoices, items = []) {
  const names = new Map(items.map((item) => [item.item_code, item.item_name]));
  const products = new Map();
  for (const invoice of invoices)
    for (const line of invoice.items ?? []) {
      const row = products.get(line.item_code) ?? { item_code: line.item_code, qty: 0, amount: 0 };
      row.qty = round(row.qty + Number(line.qty ?? 0));
      row.amount = round(row.amount + Number(line.amount ?? 0));
      products.set(line.item_code, row);
    }
  return {
    total_sales: round(
      invoices.reduce((sum, invoice) => sum + Number(invoice.grand_total ?? 0), 0),
    ),
    transaction_count: invoices.length,
    top_products: [...products.values()]
      .sort((a, b) => b.amount - a.amount || b.qty - a.qty)
      .slice(0, 5)
      .map((row) => ({ ...row, item_name: names.get(row.item_code) ?? row.item_code })),
    invoice_refs: invoices.map((invoice) => invoice.name),
  };
}

/** A stable fingerprint input for an exact purchase order. */
/**
 * The exact draft bill an owner approval is bound to: who it is for, what is on it at what rate,
 * the total, and that it updates stock. Any change to these voids the approval.
 */
export function invoiceSnapshot(invoice) {
  return {
    name: invoice.name,
    customer: invoice.customer,
    docstatus: invoice.docstatus,
    update_stock: Number(invoice.update_stock ?? 0),
    grand_total: round(Number(invoice.grand_total)),
    items: (invoice.items ?? [])
      .map((row) => ({
        item_code: row.item_code,
        qty: Number(row.qty),
        rate: round(Number(row.rate)),
      }))
      .sort((a, b) => a.item_code.localeCompare(b.item_code)),
  };
}

export function orderSnapshot(po) {
  return {
    name: po.name,
    supplier: po.supplier,
    docstatus: po.docstatus,
    grand_total: round(Number(po.grand_total)),
    items: (po.items ?? [])
      .map((row) => ({
        item_code: row.item_code,
        qty: Number(row.qty),
        rate: round(Number(row.rate)),
      }))
      .sort((a, b) => a.item_code.localeCompare(b.item_code)),
  };
}
