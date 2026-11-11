/**
 * Alice's workflow memory: durable, domain-scoped records of completed specialist reports, searchable
 * later for quick recall. It is a convenience for speed, never a source of truth:
 *  - one record per COMPLETED task (never one blob per coordination), scoped by intent, products and
 *    period, so an inventory question can only ever recall an inventory report;
 *  - a recalled report always carries its own completion time and is labelled as earlier; a question
 *    about a live value (stock, today's sales, udhaar) is recalled AND re-checked live, and the old and
 *    new values are compared side by side;
 *  - a failed or partial task is never indexed as a report;
 *  - the stored text is the compact digest the specialists already published, scrubbed of anything
 *    PIN- or secret-shaped, never raw ERP rows.
 * Semantic ranking is used only when a verified embedder exists and the stored report has a vector;
 * otherwise recall is by scope and recency, and says so.
 */
import { cosine } from "../embeddings.mjs";

export const MEMORY_NAMESPACE = "nammaops.workflow_memory";
const SEMANTIC_MIN = 0.75;
const LEXICAL_MIN = 0.2;
const MAX_SUMMARY = 3000;
const MAX_SUMMARY_LINES = 16;

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

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const norm = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase();

/**
 * A small structured digest of a workflow result, so an earlier report and a fresh one can be
 * compared by value. Only report types with a meaningful comparison have one.
 * @returns {any | null}
 */
export function digestOf(intent, result) {
  if (!result || typeof result !== "object") return null;
  if (intent === "check_stock" && Array.isArray(result.rows))
    return {
      checked: result.rows.length,
      low: (result.low ?? []).map((row) => ({
        item: row.item_name,
        available: row.available,
        reorder_level: row.reorder_level,
        recommended_qty: row.recommended_qty,
      })),
    };
  if (intent === "sales_summary" && result.total_sales !== undefined)
    return { total_sales: result.total_sales, bills: result.transaction_count ?? null };
  if (intent === "receivables_report" && result.total_outstanding !== undefined)
    return {
      total_outstanding: result.total_outstanding,
      overdue_30: result.overdue_over_30_days?.amount ?? null,
    };
  return null;
}

/**
 * Old against new, in plain lines. Null when this report type has no structured comparison (the
 * caller then says so instead of implying one).
 * @returns {string[] | null}
 */
export function compareDigests(intent, before, after) {
  if (!before || !after) return null;
  if (intent === "check_stock") {
    const was = new Map(before.low.map((row) => [norm(row.item), row]));
    const now = new Map(after.low.map((row) => [norm(row.item), row]));
    const lines = [];
    for (const [key, row] of now) {
      const old = was.get(key);
      if (!old)
        lines.push(
          `Newly low: ${row.item} (${row.available} in stock, reorder level ${row.reorder_level}, recommended ${row.recommended_qty}).`,
        );
      else if (old.available !== row.available || old.recommended_qty !== row.recommended_qty)
        lines.push(
          `${row.item}: stock ${old.available} -> ${row.available}, recommended ${old.recommended_qty} -> ${row.recommended_qty}.`,
        );
    }
    for (const [key, row] of was)
      if (!now.has(key)) lines.push(`No longer low: ${row.item} (was ${row.available} in stock).`);
    return lines.length
      ? lines
      : [`No change: the same ${after.low.length} product(s) are low, with the same quantities.`];
  }
  if (intent === "sales_summary")
    return [
      `Sales: ${inr(before.total_sales)} -> ${inr(after.total_sales)}${before.bills !== null && after.bills !== null ? ` (bills ${before.bills} -> ${after.bills})` : ""}. The earlier report may cover a different period.`,
    ];
  if (intent === "receivables_report")
    return [
      `Udhaar outstanding: ${inr(before.total_outstanding)} -> ${inr(after.total_outstanding)}${before.overdue_30 !== null && after.overdue_30 !== null ? `; over 30 days ${inr(before.overdue_30)} -> ${inr(after.overdue_30)}` : ""}.`,
    ];
  return null;
}

/**
 * Store every COMPLETED task of a coordination as its own scoped record, exactly once each (a fixed
 * id, so a retry or a recovery cannot add a second copy). A failed or partial task is skipped.
 * @param {any} runtime @param {any} coordination @param {Array<{ sub: any, status: string, record?: any }>} states
 * @returns {Promise<any[]>} the records stored by this call
 */
