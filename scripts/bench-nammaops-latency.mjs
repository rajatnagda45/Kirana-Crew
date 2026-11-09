#!/usr/bin/env node
/**
 * LIVE ERPNext latency benchmark (read-only). Runs the representative owner questions through the
 * same entry point the Gemini Live tool uses (runtime.nammaops.voice.query), over the real live
 * binding: workflows -> governance gateway -> adapter -> pinned hvgerp-mcp -> ERPNext Cloud.
 * In-memory database, stub seats; no app, no OpenClaw, no Gemini. The live binding has no write
 * capability, so nothing is written to ERPNext.
 *
 * Each round restarts the adapter (cold), asks every question once cold and WARM times warm.
 * Per run it records the workflow time, governed calls, hvgerp round trips, cache hits and a
 * completeness fingerprint (sha256 of the normalised result) that must not change between a
 * baseline and an optimised build.
 *
 *   node --env-file=.env.local scripts/bench-nammaops-latency.mjs <label> [YYYY-MM-DD today]
 *   env: ROUNDS (3), WARM (2), ONLY=stock,sales,...  BENCH_TTS=1 also times Gnani first chunk
 *
 * Writes artifacts/latency-<label>-<today>.json and .md
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { TaskDatabase } from "../lib/server/task-db.mjs";
import { AgentProfiles } from "../lib/server/agent-profiles.mjs";
import { AgentTasks } from "../lib/server/agent-tasks.mjs";
import { Specializations } from "../lib/server/developer-config.mjs";
import { McpServers } from "../lib/server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  WORKFLOW_PRINCIPALS,
} from "../lib/server/mcp-governance.mjs";
import { createNammaOps } from "../lib/server/nammaops/index.mjs";
import { loadBinding } from "../lib/server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../lib/server/nammaops/workforce.mjs";
import { gnaniTtsProvider } from "../lib/server/tts.mjs";

const LABEL = process.argv[2];
if (!LABEL || !/^[\w.-]{1,40}$/.test(LABEL)) throw new Error("Usage: <label> [YYYY-MM-DD]");
const TODAY = process.argv[3] ?? "2026-11-08";
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const WARM = Number(process.env.WARM ?? 2);
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
  .toISOString()
  .slice(0, 10);

/** The five representative questions, as Gemini Live would pass them to the tool. */
const QUESTIONS = [
  {
    id: "stock",
    label: "Simple stock check",
    args: { intent: "check_stock", products: ["milk", "rice"] },
  },
  { id: "sales", label: "Daily sales", args: { intent: "sales_summary", day: yesterday } },
  { id: "receivables", label: "Receivables", args: { intent: "receivables_report" } },
  { id: "forecast", label: "Demand forecast", args: { intent: "demand_forecast", products: [] } },
  { id: "health", label: "Store health report", args: { intent: "store_health_report" } },
].filter((q) => !only || only.has(q.id));

// ---- runtime: identical wiring to scripts/check-nammaops-live.mjs ----
const env = process.env;
const binding = loadBinding("config/nammaops/binding.hvgerp.json");
const workforce = loadWorkforce();
const db = new TaskDatabase(":memory:");
const servers = new McpServers(db, {
  env,
  policy: { stdio: [binding.server.connection], http: [], cwd: process.cwd() },
});
const owner = {
  gatewayId: "gw",
  gateway: { provider: "openclaw", status: "connected" },
  db,
  resolve: (seatId) => ({
    seat: { seatId, binding: { revision: 1 } },
    agentId: "backend",
    sessionKey: `agent:backend:${seatId}`,
  }),
  submit: () => {},
};
const runtime = {
  db,
  gateway: owner.gateway,
  seatOwner: () => owner,
  taskOwner: () => owner,
  estop: { status: () => ({ engaged: false }) },
  // One stub seat per specialist in config/nammaops/workforce.json (7 today).
  rosterSeats: () =>
    Array.from({ length: Math.max(5, workforce.agents?.length ?? 0) }, (_, i) => ({
      seatId: `s${i + 1}`,
      assigned: true,
      binding: { available: true },
    })),
};
runtime.profiles = new AgentProfiles(runtime);
runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
runtime.mcpServers = servers;
runtime.capabilities = new CapabilityRegistry(db, servers);
runtime.governance = new Governance(db, runtime.capabilities, {
  identity: (agentId) => {
    if (WORKFLOW_PRINCIPALS.has(agentId)) return { agentId, specializationId: null };
    const profile = runtime.profiles.get(agentId);
    return profile ? { agentId, specializationId: profile.specialization_id ?? null } : null;
  },
});
runtime.mcpGateway = new ToolGateway({
  db,
  servers,
  registry: runtime.capabilities,
  governance: runtime.governance,
});
runtime.nammaops = createNammaOps(
  runtime,
  { NAMMAOPS_OWNER_PIN: "0000", NAMMAOPS_REASONING: "off" },
  { binding, workforce, today: () => TODAY },
);

