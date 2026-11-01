import { createHash, randomBytes } from "node:crypto";
import Ajv from "ajv";
import { SERVER_NAMESPACE } from "./mcp-servers.mjs";
import { DEVELOPER_ACTOR } from "./developer-config.mjs";

export const CAPABILITY_NAMESPACE = "mcp.capability";
export const ASSIGNMENT_NAMESPACE = "mcp.assignment";
export const GRANT_NAMESPACE = "mcp.grant";
export const APPROVAL_NAMESPACE = "mcp.approval";
export const INVOCATION_NAMESPACE = "mcp.invocation";
export const DECISION_NAMESPACE = "mcp.decision";
export const RISKS = ["READ", "WRITE", "DESTRUCTIVE", "EXTERNAL_ACTION"];
/** Server-internal principals that act only inside a workflow gate; never reachable via the proxy. */
export const WORKFLOW_PRINCIPALS = new Set(["nammaops-po-submit"]);
export const DECISIONS = Object.freeze({
  ALLOW: "ALLOW",
  DENY: "DENY",
  REQUIRES_APPROVAL: "REQUIRES_APPROVAL",
  UNAVAILABLE: "UNAVAILABLE",
});
const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,128}$/;
const MAX_TOOLS = 200;
const MAX_RESPONSE_BYTES = 256 * 1024;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const SENSITIVE = /pass|secret|token|key|auth|credential/i;

const omit = (value, ...keys) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const fail = (status, message) => Object.assign(new Error(message), { status });
const id = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;

/** Canonical JSON so that key order never changes a fingerprint. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const fingerprint = (value) => createHash("sha256").update(canonical(value)).digest("hex");

/** Safe argument summary for audit and review: sensitive keys and long strings are not kept. */
export function redact(value, depth = 0) {
  if (depth > 4) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [key, SENSITIVE.test(key) ? "[redacted]" : redact(item, depth + 1)]),
    );
  return typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

/**
 * A suggestion only. MCP annotations are hints from the server, so an unreviewed tool is never
 * treated as safe: anything not explicitly read-only is at least WRITE.
 */
export function suggestedRisk(annotations = {}) {
  if (annotations.destructiveHint === true) return "DESTRUCTIVE";
  if (annotations.openWorldHint === true && annotations.readOnlyHint !== true)
    return "EXTERNAL_ACTION";
  if (annotations.readOnlyHint === true) return "READ";
  return "WRITE";
}

const capabilityId = (serverId, toolName) => `mcp.${serverId}.${toolName}`;

/** Discovery results become capability records; history is kept, never deleted. */
export class CapabilityRegistry {
  /** @param {any} db @param {any} servers @param {{now?: () => Date}} [options] */
  constructor(db, servers, { now } = {}) {
    this.db = db;
    this.servers = servers;
    this.now = now ?? (() => new Date());
    this.ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  }

  get(capability) {
    return this.view(this.db.record(CAPABILITY_NAMESPACE, capability));
  }

  list() {
    return this.db.records(CAPABILITY_NAMESPACE).map((row) => this.view(row));
  }

  view(record) {
    if (!record) return null;
    const { id: capability_id, revision } = record;
    const rest = omit(record, "id", "revision");
    const server = this.db.record(SERVER_NAMESPACE, rest.server_id);
    return {
      capability_id,
      ...rest,
      record_version: revision,
      // Tool state plus server state: a disabled or missing server makes every tool unavailable.
      availability:
        rest.tool_state !== "present"
          ? rest.tool_state
          : !server
            ? "server_removed"
            : server.enabled === false
              ? "server_disabled"
              : rest.schema_valid
                ? "available"
                : "invalid_schema",
    };
  }

