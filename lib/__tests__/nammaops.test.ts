import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaskDatabase } from "../server/task-db.mjs";
import { AgentProfiles } from "../server/agent-profiles.mjs";
import { AgentTasks } from "../server/agent-tasks.mjs";
import { Specializations } from "../server/developer-config.mjs";
import { McpServers } from "../server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  WORKFLOW_PRINCIPALS,
} from "../server/mcp-governance.mjs";
import { handleMcpApi, mcpRoute } from "../server/mcp-api.mjs";
import { createNammaOps } from "../server/nammaops/index.mjs";
import { loadBinding } from "../server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../server/nammaops/workforce.mjs";
import { parseCommand } from "../server/nammaops/workflows.mjs";
import { rankSuppliers, resolveProducts } from "../server/nammaops/calculations.mjs";
import { handleNammaOpsApi, nammaopsRoute } from "../server/nammaops/api.mjs";
import { NAMMAOPS_OPENAPI } from "../server/nammaops/openapi.mjs";
import Ajv from "ajv";
import { createFixtureErpServer } from "../mcp/fixture-erpnext-server.mjs";
import { VoiceService } from "../server/voice.mjs";
import { VOICE_INTENTS } from "../server/nammaops/voice-router.mjs";
import { runVoiceAgentTool, VOICE_ACTIONS } from "../voice/agent-actions";
import { voiceConfig, NAMMAOPS_BUSINESS_TOOL } from "../voice/config";

// All ERP data here is the synthetic TEST FIXTURE (config/nammaops/fixture-data.json) over an
// in-memory MCP transport, and OpenClaw is a stub seat. Nothing here is live ERPNext or OpenClaw.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const TODAY = "2026-11-01";
const PIN = "4826";
const SEATS = ["seat-m", "seat-i", "seat-s", "seat-p", "seat-f", "seat-r", "seat-b"];

function setup({ reasoning = "off", gatewayStatus = "connected" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nammaops-test-"));
  const dataPath = join(dir, "data.json");
  const statePath = join(dir, "state.json");
  copyFileSync("config/nammaops/fixture-data.json", dataPath);
  const db = new TaskDatabase(":memory:") as Any;
  const transportFactory = () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void createFixtureErpServer({ dataPath, statePath }).connect(serverSide);
    return clientSide;
  };
  const binding = loadBinding();
  const servers = new McpServers(db, {
    policy: { stdio: [binding.server.connection], http: [], cwd: process.cwd() },
    transportFactory: transportFactory as Any,
  });
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => db.close(),
    () => servers.close(),
  );
  const submitted: Any[] = [];
  const owner: Any = {
    gatewayId: "gw",
    gateway: { provider: "openclaw", status: gatewayStatus },
    db,
    resolve: (seatId: string) => ({
      seat: { seatId, binding: { revision: 1 } },
      agentId: "backend",
      sessionKey: `agent:backend:${seatId}`,
    }),
    submit: vi.fn((input: Any) => {
      submitted.push(input);
      db.insertTask({
        taskId: input.taskId,
        gatewayId: "gw",
        agentId: "backend",
        sessionKey: input.sessionKey,
        seatId: input.seatId,
        message: input.message,
        status: "queued",
        createdAt: new Date().toISOString(),
      });
    }),
  };
  const runtime: Any = {
    db,
    gateway: owner.gateway,
    seatOwner: () => owner,
    taskOwner: () => owner,
    estop: { status: () => ({ engaged: false }) },
    rosterSeats: () =>
      SEATS.map((seatId) => ({ seatId, assigned: true, binding: { available: true } })),
  };
  runtime.profiles = new AgentProfiles(runtime);
  runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
  runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
  runtime.mcpServers = servers;
  runtime.capabilities = new CapabilityRegistry(db, servers);
  runtime.governance = new Governance(db, runtime.capabilities, {
    identity: (agentId: string) => {
      if (WORKFLOW_PRINCIPALS.has(agentId)) return { agentId, specializationId: null };
      const profile = runtime.profiles.get(agentId);
      return profile ? { agentId, specializationId: profile.specialization_id ?? null } : null;
    },
  });
  runtime.mcpGateway = new ToolGateway({
    db,
    servers,
    registry: runtime.capabilities,
    governance: runtime.governance,
  });
  let now = new Date("2026-11-01T10:00:00Z");
  const nammaops = createNammaOps(
    runtime,
    {
      NAMMAOPS_OWNER_PIN: PIN,
      NAMMAOPS_REASONING: reasoning,
      NAMMAOPS_REASONING_TIMEOUT_MS: "3000",
    },
    { binding, workforce: loadWorkforce(), today: () => TODAY, now: () => now },
  );
  runtime.nammaops = nammaops;
  return {
    runtime,
    nammaops,
    owner,
    submitted,
    dataPath,
    statePath,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    editData: (edit: (data: Any) => void) => {
      const data = JSON.parse(readFileSync(dataPath, "utf8"));
      edit(data);
      writeFileSync(dataPath, JSON.stringify(data));
    },
    poState: () => JSON.parse(readFileSync(statePath, "utf8")),
  };
}

async function ready(options: Any = {}) {
  const ctx = setup(options);
  const report = await ctx.nammaops.setup({});
  expect(report.blockers).toEqual([]);
  return ctx;
}

const run = async (ctx: Any, input: Any) => (await ctx.nammaops.workflows.start(input)).done;
const W1 = "Check the stock of milk, rice and cooking oil. Tell me what we need to buy tomorrow.";
const W2 =
  "Prepare an order for the products that are running low. Choose the cheapest suitable supplier.";
const W3 = "Tell me how much business I did today, what sold the most and how much profit I made.";

