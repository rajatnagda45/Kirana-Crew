import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createNammaOps } from "../server/nammaops/index.mjs";
import { loadBinding } from "../server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../server/nammaops/workforce.mjs";
import { applyBillAnswer, parseBillRequest, parseV2 } from "../server/nammaops/workflows-v2.mjs";
import { validateDecision } from "../server/nammaops/intent-llm.mjs";
import { resolveProducts } from "../server/nammaops/calculations.mjs";
import { UNKNOWN_BLOCK_MS } from "../server/task-db.mjs";
import { parseCommand } from "../server/nammaops/workflows.mjs";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { businessIntent } from "../server/nammaops/group-business.mjs";
import { classifyIntent } from "../server/routing/intent-classifier.mjs";
import { classify, liveWriteBlocked } from "../server/nammaops/approval-policy.mjs";
import { createFixtureErpServer } from "../mcp/fixture-erpnext-server.mjs";
import { VoiceService } from "../server/voice.mjs";
import { runVoiceAgentTool } from "../voice/agent-actions";

// Synthetic TEST FIXTURE ERP over an in-memory MCP transport; OpenClaw is a stub. These tests cover
// Frank preparing a draft customer bill and the owner approving it with the PIN: the same flow the
// live ERP uses, against fixture data, never live ERPNext.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const TODAY = "2026-11-01";
const PIN = "90417352";
const SPOKEN_PIN = "nine zero four one seven three five two";
const SEATS = ["seat-m", "seat-i", "seat-s", "seat-p", "seat-f", "seat-r", "seat-b"];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "nammaops-billing-"));
  const dataPath = join(dir, "data.json");
  const statePath = join(dir, "state.json");
  copyFileSync("config/nammaops/fixture-data.json", dataPath);
  const db = new TaskDatabase(":memory:") as Any;
  const binding = loadBinding();
  const servers = new McpServers(db, {
    policy: { stdio: [binding.server.connection], http: [], cwd: process.cwd() },
    transportFactory: (() => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      void createFixtureErpServer({ dataPath, statePath }).connect(server);
      return client;
    }) as Any,
  });
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => db.close(),
    () => servers.close(),
  );
  let clock = new Date("2026-11-01T10:00:00Z");
  const now = () => clock;
  const estop = {
    on: false,
    engaged() {
      return this.on;
    },
    status() {
      return { engaged: this.on };
    },
    assertClear() {
      if (this.on) throw Object.assign(new Error("Emergency stop is engaged."), { status: 423 });
    },
  };
  const owner: Any = {
    gatewayId: "gw",
    gateway: { provider: "openclaw", status: "connected" },
    db,
    resolve: (seatId: string) => ({
      seat: { seatId, binding: { revision: 1 } },
      agentId: "backend",
      sessionKey: `agent:backend:${seatId}`,
    }),
    submit: vi.fn(),
  };
  const runtime: Any = {
    db,
    gateway: owner.gateway,
    gatewayId: "gw",
    seatOwner: () => owner,
    taskOwner: () => owner,
    estop,
    rosterSeats: () =>
      SEATS.map((seatId) => ({ seatId, assigned: true, binding: { available: true } })),
  };
  runtime.profiles = new AgentProfiles(runtime);
  runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
  runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
  runtime.mcpServers = servers;
  runtime.capabilities = new CapabilityRegistry(db, servers);
  runtime.governance = new Governance(db, runtime.capabilities, {
    now,
    estop,
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
    now,
  });
  const nammaops = createNammaOps(
    runtime,
    { NAMMAOPS_OWNER_PIN: PIN, NAMMAOPS_REASONING: "off" },
    { binding, workforce: loadWorkforce(), today: () => TODAY, now },
  );
  runtime.nammaops = nammaops;
  return {
    runtime,
    nammaops,
    estop,
    statePath,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    // The ERP's state file only exists once something has been written to it.
    state: () =>
      existsSync(statePath)
        ? JSON.parse(readFileSync(statePath, "utf8"))
        : { purchase_orders: [], sales_invoices: [] },
    writeState: (value: Any) => writeFileSync(statePath, JSON.stringify(value)),
  };
}

async function ready() {
  const ctx = setup();
  const report = await ctx.nammaops.setup({});
  expect(report.blockers).toEqual([]);
  return ctx;
}