  /** Runs MCP tools/list (paginated) and reconciles it with the stored capabilities. */
  async discover(serverId) {
    const client = await this.servers.client(serverId);
    const config = this.db.record(SERVER_NAMESPACE, serverId);
    const tools = [];
    let cursor;
    try {
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: config.request_timeout_ms,
        });
        tools.push(...(page.tools ?? []));
        cursor = page.nextCursor;
      } while (cursor && tools.length < MAX_TOOLS);
    } catch (error) {
      // The SDK rejects a tool list that breaks the MCP schema; nothing from it is registered.
      const message = `Tool discovery failed: ${String(error?.message ?? error).slice(0, 200)}`;
      this.servers.setHealth(serverId, { last_error: message });
      throw fail(502, message);
    }
    const at = this.now().toISOString();
    const seen = new Set();
    const summary = { added: [], changed: [], unchanged: [], removed: [], rejected: [] };
    for (const tool of tools.slice(0, MAX_TOOLS)) {
      if (!TOOL_NAME.test(String(tool?.name)) || seen.has(tool.name)) {
        summary.rejected.push(String(tool?.name ?? "(missing name)").slice(0, 128));
        continue;
      }
      seen.add(tool.name);
      const key = capabilityId(serverId, tool.name);
      const previous = this.db.record(CAPABILITY_NAMESPACE, key);
      let schemaValid = tool.inputSchema?.type === "object";
      if (schemaValid)
        try {
          this.ajv.compile(tool.inputSchema);
        } catch {
          schemaValid = false;
        }
      const print = fingerprint({
        input: tool.inputSchema ?? null,
        output: tool.outputSchema ?? null,
      });
      const changed = previous && previous.schema_fingerprint !== print;
      const base = {
        server_id: serverId,
        tool_name: tool.name,
        description: typeof tool.description === "string" ? tool.description.slice(0, 2000) : "",
        input_schema: tool.inputSchema ?? null,
        output_schema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? {},
        schema_valid: schemaValid,
        schema_fingerprint: print,
        schema_version: (previous?.schema_version ?? 0) + (previous && !changed ? 0 : 1),
        discovered_at: at,
        tool_state: "present",
      };
      if (!previous) {
        this.db.saveRecord(
          CAPABILITY_NAMESPACE,
          key,
          {
            ...base,
            state: "discovered",
            suggested_risk: suggestedRisk(tool.annotations),
            risk: null,
            review: { status: "pending", reasons: ["New tool; risk not reviewed."] },
            missing_metadata: base.description ? [] : ["description"],
            history: [],
          },
          0,
        );
        summary.added.push(key);
        continue;
      }
      const { revision } = previous;
      const rest = omit(previous, "id", "revision");
      this.db.saveRecord(
        CAPABILITY_NAMESPACE,
        key,
        {
          ...rest,
          ...base,
          suggested_risk: suggestedRisk(tool.annotations),
          // A materially changed tool goes back to review; old grants stop matching its fingerprint.
          ...(changed
            ? {
                state: "discovered",
                review: { status: "pending", reasons: ["Input or output schema changed."] },
                history: [
                  ...(rest.history ?? []),
                  { event: "schema_changed", at, from: rest.schema_fingerprint, to: print },
                ],
              }
            : {}),
        },
        revision,
      );
      (changed ? summary.changed : summary.unchanged).push(key);
    }
    for (const row of this.db.records(CAPABILITY_NAMESPACE))
      if (row.server_id === serverId && row.tool_state === "present" && !seen.has(row.tool_name)) {
        const { id: key, revision } = row;
        const rest = omit(row, "id", "revision");
        this.db.saveRecord(
          CAPABILITY_NAMESPACE,
          key,
          {
            ...rest,
            tool_state: "removed",
            history: [...(rest.history ?? []), { event: "removed", at }],
          },
          revision,
        );
        summary.removed.push(key);
      }
    this.servers.setHealth(serverId, { last_discovery_at: at });
    return summary;
  }

  /** Developer review: sets the authoritative risk. Server hints never set it. */
  /** @param {string} capability @param {{risk: string, approval_required?: boolean, notes?: string}} input @param {string} actor */
  review(capability, { risk, approval_required, notes }, actor) {
    if (actor !== DEVELOPER_ACTOR) throw fail(403, "Only the developer can review capabilities.");
    const record = this.db.record(CAPABILITY_NAMESPACE, capability);
    if (!record) throw fail(404, "Capability not found.");
    if (!RISKS.includes(risk)) throw fail(400, `risk must be one of ${RISKS.join(", ")}.`);
    if (approval_required !== undefined && typeof approval_required !== "boolean")
      throw fail(400, "approval_required must be a boolean.");
    if (notes !== undefined && (typeof notes !== "string" || notes.length > 500))
      throw fail(400, "notes must be up to 500 characters.");
    if (!record.schema_valid)
      throw fail(409, "A tool with an invalid input schema cannot be registered.");
    const { revision } = record;
    const rest = omit(record, "id", "revision");
    const at = this.now().toISOString();
    return this.view(
      this.db.saveRecord(
        CAPABILITY_NAMESPACE,
        capability,
        {
          ...rest,
          state: "registered",
          risk,
          // READ may run without per-call approval; anything else needs it unless a reviewer says not.
          approval_required: risk === "DESTRUCTIVE" ? true : (approval_required ?? risk !== "READ"),
          review: {
            status: "reviewed",
            by: actor,
            at,
            schema_fingerprint: rest.schema_fingerprint,
            notes: notes ?? null,
          },
          history: [...(rest.history ?? []), { event: "reviewed", at, risk }],
        },
        revision,
      ),
    );
  }

  /** Strict input validation against the currently discovered schema. */
  validateInput(capability, args) {
    const validate = this.ajv.compile(capability.input_schema);
    if (!validate(args ?? {}))
      throw fail(
        400,
        `Arguments do not match the tool schema: ${this.ajv.errorsText(validate.errors).slice(0, 300)}`,
      );
  }
}

