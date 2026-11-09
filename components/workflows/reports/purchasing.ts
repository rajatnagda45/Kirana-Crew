/**
 * Report builders for dues and purchasing: receivables_report, purchase_status,
 * supplier_comparison, supplier_performance, store_health_report.
 */
import {
  count,
  day,
  days,
  formatPeriod,
  humanize,
  money,
  percent,
  qty,
  statusCell,
  text,
  toNumber,
} from "./format";
import {
  explain,
  left,
  metric,
  nameCell,
  notice,
  rec,
  recs,
  right,
  str,
  strings,
  table,
  type Builder,
} from "./helpers";
import type { Cell, Notice, Row, Section } from "./types";

// ── Udhaar (receivables) ───────────────────────────────────────────────────

const BUCKETS: Array<[string, string]> = [
  ["Not due", "Not yet due"],
  ["0-30", "Up to 30 days overdue"],
  ["31-60", "31 to 60 days overdue"],
  ["61-90", "61 to 90 days overdue"],
  ["90+", "More than 90 days overdue"],
];

export const receivablesReport: Builder = ({ result }) => {
  const buckets = rec(result.buckets);
  const over30 = rec(result.overdue_over_30_days);
  const priority = recs(result.collection_priority);
  const notices: Notice[] = [];
  if (
    priority.length &&
    priority.every((c) => c.credit_limit === null || c.credit_limit === undefined)
  )
    notices.push(
      notice(
        "info",
        "unavailable",
        "Credit limits are not available from ERPNext, so customers over their limit were not checked.",
      ),
    );

  const sections: Section[] = [
    table(
      "buckets",
      "How old the dues are",
      [left("age", "Age"), right("amount", "Amount owed")],
      BUCKETS.map(([key, label]) => ({ age: text(label), amount: money(buckets[key]) })),
    ),
    table(
      "collect",
      "Collect first",
      [
        left("customer", "Customer"),
        right("owes", "Owes"),
        right("oldest", "Oldest due"),
        right("partly", "Partly paid bills"),
        right("bills", "Unpaid bills"),
      ],
      priority.map((c) => ({
        customer: nameCell(c.customer),
        owes: money(c.outstanding),
        oldest: days(c.oldest_days_overdue),
        partly: count(c.partially_paid),
        bills: count(c.invoices),
      })),
      {
        intro: "Ordered by how much is owed and for how long.",
        empty: "No customer has an overdue balance.",
      },
    ),
  ];

  return {
    period: formatPeriod(result.as_of),
    notices,
    metrics: [
      metric("Total owed to you", money(result.total_outstanding)),
      metric("Overdue", money(result.overdue)),
      metric(
        "Overdue for more than 30 days",
        money(over30.amount),
        `${count(over30.customers).display} customer${toNumber(over30.customers) === 1 ? "" : "s"}`,
      ),
      metric("Partly paid bills", count(result.partial_payments)),
    ],
    sections,
    recommendations: priority
      .slice(0, 3)
      .map(
        (c) =>
          `Collect from ${str(c.customer) ?? "this customer"}: ${money(c.outstanding).display} owed, oldest due ${days(c.oldest_days_overdue).display} ago.`,
      ),
  };
};

// ── Purchase status ────────────────────────────────────────────────────────

