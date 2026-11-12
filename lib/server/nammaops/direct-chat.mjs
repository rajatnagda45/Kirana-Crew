/**
 * One-to-one chat with a NammaOps specialist (Bob, Carol, Dave, Erin or Alice).
 *
 * Their seats are shared OpenClaw `main` sessions, and `main` cannot read the store's ERP data. A
 * store question typed to them used to become a free-form `main` task, which guessed, wandered
 * through its tool registry and sometimes failed. Here a store question runs the same governed
 * NammaOps workflow the group chat and the voice agents use, and the verified answer is saved into
 * that chat. A message that is not a store question gets a short help line. Nothing from these
 * seats reaches `main` until its tools are restricted.
 */
import {
  COORDINATOR_ROLE,
  formatBusinessReply,
  replySpeaker,
  routingLine,
} from "./group-business.mjs";
import { resolveResponseLang } from "./lang-detect.mjs";
import { parseCommand } from "./workflows.mjs";
import { watchForResult } from "./late-result.mjs";
import { resolveIntent } from "./intent-contract.mjs";
import { delegateToOwner } from "./delegation.mjs";
import { answerFollowUp, followUpSubject, modelFollowUpApplies } from "./follow-up.mjs";
import { coordinate, decomposeRequest, topicTasks } from "./coordination.mjs";
import { describeInstruction } from "./intent-llm.mjs";
import { NOT_REVERIFIED, isHistoricalQuestion, recall, recallText } from "./workflow-memory.mjs";
import { inAskedLanguage } from "./reply-language.mjs";

/** The name a reply is posted under: the executor, "Alice" for a team (role line says coordinating). */
const speakerLabel = (routing, fallback) => replySpeaker(routing, fallback).name;
/** The role line for a reply: set only when the manager speaks for a team. */
const speakerRole = (routing, fallback) =>
  replySpeaker(routing, fallback).coordinating ? { actorRole: COORDINATOR_ROLE } : {};

/** A resolved intent, or null when the message is not a store question. */
const usable = (resolved) => (resolved.status === "ok" ? resolved : null);

const MAX_CHARS = 1000;
const DM_WAIT_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Alice's chat: a request for one or several specialists is split into tasks, each handed to its
 * owner's own chat, and the verified results are combined here. A question about an earlier report
 * is answered from workflow memory (with its own timestamp); a live question recalls the earlier
 * report AND checks live. Returns null when this is not a coordinated request (the ordinary path).
 */
