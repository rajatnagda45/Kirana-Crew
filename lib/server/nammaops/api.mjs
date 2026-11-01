import { isLoopbackAddress } from "../../server-security.mjs";
import { NAMMAOPS_OPENAPI } from "./openapi.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

/** `/api/nammaops/*` and its `/api/runtime/nammaops/*` mirror. */
export function nammaopsRoute(path) {
  const match = /^\/api\/(?:runtime\/)?nammaops(\/.*)?$/.exec(path);
  return match ? { rest: match[1] ?? "" } : null;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw fail(413, "Request body too large");
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

/** Latest result of each workflow kind, for the dashboard. */
function dashboard(nammaops) {
  const latest = {};
  for (const row of nammaops.workflows.list()) {
    const kind = row.intent?.action;
    if (kind && !latest[kind]) latest[kind] = nammaops.workflows.view(row.id);
  }
  return {
    workforce: nammaops.workforce(),
    binding: nammaops.binding.status(),
    latest,
    // Every approval for the shown reorder, so the panel can show submitted and rejected too.
    approvals: latest.prepare_reorder
      ? nammaops.approvals.list({ workflowId: latest.prepare_reorder.id })
      : [],
    data_source:
      nammaops.binding.binding.shape === "fixture"
        ? "fixture (synthetic, not real ERPNext data)"
        : "erpnext",
  };
}

/**
 * Loopback-only like Developer Mode. Owner approval additionally requires the owner PIN, which is
 * checked by OwnerApprovals, so a developer request alone cannot approve a purchase.
 * @returns {Promise<{status: number, body: unknown}>}
 */
export async function handleNammaOpsApi(runtime, req, { rest }) {
  if (!isLoopbackAddress(req.socket?.remoteAddress))
    throw fail(403, "NammaOps is only available locally.");
  const nammaops = runtime.nammaops;
  if (!nammaops) throw fail(503, "NammaOps is not available.");
  const method = req.method;
  if (rest === "/openapi.json" && method === "GET") return { status: 200, body: NAMMAOPS_OPENAPI };
  if (rest === "/setup" && method === "POST") {
    const input = await readJson(req);
    return { status: 200, body: { setup: await nammaops.setup(input.seats ?? {}) } };
  }
  if (rest === "/workforce" && method === "GET")
    return { status: 200, body: { workforce: nammaops.workforce() } };
  if (rest === "/binding" && method === "GET")
    return { status: 200, body: { binding: nammaops.binding.status() } };
  if (rest === "/dashboard" && method === "GET") return { status: 200, body: dashboard(nammaops) };
  if (rest === "/workflows" && method === "GET")
    return { status: 200, body: { workflows: nammaops.workflows.list() } };
  if (rest === "/workflows" && method === "POST") {
    const { workflow } = nammaops.workflows.start(await readJson(req));
    return { status: 202, body: { workflow } };
  }
  const workflow = /^\/workflows\/([^/]+)(\/events)?$/.exec(rest);
  if (workflow && method === "GET") {
    const view = nammaops.workflows.view(decode(workflow[1]));
    if (!view) throw fail(404, "Workflow not found.");
    return {
      status: 200,
      body: workflow[2] ? { timeline: view.timeline, tasks: view.tasks } : { workflow: view },
    };
  }
  if (rest === "/approvals" && method === "GET")
    return { status: 200, body: { approvals: nammaops.approvals.list() } };
  const approval = /^\/approvals\/([^/]+)\/(approve|reject|reconcile)$/.exec(rest);
  if (approval && method === "POST") {
    const input = await readJson(req);
    const approvalId = decode(approval[1]);
    const result =
      approval[2] === "approve"
        ? await nammaops.approvals.approve(approvalId, input.pin)
        : approval[2] === "reject"
          ? nammaops.approvals.reject(approvalId, input.pin)
          : await nammaops.approvals.reconcile(approvalId);
    return { status: 200, body: { approval: result } };
  }
  const known =
    /^\/(setup|workforce|binding|dashboard|workflows|approvals|openapi\.json)$/.test(rest) ||
    /^\/workflows\/[^/]+(\/events)?$/.test(rest) ||
    /^\/approvals\/[^/]+\/(approve|reject|reconcile)$/.test(rest);
  if (!known) throw fail(404, "Unknown NammaOps endpoint.");
  throw fail(405, `Method ${method} is not supported on this NammaOps endpoint.`);
}