/**
 * Assignments, grants, approvals and the deterministic policy decision. Agent identity comes from
 * `identity(agentId)` (Phase A profiles in the app); nothing here trusts model or server input.
 */
export class Governance {
  /** @param {any} db @param {any} registry
   *  @param {{identity: (agentId: string) => ({agentId: string, specializationId?: string|null}|null), now?: () => Date}} options */
  constructor(db, registry, { identity, now }) {
    this.db = db;
    this.registry = registry;
    this.identity = identity;
    this.now = now ?? (() => new Date());
  }

  subjects(agent) {
    return [
      `agent:${agent.agentId}`,
      ...(agent.specializationId ? [`specialization:${agent.specializationId}`] : []),
    ];
  }

  assignments(subject) {
    const record = this.db.record(ASSIGNMENT_NAMESPACE, subject);
    return {
      subject,
      capabilities: record?.capabilities ?? [],
      version: record?.revision ?? 0,
      history: record?.history ?? [],
    };
  }

  /** Replace a subject's assigned capabilities. Assignment is not authorisation. */
  assign(subject, capabilities, actor) {
    if (actor !== DEVELOPER_ACTOR) throw fail(403, "Only the developer can assign capabilities.");
    if (!/^(agent|specialization):[a-zA-Z0-9_-]{1,96}$/.test(subject))
      throw fail(400, "Invalid subject.");
    if (
      !Array.isArray(capabilities) ||
      capabilities.length > 64 ||
      new Set(capabilities).size !== capabilities.length
    )
      throw fail(400, "capabilities must be up to 64 unique IDs.");
    for (const capability of capabilities) {
      const row = this.registry.get(capability);
      if (!row) throw fail(400, `Unknown capability: ${capability}`);
      if (row.state !== "registered")
        throw fail(409, `${capability} is not a reviewed, registered capability.`);
    }
    const previous = this.db.record(ASSIGNMENT_NAMESPACE, subject);
    const at = this.now().toISOString();
    this.db.saveRecord(
      ASSIGNMENT_NAMESPACE,
      subject,
      {
        capabilities,
        history: [
          ...(previous?.history ?? []),
          { at, by: actor, from: previous?.capabilities ?? [], to: capabilities },
        ],
      },
      previous?.revision ?? 0,
    );
    return this.assignments(subject);
  }