async function coordinateForManager(runtime, c) {
  const nammaops = runtime.nammaops;
  const db = runtime.db;
  const today = nammaops.workflows.today();
  const seats = (nammaops.voice.departments.seats ?? []).map((d) => d.voice_name);
  let { tasks, unresolved } = decomposeRequest(c.message, { today, seats });
  if (!tasks.length && c.parsed)
    tasks = [
      {
        intent: c.parsed.args.intent,
        args: c.parsed.args,
        department: c.parsed.department,
        clause: c.message,
        instruction: c.parsed.instruction ?? describeInstruction(c.parsed.args),
      },
    ];
  const intents = tasks.map((task) => task.intent);
  const reply = (content, extra = {}) =>
    db.saveMessage({
      runId: "",
      timestamp: new Date().toISOString(),
      role: "assistant",
      id: `dm_reply_${c.taskId}`,
      sessionKey: c.source.sessionKey,
      seatId: c.source.seatId,
      actorName: c.source.name,
      content,
      workflowId: null,
      intent: intents[0] ?? null,
      ...extra,
    });
  // Recall is scoped to what was asked: each task looks only for ITS OWN kind of earlier report
  // (an inventory question never recalls a sales or finance report).
  const recalled = [];
  let mode = "keyword";
  // A question about an EARLIER report is scoped by the subjects it names, not by how "report" reads.
  const historical = isHistoricalQuestion(c.message);
  const scopeTasks = historical ? topicTasks(c.message, { today, seats }) : tasks;
  for (const task of scopeTasks) {
    const found = await recall(runtime, c.message, {
      intents: [task.intent],
      products: task.args?.products ?? [],
    });
    if (found.hits[0]) {
      recalled.push({ task, hit: found.hits[0] });
      if (found.mode === "semantic") mode = "semantic";
    }
  }
  if (historical) {
    // With nothing to scope by, fall back to a keyword match over all stored reports.
    if (!scopeTasks.length) {
      const found = await recall(runtime, c.message);
      if (found.hits[0]) recalled.push({ task: null, hit: found.hits[0] });
      mode = found.mode;
    }
    const text = recalled.length
      ? `${recalled.map((row) => recallText(row.hit, { full: true })).join("\n\n")}\n\n${NOT_REVERIFIED} Ask me for the current position and I will check it live.`
      : "I do not have a stored report that matches that. Ask me for a current check and I will coordinate it.";
    reply(await c.translate(text));
    return {
      answered: {
        workflowId: null,
        intent: scopeTasks[0]?.intent ?? intents[0] ?? null,
        memory: true,
        mode,
        memoryId: recalled[0]?.hit.memory.memory_id ?? null,
        memoryIds: recalled.map((row) => row.hit.memory.memory_id),
      },
    };
  }
  const worth =
    tasks.some((task) => task.department && task.department !== "manager") || tasks.length > 1;
  if (!worth) return null;
  // A live question: a compact earlier report first (clearly labelled), then the fresh check, and
  // the combined report compares the two.
  let recallLine;
  const previous = {};
  if (recalled.length) {
    recallLine = [
      "Earlier report(s), shown only for context:",
      ...recalled.map((row) => recallText(row.hit)),
      "",
      `${NOT_REVERIFIED} I am checking now to confirm what has changed.`,
    ].join("\n");
    for (const row of recalled)
      previous[row.task.intent] = {
        memory_id: row.hit.memory.memory_id,
        completed_at: row.hit.memory.completed_at,
        data: row.hit.memory.data ?? null,
      };
  }
  return coordinate(runtime, {
    taskId: c.taskId,
    message: c.message,
    userMessageId: c.userMessageId,
    tasks,
    unresolved,
    source: c.source,
    deadline: c.deadline,
    recall: recallLine,
    previous,
  });
}

/** What each specialist can be asked, for the help line. */
const SCOPE = {
  manager: [
    "the shop's biggest problems, stock, sales, udhaar or suppliers",
    "Tell me the five biggest problems in my shop today.",
  ],
  inventory: [
    "stock, what to reorder, demand forecasts and expiring stock",
    "Check the stock of milk and rice.",
  ],
  sales: [
    "sales for a day or several days, top products and customers",
    "Give me a summary of the previous 3 days of sales.",
  ],
  procurement: [
    "supplier quotations, purchase orders and late suppliers",
    "Which supplier is delaying our milk deliveries?",
  ],
  finance: ["udhaar, profit and supplier bills", "How much udhaar is pending?"],
  reports: [
    "weekly and monthly business reports with sales, profit, udhaar and stock",
    "Give me the weekly report.",
  ],
  billing: [
    "the bills raised at the counter, their totals, returns and which are unpaid",
    "How many bills did we make today?",
  ],
};

/**
 * What was said and run earlier in this chat, so a follow-up is understood in context.
 * `scope` changes whenever the conversation does, which keeps cached understanding honest.
 */
export function conversationBefore(db, sessionKey, excludeId) {
  const messages = db
    .messages(sessionKey)
    .filter((m) => m.id !== excludeId && (m.role === "user" || m.role === "assistant"))
    .slice(-8);
  const history = messages.map((m) => ({
    role: m.role,
    name: m.actorName,
    text: m.content ?? "",
    intent: m.intent ?? undefined,
    status: m.intent ? (m.workflowStatus ?? undefined) : undefined,
  }));
  const lastHandoff = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.handoffId && !m.handoffDone);
  return {
    history,
    lastHandoffId: lastHandoff?.handoffId ?? null,
    scope: messages.at(-1)?.id ?? "start",
  };
}

/**
 * One chat turn about a handoff: either the owner answers a pending proposal in words, or asks for
 * a teammate and a new proposal is made. Returns null when this turn is not about a handoff.
 */
