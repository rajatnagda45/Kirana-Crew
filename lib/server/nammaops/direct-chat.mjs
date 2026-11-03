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
import { businessIntent, formatBusinessReply } from "./group-business.mjs";

const MAX_CHARS = 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

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
};

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
export async function answerDirect(runtime, input) {
  const profile = specialistProfile(runtime, input?.seatId);
  if (!profile) return null;
  runtime.estop?.assertClear?.();
  if (!SAFE_ID.test(String(input.taskId ?? ""))) throw fail(400, "A stable task ID is required.");
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message || message.length > MAX_CHARS)
    throw fail(400, `A message of 1 to ${MAX_CHARS} characters is required.`);
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
  const parsed = businessIntent(message, {
    today: nammaops.workflows.today(),
    seats: departments.map((d) => d.voice_name),
  });
  let content;
  let workflowId = null;
  if (!parsed) {
    content = helpLine(name, title, role);
  } else {
    try {
      // The router authorises by department, never by who was messaged; the specialists read the ERP
      // under their own governed identities. Use this seat's department as the caller.
      const response = await nammaops.voice.query({
        call: { id: `dm_${input.taskId}`, name: me?.voice_name ?? name },
        actionId: "dm",
        args: parsed.args,
      });
      workflowId = response.workflow_id ?? null;
      const owner = departments.find((d) => d.department === parsed.department);
      const handoff =
        owner && owner.department !== role && owner.department !== "manager"
          ? `${owner.voice_name} (${owner.title}) covers this, so I checked with ${owner.voice_name}'s department.\n\n`
          : "";
      content = handoff + formatBusinessReply(response);
    } catch (error) {
      content = `I could not complete that: ${error.message}`;
    }
  }
  db.saveMessage({
    ...base,
    id: replyId,
    role: "assistant",
    actorName: name,
    content,
    timestamp: now(),
    workflowId,
    intent: parsed?.args.intent ?? null,
  });
  return { answered: { workflowId, intent: parsed?.args.intent ?? null } };
}

/**
 * True when the message to this seat is a plain store question the governed workflows answer.
 * Used so that "check stock of milk" goes to the specialist, while a genuine investigation
 * ("why does the count not match") still goes to the verified work pipeline.
 */
export function isStoreQuestion(runtime, seatId, message) {
  if (!specialistProfile(runtime, seatId) || typeof message !== "string") return false;
  const nammaops = runtime.nammaops;
  return Boolean(
    businessIntent(message.trim(), {
      today: nammaops.workflows.today(),
      seats: (nammaops.voice.departments.seats ?? []).map((d) => d.voice_name),
    }),
  );
}
