import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  OWNER_ACTOR,
  WORKFLOW_PRINCIPALS,
  redact,
} from "../server/mcp-governance.mjs";
import { createNammaOps } from "../server/nammaops/index.mjs";
import { loadBinding } from "../server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../server/nammaops/workforce.mjs";
import {
  OwnerApprovals,
  extractSpokenPin,
  redactSpokenDigits,
} from "../server/nammaops/owner-approvals.mjs";
import { PinVerifier } from "../server/nammaops/pin-verifier.mjs";
import { classify, liveWriteBlocked, requiresPin } from "../server/nammaops/approval-policy.mjs";
import { createFixtureErpServer } from "../mcp/fixture-erpnext-server.mjs";
import { VoiceService } from "../server/voice.mjs";
import { runVoiceAgentTool } from "../voice/agent-actions";
import { hideSpokenDigits } from "../voice/hide-pin";

// Synthetic TEST FIXTURE ERP over an in-memory MCP transport; OpenClaw is a stub. Nothing here is
// live ERPNext. These tests exercise the Approval Manager: PIN, approval tokens, ToolGateway
// revalidation, EmergencyStop, and the spoken-PIN path.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const TODAY = "2026-11-01";
const PIN = "90417352"; // eight digits, spoken as words below
const SPOKEN_PIN = "nine zero four one seven three five two";
const SEATS = ["seat-m", "seat-i", "seat-s", "seat-p", "seat-f", "seat-r", "seat-b"];
const W2 =
  "Prepare an order for the products that are running low. Choose the cheapest suitable supplier.";

function setup({ pin = PIN }: { pin?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nammaops-approval-"));
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
    { NAMMAOPS_OWNER_PIN: pin, NAMMAOPS_REASONING: "off" },
    { binding, workforce: loadWorkforce(), today: () => TODAY, now },
  );
  runtime.nammaops = nammaops;
  return {
    runtime,
    nammaops,
    estop,
    statePath,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    poState: () => JSON.parse(readFileSync(statePath, "utf8")),
  };
}

async function ready(options: Any = {}) {
  const ctx = setup(options);
  const report = await ctx.nammaops.setup({});
  expect(report.blockers).toEqual([]);
  return ctx;
}

/** A prepared reorder: draft purchase orders in the fixture ERP, each awaiting the owner. */
async function drafts(ctx: Any) {
  const view = await (await ctx.nammaops.workflows.start({ text: W2 })).done;
  expect(view.status).toBe("awaiting_approval");
  return view.result.approvals as string[];
}

const submitCapability = (ctx: Any) => ctx.nammaops.binding.capabilityId("erp.po.submit");
const everythingStored = (ctx: Any) => {
  const sqlite = ctx.runtime.db.db;
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row: Any) => JSON.stringify(sqlite.prepare(`SELECT * FROM "${row.name}"`).all()))
    .join("\n");
};

describe("approval policy (server-owned classification)", () => {
  it("classifies reads as needing nothing and only the two writes as gated", () => {
    expect(classify("erp.items.list")).toMatchObject({ risk: "READ", requires: "none" });
    expect(classify("erp.gst.summary").requires).toBe("none");
    expect(classify("erp.po.create_draft")).toMatchObject({
      risk: "WRITE",
      requires: "approval",
      live_write: "disabled",
    });
    expect(classify("erp.po.submit")).toMatchObject({
      risk: "EXTERNAL_ACTION",
      requires: "approval+pin+confirm",
      live_write: "disabled",
    });
    expect(requiresPin("erp.po.submit")).toBe(true);
    expect(requiresPin("erp.po.get")).toBe(false);
    // A classification table an agent cannot edit.
    expect(Object.isFrozen(classify("erp.po.submit"))).toBe(true);
  });

  it("blocks a live write whatever else is true, and never blocks the synthetic fixture", () => {
    expect(liveWriteBlocked("erp.po.submit", { shape: "hvgerp" })).toBe(true);
    expect(liveWriteBlocked("erp.po.create_draft", { shape: "hvgerp" })).toBe(true);
    expect(liveWriteBlocked("erp.po.submit", { shape: "fixture" })).toBe(false);
    expect(liveWriteBlocked("erp.po.get", { shape: "hvgerp" })).toBe(false);
  });
});