  grants({ includeRevoked = false } = {}) {
    return this.db
      .records(GRANT_NAMESPACE)
      .filter((row) => includeRevoked || !row.revoked_at)
      .map((row) => ({ grant_id: row.id, ...omit(row, "id", "revision") }));
  }

  /** A grant is explicit, scoped to one capability and its reviewed schema; no wildcards. */
  grant(input, actor) {
    if (actor !== DEVELOPER_ACTOR) throw fail(403, "Only the developer can grant permissions.");
    const { subject, capability_id, resource, environment } = input ?? {};
    if (!/^(agent|specialization):[a-zA-Z0-9_-]{1,96}$/.test(String(subject)))
      throw fail(400, "subject must be agent:<id> or specialization:<id>.");
    if (String(capability_id).includes("*")) throw fail(400, "Wildcard grants are not supported.");
    const capability = this.registry.get(capability_id);
    if (!capability) throw fail(400, "Unknown capability.");
    if (capability.state !== "registered")
      throw fail(409, "Only reviewed capabilities can be granted.");
    if (
      resource !== undefined &&
      (typeof resource?.argument !== "string" ||
        !Array.isArray(resource.allowed) ||
        !resource.allowed.length ||
        resource.allowed.some((value) => typeof value !== "string"))
    )
      throw fail(400, "resource must be {argument, allowed: [string]}.");
    if (environment !== undefined && !/^[a-z0-9-]{1,32}$/.test(String(environment)))
      throw fail(400, "environment is invalid.");
    const grantId = id("grant");
    this.db.saveRecord(
      GRANT_NAMESPACE,
      grantId,
      {
        subject,
        capability_id,
        operation: capability.risk,
        resource: resource ?? null,
        environment: environment ?? null,
        schema_fingerprint: capability.schema_fingerprint,
        granted_by: actor,
        granted_at: this.now().toISOString(),
        revoked_at: null,
      },
      0,
    );
    return this.grants({ includeRevoked: true }).find((row) => row.grant_id === grantId);
  }

  revoke(grantId, actor) {
    if (actor !== DEVELOPER_ACTOR) throw fail(403, "Only the developer can revoke permissions.");
    const record = this.db.record(GRANT_NAMESPACE, grantId);
    if (!record) throw fail(404, "Grant not found.");
    if (record.revoked_at) return { grant_id: grantId, ...record };
    const { revision } = record;
    const rest = omit(record, "id", "revision");
    this.db.saveRecord(
      GRANT_NAMESPACE,
      grantId,
      { ...rest, revoked_at: this.now().toISOString(), revoked_by: actor },
      revision,
    );
    return this.grants({ includeRevoked: true }).find((row) => row.grant_id === grantId);
  }

  /** Effective view for one agent: assignments, grants and the decision for each capability. */
  effective(agentId, environment) {
    const agent = this.identity(agentId);
    if (!agent) throw fail(404, "Agent not found.");
    const assigned = [
      ...new Set(this.subjects(agent).flatMap((subject) => this.assignments(subject).capabilities)),
    ];
    return {
      agent_id: agentId,
      specialization_id: agent.specializationId ?? null,
      assigned,
      grants: this.grants().filter((row) => this.subjects(agent).includes(row.subject)),
      decisions: assigned.map((capability) => ({
        capability_id: capability,
        ...this.decide({ agentId, capabilityId: capability, args: undefined, environment }),
      })),
    };
  }

