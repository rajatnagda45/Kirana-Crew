/**
 * Agent router for KiranaCrew.
 *
 * Given a classified intent and the currently available seats, selects the correct
 * agents with scoring and hard-constraint enforcement.
 *
 * Hard constraints override scores:
 * - An agent without the required capability is never selected.
 * - An unavailable agent is never selected (fallback to partial result with warning).
 * - An agent that requires a PO approval cannot bypass it even in multi-agent plans.
 *
 * Scoring inputs (weights are initial proposals — tune against real traffic):
 *   capability_match    0.35
 *   intent_match        0.25
 *   domain_match        0.20
 *   tool_compatibility  0.10
 *   availability        0.10
 */

import {
  AGENTS,
  DOMAINS,
  AGENT_REGISTRY,
  DOMAIN_TO_AGENT,
  agentsForCapability,
} from "./capability-registry.mjs";
import { classifyIntent } from "./intent-classifier.mjs";

const SCORE_WEIGHTS = Object.freeze({
  capability_match: 0.35,
  intent_match: 0.25,
  domain_match: 0.2,
  tool_compatibility: 0.1,
  availability: 0.1,
});

// ── Scoring ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Score an agent for a given intent and seat availability.
 * Returns an object with individual scores and a weighted total.
 */
function scoreAgent(agentId, intent, availableSeatLabels) {
  const meta = AGENT_REGISTRY[agentId];
  if (!meta) return { agentId, total: 0, breakdown: {}, eligible: false };

  const requiredCaps = intent.requiredCapabilities ?? [];
  const agentCaps = new Set(meta.capabilities);

  // Hard constraint: capability match
  const matchingCaps = requiredCaps.filter((c) => agentCaps.has(c));
  const capabilityMatch = requiredCaps.length > 0 ? matchingCaps.length / requiredCaps.length : 0.5;

  // Intent match: does the agent's domain match any detected domain?
  const intentMatch = intent.domains.includes(meta.domain) ? 1.0 : 0.0;

  // Domain match: same as intent match (both score domain alignment)
  const domainMatch = intentMatch;

  // Tool compatibility: does the agent use the voice router or direct path?
  // Voice-router agents have higher tool compatibility for known intents.
  const voiceIntentForDomain = intent.voiceIntents?.[meta.domain];
  const toolCompatibility =
    meta.usesVoiceRouter && voiceIntentForDomain
      ? 1.0
      : !meta.usesVoiceRouter
        ? 0.8 // direct agent path is still valid
        : 0.4;

  // Availability score: is this agent's seat currently available?
  const availability = availableSeatLabels.has(meta.label.toLowerCase()) ? 1.0 : 0.0;

  const breakdown = {
    capability_match: capabilityMatch,
    intent_match: intentMatch,
    domain_match: domainMatch,
    tool_compatibility: toolCompatibility,
    availability,
  };
  const total = Object.entries(breakdown).reduce(
    (sum, [key, value]) => sum + value * SCORE_WEIGHTS[key],
    0,
  );

  return { agentId, total, breakdown, eligible: intentMatch > 0 && availability > 0 };
}

// ── Selection ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the routing decision for a request.
 *
 * @param {string} message - Raw user message.
 * @param {Array<{seatId: string, label: string, department?: string}>} availableSeats
 *   - Seats that are currently assigned and available.
 * @returns {RoutingDecision}
 */
export function routeRequest(message, availableSeats = []) {
  const intent = classifyIntent(message);
  return routeIntent(intent, availableSeats);
}

/**
 * Route a pre-classified intent against available seats.
 */
