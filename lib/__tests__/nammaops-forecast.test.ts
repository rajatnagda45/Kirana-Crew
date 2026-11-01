import { describe, expect, it } from "vitest";
import * as engine from "../server/nammaops/forecast.mjs";

// Synthetic sales series only; this tests the arithmetic, not any real store's demand.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const { addDays, dailyDemand, stockoutDays } = engine;
// Results are loosely typed JSDoc objects; tests read them as plain data.
const forecastItem = (input: Any): Any => engine.forecastItem(input);
const backtest = (series: Any): Any => engine.backtest(series);

const TODAY = "2026-11-01";
const item = { item_code: "MILK", item_name: "Milk" };

/** A deterministic daily series: base units, more on Saturdays and Sundays. */
function history(days: number, base: number, weekend = 0, skip: string[] = []) {
  const lines: Any[] = [];
  for (let i = days; i >= 1; i -= 1) {
    const day = addDays(TODAY, -i);
    if (skip.includes(day)) continue;
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    lines.push({
      item_code: "MILK",
      posting_date: day,
      qty: base + (dow === 0 || dow === 6 ? weekend : 0),
      document: `SINV-${i}`,
    });
  }
  return lines;
}

describe("historical-demand forecast", () => {
  it("zero-fills days without sales and keeps evidence document IDs", () => {
    const { series, documents } = dailyDemand(
      [{ item_code: "MILK", posting_date: "2026-10-30", qty: 4, document: "SINV-1" }],
      "MILK",
      "2026-10-29",
      "2026-10-31",
    );
    expect(series).toEqual([
      { day: "2026-10-29", qty: 0 },
      { day: "2026-10-30", qty: 4 },
      { day: "2026-10-31", qty: 0 },
    ]);
    expect(documents).toEqual(["SINV-1"]);
  });

  it("treats stockout days as censored, not as zero demand", () => {
    const ledger = [
      { item_code: "MILK", posting_date: "2026-10-01", qty_after_transaction: 10 },
      { item_code: "MILK", posting_date: "2026-10-05", qty_after_transaction: 0 },
      { item_code: "MILK", posting_date: "2026-10-08", qty_after_transaction: 30 },
    ];
    expect([...stockoutDays(ledger, "MILK", "2026-10-01", "2026-10-10")]).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
    const lines = history(90, 10, 0, ["2026-10-05", "2026-10-06", "2026-10-07"]);
    const withCensoring = forecastItem({
      item,
      lines,
      ledger,
      today: TODAY,
      available: 20,
      leadTimeDays: 2,
    });
    const without = forecastItem({
      item,
      lines,
      ledger: [],
      today: TODAY,
      available: 20,
      leadTimeDays: 2,
    });
    expect(withCensoring.history.censored_stockout_days).toHaveLength(3);
    expect(withCensoring.average_daily_demand).toBe(10);
    expect(without.average_daily_demand).toBeLessThan(10);
  });

  it("reports insufficient evidence for sparse items", () => {
    const result = forecastItem({
      item,
      lines: history(10, 5),
      ledger: [],
      today: TODAY,
      available: 3,
      leadTimeDays: 2,
    });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.recommendation).toBeUndefined();
    expect(result.limitations.join(" ")).toMatch(/at least 14/);
  });

  it("does not forecast an item with no sales and no stock movements at all", () => {
    const result = forecastItem({ item, lines: [], ledger: [], today: TODAY, available: 0 });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.history.observed_days).toBe(0);
    expect(result.forecast).toBeUndefined();
    expect(result.limitations.join(" ")).toMatch(/No sales or stock movements are recorded/);
    // Stock movements alone are evidence the item exists, so history starts there.
    const stocked = forecastItem({
      item,
      lines: [],
      ledger: [
        {
          item_code: "MILK",
          posting_date: addDays(TODAY, -40),
          qty_after_transaction: 50,
          actual_qty: 50,
        },
      ],
      today: TODAY,
      available: 50,
    });
    expect(stocked.status).toBe("ok");
    expect(stocked.history.observed_days).toBe(40);
  });

  it("measures accuracy on a held-out window and picks the best method", () => {
    const flat = history(90, 10);
    const series = dailyDemand(flat, "MILK", addDays(TODAY, -90), addDays(TODAY, -1)).series;
    const test = backtest(series);
    expect(test.status).toBe("ok");
    expect(test.window.days).toBe(14);
    expect(test.methods.ma7.wape).toBe(0);

    const weekly = forecastItem({
      item,
      lines: history(90, 10, 20),
      ledger: [],
      today: TODAY,
      available: 50,
      leadTimeDays: 3,
    });
    expect(weekly.method.id).toBe("weekday");
    expect(weekly.backtest.methods.weekday.wape).toBeLessThan(weekly.backtest.methods.ma30.wape);
  });

  it("computes the reorder quantity from lead-time demand, safety stock, stock and incoming", () => {
    const result = forecastItem({
      item,
      lines: history(90, 10),
      ledger: [],
      today: TODAY,
      available: 15,
      reserved: 5,
      incoming: 4,
      incomingRefs: ["PO-1"],
      leadTimeDays: 3,
    });
    // Flat 10/day: lead-time demand 30, sigma 0 -> safety 0; 30 - (15 - 5) - 4 = 16.
    expect(result.recommendation).toMatchObject({
      status: "ok",
      lead_time_demand: 30,
      safety_stock: 0,
      suggested_qty: 16,
      stockout_risk: "high",
    });
    expect(result.forecast).toEqual({ next_7_days: 70, next_30_days: 300 });
    expect(result.evidence.incoming_documents).toEqual(["PO-1"]);
    const plenty = forecastItem({
      item,
      lines: history(90, 10),
      ledger: [],
      today: TODAY,
      available: 500,
      leadTimeDays: 3,
    });
    expect(plenty.recommendation.suggested_qty).toBe(0);
  });

  it("does not compute a quantity without a supplier lead time", () => {
    const result = forecastItem({
      item,
      lines: history(90, 10),
      ledger: [],
      today: TODAY,
      available: 5,
    });
    expect(result.recommendation.status).toBe("no_lead_time");
  });
});
