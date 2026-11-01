/**
 * Phase A boundary for tools. Only the existing `dispatch_to_worker` MCP tool is described, and it
 * is not invoked from here. There is no discovery and no outbound MCP client; a future registry
 * implements this same shape. Authorisation stays with reviewed manifests and `tools.effective`.
 */
export const KNOWN_TOOLS = Object.freeze([
  {
    name: "dispatch_to_worker",
    source: "lib/mcp/agent-town-mcp.mjs",
    transport: "stdio",
    provider: "auggie",
  },
]);

/** Test fixture only: a deterministic stand-in so tests can exercise tool-event recording. */
export const TEST_FIXTURE_TOOL = Object.freeze({
  name: "test_fixture_echo",
  source: "test-fixture",
  transport: "none",
  provider: "test",
});

export class ToolRegistry {
  constructor(tools = KNOWN_TOOLS) {
    this.tools = tools;
  }

  /** Tool references only. Whether an agent may use one is decided by its reviewed grants. */
  list() {
    return this.tools.map((tool) => ({ ...tool }));
  }

  has(name) {
    return this.tools.some((tool) => tool.name === name);
  }
}
