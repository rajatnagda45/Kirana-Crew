import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReport, BUILDERS } from "../../components/workflows/reports";
import { generic } from "../../components/workflows/reports/generic";
import {
  durationMs,
  formatDateTime,
  formatDay,
  formatDuration,
  formatRupees,
  money,
  qty,
  toNumber,
} from "../../components/workflows/reports/format";
import { guardCell, tableToCsv, csvFileName } from "../../components/workflows/reports/csv";
import { exportableTables, summaryText, toPlainText } from "../../components/workflows/reports/text";
import type { ReportModel, TableSection } from "../../components/workflows/reports/types";
import { normalizeWorkflow, type WorkflowView } from "../workflow-contract";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// Fixtures are real run records, trimmed and anonymised (scripts/make-workflow-fixtures.mjs),
// shaped exactly like GET /workflows/:id.
const fixture = (name: string): WorkflowView =>
  normalizeWorkflow<WorkflowView>(
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`./fixtures/workflow-runs/${name}.json`, import.meta.url)), "utf8"),
    ).workflow,
  );
const raw = (name: string): Any =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/workflow-runs/${name}.json`, import.meta.url)), "utf8"),
  ).workflow;

const table = (model: ReportModel, id: string) =>
  model.sections.find((s) => s.kind === "table" && s.id === id) as TableSection;
const metricOf = (model: ReportModel, label: string) => model.metrics.find((m) => m.label === label);
const noticeText = (model: ReportModel) => model.notices.map((n) => n.text).join("\n");

describe("formatters", () => {
  it("formats Indian rupees with lakh grouping and only shows paise when present", () => {
    expect(formatRupees(12500)).toBe("₹12,500");
    expect(formatRupees(100000)).toBe("₹1,00,000");
    expect(formatRupees(20606.83)).toBe("₹20,606.83");
    expect(formatRupees(-500)).toBe("-₹500");
    expect(formatRupees(50)).toBe("₹50");
  });

  it("keeps a recorded zero, a missing figure and an unparseable value apart", () => {
    expect(money(0)).toMatchObject({ value: 0, display: "₹0" });
    expect(money(null)).toMatchObject({ value: null, display: "Not available" });
    expect(money(undefined).display).toBe("Not available");
    expect(money(Number.NaN).display).toBe("Not available");
    expect(money("0")).toMatchObject({ value: 0, display: "₹0" }); // ERP sometimes sends strings
    expect(toNumber("")).toBeNull();
    expect(toNumber("abc")).toBeNull();
  });

  it("does not round fractional quantities and shows units", () => {
    expect(qty(2.5, "kg").display).toBe("2.5 kg");
    expect(qty(12).display).toBe("12");
    expect(qty(null, "kg").display).toBe("Not available");
  });

  it("reads a date-only string as a local date, never the day before", () => {
    expect(formatDay("2026-11-08")).toBe("8 Nov 2026");
    expect(formatDay("2026-01-01")).toBe("1 Jan 2026");
    expect(formatDay("not a date")).toBeNull();
    expect(formatDay(null)).toBeNull();
  });

  it("formats server timestamps and works out a duration only when it is real", () => {
    expect(formatDateTime("2026-11-08T11:46:03.779Z", "Asia/Kolkata")).toBe("8 Nov 2026, 5:16 pm");
    expect(formatDateTime("garbage")).toBeNull();
    expect(durationMs("2026-11-08T11:46:03.779Z", "2026-11-08T11:46:16.906Z")).toBe(13127);
    expect(durationMs("2026-11-08T11:46:16.906Z", "2026-11-08T11:46:03.779Z")).toBeNull(); // clock skew
    expect(durationMs("2026-11-08T11:46:03.779Z", null)).toBeNull();
    expect(durationMs(undefined, undefined)).toBeNull();
    expect(formatDuration(13127)).toBe("13 seconds");
    expect(formatDuration(500)).toBe("under 1 second");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
    expect(formatDuration(3_900_000)).toBe("1 h 5 min");
  });
});

describe("csv", () => {
  const cols = [
    { key: "name", label: "Name" },
    { key: "amount", label: "Amount" },
  ];
  const cell = (value: string | number | null) => ({ kind: "text" as const, value, display: String(value) });

  it("writes RFC 4180 with CRLF and a BOM, keeping numbers as numbers", () => {
    const csv = tableToCsv({
      columns: cols,
      rows: [
        { name: cell('Ravi, "Kirana" Stores'), amount: { kind: "money", value: 20606.83, display: "₹20,606.83" } },
        { name: cell("Line\nbreak"), amount: { kind: "money", value: null, display: "Not available" } },
      ],
    });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe('﻿Name,Amount\r\n"Ravi, ""Kirana"" Stores",20606.83\r\n"Line\nbreak",\r\n');
  });

  it("keeps Kannada and Hindi text intact", () => {
    const csv = tableToCsv({ columns: cols, rows: [{ name: cell("ಬೆಳ್ಳುಳ್ಳಿ / लहसुन"), amount: cell(1) }] });
    expect(csv).toContain("ಬೆಳ್ಳುಳ್ಳಿ / लहसुन");
  });

  it("stops text cells from running as spreadsheet formulas, but leaves real numbers alone", () => {
    expect(guardCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(guardCell("@cmd")).toBe("'@cmd");
    expect(guardCell("+91 98450")).toBe("'+91 98450");
    expect(guardCell("-5")).toBe("-5"); // plain number kept
    expect(guardCell("Normal")).toBe("Normal");
    const csv = tableToCsv({ columns: cols, rows: [{ name: cell("=1+1"), amount: cell(-5) }] }, false);
    expect(csv).toBe("Name,Amount\r\n'=1+1,-5\r\n");
  });

  it("builds a safe file name", () => {
    expect(csvFileName(["Stock Check", "Products running low", "2026-11-08"])).toBe(
      "stock-check-products-running-low-2026-11-08.csv",
    );
    expect(csvFileName([null, undefined])).toBe("report.csv");
  });
});

describe("contract mapping", () => {
  it("maps the server's own field names and never reads the old camelCase ones as the source of truth", () => {
    const view = normalizeWorkflow<WorkflowView>({
      id: "wf_1",
      status: "completed",
      created_at: "2026-11-08T11:46:03.779Z",
      finished_at: "2026-11-08T11:46:16.906Z",
      summary: "Done.",
    });
    expect(view).toMatchObject({
      id: "wf_1",
      created_at: "2026-11-08T11:46:03.779Z",
      finished_at: "2026-11-08T11:46:16.906Z",
      summary: "Done.",
    });
    expect(normalizeWorkflow({ id: "x", status: "running" })).toMatchObject({
      finished_at: null,
      summary: null,
    });
    expect(normalizeWorkflow(null)).toMatchObject({ id: "", status: "unknown" });
  });
});

describe("report: stock check", () => {
  const view = fixture("stock_check.completed");
  const model = buildReport(view, { timeZone: "Asia/Kolkata" });

  it("states what is running low, with stock, reorder level, purchase quantity and supplier", () => {
    const low = raw("stock_check.completed").result.low;
    const t = table(model, "low");
    expect(t.rows).toHaveLength(low.length);
    expect(metricOf(model, "Running low")?.value.value).toBe(low.length);
    const first = t.rows[0];
    expect(first.product.display).toBe(low[0].item_name);
    expect(first.stock.value).toBe(low[0].available);
    expect(first.level.value).toBe(low[0].reorder_level);
    expect(first.buy.value).toBe(low[0].recommended_qty);
    expect(first.supplier.display).toMatch(/^Supplier \d+$/);
    expect(first.price.kind).toBe("money"); // the price is its own typed cell, so a CSV keeps the number
    expect(first.price.value).toBe(raw("stock_check.completed").result.recommendations[0].choice.rate);
    expect(model.recommendations[0]).toMatch(/^Buy .* from Supplier \d+ at ₹/);
  });

  it("shows the saved summary as the headline and real server timestamps", () => {
    expect(model.headline).toBe(view.summary);
    expect(model.statusLabel).toBe("Completed");
    expect(model.run.started).toMatch(/^\d{1,2} \w{3} 2026, /);
    expect(model.run.duration).not.toBeNull();
  });

  it("adds no all-clear text when products are running low", () => {
    expect(model.sections.some((s) => s.kind === "note" && s.id === "all-clear")).toBe(false);
  });

  it("qualifies the all-clear when some products have no reorder level", () => {
    const calm: WorkflowView = {
      ...view,
      result: {
        kind: "stock_check",
        rows: [
          { item_name: "Rice", available: 40, reorder_level: 10, status: "ok", uom: "kg" },
          { item_name: "Salt", available: 5, reorder_level: null, status: "no_reorder_level", uom: "kg" },
        ],
        low: [],
        recommendations: null,
        recommendations_status: "not_needed",
      },
    };
    const m = buildReport(calm);
    const note = m.sections.find((s) => s.kind === "note") as Any;
    expect(note.text).toMatch(/no reorder level set and could not be judged/);
    expect(note.tone).toBeUndefined(); // not styled as a clean bill of health
    expect(noticeText(m)).toMatch(/1 product has no reorder level set/);
  });
});

describe("report: daily report", () => {
  it("shows recorded sales, transactions and top products, and says profit was not requested", () => {
    const model = buildReport(fixture("daily_report.completed"));
    const r = raw("daily_report.completed").result;
    expect(metricOf(model, "Total recorded sales")?.value.display).toBe("₹8,844");
    expect(metricOf(model, "Transactions")?.value.value).toBe(r.transaction_count);
    expect(metricOf(model, "Profit or loss")?.value.display).toBe("Not requested");
    expect(table(model, "top").rows[0].product.display).toBe(r.top_products[0].item_name);
    expect(model.period).toBe("1 Nov 2026");
  });

  it("shows posted profit with its source for a day that has accounting entries (real run)", () => {
    const model = buildReport(fixture("daily_report.verified"));
    expect(model.statusLabel).toBe("Completed");
    expect(model.notices).toHaveLength(0);
    expect(metricOf(model, "Total recorded sales")?.value.display).toBe("₹15,745");
    expect(metricOf(model, "Transactions")?.value.value).toBe(6);
    expect(metricOf(model, "Profit or loss")?.value.display).toBe("₹2,614");
    expect(metricOf(model, "Profit or loss")?.hint).toBe("From posted accounting entries");
    expect(metricOf(model, "Income (posted)")?.value.display).toBe("₹15,745");
    expect(metricOf(model, "Expenses (posted)")?.value.display).toBe("₹13,131");
    expect(model.period).toBe("31 Oct 2026");
  });

  it("shows a verified profit, and a loss as a loss", () => {
    const base = fixture("daily_report.completed");
    const profit = (net: number) =>
      buildReport({
        ...base,
        result: { ...base.result, profit: { status: "verified", net_profit: net, income: 9000, expense: 6500 } },
      });
    expect(metricOf(profit(2500), "Profit or loss")?.value.display).toBe("₹2,500");
    const loss = metricOf(profit(-1200), "Profit or loss")!;
    expect(loss.value.display).toBe("-₹1,200");
    expect(loss.value.tone).toBe("bad");
    expect(metricOf(profit(2500), "Income (posted)")?.value.display).toBe("₹9,000");
  });

  it("explains a partial run: profit is unavailable, not zero, and the reason is shown once", () => {
    const view = fixture("daily_report.partial");
    const model = buildReport(view);
    expect(model.statusLabel).toBe("Partially completed");
    expect(model.notices[0]).toMatchObject({ kind: "partial", severity: "warn" });
    expect(metricOf(model, "Profit or loss")?.value).toMatchObject({ value: null, display: "Not available" });
    const profitNotices = model.notices.filter((n) => /No posted accounting entries/.test(n.text));
    expect(profitNotices).toHaveLength(1); // the builder notice and the failed step are one reason
    expect(profitNotices[0].detail).toMatch(/No posted profit and loss data/);
    expect(model.sections.some((s) => s.kind === "note" && /No submitted sales/.test(s.text))).toBe(true);
    // A recorded zero stays a zero.
    expect(metricOf(model, "Total recorded sales")?.value).toMatchObject({ value: 0, display: "₹0" });
  });
});

describe("report: demand forecast", () => {
  const model = buildReport(fixture("demand_forecast.completed"));
  const items = raw("demand_forecast.completed").result.items;

  it("shows the 7-day and 30-day forecast with the history it was based on", () => {
    const t = table(model, "forecast");
    expect(t.rows).toHaveLength(items.filter((i: Any) => i.status === "ok").length);
    expect(t.rows[0].d7.value).toBe(items[0].forecast.next_7_days);
    expect(t.rows[0].d30.value).toBe(items[0].forecast.next_30_days);
    const basis = model.sections.find((s) => s.kind === "note" && s.id === "basis") as Any;
    expect(basis.text).toMatch(/not a market prediction/);
    expect(basis.text).toMatch(/from 10 Aug 2026 to 7 Nov 2026/);
  });

  it("reports the validation result in plain words, and says when it was poor", () => {
    const cell = table(model, "forecast").rows[0].test;
    expect(cell.display).toMatch(/^Off by \d+% of actual sales in the last test$/);
    expect(noticeText(model)).toMatch(/off by more than the actual sales/);
  });
});

describe("report: forecast details", () => {
  const base = fixture("demand_forecast.completed");
  const item = (name: string, extra: Any) => ({
    item_name: name,
    status: "ok",
    forecast: { next_7_days: 10, next_30_days: 40 },
    current_stock: 5,
    method: { id: "ma7" },
    backtest: { status: "ok", methods: { ma7: { wape: 0.2 } } },
    limitations: [],
    ...extra,
  });

  it("says why there is no purchase advice instead of a bare 'Not available'", () => {
    const model = buildReport({
      ...base,
      result: {
        kind: "demand_forecast",
        as_of: "2026-11-08",
        supply_status: "available",
        items: [
          item("No lead time", { recommendation: { status: "no_lead_time" } }),
          item("Has advice", { recommendation: { status: "ok", suggested_qty: 12, stockout_risk: "high" } }),
        ],
      },
    });
    const [noLead, advice] = table(model, "forecast").rows;
    expect(noLead.buy.display).toBe("No lead time on record");
    expect(noLead.buy.value).toBeNull(); // still not a number in a CSV
    expect(advice.buy.display).toBe("12");
    expect(advice.risk.display).toBe("High");
    expect(model.recommendations).toEqual(["Order about 12 of Has advice (stock-out risk: high)."]);
  });

  it("keeps products left out of the forecast out of the basis note", () => {
    const model = buildReport({
      ...base,
      result: {
        kind: "demand_forecast",
        label: "Historical-demand forecast (not a market prediction)",
        history_window: { from: "2026-08-10", to: "2026-11-07" },
        supply_status: "available",
        items: [
          item("Forecast", { recommendation: { status: "ok", suggested_qty: 0, stockout_risk: "low" }, limitations: ["It does not see events or weather."] }),
          item("Too new", { status: "insufficient_evidence", history: { observed_days: 7 }, limitations: ["Only 7 observed day(s); at least 14 are needed."] }),
        ],
      },
    });
    const basis = model.sections.find((s) => s.kind === "note" && s.id === "basis") as Any;
    expect(basis.text).toBe(
      "Historical-demand forecast (not a market prediction). Based on this store's sales from 10 Aug 2026 to 7 Nov 2026. It does not see events or weather.",
    );
    expect(basis.text).not.toMatch(/Only 7 observed/);
    expect(table(model, "thin").rows[0].days.value).toBe(7);
  });
});

describe("report: supplier comparison (real run)", () => {
  const model = buildReport(fixture("supplier_comparison.completed"));
  it("names the best supplier, price and lead time for each product", () => {
    const rows = table(model, "best").rows;
    expect(rows).toHaveLength(3);
    expect(rows[0].product.display).toBe("Wheat Atta 5kg");
    expect(rows[0].supplier.display).toMatch(/^Supplier \d+$/);
    expect(rows[0].price).toMatchObject({ kind: "money", value: 222, display: "₹222" });
    expect(rows[0].lead.display).toBe("1 day");
    expect(rows[0].qty.value).toBe(28);
    expect(model.recommendations[0]).toMatch(/^Buy Wheat Atta 5kg from Supplier \d+ at ₹222\.$/);
  });
  it("explains the ranking and what was not known", () => {
    const why = model.sections.find((s) => s.kind === "list" && s.id === "why") as Any;
    expect(why.items.map((i: Any) => i.text).join(" ")).toMatch(/lowest rate, shortest lead time/);
    expect(why.items.map((i: Any) => i.text).join(" ")).toMatch(/usual reorder quantity/);
    expect(noticeText(model)).toMatch(/Not known for some quotations: availability, delivery reliability/);
    expect(table(model, "considered").rows.length).toBeGreaterThanOrEqual(3);
  });
  it("says so when no supplier can be recommended for a product", () => {
    const base = fixture("supplier_comparison.completed");
    const m = buildReport({
      ...base,
      result: { kind: "supplier_comparison", items: [{ item_name: "Saffron", qty: 1, qty_basis: "one_unit", choice: null, considered: [], criteria: "x", blocker: "No quotation for this item." }] },
    });
    expect(noticeText(m)).toMatch(/No suitable supplier was found for Saffron/);
    expect(table(m, "best").rows[0].supplier.display).toBe("None suitable");
    expect(m.recommendations).toHaveLength(0);
  });
});

describe("report: expiry check", () => {
  it("says expiry was not checked when the store tracks no batches, and shows no zero table", () => {
    const model = buildReport(fixture("expiry_check.completed"));
    expect(noticeText(model)).toMatch(/Expiry was not checked\. This store does not currently track product batches/);
    expect(model.sections).toHaveLength(0); // no window table of zeros that would read as "nothing expires"
    expect(metricOf(model, "Value at risk")).toBeUndefined();
    expect(metricOf(model, "Batches tracked")?.value.value).toBe(0);
  });

  it("shows windows, batches and value at risk when batches exist", () => {
    const base = fixture("expiry_check.completed");
    const model = buildReport({
      ...base,
      result: {
        kind: "expiry_check",
        as_of: "2026-11-08",
        batches_tracked: 4,
        windows: { expired: { batches: 1, qty: 3, value: 90 }, "7_days": { batches: 2, qty: 10, value: 400.5 }, "15_days": { batches: 0, qty: 0, value: 0 }, "30_days": { batches: 1, qty: 4, value: 120 } },
        value_at_risk: 610.5,
        unvalued_batches: 1,
        items: [{ item_name: "Curd", batch_no: "B1", expiry_date: "2026-11-10", days_left: 2, qty: 5, value_at_risk: 150 }],
      },
    });
    expect(table(model, "windows").rows[1].value.display).toBe("₹400.50");
    expect(table(model, "batches").rows[0].left.display).toBe("2 days");
    expect(metricOf(model, "Value at risk")?.value.display).toBe("₹610.50");
    expect(noticeText(model)).toMatch(/1 batch has no known value/);
  });
});

describe("report: udhaar", () => {
  const model = buildReport(fixture("receivables_report.completed"));
  it("shows dues by age and who to collect from first", () => {
    const r = raw("receivables_report.completed").result;
    expect(metricOf(model, "Total owed to you")?.value.value).toBe(r.total_outstanding);
    expect(table(model, "buckets").rows.map((x) => x.age.display)).toEqual([
      "Not yet due",
      "Up to 30 days overdue",
      "31 to 60 days overdue",
      "61 to 90 days overdue",
      "More than 90 days overdue",
    ]);
    expect(table(model, "collect").rows[0].oldest.value).toBe(r.collection_priority[0].oldest_days_overdue);
    expect(model.recommendations).toHaveLength(Math.min(3, r.collection_priority.length));
  });
  it("is honest that credit limits were not checked", () => {
    expect(noticeText(model)).toMatch(/Credit limits are not available from ERPNext/);
  });
});

describe("report: purchase status", () => {
  it("shows late deliveries and unpaid supplier bills", () => {
    const model = buildReport(fixture("purchase_status.completed"));
    const r = raw("purchase_status.completed").result;
    expect(table(model, "late").rows).toHaveLength(r.delayed.length);
    expect(table(model, "late").rows[0].late.display).toMatch(/day/);
    expect(metricOf(model, "Unpaid supplier bills")?.value.value).toBe(r.payables.total);
    expect(model.recommendations[0]).toMatch(/^Ask Supplier \d+ about /);
  });
});

describe("report: supplier performance and customer insights", () => {
  it("marks unavailable supplier measures instead of showing zero", () => {
    const model = buildReport(fixture("supplier_performance.completed"));
    const row = table(model, "suppliers").rows[0];
    expect(row.ontime.display).toBe("Not available");
    expect(row.lead.display).toBe("Not available");
    expect(row.late.display).toBe("0"); // a genuine zero
    expect(noticeText(model)).toMatch(/On-time rate is not available/);
  });

  it("reads the server's 0-to-1 on-time rate as a percentage", () => {
    const base = fixture("supplier_performance.completed");
    const model = buildReport({
      ...base,
      result: { ...base.result, suppliers: [{ supplier: "S", on_time_rate: 0.875, late_lines: 1, max_days_late: 3, outstanding: 100 }], delaying: [{ supplier: "S", late_lines: 1, max_days_late: 3 }] },
    });
    expect(table(model, "suppliers").rows[0].ontime.display).toBe("87.5%");
    expect(model.recommendations[0]).toMatch(/S is late on 1 line, up to 3 days/);
  });

  it("lists weekly buyers, high-value and quiet regulars, and says discounts are unavailable", () => {
    const model = buildReport(fixture("customer_insights.completed"));
    expect(model.sections.filter((s) => s.kind === "table").map((s) => s.title)).toEqual([
      "Weekly buyers",
      "High-value customers",
      "Regular customers who have gone quiet",
    ]);
    expect(table(model, "high").rows[0].favourites.display).toMatch(/Milk|Biscuits|Water/);
    expect(noticeText(model)).toMatch(/Discounts are not shown/);
  });
});

describe("report: store health", () => {
  const view = fixture("store_health_report.partial");
  const model = buildReport(view);

  it("lists the biggest problems with severity and the money affected, plus the unchecked areas", () => {
    const list = model.sections.find((s) => s.kind === "list" && s.id === "problems") as Any;
    expect(list.items).toHaveLength(raw("store_health_report.partial").result.problems.length);
    expect(list.items[0].text).toMatch(/^High: Udhaar overdue more than 30 days/);
    expect(list.items[0].detail).toMatch(/About ₹21,655.14 affected/);
    expect(noticeText(model)).toMatch(/Expiry was not checked\. This store does not currently track product batches/);
    expect(model.recommendations[0]).toMatch(/Udhaar Report/);
  });

  it("never says there are no problems when a check was skipped", () => {
    const quiet = buildReport({
      ...view,
      result: { kind: "store_health_report", as_of: "2026-11-08", problems: [], unchecked: [{ area: "expiry", reason: "No batch-tracked stock was returned by ERP." }], snapshot: {} },
    });
    const note = quiet.sections.find((s) => s.kind === "note") as Any;
    expect(note.text).toBe("No problems were found in the areas that were checked. Not checked: expiry.");
    expect(note.tone).toBeUndefined();
    const clear = buildReport({ ...view, result: { kind: "store_health_report", problems: [], unchecked: [], snapshot: {} } });
    expect((clear.sections.find((s) => s.kind === "note") as Any).text).toMatch(/^No problems were found in the areas checked/);
  });

  it("flags a profit figure that could not be read", () => {
    const m = buildReport({ ...view, result: { ...view.result, snapshot: { ...(view.result as Any).snapshot, net_profit_7_days: null } } });
    expect(metricOf(m, "Profit, last 7 days")?.value.display).toBe("Not available");
    expect(noticeText(m)).toMatch(/Profit for the last 7 days could not be read/);
  });
});

describe("report: business and billing", () => {
  it("compares with the previous period and shows posted profit", () => {
    const model = buildReport(fixture("business_report.completed"));
    expect(metricOf(model, "Compared with the previous period")?.value.display).toBe("up 0.4%");
    expect(metricOf(model, "Profit or loss")?.value.display).toBe("₹68,914");
    expect(metricOf(model, "Udhaar pending")?.hint).toBe("₹44,183.38 overdue");
    expect(model.period).toBe("1 Oct 2026 to 31 Oct 2026");
  });

  it("says plainly when the previous period could not be read", () => {
    const base = fixture("business_report.completed");
    const model = buildReport({ ...base, result: { ...base.result, previous: null, unavailable: ["Udhaar could not be read."] } });
    expect(metricOf(model, "Compared with the previous period")).toBeUndefined();
    expect(noticeText(model)).toMatch(/previous period could not be read/);
    expect(noticeText(model)).toMatch(/Udhaar could not be read/);
  });

  it("shows billing figures and keeps returns separate", () => {
    const model = buildReport(fixture("billing_summary.completed"));
    expect(metricOf(model, "Total billed")?.value.display).toBe("₹5,091");
    expect(metricOf(model, "Total billed")?.hint).toBe("Returns are listed separately");
    expect(metricOf(model, "Unpaid bills")?.hint).toBe("₹3,741 outstanding");
    expect(model.period).toBe("3 Nov 2026");
  });
});

describe("report: payments summary", () => {
  it("shows received, paid and net in rupees, with the real period", () => {
    const model = buildReport(fixture("payments_summary.completed"));
    expect(metricOf(model, "Money received")?.value.display).toBe("₹22,620");
    expect(metricOf(model, "Money paid out")?.value.display).toBe("₹0");
    expect(metricOf(model, "Net")?.value.display).toBe("₹22,620");
    expect(metricOf(model, "Payments")?.value.display).toBe("16");
    expect(model.period).toBe("1 Nov 2026 to 9 Nov 2026");
  });

  it("does not invent a net figure when an amount is missing", () => {
    const base = fixture("payments_summary.completed");
    const model = buildReport({ ...base, result: { ...base.result, paid: null } });
    expect(metricOf(model, "Net")?.value.display).toBe("Not available");
    expect(noticeText(model)).toMatch(/could not be read/);
  });
});

describe("report: blocked, clarification and other statuses", () => {
  it("explains a blocked Prepare Reorder in plain words and points to the read-only alternative", () => {
    const view = fixture("prepare_reorder.blocked");
    const model = buildReport(view);
    expect(model.statusLabel).toBe("Blocked");
    expect(model.headline).toBeNull();
    expect(model.notices[0]).toMatchObject({ severity: "error", kind: "blocked" });
    expect(model.notices[0].text).toMatch(/Live purchase-order creation is switched off/);
    expect(model.notices[0].detail).toMatch(/erp\.po\.create_draft is not enabled/);
    expect(model.recommendations.join(" ")).toMatch(/Reorder suggestions \(read-only\)/);
    expect(model.sections).toHaveLength(0);
  });

  it("asks the question from the structured clarification, not from the run summary", () => {
    const view = fixture("supplier_comparison.needs_clarification");
    const model = buildReport(view);
    expect(model.statusLabel).toBe("Needs your answer");
    expect(model.headline).toBe("Which product should I use?");
    expect(model.headline).not.toMatch(/Please clarify/);
  });

  it("uses the server's own question when it sends one", () => {
    const view = fixture("prepare_bill.needs_clarification");
    expect(buildReport(view).headline).toMatch(/How many packs of Toned Milk 500ml\?/);
  });

  it.each([
    ["interrupted", "Interrupted", /server restarted/],
    ["outcome_unknown", "Outcome unknown", /Check the ERP/],
    ["awaiting_approval", "Waiting for your approval", /approve/],
    ["running", "Running", /still being prepared/],
  ])("describes a %s run", (status, label, text) => {
    const model = buildReport({ id: "x", status, intent: { action: "stock_check" }, result: null });
    expect(model.statusLabel).toBe(label);
    expect(noticeText(model)).toMatch(text);
    expect(model.metrics).toHaveLength(0);
  });

  it("lists a failed step by its title with the reason, for a partial run", () => {
    const view: WorkflowView = {
      id: "x",
      status: "partial",
      intent: { action: "stock_check" },
      result: { kind: "stock_check", rows: [], low: [], recommendations: null, recommendations_status: "not_needed" },
      tasks: [{ status: "failed", title: "Compare suppliers", error: "Quotations timed out" }],
    };
    expect(noticeText(buildReport(view))).toMatch(/Not done: Compare suppliers\. Quotations timed out/);
  });
});

describe("report: unknown and malformed results never blank the page", () => {
  it("lays out an unknown workflow generically: tiles, tables and lists, no raw JSON", () => {
    const model = buildReport({
      id: "x",
      status: "completed",
      intent: { action: "brand_new_report" },
      summary: "Done.",
      result: {
        kind: "brand_new_report",
        total_amount: 1234.5,
        orders: 3,
        note: "All fine",
        totals: { cash_amount: 100, upi_amount: 200 },
        rows: [{ name: "A", qty: 2, amount: 50 }],
        tags: ["x", "y"],
      },
    });
    expect(model.title).toBe("Brand new report");
    expect(metricOf(model, "Total amount")?.value.display).toBe("₹1,234.50");
    expect(metricOf(model, "Orders")?.value.display).toBe("3");
    expect(metricOf(model, "Totals: Upi amount")?.value.display).toBe("₹200");
    expect(table(model, "list-rows").rows[0].amount.display).toBe("₹50");
    expect(model.sections.some((s) => s.kind === "list" && s.id === "list-tags")).toBe(true);
    expect(toPlainText(model)).not.toMatch(/[{}\[\]]/);
  });

  it("falls back to the simpler layout when a builder throws", () => {
    const result = { kind: "stock_check" };
    Object.defineProperty(result, "rows", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const model = buildReport({ id: "x", status: "completed", intent: { action: "stock_check" }, result, summary: "S" });
    expect(model.headline).toBe("S");
    expect(noticeText(model)).toMatch(/simpler layout/);
  });

  it("never throws, whatever shape a result has (fuzz over every builder)", () => {
    const weird: unknown[] = [
      {},
      { rows: null, low: 5, items: "x", windows: [], problems: {}, result: [] },
      { rows: [null, 1, "a", [], {}], items: [null, { forecast: 5, backtest: "x", recommendation: [] }] },
      { total_sales: "abc", transaction_count: {}, top_products: [{ amount: NaN }], profit: "no", period: 3 },
      { buckets: [], collection_priority: "x", overdue_over_30_days: null, snapshot: 1, unchecked: [null, 3] },
      { suppliers: [{ on_time_rate: "x" }], delaying: [1], weekly_buyers: [[]], customers: "x" },
      { sales: [], previous: [], stock: "s", udhaar: 1, unavailable: [{}, null, 4], notes: [3] },
    ];
    for (const action of [...Object.keys(BUILDERS), "unknown_thing"])
      for (const result of weird) {
        const model = buildReport({ id: "x", status: "completed", intent: { action }, result: result as Any });
        expect(model.title).toBeTruthy();
        expect(() => toPlainText(model)).not.toThrow();
        expect(() => generic({ view: {} as Any, result: result as Any, tasks: [] })).not.toThrow();
      }
  });
});

describe("plain text and export", () => {
  it("copies a summary with the saved sentence, and a caveat for a partial run", () => {
    expect(summaryText(buildReport(fixture("stock_check.completed")))).toBe(
      `Stock Check · ${buildReport(fixture("stock_check.completed")).period ?? ""}`.replace(/ · $/, "") +
        `\n${fixture("stock_check.completed").summary}`,
    );
    const partial = summaryText(buildReport(fixture("daily_report.partial")));
    expect(partial).toMatch(/Note: partially completed/);
  });

  it("copies the complete report: notes, figures, every row and the next steps", () => {
    const model = buildReport(fixture("daily_report.partial"));
    const text = toPlainText(model);
    expect(text).toMatch(/^Daily Report · Partially completed/);
    expect(text).toMatch(/Please note:/);
    expect(text).toMatch(/Profit or loss: Not available/);
    const big = buildReport({
      id: "x",
      status: "completed",
      intent: { action: "x" },
      result: { rows: Array.from({ length: 40 }, (_, i) => ({ name: `Item ${i}`, qty: i })) },
    });
    const body = toPlainText(big);
    expect(body).toMatch(/Item 0 \|/);
    expect(body).toMatch(/Item 39 \|/); // the 25-row display limit does not cut the copy
    expect((table(big, "list-rows").limit ?? 0) < 40).toBe(true);
  });

  it("offers CSV only for tables that have rows", () => {
    const model = buildReport(fixture("purchase_status.completed"));
    expect(exportableTables(model).every((t) => t.rows.length > 0)).toBe(true);
    const empty = buildReport(fixture("expiry_check.completed"));
    expect(exportableTables(empty)).toHaveLength(0);
  });
});
