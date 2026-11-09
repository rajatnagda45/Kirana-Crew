/**
 * Semantic indexing for KiranaCrew.
 *
 * Converts free-form kirana-store language to domain signals and normalized intent.
 * Handles Hindi/Kannada retail vocabulary, synonyms, and multi-domain detection.
 *
 * Rules:
 * - Preserve the original message; extract meaning separately.
 * - Do not replace words blindly — score domain confidence from context.
 * - Never grant a capability based on word match alone; scoring feeds the router.
 */

import { DOMAINS } from "./capability-registry.mjs";

// ── Synonym groups ────────────────────────────────────────────────────────────────────────────────

/** Base retail synonym groups (kirana-specific vocabulary).
 *
 * Single-word keywords are matched with word boundaries (not substring).
 * Multi-word phrases are matched with String.includes().
 * Avoid very short abbreviations (rs, po, gl) — they cause substring false-positives.
 */
export const SYNONYM_GROUPS = {
  // Inventory vocabulary — specific terms only; avoid generic words like "products"/"items"
  inventory: new Set([
    "inventory",
    "stock",
    "stocks",
    "warehouse",
    "warehouses",
    "maaal",
    "saman",
    "samaan",
    "maal",
    "stok",
    "in stock",
    "out of stock",
    "availability",
    "store room",
    "godaam",
    "godown",
    "reorder level",
    "how much do i have",
    "how many do i have",
    "do i have",
  ]),
  low_stock: new Set([
    "low stock",
    "low-stock",
    "running low",
    "running out",
    "almost finished",
    "out of stock",
    "shortage",
    "shortages",
    "finish ho gaya",
    "khatam",
    "khatam ho raha",
    "khatm",
    "baki nahi",
    "kam hai",
    "restocking",
    "restock",
    "needs restocking",
    "product shortage",
    "need to order",
    "needs ordering",
    "are low",
    "is low",
    "getting low",
    "which items are low",
    "item are low",
  ]),
  stock_check: new Set([
    "check stock",
    "check inventory",
    "check products",
    "review stock",
    "inspect stock",
    "inspect inventory",
    "view stock",
    "see stock",
    "what do we have",
    "stock levels",
    "stock level",
    "stock status",
    "inventory status",
    "inventory check",
    "stock check",
    "kitna stock",
    "current stock",
    "available products",
    "available items",
    "what is in stock",
    "how much .+ do i have",
    "how many .+ do i have",
  ]),

  // Sales vocabulary
  sales: new Set([
    "sales",
    "sale",
    "revenue",
    "turnover",
    "billing",
    "invoice",
    "invoices",
    "point of sale",
    "transactions",
    "transaction",
    "sold",
    "sell",
    "selling",
    "earnings",
    "income",
    "receipts",
    "receipt",
    "daily sales",
    "aaj ki bikri",
    "bikri",
    "customers",
    "buyer",
    "buyers",
    "how much did i earn",
    "kitna kamaya",
    "kitni bikri",
    "today's sales",
    "sales report",
    "sales summary",
  ]),
  top_products: new Set([
    "top selling",
    "top-selling",
    "best selling",
    "best-selling",
    "most sold",
    "most popular",
    "popular products",
    "bestsellers",
    "best sellers",
    "top products",
    "highest sales",
    "most revenue",
    "top items",
    "sabse zyada bikne wala",
    "sabse popular",
  ]),
  sales_trend: new Set([
    "sales trend",
    "sales trends",
    "sales history",
    "sales performance",
    "revenue trend",
    "revenue growth",
    "sales analysis",
    "analyze sales",
    "sales report",
    "sales summary",
    "bikri ka report",
  ]),

  // Procurement vocabulary — avoid very short tokens like "po" that match substrings
  procurement: new Set([
    "procurement",
    "purchasing",
    "suppliers",
    "supplier",
    "vendor",
    "vendors",
    "quotation",
    "quotations",
    "quote",
    "quotes",
    "sourcing",
    "supply chain",
    "replenish",
    "supplier price",
    "supplier prices",
    "item price",
    "item prices",
    "who to buy from",
    "kahan se khareedein",
    "supplier dhundhna",
    "purchase order",
    "purchase orders",
    "open orders",
    "kirana supplier",
    "mera supplier",
    "draft order",
  ]),
  supplier_discovery: new Set([
    "find supplier",
    "find suppliers",
    "find vendor",
    "find vendors",
    "who supplies",
    "which supplier",
    "supplier for",
    "suppliers for",
    "supplier recommendation",
    "best supplier",
    "compare supplier",
    "compare suppliers",
    "supplier comparison",
    "vendor comparison",
    "cheapest supplier",
    "best price",
  ]),

  // Finance vocabulary — avoid short tokens (rs, gl) that substring-match unrelated words
  finance: new Set([
    "finance",
    "finances",
    "financial",
    "accounting",
    "accounts",
    "ledger",
    "general ledger",
    "profit and loss",
    "profit & loss",
    "profit loss",
    "payments",
    "payment",
    "expenses",
    "expense",
    "expenditure",
    "liabilities",
    "assets",
    "purchase invoice",
    "purchase invoices",
    "bills due",
    "outstanding",
    "paisa",
    "paise",
    "rupee",
    "rupees",
    "inr",
    "kitna kharch",
    "kitna aya",
    "finance check",
    "financial report",
    "financial summary",
    "financial records",
    "account summary",
    "accounting summary",
    "p&l",
  ]),
  profit: new Set([
    "profit",
    "profitable",
    "profitability",
    "net profit",
    "gross profit",
    "margin",
    "margins",
    "loss",
    "losses",
    "making money",
    "earning",
    "amdani",
    "fayda",
    "nafa",
    "munafa",
    "nuksan",
    "am i profitable",
    "how much profit",
    "kitna profit",
  ]),

  // Management / report vocabulary — use compound phrases, not solo "report"
  management: new Set([
    "overview",
    "business performance",
    "business health",
    "daily report",
    "store report",
    "business report",
    "full report",
    "complete report",
    "comprehensive report",
    "store audit",
    "business audit",
    "store performance",
    "aaj ka report",
    "daily overview",
    "business overview",
    "operational summary",
    "store status",
    "store health",
    "complete overview",
    "full store",
    "daily business report",
    "business summary",
    "store summary",
  ]),

  // Cross-domain concepts
  stock_vs_sales: new Set([
    "stock and sales",
    "inventory and sales",
    "products and revenue",
    "items sold",
    "what is selling",
    "selling products stock",
    "fast moving",
    "fast-moving",
    "slow moving",
    "slow-moving",
    "demand",
    "popular and low stock",
  ]),
  profit_analysis: new Set([
    "profit and sales",
    "revenue vs expense",
    "income vs expense",
    "margins",
    "cost vs revenue",
    "expenses vs income",
    "financial performance",
    "store profitability",
  ]),

  // Time references
  today: new Set(["today", "aaj", "today's", "this day", "abhi"]),
  yesterday: new Set(["yesterday", "kal", "yesterday's"]),
  week: new Set(["this week", "weekly", "week", "7 days", "last 7 days"]),
  month: new Set(["this month", "monthly", "month", "last month"]),

  // Action words that signal read-only intent
  read_only: new Set([
    "check",
    "review",
    "show",
    "see",
    "view",
    "look",
    "inspect",
    "find",
    "search",
    "tell me",
    "give me",
    "what is",
    "what are",
    "how much",
    "how many",
    "list",
    "display",
    "report",
    "summary",
    "status",
    "analyze",
    "analysis",
  ]),

  // Action words that signal state-changing intent
  state_changing: new Set([
    "create",
    "make",
    "place",
    "submit",
    "approve",
    "adjust",
    "modify",
    "update",
    "delete",
    "remove",
    "add",
    "order",
    "draft",
    "prepare",
    "book",
    "post",
    "enter",
    "record",
    "edit",
  ]),

  // Negations / constraints — include both apostrophe and stripped forms
  // (normalize() strips apostrophes, so "don't" becomes "dont")
  negation_buy: new Set([
    "don't order",
    "dont order",
    "don't buy",
    "dont buy",
    "do not order",
    "do not buy",
    "no purchase order",
    "without ordering",
    "without buying",
    "only check",
    "just check",
    "just review",
    "read only",
    "don't create",
    "dont create",
    "don't place",
    "dont place",
    "no purchase",
    "without creating",
    "without placing",
  ]),
};