export const purchaseStatus: Builder = ({ result }) => {
  const delayed = recs(result.delayed);
  const lines = recs(result.lines);
  const payables = rec(result.payables);
  const bills = recs(payables.bills);
  const lineRow = (l: Record<string, unknown>): Row => ({
    order: text(l.purchase_order),
    supplier: nameCell(l.supplier),
    item: nameCell(l.item_name, l.item_code),
    ordered: qty(l.ordered_qty),
    received: qty(l.received_qty),
    pending: qty(l.pending_qty),
    expected: day(l.expected),
    late: days(l.days_late),
  });

  const sections: Section[] = [
    delayed.length
      ? table(
          "late",
          "Late deliveries",
          [
            left("order", "Order"),
            left("supplier", "Supplier"),
            left("item", "Product"),
            right("pending", "Still to arrive"),
            left("expected", "Was due"),
            right("late", "Late by"),
          ],
          delayed.map(lineRow),
        )
      : {
          kind: "note",
          id: "on-time",
          text: "No open order line is past its due date.",
          tone: "good",
        },
    table(
      "open",
      "Open purchase order lines",
      [
        left("order", "Order"),
        left("supplier", "Supplier"),
        left("item", "Product"),
        right("ordered", "Ordered"),
        right("received", "Received"),
        right("pending", "Pending"),
        left("expected", "Due"),
      ],
      lines.map(lineRow),
      { empty: "There are no open purchase orders." },
    ),
    table(
      "bills",
      "Unpaid supplier bills",
      [
        left("bill", "Bill"),
        left("supplier", "Supplier"),
        left("due", "Due date"),
        right("owed", "Amount owed"),
        right("late", "Overdue by"),
      ],
      bills.map((b) => ({
        bill: text(b.bill),
        supplier: nameCell(b.supplier),
        due: day(b.due_date),
        owed: money(b.outstanding),
        late: days(b.days_overdue),
      })),
      { empty: "There are no unpaid supplier bills." },
    ),
  ];

  return {
    period: formatPeriod(result.as_of),
    metrics: [
      metric("Open purchase orders", count(result.open_orders)),
      {
        label: "Late lines",
        value: { ...count(delayed.length), tone: delayed.length ? "warn" : "good" },
      },
      metric("Partly received", count(result.partially_received)),
      metric(
        "Unpaid supplier bills",
        money(payables.total),
        `${money(payables.overdue).display} overdue`,
      ),
    ],
    sections,
    recommendations: delayed
      .slice(0, 5)
      .map(
        (l) =>
          `Ask ${str(l.supplier) ?? "the supplier"} about ${str(l.item_name) ?? str(l.item_code) ?? "the order"}: ${days(l.days_late).display} late.`,
      ),
  };
};

// ── Supplier comparison ────────────────────────────────────────────────────

const BASIS: Record<string, string> = {
  requested: "the quantity you asked for",
  reorder_quantity: "the product's usual reorder quantity",
  one_unit: "1 unit (no quantity was given)",
};

export const supplierComparison: Builder = ({ result }) => {
  const items = recs(result.items);
  const notices: Notice[] = [];
  const unknown = new Set<string>();
  const best: Row[] = [];
  const all: Row[] = [];
  const reasons: string[] = [];

  for (const item of items) {
    const name = str(item.item_name) ?? str(item.item_code);
    const choice = rec(item.choice);
    const basis = BASIS[String(item.qty_basis)];
    if (str(choice.supplier)) {
      best.push({
        product: nameCell(name),
        qty: qty(item.qty),
        supplier: text(choice.supplier),
        price: money(choice.rate),
        lead: days(choice.lead_time_days),
        list: money(item.list_price),
      });
      strings(choice.missing).forEach((m) => unknown.add(m));
    } else {
      notices.push(
        notice(
          "warn",
          "unavailable",
          `No suitable supplier was found for ${name ?? "a product"}.`,
          str(item.blocker),
        ),
      );
      best.push({
        product: nameCell(name),
        qty: qty(item.qty),
        supplier: text("None suitable"),
        price: text(null),
        lead: text(null),
        list: money(item.list_price),
      });
    }
    if (basis) reasons.push(`${name ?? "Product"}: compared for ${basis}.`);
    for (const q of recs(item.considered)) {
      all.push({
        product: nameCell(name),
        supplier: nameCell(q.supplier),
        quote: text(q.quotation),
        price: money(q.rate),
        lead: days(q.lead_time_days),
        suitable:
          q.suitable === true
            ? statusCell("Yes", "good")
            : statusCell(strings(q.not_suitable_because).join("; ") || "No", "warn"),
      });
      strings(q.missing).forEach((m) => unknown.add(m));
    }
  }
  if (unknown.size)
    notices.push(
      notice(
        "info",
        "unavailable",
        `Not known for some quotations: ${[...unknown].join(", ")}. The ranking did not use them.`,
      ),
    );

  const criteria = [...new Set(items.map((i) => str(i.criteria)).filter(Boolean))] as string[];
  return {
    period: formatPeriod(result.as_of),
    notices,
    metrics: [metric("Products compared", count(items.length))],
    sections: [
      table(
        "best",
        "Best supplier for each product",
        [
          left("product", "Product"),
          right("qty", "Quantity"),
          left("supplier", "Supplier"),
          right("price", "Quoted price"),
          right("lead", "Lead time"),
          right("list", "Buying list price"),
        ],
        best,
        { empty: "No products were compared." },
      ),
      ...(criteria.length || reasons.length
        ? ([
            {
              kind: "list",
              id: "why",
              title: "How they were ranked",
              items: [...criteria, ...reasons].map((t) => ({ text: t })),
            },
          ] as Section[])
        : []),
      table(
        "considered",
        "All quotations considered",
        [
          left("product", "Product"),
          left("supplier", "Supplier"),
          left("quote", "Quotation"),
          right("price", "Price"),
          right("lead", "Lead time"),
          left("suitable", "Suitable?"),
        ],
        all,
      ),
    ],
    recommendations: best
      .filter((r) => r.supplier.value !== "None suitable")
      .map((r) => `Buy ${r.product.display} from ${r.supplier.display} at ${r.price.display}.`),
  };
};

