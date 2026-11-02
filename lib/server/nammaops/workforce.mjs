import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEVELOPER_ACTOR, renderInstructions } from "../developer-config.mjs";

export const WORKFORCE_NAMESPACE = "nammaops.workforce";
const fail = (status, message) => Object.assign(new Error(message), { status });

export function loadWorkforce(path = "config/nammaops/workforce.json") {
  const workforce = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!Array.isArray(workforce?.agents) || workforce.agents.length < 1)
    throw new Error(`Invalid NammaOps workforce file: ${path}`);
  return workforce;
}

/** Bound OpenClaw seats that no configured agent uses yet. */
export function freeSeats(runtime) {
  const used = new Set((runtime.profiles?.list() ?? []).map((profile) => profile.seat_id));
  return (runtime.rosterSeats?.() ?? [])
    .filter((seat) => seat.assigned && seat.binding?.available && !used.has(seat.seatId))
    .map((seat) => seat.seatId);
}

/**
 * Configures the workforce through the existing layers only: Phase C registers and reviews the
 * ERP tools, Phase B saves each specialization, Phase A binds each agent to an existing seat, and
 * Phase C assigns and grants exactly the business capabilities in the workforce file.
 * Re-running is safe: existing pieces are reused.
 */
export async function setupWorkforce({ runtime, binding, workforce, seats = {} }) {
  const actor = DEVELOPER_ACTOR;
  const { mcpServers: servers, capabilities: registry, specializations } = runtime;
  const report = {
    server: null,
    discovery: null,
    reviewed: [],
    agents: [],
    principals: [],
    blockers: [],
    disabled: [],
  };

  if (!servers.get(binding.serverId)) servers.register(binding.binding.server);
  report.discovery = await registry.discover(binding.serverId);
  report.server = servers.get(binding.serverId);

  for (const [businessId, entry] of Object.entries(binding.binding.capabilities)) {
    const capabilityId = binding.capabilityId(businessId);
    const capability = capabilityId ? registry.get(capabilityId) : null;
    if (entry.disabled) {
      report.disabled.push({ business_capability: businessId, reason: entry.disabled });
      continue;
    }
    if (!capability) {
      report.blockers.push(`${businessId}: tool ${entry.tool ?? "(unbound)"} was not discovered.`);
      continue;
    }
    if (capability.state === "registered" && capability.risk === entry.risk) continue;
    registry.review(
      capabilityId,
      {
        risk: entry.risk,
        ...(entry.approval_required !== undefined
          ? { approval_required: entry.approval_required }
          : {}),
      },
      actor,
    );
    report.reviewed.push(capabilityId);
  }

  const previous = runtime.db.record(WORKFORCE_NAMESPACE, "current")?.agents ?? {};
  const available = freeSeats(runtime).filter((seat) => !Object.values(seats).includes(seat));
  const agents = {};
  for (const agent of workforce.agents) {
    const existing = previous[agent.role];
    let specializationId = existing?.specialization_id;
    let seatId = existing?.seat_id ?? seats[agent.role];
    if (!specializationId || !specializations.get(specializationId)) {
      const draft = {
        name: agent.name,
        specialization: agent.specialization,
        description: agent.purpose,
        purpose: agent.purpose,
        responsibilities: agent.responsibilities,
        allowed_actions: agent.allowed_actions,
        forbidden_actions: agent.forbidden_actions,
        decision_rules: [
          "Use only values returned by your tools.",
          "Report missing data instead of estimating it.",
        ],
        escalation: [
          "Return to the Manager Agent when data is missing or a request needs an action you may not take.",
        ],
        output_format: "Structured JSON results with source references.",
        data_access: agent.business_capabilities.length ? "read_only" : "none",
        runtime: { provider: "openclaw" },
      };
      const config = {
        ...draft,
        // Phase B's catalogue does not list ERP tools; ERP access is governed by Phase C below.
        capabilities: [],
        permissions: [],
        instructions: renderInstructions({ ...draft, capabilities: agent.business_capabilities }),
      };
      specializationId = specializations.save({ confirm: true, config }).specialization.id;
    }
    if (!runtime.profiles.get(agent.agent_id)) {
      seatId ??= available.shift();
      if (!seatId) {
        report.blockers.push(`${agent.name}: no free bound OpenClaw seat.`);
        continue;
      }
      try {
        specializations.assign(specializationId, { agent_id: agent.agent_id, seat_id: seatId });
      } catch (error) {
        report.blockers.push(`${agent.name}: ${error.message}`);
        continue;
      }
    } else seatId = runtime.profiles.get(agent.agent_id).seat_id;

    const subject = `specialization:${specializationId}`;
    const granted = await applyCapabilities(
      runtime,
      binding,
      subject,
      agent.business_capabilities,
      report,
    );
    agents[agent.role] = {
      agent_id: agent.agent_id,
      name: agent.name,
      specialization_id: specializationId,
      seat_id: seatId,
      business_capabilities: agent.business_capabilities,
      granted,
    };
    report.agents.push(agents[agent.role]);
  }
  for (const principal of workforce.principals ?? []) {
    const granted = await applyCapabilities(
      runtime,
      binding,
      `agent:${principal.id}`,
      principal.business_capabilities,
      report,
    );
    report.principals.push({ id: principal.id, granted });
  }
  runtime.db.saveRecord(
    WORKFORCE_NAMESPACE,
    "current",
    {
      agents,
      principals: report.principals,
      server_id: binding.serverId,
      at: new Date().toISOString(),
    },
    runtime.db.record(WORKFORCE_NAMESPACE, "current")?.revision ?? 0,
  );
  return report;
}

async function applyCapabilities(runtime, binding, subject, businessIds, report) {
  const { governance } = runtime;
  const capabilityIds = businessIds.map((id) => binding.capabilityId(id)).filter(Boolean);
  const registered = capabilityIds.filter(
    (id) => runtime.capabilities.get(id)?.state === "registered",
  );
  governance.assign(subject, registered, DEVELOPER_ACTOR);
  const active = governance.grants().filter((row) => row.subject === subject);
  for (const businessId of businessIds) {
    // A capability the deployment deliberately disables is not an error and is never granted.
    if (binding.binding.capabilities[businessId]?.disabled) continue;
    const capabilityId = binding.capabilityId(businessId);
    const capability = capabilityId && runtime.capabilities.get(capabilityId);
    if (!capability || capability.state !== "registered") {
      report.blockers.push(`${subject}: ${businessId} is not a registered capability.`);
      continue;
    }
    if (
      active.some(
        (row) =>
          row.capability_id === capabilityId &&
          row.schema_fingerprint === capability.schema_fingerprint,
      )
    )
      continue;
    const resource = binding.binding.capabilities[businessId]?.resource;
    governance.grant(
      { subject, capability_id: capabilityId, ...(resource ? { resource } : {}) },
      DEVELOPER_ACTOR,
    );
  }
  return registered;
}

/** The configured workforce, or a clear error before setup. */
export function currentWorkforce(runtime) {
  const record = runtime.db.record(WORKFORCE_NAMESPACE, "current");
  if (!record)
    throw fail(409, "The NammaOps workforce is not set up yet (POST /api/nammaops/setup).");
  return record;
}
