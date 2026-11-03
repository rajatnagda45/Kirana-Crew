import { MAX_AUDIO_BYTES } from "./stt.mjs";
import { validSpeech } from "./tts.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Both public prefixes reach one implementation. `/api/runtime/tasks*` is the existing seat API, so
 * its agent-task mirror is `/api/runtime/agent-tasks*`.
 */
export function agentRoute(path) {
  const match =
    /^\/api\/(?:runtime\/)?(agents)(\/.*)?$/.exec(path) ??
    /^\/api\/(tasks)(\/.*)?$/.exec(path) ??
    /^\/api\/runtime\/agent-(tasks)(\/.*)?$/.exec(path);
  if (!match || (match[1] === "agents" && match[2] === "/discover")) return null;
  return { area: match[1], rest: match[2] ?? "" };
}

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw fail(400, "Invalid path.");
  }
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw fail(413, "Request body too large");
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

/** Multipart with a hard byte cap; uses the platform parser, so no new dependency. */
async function readForm(req) {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.toLowerCase().startsWith("multipart/form-data"))
    throw fail(415, "Use multipart/form-data.");
  const limit = MAX_AUDIO_BYTES + 64 * 1024;
  if (Number(req.headers["content-length"]) > limit) throw fail(413, "Audio upload too large.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, "Audio upload too large.");
    chunks.push(chunk);
  }
  try {
    return await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": type },
      body: Buffer.concat(chunks),
    }).formData();
  } catch {
    throw fail(400, "Invalid multipart body.");
  }
}

/**
 * Text-to-speech for a reply the owner already sees on screen. New provider work, so the emergency
 * stop applies; rate-limited; the result names the provider and whether its contract is verified.
 */
async function speak(runtime, input) {
  runtime.estop?.assertClear?.();
  const speech = validSpeech(input ?? {});
  let tts;
  try {
    tts = runtime.ttsFactory?.() ?? null;
  } catch (error) {
    throw fail(503, error.message);
  }
  if (!tts)
    throw fail(503, "No text-to-speech provider is configured (set AGENT_TOWN_TTS_PROVIDER).");
  runtime.ttsLimit?.();
  const result = await tts.synthesize(speech);
  return {
    status: 200,
    body: {
      speech: {
        provider: result.provider,
        mime: result.mime,
        audio_base64: result.bytes.toString("base64"),
        bytes: result.bytes.length,
        verifies_speech: tts.verifiesSpeech === true,
        provider_contract_verified: tts.contractVerified === true,
        ...(result.fallbackUsed ? { fallback_used: true, fallback_from: result.fallbackFrom } : {}),
      },
    },
  };
}

/** @returns {Promise<{status: number, body: unknown}>} */
export async function handleAgentApi(runtime, req, route) {
  const { profiles, agentTasks } = runtime;
  if (!profiles || !agentTasks) throw fail(503, "Agent execution is not available.");
  const { area, rest } = route;
  const method = req.method;
  if (area === "agents") {
    const id = rest ? decode(rest.slice(1)) : null;
    if (id?.includes("/")) throw fail(404, "Unknown agent endpoint.");
    if (!id && method === "GET") return { status: 200, body: { agents: profiles.list() } };
    if (!id && method === "POST")
      return { status: 201, body: { agent: profiles.create(await readJson(req)) } };
    if (id && method === "GET") {
      const agent = profiles.get(id);
      if (!agent) throw fail(404, "Agent not found.");
      return { status: 200, body: { agent } };
    }
    if (id && method === "PATCH")
      return { status: 200, body: { agent: profiles.update(id, await readJson(req)) } };
    throw fail(405, "Unsupported agent endpoint or method.");
  }
  if (rest === "" && method === "POST")
    return { status: 202, body: { task: await agentTasks.submitText(await readJson(req)) } };
  if (rest === "/voice/speak" && method === "POST") return speak(runtime, await readJson(req));
  if (rest === "/voice" && method === "POST") {
    const form = await readForm(req);
    const audio = form.get("audio");
    if (!audio || typeof audio === "string") throw fail(400, "audio file field is required.");
    const field = (name) => {
      const value = form.get(name);
      return typeof value === "string" && value !== "" ? value : undefined;
    };
    const task = await agentTasks.submitVoice({
      agentId: field("agent_id"),
      sessionId: field("session_id"),
      language: field("language"),
      mime: audio.type,
      bytes: Buffer.from(await audio.arrayBuffer()),
    });
    return { status: 202, body: { task } };
  }
  const match = /^\/([^/]+)(?:\/(events|cancel))?$/.exec(rest);
  if (!match) throw fail(404, "Unknown task endpoint.");
  const taskId = decode(match[1]);
  if (!match[2] && method === "GET") {
    const task = agentTasks.view(taskId);
    if (!task) throw fail(404, "Task not found.");
    return { status: 200, body: { task } };
  }
  if (match[2] === "events" && method === "GET") {
    const events = agentTasks.events(taskId);
    if (!events) throw fail(404, "Task not found.");
    return { status: 200, body: events };
  }
  if (match[2] === "cancel" && method === "POST")
    return { status: 200, body: { task: await agentTasks.cancel(taskId) } };
  throw fail(405, "Unsupported task endpoint or method.");
}