async function handoffTurn({ nammaops, earlier, message, scope, input, source }) {
  const handoffs = nammaops.handoffs;
  if (!handoffs) return null;
  if (earlier.lastHandoffId) {
    const record = handoffs.get(earlier.lastHandoffId);
    if (record?.status === "proposed" && Date.parse(record.expiresAt) > Date.now()) {
      try {
        const decided = await handoffs.decide(record, message);
        if (decided.status === "declined")
          return { content: "Okay, I'll stay on this with you.", status: "declined", done: true };
        if (decided.status === "consumed" || decided.status === "accepted")
          return {
            content: `Done. Open ${record.target.name}'s chat; I've passed on your request.`,
            status: "consumed",
            done: true,
          };
        // cancelled (a different request): carry on with the normal flow below
      } catch {
        // not a clear yes or no: treat it as a normal message; the proposal stays until it expires
      }
    }
  }
  const wanted = nammaops.intents.handoffTarget(message, scope);
  if (!wanted) return null;
  try {
    const lastOwner = [...earlier.history].reverse().find((h) => h.role === "user");
    const proposal = handoffs.propose({
      channel: "chat",
      fromSeatId: source.seatId,
      sessionKey: input.sessionKey,
      target: wanted,
      pending: lastOwner?.text ?? "",
      triggerMessageId: `dm_user_${input.taskId}`,
    });
    return {
      content: `Shall I connect you to ${proposal.target}? Press the button or say yes.`,
      handoffId: proposal.handoff_id,
      target: proposal.target,
      status: "proposed",
    };
  } catch (error) {
    return { content: `I can't connect you: ${error.message}`, status: "refused", done: true };
  }
}

/** The NammaOps specialist profile on this seat, or null (other seats keep their normal path). */
export function specialistProfile(runtime, seatId) {
  if (!runtime.nammaops || !seatId) return null;
  return (
    runtime.profiles
      ?.list()
      .find((p) => p.seat_id === seatId && String(p.agent_id).startsWith("nammaops-")) ?? null
  );
}

const roleOf = (profile) => String(profile.agent_id).replace(/^nammaops-/, "");

export function helpLine(name, title, role) {
  const [scope, example] = SCOPE[role] ?? SCOPE.manager;
  return `Hi, I'm ${name} (${title}). I can answer questions about ${scope}. For example: "${example}"`;
}

/**
 * Answer one direct message. Returns `{ answered }` for the HTTP layer, or null when the seat is
 * not a NammaOps specialist.
 * @param {any} runtime
 * @param {{ taskId?: string, message?: string, seatId?: string, sessionKey?: string }} input
 */
