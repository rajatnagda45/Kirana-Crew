const NAMESPACE = "agent.profile";
const FIELDS = new Set([
  "agent_id",
  "name",
  "specialization",
  "instructions",
  "model",
  "capabilities",
  "permissions",
  "runtime",
  "seat_id",
  "session_key",
  "workspace",
  "specialization_id",
  "specialization_version",
]);
const MUTABLE = new Set([
  "name",
  "specialization",
  "instructions",
  "model",
  "capabilities",
  "permissions",
  "workspace",
  "specialization_id",
  "specialization_version",
]);
export const RUNTIMES = ["openclaw", "nightshift", "auggie"];
export const MAX_INSTRUCTIONS = 3000;

const fail = (status, message) => Object.assign(new Error(message), { status });
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const text = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const list = (value, max, pattern) =>
  Array.isArray(value) &&
  value.length <= max &&
  new Set(value).size === value.length &&
  value.every((item) => typeof item === "string" && pattern.test(item));

/**
 * Agent configuration over existing seats, reviewed manifests and gateway sessions.
 *
 * A profile only references them: it never creates a seat, grant, gateway agent or session, and
 * `permissions` can name only manifests the reviewed grants already bind to this seat. Instructions
 * are prompt context and cannot widen tools.
 */
export class AgentProfiles {
  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
  }

  /** Reviewed registry; absent when specialists are not configured. */
  get registry() {
    return this.runtime.operations?.registry;
  }

  view(record) {
    if (!record) return null;
    const { id: agentId, revision, ...rest } = record;
    return { agent_id: agentId, ...rest, version: revision };
  }

  get(agentId) {
    return this.view(this.runtime.db.record(NAMESPACE, agentId));
  }

  list() {
    return this.runtime.db.records(NAMESPACE).map((record) => this.view(record));
  }

  validate(input, { partial = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw fail(400, "Agent configuration must be an object.");
    for (const key of Object.keys(input))
      if (!FIELDS.has(key)) throw fail(400, `Unsupported agent field: ${key}`);
    const require = (field, ok, message) => {
      if (input[field] === undefined) {
        if (!partial) throw fail(400, `${field} is required.`);
        return;
      }
      if (!ok) throw fail(400, message);
    };
    require("name", text(input.name, 80), "name must be 1-80 characters.");
    require("specialization", text(
      input.specialization,
      120,
    ), "specialization must be 1-120 characters.");
    require("instructions", text(
      input.instructions,
      MAX_INSTRUCTIONS,
    ), `instructions must be 1-${MAX_INSTRUCTIONS} characters.`);
    if (input.model !== undefined && !text(input.model, 128))
      throw fail(400, "model must be 1-128 characters.");
    if (input.capabilities !== undefined && !list(input.capabilities, 16, /^[a-z0-9_.:-]{1,64}$/))
      throw fail(400, "capabilities must be up to 16 unique identifiers.");
    if (input.permissions !== undefined && !list(input.permissions, 8, /^[a-z0-9_-]{1,64}$/))
      throw fail(400, "permissions must be up to 8 unique reviewed manifest IDs.");
    if (
      input.workspace !== undefined &&
      (!/^[\w./-]{1,256}$/.test(String(input.workspace)) || String(input.workspace).includes(".."))
    )
      throw fail(400, "workspace must be a relative reference without '..'.");
    if (
      input.specialization_id !== undefined &&
      !/^[a-zA-Z0-9_-]{1,96}$/.test(String(input.specialization_id))
    )
      throw fail(400, "specialization_id is invalid.");
    if (
      input.specialization_version !== undefined &&
      (!Number.isInteger(input.specialization_version) || input.specialization_version < 1)
    )
      throw fail(400, "specialization_version must be a positive integer.");
    if (input.session_key !== undefined && !text(input.session_key, 256))
      throw fail(400, "session_key must be 1-256 characters.");
    if (!partial) {
      if (!id(input.agent_id)) throw fail(400, "agent_id must match [a-zA-Z0-9_-]{1,64}.");
      if (!id(input.seat_id)) throw fail(400, "seat_id must match [a-zA-Z0-9_-]{1,64}.");
      if (!RUNTIMES.includes(input.runtime))
        throw fail(400, `runtime must be one of ${RUNTIMES.join(", ")}.`);
    }
  }

  /** Permissions must be reviewed manifests that already have a grant on this seat. */
  checkPermissions(seatId, permissions = [], capabilities = []) {
    if (!permissions.length) {
      if (capabilities.length)
        throw fail(400, "capabilities are not authorised: the agent has no permissions.");
      return;
    }
    const registry = this.registry;
    if (!registry) throw fail(409, "Reviewed specialist permissions are not configured.");
    const authorised = new Set();
    for (const manifestId of permissions) {
      const entry = registry.entry(manifestId);
      if (!entry) throw fail(400, `Unknown reviewed manifest: ${manifestId}`);
      if (!registry.grantsFor(manifestId).some((grant) => grant.seatId === seatId))
        throw fail(409, `Manifest ${manifestId} has no reviewed grant on seat ${seatId}.`);
      for (const capability of entry.manifest.capabilities) authorised.add(capability);
    }
    for (const capability of capabilities)
      if (!authorised.has(capability))
        throw fail(400, `capability ${capability} is not authorised by any permission.`);
  }

  /** Seat and runtime must already exist and be verified; nothing is provisioned. */
  checkBinding(input) {
    const owner = this.runtime.seatOwner(input.seat_id);
    let resolved;
    try {
      resolved = owner.resolve(input.seat_id, input.session_key);
    } catch (error) {
      throw fail(409, `Runtime binding unavailable: ${error.message}`);
    }
    if (owner.gateway.provider !== input.runtime)
      throw fail(
        409,
        `Seat ${input.seat_id} runs on ${owner.gateway.provider}, not ${input.runtime}.`,
      );
    return resolved;
  }

  create(input) {
    this.validate(input);
    if (this.get(input.agent_id)) throw fail(409, "agent_id already exists.");
    const clash = this.list().find((profile) => profile.seat_id === input.seat_id);
    if (clash) throw fail(409, `Seat ${input.seat_id} is already configured as ${clash.agent_id}.`);
    this.checkBinding(input);
    this.checkPermissions(input.seat_id, input.permissions, input.capabilities);
    const now = new Date().toISOString();
    const { agent_id: agentId, ...rest } = input;
    const saved = this.runtime.db.saveRecord(
      NAMESPACE,
      agentId,
      {
        ...rest,
        capabilities: input.capabilities ?? [],
        permissions: input.permissions ?? [],
        createdAt: now,
        updatedAt: now,
      },
      0,
    );
    return this.view(saved);
  }

  update(agentId, patch) {
    const current = this.runtime.db.record(NAMESPACE, agentId);
    if (!current) throw fail(404, "Agent not found.");
    this.validate(patch, { partial: true });
    for (const key of Object.keys(patch))
      if (!MUTABLE.has(key))
        throw fail(400, `${key} cannot be changed; create a new agent instead.`);
    if (!Object.keys(patch).length) throw fail(400, "No changes supplied.");
    const next = { ...current, ...patch };
    this.checkBinding({ ...next, seat_id: next.seat_id });
    this.checkPermissions(next.seat_id, next.permissions, next.capabilities);
    const { revision, ...value } = next;
    delete value.id;
    return this.view(
      this.runtime.db.saveRecord(
        NAMESPACE,
        agentId,
        { ...value, updatedAt: new Date().toISOString() },
        revision,
      ),
    );
  }
}
