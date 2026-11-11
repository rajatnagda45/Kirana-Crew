/**
 * Alice's workflow memory: a durable record of every fully completed coordinated report, searchable
 * later for quick recall. It is a convenience for speed, never a source of truth:
 *  - a recalled report always carries its own completion time and is labelled as earlier;
 *  - a question about a live value (stock, today's sales, udhaar) is recalled AND re-checked live;
 *  - only fully completed reports are kept (a failed or partial run is never indexed as a report);
 *  - the stored text is the compact digest the specialists already published, scrubbed of anything
 *    PIN- or secret-shaped, never raw ERP rows.
 * Semantic search is used only when a verified embedder exists and the stored report has a vector;
 * otherwise recall is a keyword match and says so.
 */
import { cosine } from "../embeddings.mjs";

export const MEMORY_NAMESPACE = "nammaops.workflow_memory";
const SEMANTIC_MIN = 0.75;
const LEXICAL_MIN = 0.2;
const MAX_SUMMARY = 1500;

/** Anything shaped like a credential or approval code is removed before storing. */
const scrub = (text) =>
  String(text ?? "")
    // a code said before the word ("4826 is my PIN") and anything after it ("PIN 4826")
    .replace(/\b\d{4,8}\b(?=[^.\n]{0,24}\b(?:pin|passcode|password|otp)\b)/gi, "[removed]")
    .replace(/\b(pin|passcode|password|otp|api[_ -]?key|secret|token)\b[^.\n]*/gi, "[removed]");

const words = (text) =>
  new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );

const embedderOf = (runtime) => {
  const embedder = runtime.memory?.embedder;
  return embedder?.verified && typeof embedder.embed === "function" ? embedder : null;
};

/**
 * Store a completed coordination. Exactly once per coordination (a fixed id, so a retry or a
 * recovery cannot add a second copy). Returns the stored record, or null when nothing is stored.
 * @param {any} runtime @param {any} coordination @param {Array<{ sub: any, status: string, record?: any }>} states
 */
export async function remember(runtime, coordination, states) {
  const db = runtime.db;
  if (!coordination || !states.length || states.some((row) => row.status !== "completed"))
    return null;
  const id = `mem_${coordination.coordination_id}`;
  if (db.record(MEMORY_NAMESPACE, id)) return db.record(MEMORY_NAMESPACE, id);
  const lines = [];
  for (const row of states) {
    const summary = row.record?.result_reference?.summary ?? row.sub.summary ?? [];
    lines.push(`${row.sub.name} (${row.sub.title}): ${summary.slice(0, 6).join(" ")}`);
  }
  const summary = scrub(lines.join("\n")).slice(0, MAX_SUMMARY);
  const embedder = embedderOf(runtime);
  let embedding = null;
  if (embedder) embedding = await embedder.embed(summary).catch(() => null);
  const intents = [...new Set(states.map((row) => row.sub.intent))].sort();
  const value = {
    memory_id: id,
    version: 1,
    coordination_id: coordination.coordination_id,
    type: intents.join("+"),
    intents,
    original_request: scrub(coordination.original_request),
    participants: states.map((row) => ({ name: row.sub.name, department: row.sub.department })),
    tasks: states.map((row) => ({
      intent: row.sub.intent,
      status: row.status,
      workflow_id: row.record?.workflow_id ?? row.sub.workflow_id ?? null,
      delegation_id: row.sub.delegation_id ?? null,
    })),
    completed_at: coordination.completed_at ?? new Date().toISOString(),
    summary,
    // Evidence stays traceable: the governed invocation ids behind every fact.
    evidence_invocation_ids: states.flatMap(
      (row) => row.record?.result_reference?.invocation_ids ?? [],
    ),
    limitations: [
      ...new Set(states.flatMap((row) => row.record?.result_reference?.limitations ?? [])),
    ].slice(0, 8),
    source_label: states.find((row) => row.record?.result_reference?.source_label)?.record
      .result_reference.source_label,
    report_ref: {
      session_key: coordination.source_conversation_id,
      message_id: `dm_synthesis_${coordination.task_id}`,
    },
    index_mode: embedding ? "semantic" : "keyword",
    embedding: embedding ?? null,
    embedding_model: embedding ? embedder.model : null,
  };
  return db.saveRecord(MEMORY_NAMESPACE, id, value, 0);
}

/**
 * Find stored reports that match a question. `intents` (optional) narrows to reports that covered
 * those subjects. Every hit carries its completion time and how it was matched.
 * @param {any} runtime @param {string} query
 * @param {{ intents?: string[], limit?: number }} [options]
 * @returns {Promise<{ mode: "semantic" | "keyword", hits: Array<{ memory: any, score: number }> }>}
 */
export async function recall(runtime, query, { intents = [], limit = 3 } = {}) {
  const db = runtime.db;
  const stored = db
    .records(MEMORY_NAMESPACE)
    .filter((row) => !intents.length || intents.some((intent) => row.intents.includes(intent)));
  if (!stored.length) return { mode: "keyword", hits: [] };

  const embedder = embedderOf(runtime);
  const vectors = stored.filter((row) => row.embedding && row.embedding_model === embedder?.model);
  if (embedder && vectors.length) {
    const queryEmbedding = await embedder.embed(String(query)).catch(() => null);
    if (queryEmbedding) {
      const hits = vectors
        .map((memory) => ({ memory, score: cosine(queryEmbedding, memory.embedding) }))
        .filter((hit) => hit.score >= SEMANTIC_MIN)
        .sort(
          (a, b) => b.score - a.score || b.memory.completed_at.localeCompare(a.memory.completed_at),
        )
        .slice(0, limit);
      if (hits.length) return { mode: "semantic", hits };
    }
  }
  const wanted = words(query);
  const hits = stored
    .map((memory) => {
      const have = words(
        `${memory.original_request} ${memory.summary} ${memory.intents.join(" ")}`,
      );
      const overlap = [...wanted].filter((word) => have.has(word)).length;
      const intentBoost =
        intents.length && intents.every((i) => memory.intents.includes(i)) ? 0.3 : 0;
      return { memory, score: (wanted.size ? overlap / wanted.size : 0) + intentBoost };
    })
    .filter((hit) => hit.score >= LEXICAL_MIN)
    .sort((a, b) => b.score - a.score || b.memory.completed_at.localeCompare(a.memory.completed_at))
    .slice(0, limit);
  return { mode: "keyword", hits };
}

/** A question about the past ("what did the last stock report say"), as opposed to a live value. */
export function isHistoricalQuestion(message) {
  const text = String(message ?? "");
  const past =
    /\b(last|previous|earlier|latest|past|before)\b[^.?!]*\b(report|summary|check|workflow|update)\b/i.test(
      text,
    ) || /\bwhat did\b[^.?!]*\b(report|summary|say|show|find)\b/i.test(text);
  const live = /\b(right now|currently|current|today|now|at the moment)\b/i.test(text);
  return past && !live;
}

/** The sentence that presents a recalled report: its own time, and that it is not re-verified. */
export function recallText(hit, mode) {
  const when = new Date(hit.memory.completed_at).toISOString().replace("T", " ").slice(0, 16);
  const matched = mode === "semantic" ? " (matched by meaning)" : "";
  return `From the report completed at ${when} UTC${matched}: ${hit.memory.summary.split("\n").slice(0, 3).join(" ")} This is from earlier and is not re-verified.`;
}