describe("PIN verification", () => {
  it("never compares the PIN as plain text and stores only salted scrypt hashes", async () => {
    const ctx = await ready();
    const pins: Any = ctx.nammaops.approvals.pins;
    // The in-memory credential holds a salt and a hash, never the PIN (and no `pin` field).
    expect(Object.keys(pins.env).sort()).toEqual(["hash", "salt"]);
    expect(JSON.stringify(pins.env)).not.toContain(PIN);
    expect("pin" in pins).toBe(false);
    expect(pins.env.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pins.env.salt).toMatch(/^[0-9a-f]{32}$/);
    ctx.nammaops.approvals.changePin(PIN, "5678");
    const stored = ctx.runtime.db.record("nammaops.owner-pin", "current");
    expect(Object.keys(stored).sort()).toEqual(["hash", "id", "revision", "salt", "updated_at"]);
    expect(JSON.stringify(stored)).not.toContain("5678");
    expect(() => ctx.nammaops.approvals.checkPin("5678")).not.toThrow();
    expect(() => ctx.nammaops.approvals.checkPin(PIN)).toThrow(/incorrect/);
  });

  it("locks after five wrong tries, and the lock survives a restart", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    for (let i = 0; i < 5; i += 1)
      await expect(ctx.nammaops.approvals.approve(approvalId, "0000")).rejects.toMatchObject({
        status: 403,
      });
    // Locked: even the right PIN is refused, and nothing is submitted.
    await expect(ctx.nammaops.approvals.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 429,
    });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
    // "Restart": a brand-new verifier over the same database is still locked.
    const restarted = new PinVerifier(ctx.runtime, {
      envPin: PIN,
      now: () => new Date("2026-11-01T10:00:00Z"),
    });
    expect(() => restarted.check(PIN)).toThrow(/Too many/);
    expect(restarted.status().locked_until).toBeTruthy();
    // The lock ends on its own.
    ctx.advance(6 * 60 * 1000);
    expect(() => ctx.nammaops.approvals.checkPin(PIN)).not.toThrow();
  });

  it("refuses to approve anything when no PIN has been set, and has no default PIN", async () => {
    const ctx = await ready({ pin: "" });
    const approvalId = (await drafts(ctx))[0];
    expect(ctx.nammaops.approvals.pinStatus().source).toBe("none");
    for (const guess of ["1234", "0000", ""])
      await expect(ctx.nammaops.approvals.approve(approvalId, guess)).rejects.toMatchObject({
        status: 409,
      });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
  });

  it("gives a proof that is single-use, short-lived and bound to one session", async () => {
    const ctx = await ready();
    const pins = ctx.nammaops.approvals.pins;
    const proof = pins.verify(PIN, { session: "A" });
    expect(() => pins.consume(proof, { session: "B" })).toThrow(/different session/);
    expect(() => pins.consume(proof, { session: "A" })).not.toThrow();
    expect(() => pins.consume(proof, { session: "A" })).toThrow(/already used/);
    const late = pins.verify(PIN, { session: "A" });
    ctx.advance(2 * 60 * 1000);
    expect(() => pins.consume(late, { session: "A" })).toThrow(/expired/);
    expect(() => pins.consume("pnp_made_up", { session: "A" })).toThrow(/required/);
  });

  it("keeps PIN-named arguments out of audit summaries", () => {
    expect(redact({ pin: "4826", supplier_pin: "1", shipping: "fast", mapping: 1 })).toEqual({
      pin: "[redacted]",
      supplier_pin: "[redacted]",
      shipping: "fast",
      mapping: 1,
    });
  });
});

