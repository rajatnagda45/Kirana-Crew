import { describe, expect, it } from "vitest";
import { OfficeGroupChat } from "../server/office-group-chat.mjs";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { businessIntent } from "../server/nammaops/group-business.mjs";
import { resolveIntent } from "../server/nammaops/intent-contract.mjs";
import { correctStockIntent, createIntentUnderstanding } from "../server/nammaops/intent-llm.mjs";
import { parseCommand } from "../server/nammaops/workflows.mjs";
import { reorderLevelIntent } from "../server/nammaops/stock-language.mjs";
import { DELEGATION_NAMESPACE, seatChatSession } from "../server/nammaops/delegation.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Synthetic TEST FIXTURE only (fixture ERP, a fake language model). Nothing here is live ERPNext
// and no real language model is called.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SEATS = ["Alice", "Bob", "Carol", "Dave", "Erin", "Grace", "Frank"];
const REORDER =
  "Alice, check all products below reorder level and tell me the recommended quantities.";

/** The phrases from the report, and where each must land. */
const STOCK_PHRASES = [
  REORDER,
  "Please check all products below reorder level and give me the recommended reorder quantities.",
  "Which products are below reorder level?",
  "Show me all low-stock products.",
  "Tell me recommended reorder quantities.",
  "How much should I order to bring stock back to the target level?",
];
const FORECAST_PHRASES = [
  "Forecast demand for the next seven days.",
  "Which products will run out in the next seven days?",
];

describe("the shared stock-language rule", () => {
  it.each(STOCK_PHRASES)("is a stock check: %s", (phrase) => {
    expect(reorderLevelIntent(phrase)).toBe("check_stock");
  });
  it.each(FORECAST_PHRASES)("is not, when it is about the future: %s", (phrase) => {
    expect(reorderLevelIntent(phrase)).toBeNull();
  });
  it("leaves orders and plain questions alone", () => {
    for (const text of [
      "create draft purchase orders for products below reorder level",
      "prepare a purchase order for low stock items",
      "what should I order today",
      "check stock of milk and atta",
      "list all products",
    ])
      expect(reorderLevelIntent(text)).toBeNull();
  });
});

describe("keyword reading, for every interface", () => {
  it.each(STOCK_PHRASES)("resolves to Bob's stock check: %s", (phrase) => {
    const hit: Any = resolveIntent(phrase, { today: TODAY, seats: SEATS });
    expect(hit).toMatchObject({ status: "ok", department: "inventory" });
    expect(hit.args.intent).toBe("check_stock");
    // The group's keyword fallback and the typed-command parser agree.
    expect(businessIntent(phrase, { today: TODAY, seats: SEATS })).toMatchObject({
      department: "inventory",
      args: { intent: "check_stock" },
    });
    expect(parseCommand(phrase.replace(/^Alice,\s*/, ""), TODAY)).toMatchObject({
      action: "stock_check",
    });
  });

  it("an explicit forecast is still a demand forecast", () => {
    const hit: Any = resolveIntent(FORECAST_PHRASES[0], { today: TODAY, seats: SEATS });
    expect(hit.args.intent).toBe("demand_forecast");
    expect(parseCommand("forecast demand for the next seven days", TODAY).action).toBe(
      "demand_forecast",
    );
  });

  it('"reorder" no longer starts a purchase order from a stock question, but a real order still does', () => {
    expect(parseCommand("check all products below reorder level", TODAY).action).toBe(
      "stock_check",
    );
    expect(parseCommand("prepare a reorder for the low stock items", TODAY).action).toBe(
      "prepare_reorder",
    );
  });
});

/** A fake language model that makes the mistake from the report: it answers demand_forecast. */
const fakeModel = (intent: string) => ({
  models: {
    generateContent: async () => ({ text: JSON.stringify({ intent, confidence: 0.95 }) }),
  },
});
const understanding = (ctx: Any, intent: string) =>
  createIntentUnderstanding({
    env: {},
    client: fakeModel(intent),
    workforce: () => ({
      agents: [{ role: "inventory", name: "Inventory Agent", purpose: "Stock." }],
      voice_departments: ctx.runtime.nammaops.voice.departments,
    }),
    today: () => TODAY,
    seatNames: () => SEATS,
  });