// ── Supplier performance ───────────────────────────────────────────────────

export const supplierPerformance: Builder = ({ result }) => {
  const suppliers = recs(result.suppliers);
  const delaying = recs(result.delaying);
  const rateOf = (s: Record<string, unknown>): Cell => {
    const r = toNumber(s.on_time_rate);
    return r === null ? percent(null) : percent(Math.round(r * 1000) / 10); // server sends 0 to 1
  };
  const notices: Notice[] = [];
  if (suppliers.length && suppliers.every((s) => toNumber(s.on_time_rate) === null))
    notices.push(
      notice("info", "unavailable", "On-time rate is not available for these suppliers."),
    );
  if (suppliers.length && suppliers.every((s) => toNumber(s.quoted_lead_time_days) === null))
    notices.push(
      notice("info", "unavailable", "Quoted lead times are not available for these suppliers."),
    );
  if (suppliers.length && suppliers.every((s) => toNumber(s.price_variance_pct) === null))
    notices.push(
      notice(
        "info",
        "unavailable",
        "Invoiced-versus-quoted price could not be compared for these suppliers.",
      ),
    );

  const sections: Section[] = [
    table(
      "suppliers",
      "Suppliers",
      [
        left("supplier", "Supplier"),
        right("late", "Late lines"),
        right("worst", "Longest delay"),
        right("ontime", "On time"),
        right("lead", "Quoted lead time"),
        right("price", "Invoiced vs quoted price"),
        right("owed", "Amount owed"),
      ],
      suppliers.map((s) => ({
        supplier: nameCell(s.supplier),
        late: count(s.late_lines),
        worst: days(s.max_days_late),
        ontime: rateOf(s),
        lead: days(s.quoted_lead_time_days),
        price: percent(s.price_variance_pct),
        owed: money(s.outstanding),
      })),
      { empty: "No suppliers matched." },
    ),
  ];
  if (str(result.price_basis))
    sections.push({ kind: "note", id: "basis", text: str(result.price_basis) as string });

  return {
    period: formatPeriod(result.as_of),
    notices,
    metrics: [
      metric("Suppliers reviewed", count(suppliers.length)),
      {
        label: "Delaying deliveries",
        value: { ...count(delaying.length), tone: delaying.length ? "warn" : "good" },
      },
    ],
    sections,
    recommendations: delaying.map(
      (s) =>
        `${str(s.supplier) ?? "A supplier"} is late on ${count(s.late_lines).display} line${toNumber(s.late_lines) === 1 ? "" : "s"}, up to ${days(s.max_days_late).display}. Ask when it will arrive.`,
    ),
  };
};

