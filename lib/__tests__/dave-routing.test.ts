import { describe, expect, it } from "vitest";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { correctStockIntent, createIntentUnderstanding } from "../server/nammaops/intent-llm.mjs";
import { DELEGATION_NAMESPACE, seatChatSession } from "../server/nammaops/delegation.mjs";
import { reorderLevelIntent } from "../server/nammaops/stock-language.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Synthetic TEST FIXTURE only: fixture ERP, in-memory governance, a fake language model. These tests
// go through the same entry point as Dave's real individual chat (`answerDirect`); nothing is live.
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

/** A fake language model that answers every message with the same JSON. */
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

const LOW_STOCK = [
  "Check all products below reorder level and give me recommended quantities.",
  "Please check all products below reorder level.",
  "Show me all low-stock products.",
  "Which products are at or below their reorder levels?",
  "Give me the current stock report and recommended reorder quantities.",
  "Tell me which products need restocking.",
];
const FORECAST = [
  "Forecast demand for the next seven days.",
  "Predict which products will sell the most next week.",
  "Use historical sales to estimate next week's demand.",
];

/** How the model (or its absence) can behave. Each was tried against the running logic. */
const MODEL_BEHAVIOURS: Array<[string, Any | null]> = [
  ["no model, keywords only", null],
  ["the model answers demand_forecast", { intent: "demand_forecast", confidence: 0.95 }],
  [
    "the model reuses the earlier forecast as a follow-up",
    { intent: "demand_forecast", previous_result: true, confidence: 0.95 },
  ],
  [
    "the model says several things at once",
    { intent: "check_stock", multiple: true, confidence: 0.95 },
  ],
  ["the model is unsure", { intent: "demand_forecast", confidence: 0.2 }],
];

/** Everything that must be true of a delegated stock check, proved from records, not display names. */
function expectBobStockCheck(ctx: Any, taskId: string, out: Any) {
  const db = ctx.runtime.db;
  expect(out.answered).toMatchObject({ delegated: true, intent: "check_stock" });
  const record = db.record(DELEGATION_NAMESPACE, `dlg_${taskId}`);
  // 8. The displayed intent is the executed workflow.
  expect(record.intent).toBe("check_stock");
  expect(record.target).toMatchObject({ department: "inventory", agent_id: "nammaops-inventory" });
  const view = ctx.nammaops.workflows.view(record.workflow_id);
  expect(view.intent.action).toBe("stock_check");
  expect(db.getMessage(`dm_report_${taskId}`)).toMatchObject({
    actorName: "Bob",
    intent: "check_stock",
    workflowId: record.workflow_id,
  });
  expect(db.getMessage(`dm_reply_${taskId}`).intent).toBe("check_stock");
  expect(db.getMessage(`dm_report_${taskId}`).content).not.toMatch(/expected to sell in the next/);
  const invocations = ctx.runtime.mcpGateway
    .invocations()
    .filter((row: Any) => row.correlation_id === record.workflow_id);
  // 6. Dave runs no inventory tool himself: Bob's agent made the stock reads.
  const inventoryCapabilities = new Set(
    ["erp.stock.balance", "erp.stock.ledger", "erp.stock.movements", "erp.batches.list"].map((c) =>
      ctx.nammaops.binding.capabilityId(c),
    ),
  );
  const byDave = invocations.filter((row: Any) => row.agent_id === "nammaops-procurement");
  expect(byDave.filter((row: Any) => inventoryCapabilities.has(row.capability_id))).toEqual([]);
  expect(
    invocations.some(
      (row: Any) =>
        row.agent_id === "nammaops-inventory" &&
        row.capability_id === ctx.nammaops.binding.capabilityId("erp.stock.balance"),
    ),
  ).toBe(true);
  // 7. No draft purchase order and no write of any kind.
  for (const row of invocations) {
    const capability = ctx.nammaops.binding
      .status()
      .find(
        (s: Any) => ctx.nammaops.binding.capabilityId(s.business_capability) === row.capability_id,
      );
    expect(capability?.risk).toBe("READ");
  }
  expect(ctx.nammaops.workflows.list().map((w: Any) => w.intent.action)).not.toContain(
    "prepare_reorder",
  );
}

describe("Dave's individual chat: low-stock wording is Bob's stock check, however the model behaves", () => {
  // Dave's chat already holds an earlier forecast: the situation in which a model reuses its intent.
  describe.each(MODEL_BEHAVIOURS)("%s", (_name, reply) => {
    it.each(LOW_STOCK)("%s", async (phrase) => {
      const ctx: Any = await ready();
      useModel(ctx, reply);
      await ask(ctx, "procurement", "forecast demand for the next seven days", "hist");
      const out = await ask(ctx, "procurement", phrase, "low");
      expectBobStockCheck(ctx, "low", out);
    });
  });

  it("the first message in a fresh chat takes the same route", async () => {
    const ctx: Any = await ready();
    useModel(ctx, { intent: "demand_forecast", confidence: 0.95 });
    const out = await ask(ctx, "procurement", LOW_STOCK[0], "fresh");
    expectBobStockCheck(ctx, "fresh", out);
  });
});