describe("the language model cannot override plain stock-level wording", () => {
  it("corrects demand_forecast, prepare_purchase_order and list_products to the stock check", () => {
    for (const wrong of ["demand_forecast", "prepare_purchase_order", "list_products"]) {
      const fixed: Any = correctStockIntent(
        { department: "procurement", addressed: null, args: { intent: wrong } },
        REORDER,
      );
      expect(fixed).toMatchObject({ department: "inventory", args: { intent: "check_stock" } });
    }
    // Anything else, or a real forecast, passes through untouched.
    const forecast = { department: "procurement", args: { intent: "demand_forecast" } };
    expect(correctStockIntent(forecast, FORECAST_PHRASES[0])).toBe(forecast);
    const sales = { department: "sales", args: { intent: "sales_summary" } };
    expect(correctStockIntent(sales, REORDER)).toBe(sales);
    expect(correctStockIntent(null, REORDER)).toBeNull();
  });

  it.each(STOCK_PHRASES)(
    "a model that answers demand_forecast still gets Bob's stock check: %s",
    async (phrase) => {
      const ctx: Any = await ready();
      const u = understanding(ctx, "demand_forecast");
      await u.prime(phrase);
      expect(u.resolve(phrase, { today: TODAY, seats: SEATS })).toMatchObject({
        department: "inventory",
        args: { intent: "check_stock" },
      });
      // Group chat reads the cached decision directly (peek); it is corrected there too.
      expect(u.peek(phrase)).toMatchObject({ args: { intent: "check_stock" } });
    },
  );

  it.each(FORECAST_PHRASES)("a real forecast request stays a forecast: %s", async (phrase) => {
    const ctx: Any = await ready();
    const u = understanding(ctx, "demand_forecast");
    await u.prime(phrase);
    expect(u.resolve(phrase, { today: TODAY, seats: SEATS })).toMatchObject({
      args: { intent: "demand_forecast" },
    });
  });

  it("the prompt tells the model stock-level wording is a stock check", async () => {
    const { buildPrompt } = await import("../server/nammaops/intent-llm.mjs");
    const prompt = buildPrompt({ message: REORDER, today: TODAY, workforce: {} as Any });
    expect(prompt).toMatch(/Low stock: 'below \/ at reorder level'[^\n]*=> check_stock/);
    expect(prompt).toMatch(/demand_forecast ONLY for an explicit forecast/);
  });
});

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

describe("Dave's chat: a low-stock question goes to Bob, as a stock check", () => {
  it.each(STOCK_PHRASES.slice(1))(
    "delegates to Bob and answers with the reorder working: %s",
    async (phrase) => {
      const ctx: Any = await ready();
      ctx.nammaops.intents = understanding(ctx, "demand_forecast");
      const taskId = "dave-low";
      const out = await ask(ctx, "procurement", phrase, taskId);
      expect(out.answered).toMatchObject({ delegated: true, intent: "check_stock" });
      const record = ctx.runtime.db.record(DELEGATION_NAMESPACE, `dlg_${taskId}`);
      expect(record.target).toMatchObject({
        department: "inventory",
        agent_id: "nammaops-inventory",
      });
      expect(record.intent).toBe("check_stock");
      const report = ctx.runtime.db.getMessage(`dm_report_${taskId}`);
      expect(report.actorName).toBe("Bob");
      // Not a forecast: a stock check with the reorder working.
      expect(report.content).not.toMatch(/expected to sell in the next/i);
      expect(report.content).toMatch(/products checked; \d+ at or below reorder level/);
      expect(report.content).toMatch(/reorder level \d+/);
      expect(report.content).toMatch(/Buy \d+ .* Stock \d+/);
      expect(report.content).toMatch(
        /target \d+: buy the larger of the reorder quantity \d+ and \d+ - \d+/,
      );
      // Only the inventory workflow ran.
      expect(ctx.nammaops.workflows.view(record.workflow_id).intent.action).toBe("stock_check");
    },
  );
});

describe("the reorder report has everything asked for", () => {
  it("lists total checked, each low product's stock, level, quantity, target and the formula", async () => {
    const ctx: Any = await ready();
    const res: Any = await ctx.nammaops.voice.query({
      call: { id: "rep-1", name: "Bob" },
      actionId: "r1",
      args: { intent: "check_stock" },
    });
    const text = [...res.facts, ...res.recommendations, ...res.limitations].join("\n");
    expect(text).toMatch(/\d+ products checked; \d+ at or below reorder level/);
    expect(text).toMatch(/\d+(\.\d+)? \w+ in stock, reorder level \d+ \(low\)/);
    expect(res.recommendations.length).toBeGreaterThan(0);
    for (const line of res.recommendations)
      expect(line).toMatch(
        /^Buy \d+ .+\. Stock \d+(\.\d+)?, reorder level \d+, target \d+: buy the larger of the reorder quantity \d+ and \d+ - \d+(\.\d+)? = -?\d+(\.\d+)?\.$/,
      );
    expect(text).toMatch(/Buy quantities follow the reorder-level rule/);
    // Supplier information appears only because the quotation read is authorized and available.
    expect(res.evidence.map((e: Any) => e.department)).toEqual(
      expect.arrayContaining(["inventory"]),
    );
  });
});

