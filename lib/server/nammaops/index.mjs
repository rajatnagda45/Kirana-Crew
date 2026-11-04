import { ErpBinding, loadBinding } from "./erp-binding.mjs";
import { OwnerApprovals } from "./owner-approvals.mjs";
import { Workflows } from "./workflows.mjs";
import { VoiceRouter } from "./voice-router.mjs";
import { createDashboards } from "./dashboards.mjs";
import { loadWorkforce, setupWorkforce, currentWorkforce } from "./workforce.mjs";

/**
 * The running app reads live ERPNext only. The binding must be named explicitly, and the synthetic
 * test fixture is refused unless NAMMAOPS_ALLOW_FIXTURE=1 (development only). Automated tests pass
 * their own binding through `overrides`, which does not go through here.
 */
export function liveBinding(env) {
  const path = env.NAMMAOPS_BINDING?.trim();
  if (!path)
    throw new Error(
      "NAMMAOPS_BINDING is not set. NammaOps reads live ERPNext only: set it to config/nammaops/binding.hvgerp.json.",
    );
  const binding = loadBinding(path);
  if (binding.shape === "fixture" && env.NAMMAOPS_ALLOW_FIXTURE !== "1")
    throw new Error(
      "NAMMAOPS_BINDING points at the synthetic test fixture, which the app does not use. Use config/nammaops/binding.hvgerp.json (or set NAMMAOPS_ALLOW_FIXTURE=1 for development).",
    );
  return binding;
}

/**
 * NammaOps on top of the existing runtime: the binding resolves business capabilities to governed
 * MCP tools, owner approvals gate purchase submission, and one workflow runner serves all three
 * workflows. Nothing here talks to ERP except through `runtime.mcpGateway`.
 * @param {any} runtime @param {Record<string, string | undefined>} env
 */
export function createNammaOps(runtime, env = process.env, overrides = {}) {
  const binding = new ErpBinding(overrides.binding ?? liveBinding(env), {
    registry: runtime.capabilities,
    gateway: runtime.mcpGateway,
    onOutcome: (status) => runtime.services?.observe?.("erpnext", status),
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
  // Management dashboards read through the same binding as the READ-only dashboard principal.
  const dashboards = createDashboards({
    binding,
    today: () => workflows.today(),
    now: overrides.now,
    workforce: () => {
      try {
        return currentWorkforce(runtime);
      } catch {
        return null;
      }
    },
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
    dashboards,
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