const ask = async (ctx: Any, intent: Any) => (await ctx.nammaops.workflows.start({ intent })).done;
/** A bill request as Alice would hear it: rice and milk, which the fixture ERP prices. */
const BILL = {
  action: "prepare_bill",
  customer: "Lakshmi Stores",
  lines: [
    { product: "rice", quantity: 2 },
    { product: "milk", quantity: 1 },
  ],
};
const invoices = (ctx: Any) => ctx.state().sales_invoices ?? [];
const seatOf = (ctx: Any, role: string) =>
  ctx.runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`).seat_id;
const submitCapability = (ctx: Any) =>
  ctx.nammaops.binding.capabilityId("erp.sales_invoice.submit");

describe("understanding a request for a bill", () => {
  it("reads the exact sentence that failed: one product with a weight, one with a packet", () => {
    expect(
      parseBillRequest(
        "create bill of customer which has taken 1 kg toor dal and one packet of milk",
      ),
    ).toEqual({
      customer: undefined,
      lines: [
        { product: "toor dal", quantity: 1, unit: "kg" },
        { product: "milk", quantity: 1 },
      ],
    });
  });

  it("reads a named customer, several phrasings, and keeps a missing quantity missing", () => {
    expect(
      parseBillRequest("make a bill for Lakshmi Stores: 2 rice and one packet of milk"),
    ).toMatchObject({
      customer: "Lakshmi Stores",
      lines: [
        { product: "rice", quantity: 2 },
        { product: "milk", quantity: 1 },
      ],
    });
    expect(
      parseBillRequest("generate a bill for Ramesh who bought 500 g sugar, 2 biscuits"),
    ).toMatchObject({
      customer: "Ramesh",
      lines: [
        { product: "sugar", quantity: 500, unit: "g" },
        { product: "biscuits", quantity: 2 },
      ],
    });
    // No quantity anywhere: no lines are invented, so the workflow asks what was bought.
    expect(parseBillRequest("raise an invoice for the customer who took milk").lines).toEqual([]);
  });

  it("treats asking for a NEW bill as a bill, and asking about bills as a report", () => {
    const action = (text: string) => parseV2(text.toLowerCase())?.action;
    expect(action("create bill of customer which has taken 1 kg toor dal")).toBe("prepare_bill");
    expect(action("generate a bill for Ramesh")).toBe("prepare_bill");
    expect(action("raise an invoice")).toBe("prepare_bill");
    for (const report of [
      "how many bills today",
      "show me the bills",
      "make a report of the bills",
      "billing summary",
    ])
      expect(action(report), report).toBe("billing_summary");
  });

  it("is a bill for Frank in every router, so Alice no longer sends it to the open-ended agent", () => {
    const text = "create bill of customer which has taken 1 kg toor dal and one packet of milk";
    expect(parseCommand(text, TODAY)).toMatchObject({ action: "prepare_bill" });
    const query = businessIntent(text, { today: TODAY, seats: ["Alice", "Frank"] }) as Any;
    expect(query).toMatchObject({ department: "billing", args: { intent: "prepare_bill" } });
    expect(query.args.lines).toEqual([
      { product: "toor dal", quantity: 1, unit: "kg" },
      { product: "milk", quantity: 1 },
    ]);
    expect((classifyIntent(text) as Any).voiceIntents).toMatchObject({ billing: "prepare_bill" });
  });
});

describe("Frank prepares a draft bill", () => {
  it("creates a draft from live-style selling prices, reads it back, and asks the owner to approve", async () => {
    const ctx = await ready();
    const view = await ask(ctx, BILL);
    expect(view.status).toBe("awaiting_approval");
    expect(view.result).toMatchObject({
      kind: "prepare_bill",
      customer: "Lakshmi Stores",
      customer_defaulted: false,
      total: 828, // 2 x 400 + 1 x 28, the fixture's selling rates
      already_pending: false,
    });
    expect(
      view.result.lines.map((row: Any) => [row.item_code, row.qty, row.rate, row.amount]),
    ).toEqual([
      ["RICE-5KG", 2, 400, 800],
      ["MILK-500", 1, 28, 28],
    ]);
    // A DRAFT in the ERP: not a bill yet.
    expect(invoices(ctx)).toHaveLength(1);
    expect(invoices(ctx)[0]).toMatchObject({ docstatus: 0, status: "Draft", update_stock: 1 });
    const [approval] = ctx.nammaops.approvals.list();
    expect(approval).toMatchObject({
      kind: "sales_invoice",
      status: "pending",
      customer: "Lakshmi Stores",
      total: 828,
    });
    // Every ERP call ran as Frank, through governance.
    const calls = ctx.runtime.mcpGateway
      .invocations()
      .filter((row: Any) => row.correlation_id === view.id);
    expect(new Set(calls.map((row: Any) => row.agent_id))).toEqual(new Set(["nammaops-billing"]));
    expect(
      calls.find((row: Any) => row.capability_id.endsWith("create_sales_invoice_draft")),
    ).toMatchObject({
      operation: "WRITE",
      decision: "ALLOW",
      status: "completed",
    });
  });

  it("uses the walk-in customer when none is named, and says so", async () => {
    const ctx = await ready();
    const view = await ask(ctx, { ...BILL, customer: undefined });
    expect(view.result).toMatchObject({ customer: "Walk-in Customer", customer_defaulted: true });
    expect(view.result.lines).toHaveLength(2);
  });

  it("asks instead of guessing: missing quantity, unknown or vague product, odd weight, unknown customer", async () => {
    const ctx = await ready();
    const reasons = async (intent: Any) => {
      const view = await ask(ctx, intent);
      expect(view.status).toBe("needs_clarification");
      return view.clarifications.map((row: Any) => [row.requested, row.reason]);
    };
    expect(await reasons({ action: "prepare_bill", lines: [{ product: "rice" }] })).toEqual([
      ["rice", "missing_quantity"],
    ]);
    expect(await reasons({ action: "prepare_bill", lines: [] })).toEqual([
      ["the items", "missing_items"],
    ]);
    expect(
      await reasons({ action: "prepare_bill", lines: [{ product: "unicorn dust", quantity: 1 }] }),
    ).toEqual([["unicorn dust", "unknown"]]);
    // "oil" is more than one product here: it names the options instead of picking one.
    const vague = await ask(ctx, {
      action: "prepare_bill",
      lines: [{ product: "oil", quantity: 1 }],
    });
    expect(vague.status).toBe("needs_clarification");
    expect(vague.clarifications[0].options.length).toBeGreaterThan(1);
    // 300 g of a 5 kg bag is not a whole number of packs.
    expect(
      await reasons({
        action: "prepare_bill",
        lines: [{ product: "rice", quantity: 300, unit: "g" }],
      }),
    ).toEqual([["rice", "unit_mismatch"]]);
    expect(await reasons({ ...BILL, customer: "Zed Traders" })).toEqual([
      ["Zed Traders", "unknown_customer"],
    ]);
    // Nothing was drafted for any of those.
    expect(invoices(ctx)).toEqual([]);
    expect(ctx.nammaops.approvals.list()).toEqual([]);
  });

  it("converts a spoken weight or volume into whole packs, and shows what it understood", async () => {
    const ctx = await ready();
    const view = await ask(ctx, {
      action: "prepare_bill",
      lines: [
        { product: "milk", quantity: 1, unit: "l" }, // a 500 ml pack: two of them
        { product: "rice", quantity: 10, unit: "kg" }, // a 5 kg bag: two bags
      ],
    });
    expect(view.status).toBe("awaiting_approval");
    expect(view.result.lines.map((row: Any) => [row.item_code, row.qty])).toEqual([
      ["MILK-500", 2],
      ["RICE-5KG", 2],
    ]);
    expect(view.result.lines[0].understood).toMatch(/2 x Toned Milk 500ml \(you said 1 l\)/);
  });

  it("does not draft the same pending bill twice", async () => {
    const ctx = await ready();
    const first = await ask(ctx, BILL);
    const again = await ask(ctx, BILL);
    expect(again.result).toMatchObject({ already_pending: true, bill: first.result.bill });
    expect(again.result.approvals).toEqual(first.result.approvals);
    expect(invoices(ctx)).toHaveLength(1);
    // A different quantity is a different bill.
    const other = await ask(ctx, { ...BILL, lines: [{ product: "rice", quantity: 3 }] });
    expect(other.result.already_pending).toBe(false);
    expect(invoices(ctx)).toHaveLength(2);
  });

  it("only Frank may draft a bill, nobody but the bill-submit principal may submit one", async () => {
    const ctx = await ready();
    const name = (await ask(ctx, BILL)).result.bill;
    const call = (agent: string, id: string, args: Any) =>
      ctx.nammaops.binding.call(agent, id, args);
    const draftArgs = { customer: "Walk-in Customer", items: [{ item_code: "MILK-500", qty: 1 }] };
    for (const agent of [
      "nammaops-manager",
      "nammaops-inventory",
      "nammaops-sales",
      "nammaops-procurement",
      "nammaops-finance",
      "nammaops-reports",
      "nammaops-po-submit",
      "nammaops-dashboard-reader",
    ])
      await expect(
        call(agent, "erp.sales_invoice.create_draft", draftArgs),
        agent,
      ).rejects.toMatchObject({
        invocationStatus: "denied",
      });
    // Frank cannot submit his own draft, with or without an approval.
    await expect(
      call("nammaops-billing", "erp.sales_invoice.submit", { name }),
    ).rejects.toMatchObject({
      invocationStatus: "denied",
    });
    for (const agent of ["nammaops-manager", "nammaops-finance", "nammaops-procurement"])
      await expect(call(agent, "erp.sales_invoice.submit", { name }), agent).rejects.toMatchObject({
        invocationStatus: "denied",
      });
    expect(invoices(ctx).every((row: Any) => row.docstatus === 0)).toBe(true);
    // The Manager still has no ERP grant at all.
    expect(ctx.runtime.governance.effective("nammaops-manager").assigned).toEqual([]);
  });

  it("is paused by the EmergencyStop like any write", async () => {
    const ctx = await ready();
    ctx.estop.on = true;
    const view = await ask(ctx, BILL);
    expect(view.status).not.toBe("awaiting_approval");
    expect(invoices(ctx)).toEqual([]);
  });
});

describe("the owner approves a bill with the PIN", () => {
  it("turns the draft into a bill, once, with approval and execution audited separately", async () => {
    const ctx = await ready();
    const prepared = await ask(ctx, BILL);
    const { approvals } = prepared.result;
    expect(ctx.nammaops.workflows.view(prepared.id).status).toBe("awaiting_approval");
    const done = await ctx.nammaops.approvals.approve(approvals[0], { pin: PIN, session: "tab-1" });
    expect(done).toMatchObject({
      status: "submitted",
      kind: "sales_invoice",
      document_state: "submitted",
    });
    expect(invoices(ctx)[0]).toMatchObject({ docstatus: 1, status: "Unpaid" });
    // The gateway approval: bound to the bill-submit principal, the capability, the exact call and session.
    const [gateway] = ctx.runtime.governance.approvals();
    expect(gateway).toMatchObject({
      status: "consumed",
      agent_id: "nammaops-bill-submit",
      capability_id: submitCapability(ctx),
      session_id: "tab-1",
      reviewer: "owner",
      args_summary: { name: invoices(ctx)[0].name },
    });
    const submit = ctx.runtime.mcpGateway
      .invocations()
      .find((row: Any) => row.capability_id === submitCapability(ctx));
    expect(submit).toMatchObject({
      status: "completed",
      approval_id: gateway.request_id,
      operation: "EXTERNAL_ACTION",
    });
    expect(submit.invocation_id).not.toBe(gateway.request_id);
    // The workflow finished once the owner decided, and says a bill (not a purchase order) was submitted.
    const finished = ctx.nammaops.workflows.view(prepared.id);
    expect(finished.status).toBe("completed");
    expect(finished.timeline.map((row: Any) => row.type)).toContain("BILL_SUBMITTED");
  });

  it("refuses a wrong PIN, a replay, an expired request and a changed draft, and bills nothing", async () => {
    const ctx = await ready();
    const [first, second] = [
      (await ask(ctx, BILL)).result.approvals[0],
      (await ask(ctx, { ...BILL, lines: [{ product: "rice", quantity: 3 }] })).result.approvals[0],
    ];
    await expect(ctx.nammaops.approvals.approve(first, "0000")).rejects.toMatchObject({
      status: 403,
    });
    expect(invoices(ctx).every((row: Any) => row.docstatus === 0)).toBe(true);
    // The draft is changed in the ERP after it was shown: the approval is void.
    const state = ctx.state();
    state.sales_invoices[1].items[0].qty = 49;
    ctx.writeState(state);
    await expect(ctx.nammaops.approvals.approve(second, PIN)).rejects.toThrow(
      /changed since it was presented/,
    );
    expect(ctx.nammaops.approvals.get(second).status).toBe("invalidated");
    await ctx.nammaops.approvals.approve(first, PIN);
    await expect(ctx.nammaops.approvals.approve(first, PIN)).rejects.toMatchObject({ status: 409 });
    expect(invoices(ctx).filter((row: Any) => row.docstatus === 1)).toHaveLength(1);
    // An old request lapses.
    const third = (await ask(ctx, { ...BILL, lines: [{ product: "milk", quantity: 4 }] })).result
      .approvals[0];
    ctx.advance(31 * 60 * 1000);
    await expect(ctx.nammaops.approvals.approve(third, PIN)).rejects.toMatchObject({ status: 409 });
  });

  it("is stopped by the EmergencyStop after a correct PIN, and the gateway checks the approval itself", async () => {
    const ctx = await ready();
    const approval = (await ask(ctx, BILL)).result.approvals[0];
    ctx.estop.on = true;
    await expect(ctx.nammaops.approvals.approve(approval, PIN)).rejects.toMatchObject({
      status: 423,
    });
    ctx.estop.on = false;
    expect(ctx.nammaops.approvals.get(approval).status).toBe("invalidated");
    expect(invoices(ctx)[0].docstatus).toBe(0);
    // Calling the submit tool directly, with no approval, is refused by the ToolGateway.
    await expect(
      ctx.nammaops.binding.call("nammaops-bill-submit", "erp.sales_invoice.submit", {
        name: invoices(ctx)[0].name,
      }),
    ).rejects.toMatchObject({ invocationStatus: "approval_required", workflowStatus: "blocked" });
    expect(invoices(ctx)[0].docstatus).toBe(0);
  });

  it("keeps purchase-order approvals working beside bill approvals", async () => {
    const ctx = await ready();
    const bill = (await ask(ctx, BILL)).result.approvals[0];
    const reorder = await (
      await ctx.nammaops.workflows.start({
        text: "Prepare an order for the products that are running low. Choose the cheapest suitable supplier.",
      })
    ).done;
    const po = reorder.result.approvals[0];
    expect(ctx.nammaops.approvals.get(po).kind).toBe("purchase_order");
    expect((await ctx.nammaops.approvals.approve(po, PIN)).status).toBe("submitted");
    expect((await ctx.nammaops.approvals.approve(bill, PIN)).status).toBe("submitted");
    const principals = new Set(ctx.runtime.governance.approvals().map((row: Any) => row.agent_id));
    expect(principals).toEqual(new Set(["nammaops-po-submit", "nammaops-bill-submit"]));
  });
});

describe("through chat and voice, the way Alice was asked", () => {
  const text = (ctx: Any, role: string, message: string, taskId: string) =>
    answerDirect(ctx.runtime, {
      taskId,
      message,
      seatId: seatOf(ctx, role),
      sessionKey: "agent:main:dm-billing",
    }) as Promise<Any>;
  const reply = (ctx: Any, taskId: string) =>
    ctx.runtime.db.getMessage(`dm_reply_${taskId}`).content;

  it("Alice hands a bill request to Frank, who prepares a draft and asks the owner to check it", async () => {
    const ctx = await ready();
    const out = await text(
      ctx,
      "manager",
      "create a bill for Lakshmi Stores: 2 rice and one packet of milk",
      "t1",
    );
    expect(out.answered).toMatchObject({ intent: "prepare_bill", delegated: true });
    // Alice coordinates: she acknowledges, Frank gets the task in his own chat and prepares the
    // draft there, and Alice's chat gets the combined report with the draft and its approval.
    const ack = reply(ctx, "t1");
    expect(ack).toMatch(/I'm coordinating with Frank \(Billing\)/);
    const frankReport = ctx.runtime.db.getMessage("dm_report_t1_0");
    expect(frankReport.actorName).toBe("Frank");
    expect(frankReport.sessionKey).not.toBe(ctx.runtime.db.getMessage("dm_reply_t1").sessionKey);
    expect(frankReport.content).toMatch(/Draft bill SINV-FX-0001 for Lakshmi Stores/);
    const synthesis = ctx.runtime.db.getMessage("dm_synthesis_t1").content;
    expect(synthesis).toMatch(/\*\*Frank — Billing\*\*/);
    expect(synthesis).toMatch(/Draft bill SINV-FX-0001 for Lakshmi Stores/);
    expect(synthesis).toMatch(/only a draft/);
    expect(synthesis).toMatch(/Approval own_\w+ for SINV-FX-0001/);
    // The ERP read and write ran as Frank, never as Alice.
    const workflowId = ctx.runtime.db.record("nammaops.dm_delegation", "dlg_t1_0").workflow_id;
    const view = ctx.nammaops.workflows.view(workflowId);
    expect(view.tasks.map((task: Any) => task.role)).toContain("billing");
    expect(
      ctx.runtime.mcpGateway.invocations().every((row: Any) => row.agent_id !== "nammaops-manager"),
    ).toBe(true);
  });

  it("tolerates a customer slip: 'Laxshmi Stores' still bills the recorded Lakshmi Stores", async () => {
    const ctx = await ready();
    await text(ctx, "billing", "create a bill for Laxshmi Stores: 2 rice and 1 milk", "cs1");
    expect(reply(ctx, "cs1")).toMatch(/Draft bill SINV-FX-\d+ for Lakshmi Stores/);
    expect(invoices(ctx)).toHaveLength(1);
  });

  it("asks which product and how many when the request is unclear, and creates nothing", async () => {
    const ctx = await ready();
    await text(ctx, "billing", "create a bill for Lakshmi Stores: rice and milk", "t2");
    expect(reply(ctx, "t2")).toMatch(/What did the customer buy, and how many of each\?/);
    expect(invoices(ctx)).toEqual([]);
    await text(ctx, "billing", "create a bill for Lakshmi Stores: 2 rice and 1 oil", "t3");
    expect(reply(ctx, "t3")).toMatch(/"oil" could be .* or .*\. Which one\?/);
    expect(invoices(ctx)).toEqual([]);
  });

  it("voice: approving works without knowing the id (a draft made in text chat), and asks which when several wait", async () => {
    const ctx = await ready();
    const approvals = ctx.nammaops.approvals;
    const call = { id: "voice_alice2" };
    // Nothing waiting: a clear message, not "could not be found".
    await expect(approvals.approveByVoice({ call, approvalId: undefined })).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/No approval is waiting/),
    });
    await text(ctx, "billing", "create a bill for Lakshmi Stores: 2 rice and 1 milk", "w1");
    // One waiting: no id, or a made-up id, both mean that one.
    const byNothing: Any = await approvals.approveByVoice({ call, approvalId: undefined });
    expect(byNothing).toMatchObject({ status: "pin_required" });
    const byWrongId = await approvals.approveByVoice({
      call: { id: "voice_alice3" },
      approvalId: "own_made_up",
    });
    expect(byWrongId).toMatchObject({ status: "pin_required", approval_id: byNothing.approval_id });
    // Two waiting: the owner is asked which; nothing is chosen for them.
    await text(ctx, "billing", "create a bill for Lakshmi Stores: 1 rice", "w2");
    const which = await approvals.approveByVoice({
      call: { id: "voice_alice4" },
      approvalId: undefined,
    });
    expect(which.status).toBe("which_one");
    expect(which.options).toHaveLength(2);
    expect(which.options[0]).toMatchObject({ party: "Lakshmi Stores" });
  });

  it("voice: Frank's tool call drafts the bill, then the spoken PIN makes it a bill", async () => {
    const ctx = await ready();
    const callId = "voice_alice";
    const db = Object.create(ctx.runtime.db);
    db.getSeat = (id: string) =>
      id === "seat-m"
        ? { seatId: id, assigned: true, binding: { revision: 1, agentId: "main" } }
        : null;
    db.saveRecord("voiceCall", callId, {
      seatId: "seat-m",
      name: "Alice",
      agentId: "main",
      sessionKey: "agent:main:seat-m",
      bindingRevision: 1,
      gatewayId: "gw",
      createdAt: new Date().toISOString(),
    });
    const service = new VoiceService({ gatewayId: "gw", db, nammaops: ctx.nammaops });
    let n = 0;
    const tool = (name: string, args: Any) =>
      runVoiceAgentTool(name, args, (toolName: string, parameters: Any) =>
        service.action({ tool: toolName, callId, actionId: `act_${++n}`, args: parameters }),
      ) as Promise<Any>;
    const drafted = await tool("nammaops_business_query", {
      intent: "prepare_bill",
      customer: "Lakshmi Stores",
      lines: [
        { product: "rice", quantity: 2 },
        { product: "milk", quantity: 1 },
      ],
    });
    expect(drafted.status).toBe("awaiting_approval");
    expect(drafted.facts.join(" ")).toMatch(/only a draft/);
    expect(drafted.approval_required).toBe(true);
    expect(drafted.evidence.filter((row: Any) => row.capabilities.length)).toEqual([
      expect.objectContaining({ department: "billing" }),
    ]);
    const approvalId = drafted.approvals[0].approval_id;
    // The model cannot bill anything itself: the approval tool wants the owner's spoken PIN.
    expect(await tool("approve_by_voice", { approval_id: approvalId })).toMatchObject({
      status: "pin_required",
    });
    service.finalize({
      callId,
      id: "u1",
      role: "user",
      content: `pin ${SPOKEN_PIN}`,
      timestamp: new Date().toISOString(),
    });
    expect(await tool("approve_by_voice", { approval_id: approvalId })).toMatchObject({
      status: "submitted",
    });
    expect(invoices(ctx)[0].docstatus).toBe(1);
    expect(JSON.stringify(ctx.runtime.db.db.prepare("SELECT * FROM messages").all())).not.toContain(
      PIN,
    );
    // A malformed request is refused by the strict tool schema.
    await expect(
      tool("nammaops_business_query", {
        intent: "prepare_bill",
        lines: [{ product: "rice", quantity: 1, rate: 1 }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("a packet is a count, not a weight (the 'packet of milk' that got stuck)", () => {
  it("treats any non-weight unit as 'that many' and drafts the bill", async () => {
    const ctx = await ready();
    for (const unit of ["packet", "pack", "piece", "box", "constructor"]) {
      const view = await ask(ctx, {
        action: "prepare_bill",
        lines: [{ product: "milk", quantity: 1, unit }],
      });
      expect(view.status, unit).toBe("awaiting_approval");
      expect(view.result.lines[0]).toMatchObject({ item_code: "MILK-500", qty: 1 });
    }
  });

  it("drops a non-weight unit from the language model's reading, and keeps a weight", () => {
    const decision = (unit: string) =>
      (
        validateDecision(
          {
            intent: "prepare_bill",
            confidence: 0.9,
            lines: [{ product: "milk", quantity: 1, unit }],
          },
          { today: TODAY },
        ) as Any
      ).args.lines[0];
    expect(decision("packet")).toEqual({ product: "milk", quantity: 1 });
    expect(decision("Packet")).toEqual({ product: "milk", quantity: 1 });
    expect(decision("kg")).toEqual({ product: "milk", quantity: 1, unit: "kg" });
    expect(decision("L")).toEqual({ product: "milk", quantity: 1, unit: "l" });
  });
});

describe("answering Frank's question (the '2' that got stuck)", () => {
  const talk = (ctx: Any, message: string, id: string) =>
    answerDirect(ctx.runtime, {
      taskId: id,
      message,
      seatId: seatOf(ctx, "billing"),
      sessionKey: "agent:main:dm-followup",
    }) as Promise<Any>;
  const said = (ctx: Any, id: string) => ctx.runtime.db.getMessage(`dm_reply_${id}`).content;

  it("completes the waiting bill when the owner answers with a quantity", async () => {
    const ctx = await ready();
    await talk(ctx, "create a bill for Lakshmi Stores: rice and 1 milk", "f1");
    expect(said(ctx, "f1")).toMatch(/How many rice should be on the bill\?/);
    expect(invoices(ctx)).toEqual([]);
    const out = await talk(ctx, "2", "f2");
    expect(out.answered).toMatchObject({ intent: "prepare_bill" });
    expect(said(ctx, "f2")).toMatch(/Draft bill SINV-FX-0001 for Lakshmi Stores/);
    expect(said(ctx, "f2")).toMatch(/2 x Sona Masoori Rice 5kg/);
    expect(said(ctx, "f2")).toMatch(/1 x Toned Milk 500ml/);
    expect(invoices(ctx)).toHaveLength(1);
    expect(invoices(ctx)[0].items.map((row: Any) => [row.item_code, row.qty])).toEqual([
      ["RICE-5KG", 2],
      ["MILK-500", 1],
    ]);
  });

  it("takes the answer to an odd weight as a number of packs", async () => {
    const ctx = await ready();
    await talk(ctx, "create a bill: 300 g rice", "g1");
    expect(said(ctx, "g1")).toMatch(/not a whole number of packs/);
    await talk(ctx, "two packs", "g2");
    expect(invoices(ctx)[0].items[0]).toMatchObject({ item_code: "RICE-5KG", qty: 2 });
  });

  it("takes a product name or a customer name as the answer to which one", async () => {
    const ctx = await ready();
    await talk(ctx, "create a bill: 1 oil", "p1");
    expect(said(ctx, "p1")).toMatch(/"oil" could be/);
    await talk(ctx, "Sunflower Oil 1L", "p2");
    expect(invoices(ctx)[0].items[0].item_code).toBe("OIL-SUN-1L");
    await talk(ctx, "create a bill for Zed Traders: 1 milk", "c1");
    expect(said(ctx, "c1")).toMatch(/could not find a customer called "Zed Traders"/);
    await talk(ctx, "Lakshmi Stores", "c2");
    expect(invoices(ctx)[1].customer).toBe("Lakshmi Stores");
  });

  it("never takes a new request, or an unrelated reply, for an answer", async () => {
    const ctx = await ready();
    await talk(ctx, "create a bill for Lakshmi Stores: rice and 1 milk", "n1");
    // A different request is its own request, and leaves no bill behind.
    const report = await talk(ctx, "how many bills today", "n2");
    expect(report.answered).toMatchObject({ intent: "billing_summary" });
    expect(invoices(ctx)).toEqual([]);
    // The question is no longer waiting once something else was asked: "2" is just "2".
    const stray = await talk(ctx, "2", "n3");
    expect(stray.answered.intent).toBeNull();
    expect(invoices(ctx)).toEqual([]);
  });

  it("stops waiting after 15 minutes, and after any other request", async () => {
    const ctx = await ready();
    await talk(ctx, "create a bill for Lakshmi Stores: rice and 1 milk", "t1");
    const workflows = ctx.nammaops.workflows;
    expect(workflows.pendingBillClarification()).toMatchObject({
      clarifications: [expect.objectContaining({ reason: "missing_quantity" })],
    });
    expect(workflows.pendingBillClarification(Date.now() + 16 * 60 * 1000)).toBeNull();
    await ask(ctx, { action: "stock_check", products: ["milk"] });
    expect(workflows.pendingBillClarification()).toBeNull();
  });

  it("applyBillAnswer only fills in what was asked", () => {
    const pending = (reason: string, requested: string) => ({
      intent: {
        action: "prepare_bill",
        lines: [{ product: "rice" }, { product: "milk", quantity: 1 }],
      },
      clarifications: [{ requested, reason }],
    });
    const apply = (reason: string, answer: string) =>
      applyBillAnswer(pending(reason, "rice"), answer) as Any;
    expect(apply("missing_quantity", "3").lines[0]).toEqual({ product: "rice", quantity: 3 });
    expect(apply("missing_quantity", "three packets").lines[0].quantity).toBe(3);
    expect(apply("missing_quantity", "a lot")).toBeNull(); // not a number: ask again
    expect(apply("missing_quantity", "0")).toBeNull();
    expect(apply("unknown", "5")).toBeNull(); // a product answer is a name, not a number
    expect(apply("unknown", "Sona Masoori Rice 5kg").lines[0].product).toBe(
      "Sona Masoori Rice 5kg",
    );
    expect(apply("unknown_customer", "walk-in").customer).toBeUndefined();
    expect(apply("unknown_customer", "Lakshmi Stores").customer).toBe("Lakshmi Stores");
    expect(
      applyBillAnswer(pending("missing_quantity", "rice"), "create a bill for Ramesh"),
    ).toBeNull();
    expect(applyBillAnswer(pending("missing_quantity", "rice"), "x".repeat(200))).toBeNull();
    expect(applyBillAnswer(null, "2")).toBeNull();
    expect(
      applyBillAnswer({ intent: { action: "stock_check" }, clarifications: [{}] } as Any, "2"),
    ).toBeNull();
  });
});

describe("product names as shop owners spell them", () => {
  // The recorded item names of the live store (a sample covering the cases that matter).
  const live = [
    ["NK-FACEWASH-100", "Face Wash 100g", "Personal Care"],
    ["NK-HANDWASH-200", "Hand Wash 200ml", "Personal Care"],
    ["NK-KABULI-1KG", "Kabuli Chana 1kg", "Pulses"],
    ["NK-RAJMA-1KG", "Rajma 1kg", "Pulses"],
    ["NK-MASOOR-1KG", "Masoor Dal 1kg", "Pulses"],
    ["NK-URAD-1KG", "Urad Dal 1kg", "Pulses"],
    ["NK-CHANA-1KG", "Chana Dal 1kg", "Pulses"],
    ["NK-MOONG-1KG", "Moong Dal 1kg", "Pulses"],
    ["NK-DAL-1KG", "Toor Dal 1kg", "Staples"],
    ["NK-RICE-5KG", "Sona Masoori Rice 5kg", "Staples"],
    ["NK-WHEAT-5KG", "Wheat Atta 5kg", "Staples"],
    ["NK-MILK-500", "Toned Milk 500ml", "Dairy"],
    ["NK-GHEE-200", "Ghee 200ml", "Dairy"],
  ].map(([item_code, item_name, item_group]) => ({ item_code, item_name, item_group }));
  const pick = (name: string) => resolveProducts([name], live);
  const only = (name: string) => {
    const found = pick(name);
    expect(found.clarifications, name).toEqual([]);
    return found.resolved.map((row: Any) => row.item.item_name);
  };

  it("finds 'kabuli channa' (the message that failed) and other spellings of the same item", () => {
    for (const spelling of [
      "kabuli channa",
      "kabuli chana",
      "kabli chana",
      "kabuly channa",
      "kabulli chana",
    ])
      expect(only(spelling), spelling).toEqual(["Kabuli Chana 1kg"]);
    expect(only("tur dal")).toEqual(["Toor Dal 1kg"]);
    expect(only("toor daal")).toEqual(["Toor Dal 1kg"]);
    expect(only("arhar dhal")).toEqual(["Toor Dal 1kg"]);
    expect(only("sona masuri rice")).toEqual(["Sona Masoori Rice 5kg"]);
    expect(only("wheat aata")).toEqual(["Wheat Atta 5kg"]);
    expect(only("ghi")).toEqual(["Ghee 200ml"]);
    expect(only("handwash")).toEqual(["Hand Wash 200ml"]);
    expect(only("hand wash")).toEqual(["Hand Wash 200ml"]);
  });

  it("still asks when a spelling fits more than one item, and when it fits none", () => {
    // "channa" alone is a Kabuli Chana and a Chana Dal: the owner is asked which, as for "chana".
    const alone = pick("channa");
    expect(alone.resolved).toEqual([]);
    expect(alone.clarifications[0]).toMatchObject({ reason: "ambiguous" });
    expect(alone.clarifications[0].options.sort()).toEqual(["Chana Dal 1kg", "Kabuli Chana 1kg"]);
    for (const nonsense of ["unicorn dust", "kabuli rice", "xyzzy", "kabuli channa handwash"])
      expect(pick(nonsense).clarifications[0], nonsense).toMatchObject({ reason: "unknown" });
  });

  it("never lets the spelling help override an exact match", () => {
    expect(only("Toor Dal 1kg")).toEqual(["Toor Dal 1kg"]);
    expect(only("masoor dal")).toEqual(["Masoor Dal 1kg"]);
    expect(only("rajma")).toEqual(["Rajma 1kg"]);
  });

  it("drafts the message that failed once the product is found", async () => {
    const ctx = await ready();
    // The fixture's rice is spelled "Masoori"; a typo of it still resolves, and a bad one still asks.
    const view = await ask(ctx, {
      action: "prepare_bill",
      customer: "Lakshmi Stores",
      lines: [
        { product: "sona masuri rice", quantity: 1 },
        { product: "milk", quantity: 1 },
      ],
    });
    expect(view.status).toBe("awaiting_approval");
    expect(view.result.lines.map((row: Any) => row.item_code)).toEqual(["RICE-5KG", "MILK-500"]);
  });
});

describe("the keyword reader on the exact sentence that failed (when Gemini is not used)", () => {
  it("drops the word 'item' and splits two quantity-led products with no 'and'", () => {
    expect(
      parseBillRequest("create bill of customer rohan with item 1 kg kabuli channa 1 handwash"),
    ).toEqual({
      customer: "rohan",
      lines: [
        { product: "kabuli channa", quantity: 1, unit: "kg" },
        { product: "handwash", quantity: 1 },
      ],
    });
    expect(parseBillRequest("bill for Rohan with items 2 rice 3 milk 1 handwash").lines).toEqual([
      { product: "rice", quantity: 2 },
      { product: "milk", quantity: 3 },
      { product: "handwash", quantity: 1 },
    ]);
  });

  it("does not split a size that belongs to a product name", () => {
    // "toor dal 1 kg" and "milk 500 ml" keep their sizes; the list does not start with a quantity.
    expect(
      parseBillRequest("create a bill for Rohan: toor dal 1 kg and milk 500 ml").lines,
    ).toEqual([{ product: "toor dal 1 kg" }, { product: "milk 500 ml" }]);
    // A quantity-led item whose name ends in a size is kept whole too.
    expect(parseBillRequest("create a bill: 2 toor dal 1kg").lines).toEqual([
      { product: "toor dal 1kg", quantity: 2 },
    ]);
  });
});

describe("the message as it was typed: a misspelling and two products run together", () => {
  const talk = (ctx: Any, message: string, id: string) =>
    answerDirect(ctx.runtime, {
      taskId: id,
      message,
      seatId: seatOf(ctx, "billing"),
      sessionKey: "agent:main:dm-typed",
    }) as Promise<Any>;
  const said = (ctx: Any, id: string) => ctx.runtime.db.getMessage(`dm_reply_${id}`).content;

  it("reads 'create bil' and 'invoce' as a bill request, not as something for the open-ended agent", () => {
    for (const text of [
      "create bil of customer rohan  with 1kg kabuli chana handwash",
      "make an invoce for Lakshmi Stores: 2 rice",
    ]) {
      expect(parseV2(text.toLowerCase()), text).toEqual({ action: "prepare_bill" });
      expect(businessIntent(text, { today: TODAY, seats: ["Alice"] }), text).toMatchObject({
        department: "billing",
        args: { intent: "prepare_bill" },
      });
    }
    expect((classifyIntent("create bil for rohan: 2 rice") as Any).voiceIntents).toMatchObject({
      billing: "prepare_bill",
    });
  });

  it("splits two products run together, keeps the quantity with the first, and asks for the other", async () => {
    const ctx = await ready();
    const view = await ask(ctx, {
      action: "prepare_bill",
      customer: "Lakshmi Stores",
      lines: [{ product: "rice milk", quantity: 1 }],
    });
    expect(view.status).toBe("needs_clarification");
    expect(view.clarifications.map((row: Any) => [row.requested, row.reason])).toEqual([
      ["milk", "missing_quantity"],
    ]);
    expect(invoices(ctx)).toEqual([]);
  });

  it("then takes 'how many' for the split-off product and drafts both", async () => {
    const ctx = await ready();
    await talk(ctx, "create bil for Lakshmi Stores with 1 rice milk", "r1");
    expect(said(ctx, "r1")).toMatch(/How many milk should be on the bill\?/);
    await talk(ctx, "2", "r2");
    expect(said(ctx, "r2")).toMatch(/Draft bill SINV-FX-0001 for Lakshmi Stores/);
    expect(invoices(ctx)[0].items.map((row: Any) => [row.item_code, row.qty])).toEqual([
      ["RICE-5KG", 1],
      ["MILK-500", 2],
    ]);
  });

  it("splits only when each part names exactly one product, and says so when it cannot", async () => {
    const ctx = await ready();
    // "unicorn dust" names nothing: the whole phrase is asked about, as before.
    const unknown = await ask(ctx, {
      action: "prepare_bill",
      lines: [{ product: "rice unicorn", quantity: 1 }],
    });
    expect(unknown.status).toBe("needs_clarification");
    expect(unknown.clarifications[0]).toMatchObject({
      reason: "unknown",
      requested: "rice unicorn",
    });
    // A phrase that already names one product is never split.
    const whole = await ask(ctx, {
      action: "prepare_bill",
      lines: [{ product: "sona masoori rice", quantity: 1 }],
    });
    expect(whole.status).toBe("awaiting_approval");
    expect(whole.result.lines).toHaveLength(1);
  });

  it("applyBillAnswer finds a split-off product inside the original line", () => {
    const pending = {
      intent: { action: "prepare_bill", lines: [{ product: "rice milk", quantity: 1 }] },
      clarifications: [{ requested: "milk", reason: "missing_quantity" }],
    };
    expect((applyBillAnswer(pending, "2") as Any).lines).toEqual([
      { product: "rice", quantity: 1 },
      { product: "milk", quantity: 2 },
    ]);
    // Nothing to attach the answer to: not an answer.
    expect(
      applyBillAnswer(
        { ...pending, clarifications: [{ requested: "soap", reason: "missing_quantity" }] },
        "2",
      ),
    ).toBeNull();
  });
});

describe("a lost confirmation no longer freezes a conversation", () => {
  const task = (taskId: string, status: string, createdAt: string) => ({
    taskId,
    gatewayId: "gw",
    agentId: "main",
    sessionKey: "agent:main:main",
    seatId: "seat-0",
    message: taskId,
    status,
    createdAt,
  });
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  it("starts a queued task behind an old unconfirmed one, but not behind a recent one", () => {
    const db = new TaskDatabase(":memory:") as Any;
    cleanup.push(() => db.close());
    // Yesterday's task whose outcome was never confirmed (it is never resent).
    db.insertTask(task("old", "outcome_unknown", minutesAgo(24 * 60)));
    db.insertTask(task("next", "queued", minutesAgo(1)));
    expect(db.claim("next")).toMatchObject({ taskId: "next", status: "submitted" });
    expect(db.getTask("old").status).toBe("outcome_unknown"); // left exactly as it was

    // A recent unconfirmed task still protects against running the same thing twice.
    const fresh = new TaskDatabase(":memory:") as Any;
    cleanup.push(() => fresh.close());
    fresh.insertTask(task("recent", "outcome_unknown", minutesAgo(2)));
    fresh.insertTask(task("waits", "queued", minutesAgo(1)));
    expect(fresh.claim("waits")).toBeNull();
  });

  it("still holds back behind a task that is genuinely running", () => {
    const db = new TaskDatabase(":memory:") as Any;
    cleanup.push(() => db.close());
    db.insertTask(task("busy", "running", minutesAgo(60 * 24)));
    db.insertTask(task("queued", "queued", minutesAgo(1)));
    expect(db.claim("queued")).toBeNull();
    expect(UNKNOWN_BLOCK_MS).toBe(10 * 60 * 1000);
  });
});

describe("what is enabled on the live ERP", () => {
  it("lets only the two bill capabilities write, and keeps the purchase-order writes off", () => {
    const live = loadBinding("config/nammaops/binding.hvgerp.json");
    expect(live.capabilities["erp.sales_invoice.create_draft"]).toMatchObject({
      tool: "create_sales_invoice_draft",
      risk: "WRITE",
    });
    expect(live.capabilities["erp.sales_invoice.submit"]).toMatchObject({
      tool: "submit_sales_invoice",
      risk: "EXTERNAL_ACTION",
      approval_required: true,
    });
    for (const id of ["erp.po.create_draft", "erp.po.submit"])
      expect(live.capabilities[id]).toMatchObject({ tool: null, disabled: expect.any(String) });
    expect(classify("erp.sales_invoice.submit")).toMatchObject({
      requires: "approval+pin+confirm",
      live_write: "enabled",
    });
    expect(liveWriteBlocked("erp.sales_invoice.submit", { shape: "hvgerp" })).toBe(false);
    expect(liveWriteBlocked("erp.sales_invoice.create_draft", { shape: "hvgerp" })).toBe(false);
    expect(liveWriteBlocked("erp.po.submit", { shape: "hvgerp" })).toBe(true);
  });
});
