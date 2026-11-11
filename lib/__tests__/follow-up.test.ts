import { describe, expect, it } from "vitest";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { createIntentUnderstanding } from "../server/nammaops/intent-llm.mjs";
import { DELEGATION_NAMESPACE, seatChatSession } from "../server/nammaops/delegation.mjs";
import { followUpSubject } from "../server/nammaops/follow-up.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Synthetic TEST FIXTURE only: fixture ERP, in-memory governance, a fake language model. Every test
// goes through `answerDirect`, the entry point of a real one-to-one chat. Nothing here is live.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SEATS = ["Alice", "Bob", "Carol", "Dave", "Erin", "Grace", "Frank"];
const seatOf = (ctx: Any, role: string) =>
  ctx.runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`).seat_id as string;
const sessionOf = (ctx: Any, role: string) =>
  seatChatSession(ctx.runtime, seatOf(ctx, role), "main");
const ask = (ctx: Any, role: string, text: string, taskId: string) =>
  answerDirect(ctx.runtime, {
    taskId,
    message: text,
    seatId: seatOf(ctx, role),
    sessionKey: sessionOf(ctx, role),
  }) as Promise<Any>;
const reply = (ctx: Any, taskId: string) => ctx.runtime.db.getMessage(`dm_reply_${taskId}`) as Any;

const useModel = (ctx: Any, reply: Any | null) => {
  ctx.nammaops.intents = createIntentUnderstanding({
    env: {},
    ...(reply
      ? { client: { models: { generateContent: async () => ({ text: JSON.stringify(reply) }) } } }
      : {}),
    workforce: () => ({ agents: [], voice_departments: ctx.runtime.nammaops.voice.departments }),
    today: () => TODAY,
    seatNames: () => SEATS,
  });
};

const LOW =
  "Please check all products below reorder level and give me the recommended reorder quantities.";
const RESTOCK = "Tell me which products need restocking.";
const FORECAST = "Forecast demand for the next seven days.";
const Q_FORECAST =
  "What were the top products in the previous forecast, and which ones may need replenishment?";
const Q_STOCK = "What happened to the previous stock check? Show me the result again.";

/** The manual reproduction, in order, in Dave's chat. */
async function manualSession(ctx: Any) {
  await ask(ctx, "procurement", FORECAST, "f1");
  await ask(ctx, "procurement", LOW, "s1");
  await ask(ctx, "procurement", RESTOCK, "s2");
  await ask(ctx, "procurement", FORECAST, "f2");
  return {
    forecast1: reply(ctx, "f1").workflowId as string,
    forecast2: reply(ctx, "f2").workflowId as string,
    stock1: ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_s1").workflow_id as string,
    stock2: ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_s2").workflow_id as string,
  };
}
const invocationCount = (ctx: Any) => ctx.runtime.mcpGateway.invocations().length as number;

/** Each model behaviour a follow-up can meet: none, the model's own flag, or a wrong hint. */
const MODELS: Array<[string, Any | null]> = [
  ["keywords only", null],
  [
    "the model flags a follow-up",
    { intent: "demand_forecast", previous_result: true, confidence: 0.95 },
  ],
  ["the model treats it as a new request", { intent: "demand_forecast", confidence: 0.95 }],
];

describe("the manual reproduction: forecast, stock check, stock check, forecast, then follow-ups", () => {
  describe.each(MODELS)("%s", (_name, model) => {
    it("retrieves the previous forecast from Dave's own chat", async () => {
      const ctx: Any = await ready();
      useModel(ctx, model);
      const ids = await manualSession(ctx);
      const out = await ask(ctx, "procurement", Q_FORECAST, "q1");
      expect(out.answered).toMatchObject({ followUp: true, intent: "demand_forecast" });
      // The latest completed forecast in THIS chat, not the earlier one and not a stock check.
      expect(out.answered.workflowId).toBe(ids.forecast2);
      const content = reply(ctx, "q1").content as string;
      expect(content).toMatch(
        /^Earlier demand forecast\. Completed \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. This is the saved result, not a fresh run\./,
      );
      expect(content).toMatch(/expected to sell in the next 7 days/); // top products and quantities
      expect(content).toMatch(/in stock/); // stock (and incoming when present)
      expect(content).toMatch(/from sales \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/); // the period
      expect(content).toMatch(/Evidence: .*Carol/); // saved evidence references
      expect(content).not.toMatch(/No business query with that workflow ID/);
    });

    it("retrieves Bob's completed stock check, resolved through the delegation", async () => {
      const ctx: Any = await ready();
      useModel(ctx, model);
      const ids = await manualSession(ctx);
      const out = await ask(ctx, "procurement", Q_STOCK, "q2");
      expect(out.answered).toMatchObject({ followUp: true, intent: "check_stock" });
      expect(out.answered.workflowId).toBe(ids.stock2);
      const message = reply(ctx, "q2");
      expect(message.content).toMatch(
        /^Earlier check stock \(done by Bob\)\. Completed \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. This is the saved result, not a fresh run\. The full report is in Bob's chat\./,
      );
      expect(message.content).toMatch(/products checked; \d+ at or below reorder level/);
      expect(message.content).toMatch(/reorder level \d+/);
      expect(message.content).toMatch(/Buy \d+ .* Stock \d+/);
      expect(message.content).toMatch(/Evidence: Bob \(Inventory\)/);
      // It points at Bob's chat and Bob's completed report, not at a Dave-owned query.
      const record = ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_s2");
      expect(message).toMatchObject({
        recalled: true,
        delegationId: "dlg_s2",
        linkSeatId: seatOf(ctx, "inventory"),
        linkSessionKey: record.target_conversation_id,
        linkName: "Bob",
        linkMessageId: "dm_report_s2",
      });
    });
  });
});

describe("choosing the right earlier run", () => {
  it("with several stock checks, the previous stock check is the latest completed one", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    expect(ids.stock1).not.toBe(ids.stock2);
    const out = await ask(ctx, "procurement", Q_STOCK, "m1");
    expect(out.answered.workflowId).toBe(ids.stock2);
    expect(out.answered.workflowId).not.toBe(ids.stock1);
  });

  it("with several forecasts, the previous forecast is the latest, and an unrelated newest workflow is ignored", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    expect(ids.forecast1).not.toBe(ids.forecast2);
    // The newest workflow in the whole system is a stock check; the forecast is still the answer.
    await ask(ctx, "procurement", LOW, "s3");
    const out = await ask(ctx, "procurement", Q_FORECAST, "m2");
    expect(out.answered.workflowId).toBe(ids.forecast2);
  });

  it("the words decide, not the model's hint: a stock-check question never returns the forecast", async () => {
    const ctx: Any = await ready();
    useModel(ctx, { intent: "demand_forecast", previous_result: true, confidence: 0.95 });
    const ids = await manualSession(ctx);
    const out = await ask(ctx, "procurement", Q_STOCK, "m3");
    expect(out.answered.intent).toBe("check_stock");
    expect(out.answered.workflowId).toBe(ids.stock2);
  });

  it("without a subject, the newest run in this chat is shown", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    const out = await ask(ctx, "procurement", "give me the previous result again", "m4");
    expect(out.answered.workflowId).toBe(ids.forecast2);
  });
});

describe("conversation isolation", () => {
  it("another seat's chat never exposes this chat's runs", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    await manualSession(ctx);
    // Carol's chat has run nothing: she is told so, not handed Dave's forecast.
    const out = await ask(ctx, "sales", Q_FORECAST, "iso1");
    expect(out.answered.workflowId).toBeNull();
    expect(reply(ctx, "iso1").content).toMatch(
      /could not find an earlier demand forecast in this chat/,
    );
  });

  it("Bob can show the stock check he ran for Dave, from his own chat", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    const out = await ask(
      ctx,
      "inventory",
      "show me the previous stock check result again",
      "iso2",
    );
    expect(out.answered.workflowId).toBe(ids.stock2);
    expect(reply(ctx, "iso2").content).toMatch(/Earlier check stock \(done by Bob\)/);
  });
});

describe("no duplicate execution, and nothing invented", () => {
  it("retrieving a result starts no workflow and makes no ERP call", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    await manualSession(ctx);
    const workflows = ctx.nammaops.workflows.list().length;
    const calls = invocationCount(ctx);
    const delegations = ctx.runtime.db.records(DELEGATION_NAMESPACE).length;
    await ask(ctx, "procurement", Q_FORECAST, "d1");
    await ask(ctx, "procurement", Q_STOCK, "d2");
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows);
    expect(invocationCount(ctx)).toBe(calls);
    expect(ctx.runtime.db.records(DELEGATION_NAMESPACE)).toHaveLength(delegations);
  });

  it("the same result can be retrieved again on a later request, and a retry posts once", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    const first = await ask(ctx, "procurement", Q_STOCK, "r1");
    const later = await ask(ctx, "procurement", Q_STOCK, "r2");
    expect(first.answered.workflowId).toBe(ids.stock2);
    expect(later.answered.workflowId).toBe(ids.stock2);
    const again = await ask(ctx, "procurement", Q_STOCK, "r2");
    expect(again.answered).toMatchObject({ repeat: true });
  });

  it("says plainly when there is no earlier run of that kind, and starts nothing", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    await ask(ctx, "procurement", FORECAST, "n1");
    const workflows = ctx.nammaops.workflows.list().length;
    const out = await ask(
      ctx,
      "procurement",
      "what happened to the previous supplier comparison",
      "n2",
    );
    expect(out.answered.workflowId).toBeNull();
    expect(reply(ctx, "n2").content).toMatch(
      /could not find an earlier supplier comparison in this chat, so I have not shown one and I did not start a new one/,
    );
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows);
  });

  it("an unknown workflow id gives a safe, understandable answer, never the raw error", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    // A message that names a workflow no record backs.
    ctx.runtime.db.saveMessage({
      id: "dm_reply_ghost",
      runId: "",
      sessionKey: sessionOf(ctx, "procurement"),
      seatId: seatOf(ctx, "procurement"),
      role: "assistant",
      actorName: "Dave",
      content: "Earlier answer",
      timestamp: new Date().toISOString(),
      workflowId: "wf_doesnotexist",
      intent: "demand_forecast",
    });
    const out = await ask(ctx, "procurement", Q_FORECAST, "u1");
    expect(out.answered.workflowId).toBeNull();
    expect(reply(ctx, "u1").content).toMatch(/could not find an earlier demand forecast/);
    expect(reply(ctx, "u1").content).not.toMatch(/No business query with that workflow ID/);
  });

  it("a result that can no longer be read is explained, with nothing re-run", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    const voice = ctx.nammaops.voice;
    const real = voice.query.bind(voice);
    voice.query = async (input: Any) => {
      if (input.args?.workflow_id)
        throw Object.assign(new Error("No business query with that workflow ID in this call."), {
          status: 404,
        });
      return real(input);
    };
    const workflows = ctx.nammaops.workflows.list().length;
    const out = await ask(ctx, "procurement", Q_STOCK, "u2");
    expect(out.answered.workflowId).toBe(ids.stock2);
    const content = reply(ctx, "u2").content as string;
    expect(content).toMatch(/could not read the saved result of the earlier check stock any more/);
    expect(content).toMatch(/I did not start a new one/);
    expect(content).not.toMatch(/No business query with that workflow ID/);
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows);
  });
});

describe("new requests keep working after follow-ups", () => {
  it("a low-stock request after a follow-up is still Bob's stock check, and a forecast is still a forecast", async () => {
    const ctx: Any = await ready();
    useModel(ctx, { intent: "demand_forecast", previous_result: true, confidence: 0.95 });
    await manualSession(ctx);
    await ask(ctx, "procurement", Q_STOCK, "k1");
    const low = await ask(ctx, "procurement", LOW, "k2");
    expect(low.answered).toMatchObject({ delegated: true, intent: "check_stock" });
    const forecast = await ask(ctx, "procurement", FORECAST, "k3");
    expect(forecast.answered).toMatchObject({ intent: "demand_forecast" });
    expect(forecast.answered.followUp).toBeUndefined();
    const workflowId = reply(ctx, "k3").workflowId;
    expect(ctx.nammaops.workflows.view(workflowId).intent.action).toBe("demand_forecast");
  });

  it("new-request wording is never read as a follow-up", () => {
    for (const text of [
      LOW,
      RESTOCK,
      FORECAST,
      "Show me all low-stock products.",
      "forecast demand for the last 7 days",
    ])
      expect(followUpSubject(text).isFollowUp).toBe(false);
  });

  it("follow-up wording and its subject are recognised", () => {
    expect(followUpSubject(Q_FORECAST)).toEqual({ isFollowUp: true, intent: "demand_forecast" });
    expect(followUpSubject(Q_STOCK)).toEqual({ isFollowUp: true, intent: "check_stock" });
    expect(followUpSubject("give me the previous report which was running").isFollowUp).toBe(true);
    expect(followUpSubject("give me the previous report which was running").intent).toBeNull();
  });
});

describe("why it failed before: the call id was rebuilt from a message id", () => {
  it("a result posted late (dm_late_…) or a hand-off notice (dm_done_…) has no 'dm_<task>' call to rebuild", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    const db = ctx.runtime.db;
    // A slow forecast posts its answer later as dm_late_<task>, with the same workflow id.
    db.saveMessage({
      id: "dm_late_f2",
      runId: "",
      sessionKey: sessionOf(ctx, "procurement"),
      seatId: seatOf(ctx, "procurement"),
      role: "assistant",
      actorName: "Dave",
      content: "late forecast",
      timestamp: new Date().toISOString(),
      workflowId: ids.forecast2,
      intent: "demand_forecast",
    });
    // The old lookup rebuilt the call id from the NEWEST message id ("dm_late_f2"), which is not the
    // call that started the workflow ("dm_f2"), so the router answered "No business query ...".
    const consult = db
      .records("nammaops.voice_consult")
      .find((row: Any) => row.workflow_id === ids.forecast2);
    expect(consult.call_id).toBe("dm_f2");
    // The follow-up reads the call id from the consult record instead, so it works.
    const out = await ask(ctx, "procurement", Q_FORECAST, "late1");
    expect(out.answered.workflowId).toBe(ids.forecast2);
    expect(reply(ctx, "late1").content).toMatch(/^Earlier demand forecast\./);
  });

  it("a delegated stock check's notice carries Bob's workflow id, which Dave never owned", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const ids = await manualSession(ctx);
    const consults = ctx.runtime.db
      .records("nammaops.voice_consult")
      .filter((row: Any) => row.workflow_id === ids.stock2);
    // The consult for Bob's stock check belongs to the delegation call, not to a Dave chat call.
    expect(consults.map((row: Any) => [row.call_id, row.voice_agent])).toEqual([["dlg_s2", "Bob"]]);
    const out = await ask(ctx, "procurement", Q_STOCK, "late2");
    expect(out.answered.workflowId).toBe(ids.stock2);
  });
});
