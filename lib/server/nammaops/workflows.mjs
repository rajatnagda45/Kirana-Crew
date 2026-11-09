import { randomBytes } from "node:crypto";
import Ajv from "ajv";
import {
  aggregateSales,
  analyseStock,
  groupOrders,
  rankSuppliers,
  resolveProducts,
  stockByItem,
} from "./calculations.mjs";
import { forecastItem, addDays as addUtcDays } from "./forecast.mjs";
import { currentWorkforce } from "./workforce.mjs";
import {
  V2_INTENTS,
  V2_RUNNERS,
  keyFiguresV2,
  parseBillRequest,
  parseV2,
  summarizeV2,
} from "./workflows-v2.mjs";

export const WORKFLOW_NAMESPACE = "nammaops.workflow";
export const TASK_NAMESPACE = "nammaops.task";
export const INTENTS = [
  "stock_check",
  "prepare_reorder",
  "daily_report",
  "demand_forecast",
  "supplier_comparison",
  ...V2_INTENTS,
];
const TERMINAL = new Set(["completed", "failed", "stopped", "interrupted", "outcome_unknown"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads a long date range in short slices, so no single governed tool response approaches the
 * gateway's size cap on a busy store. Slices are consecutive and non-overlapping. A few slices are
 * read at once (each is still its own governed, audited call); rows keep slice order, and any
 * failed slice fails the read, as before.
 */
export const SLICE_CONCURRENCY = 3;
async function readSlices(call, businessId, from, to, key, days = 7) {
  const ranges = [];
  for (let start = from; start <= to; start = addUtcDays(start, days)) {
    const end = addUtcDays(start, days - 1);
    ranges.push({ from_date: start, to_date: end < to ? end : to });
  }
  const parts = new Array(ranges.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(SLICE_CONCURRENCY, ranges.length) }, async () => {
      while (!failed && next < ranges.length) {
        const index = next++;
        try {
          parts[index] = (await call(businessId, ranges[index]))[key] ?? [];
        } catch (error) {
          failed = true; // no new slices after a failure
          throw error;
        }
      }
    }),
  );
  return parts.flat();
}

const fail = (status, message, body) =>
  Object.assign(new Error(message), { status, ...(body ? { body } : {}) });
const id = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const localDate = (date) => date.toLocaleDateString("en-CA");
const addDays = (day, days) => {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};

const validateIntent = new Ajv({ allErrors: true }).compile({
  type: "object",
  properties: {
    action: { enum: INTENTS },
    products: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 60 },
    },
    date: { type: "string", pattern: DATE.source },
    /** Last day (inclusive) of a multi-day sales report; absent for a single day. */
    to: { type: "string", pattern: DATE.source },
    /** daily_report only: false answers a sales question without reading the posted P&L. */
    with_profit: { type: "boolean" },
    /** receivables_report only: udhaar raised in the period ("new") or falling due soon. */
    focus: { enum: ["new", "due_soon"] },
    qty: { type: "integer", minimum: 1, maximum: 100000 },
    /** purchase_order_lookup only: the ERPNext purchase order id. */
    po_name: { type: "string", pattern: "^[A-Za-z0-9 _.-]{1,64}$" },
    /** prepare_bill only: a named customer (else the walk-in customer) and what they bought. */
    customer: { type: "string", minLength: 1, maxLength: 140 },
    lines: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          product: { type: "string", minLength: 1, maxLength: 60 },
          quantity: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          unit: { type: "string", maxLength: 12 },
        },
        required: ["product"],
        additionalProperties: false,
      },
    },
  },
  required: ["action"],
  additionalProperties: false,
});

export const MAX_REPORT_DAYS = 31;

/** Sales per calendar day for a range, including days with no sales (so a gap is visible). */
export function perDay(invoices, from, to) {
  const days = new Map();
  for (let day = from; day <= to; day = addDays(day, 1))
    days.set(day, { date: day, total: 0, transactions: 0 });
  for (const invoice of invoices) {
    const row = days.get(invoice.posting_date);
    if (!row) continue;
    row.total = Math.round((row.total + Number(invoice.grand_total ?? 0)) * 100) / 100;
    row.transactions += 1;
  }
  return [...days.values()];
}
const dayOfWeek = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const monthStart = (day) => `${day.slice(0, 7)}-01`;
const daysBetweenDays = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORD =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const monthNumber = (word) => MONTHS.indexOf(word.slice(0, 3)) + 1;

/** A real calendar date as YYYY-MM-DD, or null (so "31 feb" is not a date). */
function isoDay(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
}

/**
 * Every explicit day named in the text, in order: 2026-11-02, 2/11 (day first, as in India),
 * "2 nov", "2nd of november", "nov 2", "monday", "last friday", "the 3rd", "day before yesterday".
 * A day without a year is this year, or last year when this year's date is more than a month ahead.
 */