describe("genuine forecasts, supplier comparison and procurement overview are untouched", () => {
  describe.each(MODEL_BEHAVIOURS.slice(0, 2))("%s", (_name, reply) => {
    it.each(FORECAST)("%s", async (phrase) => {
      const ctx: Any = await ready();
      useModel(ctx, reply);
      const out = await ask(ctx, "procurement", phrase, "fc");
      expect(out.answered.intent).toBe("demand_forecast");
      // Dave owns forecasts: no hand-off, and the executed workflow is the forecast.
      expect(out.answered.delegated).toBeUndefined();
      const workflowId = ctx.runtime.db.getMessage("dm_reply_fc").workflowId;
      expect(ctx.nammaops.workflows.view(workflowId).intent.action).toBe("demand_forecast");
    });
  });

  it("a forecast in the middle of a chat that had a stock check is still a forecast", async () => {
    const ctx: Any = await ready();
    useModel(ctx, { intent: "demand_forecast", confidence: 0.95 });
    await ask(ctx, "procurement", LOW_STOCK[0], "mix1");
    const out = await ask(ctx, "procurement", FORECAST[0], "mix2");
    expect(out.answered.intent).toBe("demand_forecast");
  });

  it("supplier comparison stays supplier comparison, in Dave's own department", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const out = await ask(ctx, "procurement", "compare supplier quotations for milk", "sc");
    expect(out.answered.intent).toBe("supplier_comparison");
    expect(out.answered.delegated).toBeUndefined();
    const workflowId = ctx.runtime.db.getMessage("dm_reply_sc").workflowId;
    expect(ctx.nammaops.workflows.view(workflowId).intent.action).toBe("supplier_comparison");
  });

  it("procurement overview stays procurement overview", async () => {
    const ctx: Any = await ready();
    useModel(ctx, null);
    const out = await ask(ctx, "procurement", "tell me about procurement", "po");
    expect(out.answered.intent).toBe("procurement_overview");
    const workflowId = ctx.runtime.db.getMessage("dm_reply_po").workflowId;
    expect(ctx.nammaops.workflows.view(workflowId).intent.action).toBe("procurement_overview");
  });
});

describe("a real follow-up is still a follow-up", () => {
  it("'what happened to that?' after a forecast keeps the model's follow-up reading", () => {
    const followup = {
      followup: true,
      department: null,
      addressed: null,
      args: { intent: "demand_forecast" },
    };
    for (const text of [
      "what happened to the previous forecast",
      "give me the previous report which was running",
      "is the earlier stock check ready yet",
    ])
      expect(correctStockIntent(followup, text)).toBe(followup);
    // Without stock-level wording it is never touched.
    expect(correctStockIntent(followup, "what happened to that")).toBe(followup);
  });

  it("a follow-up flag on a stock-level request is turned into the new request it is", () => {
    const followup = {
      followup: true,
      department: null,
      addressed: null,
      args: { intent: "demand_forecast" },
    };
    for (const text of LOW_STOCK)
      expect(correctStockIntent(followup, text)).toMatchObject({
        department: "inventory",
        args: { intent: "check_stock" },
      });
    // Even a model-chosen "none" intent behind the follow-up flag.
    expect(
      correctStockIntent({ followup: true, args: { intent: "none" } }, LOW_STOCK[0]),
    ).toMatchObject({ args: { intent: "check_stock" } });
  });
});

describe("the stock-language rule covers the wording owners actually use", () => {
  it.each(LOW_STOCK)("%s", (phrase) => {
    expect(reorderLevelIntent(phrase)).toBe("check_stock");
  });
  it.each(FORECAST)("not: %s", (phrase) => {
    expect(reorderLevelIntent(phrase)).toBeNull();
  });
});

describe("Alice and group chat are unchanged by this fix", () => {
  it("Alice still delegates the low-stock request to Bob alone", async () => {
    const ctx: Any = await ready();
    useModel(ctx, { intent: "demand_forecast", previous_result: true, confidence: 0.95 });
    await ask(ctx, "manager", "forecast demand for the next seven days", "ah");
    await ask(ctx, "manager", LOW_STOCK[0], "al");
    const subtasks = ctx.runtime.db.record("nammaops.dm_coordination", "coord_al").subtasks;
    expect(subtasks.map((s: Any) => [s.name, s.intent])).toEqual([["Bob", "check_stock"]]);
  });
});
