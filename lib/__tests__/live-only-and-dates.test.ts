import { describe, expect, it } from "vitest";
import { liveBinding } from "../server/nammaops/index.mjs";
import { hasUnreadableDate, parseCommand, parseDays } from "../server/nammaops/workflows.mjs";
import { businessIntent } from "../server/nammaops/group-business.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Fixture "today" is 2026-11-01; the parser tests use Wednesday 2026-11-04.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const WED = "2026-11-04";

describe("the app reads live ERPNext only", () => {
  it("refuses to start NammaOps with no binding, so it can never fall back to synthetic data", () => {
    expect(() => liveBinding({})).toThrow(/NAMMAOPS_BINDING is not set/);
    expect(() => liveBinding({ NAMMAOPS_BINDING: "  " })).toThrow(/NAMMAOPS_BINDING is not set/);
  });

  it("refuses the synthetic fixture binding unless development explicitly allows it", () => {
    const env = { NAMMAOPS_BINDING: "config/nammaops/binding.fixture.json" };
    expect(() => liveBinding(env)).toThrow(/synthetic test fixture/);
    expect(liveBinding({ ...env, NAMMAOPS_ALLOW_FIXTURE: "1" }).shape).toBe("fixture");
  });

  it("accepts the live binding", () => {
    const binding = liveBinding({ NAMMAOPS_BINDING: "config/nammaops/binding.hvgerp.json" });
    expect(binding.shape).toBe("hvgerp");
    expect(binding.server.server_id).toBe("erpnext-live");
  });
});

describe("explicit dates in sales questions", () => {
  it.each([
    ["sales on 2 nov", "2026-11-02"],
    ["sales on 2nd november", "2026-11-02"],
    ["sales on nov 2", "2026-11-02"],
    ["sales on 02/11", "2026-11-02"],
    ["sales on 2026-11-02", "2026-11-02"],
    ["sales on monday", "2026-11-02"],
    ["sales last wednesday", "2026-10-28"],
    ["sales on the 3rd", "2026-11-03"],
    ["sales day before yesterday", "2026-11-02"],
    ["sales on 2 nov 2025", "2025-11-02"],
    ["profit on 2 nov", "2026-11-02"],
    ["sales yesterday", "2026-11-03"],
    ["sales today", WED],
  ])("%s -> %s", (text, date) => {
    expect(parseCommand(text, WED)).toEqual({ action: "daily_report", date });
  });

  it("reads two named days as a range", () => {
    expect(parseCommand("sales from 1 nov to 3 nov", WED)).toEqual({
      action: "daily_report",
      date: "2026-11-01",
      to: "2026-11-03",
    });
    expect(parseCommand("sales between 1/11 and 3/11", WED)).toEqual({
      action: "daily_report",
      date: "2026-11-01",
      to: "2026-11-03",
    });
  });

  it("never answers for today when a date was named but cannot be read", () => {
    expect(() => parseCommand("sales on 31 feb", WED)).toThrow(/could not read that date/);
    expect(hasUnreadableDate("sales on 31 feb")).toBe(true);
    // Ordinary words that happen to be month names are not dates.
    expect(parseCommand("may i see sales", WED)).toEqual({ action: "daily_report", date: WED });
  });

  it("rolls a far-future day-month back a year but keeps a near one as the future", () => {
    expect(parseDays("sales on 30 dec", WED)).toEqual(["2025-12-30"]);
    expect(parseDays("sales on 5 nov", WED)).toEqual(["2026-11-05"]);
  });

  it("passes the named day through the shared chat parser", () => {
    const parsed = businessIntent("sales on 2 nov", { today: WED, seats: [] });
    expect(parsed?.args).toMatchObject({ intent: "sales_summary", day: "2026-11-02" });
  });
});

describe("a sales answer is about sales", () => {
  const ask = async (ctx: Any, args: Any) =>
    ctx.nammaops.voice.query({
      call: { id: `c-${Math.random()}`, name: "Carol" },
      actionId: "a",
      args,
    });

  it("does not read the P&L or add accounting caveats, and gives average bill and top sellers", async () => {
    const ctx: Any = await ready();
    const out: Any = await ask(ctx, { intent: "sales_summary", day: "today" });
    expect(out.consulted).toEqual(["sales"]);
    expect(out.facts[0]).toMatch(/average of ₹[\d,]+ a bill\.$/);
    expect(out.facts[1]).toMatch(/^Top sellers: /);
    const view = ctx.nammaops.workflows.view(out.workflow_id);
    expect(view.tasks.map((t: Any) => t.role)).not.toContain("finance");
    expect(view.result.profit).toEqual({ status: "not_requested" });
    expect(view.summary).not.toMatch(/profit/i);
  });

  it("still reads the posted P&L when profit is what was asked", async () => {
    const ctx: Any = await ready();
    const out: Any = await ask(ctx, { intent: "business_profit", day: "today" });
    expect(out.consulted).toContain("finance");
    expect(out.facts[0]).toMatch(/^Net profit on 2026-11-01: ₹484 \(income ₹3,186/);
  });

  it("says plainly when nothing has been billed yet today", async () => {
    const ctx: Any = await ready();
    ctx.editData((data: Any) => {
      data.sales_invoices = [];
      data.demand_history = undefined;
    });
    const out: Any = await ask(ctx, { intent: "sales_summary", day: "today" });
    expect(out.status).toBe("no_data");
    expect(out.facts[0]).toBe(`No sales have been billed yet today (${TODAY}).`);
  });

  it("a range gives the best and quietest day", async () => {
    const ctx: Any = await ready();
    const out: Any = await ask(ctx, {
      intent: "sales_summary",
      day: "2026-10-29",
      to: "2026-10-31",
    });
    expect(out.facts.some((f: string) => /^Day by day: /.test(f))).toBe(true);
    expect(out.facts.some((f: string) => /^Best day 2026-10-\d\d \(₹/.test(f))).toBe(true);
  });
});