export function parseDays(lower, today) {
  const year = Number(today.slice(0, 4));
  const found = [];
  const add = (index, value) => value && found.push({ index, value });
  const resolve = (month, day, explicitYear) => {
    if (explicitYear !== undefined) {
      const y = explicitYear < 100 ? 2000 + explicitYear : explicitYear;
      return isoDay(y, month, day);
    }
    const here = isoDay(year, month, day);
    if (here && here > today && daysBetweenDays(today, here) > 31)
      return isoDay(year - 1, month, day);
    return here;
  };
  for (const m of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    add(m.index, isoDay(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of lower.matchAll(/(?<![\d-])(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?![\d-])/g))
    add(m.index, resolve(Number(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined));
  for (const m of lower.matchAll(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_WORD}\\b(?:\\s*,?\\s*(\\d{4}))?`,
      "g",
    ),
  ))
    add(m.index, resolve(monthNumber(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined));
  for (const m of lower.matchAll(
    new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4}))?`, "g"),
  ))
    add(m.index, resolve(monthNumber(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined));
  for (const m of lower.matchAll(/\bday before yesterday\b/g)) add(m.index, addDays(today, -2));
  for (const m of lower.matchAll(
    /\b(?:(last|previous|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g,
  )) {
    const target = WEEKDAYS.indexOf(m[2]);
    let back = (dayOfWeek(today) - target + 7) % 7;
    if (back === 0 && (m[1] === "last" || m[1] === "previous")) back = 7;
    add(m.index, addDays(today, -back));
  }
  for (const m of lower.matchAll(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/g)) {
    const day = Number(m[1]);
    let value = isoDay(year, Number(today.slice(5, 7)), day);
    if (value && value > today) {
      const prior = addDays(`${today.slice(0, 7)}-01`, -1);
      value = isoDay(Number(prior.slice(0, 4)), Number(prior.slice(5, 7)), day);
    }
    add(m.index, value);
  }
  // Drop a day that sits inside another match (the "3" of "3rd nov" is not also "the 3rd").
  const unique = [
    ...new Map(found.sort((a, b) => a.index - b.index).map((d) => [d.value, d])).values(),
  ];
  return unique.map((d) => d.value);
}

/** True when the text names a date-like thing that parseDays could not read. */
export function hasUnreadableDate(lower) {
  return (
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_WORD}\\b`).test(lower) ||
    new RegExp(`\\b${MONTH_WORD}\\s+\\d{1,2}\\b`).test(lower) ||
    /(?<![\d-])\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?(?![\d-])/.test(lower) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(lower)
  );
}

/**
 * Multi-day wording -> { from, to } (inclusive), or null for a single day. "last/previous/past N
 * days" are the N complete days before today (today is still in progress); weeks run Monday to
 * Sunday; "this week/month" end today.
 */
export function parseDateRange(lower, today) {
  const days = /\b(?:last|previous|past|prior)\s+(\d{1,2})\s+days?\b/.exec(lower);
  if (days) {
    const n = Math.min(Number(days[1]), MAX_REPORT_DAYS);
    return n >= 2 ? { from: addDays(today, -n), to: addDays(today, -1) } : null;
  }
  const back = (dayOfWeek(today) + 6) % 7; // days since Monday
  if (/\bthis week\b/.test(lower)) return { from: addDays(today, -back), to: today };
  if (/\b(?:last|previous|past) week\b/.test(lower))
    return { from: addDays(today, -back - 7), to: addDays(today, -back - 1) };
  if (/\bthis month\b/.test(lower)) return { from: monthStart(today), to: today };
  if (/\b(?:last|previous|past) month\b/.test(lower)) {
    const last = addDays(monthStart(today), -1);
    return { from: monthStart(last), to: last };
  }
  return null;
}

/**
 * Normalized owner text -> one of three intents. Deterministic on purpose: an unrecognised
 * request is refused with an explanation rather than mapped to an arbitrary operation.
 */
export function parseCommand(text, today) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 500) throw fail(400, "Command must be 1-500 characters.");
  const lower = raw.toLowerCase();
  if (/\b(delete|remove|cancel|adjust|change|update|pay|refund)\b/.test(lower))
    throw fail(
      422,
      "That operation is not supported. NammaOps can check stock, forecast demand, compare supplier quotations, prepare a reorder for approval, or report a day's business.",
    );
  const v2 = parseV2(lower);
  if (v2?.action === "prepare_bill") {
    const { customer, lines } = parseBillRequest(raw);
    return { ...v2, ...(customer ? { customer } : {}), lines };
  }
  if (
    v2?.action === "billing_summary" ||
    v2?.action === "payments_summary" ||
    v2?.action === "gst_summary"
  ) {
    const range = parseDateRange(lower, today);
    if (range) return { ...v2, date: range.from, to: range.to };
    const days = parseDays(lower, today).sort();
    if (days.length)
      return { ...v2, date: days[0], ...(days.length > 1 ? { to: days[days.length - 1] } : {}) };
    if (hasUnreadableDate(lower))
      throw fail(422, "I could not read that date. Try a day like 2 Nov, 2/11, or 2026-11-02.");
    // No date named: payments and GST cover the month so far (the runner's default); a bill count
    // defaults to today.
    if (v2.action !== "billing_summary" && !/\b(today|yesterday)\b/.test(lower)) return v2;
    return { ...v2, date: /\byesterday\b/.test(lower) ? addDays(today, -1) : today };
  }
  if (v2?.action === "business_report") {
    // "weekly report" = last 7 days, "monthly" = last 30, "report for last week" etc. via the date parser.
    const range = parseDateRange(lower, today);
    if (range) return { ...v2, date: range.from, to: range.to };
    if (/\bmonth(?:ly)?\b/.test(lower))
      return { ...v2, date: addDays(today, -30), to: addDays(today, -1) };
    return v2;
  }
  if (v2) return v2;
  if (/\b(forecast|predict|next week|next month|will sell|demand)\b/.test(lower))
    return { action: "demand_forecast", products: [] };
  const stockOf =
    /\bstock (?:of|for|levels? of)\s+([^.?!]+)/.exec(lower) ??
    /\bcheck\s+(?:the\s+)?([^.?!]+?)\s+stock\b/.exec(lower);
  if (stockOf || /\b(check|show)\b.*\b(stock|inventory)\b/.test(lower)) {
    const products = (stockOf?.[1] ?? "")
      .split(/,|\band\b|&/)
      .map((part) => part.replace(/\b(the|our|my|of)\b/g, "").trim())
      .filter(Boolean);
    return { action: "stock_check", products };
  }
  if (
    /\b(prepare|place|create|make|raise)\b.*\b(order|purchase)\b|\breorder\b|\brunning low\b/.test(
      lower,
    )
  )
    return { action: "prepare_reorder", products: [] };
  // After reorder: "prepare an order ... choose the cheapest supplier" is a reorder, not a comparison.
  const supplierFor =
    /\b(compare|cheapest|best|which)\b.*\b(suppliers?|quotations?|vendors?)\b/.test(lower)
      ? (/\b(?:for|of)\s+([^.?!]+)$/.exec(lower) ?? [])
      : null;
  if (supplierFor)
    return {
      action: "supplier_comparison",
      products: (supplierFor[1] ?? "")
        .split(/,|\band\b|&/)
        .map((part) => part.replace(/\b(the|our|my|of)\b/g, "").trim())
        .filter(Boolean),
    };
  if (/\b(business|sales|sold|sell|sells|selling|profit|revenue|report)\b/.test(lower)) {
    const range = parseDateRange(lower, today);
    if (range) return { action: "daily_report", date: range.from, to: range.to };
    const days = parseDays(lower, today).sort();
    // "from 2 nov to 4 nov" / "between the 1st and the 3rd": the first and last day named.
    if (days.length >= 2)
      return { action: "daily_report", date: days[0], to: days[days.length - 1] };
    if (days.length === 1) return { action: "daily_report", date: days[0] };
    // Never answer for today when the owner named a date that could not be read.
    if (hasUnreadableDate(lower))
      throw fail(422, "I could not read that date. Try a day like 2 Nov, 2/11, or 2026-11-02.");
    return {
      action: "daily_report",
      date: /\byesterday\b/.test(lower) ? addDays(today, -1) : today,
    };
  }
  throw fail(
    422,
    "I can check stock, forecast demand, compare suppliers, prepare a reorder for your approval, report a day's business, list pending udhaar, check expiring stock, track purchase orders and supplier delays, analyse customers, or list the shop's biggest problems. Please rephrase.",
  );
}

/**
 * One generic runner for the three NammaOps workflows. Specialist steps run as child tasks under
 * each agent's own identity through the governed gateway; numbers come from deterministic
 * calculations over the returned ERP data. Optional reasoning makes one OpenClaw Manager turn.
 */
export class Workflows {
  /** @param {any} runtime @param {{binding: any, approvals: any, reasoning?: string,
   *  reasoningTimeoutMs?: number, today?: () => string}} options */
  constructor(
    runtime,
    { binding, approvals, reasoning = "off", reasoningTimeoutMs = 15 * 60 * 1000, today },
  ) {
    this.runtime = runtime;
    this.binding = binding;
    this.approvals = approvals;
    this.reasoning = reasoning;
    this.reasoningTimeoutMs = reasoningTimeoutMs;
    this.today = today ?? (() => localDate(new Date()));
  }

  get db() {
    return this.runtime.db;
  }

  view(workflowId) {
    const record = this.db.record(WORKFLOW_NAMESPACE, workflowId);
    if (!record) return null;
    return { ...record, tasks: this.tasks(workflowId) };
  }

  /**
   * The bill request still waiting for an answer: the newest workflow, a bill that needs
   * clarification, started in the last 15 minutes. A short reply ("2") completes it (see
   * applyBillAnswer); anything older, or after another request, is a fresh conversation.
   */
  pendingBillClarification(now = Date.now()) {
    const [latest] = this.list();
    if (
      !latest ||
      latest.status !== "needs_clarification" ||
      latest.intent?.action !== "prepare_bill" ||
      now - Date.parse(latest.created_at) > 15 * 60 * 1000
    )
      return null;
    const view = this.view(latest.id);
    return view?.clarifications?.length
      ? { intent: view.intent, clarifications: view.clarifications }
      : null;
  }

  tasks(workflowId) {
    return this.db.records(TASK_NAMESPACE).filter((row) => row.workflow_id === workflowId);
  }

  list() {
    return this.db
      .records(WORKFLOW_NAMESPACE)
      .slice(-50)
      .reverse()
      .map(({ id: workflowId, intent, status, created_at, finished_at, summary, error }) => ({
        id: workflowId,
        intent,
        status,
        created_at,
        finished_at,
        summary,
        // Present only on blocked, failed or interrupted runs, so a history row can say why.
        ...(error ? { error } : {}),
      }));
  }

  /**
   * Called once when the server starts. A run still `running` from before this process booted can
   * never finish (its worker died with the old process), so it is closed honestly:
   *   - `interrupted` for the read-only workflows (nothing was changed);
   *   - `outcome_unknown` for `prepare_bill`, whose ERP draft may or may not have been created.
   * Never `completed`. Its running steps become `uncertain`, a timeline event records what
   * happened, and `awaiting_approval` runs are left alone (approvals survive a restart). Runs that
   * began after this process booted are skipped, so a second call cannot touch live work.
   * @returns {number} how many runs were closed
   */
  recover({ bootedAt = Date.now() - process.uptime() * 1000 } = {}) {
    const stamp = new Date().toISOString();
    let closed = 0;
    for (const record of this.db.records(WORKFLOW_NAMESPACE)) {
      if (record.status !== "running") continue;
      const started = Date.parse(record.created_at);
      if (!Number.isFinite(started) || started >= bootedAt) continue;
      const writes = record.intent?.action === "prepare_bill";
      const status = writes ? "outcome_unknown" : "interrupted";
      const error = writes
        ? "The server restarted while this ran. A draft bill may or may not have been created; check the ERP before trying again."
        : "The server restarted while this ran, so it did not finish. Nothing was changed.";
      for (const task of this.db.records(TASK_NAMESPACE)) {
        if (task.workflow_id !== record.id || task.status !== "running") continue;
        const { id: taskId, revision, ...rest } = task;
        this.db.saveRecord(
          TASK_NAMESPACE,
          taskId,
          { ...rest, status: "uncertain", error, finished_at: stamp },
          revision,
        );
      }
      this.save(
        record.id,
        { status, error, finished_at: stamp },
        { type: "WORKFLOW_INTERRUPTED", agent: "manager", detail: error },
      );
      closed += 1;
    }
    return closed;
  }

  save(workflowId, patch, event) {
    const current = this.db.record(WORKFLOW_NAMESPACE, workflowId);
    const { revision } = current;
    const rest = { ...current };
    delete rest.id;
    delete rest.revision;
    return this.db.saveRecord(
      WORKFLOW_NAMESPACE,
      workflowId,
      {
        ...rest,
        ...patch,
        timeline: event
          ? [...rest.timeline, { at: new Date().toISOString(), ...event }]
          : rest.timeline,
      },
      revision,
    );
  }

  /**
   * Validate and persist, then run in the background. `done` resolves with the final view.
   * `origin` is set only by server code (the voice router), never from a request body.
   */
  start(input, { origin } = {}) {
    const workforce = currentWorkforce(this.runtime);
    let intent;
    if (input?.intent !== undefined) {
      if (!validateIntent(input.intent)) throw fail(400, "Invalid intent.");
      intent = { ...input.intent };
    } else intent = parseCommand(input?.text, this.today());
    if (intent.action === "purchase_order_lookup" && !intent.po_name)
      throw fail(
        400,
        "Which purchase order? Give the purchase order number, like PUR-ORD-2026-00004.",
      );
    if (
      (intent.action === "business_report" ||
        intent.action === "billing_summary" ||
        intent.action === "payments_summary" ||
        intent.action === "gst_summary" ||
        intent.action === "receivables_report") &&
      intent.date !== undefined
    ) {
      const today = this.today();
      intent.to ??= intent.date;
      if (intent.to > today) intent.to = today;
      if (intent.date > intent.to) throw fail(400, "The report end date is before its start date.");
      if (daysBetweenDays(intent.date, intent.to) + 1 > MAX_REPORT_DAYS)
        throw fail(400, `A report covers at most ${MAX_REPORT_DAYS} days.`);
    }
    if (intent.action === "daily_report") {
      intent.date ??= this.today();
      if (intent.to !== undefined) {
        // A range is clamped to today (the future has no sales) and capped; a one-day range is a day.
        const today = this.today();
        if (intent.to > today) intent.to = today;
        if (intent.to < intent.date)
          throw fail(400, "The report end date is before its start date.");
        if (daysBetweenDays(intent.date, intent.to) + 1 > MAX_REPORT_DAYS)
          throw fail(400, `A sales report covers at most ${MAX_REPORT_DAYS} days.`);
        if (intent.to === intent.date) delete intent.to;
      }
    }
    const workflowId = id("wf");
    this.db.saveRecord(
      WORKFLOW_NAMESPACE,
      workflowId,
      {
        intent,
        command: typeof input?.text === "string" ? input.text.slice(0, 500) : null,
        ...(origin ? { origin } : {}),
        status: "running",
        created_at: new Date().toISOString(),
        finished_at: null,
        result: null,
        summary: null,
        reasoning: { mode: this.reasoning, status: this.reasoning === "off" ? "off" : "pending" },
        timeline: [
          {
            at: new Date().toISOString(),
            type: "WORKFLOW_STARTED",
            agent: "manager",
            detail: intent.action,
          },
        ],
      },
      0,
    );
    const done = this.execute(workflowId, intent, workforce).then(() => this.view(workflowId));
    return { workflow: this.view(workflowId), done };
  }

  /** A specialist step: a child task whose every ERP read is a governed call as that agent. */
  async step(workflowId, workforce, role, title, work, { optional = false } = {}) {
    const agent = workforce.agents[role];
    const taskId = id("nt");
    const task = {
      workflow_id: workflowId,
      role,
      agent_id: agent?.agent_id ?? null,
      agent_name: agent?.name ?? role,
      title,
      status: "running",
      started_at: new Date().toISOString(),
      evidence: [],
    };
    this.db.saveRecord(TASK_NAMESPACE, taskId, task, 0);
    this.save(
      workflowId,
      {},
      { type: `${role.toUpperCase()}_TASK_STARTED`, agent: role, detail: title },
    );
    const evidence = [];
    const call = async (businessId, args) => {
      if (!agent)
        throw Object.assign(fail(409, `${role} agent is not configured.`), {
          workflowStatus: "blocked",
        });
      const out = await this.binding.call(agent.agent_id, businessId, args, {
        taskId,
        correlationId: workflowId,
      });
      evidence.push({ business_capability: businessId, invocation_id: out.invocation_id });
      return out.data;
    };
    const finish = (patch) => {
      const current = this.db.record(TASK_NAMESPACE, taskId);
      this.db.saveRecord(
        TASK_NAMESPACE,
        taskId,
        { ...task, ...patch, evidence, finished_at: new Date().toISOString() },
        current.revision,
      );
    };
    try {
      const out = await work({ call, agent });
      finish({ status: "completed", summary: out?.summary ?? null });
      this.save(
        workflowId,
        {},
        {
          type: `${role.toUpperCase()}_TASK_COMPLETED`,
          agent: role,
          detail: out?.summary ?? title,
        },
      );
      return { ok: true, ...out, evidence };
    } catch (error) {
      const status = error.workflowStatus ?? "failed";
      finish({ status, error: error.message });
      this.save(
        workflowId,
        {},
        {
          type: `${role.toUpperCase()}_TASK_${status.toUpperCase()}`,
          agent: role,
          detail: error.message,
        },
      );
      if (optional) return { ok: false, status, error: error.message, evidence };
      throw Object.assign(error, { workflowStatus: status });
    }
  }

  async execute(workflowId, intent, workforce) {
    try {
      const outcome = V2_RUNNERS[intent.action]
        ? await V2_RUNNERS[intent.action](this, workflowId, intent, workforce)
        : intent.action === "stock_check"
          ? await this.stockCheck(workflowId, intent, workforce)
          : intent.action === "prepare_reorder"
            ? await this.prepareReorder(workflowId, intent, workforce)
            : intent.action === "demand_forecast"
              ? await this.demandForecast(workflowId, intent, workforce)
              : intent.action === "supplier_comparison"
                ? await this.supplierComparison(workflowId, intent, workforce)
                : await this.dailyReport(workflowId, intent, workforce);
      await this.consolidate(workflowId, workforce, outcome);
    } catch (error) {
      this.save(
        workflowId,
        {
          status: error.workflowStatus ?? "failed",
          error: error.message,
          finished_at: new Date().toISOString(),
        },
        { type: "WORKFLOW_STOPPED", agent: "manager", detail: error.message },
      );
    }
  }

  async readStock(workflowId, workforce, products) {
    return this.step(
      workflowId,
      workforce,
      "inventory",
      "Read stock and compare with reorder levels",
      async ({ call }) => {
        const { items } = await call("erp.items.list", {});
        let selected = items;
        if (products?.length) {
          const { resolved, clarifications } = resolveProducts(products, items);
          if (clarifications.length)
            return { clarifications, summary: "Some products need clarification." };
          // A category and one of its items may both be named; read each item once.
          selected = [...new Map(resolved.map((row) => [row.item.item_code, row.item])).values()];
        }
        const { bins } = await call("erp.stock.balance", {});
        const analysis = analyseStock(selected, stockByItem(bins));
        return {
          items,
          analysis,
          summary: `${analysis.rows.length} product(s) checked; ${analysis.low.length} at or below reorder level.`,
        };
      },
    );
  }

  async rankForLow(workflowId, workforce, low, { optional }) {
    return this.step(
      workflowId,
      workforce,
      "procurement",
      "Compare suppliers for low-stock products",
      async ({ call }) => {
        const { suppliers } = await call("erp.suppliers.list", {});
        const { quotations } = await call("erp.supplier_quotations.list", {});
        const rankings = low.map((row) =>
          rankSuppliers(row.item_code, row.recommended_qty, quotations, suppliers, this.today()),
        );
        return {
          rankings,
          summary: `${rankings.filter((row) => row.choice).length} of ${rankings.length} item(s) have a suitable supplier.`,
        };
      },
      { optional },
    );
  }

  async stockCheck(workflowId, intent, workforce) {
    const stock = await this.readStock(workflowId, workforce, intent.products);
    if (stock.clarifications)
      return { status: "needs_clarification", clarifications: stock.clarifications };
    const low = stock.analysis.low;
    const procurement = low.length
      ? await this.rankForLow(workflowId, workforce, low, { optional: true })
      : null;
    return {
      status: procurement && !procurement.ok ? "partial" : "completed",
      result: {
        kind: "stock_check",
        rows: stock.analysis.rows,
        low,
        recommendations: procurement?.ok ? procurement.rankings : null,
        recommendations_status: procurement
          ? procurement.ok
            ? "available"
            : procurement.error
          : "not_needed",
      },
    };
  }

  async prepareReorder(workflowId, intent, workforce) {
    const stock = await this.readStock(workflowId, workforce, intent.products);
    if (stock.clarifications)
      return { status: "needs_clarification", clarifications: stock.clarifications };
    const low = stock.analysis.low;
    if (!low.length)
      return {
        status: "completed",
        result: {
          kind: "prepare_reorder",
          low: [],
          orders: [],
          note: "No product is at or below its reorder level.",
        },
      };
    const ranked = await this.rankForLow(workflowId, workforce, low, { optional: false });
    const orders = groupOrders(ranked.rankings);
    const unplaced = ranked.rankings
      .filter((row) => !row.choice)
      .map((row) => ({ item_code: row.item_code, reason: row.blocker }));
    const drafted = await this.step(
      workflowId,
      workforce,
      "procurement",
      "Create draft purchase orders",
      async ({ call }) => {
        const drafts = [];
        for (const order of orders) {
          const created = await call("erp.po.create_draft", {
            supplier: order.supplier,
            schedule_date: addDays(this.today(), 1),
            items: order.items,
          });
          const confirmed = await call("erp.po.get", { name: created.purchase_order.name });
          drafts.push(confirmed.purchase_order);
        }
        return { drafts, summary: `${drafts.length} draft purchase order(s) created in ERP.` };
      },
    );
    const approvals = drafted.drafts.map((po) => {
      const approval = this.approvals.request({ workflowId, purchaseOrder: po });
      this.save(
        workflowId,
        {},
        {
          type: "PURCHASE_ORDER_DRAFT_CREATED",
          agent: "procurement",
          detail: `${po.name} for ${po.supplier}, total ${po.grand_total}; awaiting owner approval ${approval.id}`,
          document: po.name,
        },
      );
      return approval.id;
    });
    return {
      status: approvals.length ? "awaiting_approval" : "completed",
      result: {
        kind: "prepare_reorder",
        low,
        rankings: ranked.rankings,
        orders: drafted.drafts,
        unplaced,
        approvals,
      },
    };
  }

  /**
   * Historical-demand forecast: Sales reads submitted sales lines, Inventory reads stock and the
   * stock ledger, Procurement reads incoming orders and supplier lead times; the numbers come
   * from the deterministic forecast engine, never from a model.
   */
  async demandForecast(workflowId, intent, workforce) {
    const today = this.today();
    const from = addUtcDays(today, -90);
    const to = addUtcDays(today, -1);
    const readSupply = () =>
      this.step(
        workflowId,
        workforce,
        "procurement",
        "Read incoming purchase orders and supplier lead times",
        async ({ call }) => {
          const [{ purchase_orders }, { suppliers }, { quotations }] = await Promise.all([
            call("erp.po.open", {}),
            call("erp.suppliers.list", {}),
            call("erp.supplier_quotations.list", {}),
          ]);
          return {
            purchase_orders,
            suppliers,
            quotations,
            summary: `${purchase_orders.length} open purchase order(s), ${quotations.length} quotation line(s).`,
          };
        },
        { optional: true },
      );
    // Sales history and stock are independent, so their steps run together. Procurement joins
    // them only when no products are named: a named product may need clarification first, and
    // then no supplier data should be read.
    // step() records its task synchronously, so call order keeps the task list order
    // (sales, inventory, procurement) the same as the serial version.
    const reads = Promise.allSettled([
      this.step(
        workflowId,
        workforce,
        "sales",
        `Read sales history ${from} to ${to}`,
        async ({ call }) => {
          const lines = await readSlices(call, "erp.sales.history", from, to, "lines");
          const documents = new Set(lines.map((line) => line.document));
          return {
            lines,
            summary: `${lines.length} sales line(s) from ${documents.size} submitted invoice(s).`,
          };
        },
      ),
      this.step(
        workflowId,
        workforce,
        "inventory",
        "Read stock balances and the stock ledger",
        async ({ call }) => {
          const [{ items }, { bins }, entries] = await Promise.all([
            call("erp.items.list", {}),
            call("erp.stock.balance", {}),
            // 3-day slices: a 7-day ledger slice reached 257 KB against the gateway's 256 KB cap
            // on this store, so a slightly busier week would have failed the whole forecast.
            readSlices(call, "erp.stock.movements", from, today, "entries", 3),
          ]);
          return {
            items,
            bins,
            entries,
            summary: `${items.length} item(s), ${entries.length} stock ledger entries.`,
          };
        },
      ),
    ]);
    const early = intent.products?.length ? null : readSupply();
    const [salesRead, stockRead] = await reads;
    // Same failure order as the serial version: a sales failure is reported first.
    if (salesRead.status === "rejected") {
      await early;
      throw salesRead.reason;
    }
    if (stockRead.status === "rejected") {
      await early;
      throw stockRead.reason;
    }
    const sales = salesRead.value;
    const stock = stockRead.value;
    let selected = stock.items;
    if (intent.products?.length) {
      const { resolved, clarifications } = resolveProducts(intent.products, stock.items);
      if (clarifications.length) return { status: "needs_clarification", clarifications };
      selected = resolved.map((row) => row.item);
    }
    const supply = await (early ?? readSupply());
    const balances = stockByItem(stock.bins);
    const items = selected.map((item) => {
      const incoming = [];
      for (const po of supply.ok ? supply.purchase_orders : [])
        for (const row of po.items)
          if (row.item_code === item.item_code && row.pending_qty > 0)
            incoming.push({ document: po.name, qty: row.pending_qty, expected: po.schedule_date });
      const leadTimes = supply.ok
        ? supply.quotations
            .filter((row) => row.item_code === item.item_code)
            .map(
              (row) =>
                row.lead_time_days ??
                supply.suppliers.find((supplier) => supplier.name === row.supplier)?.lead_time_days,
            )
            .filter((value) => Number.isFinite(value))
        : [];
      const result = forecastItem({
        item,
        lines: sales.lines,
        ledger: stock.entries,
        today,
        available: balances.get(item.item_code)?.qty ?? 0,
        incoming: incoming.reduce((sum, row) => sum + row.qty, 0),
        incomingRefs: incoming.map((row) => row.document),
        leadTimeDays: leadTimes.length ? Math.min(...leadTimes) : undefined,
      });
      const qty = result.recommendation?.suggested_qty;
      const suppliers =
        supply.ok && qty > 0
          ? rankSuppliers(item.item_code, qty, supply.quotations, supply.suppliers, today)
          : null;
      return { ...result, incoming, supplier_comparison: suppliers };
    });
    items.sort((a, b) => (b.forecast?.next_7_days ?? -1) - (a.forecast?.next_7_days ?? -1));
    return {
      status: supply.ok ? "completed" : "partial",
      result: {
        kind: "demand_forecast",
        label: "Historical-demand forecast (not a market prediction)",
        as_of: today,
        history_window: { from, to },
        items,
        supply_status: supply.ok ? "available" : supply.error,
      },
    };
  }

  /**
   * Supplier quotation comparison for named products: Inventory resolves the products, Procurement
   * reads quotations, suppliers and buying prices, and `rankSuppliers` ranks them (the same rules a
   * reorder uses). Quantity is the owner's, else the item's reorder quantity; the basis is stated.
   */
  async supplierComparison(workflowId, intent, workforce) {
    if (!intent.products?.length)
      return {
        status: "needs_clarification",
        clarifications: [{ requested: "", reason: "missing_product", options: [] }],
      };
    const catalogue = await this.step(
      workflowId,
      workforce,
      "inventory",
      "Identify the products to compare",
      async ({ call }) => {
        const { items } = await call("erp.items.list", {});
        const { resolved, clarifications } = resolveProducts(intent.products, items);
        return { resolved, clarifications, summary: `${resolved.length} product(s) identified.` };
      },
    );
    if (catalogue.clarifications.length)
      return { status: "needs_clarification", clarifications: catalogue.clarifications };
    const today = this.today();
    const compared = await this.step(
      workflowId,
      workforce,
      "procurement",
      "Compare supplier quotations",
      async ({ call }) => {
        const { suppliers } = await call("erp.suppliers.list", {});
        const { quotations } = await call("erp.supplier_quotations.list", {});
        const { prices } = await call("erp.item_prices.get", {});
        const items = catalogue.resolved.map(({ item }) => {
          const reorderQty = Number(item.reorder_qty) > 0 ? Number(item.reorder_qty) : null;
          const qty = intent.qty ?? reorderQty ?? 1;
          const listPrice = prices.find((row) => row.item_code === item.item_code);
          return {
            item_name: item.item_name,
            qty_basis: intent.qty ? "requested" : reorderQty ? "reorder_quantity" : "one_unit",
            list_price: listPrice
              ? { rate: Number(listPrice.rate), price_list: listPrice.price_list ?? null }
              : null,
            ...rankSuppliers(item.item_code, qty, quotations, suppliers, today),
          };
        });
        return {
          items,
          summary: `${items.filter((row) => row.choice).length} of ${items.length} product(s) have a suitable quotation.`,
        };
      },
    );
    return {
      status: "completed",
      result: { kind: "supplier_comparison", as_of: today, items: compared.items },
    };
  }

  async dailyReport(workflowId, intent, workforce) {
    const ranged = intent.to !== undefined && intent.to !== intent.date;
    const period = { from_date: intent.date, to_date: ranged ? intent.to : intent.date };
    const label = ranged ? `${intent.date} to ${intent.to}` : intent.date;
    const sales = await this.step(
      workflowId,
      workforce,
      "sales",
      `Read sales for ${label}`,
      async ({ call }) => {
        // A range is read in 7-day slices so no single governed response gets large.
        const read = async (capability) =>
          ranged
            ? readSlices(call, capability, period.from_date, period.to_date, "invoices")
            : (await call(capability, period)).invoices;
        const invoices = await read("erp.sales_invoices.list");
        const pos = await read("erp.pos_invoices.list");
        const { items } = await call("erp.items.list", {});
        const all = [...invoices, ...pos];
        const totals = aggregateSales(all, items);
        const byDay = ranged ? perDay(all, period.from_date, period.to_date) : undefined;
        return {
          totals,
          byDay,
          summary: `${totals.transaction_count} transaction(s), total ${totals.total_sales}.`,
        };
      },
    );
    // A plain sales question does not read the P&L: no extra ERP calls, no accounting caveats.
    const wantProfit = intent.with_profit !== false;
    const finance = wantProfit
      ? await this.step(
          workflowId,
          workforce,
          "finance",
          `Read posted profit and loss for ${label}`,
          async ({ call }) => {
            const pnl = await call("erp.pnl", period);
            return { pnl, summary: `Net profit ${pnl.net_profit} from the posted P&L.` };
          },
          { optional: true },
        )
      : { ok: false, skipped: true };
    const profit = !wantProfit
      ? { status: "not_requested" }
      : finance.ok
        ? {
            status: "verified",
            net_profit: finance.pnl.net_profit,
            income: finance.pnl.income,
            expense: finance.pnl.expense,
            source: "Profit and Loss report",
          }
        : { status: "unverified", reason: finance.error };
    const warnings = [];
    if (
      finance.ok &&
      Math.abs(finance.pnl.income - sales.totals.total_sales) >
        Math.max(1, sales.totals.total_sales * 0.01)
    )
      warnings.push(
        `Posted income ${finance.pnl.income} differs from invoice total ${sales.totals.total_sales}; check unposted or returned invoices.`,
      );
    // A negative expense or a profit with no income is a posting that is not trading, such as a
    // stock adjustment. The figure is the posted one, but it must not read as a day's trading profit.
    if (
      finance.ok &&
      (finance.pnl.expense < 0 || (finance.pnl.income === 0 && finance.pnl.net_profit !== 0))
    )
      warnings.push(
        `The posted figures include non-trading postings (income ${finance.pnl.income}, expense ${finance.pnl.expense}), for example a stock adjustment. Net profit ${finance.pnl.net_profit} is not profit from sales.`,
      );
    return {
      status: finance.ok || finance.skipped ? "completed" : "partial",
      result: {
        kind: "daily_report",
        period,
        ...sales.totals,
        ...(ranged ? { by_day: sales.byDay } : {}),
        profit,
        warnings,
        data_status: { sales: "available", profit: profit.status },
        sources: {
          invoices: sales.totals.invoice_refs,
          profit: finance.ok ? "Profit and Loss report" : null,
        },
      },
    };
  }

  /** The Manager's consolidation: a deterministic summary, plus one optional OpenClaw turn. */
  async consolidate(workflowId, workforce, outcome) {
    const summary = await this.step(
      workflowId,
      workforce,
      "manager",
      "Consolidate the result for the owner",
      async () => ({
        summary: summarize(outcome),
      }),
    );
    let reasoning = { mode: this.reasoning, status: "off" };
    if (
      this.reasoning === "manager" &&
      ["completed", "partial", "awaiting_approval"].includes(outcome.status)
    )
      reasoning = await this.reason(workflowId, workforce, outcome);
    this.save(
      workflowId,
      {
        status: outcome.status,
        result: outcome.result ?? null,
        clarifications: outcome.clarifications ?? null,
        summary: summary.summary,
        reasoning,
        finished_at: outcome.status === "awaiting_approval" ? null : new Date().toISOString(),
      },
      {
        type: `WORKFLOW_${outcome.status.toUpperCase()}`,
        agent: "manager",
        detail: summary.summary,
      },
    );
  }

  /** One OpenClaw Manager turn over the evidence. Its numbers must match, or it is discarded. */
  async reason(workflowId, workforce, outcome) {
    const manager = workforce.agents.manager;
    const facts = keyFigures(outcome.result);
    try {
      const task = await this.runtime.agentTasks.submitText({
        agent_id: manager.agent_id,
        input: {
          type: "text",
          text:
            `Write a short reply for the kirana store owner from these verified facts. Do not call tools. ` +
            `Reply with JSON only: {"reply": string, "figures": ${JSON.stringify(Object.keys(facts))} mapped to numbers}.\n` +
            `Facts: ${JSON.stringify(facts)}\nResult: ${JSON.stringify(outcome.result).slice(0, 4000)}`,
        },
      });
      const deadline = Date.now() + this.reasoningTimeoutMs;
      let current = this.db.getTask(task.task_id);
      while (current && !TERMINAL.has(current.status) && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 2000));
        current = this.db.getTask(task.task_id);
      }
      if (current?.status !== "completed")
        return {
          mode: "manager",
          status: "unavailable",
          task_id: task.task_id,
          detail: current?.status ?? "missing",
        };
      const json = JSON.parse(
        String(current.result).slice(
          String(current.result).indexOf("{"),
          String(current.result).lastIndexOf("}") + 1,
        ),
      );
      const mismatched = Object.entries(facts).filter(
        ([key, value]) => Number(json.figures?.[key]) !== Number(value),
      );
      if (typeof json.reply !== "string" || mismatched.length)
        return {
          mode: "manager",
          status: "discarded",
          task_id: task.task_id,
          detail: `Figures did not match: ${mismatched.map(([key]) => key).join(", ") || "reply missing"}`,
        };
      return {
        mode: "manager",
        status: "accepted",
        task_id: task.task_id,
        reply: json.reply.slice(0, 2000),
      };
    } catch (error) {
      return {
        mode: "manager",
        status: "unavailable",
        detail: String(error.message).slice(0, 300),
      };
    }
  }

  /** Owner decisions on a reorder workflow's purchase orders update its status. */
  settleApproval(approval) {
    const workflow = this.db.record(WORKFLOW_NAMESPACE, approval.workflow_id);
    if (!workflow) return;
    const all = this.approvals.list({ workflowId: approval.workflow_id });
    const open = all.some((row) => ["pending", "submitting"].includes(row.status));
    const status = open
      ? "awaiting_approval"
      : all.some((row) => row.status === "uncertain")
        ? "uncertain"
        : all.some((row) => row.status === "failed")
          ? "failed"
          : "completed";
    const noun = approval.kind === "sales_invoice" ? "BILL" : "PURCHASE_ORDER";
    const type =
      approval.status === "submitted"
        ? `${noun}_SUBMITTED`
        : approval.status === "rejected"
          ? `${noun}_REJECTED`
          : `${noun}_${approval.status.toUpperCase()}`;
    this.save(
      approval.workflow_id,
      { status, finished_at: open ? null : new Date().toISOString() },
      {
        type,
        agent: "manager",
        detail: `${approval.erp_document_name}: ${approval.status}`,
        document: approval.erp_document_name,
      },
    );
  }
}

/** Numbers an optional model reply must reproduce exactly. */
export function keyFigures(result) {
  if (!result) return {};
  const v2 = keyFiguresV2(result);
  if (v2) return v2;
  if (result.kind === "demand_forecast")
    return {
      items_forecast: result.items.filter((row) => row.status === "ok").length,
      reorder_items: result.items.filter((row) => row.recommendation?.suggested_qty > 0).length,
    };
  if (result.kind === "supplier_comparison")
    return {
      products_compared: result.items.length,
      with_supplier: result.items.filter((row) => row.choice).length,
    };
  if (result.kind === "stock_check")
    return { products_checked: result.rows.length, low_stock: result.low.length };
  if (result.kind === "prepare_reorder")
    return { low_stock: result.low.length, draft_orders: result.orders?.length ?? 0 };
  return {
    total_sales: result.total_sales,
    transactions: result.transaction_count,
    ...(result.profit?.status === "verified" ? { net_profit: result.profit.net_profit } : {}),
  };
}

/** The deterministic owner-facing summary. */
export function summarize(outcome) {
  if (outcome.status === "needs_clarification")
    return `Please clarify: ${outcome.clarifications
      .map((row) =>
        row.reason === "missing_product"
          ? "which product should I compare suppliers for?"
          : row.reason === "ambiguous"
            ? `"${row.requested}" could be ${row.options.join(" or ")}`
            : `I don't know "${row.requested}"`,
      )
      .join("; ")}.`;
  const result = outcome.result;
  const v2 = summarizeV2(result);
  if (v2 !== null) return v2;
  if (result.kind === "demand_forecast") {
    const ok = result.items.filter((row) => row.status === "ok");
    const top = ok
      .slice(0, 3)
      .map((row) => `${row.item_name} ~${row.forecast.next_7_days}`)
      .join(", ");
    const reorder = ok
      .filter((row) => row.recommendation?.suggested_qty > 0)
      .map(
        (row) =>
          `${row.item_name} ${row.recommendation.suggested_qty} (${row.recommendation.stockout_risk} risk)`,
      );
    const sparse = result.items
      .filter((row) => row.status === "insufficient_evidence")
      .map((row) => row.item_name);
    return [
      `Historical-demand forecast for the next 7 days: ${top || "no item has enough history"}.`,
      reorder.length
        ? `Suggested purchases: ${reorder.join("; ")}.`
        : "No purchase needed for the forecast period.",
      sparse.length ? `Not enough history to forecast: ${sparse.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (result.kind === "supplier_comparison")
    return result.items
      .map((row) =>
        row.choice
          ? `${row.item_name}: best quotation ${row.choice.supplier} at ${row.choice.rate} (${row.choice.lead_time_days ?? "unknown"}-day lead time) for ${row.qty}; ${row.considered.length} quotation(s) compared.`
          : `${row.item_name}: ${row.blocker}`,
      )
      .join(" ");
  if (result.kind === "stock_check") {
    const low = result.low.map(
      (row) =>
        `${row.item_name} (${row.available} left, reorder at ${row.reorder_level}, buy ${row.recommended_qty})`,
    );
    return low.length
      ? `${low.length} item(s) to buy tomorrow: ${low.join("; ")}.`
      : `All ${result.rows.length} checked item(s) are above their reorder level.`;
  }
  if (result.kind === "prepare_reorder") {
    if (!result.orders.length) return result.note ?? "No draft purchase order was created.";
    return `${result.orders.length} draft purchase order(s) ready for your approval: ${result.orders
      .map((po) => `${po.name} from ${po.supplier}, total ${po.grand_total}`)
      .join(
        "; ",
      )}.${result.unplaced.length ? ` Not ordered: ${result.unplaced.map((row) => `${row.item_code} (${row.reason})`).join("; ")}.` : ""}`;
  }
  const top = result.top_products
    .slice(0, 3)
    .map((row) => row.item_name)
    .join(", ");
  const profit =
    result.profit.status === "verified"
      ? `net profit ${result.profit.net_profit} from the posted P&L`
      : result.profit.status === "not_requested"
        ? ""
        : "profit could not be verified from posted accounting data";
  if (result.by_day) {
    const days = result.by_day;
    const detail =
      days.length <= 7
        ? days.map((row) => `${row.date} ${row.total}`).join(", ")
        : (() => {
            const sorted = [...days].sort((a, b) => b.total - a.total);
            return `best day ${sorted[0].date} ${sorted[0].total}, quietest ${sorted.at(-1).date} ${sorted.at(-1).total}`;
          })();
    return `${result.period.from_date} to ${result.period.to_date} (${days.length} days): sales ${result.total_sales} across ${result.transaction_count} transaction(s) (${detail}); top sellers ${top || "none"}${profit ? `; ${profit}` : ""}.`;
  }
  return `${result.period.from_date}: sales ${result.total_sales} across ${result.transaction_count} transaction(s); top sellers ${top || "none"}${profit ? `; ${profit}` : ""}.`;
}