/** Office group chat as the harness can run it (seven bound seats). */
function groupChat(ctx: Any) {
  ctx.runtime.estop = { status: () => ({ engaged: false }), assertClear: () => {} };
  const names: Record<string, string> = {
    manager: "Alice",
    inventory: "Bob",
    sales: "Carol",
    procurement: "Dave",
    finance: "Erin",
    reports: "Grace",
    billing: "Frank",
  };
  ctx.runtime.rosterSeats = () =>
    Object.entries(names).map(([department, label]) => ({
      seatId: `grp-${department}`,
      label,
      assigned: true,
      binding: { agentId: `nammaops-${department}`, available: true },
    }));
  const baseOwner = ctx.runtime.seatOwner();
  ctx.runtime.seatOwner = () => ({
    ...baseOwner,
    db: ctx.runtime.db,
    seatView: (seat: Any) => ({ ...seat, binding: { ...seat.binding, available: true } }),
  });
  return new OfficeGroupChat(ctx.runtime) as Any;
}
const settle = async (ctx: Any, id: string) => {
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (
      ctx.runtime.db.getMessage(`group_bridge_grp_${id}_business`) ||
      ctx.runtime.db.getMessage(`group_bridge_grp_${id}_synthesis`) ||
      ctx.runtime.db.getMessage(`group_bridge_grp_${id}_blocked`)
    )
      return;
  }
};

describe("Office Group Chat: the same wording, the same answer, the same orchestration", () => {
  it.each(STOCK_PHRASES)("classifies as the stock check: %s", async (phrase) => {
    const ctx: Any = await ready();
    const group = groupChat(ctx);
    // The mistaken model answer is corrected where the group reads it.
    ctx.nammaops.intents = understanding(ctx, "demand_forecast");
    await ctx.nammaops.intents.prime(phrase);
    const intent = group.understoodIntent(phrase);
    expect(intent).toMatchObject({ kind: "business_query", args: { intent: "check_stock" } });
    expect(intent.department).toBe("inventory");
    // Without a model, the group's keyword path lands in the same place.
    ctx.nammaops.intents = createIntentUnderstanding({
      env: {},
      workforce: () => ({}),
      today: () => TODAY,
      seatNames: () => SEATS,
    });
    expect(group.businessIntent(phrase)).toMatchObject({
      kind: "business_query",
      args: { intent: "check_stock" },
    });
  });

  it("a low-stock request in the group is answered by Bob's stock check, not a demand forecast", async () => {
    const ctx: Any = await ready();
    const group = groupChat(ctx);
    ctx.nammaops.intents = understanding(ctx, "demand_forecast");
    group.send({ turnId: "gs1", message: REORDER, langPref: "en" });
    await settle(ctx, "gs1");
    const messages = ctx.runtime.db
      .messages("office:group:main")
      .filter((m: Any) => m.role === "assistant");
    const text = messages.map((m: Any) => `${m.actorName}: ${m.content}`).join("\n");
    expect(text).toMatch(/Bob: /);
    expect(text).toMatch(/products checked; \d+ at or below reorder level/);
    expect(text).toMatch(/Buy \d+ /);
    expect(text).not.toMatch(/Understood: Demand forecast|expected to sell in the next/i);
    // Stays a group conversation: nothing was delegated into individual chats.
    expect(ctx.runtime.db.records(DELEGATION_NAMESPACE)).toEqual([]);
  });

  it("an explicit forecast request is still the demand forecast", async () => {
    const ctx: Any = await ready();
    const group = groupChat(ctx);
    ctx.nammaops.intents = understanding(ctx, "demand_forecast");
    await ctx.nammaops.intents.prime(FORECAST_PHRASES[0]);
    expect(group.understoodIntent(FORECAST_PHRASES[0])).toMatchObject({
      args: { intent: "demand_forecast" },
    });
  });

  it("'check stock and recommend suppliers' uses the authorized collaboration, never a forecast or an order", async () => {
    const ctx: Any = await ready();
    const group = groupChat(ctx);
    ctx.nammaops.intents = createIntentUnderstanding({
      env: {},
      workforce: () => ({}),
      today: () => TODAY,
      seatNames: () => SEATS,
    });
    group.send({ turnId: "gs2", message: "Check stock and recommend suppliers.", langPref: "en" });
    await settle(ctx, "gs2");
    const workflows = ctx.nammaops.workflows.list();
    const actions = workflows.map((w: Any) => w.intent.action);
    expect(actions).not.toContain("demand_forecast");
    expect(actions).not.toContain("prepare_reorder");
    expect(actions.some((a: string) => a === "stock_check" || a === "supplier_comparison")).toBe(
      true,
    );
    // Every governed read ran under a specialist agent inside its own grants.
    const agents = new Set(
      ctx.runtime.mcpGateway
        .invocations()
        .filter((row: Any) => workflows.some((w: Any) => w.id === row.correlation_id))
        .map((row: Any) => row.agent_id),
    );
    expect(agents.has("nammaops-inventory")).toBe(true);
    expect(agents.has("nammaops-manager")).toBe(false);
    expect(ctx.runtime.db.records(DELEGATION_NAMESPACE)).toEqual([]);
  });
});
