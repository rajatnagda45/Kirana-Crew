/** Report builders for the inventory workflows: stock_check, expiry_check, demand_forecast. */
import {
  count,
  day,
  days,
  formatDay,
  formatPeriod,
  humanize,
  money,
  notChecked,
  qty,
  statusCell,
  text,
  toNumber,
} from "./format";
import {
  explain,
  left,
  metric,
  notice,
  nameCell,
  rec,
  recs,
  right,
  str,
  strings,
  table,
  type Builder,
} from "./helpers";
import type { Cell, Notice, Row, Section } from "./types";

// ── Stock check ────────────────────────────────────────────────────────────

export const stockCheck: Builder = ({ result }) => {
  const rows = recs(result.rows);
  const low = recs(result.low);
  const suggestions = new Map(recs(result.recommendations).map((r) => [str(r.item_code), r]));
  const noLevel = rows.filter((row) => row.status === "no_reorder_level");
  const suggestionsStatus = str(result.recommendations_status);
  const suggestionsMissing =
    suggestionsStatus !== undefined && !["available", "not_needed"].includes(suggestionsStatus);

  /** Supplier name and quoted price as two cells, so a CSV keeps the price as a number. */
  const supplierCells = (code: unknown): { supplier: Cell; price: Cell } => {
    const found = suggestions.get(str(code));
    if (!found) {
      const none = suggestionsMissing ? notChecked() : text(null);
      return { supplier: none, price: suggestionsMissing ? notChecked("money") : money(null) };
    }
    const choice = rec(found.choice);
    if (str(choice.supplier)) return { supplier: text(choice.supplier), price: money(choice.rate) };
    return { supplier: text(str(found.blocker) ?? "No suitable quotation"), price: money(null) };
  };

  const lowRows: Row[] = low.map((item) => ({
    product: nameCell(item.item_name, item.item_code),
    stock: qty(item.available, str(item.uom)),
    level: qty(item.reorder_level, str(item.uom)),
    short: qty(item.shortage, str(item.uom)),
    buy: qty(item.recommended_qty, str(item.uom)),
    ...supplierCells(item.item_code),
  }));
  const allRows: Row[] = rows.map((item) => ({
    product: nameCell(item.item_name, item.item_code),
    group: text(item.item_group),
    stock: qty(item.available, str(item.uom)),
    level: item.status === "no_reorder_level" ? statusCell("Not set") : qty(item.reorder_level, str(item.uom)),
    status:
      item.status === "low"
        ? statusCell("Running low", "warn")
        : item.status === "no_reorder_level"
          ? statusCell("No reorder level set")
          : statusCell("OK", "good"),
  }));

  const notices: Notice[] = [];
  if (noLevel.length)
    notices.push(
      notice(
        "info",
        "unchecked",
        `${noLevel.length} product${noLevel.length === 1 ? " has" : "s have"} no reorder level set, so ${noLevel.length === 1 ? "it" : "they"} can't be flagged as running low.`,
      ),
    );
  if (suggestionsMissing)
    notices.push(
      notice("warn", "unavailable", "Supplier suggestions could not be prepared.", suggestionsStatus),
    );

  const sections: Section[] = [];
  if (low.length)
    sections.push(
      table(
        "low",
        "Products running low",
        [
          left("product", "Product"),
          right("stock", "In stock"),
          right("level", "Reorder level"),
          right("short", "Short by"),
          right("buy", "Suggested purchase"),
          left("supplier", "Best supplier"),
          right("price", "Quoted price"),
        ],
        lowRows,
      ),
    );
  else
    sections.push({
      kind: "note",
      id: "all-clear",
      tone: noLevel.length ? undefined : "good",
      text: noLevel.length
        ? `No product with a reorder level is at or below it. ${noLevel.length} product${noLevel.length === 1 ? " has" : "s have"} no reorder level set and could not be judged.`
        : "No product is at or below its reorder level.",
    });
  sections.push(
    table(
      "all",
      "All products checked",
      [
        left("product", "Product"),
        left("group", "Group"),
        right("stock", "In stock"),
        right("level", "Reorder level"),
        left("status", "Status"),
      ],
      allRows,
    ),
  );

  return {
    notices,
    metrics: [
      metric("Products checked", count(rows.length)),
      { label: "Running low", value: { ...count(low.length), tone: low.length ? "warn" : "good" } },
      ...(noLevel.length ? [metric("No reorder level set", count(noLevel.length))] : []),
    ],
    sections,
    recommendations: low.map((item) => {
      const unit = str(item.uom);
      const choice = rec(suggestions.get(str(item.item_code))?.choice);
      const from = str(choice.supplier)
        ? ` from ${choice.supplier} at ${money(choice.rate).display}`
        : "";
      return `Buy ${qty(item.recommended_qty, unit).display} of ${str(item.item_name) ?? str(item.item_code) ?? "this product"}${from}.`;
    }),
  };
};

