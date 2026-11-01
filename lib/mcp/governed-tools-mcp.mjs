#!/usr/bin/env node
/**
 * Governed MCP proxy for OpenClaw. Register it in OpenClaw instead of the real MCP servers:
 * it lists only the tools Agent Town currently exposes to one agent and sends every call to the
 * Agent Town gateway, which decides, validates, executes once and audits it.
 *
 * Env: AGENT_TOWN_URL (loopback), AGENT_TOWN_AGENT_ID, AGENT_TOWN_MCP_PROXY_SECRET.
 * The agent identity comes from this process's configuration, never from tool arguments.
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const toolName = (capabilityId) => capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

/** @param {{baseUrl: string, agentId: string, secret: string, fetchImpl?: typeof fetch}} options */
export function createGovernedProxy({ baseUrl, agentId, secret, fetchImpl = fetch }) {
  const url = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("AGENT_TOWN_URL must be a loopback address.");
  if (!agentId || !secret)
    throw new Error("AGENT_TOWN_AGENT_ID and AGENT_TOWN_MCP_PROXY_SECRET are required.");
  const headers = { "x-agent-town-mcp-secret": secret, Origin: url.origin };
  const names = new Map();
  const listTools = async () => {
    const response = await fetchImpl(
      `${url.origin}/api/runtime/mcp-gateway/tools?agent_id=${encodeURIComponent(agentId)}`,
      { headers },
    );
    if (!response.ok)
      throw new Error(`Agent Town gateway refused the tool list (HTTP ${response.status}).`);
    const { tools } = await response.json();
    names.clear();
    return tools
      .filter((tool) => {
        const name = toolName(tool.capability_id);
        if (names.has(name)) return false;
        names.set(name, tool.capability_id);
        return true;
      })
      .map((tool) => ({
        name: toolName(tool.capability_id),
        description: `${tool.description}${tool.decision === "REQUIRES_APPROVAL" ? " (each call needs developer approval)" : ""}`,
        inputSchema: tool.input_schema,
      }));
  };
  const server = new Server(
    { name: "agent-town-governed-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!names.size) await listTools();
    const capabilityId = names.get(request.params.name);
    if (!capabilityId)
      return { isError: true, ...text("This tool is not available to this agent.") };
    const meta = request.params._meta ?? {};
    const response = await fetchImpl(`${url.origin}/api/runtime/mcp-gateway/invoke`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        capability_id: capabilityId,
        arguments: request.params.arguments ?? {},
        task_id: typeof meta.agentTownTaskId === "string" ? meta.agentTownTaskId : undefined,
      }),
    });
    const body = await response.json().catch(() => null);
    const invocation = body?.invocation;
    if (!response.ok || !invocation)
      return { isError: true, ...text(body?.error ?? `Gateway error (HTTP ${response.status}).`) };
    if (invocation.status === "completed") return invocation.result;
    if (invocation.status === "approval_required")
      return {
        isError: true,
        ...text(
          `Not executed: developer approval required (request ${invocation.approval_request_id}). Ask for approval, then repeat the identical call.`,
        ),
      };
    return {
      isError: true,
      ...text(`Not executed (${invocation.status}): ${invocation.error ?? "no detail"}`),
    };
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await createGovernedProxy({
    baseUrl: process.env.AGENT_TOWN_URL ?? "http://127.0.0.1:3108",
    agentId: process.env.AGENT_TOWN_AGENT_ID ?? "",
    secret: process.env.AGENT_TOWN_MCP_PROXY_SECRET ?? "",
  }).connect(new StdioServerTransport());
