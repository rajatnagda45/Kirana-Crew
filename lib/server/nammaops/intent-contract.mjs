import Ajv from "ajv";
import { addDays } from "./forecast.mjs";
import { businessIntent, OWNER } from "./group-business.mjs";

/**
 * The one business-intent contract shared by direct chat, office group chat, Gemini Live and the
 * batch speech pipeline: free text is RESOLVED to a structured intent, the structured intent is
 * VALIDATED, and anything ambiguous is CLARIFIED instead of guessed. The three are separate so a
 * caller that already holds structured arguments (Gemini Live) never needs the resolver.
 *
 * Nothing here authorizes anything. A valid intent is only a well-formed request: every ERP read
 * still runs under the executing specialist's own governed identity, so a seat without a
 * capability is denied by governance whatever the intent says. No PIN can travel in an intent.
 */
export { OWNER };

/**
 * Voice business intents -> the existing deterministic workflows. A voice intent never maps to a
 * workflow that does not compute what it asks for (for example, supplier comparison is its own
 * quotation comparison, not a demand forecast).
 */
export const VOICE_INTENTS = Object.freeze({
  // The product catalogue is the Inventory specialist's full stock read, listed in full.
  list_products: "stock_check",
  check_stock: "stock_check",
  sales_summary: "daily_report",
  top_selling_products: "daily_report",
  business_profit: "daily_report",
  demand_forecast: "demand_forecast",
  supplier_comparison: "supplier_comparison",
  prepare_purchase_order: "prepare_reorder",
  // Stage 1 workflows (named like the workflow they run).
  receivables_report: "receivables_report",
  expiry_check: "expiry_check",
  purchase_status: "purchase_status",
  supplier_performance: "supplier_performance",
  customer_insights: "customer_insights",
  store_health_report: "store_health_report",
  business_report: "business_report",
  billing_summary: "billing_summary",
  // Finance and procurement reads over the live ERP (read-only).
  payments_summary: "payments_summary",
  gst_summary: "gst_summary",
  purchase_order_lookup: "purchase_order_lookup",
  // Frank prepares a DRAFT customer bill; the owner approves it with their PIN (a separate action).
  prepare_bill: "prepare_bill",
  // A read-only look at suppliers, open purchase orders and quotations (never writes).
  procurement_overview: "procurement_overview",
});
export const PRODUCT_INTENTS = new Set([
  "list_products",
  "check_stock",
  "demand_forecast",
  "supplier_comparison",
  "prepare_purchase_order",
  "supplier_performance",
]);
export const DAY_INTENTS = new Set(["sales_summary", "top_selling_products", "business_profit"]);

const validateShape = new Ajv({ allErrors: true }).compile({
  type: "object",
  properties: {
    intent: { enum: Object.keys(VOICE_INTENTS) },
    products: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 60 },
    },
    day: { type: "string", pattern: "^(today|yesterday|\\d{4}-\\d{2}-\\d{2})$" },
    /** Last day (inclusive) of a multi-day sales report. */
    to: { type: "string", pattern: "^(today|yesterday|\\d{4}-\\d{2}-\\d{2})$" },
    qty: { type: "integer", minimum: 1, maximum: 100000 },
    workflow_id: { type: "string", pattern: "^wf_[a-z0-9]{1,40}$" },
    /** receivables_report only: all udhaar, udhaar raised in the period, or what falls due soon. */
    focus: { enum: ["all", "new", "due_soon"] },
    /** purchase_order_lookup only: the ERPNext purchase order id, such as PUR-ORD-2026-00004. */
    po_name: { type: "string", pattern: "^[A-Za-z0-9 _.-]{1,64}$" },
    /** prepare_bill only: the customer's name (else the walk-in customer) and what they bought. */
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
  anyOf: [{ required: ["intent"] }, { required: ["workflow_id"] }],
  additionalProperties: false,
});

// A PIN (or any secret) is never part of an intent; the owner approves with a PIN in a separate action.
const SECRET_KEY = /pin|pass(?:word|code)?|otp|secret|token/i;

/** Intents whose answer is about a day or a period (a sales question cannot be about the future). */
const PERIOD_INTENTS = new Set([
  ...DAY_INTENTS,
  "business_report",
  "billing_summary",
  "payments_summary",
  "gst_summary",
]);

const WORD_NUMBERS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  saat: 7,
};
const BARE_PERIOD = new RegExp(
  `\\b(\\d{1,3}|${Object.keys(WORD_NUMBERS).join("|")})\\s+(?:days?|din|dino|dinon)\\b`,
  "i",
);
/** Words that make a "N days" phrase an explicit period ("last 2 days", "pichhle do din"). */
const PERIOD_ANCHOR =
  /\b(?:last|past|previous|prev|recent|pichhle|pichle|pichhla|pichla|beete|next|since|within)\b/i;