// ── Domain signals ────────────────────────────────────────────────────────────────────────────────

/**
 * Domain-specific keyword sets used for domain detection scoring.
 * A text scores 1 for each set that has at least one match.
 */
const DOMAIN_SIGNALS = {
  [DOMAINS.INVENTORY]: [
    SYNONYM_GROUPS.inventory,
    SYNONYM_GROUPS.low_stock,
    SYNONYM_GROUPS.stock_check,
  ],
  [DOMAINS.SALES]: [SYNONYM_GROUPS.sales, SYNONYM_GROUPS.top_products, SYNONYM_GROUPS.sales_trend],
  [DOMAINS.PROCUREMENT]: [SYNONYM_GROUPS.procurement, SYNONYM_GROUPS.supplier_discovery],
  [DOMAINS.FINANCE]: [SYNONYM_GROUPS.finance, SYNONYM_GROUPS.profit],
  [DOMAINS.MANAGEMENT]: [SYNONYM_GROUPS.management],
  // Periodic reports are Grace's. Phrases only, so a bare "report" still means the daily report.
  [DOMAINS.REPORTS]: [
    [
      "weekly report",
      "monthly report",
      "week report",
      "month report",
      "weekly summary",
      "monthly summary",
      "report for the week",
      "report for the month",
      "report for last week",
      "report for last month",
      "report for this week",
      "report for this month",
      "summary of the week",
      "summary of the month",
      "how did we do this week",
      "how did we do this month",
      "how was the week",
      "how was the month",
    ],
  ],
  // Counter billing is Frank's.
  [DOMAINS.BILLING]: [
    [
      "bills today",
      "how many bills",
      "billing summary",
      "billing today",
      "biggest bill",
      "largest bill",
      "bill count",
      "cash memo",
      "pos bills",
      "returned bills",
      "unpaid bills",
      "invoices raised",
      "invoices today",
      "receipts today",
      "create bill",
      "create a bill",
      "make a bill",
      "generate bill",
      "generate a bill",
      "raise a bill",
      "new bill",
      "customer bill",
      "create invoice",
      "make an invoice",
      // Common misspellings of the above, so a typo still reaches Frank.
      "create bil",
      "make a bil",
      "create invoce",
    ],
  ],
};

