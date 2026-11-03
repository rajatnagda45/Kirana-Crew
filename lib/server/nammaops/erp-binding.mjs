import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fail = (status, message) => Object.assign(new Error(message), { status });
/** `hvgerp` is the live read-only adapter, which returns the fixture's result shapes. */
export const SUPPORTED_SHAPES = ["fixture", "hvgerp"];

/** Loads a binding file (business capability -> MCP tool on one server). */
export function loadBinding(path = "config/nammaops/binding.fixture.json") {
  const binding = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (
    !binding?.server?.server_id ||
    !binding.capabilities ||
    typeof binding.capabilities !== "object"
  )
    throw new Error(`Invalid NammaOps binding file: ${path}`);
  return binding;
}

/**
 * Keeps third-party MCP tool names out of agents and workflows. Callers use business IDs such as
 * `erp.stock.balance`; this resolves them to registered Phase C capabilities and calls the
 * governed gateway under the caller's agent identity.
 */
export class ErpBinding {
  /**
   * @param {any} binding
   * @param {{registry: any, gateway: any, onOutcome?: (status: string) => void}} deps
   *   `onOutcome` receives a ServiceRegistry observation ("available" | "unauthorized" |
   *   "unreachable" | "unverified") after each governed call; it never changes the result.
   */
  constructor(binding, { registry, gateway, onOutcome }) {
    this.binding = binding;
    this.registry = registry;
    this.gateway = gateway;
    this.onOutcome = onOutcome;
  }

  observe(invocationStatus) {
    if (!this.onOutcome) return;
    const status =
      invocationStatus === "completed"
        ? "available"
        : ["denied", "approval_required", "rejected"].includes(invocationStatus)
          ? "unauthorized"
          : invocationStatus === "failed"
            ? "unreachable"
            : "unverified";
    try {
      this.onOutcome(status);
    } catch {
      /* Observation is advisory only. */
    }
  }

  get serverId() {
    return this.binding.server.server_id;
  }

  capabilityId(businessId) {
    const tool = this.binding.capabilities[businessId]?.tool;
    return tool ? `mcp.${this.serverId}.${tool}` : null;
  }

  /** Per business capability: bound tool, registry state and availability. */
  status() {
    return Object.entries(this.binding.capabilities).map(([id, entry]) => {
      const capability = this.capabilityId(id) ? this.registry.get(this.capabilityId(id)) : null;
      return {
        business_capability: id,
        tool: entry.tool ?? null,
        capability_id: this.capabilityId(id),
        state: capability?.state ?? (entry.tool ? "not_discovered" : "unbound"),
        availability: capability?.availability ?? "unavailable",
        risk: capability?.risk ?? entry.risk ?? null,
      };
    });
  }

  /**
   * One governed call. Returns the tool's structured result, or throws with a truthful
   * workflow status: blocked (policy/unavailable), uncertain or failed. Never retried here.
   */
  async call(agentId, businessId, args, { taskId, correlationId } = {}) {
    if (!SUPPORTED_SHAPES.includes(this.binding.shape))
      throw Object.assign(
        fail(409, `No result normalizer for binding shape "${this.binding.shape}" yet.`),
        {
          workflowStatus: "blocked",
        },
      );
    const capabilityId = this.capabilityId(businessId);
    const disabled = this.binding.capabilities[businessId]?.disabled;
    if (!capabilityId && disabled)
      throw Object.assign(
        fail(409, `${businessId} is not enabled in this deployment: ${disabled}`),
        {
          workflowStatus: "blocked",
        },
      );
    if (!capabilityId)
      throw Object.assign(fail(409, `${businessId} is not bound to a discovered tool.`), {
        workflowStatus: "blocked",
      });
    const invocation = await this.gateway.invoke({
      agentId,
      capabilityId,
      arguments: args ?? {},
      taskId,
      correlationId,
    });
    this.observe(invocation.status);
    if (invocation.status === "completed") {
      const data =
        invocation.result?.structuredContent ??
        JSON.parse(invocation.result?.content?.find((row) => row.type === "text")?.text ?? "null");
      return { data, invocation_id: invocation.invocation_id };
    }
    const workflowStatus =
      invocation.status === "uncertain"
        ? "uncertain"
        : ["denied", "unavailable", "approval_required", "rejected"].includes(invocation.status)
          ? "blocked"
          : "failed";
    const toolText = invocation.result?.content?.find((row) => row.type === "text")?.text;
    const detail = [invocation.error, toolText].filter(Boolean).join(" ").slice(0, 300);
    throw Object.assign(
      fail(409, `${businessId}: ${invocation.status}${detail ? ` (${detail})` : ""}`),
      {
        workflowStatus,
        invocation_id: invocation.invocation_id,
        invocationStatus: invocation.status,
      },
    );
  }
}
