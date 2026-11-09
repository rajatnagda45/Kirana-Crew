/** Report builders for the sales workflows: daily_report, business_report, billing_summary, customer_insights. */
import {
  count,
  day,
  days,
  formatPeriod,
  humanize,
  money,
  percent,
  qty,
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

const topProductsTable = (id: string, rows: Array<Record<string, unknown>>) =>
  table(
    id,
    "Top-selling products",
    [left("product", "Product"), right("qty", "Units sold"), right("amount", "Sales amount")],
    rows.map((row) => ({
      product: nameCell(row.item_name, row.item_code),
      qty: qty(row.qty),
      amount: money(row.amount),
    })),
    { intro: "Ranked by sales amount.", empty: "No product sales were recorded." },
  );

const byDayTable = (rows: Array<Record<string, unknown>>) =>
  table(
    "by-day",
    "Sales by day",
    [left("date", "Date"), right("total", "Sales"), right("bills", "Bills")],
    rows.map((row) => ({
      date: day(row.date),
      total: money(row.total),
      bills: count(row.transactions),
    })),
    { limit: 31 },
  );

/** Profit cell: a verified figure, or an honest "not available" with the reason. */
function profitCell(profit: Record<string, unknown>): { cell: Cell; hint?: string } {
  if (profit.status === "verified") {
    const net = toNumber(profit.net_profit);
    const cell = money(net);
    return {
      cell: net !== null && net < 0 ? { ...cell, tone: "bad" } : cell,
      hint: "From posted accounting entries",
    };
  }
  if (profit.status === "not_requested") return { cell: text("Not requested") };
  return { cell: money(null), hint: explain(str(profit.reason)).text };
}

// ── Daily report ───────────────────────────────────────────────────────────

export const dailyReport: Builder = ({ result }) => {
  const period = rec(result.period);
  const profit = rec(result.profit);
  const sales = toNumber(result.total_sales);
  const bills = toNumber(result.transaction_count);
  const notices: Notice[] = strings(result.warnings).map((w) => notice("warn", "warning", w));
  const { cell, hint } = profitCell(profit);
  if (profit.status === "unverified") {
    const why = explain(str(profit.reason));
    notices.push(
      notice("warn", "unavailable", `Profit is not available. ${why.text}`, str(profit.reason)),
    );
  }

  const sections: Section[] = [];
  if (sales === 0 && bills === 0)
    sections.push({
      kind: "note",
      id: "no-sales",
      text: "No submitted sales were recorded for this period.",
    });
  else sections.push(topProductsTable("top", recs(result.top_products)));
  if (Array.isArray(result.by_day)) sections.push(byDayTable(recs(result.by_day)));

  const income = profit.status === "verified" ? money(profit.income) : null;
  const expense = profit.status === "verified" ? money(profit.expense) : null;
  return {
    period: formatPeriod(period.from_date, period.to_date),
    notices,
    metrics: [
      metric("Total recorded sales", money(result.total_sales)),
      metric("Transactions", count(result.transaction_count)),
      metric("Profit or loss", cell, hint),
      ...(income ? [metric("Income (posted)", income)] : []),
      ...(expense ? [metric("Expenses (posted)", expense)] : []),
    ],
    sections,
  };
};

// ── Business report ────────────────────────────────────────────────────────

/** Strings, or {area, reason} objects, from a server list of things that could not be read. */
function unavailableNotices(value: unknown): Notice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [notice("warn", "unavailable", entry)];
    const r = rec(entry);
    const what = str(r.area) ?? str(r.name) ?? str(r.what);
    const why = str(r.reason) ?? str(r.error);
    if (!what && !why) return [];
    const plain = explain(why);
    return [
      notice(
        "warn",
        "unavailable",
        `${what ? `${humanize(what)}: ` : ""}${plain.text}`,
        plain.detail,
      ),
    ];
  });
}

