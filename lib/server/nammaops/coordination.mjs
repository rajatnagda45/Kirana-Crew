/**
 * Alice (the office lead) in her own one-to-one chat: split a multi-part request into one task per
 * owning specialist, hand each to that specialist's OWN chat, run them in parallel, report progress
 * when something finishes, and combine the verified results into one report.
 *
 * Alice never reads the ERP. Each task runs through `delegation.mjs` (the owning specialist's own
 * governed identity); anything Alice cannot resolve, or a specialist cannot finish, is disclosed in
 * the combined report instead of disappearing. Office group chat does not use this module.
 */
import { OWNER } from "./group-business.mjs";
import { resolveIntent, VOICE_INTENTS } from "./intent-contract.mjs";
import { describeInstruction } from "./intent-llm.mjs";
import {
  DELEGATION_NAMESPACE,
  delegateToOwner,
  resolveSpecialist,
  settledHooks,
} from "./delegation.mjs";
import { inAskedLanguage } from "./reply-language.mjs";
import { compareDigests, digestOf, remember } from "./workflow-memory.mjs";

export const COORDINATION_NAMESPACE = "nammaops.dm_coordination";
const DM_WAIT_MS = 60_000;
/** Fewer comparable past runs than this and no estimate is given. */
export const MIN_ETA_SAMPLES = 5;
const TERMINAL = new Set(["completed", "failed", "needs_clarification"]);

