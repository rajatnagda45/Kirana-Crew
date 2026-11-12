import { parseCommand } from "./workflows.mjs";
import { PO_NAME } from "./workflows-v2.mjs";
import { reorderLevelIntent } from "./stock-language.mjs";

const escape = (value) => value.replace(/[^\w]/g, "");

/** The department agent that owns each voice intent. Presentation only; it authorizes nothing. */
export const OWNER = {
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
  business_report: "reports",
  billing_summary: "billing",
  payments_summary: "finance",
  gst_summary: "finance",
  purchase_order_lookup: "procurement",
  prepare_bill: "billing",
  procurement_overview: "procurement",
};
/** Workflow names that are also voice intents of the same name. */
const SAME_NAME_INTENTS = new Set([
  "receivables_report",
  "expiry_check",
  "purchase_status",
  "supplier_performance",
  "customer_insights",
  "store_health_report",
  "business_report",
  "billing_summary",
  "payments_summary",
  "gst_summary",
  "purchase_order_lookup",
  "prepare_bill",
  "procurement_overview",
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
    // A general procurement question gets the procurement overview (suppliers, open orders,
    // quotations), not a demand forecast.
    return { intent: "procurement_overview", department: OWNER.procurement_overview };
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
  let poName;
  let billCustomer;
  let billLines;
  // Low stock and reorder-level wording is a stock check, not a catalogue listing, a forecast or a
  // purchase order (see stock-language.mjs).
  const stockLevel = reorderLevelIntent(lower);
  const listing =
    !stockLevel &&
    /\b(list|show|tell|name|which|what|all|how many|kitne|saare|sab)\b.*\b(products?|items?|categor(?:y|ies)|catalog(?:ue)?|prodcuts?)\b/.test(
      lower,
    ) &&
    !/\b(sell|sold|selling|order|reorder|forecast|suppliers?|stock of|low)\b/.test(lower);
  if (stockLevel) {
    intent = "check_stock";
  } else if (listing) {
    intent = "list_products";
    const category =
      /\b(?:in|of|under|from)\s+(?:the\s+)?([a-z][a-z ]{1,40}?)(?:\s+(?:category|section|group))?\s*[?.!]*$/.exec(
        lower,
      );
    if (category && !/\b(store|shop|system|list|erp|data)\b/.test(category[1]))
      products = [category[1].trim()];
  } else if (
    // "what should I order today" asks for a recommendation, not a draft purchase order. A named
    // purchase order ("what is the status of PUR-ORD-2026-00004") is a lookup, not a forecast.
    !PO_NAME.test(lower) &&
    (/\bwhat\b.*\b(order|orders|buy|reorder|purchase)\b/.test(lower) ||
      /\b(order|orders)\b.*\b(have to|need to|should i|to make|to place)\b.*\b(today|tomorrow)\b/.test(
        lower,
      ))
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
    else if (SAME_NAME_INTENTS.has(parsed.action)) {
      intent = parsed.action;
      if (
        (parsed.action === "business_report" ||
          parsed.action === "billing_summary" ||
          parsed.action === "payments_summary" ||
          parsed.action === "gst_summary") &&
        parsed.date
      ) {
        day = parsed.date;
        to = parsed.to;
      }
      if (parsed.action === "purchase_order_lookup") poName = parsed.po_name;
      if (parsed.action === "prepare_bill") {
        billCustomer = parsed.customer;
        billLines = parsed.lines ?? [];
      }
    } else if (parsed.action === "daily_report") {
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
      ...(poName ? { po_name: poName } : {}),
      ...(billLines
        ? { lines: billLines, ...(billCustomer ? { customer: billCustomer } : {}) }
        : {}),
    },
  };
}

const inr = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const plural_hi = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Hinglish fact+recommendation generators for each workflow result kind.
 * Returns { facts: string[], recommendations: string[] } or null when no generator exists.
 * Falls back to null → formatBusinessReply uses the English facts[] from the voice contract.
 */
function buildHinglishFacts(result) {
  if (!result?.kind) return null;
  switch (result.kind) {
    case "stock_check": {
      const rows = result.rows ?? [];
      const low = result.low ?? [];
      const describe = (row) =>
        `${row.item_name}: ${row.available} ${row.uom ?? "units"} available` +
        (row.reorder_level !== null
          ? `, reorder level ${row.reorder_level}${row.status === "low" ? " (low)" : ""}`
          : " (reorder level set nahi)");
      const facts =
        rows.length <= 8
          ? rows.map(describe)
          : [
              `${rows.length} products check kiye; ${low.length} products ka stock reorder level pe ya neeche hai.`,
              ...low.map(describe),
            ];
      const recommendations = low.map((row) => {
        const ranking = result.recommendations?.find((item) => item.item_code === row.item_code);
        const choice = ranking?.choice;
        const supplier = choice
          ? `${choice.supplier} se, ₹${choice.rate}/unit${choice.lead_time_days != null ? `, ${choice.lead_time_days} din delivery` : ""}`
          : null;
        return `${row.recommended_qty} ${row.item_name} order karo${supplier ? ` — ${supplier}` : ""}. (Stock ${row.available}, reorder level ${row.reorder_level}, target ${row.target_stock}.)`;
      });
      return { facts, recommendations };
    }
    case "daily_report": {
      const f = [];
      const when = result.period?.from_date;
      const to = result.period?.to_date;
      const range = when && to && when !== to ? `${when} se ${to} tak` : `${when} ko`;
      f.push(
        `${range}: ${inr(result.total_sales)} ki bikri hui, ${result.transaction_count} ${result.transaction_count === 1 ? "bill" : "bills"} mein, average ${inr(Math.round(result.total_sales / (result.transaction_count || 1)))} per bill.`,
      );
      if (result.top_products?.length)
        f.push(
          `Best sellers: ${result.top_products
            .slice(0, 3)
            .map((r) => `${r.item_name} (${r.qty} sold, ${inr(r.amount)})`)
            .join(", ")}.`,
        );
      if (result.by_day) {
        const sorted = [...result.by_day].sort((a, b) => b.total - a.total);
        if (sorted.length > 1)
          f.push(
            `Sabse accha din ${sorted[0].date} (${inr(sorted[0].total)}), sabse shanta din ${sorted.at(-1).date} (${inr(sorted.at(-1).total)}).`,
          );
      }
      const recs = [];
      if (result.profit?.status === "verified")
        recs.push(`Net profit: ${inr(result.profit.net_profit)}`);
      return { facts: f, recommendations: recs };
    }
    case "receivables_report": {
      const f = [];
      const over = result.overdue_over_30_days;
      f.push(
        `Total udhaar pending: ${inr(result.total_outstanding)}, jisme se ${inr(result.overdue)} overdue hai.`,
      );
      if (over?.customers)
        f.push(
          `30+ din se overdue: ${over.customers} ${over.customers === 1 ? "customer" : "customers"}, ${inr(over.amount)}.`,
        );
      if (result.collection_priority?.length)
        f.push(
          `Pehle collect karo: ${result.collection_priority
            .slice(0, 5)
            .map((c) => `${c.customer} (${inr(c.outstanding_amount)}, ${c.overdue_days} din)`)
            .join(", ")}.`,
        );
      return { facts: f, recommendations: [] };
    }
    case "demand_forecast": {
      const ok = (result.items ?? []).filter((r) => r.status === "ok");
      const f = ok
        .slice(0, 8)
        .map(
          (r) =>
            `${r.item_name}: agli 7 dinon mein ~${r.forecast.next_7_days} bikne ka estimate (${r.current_stock} abhi stock mein${r.incoming_stock ? `, ${r.incoming_stock} aane wala` : ""}).`,
        );
      if (ok.length > 8) f.push(`${ok.length - 8} aur products forecast mein hain.`);
      const recs = ok
        .filter((r) => r.recommendation?.suggested_qty > 0)
        .map((r) => {
          const choice = r.supplier_comparison?.choice;
          const sup = choice
            ? ` — ${choice.supplier} se, ₹${choice.rate}/unit${choice.lead_time_days != null ? `, ${choice.lead_time_days} din` : ""}`
            : "";
          return `${r.recommendation.suggested_qty} ${r.item_name} order karo (${r.recommendation.stockout_risk} stockout risk)${sup}.`;
        });
      if (!recs.length) f.push("Abhi koi purchase recommend nahi hai.");
      return { facts: f, recommendations: recs };
    }
    case "business_report": {
      const f = [];
      f.push(
        `Bikri: ${inr(result.sales?.total_sales)} (${result.sales?.transaction_count} bills).`,
      );
      if (result.previous?.change_pct != null)
        f.push(
          `Pichle period se ${Math.abs(result.previous.change_pct)}% ${result.previous.change_pct >= 0 ? "upar" : "neeche"}.`,
        );
      if (result.profit?.status === "verified")
        f.push(`Posted profit: ${inr(result.profit.net_profit)}.`);
      if (result.udhaar?.status === "available")
        f.push(`Udhaar pending: ${inr(result.udhaar.total)}.`);
      return { facts: f, recommendations: [] };
    }
    case "store_health_report": {
      const problems = result.problems ?? [];
      if (!problems.length)
        return {
          facts: ["Sales, stock, udhaar aur deliveries mein koi problem nahi mila."],
          recommendations: [],
        };
      const f = problems
        .slice(0, 5)
        .map((p, i) => `${i + 1}. ${p.title}${p.detail ? ` — ${p.detail}` : ""}.`);
      return { facts: f, recommendations: [] };
    }
    case "billing_summary": {
      if (!result.bills)
        return { facts: ["Is period mein koi bill nahi tha."], recommendations: [] };
      const f = [
        `${result.bills} bills, kul ${inr(result.total)}, average ${inr(result.average_bill)} per bill.`,
      ];
      if (result.unpaid?.status === "available" && result.unpaid?.bills)
        f.push(`${result.unpaid.bills} bills abhi unpaid hain — ${inr(result.unpaid.amount)}.`);
      return { facts: f, recommendations: [] };
    }
    case "prepare_bill":
      return {
        facts: [
          `${result.customer} ke liye draft bill ready hai: ${result.lines.map((l) => `${l.qty} ${l.item_name}`).join(", ")}, kul ${inr(result.total)}.`,
          "Sirf draft hai — PIN se approve karo taaki bill submit ho.",
        ],
        recommendations: [],
      };
    default:
      return null; // fall back to English facts from the voice contract
  }
}

/** The voice contract, written for the chat: only facts, recommendations and limits it returned. */
/**
 * The owner-facing line that says who really did the work when it was not the person asked
 * ("Dave passed this to Bob (Inventory)."). Empty when the asked seat did it itself.
 * @param {{ handed_off?: boolean, asked_of?: any, executed_by?: any[] } | null | undefined} routing
 */
export function routingLine(routing, language = "en") {
  if (!routing?.handed_off || !routing.speaker) return "";
  const hi = ["hi", "hl"].includes(String(language).slice(0, 2).toLowerCase());
  const asker = routing.asked_of?.name ?? "The seat you asked";
  const who = (row) => `${row.name} (${row.title})`;
  const and = (rows) => {
    const names = rows.map(who);
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  };
  const speaker = routing.speaker;
  if (speaker.coordinating) {
    // A team: name the others, not the seat that asked.
    const team = routing.executed_by.filter(
      (row) => row.department !== routing.asked_of?.department,
    );
    const listed = and(team.length ? team : routing.executed_by);
    if (routing.asked_of?.department === "manager")
      return hi
        ? `${asker} ne ${listed} ke saath mil kar yeh kiya.`
        : `${asker} coordinated this with ${listed}.`;
    return hi ? `${asker} ne ${listed} ko saath liya.` : `${asker} brought in ${listed}.`;
  }
  const parts = [];
  if (speaker.department !== routing.asked_of?.department)
    parts.push(
      hi ? `${asker} ne yeh ${who(speaker)} ko diya.` : `${asker} passed this to ${who(speaker)}.`,
    );
  if (routing.helpers?.length)
    parts.push(
      hi
        ? `${speaker.name} ne ${and(routing.helpers)} se bhi poocha.`
        : `${speaker.name} also checked with ${and(routing.helpers)}.`,
    );
  return parts.join(" ");
}

/**
 * Where each fact came from: the governed reads behind a reply, per specialist who made them
 * ("Bob (Inventory): erp.items.list, erp.stock.balance (2 reads)"). Empty when nothing was read.
 */
export function evidenceLines(response) {
  const names = new Map(
    (response?.routing?.executed_by ?? []).map((row) => [
      row.department,
      `${row.name} (${row.title})`,
    ]),
  );
  return (response?.evidence ?? [])
    .filter((row) => row.department !== "manager" && row.invocation_ids?.length)
    .map(
      (row) =>
        `${names.get(row.department) ?? row.agent ?? row.department}: ${row.capabilities.join(", ")} (${row.invocation_ids.length} read${row.invocation_ids.length === 1 ? "" : "s"})`,
    );
}

/** Alice's role line when she speaks for a team: one agent, two responsibilities. */
export const COORDINATOR_ROLE = "Store Manager · Office Lead";

/** Who a reply is posted as: the one specialist who ran it, else the coordinating manager. */
export function replySpeaker(routing, fallbackName) {
  const speaker = routing?.speaker;
  if (!speaker) return { name: fallbackName, coordinating: false };
  return { name: speaker.name, coordinating: Boolean(speaker.coordinating) };
}

export function formatBusinessReply(response, { language = "en" } = {}) {
  const lang2 = String(language).slice(0, 2).toLowerCase();
  const hi = lang2 === "hi" || lang2 === "hl"; // both Hinglish (hl) and Devanagari Hindi (hi)
  // When Hinglish and structured result is available, generate natural Hinglish facts.
  const hinglishFacts = hi && response.result ? buildHinglishFacts(response.result) : null;
  const lines = [];
  // Speaker guidance meant for the voice model is not shown in the text chat.
  const forSpeaker = /^The requested name is not a recorded product or category\./;
  // The closing Source line already names the data source, so the note is not repeated here.
  const limitations = response.limitations.filter(
    (row) => !forSpeaker.test(row) && !/^Data source:/.test(row),
  );
  if (response.status === "clarification_required") {
    lines.push(...response.clarification_questions);
    if (response.facts.length)
      lines.push("", hi ? "Category ke products:" : "Recorded products by category:");
  } else if (response.status === "running")
    lines.push(
      hi
        ? "Yeh kaam abhi chal raha hai; result aate hi yahan post ho jayega."
        : "Still working on this; I will post the result here as soon as it is ready.",
    );
  else if (response.status === "unavailable" && !response.facts.length)
    lines.push(hi ? "Yeh request poori nahi ho payi." : "I could not complete this request.");
  // Use Hinglish fact generators when available; fall back to the English facts from the contract.
  const activeFacts = hinglishFacts?.facts ?? response.facts;
  const activeRecs = hinglishFacts?.recommendations ?? response.recommendations;
  lines.push(...activeFacts);
  if (activeRecs.length)
    lines.push("", hi ? "Sujhaav:" : "Recommended:", ...activeRecs.map((row) => `• ${row}`));
  if (limitations.length) {
    // A long list of per-product caveats buries the answer: show the first few and count the rest.
    const MAX_NOTES = 5;
    const shown = limitations.slice(0, MAX_NOTES).map((row) => `• ${row}`);
    if (limitations.length > MAX_NOTES)
      shown.push(
        hi
          ? `• …aur ${limitations.length - MAX_NOTES} aisi hi notes hain.`
          : `• …and ${limitations.length - MAX_NOTES} more similar note(s).`,
      );
    lines.push("", hi ? "Notes:" : "Notes:", ...shown);
  }
  if (response.approvals.length)
    lines.push(
      "",
      ...response.approvals.map(
        (row) =>
          `Approval ${row.approval_id} ${hi ? "ke liye" : "for"} ${row.purchase_order ?? row.bill ?? "draft"}: ${row.where}`,
      ),
    );
  return lines.join("\n").trim();
}
