#!/usr/bin/env node
/**
 * Phase A demonstration: configure an agent, run a text task and a voice task over REST, print
 * the task status and event history. It prints the exact blocker when the runtime refuses and
 * never reports success it did not observe.
 *
 *   node scripts/phase-a-demo.mjs [--base http://127.0.0.1:3108] [--seat oc-planner] [--wait 120]
 *
 * Voice needs AGENT_TOWN_STT_PROVIDER on the server. `fixture` returns a fixed transcript for any
 * audio, so it proves the pipeline wiring only, not speech recognition.
 */
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (rows, item, index, all) =>
        item.startsWith("--") ? [...rows, [item.slice(2), all[index + 1]]] : rows,
      [],
    ),
);
const base = args.base ?? "http://127.0.0.1:3108";
const seat = args.seat ?? "oc-planner";
const waitSeconds = Number(args.wait ?? 120);
const TERMINAL = new Set(["completed", "failed", "stopped", "interrupted", "outcome_unknown"]);
const TASK =
  "Research three ways to reduce inventory wastage in a small grocery store. Return a structured report.";

// Same-origin is required by the runtime for writes; this is the app's own origin.
const headers = { Origin: new URL(base).origin };
const call = async (method, path, body) => {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(base + path, init);
  return { status: response.status, body: await response.json().catch(() => null) };
};
const show = (title, value) => console.log(`\n== ${title}\n${JSON.stringify(value, null, 2)}`);

async function follow(taskId) {
  const deadline = Date.now() + waitSeconds * 1000;
  let task;
  do {
    task = (await call("GET", `/api/tasks/${taskId}`)).body?.task;
    if (task && TERMINAL.has(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  show(`task ${taskId}`, task);
  show("events", (await call("GET", `/api/tasks/${taskId}/events`)).body);
  console.log(
    TERMINAL.has(task?.status)
      ? `\nOutcome: ${task.status}`
      : `\nOutcome: not finished within ${waitSeconds}s (status ${task?.status}). Not verified.`,
  );
}

const agent = {
  agent_id: "inventory-analyst-01",
  name: "Inventory Analyst",
  specialization: "Inventory analysis",
  instructions: "Analyze inventory questions and report evidence clearly.",
  runtime: "openclaw",
  seat_id: seat,
  workspace: "agents/inventory-analyst-01",
};
let created = await call("POST", "/api/agents", agent);
if (created.status === 409) created = await call("GET", `/api/agents/${agent.agent_id}`);
show(`agent (HTTP ${created.status})`, created.body);
if (created.status >= 400) process.exit(1);

const text = await call("POST", "/api/tasks", {
  agent_id: agent.agent_id,
  input: { type: "text", text: TASK },
  session_id: "demo-session-01",
});
show(`text task submit (HTTP ${text.status})`, text.body);
if (text.status === 202) await follow(text.body.task.task_id);

// A 0.1 s silent 8 kHz mono WAV: enough to exercise upload validation and the STT adapter.
const wav = Buffer.alloc(44 + 1600);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(1600, 40);
const form = new FormData();
form.set("agent_id", agent.agent_id);
form.set("session_id", "demo-session-01");
form.set("language", "en-IN");
form.set("audio", new Blob([wav], { type: "audio/wav" }), "demo.wav");
const voice = await call("POST", "/api/tasks/voice", form);
show(`voice task submit (HTTP ${voice.status})`, voice.body);
if (voice.status === 202) await follow(voice.body.task.task_id);