const nowIso = () => new Date().toISOString();
const clip = (text, max) => {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

// ---- understanding a multi-part request ------------------------------------------------------

/** Pieces of a request: commas, semicolons, "and <verb>", "also" ("milk and atta" stays whole). */
export function splitClauses(message) {
  return String(message ?? "")
    .split(
      /\s*(?:[;\n]|,\s*(?:and\s+|also\s+)?|\s+and\s+(?=(?:also\s+)?(?:get|check|show|give|tell|find|see|list|what|how|fetch|pull|create|make)\b)|\s+(?:as well as|and also|also)\s+)\s*/i,
    )
    .map((part) => part.trim().replace(/[.?!]+$/, ""))
    .filter(Boolean);
}

/** "check whether milk and atta are in stock" -> "check stock of milk and atta". */
function normalizeClause(clause) {
  const available =
    /(?:whether|if)\s+(.+?)\s+(?:are|is)\s+(?:in\s+stock|available|in\s+the\s+store)/i;
  const hit =
    available.exec(clause) ?? /^(?:check\s+)?(.+?)\s+(?:are|is)\s+in\s+stock/i.exec(clause);
  return hit ? `check stock of ${hit[1].trim()}` : clause;
}

/** What a department's subject looks like in free text, with the plain question that covers it. */
const TOPICS = [
  {
    department: "inventory",
    re: /\b(stock|inventory|reorder|expiry|expiring)\b/i,
    ask: "check stock",
  },
  {
    department: "sales",
    re: /\b(sales?|sold|selling|top sellers?|revenue)\b/i,
    ask: (message) =>
      `show sales summary ${/\byesterday\b/i.test(message) ? "yesterday" : "today"}`,
  },
  {
    department: "finance",
    re: /\b(udhaar|udhar|receivables?|overdue|outstanding|owes?|dues?)\b/i,
    ask: "how much udhaar is pending",
  },
  {
    department: "procurement",
    re: /\b(procurement|suppliers?|purchase orders?|quotations?)\b/i,
    ask: "tell me about procurement",
  },
];

/**
 * The subjects a question names, by the department nouns alone (stock, sales, udhaar, suppliers),
 * ignoring verbs and the word "report". Used to scope a question about an EARLIER report: "what did
 * the last stock report say" is about stock, however the word "report" reads as a sales report.
 * @returns {Array<{ intent: string, args: any, department: string, clause: string, instruction: string }>}
 */
export function topicTasks(message, { today, seats }) {
  const tasks = [];
  for (const topic of TOPICS) {
    if (!topic.re.test(message)) continue;
    const ask = typeof topic.ask === "function" ? topic.ask(message) : topic.ask;
    const resolved = resolveIntent(ask, { today, seats });
    if (resolved.status !== "ok") continue;
    const intent = resolved.args.intent;
    if (tasks.some((task) => task.intent === intent)) continue;
    tasks.push({
      intent,
      args: resolved.args,
      department: OWNER[intent] ?? resolved.department,
      clause: ask,
      instruction: describeInstruction(resolved.args),
    });
  }
  return tasks;
}

/**
 * Split a request into tasks (one per intent) without the shared classifier. Each clause is read by
 * the same keyword resolver the other chats use; a subject that is named but not covered by any
 * clause gets its plain question. Anything left unread is returned so it can be disclosed.
 * @returns {{ tasks: Array<{ intent: string, args: any, department: string, clause: string, instruction: string }>, unresolved: string[] }}
 */
export function decomposeRequest(message, { today, seats }) {
  let tasks = [];
  const unresolved = [];
  const add = (resolved, clause) => {
    const intent = resolved.args.intent;
    if (tasks.some((task) => task.intent === intent)) return true;
    tasks.push({
      intent,
      args: resolved.args,
      department: OWNER[intent] ?? resolved.department,
      clause,
      instruction: describeInstruction(resolved.args),
    });
    return true;
  };
  const covered = new Set();
  for (const raw of splitClauses(message)) {
    const clause = normalizeClause(raw);
    const resolved = resolveIntent(clause, { today, seats });
    if (resolved.status === "ok") add(resolved, raw);
    else unresolved.push(raw);
  }
  for (const topic of TOPICS) {
    if (!topic.re.test(message)) continue;
    if (tasks.some((task) => task.department === topic.department)) {
      covered.add(topic.department);
      continue;
    }
    const ask = typeof topic.ask === "function" ? topic.ask(message) : topic.ask;
    const resolved = resolveIntent(ask, { today, seats });
    if (resolved.status === "ok") {
      add(resolved, ask);
      covered.add(topic.department);
    }
  }
  // A catalogue listing is subsumed by a stock check in the same request (and the catalogue is
  // manager-owned, so keeping both would make the coordinator a specialist in her own list).
  if (tasks.some((task) => task.department === "inventory" && task.intent !== "list_products"))
    tasks = tasks.filter((task) => task.intent !== "list_products");
  // A clause that only named a subject the request covers elsewhere is not "unread".
  const left = unresolved.filter(
    (clause) =>
      clause.split(/\s+/).length >= 2 &&
      !TOPICS.some((topic) => covered.has(topic.department) && topic.re.test(clause)),
  );
  return { tasks, unresolved: left };
}

// ---- how long it usually takes ---------------------------------------------------------------

const percentile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * An estimate from measured history only: the slowest of the workflows that run in parallel, from
 * past completed runs. Null (no estimate) unless every workflow has enough comparable runs.
 * `prepare_bill` is excluded: its record stays open until the owner approves.
 * @returns {{ p50_ms: number, p90_ms: number, samples: number } | null}
 */
export function durationEstimate(db, intents) {
  const actions = [...new Set(intents.map((intent) => VOICE_INTENTS[intent]).filter(Boolean))];
  if (!actions.length || actions.includes("prepare_bill")) return null;
  const rows = db.records("nammaops.workflow");
  let p50 = 0;
  let p90 = 0;
  let samples = Infinity;
  for (const action of actions) {
    const times = rows
      .filter(
        (row) =>
          row.intent?.action === action &&
          row.status === "completed" &&
          row.finished_at &&
          row.created_at,
      )
      .map((row) => Date.parse(row.finished_at) - Date.parse(row.created_at))
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
      .sort((a, b) => a - b);
    if (times.length < MIN_ETA_SAMPLES) return null;
    p50 = Math.max(p50, percentile(times, 0.5));
    p90 = Math.max(p90, percentile(times, 0.9));
    samples = Math.min(samples, times.length);
  }
  return { p50_ms: p50, p90_ms: p90, samples };
}

const seconds = (ms) =>
  `${Math.max(1, Math.round(ms / 1000))} second${Math.round(ms / 1000) === 1 ? "" : "s"}`;

function etaSentence(estimate) {
  if (!estimate)
    return "I don't have a reliable completion estimate yet. I'll tell you when the report is ready.";
  return `Estimated time: about ${seconds(estimate.p50_ms)}, and usually under ${seconds(estimate.p90_ms)} (an estimate from ${estimate.samples} comparable past runs, not a promise).`;
}

// ---- record helpers ---------------------------------------------------------------------------

function advanceCo(db, id, patch) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = db.record(COORDINATION_NAMESPACE, id);
    if (!current) return null;
    const value = { ...current };
    delete value.id;
    delete value.revision;
    try {
      return db.saveRecord(
        COORDINATION_NAMESPACE,
        id,
        { ...value, ...patch(value) },
        current.revision,
      );
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  throw new Error(`Coordination ${id} changed too often to update.`);
}

function postOnce(db, message) {
  if (db.getMessage(message.id)) return false;
  db.saveMessage({ runId: "", timestamp: nowIso(), role: "assistant", ...message });
  return true;
}

/** The current state of one sub-task, from its delegation record when it has one. */
function stateOf(db, sub) {
  if (!sub.delegation_id) return { status: sub.status, error: sub.error ?? null, own: sub };
  const record = db.record(DELEGATION_NAMESPACE, sub.delegation_id);
  if (!record) return { status: sub.status, error: sub.error ?? null, record: null };
  return {
    status: record.notified || TERMINAL.has(record.status) ? record.status : "running",
    error: record.error,
    record,
  };
}

const labelOf = (sub) => `${sub.name} (${sub.title})`;
const listNames = (items) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");

// ---- the coordinator --------------------------------------------------------------------------

/**
 * Coordinate `tasks` for Alice. Posts one immediate acknowledgment in Alice's chat, delivers each
 * specialist task to that specialist's own chat in parallel, and returns when everything has
 * finished or the wait runs out (the rest is delivered later, also after a restart).
 * @param {any} runtime
 * @param {{ taskId: string, message: string, userMessageId: string, tasks: any[], unresolved: string[],
 *   source: { seatId: string, role: string, name: string, title: string, sessionKey: string },
 *   deadline?: any, recall?: string }} c
 */
export async function coordinate(runtime, c) {
  const db = runtime.db;
  const nammaops = runtime.nammaops;
  const id = `coord_${c.taskId}`;
  const departments = nammaops.voice.departments.seats ?? [];
  const subtasks = c.tasks.map((task, index) => {
    const row = departments.find((d) => d.department === task.department);
    const own = !task.department || task.department === "manager";
    return {
      index,
      department: task.department,
      name: row?.voice_name ?? task.department,
      title: row?.title ?? task.department,
      intent: task.intent,
      args: task.args,
      clause: task.clause,
      instruction: task.instruction,
      own,
      delegation_id: own ? null : `dlg_${c.taskId}_${index}`,
      status: "queued",
      error: null,
      // The earlier report this task will be compared with (when a live question recalled one).
      previous: c.previous?.[task.intent] ?? null,
    };
  });
  let record = db.record(COORDINATION_NAMESPACE, id);
  if (!record) {
    try {
      record = db.saveRecord(
        COORDINATION_NAMESPACE,
        id,
        {
          coordination_id: id,
          task_id: c.taskId,
          parent_message_id: c.userMessageId,
          source: c.source,
          source_conversation_id: c.source.sessionKey,
          original_request: clip(c.message, 600),
          subtasks,
          unresolved: c.unresolved ?? [],
          status: "running",
          announced: [],
          final_posted: false,
          created_at: nowIso(),
          completed_at: null,
          estimate: durationEstimate(
            db,
            c.tasks.map((task) => task.intent),
          ),
        },
        0,
      );
    } catch (error) {
      if (error.status !== 409) throw error;
      record = db.record(COORDINATION_NAMESPACE, id);
    }
  }

  // 1. The immediate acknowledgment, before any work: who is on it, in parallel, and how long.
  // Alice is the coordinator, never one of the specialists she lists.
  const specialists = subtasks.filter((sub) => !sub.own);
  const ack = [
    specialists.length
      ? `I've understood your request. I'm coordinating with ${listNames(specialists.map(labelOf))}.`
      : "I've understood your request. I'm working on it now.",
    specialists.length > 1
      ? "They are checking their own records in parallel, and I'll combine their verified findings into one report."
      : specialists.length
        ? "They are checking their own records, and I'll share the verified result here."
        : "I'll share the result here as soon as it is ready.",
    etaSentence(record.estimate),
    ...(c.recall ? ["", c.recall] : []),
  ].join("\n");
  postOnce(db, {
    id: `dm_reply_${c.taskId}`,
    sessionKey: c.source.sessionKey,
    seatId: c.source.seatId,
    actorName: c.source.name,
    content: await translate(runtime, record, ack),
    delegationKind: "ack",
    coordinationId: id,
    links: specialists.map((sub) => ({ name: sub.name })),
    intent: subtasks[0]?.intent ?? null,
    workflowId: null,
  });

  // 2. Hand every task over at once.
  await Promise.allSettled(subtasks.map((sub) => startSubtask(runtime, id, sub, c)));
  await coordinationProgress(runtime, id);
  const latest = db.record(COORDINATION_NAMESPACE, id);
  return {
    answered: {
      workflowId: null,
      intent: subtasks[0]?.intent ?? null,
      delegated: true,
      coordinationId: id,
      delegations: subtasks.map((sub) => sub.delegation_id).filter(Boolean),
      status: latest.status,
    },
  };
}

const translate = (runtime, record, text) =>
  inAskedLanguage(runtime, record.original_request, text, { timeoutMs: 6500 }).then(
    (out) => out.text,
  );

/** Start one task: a specialist's own chat via delegation, or a workflow Alice coordinates herself. */
async function startSubtask(runtime, coordinationId, sub, c) {
  const db = runtime.db;
  const mark = (patch) =>
    advanceCo(db, coordinationId, (value) => ({
      subtasks: value.subtasks.map((row) => (row.index === sub.index ? { ...row, ...patch } : row)),
    }));
  if (sub.own) {
    // Manager-owned questions (profit, store health) are workflows the specialists compute; Alice
    // reports them herself and reads nothing directly.
    const voice = runtime.nammaops.voice;
    try {
      const response = await voice.query({
        call: { id: `${coordinationId}_${sub.index}`, name: c.source.name },
        actionId: "coord",
        args: sub.args,
        message: sub.clause,
        waitMs: c.deadline ? c.deadline.waitMs() : DM_WAIT_MS,
      });
      if (response.status === "running") {
        mark({ status: "running", workflow_id: response.workflow_id });
        return;
      }
      mark(ownResult(response));
    } catch (error) {
      mark({ status: "failed", error: error.message });
    }
    return;
  }
  mark({ status: "running" });
  const out = await delegateToOwner(runtime, {
    taskId: `${c.taskId}_${sub.index}`,
    message: sub.clause,
    parsed: { department: sub.department, args: sub.args, instruction: sub.instruction },
    userMessageId: c.userMessageId,
    source: c.source,
    coordinationId,
    deadline: c.deadline,
  });
  if (out.answered?.failed && !out.answered.delegated)
    mark({
      status: "failed",
      error: `${sub.name} is not available right now (the task could not be delivered)`,
    });
}

function ownResult(response) {
  const status =
    response.status === "clarification_required"
      ? "needs_clarification"
      : ["unavailable", "blocked"].includes(response.status)
        ? "failed"
        : "completed";
  return {
    status,
    error:
      status === "failed"
        ? (response.limitations?.find((row) => !/^Data source:/.test(row)) ?? "it failed")
        : null,
    summary: [...(response.facts ?? []), ...(response.recommendations ?? [])]
      .slice(0, 16)
      .map((line) => clip(line, 300)),
    workflow_id: response.workflow_id ?? null,
    executed_by: (response.routing?.executed_by ?? []).map((row) => row.name),
  };
}

/**
 * After any sub-task settles: say so when it is worth saying (some finished, some not), and when
 * all are done post the combined report exactly once. Safe to call repeatedly.
 */
export async function coordinationProgress(runtime, coordinationId) {
  const db = runtime.db;
  const co = db.record(COORDINATION_NAMESPACE, coordinationId);
  if (!co || co.final_posted) return co;
  const states = co.subtasks.map((sub) => ({ sub, ...stateOf(db, sub) }));
  const done = states.filter((row) => TERMINAL.has(row.status));
  const pending = states.filter((row) => !TERMINAL.has(row.status));
  const base = {
    sessionKey: co.source_conversation_id,
    seatId: co.source.seatId,
    actorName: co.source.name,
    coordinationId,
  };

  if (pending.length) {
    // Progress only on a real event: a task newly finished while others are still running.
    for (const row of done) {
      if (co.announced.includes(row.sub.index)) continue;
      const verb =
        row.status === "completed"
          ? "has finished"
          : row.status === "needs_clarification"
            ? "needs a detail from you"
            : "could not finish";
      const text = `${labelOf(row.sub)} ${verb}. Still waiting for ${listNames(pending.map((p) => p.sub.name))}.`;
      const posted = postOnce(db, {
        ...base,
        id: `dm_progress_${co.task_id}_${row.sub.index}`,
        content: await translate(runtime, co, text),
        delegationKind: "progress",
        links: [{ name: row.sub.name }],
      });
      advanceCo(db, coordinationId, (value) => ({
        announced: [...new Set([...value.announced, row.sub.index])],
      }));
      void posted;
    }
    return db.record(COORDINATION_NAMESPACE, coordinationId);
  }

  // Everything is terminal: one combined report.
  const sections = [];
  const problems = [];
  for (const row of states) {
    const { sub, record } = row;
    const summary = record?.result_reference?.summary ?? sub.summary ?? [];
    const evidence = record?.result_reference?.evidence ?? [];
    const head = `**${sub.name} — ${sub.title}**`;
    if (row.status === "completed") {
      sections.push(
        [
          head,
          ...(summary.length ? summary : ["Completed, with no facts to list."]),
          ...(evidence.length ? [`_Read by ${evidence.join("; ")}_`] : []),
          ...(sub.own ? [] : [`Full report: ${sub.name}'s chat.`]),
        ].join("\n"),
      );
    } else if (row.status === "needs_clarification") {
      problems.push(`${sub.name} needs a detail from you: please answer in ${sub.name}'s chat.`);
      sections.push(`${head}\nWaiting for your answer.`);
    } else {
      problems.push(
        `${sub.name} could not complete this: ${clip(row.error ?? "it failed", 200).replace(/[.\s]+$/, "")}.`,
      );
      sections.push(`${head}\nNo result.`);
    }
  }
  const comparisons = [];
  for (const row of states) {
    const { sub, record } = row;
    if (!sub.previous || row.status !== "completed") continue;
    let fresh = null;
    try {
      fresh = digestOf(
        sub.intent,
        record?.workflow_id ? runtime.nammaops.workflows.view(record.workflow_id)?.result : null,
      );
    } catch {
      fresh = null;
    }
    const lines = compareDigests(sub.intent, sub.previous.data, fresh);
    const when = String(sub.previous.completed_at).replace("T", " ").slice(0, 16);
    comparisons.push(
      [
        `**${sub.name} — earlier report (${when} UTC) compared with the newly verified result**`,
        ...(lines ?? [
          "No automatic comparison is available for this kind of report. The earlier summary is above, labelled with its time; the figures in this report are the newly verified ones.",
        ]),
      ].join("\n"),
    );
  }
  for (const clause of co.unresolved ?? [])
    problems.push(`I could not tell what to check for: "${clip(clause, 120)}".`);
  const failed =
    states.some((row) => row.status !== "completed") || (co.unresolved ?? []).length > 0;
  const text = [
    failed
      ? "Here is what I have so far. Some parts are missing."
      : "Here is the combined report from the verified results.",
    "",
    sections.join("\n\n---\n\n"),
    ...(comparisons.length ? ["", comparisons.join("\n\n")] : []),
    ...(problems.length
      ? ["", "**Missing or incomplete**", ...problems.map((row) => `- ${row}`)]
      : []),
  ].join("\n");
  const posted = postOnce(db, {
    ...base,
    id: `dm_synthesis_${co.task_id}`,
    content: await translate(runtime, co, text),
    delegationKind: "synthesis",
    links: co.subtasks.filter((sub) => !sub.own).map((sub) => ({ name: sub.name })),
  });
  const final = advanceCo(db, coordinationId, () => ({
    final_posted: true,
    status: failed ? "partial" : "completed",
    completed_at: nowIso(),
  }));
  if (posted) {
    try {
      await remember(runtime, final, states);
    } catch (error) {
      console.warn(`[nammaops] could not store workflow memory: ${error.message}`);
    }
  }
  return final;
}

settledHooks.add(async (runtime, record) => {
  if (record.coordination_id) await coordinationProgress(runtime, record.coordination_id);
});

/**
 * After a restart: start any task that was never delivered, then let progress finish the report.
 * (Delegations already in flight are recovered by `recoverDelegations`.)
 */
export async function recoverCoordinations(runtime) {
  const db = runtime.db;
  let recovered = 0;
  for (const co of db.records(COORDINATION_NAMESPACE)) {
    if (co.final_posted) continue;
    try {
      for (const sub of co.subtasks) {
        if (sub.own || TERMINAL.has(sub.status)) continue;
        if (db.record(DELEGATION_NAMESPACE, sub.delegation_id)) continue;
        if (!resolveSpecialist(runtime, sub.department)) continue;
        await startSubtask(runtime, co.coordination_id, sub, {
          taskId: co.task_id,
          userMessageId: co.parent_message_id,
          source: co.source,
        });
      }
      await coordinationProgress(runtime, co.coordination_id);
      recovered += 1;
    } catch (error) {
      console.warn(
        `[nammaops] could not recover coordination ${co.coordination_id}: ${error.message}`,
      );
    }
  }
  return { recovered };
}
