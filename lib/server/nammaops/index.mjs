import { ErpBinding, loadBinding } from "./erp-binding.mjs";
import { OwnerApprovals } from "./owner-approvals.mjs";
import { Workflows } from "./workflows.mjs";
import { VoiceRouter } from "./voice-router.mjs";
import { loadWorkforce, setupWorkforce, currentWorkforce } from "./workforce.mjs";

/**
 * NammaOps on top of the existing runtime: the binding resolves business capabilities to governed
 * MCP tools, owner approvals gate purchase submission, and one workflow runner serves all three
 * workflows. Nothing here talks to ERP except through `runtime.mcpGateway`.
 * @param {any} runtime @param {Record<string, string | undefined>} env
 */
export function createNammaOps(runtime, env = process.env, overrides = {}) {
  const binding = new ErpBinding(overrides.binding ?? loadBinding(env.NAMMAOPS_BINDING), {
    registry: runtime.capabilities,
    gateway: runtime.mcpGateway,
  });
  const workforce = overrides.workforce ?? loadWorkforce(env.NAMMAOPS_WORKFORCE);
  let workflows;
  const approvals = new OwnerApprovals(runtime, {
    binding,
    pin: env.NAMMAOPS_OWNER_PIN || undefined,
    now: overrides.now,
    onSettled: (approval) => workflows?.settleApproval(approval),
  });
  workflows = new Workflows(runtime, {
    binding,
    approvals,
    reasoning: ["off", "manager"].includes(env.NAMMAOPS_REASONING) ? env.NAMMAOPS_REASONING : "off",
    reasoningTimeoutMs: Number(env.NAMMAOPS_REASONING_TIMEOUT_MS) || undefined,
    today: overrides.today ?? (env.NAMMAOPS_TODAY ? () => env.NAMMAOPS_TODAY : undefined),
  });
  // Voice department seats are presentation only; ERP access stays with the specialists.
  const voice = new VoiceRouter({
    workflows,
    binding,
    db: () => runtime.db,
    departments: workforce.voice_departments,
    waitMs: Number(env.NAMMAOPS_VOICE_WAIT_MS) || undefined,
  });
  return {
    binding,
    approvals,
    workflows,
    voice,
    setup: (seats) => setupWorkforce({ runtime, binding, workforce, seats }),
    workforce: () => {
      try {
        return currentWorkforce(runtime);
      } catch {
        return null;
      }
    },
  };
}