// ── Store health ───────────────────────────────────────────────────────────

const SEVERITY: Record<number, string> = { 3: "High", 2: "Medium", 1: "Low" };

/** A pointer to the report to open next, chosen by the kind of problem. No figures are added. */
function nextStep(title: string): string | null {
  if (/udhaar/i.test(title)) return "Open the Udhaar Report and start with the oldest dues.";
  if (/out of stock/i.test(title))
    return "Open Stock Check and reorder the out-of-stock products first.";
  if (/reorder level/i.test(title)) return "Open Stock Check to see what to buy.";
  if (/sales dropped/i.test(title)) return "Open the Daily Report to see what changed.";
  if (/late supplier/i.test(title)) return "Open Purchase Status and follow up with the suppliers.";
  if (/expired|expiring/i.test(title))
    return "Open Expiry Check and deal with the oldest batches first.";
  if (/credit limit/i.test(title)) return "Open the Udhaar Report and review those customers.";
  if (/profit/i.test(title)) return "Open the Business Report and review expenses.";
  return null;
}

export const storeHealthReport: Builder = ({ result }) => {
  const problems = recs(result.problems);
  const unchecked = recs(result.unchecked);
  const snapshot = rec(result.snapshot);
  const total = toNumber(result.all_problems);
  const notices: Notice[] = unchecked.map((u) => {
    const why = explain(str(u.reason));
    return notice(
      "warn",
      "unchecked",
      `${humanize(str(u.area) ?? "An area")} was not checked. ${why.text}`,
      why.detail,
    );
  });
  if (snapshot.net_profit_7_days === null)
    notices.push(
      notice(
        "info",
        "unavailable",
        "Profit for the last 7 days could not be read, so it was not part of this check.",
      ),
    );

  const sections: Section[] = [];
  if (problems.length)
    sections.push({
      kind: "list",
      id: "problems",
      title: `The ${problems.length === 1 ? "problem" : `${problems.length} biggest problems`} today`,
      items: problems.map((p) => {
        const impact = toNumber(p.impact);
        const sev = SEVERITY[Number(p.severity)];
        return {
          text: `${sev ? `${sev}: ` : ""}${str(p.title) ?? "Problem"}`,
          detail: [str(p.detail), impact ? `About ${money(impact).display} affected.` : undefined]
            .filter(Boolean)
            .join(" "),
          tone: Number(p.severity) >= 3 ? ("bad" as const) : ("warn" as const),
        };
      }),
    });
  else
    sections.push({
      kind: "note",
      id: "none",
      tone: unchecked.length ? undefined : "good",
      text: unchecked.length
        ? `No problems were found in the areas that were checked. Not checked: ${unchecked.map((u) => humanize(str(u.area) ?? "area").toLowerCase()).join(", ")}.`
        : "No problems were found in the areas checked: sales, stock, udhaar, deliveries and profit.",
    });
  if (total !== null && total > problems.length)
    sections.push({
      kind: "note",
      id: "more",
      text: `Showing the top ${problems.length} of ${total} problems found.`,
    });

  return {
    period: formatPeriod(result.as_of),
    notices,
    metrics: [
      metric(
        "Sales yesterday",
        money(snapshot.sales_yesterday),
        `Average of the 6 days before: ${money(snapshot.sales_average).display}`,
      ),
      metric("Udhaar pending", money(snapshot.udhaar)),
      metric("Profit, last 7 days", money(snapshot.net_profit_7_days)),
      metric("Products running low", count(snapshot.low_stock)),
      metric("Products out of stock", count(snapshot.out_of_stock)),
      metric("Late supplier deliveries", count(snapshot.late_deliveries)),
    ],
    sections,
    recommendations: problems.flatMap((p) => {
      const step = nextStep(str(p.title) ?? "");
      return step ? [`${str(p.title)}: ${step}`] : [];
    }),
  };
};
