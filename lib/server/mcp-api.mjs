import { isLoopbackAddress, safeSecretEqual } from "../server-security.mjs";
import { DEVELOPER_ACTOR } from "./developer-config.mjs";
import { WORKFLOW_PRINCIPALS } from "./mcp-governance.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Developer routes (and their /api/runtime mirror) plus the proxy-only gateway route. */
export function mcpRoute(path) {
  const developer =
    /^\/api\/(?:runtime\/)?developer\/(mcp|capabilities|agents|permissions|approvals)(\/.*)?$/.exec(
      path,
    );
  if (developer) return { kind: "developer", area: developer[1], rest: developer[2] ?? "" };
  const gateway = /^\/api\/runtime\/mcp-gateway\/(tools|invoke)$/.exec(path);
  return gateway ? { kind: "gateway", area: gateway[1], rest: "" } : null;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw fail(413, "Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw fail(400, "Invalid JSON body");
  }
}

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw fail(400, "Invalid path.");
  }
};

/** Agent routes accept an agent ID or a specialization ID; both map to an assignment subject. */
function subjectFor(runtime, key) {
  if (runtime.profiles?.get(key)) return { subject: `agent:${key}`, kind: "agent" };
  if (runtime.specializations?.get(key))
    return { subject: `specialization:${key}`, kind: "specialization" };
  throw fail(404, "No agent or specialization with that ID.");
}

/**
 * The OpenClaw proxy path. It proves possession of AGENT_TOWN_MCP_PROXY_SECRET from a loopback
 * socket; the agent ID it sends is then evaluated by the same policy as everything else.
 */
async function handleGateway(runtime, req, area, env) {
  const secret = env.AGENT_TOWN_MCP_PROXY_SECRET;
  if (!secret) throw fail(503, "The governed MCP gateway is not configured.");
  if (
    !isLoopbackAddress(req.socket?.remoteAddress) ||
    !safeSecretEqual(req.headers["x-agent-town-mcp-secret"], secret)
  )
    throw fail(403, "Forbidden.");
  if (area === "tools" && req.method === "GET") {
    const agentId = new URL(req.url ?? "/", "http://localhost").searchParams.get("agent_id") ?? "";
    if (WORKFLOW_PRINCIPALS.has(agentId))
      throw fail(403, "Workflow principals cannot be used through the proxy.");
    return { status: 200, body: { tools: runtime.mcpGateway.exposedTools(agentId) } };
  }
  if (area === "invoke" && req.method === "POST") {
    const input = await readJson(req);
    if (WORKFLOW_PRINCIPALS.has(input.agent_id))
      throw fail(403, "Workflow principals cannot be used through the proxy.");
    return {
      status: 200,
      body: {
        invocation: await runtime.mcpGateway.invoke({
          agentId: input.agent_id,
          capabilityId: input.capability_id,
          arguments: input.arguments ?? {},
          taskId: input.task_id,
          approvalId: input.approval_id,
          correlationId: input.correlation_id,
          environment: input.environment,
        }),
      },
    };
  }
  throw fail(405, "Unsupported gateway method.");
}

/**
 * @param {any} runtime @param {any} req @param {{kind: string, area: string, rest: string}} route
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{status: number, body: unknown}>}
 */