describe("reads never ask for a PIN", () => {
  it("runs reads for every specialist with no approval and no PIN involved", async () => {
    const ctx = await ready();
    const read = (agent: string, id: string, args: Any = {}) =>
      ctx.nammaops.binding.call(agent, id, args, { correlationId: "reads" });
    await read("nammaops-inventory", "erp.items.list");
    await read("nammaops-finance", "erp.pnl", { from_date: TODAY, to_date: TODAY }).catch(() => {});
    await read("nammaops-procurement", "erp.po.open");
    const view = await (
      await ctx.nammaops.workflows.start({ text: "Check the stock of milk" })
    ).done;
    expect(view.status).toBe("completed");
    expect(ctx.runtime.governance.approvals()).toEqual([]);
    expect(ctx.nammaops.approvals.list()).toEqual([]);
    expect(ctx.runtime.db.record("nammaops.owner-pin-lock", "state")).toBeNull();
  });
});

describe("a write needs an owner approval that the ToolGateway re-validates", () => {
  it("refuses the submit without an approval, and creates a pending request, not a submission", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const name = ctx.nammaops.approvals.get(approvalId).erp_document_name;
    await expect(
      ctx.nammaops.binding.call("nammaops-po-submit", "erp.po.submit", { name }),
    ).rejects.toMatchObject({
      invocationStatus: "approval_required",
      workflowStatus: "blocked",
      approvalRequestId: expect.stringMatching(/^apr_/),
    });
    expect(ctx.poState().purchase_orders.find((po: Any) => po.name === name).docstatus).toBe(0);
  });

  it("submits after the PIN, with approval and execution recorded separately", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const owner = ctx.nammaops.approvals.get(approvalId);
    const done = await ctx.nammaops.approvals.approve(approvalId, { pin: PIN, session: "tab-1" });
    expect(done).toMatchObject({ status: "submitted", approved_via: "screen" });
    // 1) the gateway approval: bound to user, specialist, capability, exact arguments, session.
    const [gateway] = ctx.runtime.governance.approvals();
    expect(gateway).toMatchObject({
      status: "consumed",
      reviewer: OWNER_ACTOR,
      agent_id: "nammaops-po-submit",
      capability_id: submitCapability(ctx),
      session_id: "tab-1",
      approved_via: "screen",
      args_summary: { name: owner.erp_document_name },
    });
    expect(gateway.args_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The token is short-lived, not the request's 30 minutes.
    expect(Date.parse(gateway.expires_at) - Date.parse(gateway.decided_at)).toBeLessThanOrEqual(
      2 * 60 * 1000,
    );
    // 2) the execution: a separate invocation record that points at the approval.
    const submit = ctx.runtime.mcpGateway
      .invocations()
      .find((row: Any) => row.capability_id === submitCapability(ctx));
    expect(submit).toMatchObject({
      status: "completed",
      decision: "REQUIRES_APPROVAL",
      approval_id: gateway.request_id,
      agent_id: "nammaops-po-submit",
    });
    expect(submit.invocation_id).not.toBe(gateway.request_id);
    // 3) the owner-approval record's own history.
    expect(done.history.map((row: Any) => row.event)).toEqual(["approved", "submitted"]);
    expect(
      ctx.poState().purchase_orders.find((po: Any) => po.name === owner.erp_document_name)
        .docstatus,
    ).toBe(1);
  });

  it("rejects an expired approval request", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    ctx.advance(31 * 60 * 1000);
    await expect(ctx.nammaops.approvals.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 409,
    });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
  });

  it("rejects a replayed approval, both the owner request and the gateway token", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    await ctx.nammaops.approvals.approve(approvalId, PIN);
    await expect(ctx.nammaops.approvals.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 409,
    });
    const name = ctx.nammaops.approvals.get(approvalId).erp_document_name;
    const [token] = ctx.runtime.governance.approvals();
    const replay = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-po-submit",
      capabilityId: submitCapability(ctx),
      arguments: { name },
      approvalId: token.request_id,
      session: "panel",
    });
    expect(replay).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/already used/),
    });
    const submits = ctx.runtime.mcpGateway
      .invocations()
      .filter((row: Any) => row.capability_id === submitCapability(ctx));
    expect(submits.filter((row: Any) => row.status === "completed")).toHaveLength(1);
  });

  it("invalidates the approval when the arguments change", async () => {
    const ctx = await ready();
    const [first, second] = await drafts(ctx);
    const nameA = ctx.nammaops.approvals.get(first).erp_document_name;
    const nameB = ctx.nammaops.approvals.get(second).erp_document_name;
    const governance = ctx.runtime.governance;
    const capability = ctx.runtime.capabilities.get(submitCapability(ctx));
    const requestId = governance.requestApproval({
      agentId: "nammaops-po-submit",
      capability,
      args: { name: nameA },
      correlationId: "c1",
    });
    governance.issueOwnerApproval(requestId, { actor: OWNER_ACTOR, session: "s1" });
    const changed = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-po-submit",
      capabilityId: submitCapability(ctx),
      arguments: { name: nameB },
      approvalId: requestId,
      session: "s1",
    });
    expect(changed).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/Arguments differ/),
    });
    expect(ctx.poState().purchase_orders.find((po: Any) => po.name === nameB).docstatus).toBe(0);
  });

  it("binds the approval to its specialist and session, and a wrong try does not spend it", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const name = ctx.nammaops.approvals.get(approvalId).erp_document_name;
    const governance = ctx.runtime.governance;
    const requestId = governance.requestApproval({
      agentId: "nammaops-po-submit",
      capability: ctx.runtime.capabilities.get(submitCapability(ctx)),
      args: { name },
      correlationId: "c2",
    });
    governance.issueOwnerApproval(requestId, { actor: OWNER_ACTOR, session: "tab-A" });
    // A different specialist cannot use it.
    expect(() =>
      governance.consumeApproval(requestId, {
        agentId: "nammaops-procurement",
        capabilityId: submitCapability(ctx),
        args: { name },
        session: "tab-A",
      }),
    ).toThrow(/different agent or tool/);
    // A different session cannot use it.
    const other = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-po-submit",
      capabilityId: submitCapability(ctx),
      arguments: { name },
      approvalId: requestId,
      session: "tab-B",
    });
    expect(other).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/different session/),
    });
    expect(ctx.poState().purchase_orders.find((po: Any) => po.name === name).docstatus).toBe(0);
    // The failed attempts did not consume it: the right session still can, once.
    const good = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-po-submit",
      capabilityId: submitCapability(ctx),
      arguments: { name },
      approvalId: requestId,
      session: "tab-A",
    });
    expect(good.status).toBe("completed");
  });

  it("lets a token expire within minutes", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const name = ctx.nammaops.approvals.get(approvalId).erp_document_name;
    const governance = ctx.runtime.governance;
    const requestId = governance.requestApproval({
      agentId: "nammaops-po-submit",
      capability: ctx.runtime.capabilities.get(submitCapability(ctx)),
      args: { name },
      correlationId: "c3",
    });
    governance.issueOwnerApproval(requestId, { actor: OWNER_ACTOR, session: "s" });
    ctx.advance(3 * 60 * 1000);
    const late = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-po-submit",
      capabilityId: submitCapability(ctx),
      arguments: { name },
      approvalId: requestId,
      session: "s",
    });
    expect(late).toMatchObject({ status: "denied", error: expect.stringMatching(/expired/) });
  });

  it("only the owner, after the PIN, can issue an approval: not an agent, not the developer path", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const name = ctx.nammaops.approvals.get(approvalId).erp_document_name;
    const governance = ctx.runtime.governance;
    const requestId = governance.requestApproval({
      agentId: "nammaops-po-submit",
      capability: ctx.runtime.capabilities.get(submitCapability(ctx)),
      args: { name },
      correlationId: "c4",
    });
    for (const actor of ["nammaops-procurement", "nammaops-po-submit", "nammaops-manager", "main"])
      expect(() => governance.issueOwnerApproval(requestId, { actor, session: "s" })).toThrow(
        /Only the owner/,
      );
    expect(() => governance.decideApproval(requestId, "approved", "nammaops-finance")).toThrow(
      /Only the developer/,
    );
    expect(governance.approvals()[0].status).toBe("pending");
  });

  it("keeps every other specialist, and the Manager, denied the submit even with an approval", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const name = ctx.nammaops.approvals.get(approvalId).erp_document_name;
    for (const agent of [
      "nammaops-manager",
      "nammaops-inventory",
      "nammaops-sales",
      "nammaops-procurement",
      "nammaops-finance",
      "nammaops-reports",
      "nammaops-billing",
      "nammaops-dashboard-reader",
    ])
      await expect(
        ctx.nammaops.binding.call(agent, "erp.po.submit", { name }),
      ).rejects.toMatchObject({ invocationStatus: "denied" });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
    // And no grant was added anywhere by approving.
    const grantsBefore = ctx.runtime.governance.grants().length;
    await ctx.nammaops.approvals.approve(approvalId, PIN);
    expect(ctx.runtime.governance.grants()).toHaveLength(grantsBefore);
    const manager = ctx.runtime.governance.effective("nammaops-manager");
    expect(manager.assigned).toEqual([]);
  });
});