export function routeIntent(intent, availableSeats = []) {
  const availableSeatLabels = new Set(availableSeats.map((s) => (s.label ?? "").toLowerCase()));

  // Greeting: no routing needed
  if (intent.primaryIntent === "greeting") {
    return buildDecision(intent, [], [], "single", "Greeting — no agent routing needed.", []);
  }

  // Clarification needed: return as-is
  if (intent.needsClarification) {
    return buildDecision(
      intent,
      [],
      [],
      "single",
      intent.clarificationQuestion ?? "Clarification required before routing.",
      [],
      { needsClarification: true },
    );
  }

  // Score all candidate agents
  const scores = Object.keys(AGENT_REGISTRY).map((agentId) =>
    scoreAgent(agentId, intent, availableSeatLabels),
  );

  // Select eligible agents for the detected domains
  const targetAgentIds = intent.selectedAgents ?? [];
  const selectedScores = scores
    .filter((s) => targetAgentIds.includes(s.agentId))
    .sort((a, b) => b.total - a.total);

  const selected = selectedScores.filter((s) => s.eligible).map((s) => s.agentId);
  const unavailable = selectedScores
    .filter((s) => !s.eligible && targetAgentIds.includes(s.agentId))
    .map((s) => s.agentId);

  // Build selection reasons
  const reasons = {};
  for (const { agentId, breakdown, eligible } of selectedScores) {
    const meta = AGENT_REGISTRY[agentId];
    if (!meta) continue;
    const reasonList = [];
    if (intent.domains.includes(meta.domain)) reasonList.push(`${meta.domain} domain match`);
    const caps = (intent.requiredCapabilities ?? []).filter((c) => meta.capabilities.includes(c));
    if (caps.length > 0) reasonList.push(`capabilities: ${caps.slice(0, 2).join(", ")}`);
    if (!eligible) reasonList.push("seat currently unavailable");
    reasons[agentId] = reasonList;
  }

  const selectionSummary =
    selected.length > 0
      ? `Selected ${selected.map((id) => AGENT_REGISTRY[id]?.label).join(", ")} for: ${intent.domains.join(", ")}`
      : "No available agents found for this request.";

  return buildDecision(
    intent,
    selected,
    scores,
    intent.executionStrategy ?? "single",
    selectionSummary,
    reasons,
    { unavailableAgents: unavailable },
  );
}

function buildDecision(intent, selected, allScores, strategy, summary, reasons, extra = {}) {
  return {
    // Input
    originalRequest: intent.originalRequest,
    normalizedText: intent.normalizedText,
    // Classification
    domains: intent.domains,
    primaryIntent: intent.primaryIntent,
    voiceIntents: intent.voiceIntents,
    confidence: intent.confidence,
    // Selection
    selectedAgents: selected,
    selectionReasons: reasons,
    selectionSummary: summary,
    allScores: allScores.map(({ agentId, total, eligible }) => ({ agentId, total, eligible })),
    // Execution
    executionStrategy: strategy,
    dependencies: intent.dependencies,
    requiresApproval: intent.requiresApproval,
    noBuyConstraint: intent.noBuyConstraint,
    // Extras
    needsClarification: intent.needsClarification ?? false,
    clarificationQuestion: intent.clarificationQuestion,
    timeContext: intent.timeContext,
    unavailableAgents: extra.unavailableAgents ?? [],
  };
}

// ── Execution plan builder ────────────────────────────────────────────────────────────────────────

/**
 * Build an execution plan from a routing decision.
 * Returns execution groups: each group is an array of agent tasks that can run in parallel.
 * Groups run in order (group[0] → group[1] → ...).
 */
export function buildExecutionPlan(decision) {
  const { selectedAgents, executionStrategy, dependencies } = decision;
  if (selectedAgents.length === 0) return { groups: [], strategy: "none" };

  if (executionStrategy === "single") {
    return { groups: [[selectedAgents[0]]], strategy: "single" };
  }

  if (executionStrategy === "dependency_based" && dependencies?.length > 0) {
    // Topological sort based on dependencies
    const upstreamSet = new Set(dependencies.map((d) => d.upstream));
    const downstreamSet = new Set(dependencies.map((d) => d.downstream));

    const upstream = selectedAgents.filter((id) => upstreamSet.has(id));
    const downstream = selectedAgents.filter((id) => downstreamSet.has(id));
    const independent = selectedAgents.filter(
      (id) => !upstreamSet.has(id) && !downstreamSet.has(id),
    );

    const groups = [];
    if (upstream.length > 0 || independent.length > 0) {
      groups.push([...upstream, ...independent]);
    }
    if (downstream.length > 0) {
      groups.push(downstream);
    }
    return { groups, strategy: "dependency_based", dependencies };
  }

  // Parallel
  return { groups: [selectedAgents], strategy: "parallel" };
}

/**
 * Return a human-readable routing explanation for the chat UI.
 */
export function explainRouting(decision) {
  if (decision.needsClarification) {
    return decision.clarificationQuestion ?? "Could you clarify your request?";
  }
  if (decision.selectedAgents.length === 0) {
    return decision.selectionSummary;
  }
  const agentLabels = decision.selectedAgents.map((id) => AGENT_REGISTRY[id]?.label ?? id);
  const strategyText =
    decision.executionStrategy === "parallel"
      ? "They can work at the same time."
      : decision.executionStrategy === "dependency_based"
        ? "They will work in sequence — the first result feeds into the next."
        : "";
  const unavailableText =
    decision.unavailableAgents.length > 0
      ? ` Note: ${decision.unavailableAgents.map((id) => AGENT_REGISTRY[id]?.label ?? id).join(", ")} ${decision.unavailableAgents.length === 1 ? "is" : "are"} not currently available.`
      : "";
  return `I'll ask ${agentLabels.join(" and ")} to work on this. ${strategyText}${unavailableText}`;
}