export async function handleMcpApi(runtime, req, route, env = process.env) {
  const { mcpServers: servers, capabilities, governance, mcpGateway } = runtime;
  if (!servers || !capabilities || !governance || !mcpGateway)
    throw fail(503, "MCP governance is not available.");
  if (route.kind === "gateway") return handleGateway(runtime, req, route.area, env);
  if (!isLoopbackAddress(req.socket?.remoteAddress))
    throw fail(403, "Developer Mode is only available to the local developer.");
  const { area, rest } = route;
  const method = req.method;
  const actor = DEVELOPER_ACTOR;

  if (area === "mcp") {
    if (rest === "/servers" && method === "GET")
      return { status: 200, body: { servers: servers.list() } };
    if (rest === "/servers" && method === "POST")
      return { status: 201, body: { server: servers.register(await readJson(req)) } };
    if (rest === "/invocations" && method === "GET") {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      return {
        status: 200,
        body: {
          invocations: mcpGateway.invocations({
            taskId: params.get("task_id") ?? undefined,
            agentId: params.get("agent_id") ?? undefined,
          }),
        },
      };
    }
    const match = /^\/servers\/([^/]+)(?:\/(connect|discover|disconnect))?$/.exec(rest);
    if (!match) throw fail(404, "Unknown MCP endpoint.");
    const id = decode(match[1]);
    if (!match[2] && method === "GET") {
      const server = servers.get(id);
      if (!server) throw fail(404, "MCP server not found.");
      return { status: 200, body: { server } };
    }
    if (!match[2] && method === "PATCH")
      return { status: 200, body: { server: await servers.update(id, await readJson(req)) } };
    if (match[2] === "connect" && method === "POST") {
      await servers.client(id);
      return { status: 200, body: { server: servers.get(id) } };
    }
    if (match[2] === "discover" && method === "POST") {
      const summary = await capabilities.discover(id);
      return { status: 200, body: { discovery: summary, server: servers.get(id) } };
    }
    if (match[2] === "disconnect" && method === "POST")
      return { status: 200, body: { server: await servers.disconnect(id) } };
    throw fail(405, "Unsupported MCP server method.");
  }

  if (area === "capabilities") {
    if (rest === "" && method === "GET")
      return { status: 200, body: { capabilities: capabilities.list() } };
    const match = /^\/([^/]+)(\/review)?$/.exec(rest);
    if (!match) throw fail(404, "Unknown capability endpoint.");
    const id = decode(match[1]);
    if (!match[2] && method === "GET") {
      const capability = capabilities.get(id);
      if (!capability) throw fail(404, "Capability not found.");
      return { status: 200, body: { capability } };
    }
    if (match[2] && method === "POST")
      return {
        status: 200,
        body: { capability: capabilities.review(id, await readJson(req), actor) },
      };
    throw fail(405, "Unsupported capability method.");
  }

  if (area === "agents") {
    const match = /^\/([^/]+)\/(capabilities|permissions)$/.exec(rest);
    if (!match) throw fail(404, "Unknown agent endpoint.");
    const key = decode(match[1]);
    const { subject, kind } = subjectFor(runtime, key);
    if (match[2] === "capabilities" && method === "GET")
      return { status: 200, body: governance.assignments(subject) };
    if (match[2] === "capabilities" && method === "PUT") {
      const input = await readJson(req);
      return { status: 200, body: governance.assign(subject, input.capabilities, actor) };
    }
    if (match[2] === "permissions" && method === "GET")
      return {
        status: 200,
        body:
          kind === "agent"
            ? governance.effective(key)
            : {
                subject,
                assigned: governance.assignments(subject).capabilities,
                grants: governance.grants().filter((row) => row.subject === subject),
              },
      };
    throw fail(405, "Unsupported agent method.");
  }

  if (area === "permissions") {
    if (rest === "" && method === "GET")
      return { status: 200, body: { grants: governance.grants({ includeRevoked: true }) } };
    if (rest === "" && method === "POST")
      return { status: 201, body: { grant: governance.grant(await readJson(req), actor) } };
    const match = /^\/([^/]+)$/.exec(rest);
    if (match && method === "DELETE")
      return { status: 200, body: { grant: governance.revoke(decode(match[1]), actor) } };
    throw fail(405, "Unsupported permission method.");
  }

  // approvals
  if (rest === "" && method === "GET")
    return { status: 200, body: { approvals: governance.approvals() } };
  const match = /^\/([^/]+)\/(approve|deny)$/.exec(rest);
  if (match && method === "POST")
    return {
      status: 200,
      body: {
        approval: governance.decideApproval(
          decode(match[1]),
          match[2] === "approve" ? "approved" : "denied",
          actor,
        ),
      },
    };
  throw fail(405, "Unsupported approval method.");
}