describe("EmergencyStop", () => {
  it("voids the approval and submits nothing, even with the right PIN", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    ctx.estop.on = true;
    expect(ctx.nammaops.approvals.get(approvalId).status).toBe("invalidated");
    await expect(ctx.nammaops.approvals.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 423,
    });
    // The PIN was not even tried, so it did not count against the lockout.
    expect(ctx.nammaops.approvals.pins.lock().failures).toBe(0);
    ctx.estop.on = false;
    // Releasing the stop does not revive it: the owner must prepare the order again.
    expect(ctx.nammaops.approvals.get(approvalId).status).toBe("invalidated");
    await expect(ctx.nammaops.approvals.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 409,
    });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
  });

  it("stops a call that already holds an approval at the ToolGateway, and voids that token", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const name = ctx.nammaops.approvals.get(approvalId).erp_document_name;
    const governance = ctx.runtime.governance;
    const requestId = governance.requestApproval({
      agentId: "nammaops-po-submit",
      capability: ctx.runtime.capabilities.get(submitCapability(ctx)),
      args: { name },
      correlationId: "c5",
    });
    governance.issueOwnerApproval(requestId, { actor: OWNER_ACTOR, session: "s" });
    ctx.estop.on = true;
    const stopped = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-po-submit",
      capabilityId: submitCapability(ctx),
      arguments: { name },
      approvalId: requestId,
      session: "s",
    });
    expect(stopped).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/Emergency stop/),
    });
    ctx.estop.on = false;
    expect(governance.approvals().find((row: Any) => row.request_id === requestId)).toMatchObject({
      status: "invalidated",
      invalidated_reason: "Emergency stop engaged.",
    });
    const again = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-po-submit",
      capabilityId: submitCapability(ctx),
      arguments: { name },
      approvalId: requestId,
      session: "s",
    });
    expect(again.status).toBe("denied");
    expect(ctx.poState().purchase_orders.find((po: Any) => po.name === name).docstatus).toBe(0);
  });

  it("does not pause reads (it pauses new side-effecting work only)", async () => {
    const ctx = await ready();
    ctx.estop.on = true;
    await expect(
      ctx.nammaops.binding.call("nammaops-inventory", "erp.items.list", {}),
    ).resolves.toBeTruthy();
  });
});