describe("workforce configuration", () => {
  it("1. configures five agents through the same generic layers", async () => {
    const { runtime, nammaops } = await ready();
    const workforce = nammaops.workforce();
    expect(Object.keys(workforce.agents).sort()).toEqual([
      "billing",
      "finance",
      "inventory",
      "manager",
      "procurement",
      "reports",
      "sales",
    ]);
    for (const agent of Object.values(workforce.agents) as Any[]) {
      const profile = runtime.profiles.get(agent.agent_id);
      expect(profile).toMatchObject({
        specialization_id: agent.specialization_id,
        runtime: "openclaw",
      });
      expect(runtime.specializations.get(agent.specialization_id).config.instructions).toMatch(
        /grants no permissions/,
      );
    }
    expect(new Set(Object.values(workforce.agents).map((agent: Any) => agent.seat_id)).size).toBe(
      7,
    );
    const again = await nammaops.setup({});
    expect(again.blockers).toEqual([]);
    expect(runtime.profiles.list()).toHaveLength(7);
  });

  it("2. restricts each specialist to its capabilities; only the principal can submit", async () => {
    const { runtime, nammaops } = await ready();
    const call = (agentId: string, cap: string, args: Any = {}) =>
      runtime.mcpGateway.invoke({
        agentId,
        capabilityId: nammaops.binding.capabilityId(cap),
        arguments: args,
      });
    expect((await call("nammaops-inventory", "erp.stock.balance")).status).toBe("completed");
    expect(
      (await call("nammaops-inventory", "erp.po.create_draft", { supplier: "x", items: [] }))
        .status,
    ).toBe("denied");
    expect((await call("nammaops-sales", "erp.stock.balance")).status).toBe("denied");
    expect((await call("nammaops-manager", "erp.items.list")).status).toBe("denied");
    expect(
      (await call("nammaops-procurement", "erp.po.submit", { name: "PUR-ORD-FX-0001" })).status,
    ).toBe("denied");
    expect(
      (await call("nammaops-finance", "erp.pnl", { from_date: TODAY, to_date: TODAY })).status,
    ).toBe("completed");
    const req: Any = Readable.from([
      Buffer.from(JSON.stringify({ agent_id: "nammaops-po-submit", capability_id: "x" })),
    ]);
    Object.assign(req, {
      method: "POST",
      url: "/api/runtime/mcp-gateway/invoke",
      headers: { "x-agent-town-mcp-secret": "s" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    await expect(
      handleMcpApi(runtime, req, mcpRoute("/api/runtime/mcp-gateway/invoke") as Any, {
        AGENT_TOWN_MCP_PROXY_SECRET: "s",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("intent and products", () => {
  it("4. maps the three owner commands and refuses unsupported operations", () => {
    expect(parseCommand(W1, TODAY)).toEqual({
      action: "stock_check",
      products: ["milk", "rice", "cooking oil"],
    });
    expect(parseCommand(W2, TODAY)).toEqual({ action: "prepare_reorder", products: [] });
    expect(parseCommand(W3, TODAY)).toEqual({ action: "daily_report", date: TODAY });
    expect(parseCommand("How were sales yesterday?", TODAY)).toEqual({
      action: "daily_report",
      date: "2026-10-31",
    });
    expect(() => parseCommand("Delete the milk record", TODAY)).toThrow(/not supported/);
    expect(() => parseCommand("Sing me a song", TODAY)).toThrow(/rephrase/);
  });

  it("4b. validates structured intents", async () => {
    const { nammaops } = await ready();
    expect(() => nammaops.workflows.start({ intent: { action: "drop_tables" } })).toThrow(
      /Invalid intent/,
    );
  });

  it("5. asks for clarification on ambiguous or unknown products", async () => {
    const ctx = await ready();
    const view = await run(ctx, { text: "Check the stock of oil and paneer." });
    expect(view.status).toBe("needs_clarification");
    expect(view.clarifications).toEqual([
      { requested: "oil", reason: "ambiguous", options: ["Sunflower Oil 1L", "Coconut Oil 500ml"] },
      // An unknown name carries the recorded catalogue so the speaker can offer real products.
      { requested: "paneer", reason: "unknown", options: [], categories: expect.any(Object) },
    ]);
    expect(view.summary).toMatch(/Sunflower Oil 1L or Coconut Oil 500ml/);
    const items = JSON.parse(readFileSync("config/nammaops/fixture-data.json", "utf8")).items;
    expect(resolveProducts(["cooking oil"], items).resolved[0].item.item_code).toBe("OIL-SUN-1L");
  });
});

describe("workflow 1: stock intelligence", () => {
  it("6-7. reads ERP stock, compares reorder levels, and reflects ERP changes on rerun", async () => {
    const ctx = await ready();
    const first = await run(ctx, { text: W1 });
    expect(first.status).toBe("completed");
    const row = (view: Any, code: string) =>
      view.result.rows.find((item: Any) => item.item_code === code);
    expect(row(first, "MILK-500")).toMatchObject({
      available: 24,
      reorder_level: 40,
      status: "low",
      recommended_qty: 60,
    });
    expect(row(first, "RICE-5KG")).toMatchObject({ available: 14, status: "ok" });
    expect(row(first, "OIL-SUN-1L")).toMatchObject({ available: 9, status: "low" });
    expect(first.result.recommendations.map((item: Any) => item.choice?.supplier)).toEqual([
      "Bengaluru Wholesale Traders",
      "Mysuru Agro Supplies",
    ]);
    ctx.editData(
      (data) => (data.bins.find((bin: Any) => bin.item_code === "MILK-500").actual_qty = 90),
    );
    const second = await run(ctx, { text: W1 });
    expect(row(second, "MILK-500")).toMatchObject({ available: 96, status: "ok" });
  });

  it("8. compares suppliers on suitability, then price and lead time, disclosing gaps", () => {
    const data = JSON.parse(readFileSync("config/nammaops/fixture-data.json", "utf8"));
    const milk = rankSuppliers("MILK-500", 60, data.supplier_quotations, data.suppliers, TODAY);
    expect(milk.choice.supplier).toBe("Bengaluru Wholesale Traders");
    const dairy = milk.considered.find((row: Any) => row.supplier === "City Dairy Distributors");
    expect(dairy).toMatchObject({ suitable: false, not_suitable_because: ["only 30 available"] });
    expect(dairy.missing).toContain("delivery reliability");
    expect(
      rankSuppliers("OIL-COCO-500", 10, data.supplier_quotations, data.suppliers, TODAY).blocker,
    ).toMatch(/No supplier quotation/);
  });
});

describe("workflow 2: reorder with owner approval", () => {
  const prepare = async (ctx: Any) => {
    const view = await run(ctx, { text: W2 });
    expect(view.status).toBe("awaiting_approval");
    return view;
  };

  it("9. creates draft purchase orders in ERP and asks the owner", async () => {
    const ctx = await ready();
    const view = await prepare(ctx);
    expect(
      view.result.orders.map((po: Any) => [po.supplier, po.docstatus, po.grand_total]),
    ).toEqual([
      ["Bengaluru Wholesale Traders", 0, 1440],
      ["Mysuru Agro Supplies", 0, 3312],
    ]);
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
    expect(
      view.timeline.filter((row: Any) => row.type === "PURCHASE_ORDER_DRAFT_CREATED"),
    ).toHaveLength(2);
    expect(ctx.nammaops.approvals.list().map((row: Any) => row.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("10. submits exactly the approved order after the owner PIN", async () => {
    const ctx = await ready();
    const view = await prepare(ctx);
    const grantsBefore = ctx.runtime.governance.grants().length;
    for (const approvalId of view.result.approvals) {
      const approved = await ctx.nammaops.approvals.approve(approvalId, PIN);
      expect(approved).toMatchObject({ status: "submitted", document_state: "submitted" });
    }
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 1)).toBe(true);
    const done = ctx.nammaops.workflows.view(view.id);
    expect(done.status).toBe("completed");
    expect(
      done.timeline.filter((row: Any) => row.type === "PURCHASE_ORDER_SUBMITTED"),
    ).toHaveLength(2);
    expect(ctx.runtime.governance.grants()).toHaveLength(grantsBefore);
  });

  it("11. rejection submits nothing", async () => {
    const ctx = await ready();
    const view = await prepare(ctx);
    for (const approvalId of view.result.approvals) ctx.nammaops.approvals.reject(approvalId, PIN);
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
    expect(ctx.nammaops.workflows.view(view.id).status).toBe("completed");
  });

  it("12. refuses an expired approval", async () => {
    const ctx = await ready();
    const view = await prepare(ctx);
    ctx.advance(31 * 60 * 1000);
    await expect(
      ctx.nammaops.approvals.approve(view.result.approvals[0], PIN),
    ).rejects.toMatchObject({ status: 409 });
    expect(ctx.poState().purchase_orders[0].docstatus).toBe(0);
  });

  it("13. refuses when the ERP draft changed after it was presented", async () => {
    const ctx = await ready();
    const view = await prepare(ctx);
    const state = ctx.poState();
    state.purchase_orders[0].items[0].qty = 999;
    writeFileSync(ctx.statePath, JSON.stringify(state));
    await expect(ctx.nammaops.approvals.approve(view.result.approvals[0], PIN)).rejects.toThrow(
      /changed/,
    );
    expect(ctx.nammaops.approvals.get(view.result.approvals[0]).status).toBe("invalidated");
    expect(ctx.poState().purchase_orders[0].docstatus).toBe(0);
  });

  it("14. prevents duplicate submission and checks the PIN", async () => {
    const ctx = await ready();
    const view = await prepare(ctx);
    const approvalId = view.result.approvals[0];
    await expect(ctx.nammaops.approvals.approve(approvalId, "0000")).rejects.toMatchObject({
      status: 403,
    });
    await ctx.nammaops.approvals.approve(approvalId, PIN);
    await expect(ctx.nammaops.approvals.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 409,
    });
    const submits = ctx.runtime.mcpGateway
      .invocations()
      .filter((row: Any) => row.capability_id.endsWith("submit_purchase_order"));
    expect(submits.map((row: Any) => row.status)).toEqual(["completed"]);
    expect(submits[0]).toMatchObject({
      agent_id: "nammaops-po-submit",
      correlation_id: approvalId,
    });
  });

  it("22. reports an uncertain submission truthfully and reconciles from ERP", async () => {
    const ctx = await ready();
    const view = await prepare(ctx);
    const realCall = ctx.nammaops.binding.call.bind(ctx.nammaops.binding);
    ctx.nammaops.binding.call = async (agentId: string, cap: string, args: Any, extra: Any) => {
      if (cap === "erp.po.submit") {
        await realCall(agentId, cap, args, extra);
        throw Object.assign(new Error("Connection lost after the request was sent"), {
          workflowStatus: "uncertain",
        });
      }
      return realCall(agentId, cap, args, extra);
    };
    const approvalId = view.result.approvals[0];
    expect((await ctx.nammaops.approvals.approve(approvalId, PIN)).status).toBe("uncertain");
    expect(ctx.nammaops.workflows.view(view.id).status).toBe("awaiting_approval");
    const reconciled = await ctx.nammaops.approvals.reconcile(approvalId);
    expect(reconciled).toMatchObject({ status: "submitted", document_state: "submitted" });
  });
});

describe("workflow 3: daily business report", () => {
  it("15-16. aggregates sales and uses the posted P&L for profit", async () => {
    const ctx = await ready();
    const view = await run(ctx, { text: W3 });
    expect(view.status).toBe("completed");
    expect(view.result).toMatchObject({ total_sales: 3186, transaction_count: 3, warnings: [] });
    expect(view.result.top_products[0]).toMatchObject({ item_code: "RICE-5KG", amount: 1600 });
    expect(view.result.profit).toMatchObject({
      status: "verified",
      net_profit: 484,
      source: "Profit and Loss report",
    });
    ctx.editData((data) =>
      data.sales_invoices.push({
        name: "POS-FX-0003",
        posting_date: TODAY,
        docstatus: 1,
        is_pos: true,
        grand_total: 250,
        items: [{ item_code: "SUGAR-1KG", qty: 5, amount: 250 }],
      }),
    );
    const again = await run(ctx, { text: W3 });
    expect(again.result).toMatchObject({ total_sales: 3436, transaction_count: 4 });
    expect(again.result.warnings[0]).toMatch(/differs from invoice total/);
  });

  it("warns when posted figures are non-trading, such as a stock adjustment credit", async () => {
    const ctx = await ready();
    ctx.editData((data) => {
      data.sales_invoices = [];
      data.pos_invoices = [];
      data.profit_and_loss = [{ date: TODAY, income: 0, expense: -36508, net_profit: 36508 }];
    });
    const view = await run(ctx, { text: W3 });
    expect(view.result.profit).toMatchObject({ status: "verified", net_profit: 36508 });
    expect(view.result.warnings.join(" ")).toMatch(/non-trading postings.*not profit from sales/);
    // An ordinary trading day carries no such warning.
    const normal = await ready();
    expect((await run(normal, { text: W3 })).result.warnings).toEqual([]);
  });

  it("understands 'sell' as a request for the day's sales", () => {
    expect(parseCommand("How much did we sell yesterday?", TODAY)).toEqual({
      action: "daily_report",
      date: "2026-10-31",
    });
    expect(parseCommand("What are we selling today?", TODAY).action).toBe("daily_report");
  });

  it("17. never invents profit when the P&L is missing", async () => {
    const ctx = await ready();
    ctx.editData((data) => (data.profit_and_loss = []));
    const view = await run(ctx, { text: W3 });
    expect(view.status).toBe("partial");
    expect(view.result.profit.status).toBe("unverified");
    expect(view.result.profit.net_profit).toBeUndefined();
    expect(view.summary).toMatch(/profit could not be verified/);
  });
});

describe("demand forecast workflow (fixture)", () => {
  const W4 = "What will sell next week and what should I buy?";
  const find = (view: Any, code: string) =>
    view.result.items.find((row: Any) => row.item_code === code);

  it("routes the command and forecasts from governed evidence per specialist", async () => {
    expect(parseCommand(W4, TODAY)).toEqual({ action: "demand_forecast", products: [] });
    const ctx = await ready();
    const view = await run(ctx, { text: W4 });
    expect(view.status).toBe("completed");
    expect(view.result.label).toMatch(/not a market prediction/);
    expect(view.tasks.map((task: Any) => task.role)).toEqual([
      "sales",
      "inventory",
      "procurement",
      "manager",
    ]);
    const milk = find(view, "MILK-500");
    expect(milk).toMatchObject({ status: "ok", current_stock: 24 });
    expect(milk.backtest.window.days).toBe(14);
    expect(Object.keys(milk.backtest.methods)).toEqual(
      expect.arrayContaining(["ma7", "ma30", "weighted", "weekday"]),
    );
    expect(
      milk.evidence.sales_documents.every((id: string) => /^(HIST-POS-|SINV-FX-|POS-FX-)/.test(id)),
    ).toBe(true);
    expect(milk.recommendation.suggested_qty).toBeGreaterThan(0);
    expect(milk.supplier_comparison.choice.supplier).toBeTruthy();
    expect(view.result.items[0].forecast.next_7_days).toBeGreaterThanOrEqual(
      view.result.items[1].forecast.next_7_days,
    );
  });

  it("flags sparse items, censors stockouts and counts incoming purchase orders", async () => {
    const ctx = await ready();
    const view = await run(ctx, { text: W4 });
    expect(find(view, "GHEE-200").status).toBe("insufficient_evidence");
    const dal = find(view, "DAL-TOOR-1KG");
    expect(dal.history.censored_stockout_days).toEqual([
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(dal.incoming).toEqual([
      { document: "PUR-ORD-FX-OPEN-02", qty: 10, expected: "2026-11-03" },
    ]);
    expect(find(view, "SUGAR-1KG").incoming_stock).toBe(20);
    expect(view.summary).toMatch(/Not enough history to forecast: Ghee 200ml/);
  });

  it("reflects ERP changes: new sales, incoming orders and quotation prices", async () => {
    const ctx = await ready();
    const before = find(await run(ctx, { text: W4 }), "MILK-500");
    ctx.editData((data) => {
      data.sales_invoices.push({
        name: "SINV-FX-SPIKE",
        posting_date: "2026-10-31",
        docstatus: 1,
        is_pos: false,
        grand_total: 4800,
        items: [{ item_code: "MILK-500", qty: 200, amount: 4800 }],
      });
      data.open_purchase_orders.push({
        name: "PUR-ORD-FX-OPEN-03",
        supplier: "City Dairy Distributors",
        docstatus: 1,
        schedule_date: "2026-11-02",
        items: [{ item_code: "MILK-500", qty: 500, received_qty: 0 }],
      });
      data.supplier_quotations.find((row: Any) => row.name === "SQ-FX-0002").available_qty = 5000;
    });
    const after = find(await run(ctx, { text: W4 }), "MILK-500");
    expect(after.history.units_sold).toBe(before.history.units_sold + 200);
    expect(after.evidence.sales_documents).toContain("SINV-FX-SPIKE");
    expect(after.incoming_stock).toBe(500);
    expect(after.recommendation.suggested_qty).toBeLessThan(before.recommendation.suggested_qty);
    if (after.supplier_comparison)
      expect(after.supplier_comparison.choice.supplier).toBe("City Dairy Distributors");
  });
});

describe("failures, evidence and reasoning", () => {
  it("18. stops truthfully when the ERP MCP server is unavailable", async () => {
    const ctx = await ready();
    await ctx.runtime.mcpServers.update("erp-fixture", { enabled: false });
    const view = await run(ctx, { text: W1 });
    expect(view.status).toBe("blocked");
    expect(view.error).toMatch(/unavailable/);
    expect(view.result).toBeNull();
  });

  it("20-21. persists governed evidence per specialist and an ordered timeline", async () => {
    const ctx = await ready();
    const view = await run(ctx, { text: W3 });
    const invocations = ctx.runtime.mcpGateway.invocations();
    for (const task of view.tasks.filter((row: Any) => row.role !== "manager")) {
      expect(task.evidence.length).toBeGreaterThan(0);
      for (const item of task.evidence) {
        const record = invocations.find((row: Any) => row.invocation_id === item.invocation_id);
        expect(record).toMatchObject({
          agent_id: task.agent_id,
          status: "completed",
          correlation_id: view.id,
        });
      }
    }
    expect(view.timeline.map((row: Any) => row.type)).toEqual([
      "WORKFLOW_STARTED",
      "SALES_TASK_STARTED",
      "SALES_TASK_COMPLETED",
      "FINANCE_TASK_STARTED",
      "FINANCE_TASK_COMPLETED",
      "MANAGER_TASK_STARTED",
      "MANAGER_TASK_COMPLETED",
      "WORKFLOW_COMPLETED",
    ]);
  });

  it("3. reasoning mode dispatches one OpenClaw Manager turn and checks its figures", async () => {
    const ctx = await ready({ reasoning: "manager" });
    const pending = ctx.nammaops.workflows.start({ text: W3 });
    await vi.waitFor(() => expect(ctx.submitted).toHaveLength(1));
    const turn = ctx.submitted[0];
    expect(turn.seatId).toBe(ctx.runtime.profiles.get("nammaops-manager").seat_id);
    ctx.runtime.db.updateTask(turn.taskId, {
      status: "completed",
      result: JSON.stringify({
        reply: "Good day.",
        figures: { total_sales: 3186, transactions: 3, net_profit: 484 },
      }),
    });
    const view = await pending.done;
    expect(view.reasoning).toMatchObject({
      mode: "manager",
      status: "accepted",
      reply: "Good day.",
    });

    const wrong = ctx.nammaops.workflows.start({ text: W3 });
    await vi.waitFor(() => expect(ctx.submitted).toHaveLength(2));
    ctx.runtime.db.updateTask(ctx.submitted[1].taskId, {
      status: "completed",
      result: JSON.stringify({
        reply: "Great day!",
        figures: { total_sales: 9999, transactions: 3, net_profit: 484 },
      }),
    });
    expect((await wrong.done).reasoning).toMatchObject({ status: "discarded" });
  });

  it("19. completes from evidence when OpenClaw is unavailable", async () => {
    const ctx = await ready({ reasoning: "manager", gatewayStatus: "disconnected" });
    const view = await run(ctx, { text: W1 });
    expect(view.status).toBe("completed");
    expect(view.reasoning).toMatchObject({ mode: "manager", status: "unavailable" });
  });

  it("serves the REST routes to loopback callers only", async () => {
    const ctx = await ready();
    const request = (method: string, path: string, body?: unknown, address = "127.0.0.1") => {
      const req: Any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method, url: path, headers: {}, socket: { remoteAddress: address } });
      return handleNammaOpsApi(ctx.runtime, req, nammaopsRoute(path) as Any);
    };
    const started: Any = await request("POST", "/api/nammaops/workflows", { text: W1 });
    expect(started.status).toBe(202);
    const dash: Any = await request("GET", "/api/nammaops/dashboard");
    expect(dash.body.data_source).toMatch(/fixture/);
    await expect(
      request("GET", "/api/nammaops/dashboard", undefined, "10.0.0.2"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("OpenAPI contract (fixture)", () => {
  const spec: Any = NAMMAOPS_OPENAPI;
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(JSON.parse(JSON.stringify({ $id: "openapi", components: spec.components })));
  const compile = (schema: Any) =>
    ajv.compile(
      JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"openapi#/components/')),
    );
  const template = (path: string) =>
    Object.keys(spec.paths).find((candidate) =>
      new RegExp(`^${candidate.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path),
    );
  const exercised = new Set<string>();

  async function call(ctx: Any, method: string, path: string, body?: unknown) {
    const req: Any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: {}, socket: { remoteAddress: "127.0.0.1" } });
    let status: number;
    let payload: Any;
    try {
      const result: Any = await handleNammaOpsApi(ctx.runtime, req, nammaopsRoute(path) as Any);
      status = result.status;
      payload = result.body;
    } catch (error: Any) {
      status = error.status;
      payload = error.body ?? { error: error.message };
    }
    const operation = template(path) && spec.paths[template(path)!][method.toLowerCase()];
    if (operation) {
      exercised.add(`${method} ${template(path)}`);
      const documented = operation.responses[String(status)];
      expect(documented, `${method} ${path} returned undocumented ${status}`).toBeTruthy();
      const schema = documented.content?.["application/json"]?.schema;
      if (schema) {
        const validate = compile(schema);
        expect(
          validate(payload),
          `${method} ${path} ${status}: ${ajv.errorsText(validate.errors)}`,
        ).toBe(true);
      }
    }
    return { status, body: payload };
  }

  it("documents and serves every route with responses matching their schemas", async () => {
    const fresh = setup();
    expect(
      (await call(fresh, "POST", "/api/nammaops/workflows", { text: "Check the stock of milk." }))
        .status,
    ).toBe(409);
    expect((await call(fresh, "GET", "/api/nammaops/workforce")).body.workforce).toBeNull();

    const ctx = await ready();
    expect((await call(ctx, "GET", "/api/nammaops/openapi.json")).status).toBe(200);
    expect((await call(ctx, "POST", "/api/nammaops/setup", {})).status).toBe(200);
    for (const path of ["workforce", "binding", "dashboard", "workflows", "approvals"])
      expect((await call(ctx, "GET", `/api/nammaops/${path}`)).status).toBe(200);
    expect((await call(ctx, "GET", "/api/nammaops/dashboards")).status).toBe(200);
    for (const name of ["stock", "selling", "receivables", "gst"])
      expect((await call(ctx, "GET", `/api/nammaops/dashboards/${name}`)).status).toBe(200);
    expect((await call(ctx, "GET", "/api/nammaops/dashboards/stock?from=bad")).status).toBe(400);
    expect((await call(ctx, "GET", "/api/nammaops/dashboards/nope")).status).toBe(404);
    expect((await call(fresh, "GET", "/api/nammaops/dashboards/stock")).status).toBe(409);

    const started = await call(ctx, "POST", "/api/nammaops/workflows", { text: W1 });
    expect(started.status).toBe(202);
    await ctx.nammaops.workflows.view(started.body.workflow.id);
    await run(ctx, { text: W1 });
    expect(
      (
        await call(ctx, "POST", "/api/nammaops/workflows", {
          intent: { action: "daily_report", date: TODAY },
        })
      ).status,
    ).toBe(202);
    expect(
      (await call(ctx, "POST", "/api/nammaops/workflows", { intent: { action: "drop" } })).status,
    ).toBe(400);
    expect((await call(ctx, "POST", "/api/nammaops/workflows", {})).status).toBe(400);
    expect(
      (await call(ctx, "POST", "/api/nammaops/workflows", { text: "delete the milk record" }))
        .status,
    ).toBe(422);
    const id = started.body.workflow.id;
    expect((await call(ctx, "GET", `/api/nammaops/workflows/${id}`)).status).toBe(200);
    expect((await call(ctx, "GET", `/api/nammaops/workflows/${id}/events`)).status).toBe(200);
    expect((await call(ctx, "GET", "/api/nammaops/workflows/wf_missing")).status).toBe(404);
    expect((await call(ctx, "GET", "/api/nammaops/workflows/wf_missing/events")).status).toBe(404);

    const reorder = await run(ctx, { text: W2 });
    const [first, second] = reorder.result.approvals;
    expect(
      (await call(ctx, "POST", `/api/nammaops/approvals/${first}/approve`, { pin: "0000" })).status,
    ).toBe(403);
    expect(
      (await call(ctx, "POST", `/api/nammaops/approvals/${first}/approve`, { pin: PIN })).status,
    ).toBe(200);
    expect(
      (await call(ctx, "POST", `/api/nammaops/approvals/${first}/approve`, { pin: PIN })).status,
    ).toBe(409);
    expect((await call(ctx, "POST", `/api/nammaops/approvals/${first}/reconcile`, {})).status).toBe(
      409,
    );
    expect(
      (await call(ctx, "POST", `/api/nammaops/approvals/${second}/reject`, { pin: PIN })).status,
    ).toBe(200);
    expect(
      (await call(ctx, "POST", "/api/nammaops/approvals/own_missing/reject", { pin: PIN })).status,
    ).toBe(404);

    // Voice queries need a multipart audio upload; a JSON body is refused before any provider runs.
    expect((await call(ctx, "POST", "/api/nammaops/voice-query", {})).status).toBe(415);
    const voices = await call(ctx, "GET", "/api/nammaops/voices");
    expect(voices.status).toBe(200);
    expect(new Set(Object.values(voices.body.voices).map((v: Any) => v.voice)).size).toBe(7);
    expect(
      (await call(ctx, "POST", "/api/nammaops/voices", { voices: { sales: "Nobody" } })).status,
    ).toBe(400);
    expect(
      (await call(ctx, "POST", "/api/nammaops/voices", { voices: { sales: "Tarika" } })).body.voices
        .sales,
    ).toMatchObject({ voice: "Tarika", custom: true });
    const access = await call(ctx, "POST", "/api/nammaops/access-check", {});
    expect(access.status).toBe(200);
    expect(access.body.access_check.passed).toBe(true);
    expect((await call(ctx, "GET", "/api/nammaops/owner-pin")).status).toBe(200);
    expect(
      (await call(ctx, "POST", "/api/nammaops/owner-pin", { current_pin: PIN, new_pin: "12" }))
        .status,
    ).toBe(400);
    expect(
      (await call(ctx, "POST", "/api/nammaops/owner-pin", { current_pin: "0000", new_pin: "5678" }))
        .status,
    ).toBe(403);
    expect(
      (await call(ctx, "POST", "/api/nammaops/owner-pin", { current_pin: PIN, new_pin: PIN }))
        .status,
    ).toBe(200);
    for (const action of ["accept", "decline"])
      expect(
        (await call(ctx, "POST", `/api/nammaops/handoffs/hof_unknown/${action}`, {})).status,
      ).toBe(404);
    expect((await call(ctx, "GET", "/api/nammaops/nope")).status).toBe(404);
    expect((await call(ctx, "DELETE", "/api/nammaops/workflows")).status).toBe(405);

    const documented = Object.entries(spec.paths).flatMap(([path, operations]: [string, Any]) =>
      Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(documented.filter((operation) => !exercised.has(operation))).toEqual([]);
  });

  it("keeps the captured examples valid against their schemas", () => {
    for (const [path, operations] of Object.entries(spec.paths) as Array<[string, Any]>)
      for (const [method, operation] of Object.entries(operations) as Array<[string, Any]>)
        for (const [code, response] of Object.entries(operation.responses) as Array<
          [string, Any]
        >) {
          const content = response.content?.["application/json"];
          if (!content?.example || !content.schema) continue;
          const validate = compile(content.schema);
          expect(
            validate(content.example),
            `${method} ${path} ${code} example: ${ajv.errorsText(validate.errors)}`,
          ).toBe(true);
        }
  });
});

describe("F2 voice department agents (fixture)", () => {
  // Gemini's tool call is simulated: the same client allowlist (runVoiceAgentTool) and server
  // action (VoiceService.action) a live call uses, over the fixture ERP. No Gemini, no OpenClaw.
  const voiceFor = (ctx: Any, name = "Alice", seatId = "seat-0") => {
    const callId = `voice_${name.toLowerCase()}`;
    const db = Object.create(ctx.runtime.db);
    db.getSeat = (id: string) =>
      id === seatId ? { seatId, assigned: true, binding: { revision: 1, agentId: "main" } } : null;
    db.saveRecord("voiceCall", callId, {
      seatId,
      name,
      agentId: "main",
      sessionKey: `agent:main:${seatId}`,
      bindingRevision: 1,
      gatewayId: "gw",
      createdAt: new Date().toISOString(),
    });
    const service = new VoiceService({ gatewayId: "gw", db, nammaops: ctx.nammaops });
    let n = 0;
    return (args: Any, tool = "nammaops_business_query", actionId = `act_${++n}`) =>
      runVoiceAgentTool(tool, args, (name: string, parameters: Any) =>
        service.action({ tool: name, callId, actionId, args: parameters }),
      ) as Promise<Any>;
  };

  it("registers the business tool for department seats only, in both allowlists", () => {
    const base: Any = {
      seatId: "seat-0",
      name: "Alice",
      role: "Worker",
      status: "idle",
      gatewayConnected: true,
      tasks: [],
      conversation: [],
    };
    const names = (agent: Any) =>
      (voiceConfig(agent).tools?.[0] as Any).functionDeclarations.map((row: Any) => row.name);
    expect(names(base)).not.toContain("nammaops_business_query");
    const department = {
      department: "manager",
      title: "Store Manager",
      colleagues: [],
      background: [],
    };
    expect(names({ ...base, department })).toContain("nammaops_business_query");
    expect(String(voiceConfig({ ...base, department }).systemInstruction)).toMatch(
      /Answer only from that tool's result/,
    );
    // The source must be relayed from the result, never assumed (a live call said "fixture").
    const prompt = String(voiceConfig({ ...base, department }).systemInstruction);
    expect(prompt).toMatch(/data source exactly as the result's limitations describe it/);
    expect(prompt).not.toMatch(/including when the data source is test fixture/);
    expect(NAMMAOPS_BUSINESS_TOOL.parameters.properties.intent.enum).toEqual(
      Object.keys(VOICE_INTENTS),
    );
    expect(VOICE_ACTIONS.has("nammaops_business_query")).toBe(true);
    expect(VOICE_ACTIONS.has("approve_purchase_order")).toBe(false);
  });

  it("maps voice intents to the workflows that compute them", () => {
    expect(VOICE_INTENTS).toEqual({
      list_products: "stock_check",
      check_stock: "stock_check",
      sales_summary: "daily_report",
      top_selling_products: "daily_report",
      business_profit: "daily_report",
      demand_forecast: "demand_forecast",
      supplier_comparison: "supplier_comparison",
      prepare_purchase_order: "prepare_reorder",
      receivables_report: "receivables_report",
      expiry_check: "expiry_check",
      purchase_status: "purchase_status",
      supplier_performance: "supplier_performance",
      customer_insights: "customer_insights",
      store_health_report: "store_health_report",
      business_report: "business_report",
      billing_summary: "billing_summary",
      payments_summary: "payments_summary",
      gst_summary: "gst_summary",
      purchase_order_lookup: "purchase_order_lookup",
    });
    // Typed commands: a comparison request compares; ordering with a supplier preference reorders.
    expect(parseCommand("Compare supplier quotations for milk and sugar", TODAY)).toEqual({
      action: "supplier_comparison",
      products: ["milk", "sugar"],
    });
    expect(parseCommand(W2, TODAY)).toEqual({ action: "prepare_reorder", products: [] });
  });

  it("maps Alice, Bob, Carol, Dave and Erin to departments from configuration only", async () => {
    const ctx = await ready();
    const router = ctx.nammaops.voice;
    expect(router.department("Alice")).toMatchObject({ department: "manager" });
    expect(router.department("bob")).toMatchObject({ department: "inventory" });
    expect(router.department("Carol")).toMatchObject({ department: "sales" });
    expect(router.department("Dave")).toMatchObject({ department: "procurement" });
    expect(router.department("Erin")).toMatchObject({ department: "finance", title: "Finance" });
    expect(router.department("Alice")?.background).toEqual([]);
    expect(router.department("Alice")?.colleagues.map((c: Any) => c.name)).toContain("Erin");
    expect(router.department("Rahul")).toBeNull();
    // A seat that is not a department gets nothing, and a department grants no ERP capability.
    await expect(
      voiceFor(ctx, "Rahul", "analyze")({ intent: "check_stock" }),
    ).rejects.toMatchObject({ status: 403 });
    const subjects = ctx.runtime.governance.grants().map((row: Any) => row.subject);
    expect(subjects.some((subject: string) => /alice|bob|carol|dave|voice/i.test(subject))).toBe(
      false,
    );
  });

  it("1. stock: Alice answers through the Inventory workflow with evidence", async () => {
    const ctx = await ready();
    const out = await voiceFor(ctx)({ intent: "check_stock", products: ["milk", "rice"] });
    expect(out).toMatchObject({
      status: "completed",
      intent: "check_stock",
      source: "fixture",
      clarification_required: false,
      approval_required: false,
    });
    expect(out.facts.join(" ")).toMatch(/Toned Milk 500ml: \d+ Nos in stock, reorder level 40/);
    expect(out.consulted).toContain("inventory");
    const inventory = out.evidence.find((row: Any) => row.department === "inventory");
    expect(inventory.capabilities).toEqual(["erp.items.list", "erp.stock.balance"]);
    expect(inventory.invocation_ids.length).toBe(2);
    expect(out.limitations[0]).toMatch(/test fixture/);
    const view = ctx.nammaops.workflows.view(out.workflow_id);
    expect(view.origin).toMatchObject({
      channel: "voice",
      voice_agent: "Alice",
      voice_department: "manager",
      voice_intent: "check_stock",
    });
    expect(view.timeline.some((row: Any) => row.type === "VOICE_CONSULT")).toBe(true);
  });

  it("lists every product by category, and offers real products for an unknown word", async () => {
    const ctx = await ready();
    const ask = voiceFor(ctx);
    const all = await ask({ intent: "list_products" });
    expect(all.status).toBe("completed");
    expect(all.consulted).toContain("inventory");
    const view = ctx.nammaops.workflows.view(all.workflow_id);
    const count = view.result.rows.length;
    expect(all.facts[0]).toMatch(new RegExp(`^${count} products in \\d+ categor`));
    // Never truncated: every product name appears.
    for (const row of view.result.rows) expect(all.facts.join(" ")).toContain(row.item_name);
    const unknown = await ask({ intent: "check_stock", products: ["electronics"] });
    expect(unknown.status).toBe("clarification_required");
    expect(unknown.facts.join(" ")).toContain("Toned Milk 500ml");
    expect(unknown.limitations.join(" ")).toMatch(/closest recorded products/);
  });

  it("a category name selects every item in that ERP item group", () => {
    const items = [
      { item_code: "DAL", item_name: "Toor Dal 1kg", item_group: "Staples", aliases: ["Staples"] },
      { item_code: "RICE", item_name: "Rice 5kg", item_group: "Staples", aliases: ["Staples"] },
      { item_code: "MILK", item_name: "Milk", item_group: "Dairy", aliases: ["Dairy"] },
    ];
    expect(resolveProducts(["staples"], items).resolved.map((row) => row.item.item_code)).toEqual([
      "DAL",
      "RICE",
    ]);
    expect(resolveProducts(["dal"], items).resolved[0].item.item_code).toBe("DAL");
    const missing = resolveProducts(["electronics"], items).clarifications[0];
    expect(missing).toMatchObject({ reason: "unknown" });
    expect(missing.categories).toEqual({ Staples: ["Toor Dal 1kg", "Rice 5kg"], Dairy: ["Milk"] });
  });

  it("2-3. sales and top products come from the requested day's fixture invoices", async () => {
    const ctx = await ready();
    const ask = voiceFor(ctx, "Carol", "seat-2");
    const today = await ask({ intent: "sales_summary", day: "today" });
    expect(today.facts[0]).toBe(
      "Sales on 2026-11-01: ₹3,186 from 3 bills, an average of ₹1,062 a bill.",
    );
    expect(today.facts[1]).toBe(
      "Top sellers: Sona Masoori Rice 5kg (4 sold, ₹1,600), Toned Milk 500ml (42 sold, ₹1,136), Sunflower Oil 1L (3 sold, ₹450).",
    );
    // A sales question stays about sales: the P&L is not read and no accounting caveats appear.
    expect(today.consulted).toEqual(["sales"]);
    expect(today.limitations.join(" ")).not.toMatch(/non-trading|Net profit/);
    expect(today.documents.length).toBe(3);
    const top = await ask({ intent: "top_selling_products", day: "today" });
    expect(top.facts[0]).toMatch(
      /^#1 on 2026-11-01: Sona Masoori Rice 5kg, \d+ sold for ₹1,600\.$/,
    );
    const yesterday = await ask({ intent: "sales_summary", day: "yesterday" });
    const report = ctx.nammaops.workflows.view(yesterday.workflow_id);
    expect(report.intent.date).toBe("2026-10-31");
    expect(report.result.profit).toEqual({ status: "not_requested" });
    expect(yesterday.facts[0]).toContain(`from ${report.result.transaction_count} bill`);
    const future = await ask({ intent: "sales_summary", day: "2026-12-01" });
    expect(future).toMatchObject({
      status: "clarification_required",
      clarification_required: true,
      workflow_id: null,
    });
  });

  it("profit comes only from the posted P&L, never estimated", async () => {
    const ctx = await ready();
    const ask = voiceFor(ctx);
    const verified = await ask({ intent: "business_profit", day: "today" });
    expect(verified.facts[0]).toMatch(
      /^Net profit on 2026-11-01: ₹484 .*posted Profit and Loss report\.$/,
    );
    expect(verified.consulted).toContain("finance");
    ctx.editData((data) => (data.profit_and_loss = []));
    const missing = await ask({ intent: "business_profit", day: "today" });
    expect(missing.status).toBe("unavailable");
    expect(missing.facts).toEqual([]);
    expect(missing.limitations.join(" ")).toMatch(/could not be verified[\s\S]*never estimated/);
  });

  it("4. demand forecast consults Sales, Inventory and Procurement and states its limits", async () => {
    const ctx = await ready();
    const out = await voiceFor(ctx)({ intent: "demand_forecast" });
    expect(["completed", "partial"]).toContain(out.status);
    expect(out.consulted).toEqual(expect.arrayContaining(["sales", "inventory", "procurement"]));
    expect(out.recommendations.length).toBeGreaterThan(0);
    const view = ctx.nammaops.workflows.view(out.workflow_id);
    const first = view.result.items.find((row: Any) => row.recommendation?.suggested_qty > 0);
    expect(out.recommendations.join(" ")).toContain(
      `Order ${first.recommendation.suggested_qty} ${first.item_name}`,
    );
    const limits = out.limitations.join(" ");
    expect(limits).toMatch(/not a market prediction/);
    expect(limits).toMatch(/Ghee 200ml: not enough sales history/);
    expect(limits).toMatch(/Toor Dal 1kg: \d+ stockout day\(s\) excluded/);
  });

  it("5. supplier comparison uses quotations, not the forecast", async () => {
    const ctx = await ready();
    const ask = voiceFor(ctx, "Dave", "seat-3");
    const out = await ask({ intent: "supplier_comparison", products: ["milk"] });
    expect(out.status).toBe("completed");
    const view = ctx.nammaops.workflows.view(out.workflow_id);
    expect(view.intent).toEqual({ action: "supplier_comparison", products: ["milk"] });
    expect(view.tasks.map((task: Any) => task.title)).toEqual(
      expect.arrayContaining(["Identify the products to compare", "Compare supplier quotations"]),
    );
    const procurement = out.evidence.find((row: Any) => row.department === "procurement");
    expect(procurement.capabilities).toEqual([
      "erp.suppliers.list",
      "erp.supplier_quotations.list",
      "erp.item_prices.get",
    ]);
    expect(out.evidence.some((row: Any) => row.capabilities.includes("erp.sales.history"))).toBe(
      false,
    );
    expect(out.documents).toEqual(expect.arrayContaining(["SQ-FX-0001", "SQ-FX-0002"]));
    // Same ranking rules as the reorder workflow (rankSuppliers) for the same quantity.
    const ranked = view.result.items[0];
    expect(ranked).toMatchObject(
      rankSuppliers(
        "MILK-500",
        60,
        JSON.parse(readFileSync(ctx.dataPath, "utf8")).supplier_quotations,
        JSON.parse(readFileSync(ctx.dataPath, "utf8")).suppliers,
        TODAY,
      ),
    );
    expect(out.recommendations[0]).toContain(`${ranked.choice.supplier} at ${ranked.choice.rate}`);
    expect(out.limitations.join(" ")).toMatch(
      /compared for 60 unit\(s\), the item's reorder quantity/,
    );
    const big = await ask({ intent: "supplier_comparison", products: ["milk"], qty: 150 });
    expect(ctx.nammaops.workflows.view(big.workflow_id).result.items[0].qty).toBe(150);
    const none = await ask({ intent: "supplier_comparison" });
    expect(none).toMatchObject({
      status: "clarification_required",
      clarification_questions: ["Which product should I compare suppliers for?"],
    });
  });

  it("6-7. unknown products ask for clarification; missing data is reported honestly", async () => {
    const ctx = await ready();
    const unknown = await voiceFor(
      ctx,
      "Bob",
      "seat-1",
    )({
      intent: "check_stock",
      products: ["paneer"],
    });
    expect(unknown).toMatchObject({
      status: "clarification_required",
      clarification_required: true,
    });
    // Facts are only the recorded catalogue (no stock numbers, no invented product).
    expect(unknown.facts.join(" ")).toContain("Toned Milk 500ml");
    expect(unknown.facts.join(" ")).not.toMatch(/paneer|in stock/i);
    expect(unknown.clarification_questions[0]).toMatch(/could not find "paneer"/);
    ctx.editData((data) => {
      data.sales_invoices = [];
      data.pos_invoices = [];
    });
    const empty = await voiceFor(
      ctx,
      "Carol",
      "seat-2",
    )({
      intent: "top_selling_products",
      day: "today",
    });
    expect(empty.status).toBe("no_data");
    expect(empty.facts[0]).toMatch(/No submitted sales are recorded for 2026-11-01/);
  });

  it("8-9. purchase recommendations create drafts only; voice cannot approve; the panel path still works", async () => {
    const ctx = await ready();
    const ask = voiceFor(ctx);
    const out = await ask({ intent: "prepare_purchase_order" });
    expect(out).toMatchObject({ status: "awaiting_approval", approval_required: true });
    expect(out.facts.every((fact: string) => /draft and has not been sent/.test(fact))).toBe(true);
    expect(out.facts.join(" ")).toMatch(/\d+ Toned Milk 500ml/);
    expect(out.recommendations[0]).toMatch(/owner approves a draft with their PIN/);
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
    // No voice tool can approve: unknown tools are refused, and a PIN argument is rejected.
    expect(
      await ask({ approval_id: out.approvals[0].approval_id }, "approve_purchase_order"),
    ).toMatchObject({ error: expect.stringMatching(/Unsupported voice action/) });
    await expect(ask({ intent: "prepare_purchase_order", pin: PIN })).rejects.toMatchObject({
      status: 400,
    });
    expect(ctx.nammaops.approvals.list().every((row: Any) => row.status === "pending")).toBe(true);
    // The existing owner panel path (PIN) is unchanged.
    const [first, second] = out.approvals.map((row: Any) => row.approval_id);
    expect((await ctx.nammaops.approvals.approve(first, PIN)).status).toBe("submitted");
    expect(ctx.nammaops.approvals.reject(second, PIN).status).toBe("rejected");
  });

  it("logs every background consultation and never starts a workflow twice per tool call", async () => {
    const ctx = await ready();
    const ask = voiceFor(ctx);
    const one = await ask({ intent: "check_stock", products: ["milk"] }, undefined, "same-action");
    const again = await ask(
      { intent: "check_stock", products: ["milk"] },
      undefined,
      "same-action",
    );
    expect(again.workflow_id).toBe(one.workflow_id);
    expect(ctx.nammaops.workflows.list().length).toBe(1);
    await expect(
      ask({ intent: "demand_forecast" }, undefined, "same-action"),
    ).rejects.toMatchObject({ status: 409 });
    const consults = ctx.runtime.db.records("nammaops.voice_consult");
    expect(consults).toHaveLength(1);
    expect(consults[0]).toMatchObject({
      call_id: "voice_alice",
      voice_agent: "Alice",
      voice_department: "manager",
      intent: "check_stock",
      workflow_id: one.workflow_id,
      status: "completed",
      consulted: ["inventory", "procurement"],
    });
    const followUp = await ask({ workflow_id: one.workflow_id });
    expect(followUp.facts).toEqual(one.facts);
    await expect(
      voiceFor(ctx, "Bob", "seat-1")({ workflow_id: one.workflow_id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("'what should I order tomorrow': forecast, then drafts, with every department's evidence", async () => {
    const ctx = await ready();
    const ask = voiceFor(ctx);
    const forecast = await ask({ intent: "demand_forecast" });
    const drafts = await ask({ intent: "prepare_purchase_order" });
    expect(new Set([...forecast.consulted, ...drafts.consulted])).toEqual(
      new Set(["sales", "inventory", "procurement"]),
    );
    expect(drafts.approval_required).toBe(true);
    expect(ctx.runtime.db.records("nammaops.voice_consult").map((row: Any) => row.intent)).toEqual([
      "demand_forecast",
      "prepare_purchase_order",
    ]);
  });
});
