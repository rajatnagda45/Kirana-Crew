import { randomBytes } from "node:crypto";
import { SPECIALIST_CATALOGUE } from "./specialist-catalogue.mjs";
import { MAX_INSTRUCTIONS, RUNTIMES } from "./agent-profiles.mjs";
import { TOOL_SERVICES } from "./tool-registry.mjs";

export const GENERATION_NAMESPACE = "developer.generation";
export const SPECIALIZATION_NAMESPACE = "agent.specialization";
export const APPROVAL_NAMESPACE = "developer.permission-approval";
export const DEVELOPER_ACTOR = "loopback-developer";
const ACTIVE = new Set(["queued", "submitted", "running", "cancel_requested", "waiting_approval"]);
const SECRET =
  /\b(sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{12,}|password\s*[:=])/i;

const fail = (status, message, body) =>
  Object.assign(new Error(message), { status, ...(body ? { body } : {}) });
const str = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const strings = (value, maxItems, maxLength) =>
  Array.isArray(value) && value.length <= maxItems && value.every((item) => str(item, maxLength));
const label = (id) => id.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const norm = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Risk comes only from the manifest's reviewed permissions, never from model text. */
export function permissionRisk(permissions) {
  if (permissions.dataAccess === "scoped_write" || permissions.sensitiveWrites !== "denied")
    return "high";
  return permissions.dataAccess === "read_only" ? "medium" : "low";
}
const writes = (permissions) => permissionRisk(permissions) === "high";

/** The registered inventory: reviewed manifests, their grants and integration status. */
export function capabilityInventory(runtime) {
  const registry = runtime.operations?.registry;
  const catalogue = registry?.catalogue ?? SPECIALIST_CATALOGUE;
  const services = new Map(
    (runtime.services?.snapshot().services ?? []).map((service) => [service.id, service]),
  );
  const provider =
    runtime.gateway?.provider === "nightshift" ? "meterless-nightshift" : runtime.gateway?.provider;
  const manifests = catalogue.map(({ manifest }) => ({
    id: manifest.id,
    provider: manifest.provider,
    runtimeMatches: manifest.provider === provider,
    capabilities: [...manifest.capabilities],
    tools: [...manifest.tools],
    permissions: { ...manifest.permissions },
    risk: permissionRisk(manifest.permissions),
    grantedSeats: (registry?.grantsFor(manifest.id) ?? []).map((grant) => grant.seatId),
    integrations: [
      ...new Set(manifest.tools.map((tool) => TOOL_SERVICES[tool.split(".")[0]]).filter(Boolean)),
    ].map((id) => ({
      id,
      configured: services.get(id)?.configuration?.configured === true,
      available: services.get(id)?.available === true,
    })),
  }));
  const capabilities = new Map();
  for (const manifest of manifests)
    for (const id of manifest.capabilities) {
      const row = capabilities.get(id) ?? { id, description: label(id), manifests: [] };
      row.manifests.push(manifest.id);
      capabilities.set(id, row);
    }
  return {
    provider: runtime.gateway?.provider ?? null,
    manifests,
    capabilities: [...capabilities.values()],
  };
}

/** The model may only choose identifiers from this list; everything is re-checked afterwards. */
export function generationPrompt(description, inventory) {
  const capabilities = inventory.capabilities.map((row) => ({
    id: row.id,
    description: row.description,
  }));
  const permissions = inventory.manifests
    .filter((manifest) => manifest.runtimeMatches)
    .map(({ id, capabilities: caps, tools, permissions: scope }) => ({
      id,
      capabilities: caps,
      tools,
      scope,
    }));
  return [
    "You are drafting an agent configuration for review by a developer. Do not call any tools.",
    "Reply with exactly one JSON object and nothing else. Use only capability and permission IDs",
    "from the lists below; if something needed is not listed, put it in requested_capabilities",
    'with confidence "low" and explain in reason. You cannot grant permissions.',
    "",
    "Schema:",
    JSON.stringify({
      name: "string",
      specialization: "string",
      description: "string",
      purpose: "string",
      responsibilities: ["string"],
      allowed_actions: ["string"],
      forbidden_actions: [{ text: "string", category: "read|write|external_send|other" }],
      inputs: ["string"],
      outputs: ["string"],
      integrations: ["string"],
      data_access: "none|read_only|scoped_write",
      safety: ["string"],
      decision_rules: ["string"],
      escalation: ["string"],
      output_format: "string",
      requested_capabilities: [
        { id: "string", reason: "string", confidence: "high|medium|low", required: true },
      ],
      requested_permissions: [{ id: "string", reason: "string" }],
    }),
    "",
    `Registered capabilities: ${JSON.stringify(capabilities)}`,
    `Registered permissions: ${JSON.stringify(permissions)}`,
    "",
    `Developer description:\n${description}`,
  ].join("\n");
}

