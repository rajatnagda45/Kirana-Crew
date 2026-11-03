/**
 * Multi-agent task planner for KiranaCrew.
 *
 * Builds a concrete execution plan from a routing decision:
 * - Creates task descriptors with IDs, assignments, and subtask descriptions.
 * - Detects and prevents circular dependencies.
 * - Generates per-agent instructions for the group chat message.
 * - Handles partial failure: if an upstream agent fails, downstream tasks are skipped.
 *
 * This planner produces the plan; the ExecutionCoordinator in office-group-chat runs it.
 */

import { AGENTS, AGENT_REGISTRY, DOMAINS } from "./capability-registry.mjs";
import { buildExecutionPlan } from "./agent-router.mjs";

// ── Task status ───────────────────────────────────────────────────────────────────────────────────

export const TASK_STATUS = Object.freeze({
  PLANNED: "planned",
  QUEUED: "queued",
  RUNNING: "running",
  WAITING: "waiting_for_dependency",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  AWAITING_APPROVAL: "awaiting_approval",
});

// ── Agent instruction templates ───────────────────────────────────────────────────────────────────

/**
 * Build the specific instruction for an agent task.
 * The instruction tells the agent exactly what to check and how to report.
 */
function buildAgentInstruction(agentId, voiceIntent, primaryIntent, timeContext, noBuyConstraint) {
  const meta = AGENT_REGISTRY[agentId];
  const today = timeContext === "yesterday" ? "yesterday" : "today";

  switch (agentId) {
    case AGENTS.INVENTORY:
      if (voiceIntent === "list_products")
        return `List all products by category with current stock levels. Show every item's available quantity.`;
      if (voiceIntent === "demand_forecast")
        return `Forecast what needs to be ordered based on recent sales history. List products with expected demand and suggested order quantities.`;
      return `Check all inventory: report stock levels for all products, identify items at or below reorder level, and provide purchase recommendations for low-stock items.`;

    case AGENTS.SALES:
      if (voiceIntent === "top_selling_products")
        return `Report the top-selling products for ${today} by quantity and revenue. Use submitted sales invoices and POS records only.`;
      return `Summarise sales for ${today}: total revenue, number of transactions, and top products. Use submitted invoices and POS records only.`;

    case AGENTS.PROCUREMENT:
      if (voiceIntent === "supplier_comparison")
        return `Compare suppliers and quotations for low-stock or requested items. Show supplier names, prices, and lead times.`;
      if (voiceIntent === "prepare_purchase_order" && !noBuyConstraint)
        return `Prepare draft purchase orders for products that need restocking. Present them for owner approval — do not submit.`;
      return `Check demand forecast: which products need to be ordered based on current stock and recent sales? Show recommended quantities and available suppliers.`;

    case AGENTS.FINANCE:
      return `Review financial records: check the profit and loss report, general ledger, and payment summary. Report actual figures from posted accounting data only. Do not estimate profit from sales alone.`;

    case AGENTS.MANAGER:
      return `Coordinate the team's findings and provide a unified store overview. Synthesize the specialist reports into one clear answer.`;

    default:
      return `Review your area and report findings clearly. Use your tools; report only verified data.`;
  }
}

// ── Circular dependency detection ────────────────────────────────────────────────────────────────

function hasCycle(agentIds, deps) {
  const adj = new Map(agentIds.map((id) => [id, []]));
  for (const { upstream, downstream } of deps ?? []) {
    if (adj.has(upstream)) adj.get(upstream).push(downstream);
  }
  const visited = new Set();
  const inStack = new Set();
  function dfs(node) {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const neighbor of adj.get(node) ?? []) {
      if (dfs(neighbor)) return true;
    }
    inStack.delete(node);
    return false;
  }
  return agentIds.some((id) => dfs(id));
}

// ── Main planner ──────────────────────────────────────────────────────────────────────────────────

/**
 * Build a concrete multi-agent task plan from a routing decision.
 *
 * @param {object} decision - Output of routeIntent().
 * @param {string} groupTurnId - The group turn ID for task ID namespacing.
 * @returns {MultiAgentPlan}
 */
