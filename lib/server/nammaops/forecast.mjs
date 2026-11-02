/**
 * Historical-demand forecasting for NammaOps. Deterministic and explainable: every number comes
 * from submitted sales lines and stock ledger balances returned by ERP tools. This is a forecast
 * of the store's own past demand, not a market prediction; it knows nothing about events,
 * weather or competitors.
 */

export const MIN_OBSERVED_DAYS = 14;
export const HOLDOUT_DAYS = 14;
const DAY = 86400000;
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

export const toDay = (value) => String(value).slice(0, 10);
export function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
export function daysBetween(from, to) {
  const out = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * Days on which an item had no stock at the end of the day. Sales on those days are censored:
 * zero sales during a stockout is missing demand, not zero demand.
 * @param {Array<{item_code: string, posting_date: string, qty_after_transaction: number}>} ledger
 */
export function stockoutDays(ledger, itemCode, from, to) {
  const rows = ledger
    .filter((row) => row.item_code === itemCode)
    .map((row) => ({ day: toDay(row.posting_date), balance: Number(row.qty_after_transaction) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const out = new Set();
  let balance = null;
  let index = 0;
  for (const day of daysBetween(from, to)) {
    while (index < rows.length && rows[index].day <= day) balance = rows[index++].balance;
    if (balance !== null && balance <= 0) out.add(day);
  }
  return out;
}

/**
 * Zero-filled daily units sold for one item, excluding censored stockout days.
 * @param {Array<{item_code: string, posting_date: string, qty: number, document: string}>} lines
 */
export function dailyDemand(lines, itemCode, from, to, censored = new Set()) {
  const totals = new Map();
  const documents = new Set();
  for (const line of lines) {
    if (line.item_code !== itemCode) continue;
    const day = toDay(line.posting_date);
    if (day < from || day > to) continue;
    totals.set(day, (totals.get(day) ?? 0) + Number(line.qty));
    if (line.document) documents.add(line.document);
  }
  return {
    series: daysBetween(from, to)
      .filter((day) => !censored.has(day))
      .map((day) => ({ day, qty: totals.get(day) ?? 0 })),
    documents: [...documents],
    censoredDays: [...censored].filter((day) => day >= from && day <= to).sort(),
  };
}

const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stdev = (values) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};

/** Each method returns a per-day rate function fitted on `series` (observed days only). */
export const METHODS = {
  ma7: {
    label: "7-day moving average",
    fit: (series) => {
      const rate = mean(series.slice(-7).map((row) => row.qty));
      return () => rate;
    },
  },
  ma30: {
    label: "30-day moving average",
    fit: (series) => {
      const rate = mean(series.slice(-30).map((row) => row.qty));
      return () => rate;
    },
  },
  weighted: {
    label: "Weighted recent demand (exponential, alpha 0.3)",
    fit: (series) => {
      let level = series.length ? series[0].qty : 0;
      for (const row of series.slice(1)) level = 0.3 * row.qty + 0.7 * level;
      return () => level;
    },
  },
  weekday: {
    label: "30-day average with weekday pattern",
    minDays: 28,
    fit: (series) => {
      const recent = series.slice(-56);
      const base = mean(series.slice(-30).map((row) => row.qty));
      const overall = mean(recent.map((row) => row.qty)) || 1;
      const factors = Array.from({ length: 7 }, (_, dow) => {
        const days = recent.filter((row) => weekday(row.day) === dow).map((row) => row.qty);
        return days.length >= 3 ? mean(days) / overall : 1;
      });
      return (day) => base * factors[weekday(day)];
    },
  },
};

/**
 * Hold out the most recent observed days, fit each method on the rest, and measure error.
 * WAPE = sum |actual - forecast| / sum actual.
 */
export function backtest(series, holdout = HOLDOUT_DAYS) {
  if (series.length < MIN_OBSERVED_DAYS + holdout)
    return { status: "insufficient_history", methods: {} };
  const train = series.slice(0, -holdout);
  const test = series.slice(-holdout);
  const actual = test.reduce((sum, row) => sum + row.qty, 0);
  const methods = {};
  for (const [id, method] of Object.entries(METHODS)) {
    if (method.minDays && train.length < method.minDays) continue;
    const rate = method.fit(train);
    const errors = test.map((row) => Math.abs(row.qty - rate(row.day)));
    methods[id] = {
      mae: round(mean(errors)),
      wape: actual > 0 ? round(errors.reduce((sum, value) => sum + value, 0) / actual, 3) : null,
    };
  }
  return {
    status: "ok",
    window: { from: test[0].day, to: test.at(-1).day, days: holdout },
    actual_units: actual,
    methods,
  };
}

/**
 * Forecast one item and recommend a purchase quantity.
 * Reorder qty = max(0, lead-time demand + safety stock - available - incoming).
 * Safety stock = z x sigma(daily demand) x sqrt(lead time days).
 */
export function forecastItem({
  item,
  lines,
  ledger,
  today,
  historyDays = 90,
  horizons = [7, 30],
  available,
  reserved = 0,
  incoming = 0,
  incomingRefs = [],
  leadTimeDays,
  z = 1.65,
}) {
  const windowStart = addDays(today, -historyDays);
  const to = addDays(today, -1);
  // History starts at the item's first evidence, not the window start: days before the item was
  // stocked or sold are unknown, not zero demand.
  const firstSeen = [
    ...lines
      .filter((row) => row.item_code === item.item_code)
      .map((row) => toDay(row.posting_date)),
    ...ledger
      .filter((row) => row.item_code === item.item_code)
      .map((row) => toDay(row.posting_date)),
  ].sort()[0];
  const from = firstSeen && firstSeen > windowStart ? firstSeen : windowStart;
  const censored = stockoutDays(ledger, item.item_code, from, to);
  const { series, documents, censoredDays } = dailyDemand(
    lines,
    item.item_code,
    from,
    to,
    censored,
  );
  const unitsSold = series.reduce((sum, row) => sum + row.qty, 0);
  const base = {
    item_code: item.item_code,
    item_name: item.item_name,
    history: {
      from,
      to,
      observed_days: series.length,
      censored_stockout_days: censoredDays,
      units_sold: unitsSold,
    },
    evidence: { sales_documents: documents, incoming_documents: incomingRefs },
    current_stock: available,
    reserved_stock: reserved,
    incoming_stock: incoming,
    supplier_lead_time_days: leadTimeDays ?? null,
  };
  const limitations = [
    "Historical-demand forecast from this store's own sales; it does not see events, weather, prices or competitors.",
  ];
  // No sale and no stock movement at all in the window: zero-filling would turn "nothing recorded"
  // into 90 days of "zero demand". That is missing evidence, not a forecast.
  if (!firstSeen)
    return {
      ...base,
      history: { ...base.history, observed_days: 0 },
      status: "insufficient_evidence",
      limitations: [...limitations, "No sales or stock movements are recorded for this item."],
    };
  if (censoredDays.length)
    limitations.push(
      `${censoredDays.length} stockout day(s) excluded: sales were impossible, so they are not counted as zero demand.`,
    );
  if (series.length < MIN_OBSERVED_DAYS)
    return {
      ...base,
      status: "insufficient_evidence",
      limitations: [
        ...limitations,
        `Only ${series.length} observed day(s); at least ${MIN_OBSERVED_DAYS} are needed.`,
      ],
    };
  const test = backtest(series);
  const ranked = Object.entries(test.methods)
    .filter(([, score]) => score.wape !== null)
    .sort((a, b) => a[1].wape - b[1].wape);
  const methodId = ranked[0]?.[0] ?? "ma30";
  if (!ranked.length)
    limitations.push("No held-out sales to score methods; using the 30-day average.");
  const rate = METHODS[methodId].fit(series);
  const sigma = stdev(series.slice(-30).map((row) => row.qty));
  const demandOver = (days) => {
    let total = 0;
    for (let i = 0; i < days; i += 1) total += rate(addDays(today, i));
    return total;
  };
  const forecasts = Object.fromEntries(
    horizons.map((days) => [`next_${days}_days`, round(demandOver(days), 1)]),
  );
  const averageDaily = round(mean(series.map((row) => row.qty)));
  const usable = Math.max(0, available - reserved);
  let recommendation = {
    status: "no_lead_time",
    reason: "Supplier lead time is unknown; no reorder quantity computed.",
  };
  if (Number.isFinite(leadTimeDays) && leadTimeDays > 0) {
    const leadDemand = demandOver(leadTimeDays);
    const safety = z * sigma * Math.sqrt(leadTimeDays);
    const qty = Math.max(0, Math.ceil(leadDemand + safety - usable - incoming));
    const dailyRate = demandOver(7) / 7;
    const cover = dailyRate > 0 ? usable / dailyRate : null;
    recommendation = {
      status: "ok",
      lead_time_demand: round(leadDemand, 1),
      safety_stock: round(safety, 1),
      suggested_qty: qty,
      days_of_cover: cover === null ? null : round(cover, 1),
      stockout_risk:
        cover === null
          ? "none_expected"
          : cover < leadTimeDays
            ? "high"
            : cover < leadTimeDays + 7
              ? "medium"
              : "low",
      formula: "max(0, lead-time demand + safety stock - (available - reserved) - incoming)",
    };
  }
  return {
    ...base,
    status: "ok",
    average_daily_demand: averageDaily,
    method: { id: methodId, label: METHODS[methodId].label, sigma: round(sigma), z },
    backtest: test,
    forecast: forecasts,
    recommendation,
    limitations,
  };
}