  /**
   * The single deterministic policy decision, made immediately before each invocation.
   * Default deny: anything unknown, unassigned, ungranted or out of scope is denied.
   */
  decide({ agentId, capabilityId, args, environment }) {
    const deny = (reason) => ({ decision: DECISIONS.DENY, reason });
    const agent =
      typeof agentId === "string" && agentId !== DEVELOPER_ACTOR ? this.identity(agentId) : null;
    if (!agent) return deny("Unknown or invalid agent identity.");
    const capability = this.registry.get(capabilityId);
    if (!capability) return deny("Unknown capability.");
    if (capability.availability !== "available")
      return {
        decision: DECISIONS.UNAVAILABLE,
        reason: `Capability is ${capability.availability}.`,
      };
    if (
      capability.state !== "registered" ||
      capability.review?.schema_fingerprint !== capability.schema_fingerprint
    )
      return deny("Capability is not reviewed for its current schema.");
    const subjects = this.subjects(agent);
    if (!subjects.some((subject) => this.assignments(subject).capabilities.includes(capabilityId)))
      return deny("Capability is not assigned to this agent.");
    const candidates = this.grants().filter(
      (row) => subjects.includes(row.subject) && row.capability_id === capabilityId,
    );
    if (!candidates.length) return deny("No active grant for this capability.");
    const current = candidates.filter(
      (row) =>
        row.schema_fingerprint === capability.schema_fingerprint &&
        row.operation === capability.risk,
    );
    if (!current.length)
      return deny("The tool changed since it was granted; a new grant is required.");
    const scoped = current.filter(
      (row) =>
        (!row.environment || row.environment === environment) &&
        (!row.resource ||
          args === undefined ||
          row.resource.allowed.includes(String(args?.[row.resource.argument]))),
    );
    if (!scoped.length)
      return deny("Requested resource or environment is outside the grant's scope.");
    const grant = scoped[0];
    if (capability.approval_required)
      return {
        decision: DECISIONS.REQUIRES_APPROVAL,
        reason: `${capability.risk} operations need a per-request approval.`,
        grant_id: grant.grant_id,
      };
    return {
      decision: DECISIONS.ALLOW,
      reason: "Assigned, granted and in scope.",
      grant_id: grant.grant_id,
    };
  }

  approvals() {
    const now = this.now().getTime();
    return this.db.records(APPROVAL_NAMESPACE).map((row) => ({
      request_id: row.id,
      ...omit(row, "id", "revision"),
      status:
        row.status === "pending" && Date.parse(row.expires_at) <= now ? "expired" : row.status,
    }));
  }

  requestApproval({ agentId, capability, args, taskId, correlationId, resource }) {
    const requestId = id("apr");
    const at = this.now();
    this.db.saveRecord(
      APPROVAL_NAMESPACE,
      requestId,
      {
        agent_id: agentId,
        capability_id: capability.capability_id,
        server_id: capability.server_id,
        tool_name: capability.tool_name,
        operation: capability.risk,
        args_fingerprint: fingerprint(args ?? {}),
        args_summary: redact(args ?? {}),
        resource: resource ?? null,
        task_id: taskId ?? null,
        correlation_id: correlationId,
        status: "pending",
        requested_at: at.toISOString(),
        expires_at: new Date(at.getTime() + APPROVAL_TTL_MS).toISOString(),
      },
      0,
    );
    return requestId;
  }

  /** Only the developer decides; the requesting agent never can. */
  decideApproval(requestId, decision, actor) {
    if (actor !== DEVELOPER_ACTOR)
      throw fail(403, "Only the developer can decide approval requests.");
    const record = this.db.record(APPROVAL_NAMESPACE, requestId);
    if (!record) throw fail(404, "Approval request not found.");
    if (record.agent_id === actor) throw fail(403, "An agent cannot approve its own request.");
    if (record.status !== "pending") throw fail(409, `Request is already ${record.status}.`);
    if (Date.parse(record.expires_at) <= this.now().getTime())
      throw fail(409, "Request has expired.");
    const { revision } = record;
    const rest = omit(record, "id", "revision");
    this.db.saveRecord(
      APPROVAL_NAMESPACE,
      requestId,
      { ...rest, status: decision, reviewer: actor, decided_at: this.now().toISOString() },
      revision,
    );
    return this.approvals().find((row) => row.request_id === requestId);
  }