// ── Expiry check ───────────────────────────────────────────────────────────

const WINDOWS: Array<[string, string]> = [
  ["expired", "Already expired"],
  ["7_days", "Expires within 7 days"],
  ["15_days", "Expires in 8 to 15 days"],
  ["30_days", "Expires in 16 to 30 days"],
];

export const expiryCheck: Builder = ({ result }) => {
  const tracked = toNumber(result.batches_tracked);
  const noBatches = tracked === 0;
  const note = str(result.note);
  const windows = rec(result.windows);
  const unvalued = toNumber(result.unvalued_batches) ?? 0;
  const notices: Notice[] = [];
  const sections: Section[] = [];

  if (noBatches || note) {
    const why = explain(note ?? "No batch-tracked stock");
    notices.push(notice("warn", "unchecked", `Expiry was not checked. ${why.text}`, why.detail));
  }
  if (unvalued > 0)
    notices.push(
      notice(
        "info",
        "unavailable",
        `${unvalued} batch${unvalued === 1 ? " has" : "es have"} no known value, so ${unvalued === 1 ? "it is" : "they are"} not included in the value at risk.`,
      ),
    );

  if (!noBatches) {
    sections.push(
      table(
        "windows",
        "Stock by expiry window",
        [left("window", "Expires"), right("batches", "Batches"), right("qty", "Quantity"), right("value", "Value")],
        WINDOWS.map(([key, label]) => {
          const w = rec(windows[key]);
          return {
            window: text(label),
            batches: count(w.batches),
            qty: qty(w.qty),
            value: money(w.value),
          };
        }),
      ),
    );
    sections.push(
      table(
        "batches",
        "Batches to deal with first",
        [
          left("item", "Product"),
          left("batch", "Batch"),
          left("expiry", "Expiry date"),
          right("left", "Days left"),
          right("qty", "Quantity"),
          right("value", "Value at risk"),
        ],
        recs(result.items).map((item) => ({
          item: nameCell(item.item_name, item.item_code),
          batch: text(item.batch_no),
          expiry: day(item.expiry_date),
          left: days(item.days_left),
          qty: qty(item.qty),
          value: money(item.value_at_risk),
        })),
        { intro: "Perishable products are listed first.", empty: "No batches expire within 30 days." },
      ),
    );
  }

  return {
    period: formatPeriod(result.as_of),
    notices,
    metrics: noBatches
      ? [metric("Batches tracked", count(0))]
      : [metric("Batches tracked", count(tracked)), metric("Value at risk", money(result.value_at_risk))],
    sections,
  };
};

// ── Demand forecast ────────────────────────────────────────────────────────

/** Ends a phrase with a full stop unless it already has one. */
const sentence = (value: string) => (/[.!?]$/.test(value) ? value : `${value}.`);

const RISK: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none_expected: "None expected",
};

/** The last held-out test as plain words. WAPE 1.22 means the error was 122% of actual sales. */
function testResult(item: Record<string, unknown>): Cell {
  const back = rec(item.backtest);
  const methodId = str(rec(item.method).id);
  const wape = toNumber(rec(rec(back.methods)[methodId ?? ""]).wape);
  if (back.status !== "ok" || wape === null) return text("Too little history to test");
  return text(`Off by ${Math.round(wape * 100)}% of actual sales in the last test`);
}