export const businessReport: Builder = ({ result }) => {
  const period = rec(result.period);
  const sales = rec(result.sales);
  const previous = rec(result.previous);
  const profit = rec(result.profit);
  const udhaar = rec(result.udhaar);
  const stock = rec(result.stock);
  const hasPrevious = Object.keys(previous).length > 0;
  const change = toNumber(previous.change_pct);
  const { cell, hint } = profitCell(profit);
  const notices: Notice[] = [
    ...unavailableNotices(result.unavailable),
    ...strings(result.notes).map((n) => notice("warn", "warning", n)),
  ];
  if (!hasPrevious)
    notices.push(
      notice(
        "info",
        "unavailable",
        "The previous period could not be read, so no comparison is shown.",
      ),
    );
  if (profit.status === "unverified")
    notices.push(
      notice(
        "warn",
        "unavailable",
        `Profit is not available. ${explain(str(profit.reason)).text}`,
        str(profit.reason),
      ),
    );

  const sections: Section[] = [topProductsTable("top", recs(sales.top_products))];
  if (Array.isArray(sales.by_day)) sections.push(byDayTable(recs(sales.by_day)));
  const lowItems = strings(stock.low_items);
  if (lowItems.length)
    sections.push({
      kind: "list",
      id: "low-items",
      title: "Products running low",
      items: lowItems.map((name) => ({ text: name })),
    });

  return {
    period: formatPeriod(period.from_date, period.to_date),
    notices,
    metrics: [
      metric("Total sales", money(sales.total_sales)),
      metric("Bills", count(sales.transaction_count)),
      metric("Average bill", money(sales.average_bill)),
      ...(hasPrevious
        ? [
            metric(
              "Compared with the previous period",
              change === null
                ? { ...percent(null), display: "Not available" }
                : {
                    ...percent(change),
                    display: `${change > 0 ? "up " : change < 0 ? "down " : ""}${Math.abs(change)}%`,
                  },
              `Previous: ${money(previous.total_sales).display} from ${formatPeriod(previous.from_date, previous.to_date) ?? "an earlier period"}`,
            ),
          ]
        : []),
      metric("Profit or loss", cell, hint),
      metric(
        "Udhaar pending",
        udhaar.status === "available" ? money(udhaar.total) : money(null),
        udhaar.status === "available"
          ? `${money(udhaar.overdue).display} overdue`
          : "Could not be read",
      ),
      metric(
        "Products running low",
        stock.status === "available" ? count(stock.low) : count(null),
        stock.status === "available"
          ? `${count(stock.out).display} out of stock`
          : "Could not be read",
      ),
    ],
    sections,
  };
};

// ── Billing summary ────────────────────────────────────────────────────────

export const billingSummary: Builder = ({ result }) => {
  const period = rec(result.period);
  const returns = rec(result.returns);
  const unpaid = rec(result.unpaid);
  const biggest = rec(result.biggest);
  const unpaidKnown = unpaid.status === "available";
  const notices: Notice[] = strings(result.notes).map((n) => notice("warn", "warning", n));
  if (!unpaidKnown)
    notices.push(
      notice(
        "warn",
        "unavailable",
        "Whether bills are paid could not be read, so unpaid bills are not shown.",
      ),
    );

  const mix: Row[] = [
    { what: text("Counter (POS) bills"), bills: count(result.pos_bills) },
    { what: text("Invoice bills"), bills: count(result.invoice_bills) },
    { what: text("Bills to named customers"), bills: count(result.named_customer_bills) },
    { what: text("Walk-in customer bills"), bills: count(result.walk_in_bills) },
  ];
  const sections: Section[] = [
    table("mix", "Bill mix", [left("what", "Type"), right("bills", "Bills")], mix, { limit: 10 }),
  ];
  if (str(biggest.name))
    sections.push({
      kind: "note",
      id: "biggest",
      title: "Biggest bill",
      text: `${biggest.name} for ${money(biggest.amount).display}${str(biggest.customer) ? `, ${biggest.customer}` : ""}.`,
    });

  return {
    period: formatPeriod(period.from_date, period.to_date),
    notices,
    metrics: [
      metric("Bills", count(result.bills)),
      metric("Total billed", money(result.total), "Returns are listed separately"),
      metric("Average bill", money(result.average_bill)),
      metric("Items per bill", qty(result.items_per_bill)),
      metric("Returns", count(returns.count), `${money(returns.amount).display} returned`),
      metric(
        "Unpaid bills",
        unpaidKnown ? count(unpaid.bills) : count(null),
        unpaidKnown ? `${money(unpaid.amount).display} outstanding` : undefined,
      ),
    ],
    sections,
  };
};

