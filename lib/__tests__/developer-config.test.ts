import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { TaskDatabase } from "../server/task-db.mjs";
import { SPECIALIST_CATALOGUE } from "../server/specialist-catalogue.mjs";
import { AgentProfiles } from "../server/agent-profiles.mjs";
import { AgentTasks } from "../server/agent-tasks.mjs";
import {
  DeveloperGenerations,
  Specializations,
  DEVELOPER_ACTOR,
  buildProposal,
  capabilityInventory,
  matchCapabilities,
  parseProposal,
  recommendPermissions,
  validateConfig,
} from "../server/developer-config.mjs";
import { developerRoute, handleDeveloperApi } from "../server/developer-api.mjs";

// Model output here is fixed text standing in for an OpenClaw reply. Passing these tests says
// nothing about live generation quality; it proves parsing, policy and enforcement only.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const open: TaskDatabase[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

function harness({ grants = [{ manifestId: "data-steward-researcher", seatId: "seat-i" }] } = {}) {
  const db = new TaskDatabase(":memory:") as Any;
  open.push(db);
  const owner: Any = {
    gatewayId: "gw",
    gateway: { provider: "openclaw", status: "connected" },
    db,
    resolve: (seatId: string) => {
      if (seatId === "unbound")
        throw new Error("This seat has no available backend agent binding.");
      return {
        seat: { seatId, binding: { revision: 3 } },
        agentId: "backend",
        sessionKey: "agent:backend:main",
      };
    },
    submit: vi.fn((input: Any) =>
      db.insertTask({
        taskId: input.taskId,
        gatewayId: "gw",
        agentId: "backend",
        sessionKey: input.sessionKey,
        seatId: input.seatId,
        message: input.message,
        status: "queued",
        createdAt: "2026-11-01T00:00:00.000Z",
      }),
    ),
  };
  const runtime: Any = {
    db,
    gateway: owner.gateway,
    seatOwner: () => owner,
    taskOwner: () => owner,
    estop: { status: () => ({ engaged: false }) },
    services: {
      snapshot: () => ({
        services: [
          { id: "zetaris", available: true, configuration: { configured: true } },
          { id: "web-search", available: false, configuration: { configured: false } },
        ],
      }),
    },
    operations: {
      registry: {
        catalogue: SPECIALIST_CATALOGUE,
        entry: (id: string) => SPECIALIST_CATALOGUE.find((row: Any) => row.manifest.id === id),
        grantsFor: (id: string) => grants.filter((grant) => grant.manifestId === id),
      },
      routing: {
        selectTask: vi.fn(() => ({ status: "assigned", assignment: { seatId: "seat-i" } })),
      },
    },
  };
  runtime.profiles = new AgentProfiles(runtime);
  runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
  runtime.generations = new DeveloperGenerations(runtime, { seatId: "gen-seat" });
  runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
  return { runtime, owner, db };
}

const inventoryAnalyst = {
  name: "Inventory Analyst",
  specialization: "Inventory investigation",
  description: "Investigates stock discrepancies and prepares evidence-based reports.",
  purpose: "Explain stock discrepancies with evidence.",
  responsibilities: ["Investigate stock discrepancies", "Analyze inventory movements"],
  allowed_actions: ["Read inventory records", "Prepare evidence-based reports"],
  forbidden_actions: [
    { text: "Modify inventory records", category: "write" },
    { text: "Submit stock adjustments", category: "write" },
  ],
  inputs: ["SKU", "location"],
  outputs: ["Discrepancy report"],
  integrations: ["inventory ledger"],
  data_access: "read_only",
  safety: ["Never change stock"],
  requested_capabilities: [
    { id: "read_operational_records", reason: "Read stock movements", confidence: "high" },
    { id: "verify_evidence", reason: "Check its own evidence", confidence: "medium" },
  ],
  requested_permissions: [{ id: "executor", reason: "Could apply fixes" }],
};

const researchAnalyst = {
  name: "Research Analyst",
  specialization: "Topic research",
  description: "Researches a topic and compares findings in a structured report.",
  purpose: "Collect and compare evidence on a topic.",
  responsibilities: ["Research a topic", "Compare findings"],
  allowed_actions: ["Search public sources", "Write a structured report"],
  forbidden_actions: [{ text: "Claim a tool ran when it did not", category: "other" }],
  data_access: "read_only",
  requested_capabilities: [
    { id: "research_external_sources", reason: "Collect evidence", confidence: "high" },
    { id: "verify_evidence", reason: "Compare findings", confidence: "high" },
  ],
};

const reply = (value: unknown) => `Here is the draft:\n${JSON.stringify(value)}\nDone.`;

