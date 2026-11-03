/**
 * Routing telemetry for KiranaCrew.
 *
 * Records structured routing traces for observability and debugging.
 * Traces contain factual routing information only — no sensitive prompts,
 * credentials, or internal chain-of-thought reasoning.
 *
 * Stored in the runtime database under namespace "routing.trace".
 * Accessible at GET /api/runtime/routing/trace?turnId=...
 */

export const ROUTING_TRACE_NS = "routing.trace";

/**
 * Record a routing trace for a group turn.
 * @param {object} db - Runtime database (must have saveRecord/record methods).
 * @param {string} turnId - The group turn ID.
 * @param {object} decision - The routing decision from routeIntent().
 * @param {object} [plan] - The task plan from buildPlan(), if available.
 */
export function recordTrace(db, turnId, decision, plan = null) {
  if (!db?.saveRecord) return;
  try {
    const trace = {
      turnId,
      at: new Date().toISOString(),
      request: decision.originalRequest,
      normalizedText: decision.normalizedText,
      domains: decision.domains,
      primaryIntent: decision.primaryIntent,
      confidence: decision.confidence,
      selectedAgents: decision.selectedAgents,
      selectionReasons: decision.selectionReasons,
      unavailableAgents: decision.unavailableAgents ?? [],
      executionStrategy: decision.executionStrategy,
      requiresApproval: decision.requiresApproval,
      noBuyConstraint: decision.noBuyConstraint,
      needsClarification: decision.needsClarification,
      ...(plan
        ? {
            planId: plan.planId,
            planStrategy: plan.strategy,
            planExplanation: plan.explanation,
            taskCount: plan.tasks.length,
          }
        : {}),
    };
    db.saveRecord(ROUTING_TRACE_NS, turnId, trace, 0);
  } catch {
    // Telemetry must never break routing execution
  }
}

/**
 * Get the routing trace for a turn.
 * @param {object} db - Runtime database.
 * @param {string} turnId
 * @returns {object|null}
 */
export function getTrace(db, turnId) {
  if (!db?.record) return null;
  try {
    return db.record(ROUTING_TRACE_NS, turnId) ?? null;
  } catch {
    return null;
  }
}

/**
 * List all recorded routing traces, most recent first.
 * @param {object} db
 * @param {number} [limit=50]
 */
export function listTraces(db, limit = 50) {
  if (!db?.records) return [];
  try {
    return (db.records(ROUTING_TRACE_NS) ?? [])
      .sort((a, b) => new Date(b.at ?? 0) - new Date(a.at ?? 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Format a trace for a human-readable routing explanation.
 * Safe to show to the store owner — no internal reasoning or credentials.
 */
export function formatTraceForDisplay(trace) {
  if (!trace) return "No routing trace available.";
  const agentList = (trace.selectedAgents ?? []).join(", ");
  const reasonLines = Object.entries(trace.selectionReasons ?? {})
    .map(([agentId, reasons]) => `  ${agentId}: ${(reasons ?? []).join(", ")}`)
    .join("\n");
  return [
    `Request: ${trace.request}`,
    `Domains: ${(trace.domains ?? []).join(", ") || "none"}`,
    `Intent: ${trace.primaryIntent ?? "unknown"}`,
    `Confidence: ${trace.confidence ?? "unknown"}`,
    `Selected agents: ${agentList || "none"}`,
    reasonLines ? `Selection reasons:\n${reasonLines}` : "",
    `Strategy: ${trace.executionStrategy ?? "none"}`,
    trace.needsClarification ? "Needs clarification before routing." : "",
  ]
    .filter(Boolean)
    .join("\n");
}