// ── Customer insights ──────────────────────────────────────────────────────

export const customerInsights: Builder = ({ result }) => {
  const period = rec(result.period);
  const returns = rec(result.returns);
  const discounts = rec(result.discounts);
  const weekly = recs(result.weekly_buyers);
  const inactive = recs(result.inactive_regulars);
  const high = recs(result.high_value);
  const definitions = rec(result.definitions);

  const customerRows = (rows: Array<Record<string, unknown>>): Row[] =>
    rows.map((c) => ({
      customer: nameCell(c.customer),
      bills: count(c.invoices),
      total: money(c.sales),
      average: money(c.average_bill),
      last: day(c.last_purchase),
      since: days(c.days_since_last),
      favourites: text(
        recs(c.favourite_products)
          .map((p) => str(p.item))
          .filter(Boolean)
          .join(", ") || null,
      ),
    }));
  const columns = [
    left("customer", "Customer"),
    right("bills", "Bills"),
    right("total", "Total bought"),
    right("average", "Average bill"),
    left("last", "Last bought"),
    right("since", "Since then"),
    left("favourites", "Favourite products"),
  ];

  const notices: Notice[] = [];
  if (discounts.status === "not_available")
    notices.push(
      notice(
        "info",
        "unavailable",
        "Discounts are not shown: they are not available in the sales data.",
        str(discounts.reason),
      ),
    );

  const sections: Section[] = [
    table("weekly", "Weekly buyers", columns, customerRows(weekly), {
      intro: str(definitions.weekly),
      empty: "No customer bought often enough to count as a weekly buyer.",
    }),
    table("high", "High-value customers", columns, customerRows(high), {
      intro: str(definitions.high_value),
      empty: "No high-value customers were found.",
    }),
    table("inactive", "Regular customers who have gone quiet", columns, customerRows(inactive), {
      intro: str(definitions.inactive),
      empty: "No regular customer has been away for more than 3 weeks.",
    }),
  ];

  return {
    period: formatPeriod(period.from_date, period.to_date),
    notices,
    metrics: [
      metric("Named customers", count(result.named_customers)),
      metric("Bought in this period", count(result.buying_customers)),
      metric("Regular customers", count(result.regular_customers), str(definitions.regular)),
      metric("Weekly buyers", count(weekly.length)),
      metric("Gone quiet", count(inactive.length)),
      metric("Returns", count(returns.count), `${money(returns.amount).display} returned`),
    ],
    sections,
  };
};

/** payments_summary: money received and paid out. Field names are those of the live ERP read. */
export const paymentsSummary: Builder = ({ result }) => {
  const period = rec(result.period);
  const received = toNumber(result.received);
  const paid = toNumber(result.paid);
  const notices: Notice[] = [];
  if (received === null || paid === null)
    notices.push(
      notice(
        "warn",
        "unavailable",
        "Received or paid amounts could not be read, so the net figure is not shown.",
      ),
    );
  return {
    period: formatPeriod(period.from_date, period.to_date),
    notices,
    metrics: [
      metric("Money received", money(result.received)),
      metric("Money paid out", money(result.paid)),
      metric("Net", received === null || paid === null ? money(null) : money(received - paid)),
      metric("Payments", count(result.payments)),
    ],
  };
};