  /** An approved, unexpired, unused request for exactly this agent, tool and arguments. */
  findApproved({ agentId, capabilityId, args }) {
    const print = fingerprint(args ?? {});
    return this.approvals().find(
      (row) =>
        row.status === "approved" &&
        row.agent_id === agentId &&
        row.capability_id === capabilityId &&
        row.args_fingerprint === print &&
        Date.parse(row.expires_at) > this.now().getTime(),
    )?.request_id;
  }

  /** Atomically consumes an approval bound to this exact agent, tool and argument fingerprint. */
  consumeApproval(requestId, { agentId, capabilityId, args }) {
    const record = this.db.record(APPROVAL_NAMESPACE, requestId);
    if (!record) throw fail(404, "Approval request not found.");
    if (record.status === "consumed") throw fail(409, "This approval was already used.");
    if (record.status !== "approved") throw fail(409, `Approval is ${record.status}.`);
    if (Date.parse(record.expires_at) <= this.now().getTime())
      throw fail(409, "Approval has expired.");
    if (record.agent_id !== agentId || record.capability_id !== capabilityId)
      throw fail(403, "Approval was issued for a different agent or tool.");
    if (record.args_fingerprint !== fingerprint(args ?? {}))
      throw fail(403, "Arguments differ from the approved request.");
    const { revision } = record;
    const rest = omit(record, "id", "revision");
    // The revision check makes a concurrent second use fail instead of running twice.
    this.db.saveRecord(
      APPROVAL_NAMESPACE,
      requestId,
      { ...rest, status: "consumed", consumed_at: this.now().toISOString() },
      revision,
    );
  }
}

const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value ?? null));

/**
 * The only way to invoke an MCP tool. Every call is decided by current policy, validated against
 * the current schema, executed once (never retried) and recorded.
 */
export class ToolGateway {
  /** @param {{db: any, servers: any, registry: CapabilityRegistry, governance: Governance, now?: () => Date}} deps */
  constructor({ db, servers, registry, governance, now }) {
    Object.assign(this, { db, servers, registry, governance });
    this.now = now ?? (() => new Date());
  }

  invocations({ taskId, agentId } = {}) {
    return this.db
      .records(INVOCATION_NAMESPACE)
      .filter(
        (row) => (!taskId || row.task_id === taskId) && (!agentId || row.agent_id === agentId),
      )
      .map((row) => ({ invocation_id: row.id, ...omit(row, "id", "revision") }));
  }

  record(invocationId, value) {
    const previous = this.db.record(INVOCATION_NAMESPACE, invocationId);
    this.db.saveRecord(
      INVOCATION_NAMESPACE,
      invocationId,
      { ...previous, ...value },
      previous?.revision ?? 0,
    );
  }