/** Explicit multi-word phrases that map directly to a domain set. */
const DOMAIN_PHRASES = [
  { phrase: "check finance", domains: [DOMAINS.FINANCE] },
  { phrase: "check finances", domains: [DOMAINS.FINANCE] },
  { phrase: "review finances", domains: [DOMAINS.FINANCE] },
  { phrase: "financial check", domains: [DOMAINS.FINANCE] },
  { phrase: "check procurement", domains: [DOMAINS.PROCUREMENT] },
  { phrase: "review procurement", domains: [DOMAINS.PROCUREMENT] },
  { phrase: "check inventory", domains: [DOMAINS.INVENTORY] },
  { phrase: "check stock", domains: [DOMAINS.INVENTORY] },
  { phrase: "check sales", domains: [DOMAINS.SALES] },
  { phrase: "review sales", domains: [DOMAINS.SALES] },
  { phrase: "check finance and inventory", domains: [DOMAINS.FINANCE, DOMAINS.INVENTORY] },
  { phrase: "check inventory and finance", domains: [DOMAINS.INVENTORY, DOMAINS.FINANCE] },
  { phrase: "finance and inventory", domains: [DOMAINS.FINANCE, DOMAINS.INVENTORY] },
  { phrase: "inventory and finance", domains: [DOMAINS.INVENTORY, DOMAINS.FINANCE] },
  { phrase: "sales and inventory", domains: [DOMAINS.SALES, DOMAINS.INVENTORY] },
  { phrase: "inventory and sales", domains: [DOMAINS.INVENTORY, DOMAINS.SALES] },
  { phrase: "sales and stock", domains: [DOMAINS.SALES, DOMAINS.INVENTORY] },
  { phrase: "stock and sales", domains: [DOMAINS.INVENTORY, DOMAINS.SALES] },
  { phrase: "connect me with finance", domains: [DOMAINS.FINANCE] },
  { phrase: "connect finance agent", domains: [DOMAINS.FINANCE] },
  { phrase: "talk to finance", domains: [DOMAINS.FINANCE] },
  { phrase: "talk to erin", domains: [DOMAINS.FINANCE] },
  { phrase: "ask erin", domains: [DOMAINS.FINANCE] },
  { phrase: "ask bob", domains: [DOMAINS.INVENTORY] },
  { phrase: "ask carol", domains: [DOMAINS.SALES] },
  { phrase: "ask dave", domains: [DOMAINS.PROCUREMENT] },
  { phrase: "connect with bob", domains: [DOMAINS.INVENTORY] },
  { phrase: "connect with carol", domains: [DOMAINS.SALES] },
  { phrase: "connect with dave", domains: [DOMAINS.PROCUREMENT] },
  { phrase: "connect with erin", domains: [DOMAINS.FINANCE] },
];