describe("requirement extraction and model output", () => {
  it("extracts structured requirements from a reply", () => {
    const { requirements } = parseProposal(reply(inventoryAnalyst));
    expect(requirements).toMatchObject({
      purpose: "Explain stock discrepancies with evidence.",
      data_access: "read_only",
      inputs: ["SKU", "location"],
      outputs: ["Discrepancy report"],
      forbidden_actions: [
        { text: "Modify inventory records", category: "write" },
        { text: "Submit stock adjustments", category: "write" },
      ],
    });
    expect(requirements.requested_capabilities[0]).toEqual({
      id: "read_operational_records",
      reason: "Read stock movements",
      confidence: "high",
      required: true,
    });
  });

  it("rejects malformed and off-schema model output instead of repairing it", () => {
    expect(() => parseProposal("")).toThrow(/no output/);
    expect(() => parseProposal("I cannot help with that.")).toThrow(/no JSON/);
    expect(() => parseProposal("{not json}")).toThrow(/not valid JSON/);
    expect(() =>
      parseProposal(JSON.stringify({ ...inventoryAnalyst, data_access: "admin" })),
    ).toThrow(/data_access/);
    expect(() =>
      parseProposal(JSON.stringify({ ...inventoryAnalyst, forbidden_actions: ["no category"] })),
    ).toThrow(/forbidden_actions/);
    expect(parseProposal(JSON.stringify({ ...inventoryAnalyst, extra: 1 })).ignored).toEqual([
      "extra",
    ]);
  });
});

describe("capability matching and permission recommendations", () => {
  const setup = () => {
    const { runtime } = harness();
    return { runtime, inventory: capabilityInventory(runtime) };
  };

  it("builds the inventory from the registered catalogue only", () => {
    const { inventory } = setup();
    expect(inventory.capabilities.map((row: Any) => row.id)).toContain("read_operational_records");
    const steward = inventory.manifests.find((row: Any) => row.id === "data-steward-researcher");
    expect(steward).toMatchObject({ risk: "medium", grantedSeats: ["seat-i"] });
    expect(steward.integrations).toEqual(
      expect.arrayContaining([
        { id: "zetaris", configured: true, available: true },
        { id: "web-search", configured: false, available: false },
      ]),
    );
  });

  it("classifies available, requires authorization, unavailable, ambiguous and not required", () => {
    const { inventory } = setup();
    const matches = matchCapabilities(
      [
        { id: "read_operational_records", reason: "r", confidence: "high", required: true },
        { id: "verify_evidence", reason: "r", confidence: "high", required: true },
        { id: "delete_everything", reason: "r", confidence: "high", required: true },
        { id: "analyze_evidence", reason: "r", confidence: "high", required: true },
        { id: "plan_dependencies", reason: "r", confidence: "low", required: true },
        { id: "decompose_task", reason: "r", confidence: "high", required: false },
      ],
      inventory,
      { seatId: "seat-i" },
    );
    expect(matches.map((row: Any) => [row.id, row.status])).toEqual([
      ["read_operational_records", "available"],
      ["verify_evidence", "requires_authorization"],
      ["delete_everything", "unavailable"],
      ["analyze_evidence", "unavailable"],
      ["plan_dependencies", "ambiguous"],
      ["decompose_task", "not_required"],
    ]);
    expect(matches[2].detail).toMatch(/Not a registered capability/);
    expect(matches[0].tools).toContain("zetaris.read");
  });

  it("separates existing, additional, high-risk, unsupported and conflicting permissions", () => {
    const { inventory } = setup();
    const { requirements } = parseProposal(
      JSON.stringify({
        ...inventoryAnalyst,
        requested_permissions: [
          { id: "executor", reason: "fixes" },
          { id: "root-access", reason: "everything" },
          { id: "nightshift-analyst", reason: "analysis" },
        ],
      }),
    );
    const matches = matchCapabilities(requirements.requested_capabilities, inventory, {
      seatId: "seat-i",
    });
    const rows = recommendPermissions(requirements, matches, inventory, { seatId: "seat-i" });
    const by = Object.fromEntries(rows.map((row: Any) => [row.id, row]));
    expect(by["data-steward-researcher"]).toMatchObject({
      classification: "existing",
      exists: true,
      risk: "medium",
    });
    expect(by.critic).toMatchObject({ classification: "additional_recommended", exists: false });
    expect(by.executor).toMatchObject({
      classification: "not_required",
      risk: "high",
      requires_approval: false,
    });
    expect(by["root-access"]).toMatchObject({ classification: "unsupported" });
    expect(by["nightshift-analyst"]).toMatchObject({ classification: "unsupported" });

    const writer = parseProposal(
      JSON.stringify({ ...inventoryAnalyst, data_access: "scoped_write", forbidden_actions: [] }),
    ).requirements;
    const high = recommendPermissions(writer, [], inventory, { seatId: "seat-i" });
    expect(high.find((row: Any) => row.id === "executor")).toMatchObject({
      classification: "high_risk",
      requires_approval: true,
      operation: "write",
    });
  });
});

