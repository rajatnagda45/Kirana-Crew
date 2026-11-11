import { describe, expect, it } from "vitest";
import {
  clarifyIntent,
  resolveIntent,
  toWorkflowIntent,
  validateIntent,
} from "../server/nammaops/intent-contract.mjs";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Synthetic TEST FIXTURE only (fixture "today" is 2026-11-01, a Sunday).
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SEATS = ["Alice", "Bob", "Carol", "Dave", "Erin", "Grace", "Frank"];
const SALES = { intent: "sales_summary" };

describe("validateIntent: well-formed, never a permission", () => {
  it("accepts a supported intent and rejects an unknown one", () => {
    expect(validateIntent({ intent: "sales_summary", day: "yesterday" })).toMatchObject({
      ok: true,
    });
    expect(validateIntent({ intent: "delete_everything" })).toMatchObject({ ok: false });
  });

  it("refuses anything that looks like a PIN or secret, by name", () => {
    for (const key of ["pin", "owner_pin", "passcode", "password", "otp", "token"]) {
      const result: Any = validateIntent({ intent: "sales_summary", [key]: "1234" });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/PIN or any secret/);
    }
  });

  it("refuses fields it does not know (no smuggled tool or capability names)", () => {
    expect(validateIntent({ intent: "sales_summary", capability: "erp.po.submit" })).toMatchObject({
      ok: false,
    });
  });
});

describe("clarifyIntent: ask, never silently pick a period", () => {
  const ask = (message: string | undefined, args: Any = SALES) =>
    clarifyIntent(args, message, TODAY);

  it('asks about "to days" instead of defaulting to today', () => {
    expect(ask("frank tell be about to days sales")?.questions[0]).toMatch(/today|last 2 days/i);
  });

  it("asks about a bare count of days but not when the period is explicit", () => {
    expect(ask("2 days sales")?.questions[0]).toMatch(/last 2 days/);
    expect(ask("do din ki sale")?.questions[0]).toMatch(/last 2 days/);
    expect(ask("sales for last 2 days")).toBeNull();
    expect(ask("pichhle do din ki sale")).toBeNull();
    expect(ask("past three days sales")).toBeNull();
  });

  it("does not ask when the resolver already pinned the period down", () => {
    expect(ask("2 days sales", { ...SALES, day: "2026-10-30", to: "today" })).toBeNull();
    expect(ask("sales on 2026-10-30 and 3 days before", SALES)).toBeNull();
  });

  it("leaves plain, unambiguous questions alone", () => {
    for (const message of [
      "sales today",
      "aaj ki sale",
      "sales yesterday",
      "kal ki sale",
      "sales this week",
      "how much udhaar is pending",
    ])
      expect(ask(message)).toBeNull();
  });

  it("asks about a day in the future for every period-based intent", () => {
    for (const intent of ["sales_summary", "business_report", "gst_summary", "billing_summary"])
      expect(ask(undefined, { intent, day: "2026-11-05" })?.questions[0]).toMatch(/in the future/);
  });

  it("checks only the arguments when there are no words (a Gemini Live tool call)", () => {
    expect(ask(undefined, { ...SALES, day: "yesterday" })).toBeNull();
    expect(ask(undefined, { ...SALES, day: "2026-11-05" })).not.toBeNull();
  });

  it("never second-guesses an intent that is not about a period", () => {
    expect(ask("check stock for 2 days", { intent: "check_stock" })).toBeNull();
  });
});

describe("resolveIntent and toWorkflowIntent", () => {
  it("resolves plain store text with the keyword reader and nothing else", () => {
    const hit: Any = resolveIntent("how much udhaar is pending", { today: TODAY, seats: SEATS });
    expect(hit).toMatchObject({ status: "ok", department: "finance" });
    expect(hit.args.intent).toBe("receivables_report");
    expect(resolveIntent("good morning", { today: TODAY, seats: SEATS })).toEqual({
      status: "none",
    });
  });

  it("uses a supplied resolver when there is one", () => {
    const intents = { resolve: () => ({ department: "sales", addressed: null, args: SALES }) };
    expect(resolveIntent("anything", { intents, today: TODAY, seats: SEATS })).toMatchObject({
      status: "ok",
      department: "sales",
    });
  });

  it("builds the same workflow intent for a single day and a range", () => {
    expect(toWorkflowIntent({ intent: "sales_summary", day: "yesterday" }, TODAY)).toMatchObject({
      action: "daily_report",
      date: "2026-10-31",
    });
    expect(
      toWorkflowIntent({ intent: "sales_summary", day: "2026-10-29", to: "yesterday" }, TODAY),
    ).toMatchObject({ action: "daily_report", date: "2026-10-29", to: "2026-10-31" });
  });
});

describe("the contract is enforced on every path that reaches the router", () => {
  const seatId = (ctx: Any, role: string) =>
    ctx.runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`).seat_id;

  it('direct chat asks about "to days" and starts no workflow', async () => {
    const ctx: Any = await ready();
    const taskId = "t-to-days";
    await answerDirect(ctx.runtime, {
      taskId,
      message: "tell me about to days sales",
      seatId: seatId(ctx, "sales"),
      sessionKey: "agent:main:dm-contract",
    });
    expect(ctx.runtime.db.getMessage(`dm_reply_${taskId}`).content).toMatch(/today|last 2 days/i);
    expect(ctx.nammaops.workflows.list()).toHaveLength(0);
  });

  it("direct chat still answers a clear sales question", async () => {
    const ctx: Any = await ready();
    const out: Any = await answerDirect(ctx.runtime, {
      taskId: "t-clear",
      message: "sales for the last 2 days",
      seatId: seatId(ctx, "sales"),
      sessionKey: "agent:main:dm-contract",
    });
    expect(out.answered.workflowId).toMatch(/^wf_/);
  });

  it("the router (Gemini Live path) refuses a PIN in a tool call and a future day", async () => {
    const ctx: Any = await ready();
    const voice = ctx.nammaops.voice;
    const call = { id: "call-contract", name: "Carol" };
    await expect(
      voice.query({ call, actionId: "a1", args: { intent: "sales_summary", pin: "1234" } }),
    ).rejects.toMatchObject({ status: 400 });
    const future: Any = await voice.query({
      call,
      actionId: "a2",
      args: { intent: "sales_summary", day: "2026-11-09" },
    });
    expect(future.status).toBe("clarification_required");
    expect(ctx.nammaops.workflows.list()).toHaveLength(0);
  });

  it("the router asks about an unclear period when it is given the owner's words", async () => {
    const ctx: Any = await ready();
    const out: Any = await ctx.nammaops.voice.query({
      call: { id: "call-words", name: "Carol" },
      actionId: "b1",
      args: SALES,
      message: "sales for 2 days",
    });
    expect(out.status).toBe("clarification_required");
    expect(out.clarification_questions[0]).toMatch(/last 2 days/);
  });
});
