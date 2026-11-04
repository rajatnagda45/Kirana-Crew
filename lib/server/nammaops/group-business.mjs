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
  receivables_report: "finance",
  expiry_check: "inventory",
  purchase_status: "procurement",
  supplier_performance: "procurement",
  customer_insights: "sales",
  store_health_report: "manager",
};
/** Workflow names that are also voice intents of the same name. */
const SAME_NAME_INTENTS = new Set([
  "receivables_report",
  "expiry_check",
  "purchase_status",
  "supplier_performance",
  "customer_insights",
  "store_health_report",
]);

/**
 * Extended fallback patterns: common kirana requests that parseCommand() does not yet cover.
 * Tried after the existing logic; returns { intent, department, args } or null.
 */
function extendedBusinessIntent(lower, today) {
  // Finance / profit check
  if (
    /\b(?:check|review|show|see|view|tell me|give me|finance|financial|p&l|profit\s+and\s+loss|profit\s*&\s*loss|pnl|general\s+ledger|gl|payments\s+summary|accounting)\b/.test(
      lower,
    ) &&
    /\b(?:finance|finances|financial|p&l|pnl|profit\s+and\s+loss|profit\s*&\s*loss|general\s+ledger|gl|payment|payments|accounting|ledger|accounts)\b/.test(
      lower,
    ) &&
    !/\b(?:check\s+stock|check\s+inventory|check\s+sales|check\s+supplier|purchase\s+order)\b/.test(
      lower,
    )
  ) {
    return { intent: "business_profit", department: OWNER.business_profit };
  }

  // Procurement / supplier generic check
  if (
    /\b(?:check|review|show|find|look at|procurement|supplier|vendor|sourcing)\b/.test(lower) &&
    /\b(?:procurement|supplier|suppliers|vendor|vendors|quotation|quotations|source|sourcing|buying|purchasing)\b/.test(
      lower,
    ) &&
    !/\b(?:check\s+stock|check\s+inventory|check\s+sales|check\s+finance)\b/.test(lower)
  ) {
    // "find suppliers" or "compare suppliers" → supplier_comparison
    if (
      /\b(?:compare|compare\s+supplier|best\s+price|cheapest|quotation|find\s+supplier)\b/.test(
        lower,
      )
    )
      return { intent: "supplier_comparison", department: OWNER.supplier_comparison };
    // Generic procurement check → demand_forecast (most useful general view)
    return { intent: "demand_forecast", department: OWNER.demand_forecast };
  }

  // Sales generic check
  if (
    /\b(?:check|review|show|see|how\s+much\s+did\s+i\s+(?:earn|sell|make)|how\s+much\s+(?:revenue|income|sales))\b/.test(
      lower,
    ) &&
    /\b(?:sales|selling|sold|revenue|income|billing|invoices|earnings)\b/.test(lower) &&
    !/\b(?:check\s+stock|check\s+inventory|check\s+finance)\b/.test(lower)
  ) {
    if (/\b(?:top|best|most|popular|highest)\b/.test(lower))
      return { intent: "top_selling_products", department: OWNER.top_selling_products };
    return { intent: "sales_summary", department: OWNER.sales_summary };
  }

  // Inventory generic check
  if (
    /\b(?:check|review|show|see|inspect|view)\b/.test(lower) &&
    /\b(?:inventory|stock|products|items|warehouse|available\s+(?:goods|products|items))\b/.test(
      lower,
    ) &&
    !/\b(?:check\s+finance|check\s+sales|check\s+procurement)\b/.test(lower)
  ) {
    if (/\b(?:list|all|every|full|catalogue|catalog)\b/.test(lower))
      return { intent: "list_products", department: OWNER.list_products };
    return { intent: "check_stock", department: OWNER.check_stock };
  }

  // Profit check
  if (
    /\b(?:profit|profitable|profitability|am\s+i\s+(?:making|earning)|net\s+profit|how\s+much\s+(?:profit|did\s+i\s+make))\b/.test(
      lower,
    )
  ) {
    return { intent: "business_profit", department: OWNER.business_profit };
  }

  return null;
}

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
  let to;
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
    else if (SAME_NAME_INTENTS.has(parsed.action)) intent = parsed.action;
    else if (parsed.action === "daily_report") {
      intent = /\bprofit\b/.test(lower)
        ? "business_profit"
        : /\b(top|best|most)\b.*\b(sell|sold|selling|product)/.test(lower)
          ? "top_selling_products"
          : "sales_summary";
      day =
        parsed.date === today ? "today" : /\byesterday\b/.test(lower) ? "yesterday" : parsed.date;
      to = parsed.to; // multi-day range ("previous 3 days", "this week")
    } else {
      // Fall through to extended patterns before giving up.
      const extended = extendedBusinessIntent(lower, today);
      if (!extended) return null;
      intent = extended.intent;
      if (extended.department) {
        return {
          department: extended.department,
          addressed,
          args: { intent, ...(products.length ? { products } : {}), ...(day ? { day } : {}) },
        };
      }
    }
  }
  return {
    department: OWNER[intent],
    addressed,
    args: {
      intent,
      ...(products.length ? { products } : {}),
      ...(day ? { day } : {}),
      ...(to ? { to } : {}),
      ...(qty ? { qty } : {}),
    },
  };
}

/** The voice contract, written for the chat: only facts, recommendations and limits it returned. */
export function formatBusinessReply(response) {
  const lines = [];
  // Speaker guidance meant for the voice model is not shown in the text chat.
  const forSpeaker = /^The requested name is not a recorded product or category\./;
  // The closing Source line already names the data source, so the note is not repeated here.
  const limitations = response.limitations.filter(
    (row) => !forSpeaker.test(row) && !/^Data source:/.test(row),
  );
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
