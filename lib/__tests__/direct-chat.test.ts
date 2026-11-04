import { describe, expect, it } from "vitest";
import { answerDirect, helpLine, specialistProfile } from "../server/nammaops/direct-chat.mjs";
import { MAX_REPORT_DAYS, parseCommand, parseDateRange } from "../server/nammaops/workflows.mjs";
import { resolveProducts } from "../server/nammaops/calculations.mjs";
import { classifyIntent } from "../server/routing/intent-classifier.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Synthetic TEST FIXTURE only (fixture "today" is 2026-11-01, a Sunday).
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SESSION = "agent:main:dm-test-session";

/** The seat each NammaOps specialist was bound to by workforce setup. */
function seats(ctx: Any) {
  const bySeat = (role: string) =>
    ctx.runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`).seat_id;
  return {
    manager: bySeat("manager"),
    inventory: bySeat("inventory"),
    sales: bySeat("sales"),
    procurement: bySeat("procurement"),
    finance: bySeat("finance"),
  };
}
const send = (ctx: Any, seatId: string, message: string, taskId = crypto.randomUUID()) =>
  answerDirect(ctx.runtime, { taskId, message, seatId, sessionKey: SESSION });
const saved = (ctx: Any, taskId: string) => ({
  user: ctx.runtime.db.getMessage(`dm_user_${taskId}`),
  reply: ctx.runtime.db.getMessage(`dm_reply_${taskId}`),
});

describe("one-to-one chat with a NammaOps specialist", () => {
  it("answers a store question with the governed workflow and never uses the shared main agent", async () => {
    const ctx: Any = await ready();
    const { finance } = seats(ctx);
    const taskId = "t-udhaar-1";
    const out: Any = await send(ctx, finance, "How much udhaar is pending?", taskId);
    expect(out.answered).toMatchObject({ intent: "receivables_report" });
    expect(out.answered.workflowId).toMatch(/^wf_/);
    const { user, reply } = saved(ctx, taskId);
    expect(user).toMatchObject({ role: "user", sessionKey: SESSION, seatId: finance });
    expect(reply).toMatchObject({ role: "assistant", sessionKey: SESSION, actorName: "Erin" });
    expect(reply.content).toMatch(/Udhaar pending/);
    expect(reply.content).toMatch(/Source: .*consulted finance/);
    // No OpenClaw task was started for this message.
    expect(ctx.runtime.seatOwner().submit).not.toHaveBeenCalled();
    // The reads were audited under the finance specialist's own governed identity.
    const view = ctx.nammaops.workflows.view(out.answered.workflowId);
    expect(view.tasks.find((t: Any) => t.role === "finance").evidence.length).toBeGreaterThan(0);
  });

  it("hands a question to the specialist who owns it and says so", async () => {
    const ctx: Any = await ready();
    const { sales } = seats(ctx);
    const taskId = "t-handoff-1";
    await send(ctx, sales, "how much udhaar is pending", taskId);
    const { reply } = saved(ctx, taskId);
    expect(reply.actorName).toBe("Carol");
    expect(reply.content).toMatch(/^Erin \(Finance\) covers this/);
    expect(reply.content).toMatch(/Udhaar pending/);
  });

  it("answers a multi-day sales request with a per-day breakdown", async () => {
    const ctx: Any = await ready();
    const { sales } = seats(ctx);
    const taskId = "t-range-1";
    const out: Any = await send(ctx, sales, "give summary on previous 3 day sales", taskId);
    expect(out.answered.intent).toBe("sales_summary");
    const view = ctx.nammaops.workflows.view(out.answered.workflowId);
    expect(view.intent).toMatchObject({
      action: "daily_report",
      date: "2026-10-29",
      to: "2026-10-31",
    });
    expect(view.result.by_day.map((d: Any) => d.date)).toEqual([
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
    ]);
    const sum = view.result.by_day.reduce((s: number, d: Any) => s + d.total, 0);
    expect(view.result.total_sales).toBeCloseTo(sum, 2);
    expect(saved(ctx, taskId).reply.content).toMatch(/Day by day: 2026-10-29 /);
  });

  it("replies with a short help line to anything that is not a store question, without calling main", async () => {
    const ctx: Any = await ready();
    const { inventory } = seats(ctx);
    const taskId = "t-joke-1";
    const out: Any = await send(ctx, inventory, "tell me a joke", taskId);
    expect(out.answered).toMatchObject({ workflowId: null, intent: null });
    const { reply } = saved(ctx, taskId);
    expect(reply.content).toBe(helpLine("Bob", "Inventory", "inventory"));
    expect(reply.content).toMatch(/stock, what to reorder/);
    expect(ctx.runtime.seatOwner().submit).not.toHaveBeenCalled();
    expect(ctx.nammaops.workflows.list()).toHaveLength(0);
  });

  it("does not run the workflow twice when a send is retried", async () => {
    const ctx: Any = await ready();
    const { finance } = seats(ctx);
    const first: Any = await send(ctx, finance, "how much udhaar is pending", "t-retry-1");
    const again: Any = await send(ctx, finance, "how much udhaar is pending", "t-retry-1");
    expect(again.answered).toMatchObject({ repeat: true, workflowId: first.answered.workflowId });
    expect(ctx.nammaops.workflows.list()).toHaveLength(1);
  });

  it("obeys the emergency stop", async () => {
    const ctx: Any = await ready();
    const { finance } = seats(ctx);
    ctx.runtime.estop = {
      assertClear: () => {
        throw Object.assign(new Error("Emergency stop is engaged."), { status: 423 });
      },
    };
    await expect(send(ctx, finance, "how much udhaar is pending")).rejects.toMatchObject({
      status: 423,
    });
    expect(ctx.runtime.db.messages(SESSION)).toEqual([]);
  });

  it("leaves other seats alone and validates input", async () => {
    const ctx: Any = await ready();
    const { finance } = seats(ctx);
    expect(specialistProfile(ctx.runtime, "seat-research")).toBeNull();
    expect(await send(ctx, "seat-research", "hello")).toBeNull();
    await expect(
      answerDirect(ctx.runtime, {
        taskId: "bad id!",
        message: "hi",
        seatId: finance,
        sessionKey: SESSION,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(send(ctx, finance, "x".repeat(1001))).rejects.toMatchObject({ status: 400 });
    await expect(
      answerDirect(ctx.runtime, { taskId: "t1", message: "hi", seatId: finance }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("multi-day sales ranges", () => {
  // 2026-11-04 is a Wednesday.
  const WED = "2026-11-04";
  it.each([
    ["give summary on previous 3 day sales", { date: "2026-11-01", to: "2026-11-03" }],
    ["sales for the last 7 days", { date: "2026-10-28", to: "2026-11-03" }],
    ["sales this week", { date: "2026-11-02", to: WED }],
    ["sales last week", { date: "2026-10-26", to: "2026-11-01" }],
    ["sales this month", { date: "2026-11-01", to: WED }],
    ["sales last month", { date: "2026-10-01", to: "2026-10-31" }],
  ])("%s", (text, range) => {
    expect(parseCommand(text, WED)).toEqual({ action: "daily_report", ...range });
  });

  it("keeps a single day a single day, and caps a range at 31 days", () => {
    expect(parseCommand("sales yesterday", WED)).toEqual({
      action: "daily_report",
      date: "2026-11-03",
    });
    expect(parseCommand("sales for the last 1 day", WED)).toEqual({
      action: "daily_report",
      date: WED,
    });
    expect(parseDateRange("sales for the last 90 days", WED)).toEqual({
      from: "2026-10-04",
      to: "2026-11-03",
    });
    expect(MAX_REPORT_DAYS).toBe(31);
  });

  it("rejects a bad explicit range and clamps one that reaches into the future", async () => {
    const ctx: Any = await ready();
    const wf = ctx.nammaops.workflows;
    expect(() =>
      wf.start({ intent: { action: "daily_report", date: "2026-10-31", to: "2026-10-01" } }),
    ).toThrow(/before its start/);
    expect(() =>
      wf.start({ intent: { action: "daily_report", date: "2026-08-01", to: "2026-10-31" } }),
    ).toThrow(/at most 31 days/);
    const started = wf.start({
      intent: { action: "daily_report", date: "2026-10-30", to: "2026-12-31" },
    });
    expect(started.workflow.intent.to).toBe(TODAY);
    await started.done;
  });

  it("a single-day report is unchanged: no by_day field", async () => {
    const ctx: Any = await ready();
    const view = await ctx.nammaops.workflows.start({
      intent: { action: "daily_report", date: "2026-11-01" },
    }).done;
    expect(view.result.by_day).toBeUndefined();
    expect(view.result).toMatchObject({ total_sales: 3186, transaction_count: 3 });
  });
});

describe("Erin and the new workflows through the voice router", () => {
  it("accepts Erin as a department and answers udhaar with facts and evidence", async () => {
    const ctx: Any = await ready();
    const response: Any = await ctx.nammaops.voice.query({
      call: { id: "call-erin", name: "Erin" },
      actionId: "a1",
      args: { intent: "receivables_report" },
    });
    expect(response.status).toBe("completed");
    expect(response.voice_department).toBe("finance");
    expect(response.facts[0]).toMatch(/^Udhaar pending ₹/);
    expect(response.consulted).toContain("finance");
  });

  it.each([
    ["expiry_check", "inventory"],
    ["purchase_status", "procurement"],
    ["supplier_performance", "procurement"],
    ["customer_insights", "sales"],
    ["store_health_report", "manager"],
  ])("%s runs and returns facts", async (intent, department) => {
    const ctx: Any = await ready();
    const name = { inventory: "Bob", procurement: "Dave", sales: "Carol", manager: "Alice" }[
      department
    ];
    const response: Any = await ctx.nammaops.voice.query({
      call: { id: `call-${intent}`, name },
      actionId: "a1",
      args: { intent },
    });
    expect(["completed", "partial"]).toContain(response.status);
    expect(response.facts.length).toBeGreaterThan(0);
    expect(response.workflow_id).toMatch(/^wf_/);
  });

  it("classifies finance questions into a finance voice intent instead of a direct task", () => {
    const intent = (text: string) =>
      classifyIntent(text) as { voiceIntents: Record<string, string> };
    expect(intent("check finance").voiceIntents.finance).toBe("business_profit");
    expect(intent("show me the finance dues, who has not paid").voiceIntents.finance).toBe(
      "receivables_report",
    );
  });
});

describe("everyday product words", () => {
  const items = [
    { item_code: "A", item_name: "Toor Dal 1kg", item_group: "Staples" },
    { item_code: "B", item_name: "Urad Dal 1kg", item_group: "Staples" },
    { item_code: "C", item_name: "Kabuli Chana 1kg", item_group: "Staples" },
    { item_code: "D", item_name: "Sugar 1kg", item_group: "Staples" },
  ];
  it("resolves pulses to the dal and pulse items that are recorded", () => {
    const { resolved, clarifications } = resolveProducts(["pulses"], items);
    expect(clarifications).toEqual([]);
    expect(resolved.map((r: Any) => r.item.item_code)).toEqual(["A", "B", "C"]);
  });
  it("still asks when nothing matches, never inventing a product", () => {
    const { resolved, clarifications } = resolveProducts(["pulses"], [items[3]]);
    expect(resolved).toEqual([]);
    expect(clarifications[0]).toMatchObject({ requested: "pulses", reason: "unknown" });
  });
});

describe("store questions versus investigations", () => {
  it("treats a plain stock question as a store question and an investigation as not", async () => {
    const { isStoreQuestion } = await import("../server/nammaops/direct-chat.mjs");
    const ctx: Any = await ready();
    const { inventory } = seats(ctx);
    expect(await isStoreQuestion(ctx.runtime, inventory, "check stock of pulses")).toBe(true);
    expect(await isStoreQuestion(ctx.runtime, inventory, "how much udhaar is pending")).toBe(true);
    expect(
      await isStoreQuestion(ctx.runtime, inventory, "why does the stock count not match the books"),
    ).toBe(false);
    expect(await isStoreQuestion(ctx.runtime, "seat-research", "check stock of milk")).toBe(false);
  });
});

describe("a date that cannot be read", () => {
  it("tells the owner so instead of showing a generic help line", async () => {
    const ctx: Any = await ready();
    const { sales } = seats(ctx);
    const taskId = "t-baddate-1";
    await send(ctx, sales, "sales on 31 feb", taskId);
    expect(saved(ctx, taskId).reply.content).toMatch(/could not read that date/);
    expect(ctx.nammaops.workflows.list()).toHaveLength(0);
  });

  it("does not repeat the data-source note when the Source line already names it", async () => {
    const ctx: Any = await ready();
    const { sales } = seats(ctx);
    const taskId = "t-source-1";
    await send(ctx, sales, "sales yesterday", taskId);
    const content = saved(ctx, taskId).reply.content as string;
    expect(content).not.toMatch(/Data source:/);
    expect(content).toMatch(/\nSource: .*consulted sales/);
  });
});

describe("Grace (Reports) is a real specialist", () => {
  it("is a voice department and runs the weekly report under her own identity", async () => {
    const ctx: Any = await ready();
    const response: Any = await ctx.nammaops.voice.query({
      call: { id: "call-grace", name: "Grace" },
      actionId: "a1",
      args: { intent: "business_report" },
    });
    expect(["completed", "partial"]).toContain(response.status);
    expect(response.voice_department).toBe("reports");
    expect(response.facts[0]).toMatch(/^Report for /);
    expect(response.consulted).toContain("reports");
    // Her reads ran as her, never as Carol or Erin.
    const view = ctx.nammaops.workflows.view(response.workflow_id);
    expect(view.tasks.map((t: Any) => t.role)[0]).toBe("reports");
  });

  it("answers a one-to-one weekly report request and routes the wording to her", async () => {
    const ctx: Any = await ready();
    const seat = ctx.runtime.profiles
      .list()
      .find((p: Any) => p.agent_id === "nammaops-reports").seat_id;
    const out: Any = await send(ctx, seat, "Give me the weekly report", "t-grace-1");
    expect(out.answered).toMatchObject({ intent: "business_report" });
    expect(saved(ctx, "t-grace-1").reply.content).toMatch(/Report for /);
    expect(parseCommand("weekly report", TODAY)).toMatchObject({ action: "business_report" });
    // A sales question stays Carol's.
    expect(parseCommand("give summary on previous 3 day sales", TODAY).action).toBe("daily_report");
    const routed = classifyIntent("give me the monthly report") as Any;
    expect(routed.voiceIntents.reports).toBe("business_report");
  });
});

describe("Frank (Billing) is a real specialist", () => {
  it("answers a bills question under his own identity and keeps udhaar and sales elsewhere", async () => {
    const ctx: Any = await ready();
    const response: Any = await ctx.nammaops.voice.query({
      call: { id: "call-frank", name: "Frank" },
      actionId: "a1",
      args: { intent: "billing_summary" },
    });
    expect(["completed", "partial"]).toContain(response.status);
    expect(response.voice_department).toBe("billing");
    expect(response.consulted).toContain("billing");
    const view = ctx.nammaops.workflows.view(response.workflow_id);
    expect(view.tasks.map((t: Any) => t.role)[0]).toBe("billing");
    expect(parseCommand("how many bills did we make yesterday", TODAY)).toMatchObject({
      action: "billing_summary",
      date: "2026-10-31",
    });
    expect(parseCommand("who has not paid their invoices", TODAY).action).toBe(
      "receivables_report",
    );
    expect(parseCommand("give summary on previous 3 day sales", TODAY).action).toBe("daily_report");
  });
});