const ISO_DAY = /\b\d{4}-\d{2}-\d{2}\b/;

/**
 * Free text -> structured intent. Uses the shared model-then-keyword resolver when given one
 * (`context.intents`), else the keyword reader alone.
 * @param {string} message
 * @param {{ intents?: any, today: string, seats: string[], scope?: string }} context
 * @returns {{ status: "none" } | ({ status: "ok", department: string, args: any } & Record<string, any>)}
 */
export function resolveIntent(message, context) {
  const { intents, ...rest } = context;
  const parsed = intents ? intents.resolve(message, rest) : businessIntent(message, rest);
  return parsed?.args ? { status: "ok", ...parsed } : { status: "none" };
}

/**
 * Is this a well-formed request? Pure: no model, no ERP, no permission decision.
 * @returns {{ ok: true, args: any } | { ok: false, reason: string }}
 */
export function validateIntent(args) {
  if (args && typeof args === "object" && Object.keys(args).some((key) => SECRET_KEY.test(key)))
    return { ok: false, reason: "An intent never carries a PIN or any secret." };
  if (!validateShape(args))
    return {
      ok: false,
      reason: "Invalid business query. Choose a supported intent and plain product names.",
    };
  return { ok: true, args };
}

const resolveDay = (day, today) =>
  !day || day === "today" ? today : day === "yesterday" ? addDays(today, -1) : day;

/**
 * Should the owner be asked instead of the question being answered? Returns null (go ahead) or
 * `{ questions }`. Conservative on dates: a period the owner did not clearly name is asked, never
 * defaulted. `message` is the owner's own words when there are any (a Gemini Live tool call may
 * have none, and then only the structured arguments are checked).
 * @returns {null | { questions: string[] }}
 */
export function clarifyIntent(args, message, today) {
  if (!PERIOD_INTENTS.has(args?.intent)) return null;
  const date = resolveDay(args.day, today);
  if (date > today) return { questions: [`${date} is in the future. Which day do you mean?`] };
  const text = typeof message === "string" ? message : "";
  // A period the resolver already pinned down (a range, or an explicit date) is not ambiguous.
  if (!text || args.to || ISO_DAY.test(text)) return null;
  if (/\bto\s+days?\b/i.test(text))
    return {
      questions: [
        '"To days" could mean today or a few days. Do you want today, or the last 2 days?',
      ],
    };
  const bare = BARE_PERIOD.exec(text);
  if (bare && !PERIOD_ANCHOR.test(text)) {
    const n = WORD_NUMBERS[bare[1].toLowerCase()] ?? Number(bare[1]);
    return {
      questions: [`Do you mean the last ${n} day${n === 1 ? "" : "s"} up to today, or just today?`],
    };
  }
  return null;
}

/**
 * The workflow intent a validated, clarified query starts. Shared by the voice router and the
 * batch speech pipeline so both build the same workflow from the same arguments.
 */
export function toWorkflowIntent(args, today) {
  const action = VOICE_INTENTS[args.intent];
  const date = resolveDay(args.day, today);
  const products = PRODUCT_INTENTS.has(args.intent) ? (args.products ?? []) : undefined;
  const end =
    args.to === "today" ? today : args.to === "yesterday" ? addDays(today, -1) : (args.to ?? null);
  return {
    action,
    ...(products ? { products } : {}),
    ...(action === "daily_report" ? { date } : {}),
    ...(action === "daily_report" && end && end !== date ? { to: end } : {}),
    // Only a profit question reads the posted P&L; sales questions stay about sales.
    ...(action === "daily_report" && args.intent !== "business_profit"
      ? { with_profit: false }
      : {}),
    ...((action === "business_report" || action === "billing_summary") && args.day
      ? { date, ...(end ? { to: end } : {}) }
      : {}),
    // With no day named, payments and GST cover the month so far (the workflow's default).
    ...((action === "payments_summary" || action === "gst_summary") && args.day
      ? { date, ...(end ? { to: end } : {}) }
      : {}),
    ...(action === "prepare_bill"
      ? { ...(args.customer ? { customer: args.customer.trim() } : {}), lines: args.lines ?? [] }
      : {}),
    ...(action === "purchase_order_lookup" && args.po_name
      ? { po_name: args.po_name.trim().toUpperCase() }
      : {}),
    ...(action === "supplier_comparison" && args.qty ? { qty: args.qty } : {}),
    ...(action === "receivables_report" && args.focus && args.focus !== "all"
      ? {
          focus: args.focus,
          ...(args.focus === "new" ? { date, ...(end ? { to: end } : {}) } : {}),
        }
      : {}),
  };
}
