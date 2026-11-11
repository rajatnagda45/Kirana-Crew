/**
 * One place that knows when the owner is asking about LOW STOCK or REORDER LEVELS rather than about
 * future demand. "Which products are below reorder level?" and "tell me the recommended reorder
 * quantities" are stock checks (the stock check already computes the reorder quantities); only an
 * explicit forecast, future demand or "will run out in N days" is a demand forecast.
 *
 * No imports, so the keyword resolver, the model-decision correction and the typed-command parser
 * can all use it without a cycle.
 */

/** Wording about stock levels: below or at the reorder level, low stock, recommended reorder quantity. */
const STOCK_LEVEL =
  /\b(?:below|under|beneath|at or below|at)\s+(?:the\s+|their\s+|its\s+|our\s+|your\s+)?(?:re-?order|minimum|min)(?:\s+(?:levels?|points?|quantity))?\b|\bre-?order\s+(?:levels?|points?|quantit(?:y|ies)|qty)\b|\bre-?stock(?:ing|ed)?\b|\bneed(?:s|ing)?\s+(?:to\s+be\s+)?re-?ordered\b|\blow[\s-]?stock\b|\blow\s+on\s+stock\b|\bstock\s+(?:is\s+|are\s+)?(?:low|running low)\b|\brunning\s+low\b|\brecommended\s+(?:re-?order\s+)?quantit(?:y|ies)\b|\bbring\s+(?:the\s+)?stock\s+back\b|\b(?:to|reach)\s+(?:the\s+)?target\s+(?:stock|level)\b|\btarget\s+(?:stock|level)\b/i;

/** Wording that is genuinely about the future: a forecast, expected demand, running out in N days. */
const FUTURE_DEMAND =
  /\b(?:forecast|predict(?:ion)?|projection|future\s+demand|expected\s+demand|demand\s+(?:for|over|in)|will\s+(?:run\s+out|sell|need|be\s+needed)|run\s+out\s+(?:in|within|by)|next\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|week|month)\b)/i;

/** Asking to create, draft or place a purchase order is not a stock question. */
const PURCHASE_ORDER_ACTION =
  /\b(?:create|draft|prepare|place|raise|make|generate)\b[^.?!]{0,40}\b(?:purchase\s+orders?|po|re-?orders?\b(?!\s+(?:level|point|quantit(?:y|ies)|qty))|orders?)\b/i;

/**
 * "check_stock" when the text is about low stock or reorder levels and is not a forecast or a
 * request to create an order; otherwise null (the caller's own reading stands).
 * @param {string} text
 * @returns {"check_stock" | null}
 */
export function reorderLevelIntent(text) {
  const value = String(text ?? "");
  if (!STOCK_LEVEL.test(value)) return null;
  if (FUTURE_DEMAND.test(value)) return null;
  if (PURCHASE_ORDER_ACTION.test(value)) return null;
  return "check_stock";
}
