/**
 * One-to-one chat delegation: when an owner asks the wrong specialist, the asked seat passes the
 * request to the owning specialist as a real task in THAT specialist's own chat, the specialist
 * answers there, and the asked seat tells the owner where the answer is.
 *
 * Rules this module keeps:
 *  - The target is resolved from the server's specialist registry and verified seat binding, never
 *    from a name the owner or a model supplied. The work runs through the governed workflows as the
 *    owning specialist's own agent; the asked seat's grants are never used.
 *  - Every transition is saved (namespace `nammaops.dm_delegation`) so a restart can finish the
 *    work, and every effect (task message, acceptance, report, notice) has a fixed message id and
 *    a compare-and-set on the record, so a retry or a duplicate event does it once.
 *  - It writes only to individual chats. Office group chat does not use it.
 */
import { randomUUID } from "node:crypto";
import { OWNER, evidenceLines, formatBusinessReply, replySpeaker } from "./group-business.mjs";
import { describeInstruction } from "./intent-llm.mjs";
import { watchForResult } from "./late-result.mjs";
import { inAskedLanguage } from "./reply-language.mjs";

export const DELEGATION_NAMESPACE = "nammaops.dm_delegation";
const DM_WAIT_MS = 60_000;
/**
 * Called after a delegation settles (report and notice published). Coordination registers here, so
 * a restart-recovered sub-task still advances the coordinator's progress and final report.
 * @type {Set<(runtime: any, record: any) => Promise<void> | void>}
 */
export const settledHooks = new Set();
/** Terminal states: nothing more will run; the notice may still be pending. */
const FINAL = new Set(["completed", "failed", "needs_clarification"]);