// ---- helpers ----
const VOLATILE = /(^id$|_id$|_ids$|_at$|^at$|retrieved|generated|timing|revision|timeline)/;
/** Drop ids, timestamps and timing so two runs over the same data compare equal. */
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !VOLATILE.test(key))
      .sort()
      .map((key) => [key, normalise(value[key])]),
  );
}
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const pct = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};
const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

let action = 0;
async function ask(question, phase, round) {
  const call = { id: `bench_${LABEL}_${round}`, name: "Alice" };
  const started = performance.now();
  let response;
  let error = null;
  try {
    // Wait for the full workflow; whether it would exceed the 20 s voice wait is reported separately.
    response = await runtime.nammaops.voice.query({
      call,
      actionId: `a${++action}`,
      args: question.args,
      waitMs: 300_000,
    });
  } catch (caught) {
    error = String(caught?.message ?? caught).slice(0, 200);
  }
  const ms = Math.round(performance.now() - started);
  const workflowId = response?.workflow_id ?? null;
  const view = workflowId ? runtime.nammaops.workflows.view(workflowId) : null;
  const invocations = workflowId
    ? runtime.mcpGateway.invocations().filter((row) => row.correlation_id === workflowId)
    : [];
  const adapter = invocations.map((row) => row.timing?.adapter ?? {});
  return {
    question: question.id,
    phase,
    round,
    ms,
    status: response?.status ?? "error",
    workflow_status: view?.status ?? null,
    error: error ?? view?.error ?? null,
    over_voice_wait: ms > 20_000,
    // Optional specialist steps that did not complete (the reason a workflow is "partial").
    incomplete_steps: (view?.tasks ?? [])
      .filter((task) => task.status !== "completed")
      .map((task) => `${task.role}:${task.status}:${String(task.error ?? "").slice(0, 100)}`),
    governed_calls: invocations.length,
    failed_calls: invocations.filter((row) => row.status !== "completed").length,
    hv_calls: sum(adapter, (a) => a.hv_calls),
    cache_hits: sum(adapter, (a) => a.cache_hits),
    cache_misses: sum(adapter, (a) => a.cache_misses),
    splits: sum(adapter, (a) => a.splits),
    slowest_call_ms: Math.max(0, ...invocations.map((row) => row.timing?.duration_ms ?? 0)),
    fingerprint: view
      ? sha({ status: view.status, result: normalise(view.result), facts: response?.facts ?? [] })
      : null,
  };
}

async function benchTts() {
  if (!env.GNANI_API_KEY) return { skipped: "GNANI_API_KEY not set" };
  const sentences = [
    "Your milk stock is low.",
    "Yesterday's sales were twelve thousand rupees.",
    "Three customers owe you money.",
    "Order more rice this week.",
    "The store looks healthy today.",
  ];
  const out = {};
  for (const transport of ["sse", "ws"]) {
    const tts = gnaniTtsProvider({
      apiKey: env.GNANI_API_KEY,
      model: env.GNANI_TTS_MODEL || undefined,
      voice: env.GNANI_TTS_VOICE || undefined,
      transport,
    });
    const samples = [];
    for (const text of sentences) {
      const started = performance.now();
      let first = null;
      let used = null;
      try {
        for await (const _chunk of tts.stream({ text, onTransport: (t) => (used = t) })) {
          first ??= Math.round(performance.now() - started);
        }
        samples.push({
          first_chunk_ms: first,
          total_ms: Math.round(performance.now() - started),
          used,
        });
      } catch (caught) {
        samples.push({ error: String(caught?.message ?? caught).slice(0, 120) });
      }
    }
    const firsts = samples.map((s) => s.first_chunk_ms).filter(Number.isFinite);
    out[transport] = { p50: pct(firsts, 0.5), p95: pct(firsts, 0.95), samples };
  }
  return out;
}