export async function answerDirect(runtime, input, { deadline = null } = {}) {
  const profile = specialistProfile(runtime, input?.seatId);
  if (!profile) return null;
  runtime.estop?.assertClear?.();
  if (!SAFE_ID.test(String(input.taskId ?? ""))) throw fail(400, "A stable task ID is required.");
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message || message.length > MAX_CHARS)
    throw fail(400, `A message of 1 to ${MAX_CHARS} characters is required.`);
  // Use the user's explicit language preference; fall back to auto-detecting from input text.
  const msgLang = resolveResponseLang(input.language ?? null, message);
  if (typeof input.sessionKey !== "string" || !input.sessionKey)
    throw fail(400, "A conversation session is required.");

  const db = runtime.db;
  const seat = db.getSeat(input.seatId);
  const role = roleOf(profile);
  const departments = runtime.nammaops.voice.departments.seats ?? [];
  const me = departments.find((d) => d.department === role);
  const name = seat?.label ?? me?.voice_name ?? profile.name;
  const title = me?.title ?? seat?.roleTitle ?? role;
  const userId = `dm_user_${input.taskId}`;
  const replyId = `dm_reply_${input.taskId}`;

  // A retried send (same task ID) returns the saved answer instead of running the workflow again.
  const saved = db.getMessage(replyId);
  if (saved)
    return {
      answered: {
        workflowId: saved.workflowId ?? null,
        intent: saved.intent ?? null,
        repeat: true,
      },
    };

  const now = () => new Date().toISOString();
  const base = { runId: "", sessionKey: input.sessionKey, seatId: input.seatId };
  db.saveMessage({ ...base, id: userId, role: "user", content: message, timestamp: now() });

  const nammaops = runtime.nammaops;
  // The reply comes back in the language the owner wrote in (English questions are untouched).
  const inTheirLanguage = async (text) =>
    (await inAskedLanguage(runtime, message, text, { timeoutMs: 6500 })).text;
  const earlier = conversationBefore(db, input.sessionKey, userId);
  const scope = earlier.scope;
  await nammaops.intents.prime(message, { history: earlier.history, scope, deadline });
  // Moving the conversation to a teammate: the model only proposes; the server resolves the target,
  // checks the owner's reply and consumes the handoff once.
  const handoffReply = await handoffTurn({
    nammaops,
    earlier,
    message,
    scope,
    input,
    source: { name, seatId: input.seatId },
  });
  if (handoffReply) {
    db.saveMessage({
      ...base,
      id: replyId,
      role: "assistant",
      actorName: name,
      content: await inTheirLanguage(handoffReply.content),
      timestamp: now(),
      workflowId: null,
      intent: null,
      ...(handoffReply.handoffId
        ? { handoffId: handoffReply.handoffId, handoffTarget: handoffReply.target }
        : {}),
      ...(handoffReply.done ? { handoffDone: true } : {}),
    });
    return { answered: { workflowId: null, intent: null, handoff: handoffReply.status } };
  }
  // A follow-up ("what happened to the previous stock check?") shows the SAVED result of an earlier
  // run in THIS chat: the owner's words or the model's reading say so. It never starts a workflow.
  // (Alice's questions about earlier reports are answered from her workflow memory instead.)
  const followWords = followUpSubject(message);
  const asksAboutEarlier =
    (followWords.isFollowUp ||
      (nammaops.intents.followUp(message, scope) &&
        modelFollowUpApplies(db, input.sessionKey, message))) &&
    !(role === "manager" && isHistoricalQuestion(message));
  if (asksAboutEarlier) {
    const earlierResult = await answerFollowUp(runtime, {
      sessionKey: input.sessionKey,
      message,
      subject: followWords.intent,
      hint: nammaops.intents.followUpIntent?.(message, scope) ?? null,
      language: msgLang,
    });
    db.saveMessage({
      ...base,
      id: replyId,
      role: "assistant",
      actorName: name,
      content: await inTheirLanguage(earlierResult.content),
      timestamp: now(),
      workflowId: earlierResult.workflowId,
      intent: earlierResult.intent,
      recalled: true,
      ...earlierResult.extra,
    });
    return {
      answered: {
        workflowId: earlierResult.workflowId,
        intent: earlierResult.intent,
        followUp: true,
      },
    };
  }
  const parsed = usable(
    resolveIntent(message, {
      intents: nammaops.intents,
      scope,
      today: nammaops.workflows.today(),
      seats: departments.map((d) => d.voice_name),
    }),
  );
  // Alice coordinates: one task per owning specialist, in each one's own chat, combined here.
  if (role === "manager") {
    const coordinated = await coordinateForManager(runtime, {
      taskId: input.taskId,
      message,
      parsed,
      userMessageId: userId,
      source: { seatId: input.seatId, role, name, title, sessionKey: input.sessionKey },
      deadline,
      translate: inTheirLanguage,
    });
    if (coordinated) return coordinated;
  }
  // A question that belongs to another specialist is passed to them as a task in THEIR chat; they
  // answer there and this seat tells the owner where. (Alice, the office lead, and questions the
  // manager owns keep the coordinating path below.)
  if (
    parsed &&
    role !== "manager" &&
    parsed.department &&
    parsed.department !== "manager" &&
    parsed.department !== role
  )
    return delegateToOwner(runtime, {
      taskId: input.taskId,
      message,
      parsed,
      userMessageId: userId,
      source: { seatId: input.seatId, role, name, title, sessionKey: input.sessionKey },
      deadline,
    });
  let content;
  let speaker = name; // the specialist who really ran the work, once known
  let speakerExtra = {};
  let workflowId = null;
  let workflowStatus = null;
  if (!parsed) {
    // businessIntent swallows parse errors; a date that cannot be read deserves a specific answer.
    let unreadableDate = null;
    try {
      parseCommand(message, nammaops.workflows.today());
    } catch (error) {
      if (/could not read that date/.test(error.message)) unreadableDate = error.message;
    }
    content = unreadableDate ?? helpLine(name, title, role);
  } else {
    try {
      // The router authorises by department, never by who was messaged; the specialists read the ERP
      // under their own governed identities. Use this seat's department as the caller.
      // A new question starts one workflow. Chat can wait longer than speech.
      const call = {
        id: `dm_${input.taskId}`,
        name: me?.voice_name ?? name,
      };
      const response = await nammaops.voice.query({
        call,
        actionId: "dm",
        args: parsed.args,
        // The owner's own words, so the shared contract can ask about an unclear period.
        message,
        // Inside a 15 s turn the chat shows a status and the result follows; without a deadline
        // (older callers) the long wait stays.
        waitMs: deadline ? deadline.waitMs() : DM_WAIT_MS,
      });
      workflowId = response.workflow_id ?? null;
      workflowStatus = response.status ?? null;
      // Who really ran it, from the workflow's own tasks: the reply is posted as that specialist,
      // with a line saying the asked seat passed it on.
      speaker = speakerLabel(response.routing, name);
      speakerExtra = speakerRole(response.routing, name);
      const handoffOf = (reply) => {
        const line = routingLine(reply?.routing, msgLang);
        return line ? `${line}\n\n` : "";
      };
      const handoff = handoffOf(response);
      // Only the model path carries a cleaned instruction; the keyword path shows none.
      const isHinglish = msgLang === "hl" || msgLang === "hi";
      const understood = parsed.instruction
        ? `${isHinglish ? "Samjha" : "Understood"}: ${parsed.instruction}\n\n`
        : "";
      content = understood + handoff + formatBusinessReply(response, { language: msgLang });
      if (response.status === "running" && workflowId && deadline) {
        const lateId = `dm_late_${input.taskId}`;
        void watchForResult({
          voice: nammaops.voice,
          call,
          intent: parsed.args.intent,
          workflowId,
          post: async (finished) => {
            if (db.getMessage(lateId)) return; // posted already (duplicate watcher or retry)
            const lateContent = await inTheirLanguage(
              understood +
                handoffOf(finished) +
                formatBusinessReply(finished, { language: msgLang }),
            );
            if (db.getMessage(lateId)) return;
            db.saveMessage({
              ...base,
              id: lateId,
              role: "assistant",
              actorName: speakerLabel(finished.routing, speaker),
              ...speakerRole(finished.routing, speaker),
              content: lateContent,
              timestamp: now(),
              workflowId,
              intent: parsed.args.intent,
              workflowStatus: finished.status ?? null,
            });
          },
        });
      }
    } catch (error) {
      content = `I could not complete that: ${error.message}`;
    }
  }
  content = await inTheirLanguage(content);
  db.saveMessage({
    ...base,
    id: replyId,
    role: "assistant",
    actorName: speaker,
    ...speakerExtra,
    content,
    timestamp: now(),
    workflowId,
    intent: parsed?.args.intent ?? null,
    workflowStatus,
  });
  return { answered: { workflowId, intent: parsed?.args.intent ?? null } };
}

/**
 * True when the message to this seat is a plain store question the governed workflows answer.
 * Used so that "check stock of milk" goes to the specialist, while a genuine investigation
 * ("why does the count not match") still goes to the verified work pipeline.
 */
export async function isStoreQuestion(runtime, seatId, message, { deadline = null } = {}) {
  if (!specialistProfile(runtime, seatId) || typeof message !== "string") return false;
  const nammaops = runtime.nammaops;
  await nammaops.intents.prime(message.trim(), { deadline });
  return (
    resolveIntent(message.trim(), {
      intents: nammaops.intents,
      today: nammaops.workflows.today(),
      seats: (nammaops.voice.departments.seats ?? []).map((d) => d.voice_name),
    }).status === "ok"
  );
}