// ── Normalization ─────────────────────────────────────────────────────────────────────────────────

const ABBREVIATIONS = {
  "p&l": "profit and loss",
  pnl: "profit and loss",
  pos: "point of sale",
  po: "purchase order",
  gl: "general ledger",
  qty: "quantity",
  inv: "inventory",
  fin: "finance",
  proc: "procurement",
};

const PLURAL_PAIRS = [
  [/\bproducts\b/g, "product"],
  [/\bitems\b/g, "item"],
  [/\bsuppliers\b/g, "supplier"],
  [/\binvoices\b/g, "invoice"],
  [/\bpayments\b/g, "payment"],
  [/\borders\b/g, "order"],
];

/** Normalize a user message for analysis: lowercase, expand abbreviations, normalize plurals. */
export function normalize(text) {
  if (!text) return "";
  let lower = String(text).toLowerCase().trim();
  // Expand abbreviations
  for (const [abbr, expansion] of Object.entries(ABBREVIATIONS)) {
    lower = lower.replace(new RegExp(`\\b${abbr}\\b`, "g"), expansion);
  }
  // Normalize punctuation
  lower = lower.replace(/['"]/g, "").replace(/\s+/g, " ");
  return lower;
}

// ── Keyword matching ──────────────────────────────────────────────────────────────────────────────

// Escape regex metacharacters for safe literal use
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Check if a keyword matches in normalizedText.
 * - Single-word keywords: word-boundary match (prevents "rs" matching inside "suppliers").
 * - Multi-word phrases: plain substring (phrase boundaries are sufficient).
 * - Regex-style patterns (containing "."): tested as regex against normalizedText.
 */
function matchesKeyword(text, keyword) {
  if (keyword.includes(".+")) {
    // Structural regex pattern (e.g. "how much .+ do i have")
    try {
      return new RegExp(keyword).test(text);
    } catch {
      return false;
    }
  }
  if (!keyword.includes(" ")) {
    // Single word: require word boundary to prevent substring false-positives
    return new RegExp(`\\b${reEscape(keyword)}\\b`).test(text);
  }
  // Multi-word phrase: substring is safe (phrase boundaries constrain the match)
  return text.includes(keyword);
}

// ── Domain detection ──────────────────────────────────────────────────────────────────────────────

/**
 * Score each domain's relevance to a normalized message.
 * Returns a map of domain → score (0..3).
 * Score 0 = no signal; 1+ = some evidence; 2+ = strong evidence.
 */
export function scoreDomains(normalizedText) {
  const scores = Object.fromEntries(Object.values(DOMAINS).map((d) => [d, 0]));

  // Check explicit multi-word phrases first (highest confidence)
  for (const { phrase, domains } of DOMAIN_PHRASES) {
    if (normalizedText.includes(phrase)) {
      for (const domain of domains) scores[domain] = Math.max(scores[domain], 3);
    }
  }

  // Score individual signal groups — word-boundary for single words, substring for phrases
  for (const [domain, signalSets] of Object.entries(DOMAIN_SIGNALS)) {
    for (const signalSet of signalSets) {
      for (const keyword of signalSet) {
        if (matchesKeyword(normalizedText, keyword)) {
          scores[domain] += 1;
          break; // one match per signal group is enough
        }
      }
    }
  }

  return scores;
}

/**
 * Detect domains from a user message.
 * Returns ordered list of domains with score ≥ threshold.
 * Default threshold = 1 (any signal counts).
 */
export function detectDomains(message, { threshold = 1 } = {}) {
  const normalized = normalize(message);
  const scores = scoreDomains(normalized);
  return Object.entries(scores)
    .filter(([, score]) => score >= threshold)
    .sort(([, a], [, b]) => b - a)
    .map(([domain]) => domain);
}

/**
 * Check whether the message contains an explicit constraint against creating purchase orders.
 */
export function hasNoBuyConstraint(message) {
  const normalized = normalize(message);
  for (const phrase of SYNONYM_GROUPS.negation_buy) {
    if (normalized.includes(phrase)) return true;
  }
  return false;
}

/**
 * Check whether the message is clearly a greeting (no domain content).
 * Accepts combinations like "hi good morning" or "hello there".
 */
export function isGreeting(message) {
  const t = message.trim();
  // Pure greeting: only greeting words and punctuation
  if (/^(?:hi|hello|hey|good (?:morning|afternoon|evening)|namaste|namaskar)[!?.,\s]*$/i.test(t))
    return true;
  // Compound greeting without any domain keyword: "hi good morning", "hello there"
  if (
    /^(?:hi|hello|hey)\s+(?:good\s+(?:morning|afternoon|evening)|there|friend|boss)[!?.,\s]*$/i.test(
      t,
    )
  )
    return true;
  return false;
}

/**
 * Check whether the message is a "connect me with X" or "ask X" delegation request.
 * Returns the target label if found, or null.
 */
export function extractDelegationTarget(message) {
  const normalized = normalize(message);
  const patterns = [
    /connect\s+(?:me\s+with\s+)?(?:the\s+)?(\w+)(?:\s+agent)?/,
    /talk\s+to\s+(?:the\s+)?(\w+)(?:\s+agent)?/,
    /ask\s+(?:the\s+)?(\w+)(?:\s+agent)?/,
    /(?:speak\s+to|speak\s+with)\s+(\w+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match) return match[1];
  }
  return null;
}

/**
 * Determine confidence level of the domain detection.
 * - "high": one or more domains with score ≥ 2, no ambiguity
 * - "medium": domains detected at score 1, or multiple competing domains
 * - "low": no domains or very weak signal
 */
export function domainConfidence(scores) {
  const detected = Object.values(scores).filter((s) => s > 0);
  if (detected.length === 0) return "low";
  const maxScore = Math.max(...detected);
  if (maxScore >= 2) return "high";
  if (detected.length >= 1) return "medium";
  return "low";
}