export const demandForecast: Builder = ({ result }) => {
  const items = recs(result.items);
  const usable = items.filter((item) => item.status === "ok");
  const thin = items.filter((item) => item.status !== "ok");
  const window = rec(result.history_window);
  const supply = str(result.supply_status);
  const noLeadTime = usable.filter((item) => rec(item.recommendation).status === "no_lead_time");
  const rough = usable.filter((item) => {
    const wape = toNumber(rec(rec(rec(item.backtest).methods)[str(rec(item.method).id) ?? ""]).wape);
    return wape !== null && wape > 1;
  });
  // Only the limits of products that were actually forecast belong in the basis note.
  const limitations = [...new Set(usable.flatMap((item) => strings(item.limitations)))];

  const notices: Notice[] = [];
  if (supply && supply !== "available")
    notices.push(
      notice(
        "warn",
        "unavailable",
        "Incoming orders and supplier details could not be read, so purchase advice is limited.",
        supply,
      ),
    );
  if (noLeadTime.length)
    notices.push(
      notice(
        "info",
        "unavailable",
        `${noLeadTime.length} product${noLeadTime.length === 1 ? " has" : "s have"} no supplier lead time on record, so a purchase quantity could not be worked out.`,
      ),
    );
  if (rough.length)
    notices.push(
      notice(
        "info",
        "warning",
        `For ${rough.length} product${rough.length === 1 ? "" : "s"}, the last 14-day test was off by more than the actual sales. Treat those forecasts as a rough guide.`,
      ),
    );

  const sections: Section[] = [];
  const from = formatDay(window.from);
  const to = formatDay(window.to);
  if (str(result.label) || from)
    sections.push({
      kind: "note",
      id: "basis",
      text: [
        str(result.label) ? sentence(str(result.label) as string) : undefined,
        from && to ? `Based on this store's sales from ${from} to ${to}.` : undefined,
        ...limitations,
      ]
        .filter(Boolean)
        .join(" "),
    });
  sections.push(
    table(
      "forecast",
      "Expected demand",
      [
        left("product", "Product"),
        right("d7", "Next 7 days"),
        right("d30", "Next 30 days"),
        right("stock", "In stock"),
        right("buy", "Suggested purchase"),
        left("risk", "Stock-out risk"),
        left("test", "Forecast check"),
      ],
      usable.map((item) => {
        const r = rec(item.recommendation);
        const forecast = rec(item.forecast);
        // Say why there is no purchase advice, not just "Not available".
        const noAdvice: Cell = {
          kind: "text",
          value: null,
          display: r.status === "no_lead_time" ? "No lead time on record" : "Not available",
        };
        return {
          product: nameCell(item.item_name, item.item_code),
          d7: qty(forecast.next_7_days),
          d30: qty(forecast.next_30_days),
          stock: qty(item.current_stock),
          buy: r.status === "ok" ? qty(r.suggested_qty) : noAdvice,
          risk: r.status === "ok" ? text(RISK[String(r.stockout_risk)] ?? humanize(String(r.stockout_risk ?? ""))) : noAdvice,
          test: testResult(item),
        };
      }),
      { empty: "No product has enough sales history to forecast." },
    ),
  );
  if (thin.length)
    sections.push(
      table(
        "thin",
        "Not enough history to forecast",
        [left("product", "Product"), right("days", "Days of sales found")],
        thin.map((item) => ({
          product: nameCell(item.item_name, item.item_code),
          days: count(rec(item.history).observed_days),
        })),
        { intro: "At least 14 days of sales are needed. These products are left out rather than guessed." },
      ),
    );

  return {
    period: formatPeriod(result.as_of),
    notices,
    metrics: [
      metric("Products forecast", count(usable.length)),
      ...(thin.length ? [metric("Not enough history", count(thin.length))] : []),
    ],
    sections,
    recommendations: usable
      .filter((item) => (toNumber(rec(item.recommendation).suggested_qty) ?? 0) > 0)
      .map((item) => {
        const r = rec(item.recommendation);
        const risk = RISK[String(r.stockout_risk)];
        return `Order about ${qty(r.suggested_qty).display} of ${str(item.item_name) ?? str(item.item_code) ?? "this product"}${risk ? ` (stock-out risk: ${risk.toLowerCase()})` : ""}.`;
      }),
  };
};