  async invoke({
    agentId,
    capabilityId,
    arguments: args = {},
    taskId,
    approvalId,
    environment,
    correlationId,
  }) {
    const invocationId = id("inv");
    const correlation =
      typeof correlationId === "string" && correlationId.length <= 128
        ? correlationId
        : invocationId;
    const capability = this.registry.get(capabilityId);
    const base = {
      correlation_id: correlation,
      task_id: typeof taskId === "string" ? taskId.slice(0, 128) : null,
      agent_id: typeof agentId === "string" ? agentId.slice(0, 96) : null,
      capability_id: String(capabilityId).slice(0, 200),
      server_id: capability?.server_id ?? null,
      tool_name: capability?.tool_name ?? null,
      operation: capability?.risk ?? null,
      args_fingerprint: fingerprint(args),
      args_summary: redact(args),
      started_at: this.now().toISOString(),
    };
    const decision = this.governance.decide({ agentId, capabilityId, args, environment });
    this.db.saveRecord(DECISION_NAMESPACE, invocationId, { ...base, ...decision }, 0);
    const finish = (status, extra = {}) => {
      this.record(invocationId, {
        ...base,
        decision: decision.decision,
        decision_reason: decision.reason,
        status,
        finished_at: this.now().toISOString(),
        ...extra,
      });
      return {
        invocation_id: invocationId,
        correlation_id: correlation,
        status,
        decision: decision.decision,
        ...extra,
      };
    };
    if (decision.decision === DECISIONS.DENY) return finish("denied", { error: decision.reason });
    if (decision.decision === DECISIONS.UNAVAILABLE)
      return finish("unavailable", { error: decision.reason });
    try {
      this.registry.validateInput(capability, args);
    } catch (error) {
      return finish("rejected", { error: error.message });
    }
    if (decision.decision === DECISIONS.REQUIRES_APPROVAL) {
      // Re-issuing the identical call picks up its own approval; any change needs a new one.
      approvalId ??= this.governance.findApproved({ agentId, capabilityId, args });
      if (!approvalId) {
        const requestId = this.governance.requestApproval({
          agentId,
          capability,
          args,
          taskId: base.task_id,
          correlationId: correlation,
        });
        return finish("approval_required", {
          approval_request_id: requestId,
          error: decision.reason,
        });
      }
      try {
        this.governance.consumeApproval(approvalId, { agentId, capabilityId, args });
      } catch (error) {
        return finish("denied", { error: error.message, approval_id: approvalId });
      }
    }
    const sideEffecting = capability.risk !== "READ";
    let client;
    try {
      client = await this.servers.client(capability.server_id);
    } catch (error) {
      return finish("unavailable", { error: error.message });
    }
    const config = this.db.record(SERVER_NAMESPACE, capability.server_id);
    this.record(invocationId, {
      ...base,
      decision: decision.decision,
      status: "running",
      approval_id: approvalId ?? null,
    });
    let result;
    try {
      result = await client.callTool({ name: capability.tool_name, arguments: args }, undefined, {
        timeout: config.request_timeout_ms,
      });
    } catch (error) {
      const timeout = error?.code === -32001 || /timed out/i.test(error?.message ?? "");
      const dropped = error?.code === -32000 || /closed|disconnect/i.test(error?.message ?? "");
      // A side-effecting call that may have reached the server is uncertain, not failed.
      if (sideEffecting && (timeout || dropped))
        return finish("uncertain", {
          error: `${timeout ? "Timed out" : "Connection lost"} after the request was sent; verify on the server before retrying.`,
          approval_id: approvalId ?? null,
        });
      return finish("failed", {
        error: `${timeout ? "Timed out" : "MCP error"}: ${String(error?.message ?? error).slice(0, 300)}`,
        error_code: error?.code ?? null,
        approval_id: approvalId ?? null,
      });
    }
    if (!result || !Array.isArray(result.content))
      return finish(sideEffecting ? "uncertain" : "failed", { error: "Malformed tool response." });
    if (sizeOf(result) > MAX_RESPONSE_BYTES)
      return finish(sideEffecting ? "uncertain" : "failed", {
        error: `Tool response exceeded ${MAX_RESPONSE_BYTES} bytes and was discarded.`,
      });
    if (result.isError)
      return finish("failed", {
        error: "The tool reported an error.",
        result: { content: result.content },
        approval_id: approvalId ?? null,
      });
    return finish("completed", {
      result: { content: result.content, structuredContent: result.structuredContent ?? null },
      result_bytes: sizeOf(result),
      approval_id: approvalId ?? null,
    });
  }

  /** Tools an agent may request right now: assigned, available and not denied by policy. */
  exposedTools(agentId) {
    const agent = this.governance.identity(agentId);
    if (!agent) return [];
    const assigned = new Set(
      this.governance
        .subjects(agent)
        .flatMap((subject) => this.governance.assignments(subject).capabilities),
    );
    return [...assigned]
      .map((capabilityId) => ({
        capability: this.registry.get(capabilityId),
        decision: this.governance.decide({ agentId, capabilityId, args: undefined }),
      }))
      .filter(
        ({ capability, decision }) =>
          capability && [DECISIONS.ALLOW, DECISIONS.REQUIRES_APPROVAL].includes(decision.decision),
      )
      .map(({ capability, decision }) => ({
        capability_id: capability.capability_id,
        description: capability.description,
        input_schema: capability.input_schema,
        risk: capability.risk,
        decision: decision.decision,
      }));
  }
}
