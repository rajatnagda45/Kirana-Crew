import { parseCommand } from "./workflows.mjs";

const escape = (value) => value.replace(/[^\w]/g, "");

/** The department agent that owns each voice intent. Presentation only; it authorizes nothing. */
const OWNER = {
  // The lead answers catalogue questions; the Inventory specialist does the read.
  list_products: "manager",
  check_stock: "inventory",
  sales_summary: "sales",
  top_selling_products: "sales",
  business_profit: "manager",
  demand_forecast: "procurement",
  supplier_comparison: "procurement",
  prepare_purchase_order: "procurement",
};

/**
 * Plain office text -> the same business query the voice tool sends, or null when the message is
 * not a supported store question (it then continues down the ordinary chat path).
 * @param {string} message @param {{today: string, seats: string[]}} context
 */
export function businessIntent(message, { today, seats }) {
  let text = String(message ?? "").trim();
  let addressed = null;
  for (const label of seats) {
    const lead = new RegExp(`^@?${escape(label)}\\b[\\s,:;-]*`, "i").exec(text);
    if (lead) {
      addressed = label;
      text = text.slice(lead[0].length);
      break;
    }
  }
  if (!text) return null;
  const lower = text.toLowerCase();
  let intent;
  let products = [];
  let day;
  let qty;
  const listing =
    /\b(list|show|tell|name|which|what|all|how many|kitne|saare|sab)\b.*\b(products?|items?|categor(?:y|ies)|catalog(?:ue)?|prodcuts?)\b/.test(
      lower,
    ) && !/\b(sell|sold|selling|order|forecast|suppliers?|stock of|low)\b/.test(lower);
  if (listing) {
    intent = "list_products";
    const category =
      /\b(?:in|of|under|from)\s+(?:the\s+)?([a-z][a-z ]{1,40}?)(?:\s+(?:category|section|group))?\s*[?.!]*$/.exec(
        lower,
      );
    if (category && !/\b(store|shop|system|list|erp|data)\b/.test(category[1]))
      products = [category[1].trim()];
  } else if (
    // "what should I order today" asks for a recommendation, not a draft purchase order.
    /\bwhat\b.*\b(order|orders|buy|reorder|purchase)\b/.test(lower) ||
    /\b(order|orders)\b.*\b(have to|need to|should i|to make|to place)\b.*\b(today|tomorrow)\b/.test(
      lower,
    )
  ) {
    intent = "demand_forecast";
  } else {
    let parsed;
    try {
      parsed = parseCommand(text, today);
    } catch {
      return null;
    }
    products = parsed.products ?? [];
    if (parsed.action === "stock_check") intent = "check_stock";
    else if (parsed.action === "demand_forecast") intent = "demand_forecast";
    else if (parsed.action === "supplier_comparison") {
      intent = "supplier_comparison";
      const amount = /\b(\d{1,6})\s*(?:units?|pcs|pieces)\b/.exec(lower);
      if (amount) qty = Number(amount[1]);
    } else if (parsed.action === "prepare_reorder") intent = "prepare_purchase_order";
    else if (parsed.action === "daily_report") {
      intent = /\bprofit\b/.test(lower)
        ? "business_profit"
        : /\b(top|best|most)\b.*\b(sell|sold|selling|product)/.test(lower)
          ? "top_selling_products"
          : "sales_summary";
      day =
        parsed.date === today ? "today" : /\byesterday\b/.test(lower) ? "yesterday" : parsed.date;
    } else return null;
  }
  return {
    department: OWNER[intent],
    addressed,
    args: {
      intent,
      ...(products.length ? { products } : {}),
      ...(day ? { day } : {}),
      ...(qty ? { qty } : {}),
    },
  };
}

/** The voice contract, written for the chat: only facts, recommendations and limits it returned. */
export function formatBusinessReply(response) {
  const lines = [];
  // Speaker guidance meant for the voice model is not shown in the text chat.
  const forSpeaker = /^The requested name is not a recorded product or category\./;
  const limitations = response.limitations.filter((row) => !forSpeaker.test(row));
  if (response.status === "clarification_required") {
    lines.push(...response.clarification_questions);
    if (response.facts.length) lines.push("", "Recorded products by category:");
  } else if (response.status === "running")
    lines.push("Still working on this; ask again in a moment.");
  else if (response.status === "unavailable" && !response.facts.length)
    lines.push("I could not complete this request.");
  lines.push(...response.facts);
  if (response.recommendations.length)
    lines.push("", "Recommended:", ...response.recommendations.map((row) => `• ${row}`));
  if (limitations.length) lines.push("", "Notes:", ...limitations.map((row) => `• ${row}`));
  if (response.approvals.length)
    lines.push(
      "",
      ...response.approvals.map(
        (row) => `Approval ${row.approval_id} for ${row.purchase_order ?? "draft"}: ${row.where}`,
      ),
    );
  const consulted = response.consulted.length
    ? ` · consulted ${response.consulted.join(", ")}`
    : "";
  lines.push(
    "",
    `Source: ${response.source === "fixture" ? "NammaOps fixture data" : "live ERPNext"}${consulted}${response.workflow_id ? ` · ${response.workflow_id}` : ""}`,
  );
  return lines.join("\n").trim();
}