// ---- run ----
const runs = [];
const t0 = Date.now();
try {
  const setup = await runtime.nammaops.setup({});
  if (setup.blockers.length) throw new Error(`setup blockers: ${JSON.stringify(setup.blockers)}`);
  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const question of QUESTIONS) {
      await servers.close(); // fresh adapter child: empty caches
      runs.push(await ask(question, "cold", round));
      console.log(JSON.stringify(runs.at(-1)));
      for (let w = 0; w < WARM; w += 1) {
        runs.push(await ask(question, "warm", round));
        console.log(JSON.stringify(runs.at(-1)));
      }
    }
  }
  const tts = env.BENCH_TTS === "1" ? await benchTts() : { skipped: "set BENCH_TTS=1" };

  const summary = QUESTIONS.map((question) => {
    const row = { question: question.id, label: question.label };
    for (const phase of ["cold", "warm"]) {
      const these = runs.filter((r) => r.question === question.id && r.phase === phase);
      const ms = these.map((r) => r.ms);
      const lookups = sum(these, (r) => r.cache_hits) + sum(these, (r) => r.cache_misses);
      row[phase] = {
        n: these.length,
        p50_ms: pct(ms, 0.5),
        p95_ms: pct(ms, 0.95),
        governed_calls: pct(
          these.map((r) => r.governed_calls),
          0.5,
        ),
        hv_calls: pct(
          these.map((r) => r.hv_calls),
          0.5,
        ),
        cache_hit_rate: lookups
          ? Math.round((sum(these, (r) => r.cache_hits) / lookups) * 100) / 100
          : null,
        over_voice_wait: these.filter((r) => r.over_voice_wait).length,
        failures: these.filter(
          (r) => r.error || r.failed_calls || !["completed", "partial"].includes(r.workflow_status),
        ).length,
        partial: these.filter((r) => r.workflow_status === "partial").length,
      };
    }
    const prints = [
      ...new Set(runs.filter((r) => r.question === question.id).map((r) => r.fingerprint)),
    ];
    row.fingerprints = prints;
    return row;
  });

  const report = {
    label: LABEL,
    today: TODAY,
    rounds: ROUNDS,
    warm: WARM,
    at: new Date().toISOString(),
    summary,
    tts,
    runs,
  };
  mkdirSync("artifacts", { recursive: true });
  const base = `artifacts/latency-${LABEL}-${TODAY}`;
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  const md = [
    `# Latency ${LABEL} (today=${TODAY}, rounds=${ROUNDS}, warm=${WARM})`,
    "",
    "| Question | Cold p50 / p95 ms | Warm p50 / p95 ms | Governed calls | hvgerp calls cold / warm | Warm cache hit | >20 s | Failures | Partial | Fingerprint |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary.map(
      (r) =>
        `| ${r.label} | ${r.cold.p50_ms} / ${r.cold.p95_ms} | ${r.warm.p50_ms} / ${r.warm.p95_ms} | ${r.cold.governed_calls} | ${r.cold.hv_calls} / ${r.warm.hv_calls} | ${r.warm.cache_hit_rate ?? "-"} | ${r.cold.over_voice_wait + r.warm.over_voice_wait} | ${r.cold.failures + r.warm.failures} | ${r.cold.partial + r.warm.partial} | ${r.fingerprints.join(", ")} |`,
    ),
    "",
    tts.skipped
      ? `TTS: ${tts.skipped}`
      : `TTS first chunk p50/p95 ms — SSE ${tts.sse.p50}/${tts.sse.p95}, WS ${tts.ws.p50}/${tts.ws.p95}`,
  ].join("\n");
  writeFileSync(`${base}.md`, md);
  console.log(`\n${md}\n\nwrote ${base}.json (${Math.round((Date.now() - t0) / 1000)} s)`);
} catch (error) {
  console.error(`FAIL ${String(error?.stack ?? error).slice(0, 500)}`);
  process.exitCode = 1;
} finally {
  await servers.close();
  db.close();
}