describe("policy validation", () => {
  const base = (runtime: Any) =>
    buildProposal(parseProposal(reply(inventoryAnalyst)), runtime, { seatId: "seat-i" }).config;

  it("rejects unknown capabilities and unsupported permissions", () => {
    const { runtime } = harness();
    const config = base(runtime);
    const result = validateConfig(
      {
        ...config,
        capabilities: [...config.capabilities, "launch_rockets"],
        permissions: [...config.permissions, "god-mode"],
      },
      runtime,
    );
    expect(result.status).toBe("blocked");
    expect(result.missing_capabilities).toEqual(["launch_rockets"]);
    expect(result.unsupported_permissions).toEqual(["god-mode"]);
  });

  it("requires explicit approval for high-risk permissions", () => {
    const { runtime } = harness();
    const config = {
      ...base(runtime),
      data_access: "scoped_write",
      forbidden_actions: [],
      allowed_actions: ["Apply approved corrections"],
      permissions: ["executor"],
      capabilities: ["execute_approved_action"],
    };
    const result = validateConfig(config, runtime);
    expect(result.status).toBe("requires_developer_approval");
    expect(result.required_approvals).toEqual([
      { id: "executor", risk: "high", high_risk: true, decision: "pending" },
    ]);
  });

  it("blocks conflicting allowed and forbidden actions and write permissions that are forbidden", () => {
    const { runtime } = harness();
    const config = base(runtime);
    expect(
      validateConfig(
        { ...config, allowed_actions: ["Modify inventory records"] },
        runtime,
      ).errors.join(),
    ).toMatch(/conflicts with a forbidden action/);
    expect(
      validateConfig(
        { ...config, permissions: [...config.permissions, "executor"] },
        runtime,
      ).errors.join(),
    ).toMatch(/executor allows writes/);
  });

  it("validates the runtime binding and provider", () => {
    const { runtime } = harness();
    const config = base(runtime);
    expect(
      validateConfig({ ...config, runtime: { provider: "openclaw", seat_id: "unbound" } }, runtime),
    ).toMatchObject({
      status: "blocked",
    });
    expect(
      validateConfig(
        { ...config, runtime: { provider: "nightshift", seat_id: "seat-i" } },
        runtime,
      ).errors.join(),
    ).toMatch(/runs on openclaw/);
    expect(validateConfig({ ...config, runtime: { provider: "other" } }, runtime).status).toBe(
      "blocked",
    );
  });

  it("refuses secret-like values in instructions", () => {
    const { runtime } = harness();
    const result = validateConfig(
      { ...base(runtime), instructions: "Use api_key=abc123 when calling." },
      runtime,
    );
    expect(result.errors.join()).toMatch(/secret-like/);
  });
});

