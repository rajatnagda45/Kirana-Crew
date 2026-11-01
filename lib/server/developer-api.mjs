import { isLoopbackAddress } from "../server-security.mjs";
import { DEVELOPER_ACTOR, validateConfig } from "./developer-config.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

/** `/api/developer/agent-config/*` and its `/api/runtime/` mirror reach one implementation. */
export function developerRoute(path) {
  const match = /^\/api\/(?:runtime\/)?developer\/agent-config(\/.*)?$/.exec(path);
  return match ? { rest: match[1] ?? "" } : null;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw fail(413, "Request body too large");
    chunks.push(chunk);
  }
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

/**
 * Developer authority is the local operator: a loopback socket that already passed the runtime's
 * same-origin checks. Models and agents have no route here.
 * @returns {Promise<{status: number, body: unknown}>}
 */
export async function handleDeveloperApi(runtime, req, { rest }) {
  if (!isLoopbackAddress(req.socket?.remoteAddress))
    throw fail(403, "Developer Mode is only available to the local developer.");
  const { generations, specializations } = runtime;
  if (!generations || !specializations) throw fail(503, "Developer Mode is not available.");
  const method = req.method;
  if (rest === "/generate" && method === "POST")
    return { status: 202, body: { generation: generations.generate(await readJson(req)) } };
  if (rest === "/validate" && method === "POST") {
    const input = await readJson(req);
    const approvals = input.id ? specializations.approvals(input.id) : {};
    return {
      status: 200,
      body: { validation: validateConfig(input.config, runtime, { approvals }) },
    };
  }
  if (rest === "/save" && method === "POST")
    return { status: 201, body: specializations.save(await readJson(req)) };
  if (rest === "" && method === "GET")
    return { status: 200, body: { specializations: specializations.list() } };
  const generation = /^\/generations\/([^/]+)$/.exec(rest);
  if (generation && method === "GET") {
    const view = generations.view(decode(generation[1]));
    if (!view) throw fail(404, "Generation not found.");
    return { status: 200, body: { generation: view } };
  }
  const decision = /^\/([^/]+)\/permissions\/([^/]+)$/.exec(rest);
  if (decision && method === "POST")
    return {
      status: 200,
      body: {
        approval: specializations.decide(
          decode(decision[1]),
          decode(decision[2]),
          await readJson(req),
          DEVELOPER_ACTOR,
        ),
      },
    };
  const item = /^\/([^/]+)$/.exec(rest);
  if (item && method === "GET") {
    const view = specializations.get(decode(item[1]));
    if (!view) throw fail(404, "Specialization not found.");
    return { status: 200, body: { specialization: view } };
  }
  if (item && method === "PATCH")
    return { status: 200, body: specializations.update(decode(item[1]), await readJson(req)) };
  throw fail(405, "Unsupported developer endpoint or method.");
}