/** Strictly validates model output. Never repairs it into a successful proposal. */
export function parseProposal(text) {
  if (typeof text !== "string" || !text.trim()) throw fail(422, "The model returned no output.");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw fail(422, "The model output contains no JSON object.");
  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw fail(422, "The model output is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(422, "The model output must be a JSON object.");
  const errors = [];
  const need = (key, ok, message) => {
    if (!ok) errors.push(`${key}: ${message}`);
  };
  need("name", str(value.name, 80), "1-80 characters");
  need("specialization", str(value.specialization, 120), "1-120 characters");
  need("description", str(value.description, 600), "1-600 characters");
  need("purpose", str(value.purpose, 600), "1-600 characters");
  for (const key of ["responsibilities", "allowed_actions"])
    need(key, strings(value[key], 20, 300), "up to 20 short strings");
  for (const key of ["inputs", "outputs", "integrations", "safety", "decision_rules", "escalation"])
    need(key, value[key] === undefined || strings(value[key], 20, 300), "up to 20 short strings");
  need(
    "forbidden_actions",
    Array.isArray(value.forbidden_actions) &&
      value.forbidden_actions.length <= 20 &&
      value.forbidden_actions.every(
        (row) =>
          str(row?.text, 300) && ["read", "write", "external_send", "other"].includes(row.category),
      ),
    "up to 20 {text, category}",
  );
  need(
    "data_access",
    ["none", "read_only", "scoped_write"].includes(value.data_access),
    "none, read_only or scoped_write",
  );
  need(
    "output_format",
    value.output_format === undefined || str(value.output_format, 600),
    "up to 600 characters",
  );
  need(
    "requested_capabilities",
    Array.isArray(value.requested_capabilities) &&
      value.requested_capabilities.length <= 16 &&
      value.requested_capabilities.every(
        (row) =>
          str(row?.id, 64) &&
          str(row.reason, 300) &&
          ["high", "medium", "low"].includes(row.confidence) &&
          (row.required === undefined || typeof row.required === "boolean"),
      ),
    "up to 16 {id, reason, confidence}",
  );
  need(
    "requested_permissions",
    value.requested_permissions === undefined ||
      (Array.isArray(value.requested_permissions) &&
        value.requested_permissions.length <= 8 &&
        value.requested_permissions.every((row) => str(row?.id, 64) && str(row.reason, 300))),
    "up to 8 {id, reason}",
  );
  if (errors.length)
    throw fail(422, `The model output does not match the schema: ${errors.join("; ")}`);
  const known = new Set([
    "name",
    "specialization",
    "description",
    "purpose",
    "responsibilities",
    "allowed_actions",
    "forbidden_actions",
    "inputs",
    "outputs",
    "integrations",
    "data_access",
    "safety",
    "decision_rules",
    "escalation",
    "output_format",
    "requested_capabilities",
    "requested_permissions",
  ]);
  const ignored = Object.keys(value).filter((key) => !known.has(key));
  return {
    requirements: {
      name: value.name.trim(),
      specialization: value.specialization.trim(),
      description: value.description.trim(),
      purpose: value.purpose.trim(),
      responsibilities: value.responsibilities,
      allowed_actions: value.allowed_actions,
      forbidden_actions: value.forbidden_actions.map(({ text: t, category }) => ({
        text: t,
        category,
      })),
      inputs: value.inputs ?? [],
      outputs: value.outputs ?? [],
      integrations: value.integrations ?? [],
      data_access: value.data_access,
      safety: value.safety ?? [],
      decision_rules: value.decision_rules ?? [],
      escalation: value.escalation ?? [],
      output_format: value.output_format ?? "",
      requested_capabilities: value.requested_capabilities.map((row) => ({
        id: row.id,
        reason: row.reason,
        confidence: row.confidence,
        required: row.required !== false,
      })),
      requested_permissions: (value.requested_permissions ?? []).map(({ id, reason }) => ({
        id,
        reason,
      })),
    },
    ignored,
  };
}

const grantedOn = (manifest, seatId) => !!seatId && manifest.grantedSeats.includes(seatId);

/** Every request is resolved against the registry; nothing unregistered is ever reported available. */
export function matchCapabilities(requested, inventory, { seatId } = {}) {
  return requested.map((row) => {
    const entry = inventory.capabilities.find((item) => item.id === row.id);
    const base = { id: row.id, reason: row.reason, description: entry?.description ?? null };
    if (!row.required)
      return { ...base, status: "not_required", tools: [], integrations: [], manifests: [] };
    if (!entry)
      return {
        ...base,
        status: "unavailable",
        detail: "Not a registered capability.",
        tools: [],
        integrations: [],
        manifests: [],
      };
    const offering = inventory.manifests.filter(
      (manifest) => manifest.runtimeMatches && manifest.capabilities.includes(row.id),
    );
    const view = (status, detail, manifests) => ({
      ...base,
      status,
      detail,
      manifests: manifests.map((manifest) => manifest.id),
      tools: [...new Set(manifests.flatMap((manifest) => manifest.tools))],
      integrations: manifests.flatMap((manifest) => manifest.integrations),
    });
    if (!offering.length)
      return view(
        "unavailable",
        `Only offered by ${entry.manifests.join(", ")} on another runtime.`,
        [],
      );
    if (row.confidence === "low")
      return view(
        "ambiguous",
        "The model was not confident this is needed; confirm or remove it.",
        offering,
      );
    const granted = offering.filter((manifest) => grantedOn(manifest, seatId));
    if (granted.length)
      return view("available", "A reviewed grant on this seat provides it.", granted);
    return view(
      "requires_authorization",
      seatId
        ? "Registered, but no reviewed grant on this seat provides it."
        : "Registered; a seat with a reviewed grant is needed.",
      offering,
    );
  });
}

const forbidsWrites = (requirements) =>
  requirements.data_access !== "scoped_write" ||
  requirements.forbidden_actions.some((row) => row.category === "write");

/** Recommendations are derived from matched capabilities and validated model suggestions. */
export function recommendPermissions(requirements, matches, inventory, { seatId } = {}) {
  const reasons = new Map();
  for (const match of matches) {
    if (!["available", "requires_authorization", "ambiguous"].includes(match.status)) continue;
    // Least privilege: the lowest-risk, smallest manifest that provides the capability.
    const choice = match.manifests
      .map((id) => inventory.manifests.find((manifest) => manifest.id === id))
      .filter(Boolean)
      .sort(
        (a, b) =>
          ["low", "medium", "high"].indexOf(a.risk) - ["low", "medium", "high"].indexOf(b.risk) ||
          a.tools.length - b.tools.length ||
          a.id.localeCompare(b.id),
      )[0];
    if (choice) reasons.set(choice.id, [...(reasons.get(choice.id) ?? []), `provides ${match.id}`]);
  }
  for (const row of requirements.requested_permissions)
    reasons.set(row.id, [...(reasons.get(row.id) ?? []), `model suggestion: ${row.reason}`]);
  return [...reasons.entries()].map(([id, why]) => {
    const manifest = inventory.manifests.find((item) => item.id === id);
    if (!manifest || !manifest.runtimeMatches)
      return {
        id,
        classification: "unsupported",
        reason: manifest
          ? `Runs on ${manifest.provider}, not this runtime.`
          : "Not a registered permission.",
        exists: false,
        risk: null,
        requires_approval: false,
        scope: null,
        operation: null,
      };
    const exists = grantedOn(manifest, seatId);
    const conflict = writes(manifest.permissions) && forbidsWrites(requirements);
    return {
      id,
      classification: conflict
        ? "not_required"
        : exists
          ? "existing"
          : manifest.risk === "high"
            ? "high_risk"
            : "additional_recommended",
      reason: conflict
        ? "Its write access conflicts with a forbidden write action."
        : why.join("; "),
      exists,
      risk: manifest.risk,
      // Every effective permission still needs a recorded developer decision.
      requires_approval: !conflict,
      scope: { tools: manifest.tools, ...manifest.permissions },
      operation: writes(manifest.permissions)
        ? "write"
        : manifest.permissions.dataAccess === "none"
          ? "message"
          : "read",
    };
  });
}

const bullets = (rows) => (rows.length ? rows.map((row) => `- ${row}`).join("\n") : "- None.");

/** Deterministic instruction text built from reviewed fields. It cannot change authorisation. */
export function renderInstructions(config) {
  const text = [
    `You are ${config.name}, a ${config.specialization} agent.`,
    `Objective: ${config.purpose}`,
    `Responsibilities:\n${bullets(config.responsibilities)}`,
    `Decision rules:\n${bullets(config.decision_rules ?? [])}`,
    `Capabilities you may rely on (only when the runtime confirms them):\n${bullets(config.capabilities)}`,
    `Authorised actions:\n${bullets(config.allowed_actions)}`,
    `Forbidden actions:\n${bullets(config.forbidden_actions.map((row) => row.text))}`,
    "Evidence: cite the source of every factual claim. Never state that a tool ran unless its result is present.",
    "Errors: if a tool or source is unavailable, say so and stop that step; do not guess or invent results.",
    `Escalation:\n${bullets(config.escalation?.length ? config.escalation : ["Ask the requester when a request needs an action you are not authorised to take."])}`,
    `Output format: ${config.output_format || "A structured report with findings, evidence and open questions."}`,
    "This text grants no permissions; the server enforces authorisation.",
  ].join("\n\n");
  return text.length <= MAX_INSTRUCTIONS ? text : `${text.slice(0, MAX_INSTRUCTIONS - 1)}…`;
}

/** Server-side policy check. Outcomes: valid, valid_with_warnings, blocked, requires_developer_approval. */
export function validateConfig(config, runtime, { approvals = {} } = {}) {
  const inventory = capabilityInventory(runtime);
  const errors = [];
  const warnings = [];
  const missing_capabilities = [];
  const unsupported_permissions = [];
  const required_approvals = [];
  if (!config || typeof config !== "object") throw fail(400, "Configuration must be an object.");
  if (!str(config.name, 80)) errors.push("name is required (1-80 characters).");
  if (!str(config.specialization, 120))
    errors.push("specialization is required (1-120 characters).");
  if (!str(config.instructions, MAX_INSTRUCTIONS))
    errors.push(`instructions are required (1-${MAX_INSTRUCTIONS} characters).`);
  else if (SECRET.test(config.instructions))
    errors.push("instructions contain a secret-like value.");
  for (const key of ["responsibilities", "allowed_actions", "capabilities", "permissions"])
    if (!strings(config[key] ?? [], 20, 300))
      errors.push(`${key} must be a list of short strings.`);
  if (!Array.isArray(config.forbidden_actions)) errors.push("forbidden_actions must be a list.");
  const provider = config.runtime?.provider;
  if (!RUNTIMES.includes(provider))
    errors.push(`runtime.provider must be one of ${RUNTIMES.join(", ")}.`);
  if (errors.length)
    return {
      status: "blocked",
      errors,
      warnings,
      missing_capabilities,
      unsupported_permissions,
      required_approvals,
    };

  const seatId = config.runtime.seat_id;
  if (seatId) {
    try {
      const owner = runtime.seatOwner(seatId);
      owner.resolve(seatId);
      if (owner.gateway.provider !== provider)
        errors.push(`Seat ${seatId} runs on ${owner.gateway.provider}, not ${provider}.`);
    } catch (error) {
      errors.push(`Runtime binding for seat ${seatId} is unavailable: ${error.message}`);
    }
  } else
    warnings.push("No seat selected; the runtime binding is checked when the agent is assigned.");

  const selected = [];
  for (const id of config.permissions) {
    const manifest = inventory.manifests.find((item) => item.id === id);
    if (!manifest || !manifest.runtimeMatches) {
      unsupported_permissions.push(id);
      continue;
    }
    selected.push(manifest);
    if (writes(manifest.permissions) && forbidsWrites(config))
      errors.push(`Permission ${id} allows writes, which the configuration forbids.`);
    const decision = approvals[id]?.decision;
    if (decision !== "approved")
      required_approvals.push({
        id,
        risk: manifest.risk,
        high_risk: manifest.risk === "high",
        decision: decision ?? "pending",
      });
    if (!grantedOn(manifest, seatId))
      warnings.push(
        `Permission ${id} has no reviewed grant${seatId ? ` on seat ${seatId}` : ""}; it cannot run until one exists.`,
      );
  }
  if (unsupported_permissions.length)
    errors.push(`Unsupported permissions: ${unsupported_permissions.join(", ")}.`);
  for (const id of config.capabilities) {
    if (!inventory.capabilities.some((row) => row.id === id)) missing_capabilities.push(id);
    else if (!selected.some((manifest) => manifest.capabilities.includes(id)))
      errors.push(`Capability ${id} is not provided by any selected permission.`);
  }
  if (missing_capabilities.length)
    errors.push(`Unregistered capabilities: ${missing_capabilities.join(", ")}.`);
  const forbidden = config.forbidden_actions.map((row) => norm(row?.text ?? row));
  for (const allowed of config.allowed_actions.map(norm))
    if (
      forbidden.some(
        (item) => item && (item === allowed || item.includes(allowed) || allowed.includes(item)),
      )
    )
      errors.push(`Allowed action conflicts with a forbidden action: "${allowed}".`);
  const status = errors.length
    ? "blocked"
    : required_approvals.length
      ? "requires_developer_approval"
      : warnings.length
        ? "valid_with_warnings"
        : "valid";
  return {
    status,
    errors,
    warnings,
    missing_capabilities,
    unsupported_permissions,
    required_approvals,
  };
}

const forbiddenOf = (requirements) => requirements.forbidden_actions;

/** Requirement extraction → matching → recommendations → instructions → structured config → validation. */
export function buildProposal(parsed, runtime, { seatId, provider } = {}) {
  const { requirements } = parsed;
  const inventory = capabilityInventory(runtime);
  const capabilities = matchCapabilities(requirements.requested_capabilities, inventory, {
    seatId,
  });
  const permission_recommendations = recommendPermissions(requirements, capabilities, inventory, {
    seatId,
  });
  const usable = permission_recommendations.filter((row) =>
    ["existing", "additional_recommended", "high_risk"].includes(row.classification),
  );
  const covered = new Set(
    usable.flatMap(
      (row) => inventory.manifests.find((manifest) => manifest.id === row.id).capabilities,
    ),
  );
  const draft = {
    name: requirements.name,
    specialization: requirements.specialization,
    description: requirements.description,
    purpose: requirements.purpose,
    responsibilities: requirements.responsibilities,
    allowed_actions: requirements.allowed_actions,
    forbidden_actions: forbiddenOf(requirements),
    decision_rules: requirements.decision_rules,
    escalation: requirements.escalation,
    output_format: requirements.output_format,
    data_access: requirements.data_access,
    capabilities: capabilities
      .filter(
        (row) =>
          ["available", "requires_authorization"].includes(row.status) && covered.has(row.id),
      )
      .map((row) => row.id),
    permissions: usable.map((row) => row.id),
    runtime: {
      provider: provider ?? inventory.provider ?? "openclaw",
      ...(seatId ? { seat_id: seatId } : {}),
    },
    input_schema: { type: "object", description: requirements.inputs },
    output_schema: { type: "object", description: requirements.outputs },
  };
  const config = { ...draft, instructions: renderInstructions(draft) };
  const validation = validateConfig(config, runtime);
  if (parsed.ignored?.length)
    validation.warnings.push(`Ignored unknown model fields: ${parsed.ignored.join(", ")}.`);
  return { requirements, capabilities, permission_recommendations, config, validation };
}

/** Generation runs as an ordinary seat task on the existing runtime; output is validated, never trusted. */
export class DeveloperGenerations {
  /** @param {any} runtime @param {{seatId?: string}} [options] */
  constructor(runtime, { seatId } = {}) {
    this.runtime = runtime;
    this.seatId = seatId;
  }

  generate(input) {
    const description = input?.description;
    if (!str(description, 4000) || description.trim().length < 20)
      throw fail(400, "description must be 20-4000 characters.");
    const target = input.seat_id;
    if (target !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(String(target)))
      throw fail(400, "seat_id is invalid.");
    if (input.runtime !== undefined && !RUNTIMES.includes(input.runtime))
      throw fail(400, `runtime must be one of ${RUNTIMES.join(", ")}.`);
    const unavailable = (message) =>
      fail(503, message, { status: "unavailable", error: message, description });
    if (!this.seatId)
      throw unavailable(
        "No generation seat is configured (set AGENT_TOWN_DEVELOPER_GENERATION_SEAT).",
      );
    const owner = this.runtime.seatOwner(this.seatId);
    if (owner.gateway.status !== "connected")
      throw unavailable(`The ${owner.gateway.provider} runtime is not connected.`);
    let resolved;
    try {
      resolved = owner.resolve(this.seatId);
    } catch (error) {
      throw unavailable(`Generation seat binding unavailable: ${error.message}`);
    }
    const id = `gen_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
    const prompt = generationPrompt(description.trim(), capabilityInventory(this.runtime));
    this.runtime.db.saveRecord(GENERATION_NAMESPACE, id, {
      description,
      seat_id: target ?? null,
      runtime: input.runtime ?? null,
      generation_seat: this.seatId,
      provider: owner.gateway.provider,
      taskId: id,
      createdAt: new Date().toISOString(),
    });
    owner.submit({
      taskId: id,
      message: prompt,
      seatId: this.seatId,
      sessionKey: resolved.sessionKey,
      bindingRevision: resolved.seat.binding.revision,
    });
    return this.view(id);
  }

  view(id) {
    const record = this.runtime.db.record(GENERATION_NAMESPACE, id);
    if (!record) return null;
    const base = {
      generation_id: id,
      description: record.description,
      source: { runtime: record.provider, seat_id: record.generation_seat, task_id: record.taskId },
    };
    if (record.proposal) return { ...base, status: "proposed", proposal: record.proposal };
    const task = this.runtime.db.getTask(record.taskId);
    if (!task || ACTIVE.has(task.status))
      return { ...base, status: "generating", task_status: task?.status ?? null };
    if (task.status !== "completed")
      return {
        ...base,
        status: "failed",
        error: task.error ?? `Generation task ended as ${task.status}; no proposal was produced.`,
      };
    const tools = this.runtime
      .taskOwner(task)
      .db.messages(task.sessionKey)
      .filter((message) => message.taskId === task.taskId && message.role === "tool");
    if (tools.length)
      return {
        ...base,
        status: "blocked",
        error: `The generation agent used tools (${tools.map((row) => row.toolName).join(", ")}); the output was discarded.`,
      };
    let parsed;
    try {
      parsed = parseProposal(task.result);
    } catch (error) {
      return { ...base, status: "failed", error: error.message };
    }
    const proposal = buildProposal(parsed, this.runtime, {
      seatId: record.seat_id ?? undefined,
      provider: record.runtime ?? undefined,
    });
    this.runtime.db.saveRecord(GENERATION_NAMESPACE, id, { ...record, proposal }, record.revision);
    return { ...base, status: "proposed", proposal };
  }
}

const decisionKey = (specId, manifestId) => `${specId}:${manifestId}`;

/** The current recorded decision for one permission of one specialization. */
export function permissionDecision(db, specId, manifestId) {
  return db.record(APPROVAL_NAMESPACE, decisionKey(specId, manifestId));
}

/** Reusable specializations: versioned records; approvals are separate audit records. */
export class Specializations {
  /** @param {any} runtime @param {{profiles?: any}} [options] */
  constructor(runtime, { profiles } = {}) {
    this.runtime = runtime;
    this.profiles = profiles;
  }

  approvals(id) {
    return Object.fromEntries(
      this.runtime.db
        .records(APPROVAL_NAMESPACE)
        .filter((row) => row.specialization_id === id)
        .map((row) => [row.manifest_id, row]),
    );
  }

  view(record) {
    if (!record) return null;
    const { id, revision, ...rest } = record;
    const approvals = this.approvals(id);
    const validation = validateConfig(rest.config, this.runtime, { approvals });
    return {
      id,
      version: revision,
      ...rest,
      approvals: Object.values(approvals),
      validation,
      approval_state: rest.draft
        ? "draft"
        : validation.status === "blocked"
          ? "blocked"
          : validation.required_approvals.length
            ? "pending_approval"
            : "approved",
    };
  }

  get(id) {
    return this.view(this.runtime.db.record(SPECIALIZATION_NAMESPACE, id));
  }

  list() {
    return this.runtime.db.records(SPECIALIZATION_NAMESPACE).map((record) => this.view(record));
  }

  save(input) {
    if (input?.confirm !== true)
      throw fail(400, "Saving requires explicit confirmation (confirm: true).");
    const config = input.config;
    const draft = input.draft === true;
    let id = input.id;
    const previous = id ? this.runtime.db.record(SPECIALIZATION_NAMESPACE, id) : null;
    if (id && !previous) throw fail(404, "Specialization not found.");
    const validation = validateConfig(config, this.runtime, {
      approvals: id ? this.approvals(id) : {},
    });
    if (validation.status === "blocked" && !draft)
      throw fail(409, "Configuration is blocked; fix it or save it as a draft.", {
        status: "blocked",
        validation,
      });
    const generation = input.generation_id
      ? this.runtime.db.record(GENERATION_NAMESPACE, input.generation_id)
      : null;
    if (input.generation_id && !generation) throw fail(400, "Unknown generation_id.");
    id ??= `spec_${norm(config.specialization).replace(/ /g, "-").slice(0, 40) || "agent"}_${randomBytes(3).toString("hex")}`;
    const now = new Date().toISOString();
    const saved = this.runtime.db.saveRecord(
      SPECIALIZATION_NAMESPACE,
      id,
      {
        config,
        draft,
        generation_source: generation
          ? {
              generation_id: input.generation_id,
              task_id: generation.taskId,
              runtime: generation.provider,
              seat_id: generation.generation_seat,
            }
          : (previous?.generation_source ?? { manual: true }),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      },
      previous ? previous.revision : 0,
    );
    const view = this.view(saved);
    if (input.assign) return { specialization: view, agent: this.assign(id, input.assign) };
    return { specialization: view };
  }

  update(id, patch) {
    const previous = this.runtime.db.record(SPECIALIZATION_NAMESPACE, id);
    if (!previous) throw fail(404, "Specialization not found.");
    if (!patch?.config || typeof patch.config !== "object")
      throw fail(400, "Provide config changes.");
    return this.save({
      id,
      confirm: patch.confirm,
      draft: patch.draft ?? previous.draft,
      config: { ...previous.config, ...patch.config },
      assign: patch.assign,
    });
  }

  /** Record a developer decision. It gates the permission; it never creates a grant. */
  decide(id, manifestId, { decision, reason }, actor) {
    if (actor !== DEVELOPER_ACTOR) throw fail(403, "Only the developer can decide permissions.");
    const spec = this.runtime.db.record(SPECIALIZATION_NAMESPACE, id);
    if (!spec) throw fail(404, "Specialization not found.");
    if (!spec.config.permissions.includes(manifestId))
      throw fail(400, `${manifestId} is not part of this configuration.`);
    if (!["approved", "denied", "revoked"].includes(decision))
      throw fail(400, "decision must be approved, denied or revoked.");
    const current = permissionDecision(this.runtime.db, id, manifestId);
    if (decision === "revoked" && current?.decision !== "approved")
      throw fail(409, "Only an approved permission can be revoked.");
    if (reason !== undefined && !str(reason, 300))
      throw fail(400, "reason must be up to 300 characters.");
    return this.runtime.db.saveRecord(APPROVAL_NAMESPACE, decisionKey(id, manifestId), {
      specialization_id: id,
      specialization_version: spec.revision,
      manifest_id: manifestId,
      decision,
      reason: reason ?? null,
      approver: actor,
      at: new Date().toISOString(),
      history: [
        ...(current?.history ?? []),
        ...(current ? [{ decision: current.decision, at: current.at }] : []),
      ],
    });
  }

  /** Configure a Phase A agent from this specialization. Only approved permissions are carried. */
  assign(id, { agent_id: agentId, seat_id: seatId }) {
    if (!this.profiles) throw fail(503, "Agent profiles are not available.");
    const spec = this.get(id);
    if (!spec) throw fail(404, "Specialization not found.");
    if (spec.approval_state === "draft" || spec.approval_state === "blocked")
      throw fail(409, `A ${spec.approval_state} specialization cannot be assigned.`);
    const approved = spec.config.permissions.filter(
      (manifestId) => permissionDecision(this.runtime.db, id, manifestId)?.decision === "approved",
    );
    const inventory = capabilityInventory(this.runtime);
    const capabilities = spec.config.capabilities.filter((capability) =>
      approved.some((manifestId) =>
        inventory.manifests
          .find((manifest) => manifest.id === manifestId)
          ?.capabilities.includes(capability),
      ),
    );
    const fields = {
      name: spec.config.name,
      specialization: spec.config.specialization,
      instructions: spec.config.instructions,
      permissions: approved,
      capabilities,
      specialization_id: id,
      specialization_version: spec.version,
    };
    if (this.profiles.get(agentId)) return this.profiles.update(agentId, fields);
    return this.profiles.create({
      agent_id: agentId,
      seat_id: seatId,
      runtime: spec.config.runtime.provider,
      workspace: `agents/${agentId}`,
      ...fields,
    });
  }
}