describe("two specializations through one pipeline", () => {
  it("Inventory Analyst: read-only access recommended, stock modification not authorised", () => {
    const { runtime } = harness();
    const proposal = buildProposal(parseProposal(reply(inventoryAnalyst)), runtime, {
      seatId: "seat-i",
    });
    expect(proposal.config.permissions).toEqual(["data-steward-researcher", "critic"]);
    expect(proposal.config.permissions).not.toContain("executor");
    expect(
      proposal.permission_recommendations.find((row: Any) => row.id === "executor")?.classification,
    ).toBe("not_required");
    expect(proposal.config.instructions).toMatch(/Forbidden actions:\n- Modify inventory records/);
    expect(proposal.config.instructions).toMatch(/grants no permissions/);
    expect(proposal.validation.status).toBe("requires_developer_approval");
  });

  it("Research Analyst: same functions, different configuration, honest integration status", () => {
    const { runtime } = harness();
    const proposal = buildProposal(parseProposal(reply(researchAnalyst)), runtime, {
      seatId: "seat-r",
    });
    expect(proposal.config.specialization).toBe("Topic research");
    expect(
      proposal.permission_recommendations.map((row: Any) => [row.id, row.classification]),
    ).toEqual([
      ["data-steward-researcher", "additional_recommended"],
      ["critic", "additional_recommended"],
    ]);
    const research = proposal.capabilities.find(
      (row: Any) => row.id === "research_external_sources",
    );
    expect(research.integrations).toContainEqual({
      id: "web-search",
      configured: false,
      available: false,
    });
    expect(proposal.validation.warnings.join()).toMatch(/no reviewed grant on seat seat-r/);
  });

  it("contains no specialization-specific branching", () => {
    for (const file of ["developer-config.mjs", "developer-api.mjs"]) {
      const source = readFileSync(new URL(`../server/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /(===|!==|case)\s*["'](inventory|research|sales|finance|procurement)/i,
      );
      expect(source).not.toMatch(/agentType/);
    }
  });
});

describe("generation through the runtime", () => {
  it("submits a task, then builds a proposal only from completed, tool-free output", () => {
    const { runtime, owner, db } = harness();
    const pending = runtime.generations.generate({
      description: "Create an Inventory Analyst that investigates stock discrepancies.",
      seat_id: "seat-i",
    });
    expect(pending.status).toBe("generating");
    expect(owner.submit.mock.calls[0][0].message).toMatch(/Do not call any tools/);
    db.updateTask(pending.generation_id, { status: "completed", result: reply(inventoryAnalyst) });
    const done = runtime.generations.view(pending.generation_id);
    expect(done.status).toBe("proposed");
    expect(done.proposal.config.name).toBe("Inventory Analyst");
    expect(done.source).toMatchObject({ runtime: "openclaw", seat_id: "gen-seat" });
  });

  it("discards output when the generation agent used tools, and keeps the description on failure", () => {
    const { runtime, db } = harness();
    const description = "Create a research analyst for comparing sources on a topic.";
    const first = runtime.generations.generate({ description });
    db.saveMessage({
      id: `tool_${first.generation_id}_1`,
      taskId: first.generation_id,
      sessionKey: "agent:backend:main",
      role: "tool",
      toolName: "openclaw.browser",
      timestamp: "2026-11-01T00:00:01.000Z",
    });
    db.updateTask(first.generation_id, { status: "completed", result: reply(researchAnalyst) });
    expect(runtime.generations.view(first.generation_id)).toMatchObject({
      status: "blocked",
      description,
    });

    const second = runtime.generations.generate({ description });
    db.updateTask(second.generation_id, { status: "completed", result: "Sorry, no JSON today." });
    expect(runtime.generations.view(second.generation_id)).toMatchObject({
      status: "failed",
      description,
    });

    const third = runtime.generations.generate({ description });
    db.updateTask(third.generation_id, { status: "outcome_unknown" });
    expect(runtime.generations.view(third.generation_id).status).toBe("failed");
  });

  it("returns the description when no generation seat is configured", () => {
    const { runtime } = harness();
    runtime.generations = new DeveloperGenerations(runtime, {});
    const description = "Create an agent that summarises maintenance history.";
    expect(() => runtime.generations.generate({ description })).toThrow(/No generation seat/);
    try {
      runtime.generations.generate({ description });
    } catch (error: Any) {
      expect(error.body).toMatchObject({ status: "unavailable", description });
    }
  });
});

describe("save, versions, approvals and runtime enforcement", () => {
  const proposalFor = (runtime: Any) =>
    buildProposal(parseProposal(reply(inventoryAnalyst)), runtime, { seatId: "seat-i" }).config;

  it("needs confirmation, refuses blocked configs unless draft, and versions updates", () => {
    const { runtime } = harness();
    const config = proposalFor(runtime);
    expect(() => runtime.specializations.save({ config })).toThrow(/confirm/);
    expect(() =>
      runtime.specializations.save({
        confirm: true,
        config: { ...config, permissions: ["god-mode"] },
      }),
    ).toThrow(/blocked/);
    const draft = runtime.specializations.save({
      confirm: true,
      draft: true,
      config: { ...config, permissions: ["god-mode"] },
    });
    expect(draft.specialization.approval_state).toBe("draft");

    const saved = runtime.specializations.save({ confirm: true, config }).specialization;
    expect(saved).toMatchObject({ version: 1, approval_state: "pending_approval" });
    expect(saved.generation_source).toEqual({ manual: true });
    const updated = runtime.specializations.update(saved.id, {
      confirm: true,
      config: { purpose: "Explain discrepancies faster." },
    }).specialization;
    expect(updated).toMatchObject({ version: 2, createdAt: saved.createdAt });
    expect(updated.config.purpose).toBe("Explain discrepancies faster.");
  });

  it("records approvals, never grants, and enforces revocation at runtime", async () => {
    const { runtime, owner } = harness();
    const config = proposalFor(runtime);
    const { id } = runtime.specializations.save({ confirm: true, config }).specialization;

    expect(() =>
      runtime.specializations.decide(
        id,
        "data-steward-researcher",
        { decision: "approved" },
        "lead-manager",
      ),
    ).toThrow(/Only the developer/);
    expect(() =>
      runtime.specializations.decide(id, "executor", { decision: "approved" }, DEVELOPER_ACTOR),
    ).toThrow(/not part of this configuration/);
    expect(() =>
      runtime.specializations.decide(
        id,
        "data-steward-researcher",
        { decision: "revoked" },
        DEVELOPER_ACTOR,
      ),
    ).toThrow(/Only an approved permission/);

    runtime.specializations.decide(
      id,
      "data-steward-researcher",
      { decision: "approved", reason: "read only" },
      DEVELOPER_ACTOR,
    );
    runtime.specializations.decide(id, "critic", { decision: "denied" }, DEVELOPER_ACTOR);
    const agent = runtime.specializations.assign(id, { agent_id: "inv-01", seat_id: "seat-i" });
    expect(agent).toMatchObject({
      permissions: ["data-steward-researcher"],
      specialization_id: id,
    });

    const request = { agent_id: "inv-01", input: { type: "text", text: "Why is SKU-17 short?" } };
    await expect(runtime.agentTasks.submitText(request)).resolves.toMatchObject({
      status: "queued",
    });

    const revoked = runtime.specializations.decide(
      id,
      "data-steward-researcher",
      { decision: "revoked" },
      DEVELOPER_ACTOR,
    );
    expect(revoked.history).toEqual([expect.objectContaining({ decision: "approved" })]);
    await expect(runtime.agentTasks.submitText(request)).rejects.toMatchObject({
      status: 409,
      body: { status: "blocked" },
    });
    expect(owner.submit).toHaveBeenCalledTimes(1);
  });

  it("blocks execution when a specialization permission was never approved", async () => {
    const { runtime } = harness();
    const { id } = runtime.specializations.save({
      confirm: true,
      config: proposalFor(runtime),
    }).specialization;
    runtime.profiles.create({
      agent_id: "inv-02",
      name: "Inventory Analyst",
      specialization: "Inventory investigation",
      instructions: "Investigate.",
      runtime: "openclaw",
      seat_id: "seat-i",
      permissions: ["data-steward-researcher"],
      specialization_id: id,
      specialization_version: 1,
    });
    await expect(
      runtime.agentTasks.submitText({
        agent_id: "inv-02",
        input: { type: "text", text: "Check stock." },
      }),
    ).rejects.toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/not approved \(pending\)/) },
    });
  });
});

describe("developer REST routes", () => {
  const call = (
    runtime: Any,
    method: string,
    path: string,
    body?: unknown,
    address = "127.0.0.1",
  ) => {
    const req: Any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = { "content-type": "application/json" };
    req.socket = { remoteAddress: address };
    return handleDeveloperApi(runtime, req, developerRoute(path) as Any);
  };

  it("maps both prefixes and refuses non-loopback callers", async () => {
    expect(developerRoute("/api/developer/agent-config/save")).toEqual({ rest: "/save" });
    expect(developerRoute("/api/runtime/developer/agent-config/x")).toEqual({ rest: "/x" });
    expect(developerRoute("/api/developer/other")).toBeNull();
    const { runtime } = harness();
    await expect(
      call(runtime, "GET", "/api/developer/agent-config", undefined, "10.0.0.5"),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it("validates, saves, reads, patches and decides over REST", async () => {
    const { runtime } = harness();
    const config = buildProposal(parseProposal(reply(researchAnalyst)), runtime, {}).config;
    const checked: Any = await call(runtime, "POST", "/api/developer/agent-config/validate", {
      config,
    });
    expect(checked.body.validation.status).toBe("requires_developer_approval");
    const saved: Any = await call(runtime, "POST", "/api/developer/agent-config/save", {
      confirm: true,
      config,
    });
    expect(saved.status).toBe(201);
    const id = saved.body.specialization.id;
    expect((await call(runtime, "GET", `/api/developer/agent-config/${id}`)).status).toBe(200);
    const patched: Any = await call(runtime, "PATCH", `/api/developer/agent-config/${id}`, {
      confirm: true,
      config: { name: "Research Analyst v2" },
    });
    expect(patched.body.specialization.version).toBe(2);
    const decided: Any = await call(
      runtime,
      "POST",
      `/api/developer/agent-config/${id}/permissions/critic`,
      {
        decision: "approved",
      },
    );
    expect(decided.body.approval).toMatchObject({
      decision: "approved",
      approver: DEVELOPER_ACTOR,
    });
  });
});
