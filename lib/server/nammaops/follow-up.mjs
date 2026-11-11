/**
 * "What happened to the previous stock check? Show me the result again." / "What were the top
 * products in the previous forecast?" A follow-up shows the SAVED result of an earlier run in this
 * same chat. It never starts a workflow and never guesses which run: it looks only at the runs
 * recorded in this conversation (a run it executed itself, or one it handed to another specialist),
 * picks the one the question is about by subject and intent, and reads that workflow through the
 * call that started it.
 */
import { DELEGATION_NAMESPACE } from "./delegation.mjs";
import { COORDINATION_NAMESPACE } from "./coordination.mjs";
import { evidenceLines, formatBusinessReply } from "./group-business.mjs";
import { describeInstruction } from "./intent-llm.mjs";
import { VOICE_CONSULT_NAMESPACE } from "./voice-router.mjs";

/** Wording of a real follow-up: an EARLIER request or its result is being asked about. */
const FOLLOW_UP = [
  /\b(?:previous|earlier|prior|last|above|that)\s+(?:one\s+)?(?:forecast|stock\s*check|stock\s+report|inventory\s+check|report|result|run|check|answer|comparison|summary)\b/i,
  /\bwhat\s+happened\s+to\b/i,
  /\b(?:show|give|send|read)\s+(?:me\s+)?(?:the\s+)?(?:result|results|report|answer)s?\s+again\b/i,
  /\bwhat\s+(?:was|were)\b[^.?!]{0,60}\b(?:previous|earlier|last)\b/i,
];

/** The subject of a question, by its department nouns; the first match wins. */
const SUBJECTS = [
  [/\b(?:forecast|prediction|projected|demand)\b/i, "demand_forecast"],
  [/\b(?:stock|inventory|reorder|restock\w*|low[\s-]?stock)\b/i, "check_stock"],
  [/\b(?:supplier|quotation|quote)s?\b/i, "supplier_comparison"],
  [/\b(?:udhaar|udhar|receivables?)\b/i, "receivables_report"],
  [/\b(?:sales|sold|revenue|takings)\b/i, "sales_summary"],
  [/\bprocurement\b/i, "procurement_overview"],
];

/** A weak cue that a message refers back to something: enough to trust the model's follow-up flag. */
const FOLLOW_CUE =
  /\b(?:previous|earlier|prior|last|that|which was|was running|still running|again|ready|results?|happened|same)\b/i;

/**
 * Should the language model's follow-up flag be believed? Only when the words refer back to
 * something AND this chat has an earlier run to refer to. Otherwise the message is a new request
 * (a model that flags "forecast demand for the next seven days" as a follow-up is simply wrong).
 */
export function modelFollowUpApplies(db, sessionKey, message) {
  return FOLLOW_CUE.test(String(message ?? "")) && earlierRuns(db, sessionKey).length > 0;
}

/**
 * Is this question about an earlier run, and which kind of run (null when it names no subject)?
 * @returns {{ isFollowUp: boolean, intent: string | null }}
 */
export function followUpSubject(text) {
  const value = String(text ?? "");
  const isFollowUp = FOLLOW_UP.some((re) => re.test(value));
  const intent = isFollowUp ? (SUBJECTS.find(([re]) => re.test(value))?.[1] ?? null) : null;
  return { isFollowUp, intent };
}

/**
 * The runs recorded in this conversation, oldest first, one per workflow or delegation: a workflow
 * this chat's seat ran, a task it handed to another specialist, or the parts of a coordination.
 * Messages that merely re-showed an earlier result are not runs of their own.
 */
export function earlierRuns(db, sessionKey) {
  const runs = new Map();
  const note = (key, run) => {
    runs.delete(key); // a later message about the same run moves it to the end
    runs.set(key, run);
  };
  for (const message of db.messages(sessionKey)) {
    if (message.role !== "assistant" || message.recalled) continue;
    if (message.delegationId && message.delegationKind !== "task")
      note(`delegation:${message.delegationId}`, { delegationId: message.delegationId });
    else if (message.coordinationId) {
      const co = db.record(COORDINATION_NAMESPACE, message.coordinationId);
      for (const sub of co?.subtasks ?? [])
        if (sub.delegation_id)
          note(`delegation:${sub.delegation_id}`, { delegationId: sub.delegation_id });
    } else if (message.workflowId && message.intent)
      note(`workflow:${message.workflowId}`, { workflowId: message.workflowId });
  }
  return [...runs.values()];
}