const nowIso = () => new Date().toISOString();
const clip = (text, max) => {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/**
 * The specialist for a department, from the server registry (workforce voice departments plus the
 * profile bound to a seat) and the seat roster. Null when there is no assigned, available seat.
 */
export function resolveSpecialist(runtime, department) {
  const nammaops = runtime.nammaops;
  const row = (nammaops?.voice?.departments?.seats ?? []).find((d) => d.department === department);
  const profile = runtime.profiles
    ?.list()
    .find((p) => p.agent_id === `nammaops-${department}` && p.seat_id);
  if (!row || !profile) return null;
  const roster = runtime.rosterSeats?.() ?? runtime.db.seats();
  const seat = roster.find((s) => s.seatId === profile.seat_id);
  if (!seat?.assigned || seat.binding?.available === false) return null;
  return {
    department,
    seatId: profile.seat_id,
    specialistAgentId: profile.agent_id,
    chatAgentId: seat.binding?.agentId ?? String(profile.session_key ?? "").split(":")[1] ?? "main",
    voiceName: row.voice_name,
    title: row.title,
  };
}

/**
 * The conversation the owner sees when they open a seat's chat: the newest session tagged with the
 * seat (the same rule the UI uses). Created when the seat has none. This is deliberately not the
 * seat's `binding.sessionKey`, which the UI does not show and group chat relies on.
 */
export function seatChatSession(runtime, seatId, chatAgentId) {
  const owner = runtime.seatOwner?.(seatId);
  const db = owner?.db ?? runtime.db;
  const found = db
    .sessions()
    .find((s) => s.seatId === seatId && s.key.split(":")[1] === chatAgentId);
  if (found) return found.key;
  if (typeof owner?.newSession === "function") return owner.newSession(seatId).key;
  const record = {
    key: `agent:${chatAgentId}:${randomUUID()}`,
    seatId,
    agentId: chatAgentId,
    createdAt: nowIso(),
  };
  db.saveSession(record, chatAgentId);
  return record.key;
}

/** Save a message once: a fixed id means a retry, duplicate event or recovery never repeats it. */
function postOnce(db, message) {
  if (db.getMessage(message.id)) return false;
  db.saveMessage({ runId: "", timestamp: nowIso(), role: "assistant", ...message });
  return true;
}

/** Update the delegation record with compare-and-set, retrying a concurrent writer. */
function advance(db, id, patch, event) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = db.record(DELEGATION_NAMESPACE, id);
    if (!current) throw new Error(`Delegation ${id} not found.`);
    const value = { ...current };
    delete value.id;
    delete value.revision;
    const next = {
      ...value,
      ...patch,
      timeline: [...(value.timeline ?? []), ...(event ? [{ event, at: nowIso() }] : [])],
    };
    try {
      return db.saveRecord(DELEGATION_NAMESPACE, id, next, current.revision);
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  throw new Error(`Delegation ${id} changed too often to update.`);
}

const translate = (runtime, record, text) =>
  inAskedLanguage(runtime, record.original_request, text, { timeoutMs: 6500 }).then(
    (out) => out.text,
  );

const linkFields = (record, messageId) => ({
  delegationId: record.delegation_id,
  linkSeatId: record.target.seat_id,
  linkSessionKey: record.target_conversation_id,
  linkName: record.target.name,
  ...(messageId ? { linkMessageId: messageId } : {}),
});

/**
 * Pass `parsed` (a resolved, validated intent owned by another specialist) to its owner. Returns
 * the `answered` payload for the HTTP layer. The acknowledgment in the asked seat's chat is saved
 * first (it is also the retry guard), then the task is delivered, run and reported.
 * @param {any} runtime
 * @param {{ taskId: string, message: string, parsed: any, userMessageId: string,
 *   source: { seatId: string, role: string, name: string, title: string, sessionKey: string },
 *   deadline?: any, waitMs?: number }} c
 */
export async function delegateToOwner(runtime, c) {
  const db = runtime.db;
  const { parsed, source } = c;
  const replyId = `dm_reply_${c.taskId}`;
  const id = `dlg_${c.taskId}`;
  const intent = parsed.args.intent;
  const sourceMessage = (content, extra = {}) => ({
    id: replyId,
    sessionKey: source.sessionKey,
    seatId: source.seatId,
    actorName: source.name,
    content,
    workflowId: null,
    intent,
    ...extra,
  });
  // The owner comes from the server's own intent-to-department table, never from a department
  // name carried by the caller or a model, so the label cannot disagree with who actually runs it.
  const target = resolveSpecialist(runtime, OWNER[intent] ?? null);
  if (!target || target.seatId === source.seatId) {
    const who = target?.voiceName ?? "the specialist who handles this";
    if (c.coordinationId)
      return {
        answered: {
          workflowId: null,
          intent,
          delegated: false,
          failed: true,
          error: `${who} is not available right now.`,
        },
      };
    postOnce(
      db,
      sourceMessage(
        await inAskedLanguage(
          runtime,
          c.message,
          `${who} is not available right now, so I could not pass this on. Nothing was run. Please try again later.`,
          { timeoutMs: 6500 },
        ).then((out) => out.text),
      ),
    );
    return { answered: { workflowId: null, intent, delegated: false, failed: true } };
  }

  let targetSession = null;
  try {
    targetSession = seatChatSession(runtime, target.seatId, target.chatAgentId);
  } catch {
    // reported below: nothing runs without a conversation to deliver into
  }
  if (!targetSession || targetSession === source.sessionKey) {
    if (c.coordinationId)
      return {
        answered: {
          workflowId: null,
          intent,
          delegated: false,
          failed: true,
          error: `${target.voiceName}'s conversation could not be opened.`,
        },
      };
    postOnce(
      db,
      sourceMessage(
        `I could not open ${target.voiceName}'s conversation, so I could not pass this on. Nothing was run.`,
      ),
    );
    return { answered: { workflowId: null, intent, delegated: false, failed: true } };
  }

  const goal = parsed.instruction ?? describeInstruction(parsed.args);
  let grants = [];
  try {
    grants = runtime.nammaops.workforce()?.agents?.[target.department]?.business_capabilities ?? [];
  } catch {
    grants = [];
  }
  const created = {
    delegation_id: id,
    parent_task_id: c.taskId,
    parent_message_id: c.userMessageId,
    workflow_id: null,
    source: {
      seat_id: source.seatId,
      department: source.role,
      name: source.name,
      title: source.title,
    },
    target: {
      seat_id: target.seatId,
      department: target.department,
      agent_id: target.specialistAgentId,
      name: target.voiceName,
      title: target.title,
    },
    source_conversation_id: source.sessionKey,
    target_conversation_id: targetSession,
    coordination_id: c.coordinationId ?? null,
    original_request: clip(c.message, 600),
    normalized_goal: goal,
    handoff_reason: `${source.name} (${source.title}) was asked about this, and ${target.voiceName} (${target.title}) owns it.`,
    relevant_context:
      "Read-only: answer from your own records. Nothing is to be ordered, approved or changed.",
    required_capabilities: grants,
    intent,
    args: parsed.args,
    status: "queued",
    created_at: nowIso(),
    started_at: null,
    completed_at: null,
    result_reference: null,
    error: null,
    notified: false,
    timeline: [{ event: "task_delegated", at: nowIso() }],
  };
  let record = db.record(DELEGATION_NAMESPACE, id);
  if (!record) {
    try {
      record = db.saveRecord(DELEGATION_NAMESPACE, id, created, 0);
    } catch (error) {
      if (error.status !== 409) throw error;
      record = db.record(DELEGATION_NAMESPACE, id);
    }
  }

  // 1. The asked seat acknowledges in its own chat (this is also the retry guard). A coordinator
  //    (Alice) posts one combined acknowledgment instead.
  if (!c.coordinationId) {
    const ack = await translate(
      runtime,
      record,
      `This is a ${target.title.toLowerCase()} request, and ${target.voiceName} handles it. I have passed it to ${target.voiceName}: they will share the verified answer in their own chat, and I will tell you here when it is ready.`,
    );
    postOnce(db, sourceMessage(ack, linkFields(record), { delegationKind: "ack" }));
  }

  // 2. The task arrives in the owner's chat as a message from the asked seat, and they accept it.
  postOnce(db, {
    id: `dm_task_${c.taskId}`,
    sessionKey: targetSession,
    seatId: target.seatId,
    actorName: source.name,
    delegationId: id,
    delegationKind: "task",
    fromName: source.name,
    fromTitle: source.title,
    fromSeatId: source.seatId,
    fromSessionKey: source.sessionKey,
    content: await translate(
      runtime,
      record,
      `Hi ${target.voiceName}, the owner asked me: "${record.original_request}". That is ${target.title.toLowerCase()}, which is yours, so I am passing it to you.\n\nWhat is needed: ${goal}.\nConstraints: read-only. Use your own records; nothing is to be ordered, approved or changed.\n\nPlease post the verified answer here in your chat. I will let the owner know when it is ready.`,
    ),
  });
  postOnce(db, {
    id: `dm_accept_${c.taskId}`,
    sessionKey: targetSession,
    seatId: target.seatId,
    actorName: target.voiceName,
    delegationId: id,
    delegationKind: "accepted",
    content: await translate(
      runtime,
      record,
      `Got it, ${source.name}. I am checking the live records now and will post the verified answer here.`,
    ),
  });
  advance(db, id, { status: "running", started_at: nowIso() }, "task_started");

  return execute(runtime, id, {
    waitMs: c.waitMs ?? (c.deadline ? c.deadline.waitMs() : DM_WAIT_MS),
  });
}

/**
 * Run (or rejoin) the governed workflow for a delegation as the OWNING specialist. The consult
 * key [delegation id, "dlg"] means a retry or a recovery returns the same workflow, never a second.
 */
async function execute(runtime, id, { waitMs } = {}) {
  const db = runtime.db;
  const voice = runtime.nammaops.voice;
  let record = db.record(DELEGATION_NAMESPACE, id);
  if (FINAL.has(record.status) && record.notified) return { answered: answeredOf(record) };
  // The caller's identity is the owning specialist's seat name from the server registry.
  const call = { id, name: record.target.voice_name ?? record.target.name };
  let response;
  try {
    response = await voice.query({
      call,
      actionId: "dlg",
      args: record.args,
      message: record.original_request,
      ...(waitMs ? { waitMs } : {}),
    });
  } catch (error) {
    await finish(runtime, id, null, error.message);
    record = db.record(DELEGATION_NAMESPACE, id);
    return { answered: answeredOf(record) };
  }
  if (response.workflow_id && record.workflow_id !== response.workflow_id)
    advance(db, id, { workflow_id: response.workflow_id });
  if (response.status === "running" && response.workflow_id) {
    // Slow work: the watcher is only an accelerator; recovery finishes it after a restart.
    void watchForResult({
      voice,
      call,
      intent: record.intent,
      workflowId: response.workflow_id,
      post: (finished) => finish(runtime, id, finished),
      pollMs: runtime.nammaops.delegationPollMs,
    });
    return { answered: answeredOf(db.record(DELEGATION_NAMESPACE, id)) };
  }
  await finish(runtime, id, response);
  return { answered: answeredOf(db.record(DELEGATION_NAMESPACE, id)) };
}

const answeredOf = (record) => ({
  workflowId: record.workflow_id ?? null,
  intent: record.intent,
  delegated: true,
  delegationId: record.delegation_id,
  status: record.status,
});

/**
 * Publish a delegation's result exactly once: the report in the owner's chat, then the short
 * notice (with a link) in the asked seat's chat. Safe to call again for the same delegation.
 */
export async function finish(runtime, id, response, failure = null) {
  const db = runtime.db;
  const record = db.record(DELEGATION_NAMESPACE, id);
  if (!record || (FINAL.has(record.status) && record.notified)) return record;
  const lang = record.original_request;
  const target = record.target;
  const source = record.source;
  const reportId = `dm_report_${record.parent_task_id}`;
  const doneId = `dm_done_${record.parent_task_id}`;

  let status;
  let reportText;
  let reason = failure;
  if (response) {
    if (response.status === "clarification_required") status = "needs_clarification";
    else if (response.status === "unavailable" || response.status === "blocked") {
      status = "failed";
      reason ??=
        response.limitations?.find((row) => !/^Data source:/.test(row)) ??
        "it could not be completed";
    } else status = "completed";
    reportText = formatBusinessReply(response, { language: "en" });
  } else {
    status = "failed";
    reportText = `I could not complete this: ${failure ?? "it failed"}.`;
  }

  const speaker = response ? replySpeaker(response.routing, target.name) : { name: target.name };
  const reportName = speaker.coordinating ? `${speaker.name} (coordinating)` : speaker.name;
  const report = await inAskedLanguage(runtime, lang, reportText, { timeoutMs: 6500 }).then(
    (out) => out.text,
  );
  postOnce(db, {
    id: reportId,
    sessionKey: record.target_conversation_id,
    seatId: target.seat_id,
    actorName: reportName,
    delegationId: id,
    delegationKind: status === "failed" ? "failed" : "report",
    content: report,
    workflowId: response?.workflow_id ?? record.workflow_id ?? null,
    intent: record.intent,
    workflowStatus: response?.status ?? null,
  });

  const notice =
    status === "completed"
      ? `${target.name} has finished: ${record.normalized_goal}. The full answer is in ${target.name}'s chat.`
      : status === "needs_clarification"
        ? `${target.name} needs one more detail before continuing. Please answer in ${target.name}'s chat.`
        : `${target.name} could not complete this (${clip(reason, 160)}). Nothing was run under anyone else's access.`;
  const noticeText = await inAskedLanguage(runtime, lang, notice, { timeoutMs: 6500 }).then(
    (out) => out.text,
  );
  // A coordinator's sub-task has no notice of its own: the coordinator reports progress and one
  // combined report instead.
  if (!record.coordination_id)
    postOnce(db, {
      id: doneId,
      sessionKey: record.source_conversation_id,
      seatId: source.seat_id,
      actorName: source.name,
      delegationKind: "notice",
      ...linkFields(record, reportId),
      content: noticeText,
      workflowId: response?.workflow_id ?? record.workflow_id ?? null,
      intent: record.intent,
    });

  const invocationIds = (response?.evidence ?? []).flatMap((row) => row.invocation_ids ?? []);
  // A compact, secret-free digest for a coordinator's combined report and for workflow memory.
  const summary = response
    ? [
        ...(response.facts ?? []),
        ...(response.recommendations ?? []),
        ...(response.approvals ?? []).map(
          (row) =>
            `Approval ${row.approval_id} for ${row.bill ?? row.purchase_order ?? "the draft"}: ${row.where}`,
        ),
      ]
        .slice(0, 16)
        .map((line) => clip(line, 300))
    : [];
  const settled = advance(
    db,
    id,
    {
      status,
      completed_at: nowIso(),
      notified: true,
      error: status === "failed" ? clip(reason, 400) : null,
      result_reference: {
        session_key: record.target_conversation_id,
        message_id: reportId,
        workflow_id: response?.workflow_id ?? record.workflow_id ?? null,
        invocation_ids: invocationIds,
        summary,
        evidence: response ? evidenceLines(response) : [],
        limitations: (response?.limitations ?? [])
          .filter((row) => !/^Data source:/.test(row))
          .slice(0, 5)
          .map((row) => clip(row, 220)),
        source_label: response?.limitations?.find((row) => /^Data source:/.test(row)) ?? null,
      },
    },
    status === "failed" ? "task_failed" : "task_completed",
  );
  for (const hook of settledHooks) await hook(runtime, settled);
  return settled;
}

/**
 * After a restart: finish every delegation that was queued, running, or finished but not yet
 * delivered. It reconciles with the workflow first (a workflow that exists is rejoined, never run
 * again) and reuses the same exactly-once publishing.
 */
export async function recoverDelegations(runtime) {
  const db = runtime.db;
  const voice = runtime.nammaops?.voice;
  if (!voice) return { recovered: 0 };
  let recovered = 0;
  for (const record of db.records(DELEGATION_NAMESPACE)) {
    if (FINAL.has(record.status) && record.notified) continue;
    try {
      if (!record.workflow_id) {
        await execute(runtime, record.delegation_id, { waitMs: DM_WAIT_MS });
      } else {
        const call = { id: record.delegation_id, name: record.target.name };
        const response = await voice.query({
          call,
          actionId: `recover-${Date.now()}`,
          args: { intent: record.intent, workflow_id: record.workflow_id },
        });
        if (response.status === "running")
          void watchForResult({
            voice,
            call,
            intent: record.intent,
            workflowId: record.workflow_id,
            post: (finished) => finish(runtime, record.delegation_id, finished),
          });
        else await finish(runtime, record.delegation_id, response);
      }
      recovered += 1;
    } catch (error) {
      console.warn(
        `[nammaops] could not recover delegation ${record.delegation_id}: ${error.message}`,
      );
    }
  }
  return { recovered };
}