export function buildPlan(decision, groupTurnId) {
  const executionPlan = buildExecutionPlan(decision);

  if (executionPlan.groups.length === 0) {
    return {
      planId: `plan_${groupTurnId}`,
      groupTurnId,
      strategy: "none",
      groups: [],
      tasks: [],
      hasCycle: false,
      requiresApproval: decision.requiresApproval,
      noBuyConstraint: decision.noBuyConstraint,
      explanation: decision.selectionSummary,
    };
  }

  const allAgents = executionPlan.groups.flat();
  const cycleDetected = hasCycle(allAgents, decision.dependencies);
  if (cycleDetected) {
    throw new Error("Circular dependency detected in agent execution plan.");
  }

  // Build task descriptors
  const tasks = [];
  for (let groupIndex = 0; groupIndex < executionPlan.groups.length; groupIndex++) {
    const group = executionPlan.groups[groupIndex];
    for (const agentId of group) {
      const meta = AGENT_REGISTRY[agentId];
      if (!meta) continue;

      const voiceIntent = decision.voiceIntents?.[meta.domain] ?? null;
      const taskId = `plan_${groupTurnId}_${agentId.replace(/[^a-z0-9]/g, "_")}`;
      const deps = (decision.dependencies ?? [])
        .filter((d) => d.downstream === agentId)
        .map((d) => `plan_${groupTurnId}_${d.upstream.replace(/[^a-z0-9]/g, "_")}`);

      tasks.push({
        taskId,
        groupTurnId,
        agentId,
        label: meta.label,
        domain: meta.domain,
        groupIndex,
        voiceIntent,
        instruction: buildAgentInstruction(
          agentId,
          voiceIntent,
          decision.primaryIntent,
          decision.timeContext,
          decision.noBuyConstraint,
        ),
        usesVoiceRouter: meta.usesVoiceRouter,
        dependsOn: deps,
        status: TASK_STATUS.PLANNED,
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
      });
    }
  }

  // Build execution explanation
  const groupDescriptions = executionPlan.groups.map((group, i) => {
    const labels = group.map((id) => AGENT_REGISTRY[id]?.label ?? id);
    const sep = executionPlan.strategy === "dependency_based" ? `Step ${i + 1}` : "Parallel";
    return `${sep}: ${labels.join(", ")}`;
  });

  const explanation =
    executionPlan.groups.length === 1
      ? `${executionPlan.groups[0].map((id) => AGENT_REGISTRY[id]?.label).join(" and ")} will work on this.`
      : `${groupDescriptions.join(" → ")}. Alice will synthesize all results.`;

  return {
    planId: `plan_${groupTurnId}`,
    groupTurnId,
    strategy: executionPlan.strategy,
    groups: executionPlan.groups,
    tasks,
    hasCycle: false,
    requiresApproval: decision.requiresApproval,
    noBuyConstraint: decision.noBuyConstraint,
    explanation,
    // Routing metadata for telemetry
    routing: {
      domains: decision.domains,
      primaryIntent: decision.primaryIntent,
      confidence: decision.confidence,
      selectionReasons: decision.selectionReasons,
    },
  };
}

/**
 * Get tasks for a specific execution group index.
 */
export function tasksForGroup(plan, groupIndex) {
  return plan.tasks.filter((t) => t.groupIndex === groupIndex);
}

/**
 * Check if all tasks in a group have completed.
 */
export function groupCompleted(plan, groupIndex) {
  return tasksForGroup(plan, groupIndex).every(
    (t) => t.status === TASK_STATUS.COMPLETED || t.status === TASK_STATUS.FAILED,
  );
}

/**
 * Get the results from a completed group (for passing to dependent groups).
 */
export function groupResults(plan, groupIndex) {
  return tasksForGroup(plan, groupIndex)
    .filter((t) => t.status === TASK_STATUS.COMPLETED && t.result)
    .map((t) => ({ agentId: t.agentId, label: t.label, result: t.result }));
}