describe("live writes stay disabled, whatever the PIN or approval", () => {
  it("refuses a live approval before the PIN is even checked and never reaches the ERP", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const record = ctx.runtime.db.record("nammaops.owner-approval", approvalId);
    const call = vi.fn();
    const liveLike = {
      binding: { shape: "hvgerp" },
      call,
      capabilityId: () => null,
    };
    const live = new OwnerApprovals(ctx.runtime, { binding: liveLike, pin: PIN });
    await expect(live.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Live ERP writes of this kind are disabled/),
    });
    await expect(live.approveByVoice({ call: { id: "v1" }, approvalId })).rejects.toMatchObject({
      status: 409,
    });
    expect(call).not.toHaveBeenCalled();
    expect(live.pins.lock().failures).toBe(0);
    // The request itself is untouched.
    expect(ctx.runtime.db.record("nammaops.owner-approval", approvalId).status).toBe(record.status);
  });

  it("the real live binding has no submit or draft tool to approve", () => {
    const live = loadBinding("config/nammaops/binding.hvgerp.json");
    for (const id of ["erp.po.create_draft", "erp.po.submit"])
      expect(live.capabilities[id]).toMatchObject({ tool: null, disabled: expect.any(String) });
  });
});

describe("spoken PIN: the server hears it, the transcript never keeps it", () => {
  const voiceFor = (ctx: Any, name = "Alice", seatId = "seat-m") => {
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
    return {
      callId,
      tool: (args: Any, tool = "approve_by_voice") =>
        runVoiceAgentTool(tool, args, (toolName: string, parameters: Any) =>
          service.action({ tool: toolName, callId, actionId: `act_${++n}`, args: parameters }),
        ) as Promise<Any>,
      owner: (id: string, content: string) =>
        service.finalize({
          callId,
          id,
          role: "user",
          content,
          timestamp: new Date().toISOString(),
        }),
    };
  };

  it("approves by voice: pin_required, the owner speaks, the next call submits", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const voice = voiceFor(ctx);
    const first = await voice.tool({ approval_id: approvalId });
    expect(first).toMatchObject({ status: "pin_required", approval_id: approvalId });
    expect(JSON.stringify(first)).not.toContain(PIN);
    // The owner says the PIN; the server checks it as the turn is saved and hides the digits.
    const saved = voice.owner("u1", `my pin is ${SPOKEN_PIN}`);
    expect(saved.content).toBe("my pin is [PIN hidden]");
    expect(saved.pinRedacted).toBe(true);
    const done = await voice.tool({ approval_id: approvalId });
    expect(done).toMatchObject({ status: "submitted" });
    expect(JSON.stringify(done)).not.toContain(PIN);
    expect(ctx.poState().purchase_orders.filter((po: Any) => po.docstatus === 1)).toHaveLength(1);
    // The gateway approval records the channel and ties it to this call.
    expect(ctx.runtime.governance.approvals()[0]).toMatchObject({
      approved_via: "voice",
      session_id: voice.callId,
      reviewer: OWNER_ACTOR,
    });
  });

  it("never writes the spoken digits anywhere: not in messages, events, records or audit", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const voice = voiceFor(ctx);
    await voice.tool({ approval_id: approvalId });
    voice.owner("u1", `pin ${SPOKEN_PIN}`);
    await voice.tool({ approval_id: approvalId });
    const stored = everythingStored(ctx);
    expect(stored).not.toContain(PIN);
    for (const fragment of ["nine zero four one", "seven three five two", "9041 7352"])
      expect(stored).not.toContain(fragment);
    expect(stored).toContain("[PIN hidden]");
    // A client retry of the same finalized turn is accepted, and still stores nothing.
    expect(() => voice.owner("u1", `pin ${SPOKEN_PIN}`)).not.toThrow();
    expect(everythingStored(ctx)).not.toContain(PIN);
  });

  it("hides digits said in any form while waiting, and leaves other speech alone", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const voice = voiceFor(ctx);
    await voice.tool({ approval_id: approvalId });
    expect(voice.owner("u1", "what is this for?").content).toBe("what is this for?");
    // Partial or malformed digits are hidden too, and the challenge stays open.
    expect(voice.owner("u2", "um nine zero four").content).toBe("um [PIN hidden]");
    expect(ctx.nammaops.approvals.hasPinChallenge(voice.callId)).toBe(true);
    expect(extractSpokenPin("it is 9 0 4 1 7 3 5 2")).toBe("90417352");
    expect(extractSpokenPin("४८२६")).toBe("4826");
    expect(extractSpokenPin("char aath do chhe")).toBe("4826");
    expect(extractSpokenPin("call me on 12")).toBeNull();
    expect(redactSpokenDigits("I have 3 apples")).toBe("I have 3 apples");
    expect(redactSpokenDigits("code 1 2 3 4")).toBe("code [PIN hidden]");
  });

  it("does nothing and says so when the PIN is wrong, and the failures lock persistently", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const voice = voiceFor(ctx);
    for (let i = 0; i < 5; i += 1) {
      expect(await voice.tool({ approval_id: approvalId })).toMatchObject({
        status: "pin_required",
      });
      voice.owner(`w${i}`, "one two three four");
      const rejected = await voice.tool({ approval_id: approvalId });
      expect(rejected).toMatchObject({ status: "pin_rejected" });
      expect(rejected.reason).toBe(i === 4 ? "incorrect" : "incorrect");
    }
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
    // Five wrong PINs by voice lock the on-screen PIN too: one shared, persistent lockout.
    await expect(ctx.nammaops.approvals.approve(approvalId, PIN)).rejects.toMatchObject({
      status: 429,
    });
    await expect(voice.tool({ approval_id: approvalId })).rejects.toMatchObject({ status: 429 });
  });

  it("refuses a PIN or any extra argument in the tool call", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const voice = voiceFor(ctx);
    await expect(voice.tool({ approval_id: approvalId, pin: PIN })).rejects.toMatchObject({
      status: 400,
    });
    await expect(voice.tool({ approval_id: approvalId, extra: "x" })).rejects.toMatchObject({
      status: 400,
    });
    // The id is optional (a draft made in text chat has none the voice agent knows); with several
    // waiting the owner is asked which, and nothing is chosen or approved for them.
    expect(await voice.tool({})).toMatchObject({ status: "which_one" });
    await expect(voice.tool({ approval_id: 42 })).rejects.toMatchObject({ status: 400 });
    expect(everythingStored(ctx)).not.toContain(PIN);
  });

  it("expires an unanswered challenge, and one call's PIN cannot approve in another call", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const alice = voiceFor(ctx, "Alice", "seat-m");
    const bob = voiceFor(ctx, "Bob", "seat-i");
    await alice.tool({ approval_id: approvalId });
    ctx.advance(3 * 60 * 1000);
    // The old challenge has lapsed, so the owner is asked again instead of anything being approved.
    expect(await alice.tool({ approval_id: approvalId })).toMatchObject({ status: "pin_required" });
    // Bob's call has no challenge: the PIN Alice's call heard means nothing to Bob.
    alice.owner("u9", `pin ${SPOKEN_PIN}`);
    expect(await bob.tool({ approval_id: approvalId })).toMatchObject({ status: "pin_required" });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
    // Alice's verified PIN is bound to Alice's call and still works there, once.
    expect(await alice.tool({ approval_id: approvalId })).toMatchObject({ status: "submitted" });
  });

  it("waits briefly for a PIN that has not been heard yet, and approves nothing meanwhile", async () => {
    const ctx = await ready();
    ctx.nammaops.approvals.voiceWaitTries = 1;
    const approvalId = (await drafts(ctx))[0];
    const voice = voiceFor(ctx);
    await voice.tool({ approval_id: approvalId });
    expect(await voice.tool({ approval_id: approvalId })).toMatchObject({
      status: "waiting_for_pin",
    });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
  });

  it("is stopped by the EmergencyStop even after the PIN was spoken", async () => {
    const ctx = await ready();
    const approvalId = (await drafts(ctx))[0];
    const voice = voiceFor(ctx);
    await voice.tool({ approval_id: approvalId });
    voice.owner("u1", `pin ${SPOKEN_PIN}`);
    ctx.estop.on = true;
    await expect(voice.tool({ approval_id: approvalId })).rejects.toMatchObject({ status: 423 });
    expect(ctx.poState().purchase_orders.every((po: Any) => po.docstatus === 0)).toBe(true);
  });

  it("the on-screen redactor behaves exactly like the server's", () => {
    for (const sample of [
      `my pin is ${SPOKEN_PIN}`,
      "it is 9 0 4 1 7 3 5 2",
      "४८२६ yes",
      "char aath do chhe",
      "I have 3 apples and two friends",
      "one two",
      "nothing to hide here",
      "pin 90417352, thanks",
    ])
      expect(hideSpokenDigits(sample), sample).toBe(redactSpokenDigits(sample));
  });

  it("does not offer approve_by_voice to anything outside the voice allowlist", async () => {
    const ctx = await ready();
    const voice = voiceFor(ctx);
    const result = await voice.tool({ approval_id: "own_x" }, "approve_purchase_order");
    expect(result).toMatchObject({ error: expect.stringMatching(/Unsupported voice action/) });
  });
});