/**
 * How to read a run's saved result: the workflow, the call that started it, and who ran it. Null
 * when the record behind it is gone (it is never rebuilt from the newest workflow).
 */
function resolveRun(db, run) {
  if (run.delegationId) {
    const rec = db.record(DELEGATION_NAMESPACE, run.delegationId);
    if (!rec) return null;
    return {
      intent: rec.intent,
      workflowId: rec.workflow_id ?? null,
      call: { id: rec.delegation_id, name: rec.target.name },
      who: rec.target.name,
      at: rec.completed_at ?? rec.created_at,
      status: rec.status,
      delegation: rec,
    };
  }
  const consult = db.records(VOICE_CONSULT_NAMESPACE).find((r) => r.workflow_id === run.workflowId);
  if (!consult) return null;
  return {
    intent: consult.intent,
    workflowId: consult.workflow_id,
    call: { id: consult.call_id, name: consult.voice_agent },
    who: consult.voice_agent,
    at: consult.finished_at ?? consult.at,
    status: consult.status,
    delegation: null,
  };
}

const stamp = (iso) =>
  iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) : "an unrecorded time";

/**
 * Pick the earlier run the question is about. `subject` (from the owner's words) must match exactly;
 * `hint` (the model's reading) is only used when the words name no subject, and falls back to the
 * newest run in this chat.
 */
export function pickRun(db, sessionKey, { subject, hint }) {
  const resolved = earlierRuns(db, sessionKey)
    .map((run) => resolveRun(db, run))
    .filter(Boolean);
  if (subject) return resolved.filter((run) => run.intent === subject).at(-1) ?? null;
  return (
    (hint ? resolved.filter((run) => run.intent === hint).at(-1) : null) ?? resolved.at(-1) ?? null
  );
}

/**
 * Answer a follow-up: re-read the chosen run's saved result and say plainly that it is earlier
 * output. Nothing is run. Returns `{ content, workflowId, intent, extra }` for the caller to save.
 * @param {any} runtime
 * @param {{ sessionKey: string, message: string, subject: string | null, hint: string | null,
 *   language: string }} c
 */
export async function answerFollowUp(runtime, c) {
  const db = runtime.db;
  const run = pickRun(db, c.sessionKey, { subject: c.subject, hint: c.hint });
  const wanted = c.subject ? describeInstruction({ intent: c.subject }).toLowerCase() : "run";
  if (!run)
    return {
      content: `I could not find an earlier ${wanted} in this chat, so I have not shown one and I did not start a new one. Ask me to run it and I will.`,
      workflowId: null,
      intent: c.subject ?? null,
      extra: {},
    };
  const label = describeInstruction({ intent: run.intent }).toLowerCase();
  if (!run.workflowId)
    return {
      content: `The earlier ${label} handed to ${run.who} has not produced a result yet (status: ${String(run.status).replace(/_/g, " ")}). I did not start a new one.`,
      workflowId: null,
      intent: run.intent,
      extra: {},
    };
  let response;
  try {
    response = await runtime.nammaops.voice.query({
      call: run.call,
      actionId: `follow-${Date.now().toString(36)}`,
      args: { intent: run.intent, workflow_id: run.workflowId },
    });
  } catch {
    return {
      content: `I could not read the saved result of the earlier ${label} any more, so I have not shown one. I did not start a new one; ask me to run it again if you want a fresh result.`,
      workflowId: run.workflowId,
      intent: run.intent,
      extra: {},
    };
  }
  const who = run.delegation ? ` (done by ${run.who})` : "";
  const state =
    response.status === "running"
      ? "It is still running; this is its status so far."
      : `Completed ${stamp(run.at)} UTC. This is the saved result, not a fresh run.`;
  const evidence = evidenceLines(response);
  const link = run.delegation ? ` The full report is in ${run.who}'s chat.` : "";
  const content = [
    `Earlier ${label}${who}. ${state}${link}`,
    "",
    formatBusinessReply(response, { language: c.language }),
    ...(evidence.length ? ["", `Evidence: ${evidence.join("; ")}`] : []),
  ].join("\n");
  const rec = run.delegation;
  return {
    content,
    workflowId: run.workflowId,
    intent: run.intent,
    extra: rec
      ? {
          delegationId: rec.delegation_id,
          linkSeatId: rec.target.seat_id,
          linkSessionKey: rec.target_conversation_id,
          linkName: rec.target.name,
          linkMessageId: rec.result_reference?.message_id,
        }
      : {},
  };
}