export async function remember(runtime, coordination, states) {
  const db = runtime.db;
  const stored = [];
  if (!coordination) return stored;
  const embedder = embedderOf(runtime);
  for (const row of states) {
    if (row.status !== "completed") continue;
    const { sub, record } = row;
    const id = `mem_${coordination.coordination_id}_${sub.intent}`;
    if (db.record(MEMORY_NAMESPACE, id)) continue;
    const lines = (record?.result_reference?.summary ?? sub.summary ?? []).slice(
      0,
      MAX_SUMMARY_LINES,
    );
    const summary = scrub(lines.join("\n")).slice(0, MAX_SUMMARY);
    if (!summary.trim()) continue; // nothing to recall
    const workflowId = record?.workflow_id ?? sub.workflow_id ?? null;
    let view = null;
    try {
      view = workflowId ? runtime.nammaops?.workflows?.view(workflowId) : null;
    } catch {
      view = null;
    }
    let embedding = null;
    if (embedder) embedding = await embedder.embed(summary).catch(() => null);
    const value = {
      memory_id: id,
      version: 1,
      coordination_id: coordination.coordination_id,
      intent: sub.intent,
      intents: [sub.intent],
      department: sub.department,
      participants: [{ name: sub.name, department: sub.department }],
      products: sub.args?.products ?? [],
      period: view?.result?.period
        ? { from: view.result.period.from_date ?? null, to: view.result.period.to_date ?? null }
        : null,
      original_request: scrub(sub.clause ?? coordination.original_request),
      completed_at: record?.completed_at ?? coordination.completed_at ?? new Date().toISOString(),
      summary,
      data: digestOf(sub.intent, view?.result),
      workflow_id: workflowId,
      evidence_invocation_ids: record?.result_reference?.invocation_ids ?? [],
      limitations: (record?.result_reference?.limitations ?? []).slice(0, 8),
      source_label: record?.result_reference?.source_label ?? null,
      // The canonical report is the specialist's own message; the combined report is Alice's.
      report_ref: record?.result_reference
        ? {
            session_key: record.result_reference.session_key,
            message_id: record.result_reference.message_id,
          }
        : null,
      coordination_report: {
        session_key: coordination.source_conversation_id,
        message_id: `dm_synthesis_${coordination.task_id}`,
      },
      index_mode: embedding ? "semantic" : "keyword",
      embedding: embedding ?? null,
      embedding_model: embedding ? embedder.model : null,
    };
    stored.push(db.saveRecord(MEMORY_NAMESPACE, id, value, 0));
  }
  return stored;
}

/** A request with no product filter only matches reports with none; named products match overlap. */
function scopeMatches(recordProducts, wantedProducts) {
  const have = (recordProducts ?? []).map(norm);
  const want = (wantedProducts ?? []).map(norm).filter(Boolean);
  if (!want.length) return have.length === 0;
  if (!have.length) return true;
  return want.some((w) => have.some((h) => h.includes(w) || w.includes(h)));
}

/**
 * Find the stored report that answers a question, SCOPED to what was asked. With `intents`, only a
 * record whose own intents are all among them qualifies (an inventory question can never recall a
 * sales or finance report, nor an old combined one); the newest in scope wins, or the closest by
 * meaning when a verified embedder produced vectors. Without `intents`, a keyword match over all.
 * Every hit carries its completion time and how it was matched.
 * @param {any} runtime @param {string} query
 * @param {{ intents?: string[], products?: string[], limit?: number }} [options]
 * @returns {Promise<{ mode: "semantic" | "keyword", hits: Array<{ memory: any, score: number, how: "semantic" | "keyword" }> }>}
 */
export async function recall(runtime, query, { intents = [], products = [], limit = 3 } = {}) {
  const db = runtime.db;
  const wantedIntents = new Set(intents);
  let stored = db.records(MEMORY_NAMESPACE);
  if (wantedIntents.size)
    stored = stored
      .filter((row) => (row.intents ?? []).every((intent) => wantedIntents.has(intent)))
      .filter((row) => scopeMatches(row.products, products));
  if (!stored.length) return { mode: "keyword", hits: [] };
  const newest = (a, b) => String(b.completed_at).localeCompare(String(a.completed_at));

  const embedder = embedderOf(runtime);
  const vectors = stored.filter((row) => row.embedding && row.embedding_model === embedder?.model);
  if (embedder && vectors.length) {
    const queryEmbedding = await embedder.embed(String(query)).catch(() => null);
    if (queryEmbedding) {
      const ranked = vectors
        .map((memory) => ({ memory, score: cosine(queryEmbedding, memory.embedding) }))
        .filter((hit) => hit.score >= SEMANTIC_MIN)
        .sort((a, b) => b.score - a.score || newest(a.memory, b.memory))
        .slice(0, limit)
        .map((hit) => ({ ...hit, how: "semantic" }));
      if (ranked.length) return { mode: "semantic", hits: ranked };
    }
  }
  // Scoped by intent: the newest report in scope. Unscoped: keyword overlap with a floor.
  if (wantedIntents.size)
    return {
      mode: "keyword",
      hits: stored
        .sort(newest)
        .slice(0, limit)
        .map((memory) => ({ memory, score: 1, how: "keyword" })),
    };
  const wanted = words(query);
  const hits = stored
    .map((memory) => {
      const have = words(`${memory.original_request} ${memory.summary} ${memory.intent}`);
      const overlap = [...wanted].filter((word) => have.has(word)).length;
      return { memory, score: wanted.size ? overlap / wanted.size : 0, how: "keyword" };
    })
    .filter((hit) => hit.score >= LEXICAL_MIN)
    .sort((a, b) => b.score - a.score || newest(a.memory, b.memory))
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

const stamp = (iso) => new Date(iso).toISOString().replace("T", " ").slice(0, 16);

/**
 * How a recalled report is presented: its own completion time, its scope, and that it is not
 * re-verified. `full` (a historical answer) lists every stored line; otherwise a compact head
 * (a live question, which is re-checked right after).
 */
export function recallText(hit, { full = false } = {}) {
  const { memory } = hit;
  const who = memory.participants?.[0]?.name ?? "The specialist";
  const lines = String(memory.summary).split("\n");
  const shown = full ? lines : lines.slice(0, 3);
  const more =
    !full && lines.length > shown.length ? ` (+${lines.length - shown.length} more lines)` : "";
  const matched = hit.how === "semantic" ? ", matched by meaning" : "";
  const period = memory.period?.from
    ? `, covering ${memory.period.from}${memory.period.to && memory.period.to !== memory.period.from ? ` to ${memory.period.to}` : ""}`
    : "";
  return `${who}'s report completed at ${stamp(memory.completed_at)} UTC${period}${matched}:\n${shown.join("\n")}${more}`;
}

export const NOT_REVERIFIED = "This is from earlier and is not re-verified.";
