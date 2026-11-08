/**
 * Intent classifier for KiranaCrew.
 *
 * Converts a natural-language user message into a structured intent representation.
 * Deterministic: no LLM call. The router uses this output to select agents.
 *
 * Output schema:
 * {
 *   originalRequest: string,
 *   normalizedText: string,
 *   domains: string[],          // detected business domains in relevance order
 *   domainScores: Record<string, number>,
 *   primaryIntent: string,      // e.g. "check_stock", "sales_summary", "multi_domain_review"
 *   voiceIntents: Record<string, string>,  // domain → voice router intent key
 *   requiredCapabilities: string[],
 *   selectedAgents: string[],   // agent IDs in execution order
 *   executionStrategy: "single" | "parallel" | "dependency_based",
 *   dependencies: { upstream: string, downstream: string }[],
 *   requiresApproval: boolean,
 *   noBuyConstraint: boolean,
 *   confidence: "high" | "medium" | "low",
 *   needsClarification: boolean,
 *   clarificationQuestion?: string,
 *   timeContext?: "today" | "yesterday" | string,
 *   products?: string[],
 * }
 */

import {
  DOMAINS,
  AGENTS,
  AGENT_REGISTRY,
  DOMAIN_TO_AGENT,
  capabilitiesForDomains,
} from "./capability-registry.mjs";
import {
  normalize,
  scoreDomains,
  detectDomains,
  hasNoBuyConstraint,
  isGreeting,
  extractDelegationTarget,
  domainConfidence,
} from "./semantic-indexer.mjs";

// ── Single-domain intent mapping ──────────────────────────────────────────────────────────────────

/**
 * Given a single domain, determine the best voice-router intent key for a generic query.
 * These are the intents the NammaOps voice router supports.
 */
function defaultVoiceIntentForDomain(domain, normalizedText) {
  switch (domain) {
    case DOMAINS.INVENTORY:
      if (/\b(?:list|all|every|full|catalogue|catalog)\b/.test(normalizedText))
        return "list_products";
      if (
        /\b(?:forecast|predict|what to order|should i order|order tomorrow)\b/.test(normalizedText)
      )
        return "demand_forecast";
      return "check_stock";

    case DOMAINS.SALES:
      if (/\b(?:top|best|most|highest|popular|ranking)\b/.test(normalizedText))
        return "top_selling_products";
      return "sales_summary";

    case DOMAINS.PROCUREMENT:
      if (/\b(?:compare|best price|cheapest|quotation|quote)\b/.test(normalizedText))
        return "supplier_comparison";
      if (/\bpur-ord-[a-z0-9-]{3,50}\b/.test(normalizedText)) return "purchase_order_lookup";
      if (
        /\b(?:prepare|draft|create|make|place)\b.*\b(?:purchase order|order|po)\b/.test(
          normalizedText,
        )
      )
        return "prepare_purchase_order";
      return "demand_forecast";

    case DOMAINS.FINANCE:
      // Erin answers through the governed NammaOps workflows like the other departments:
      // GST -> the GST summary, payments -> the payments summary, udhaar and dues -> the
      // receivables report, everything else -> the posted profit report.
      if (/\b(?:gst|gstr|hsn|cgst|sgst|igst)\b/.test(normalizedText)) return "gst_summary";
      if (
        /\bpayments?\b/.test(normalizedText) &&
        !/\b(?:udhaar|udhar|unpaid|not paid|owe[sd]?|dues?|outstanding|overdue|pending)\b/.test(
          normalizedText,
        )
      )
        return "payments_summary";
      if (
        /\b(?:udhaar|udhar|credit|receivables?|owe[sd]?|outstanding|dues?|unpaid|not paid|collect)\b/.test(
          normalizedText,
        )
      )
        return "receivables_report";
      return "business_profit";

    case DOMAINS.REPORTS:
      return "business_report";

    case DOMAINS.BILLING:
      return "billing_summary";

    case DOMAINS.MANAGEMENT:
      return "business_profit";

    default:
      return null;
  }
}

// ── Dependency detection ──────────────────────────────────────────────────────────────────────────

/**
 * Detect if the query requires dependency-based execution (upstream → downstream).
 * Returns null for parallel or no dependency.
 */
function detectDependencies(domains, normalizedText) {
  const deps = [];

  // Pattern: "find suppliers for [low stock / products running low]"
  // → Bob must run first, Dave uses Bob's product list
  const lowStockSupplier =
    domains.includes(DOMAINS.PROCUREMENT) &&
    domains.includes(DOMAINS.INVENTORY) &&
    /\b(?:for low|for products|for items|for stock|running low|low stock|almost finished)\b/.test(
      normalizedText,
    );
  if (lowStockSupplier) {
    deps.push({ upstream: AGENTS.INVENTORY, downstream: AGENTS.PROCUREMENT });
  }

  // Pattern: "compare suppliers for [specific products]" where products need inventory check first
  const supplierForUnknownStock =
    domains.includes(DOMAINS.PROCUREMENT) &&
    domains.includes(DOMAINS.INVENTORY) &&
    /\b(?:supplier\s+for|compare\s+supplier|which\s+supplier|find\s+supplier)\b/.test(
      normalizedText,
    ) &&
    !lowStockSupplier;
  if (supplierForUnknownStock) {
    deps.push({ upstream: AGENTS.INVENTORY, downstream: AGENTS.PROCUREMENT });
  }

  return deps.length > 0 ? deps : null;
}

// ── Time context ──────────────────────────────────────────────────────────────────────────────────

function extractTimeContext(normalizedText) {
  if (/\btoday\b|\baaj\b/.test(normalizedText)) return "today";
  if (/\byesterday\b|\bkal\b/.test(normalizedText)) return "yesterday";
  if (/\bthis week\b|\bweekly\b/.test(normalizedText)) return "week";
  if (/\bthis month\b|\bmonthly\b/.test(normalizedText)) return "month";
  return "today"; // default for store queries
}

// ── Clarification detection ───────────────────────────────────────────────────────────────────────

const AMBIGUOUS_PATTERNS = [
  /^check (?:my )?business\s*\??$/,
  /^review (?:everything|all)\s*\??$/,
  /^show (?:me )?(?:the )?numbers\s*\??$/,
  /^find (?:the )?best (?:option)?\s*\??$/,
  /^(?:what|tell me)\s*\??$/,
  /^help\s*\??$/,
];

function needsClarification(normalizedText, domains, confidence) {
  if (confidence === "low") return true;
  if (AMBIGUOUS_PATTERNS.some((p) => p.test(normalizedText))) return true;
  // Very short messages with no domain signal
  if (normalizedText.length < 10 && domains.length === 0) return true;
  return false;
}

function buildClarificationQuestion(domains) {
  if (domains.length === 0)
    return "What would you like to check? For example: inventory levels, today's sales, supplier prices, or financial records?";
  if (domains.length === 1) {
    const domainName = domains[0];
    const examples = {
      [DOMAINS.INVENTORY]: "stock levels, low-stock products, or specific items?",
      [DOMAINS.SALES]: "today's sales, top-selling products, or customer records?",
      [DOMAINS.PROCUREMENT]: "supplier recommendations, demand forecast, or quotations?",
      [DOMAINS.FINANCE]: "profit & loss, general ledger, or payment summary?",
      [DOMAINS.MANAGEMENT]: "a full store overview or a specific report?",
    };
    return `Which part of ${domainName} would you like to check? ${examples[domainName] ?? ""}`;
  }
  return null; // multi-domain is clear enough
}

// ── Primary intent label ──────────────────────────────────────────────────────────────────────────

function primaryIntentLabel(domains, normalizedText) {
  if (domains.length === 0) return "unknown";
  if (domains.length === 1) {
    const voice = defaultVoiceIntentForDomain(domains[0], normalizedText);
    return voice ?? `${domains[0]}_review`;
  }
  const sorted = [...domains].sort().join("_");
  if (domains.includes(DOMAINS.INVENTORY) && domains.includes(DOMAINS.PROCUREMENT))
    return "low_stock_supplier_discovery";
  if (
    domains.includes(DOMAINS.INVENTORY) &&
    domains.includes(DOMAINS.SALES) &&
    domains.includes(DOMAINS.FINANCE)
  )
    return "business_performance_report";
  if (domains.length >= 4) return "store_audit";
  return `cross_domain_${sorted}`;
}

// ── Main classifier ───────────────────────────────────────────────────────────────────────────────

/**
 * Classify a user message into a structured routing intent.
 * @param {string} message
 * @returns {object}
 */
export function classifyIntent(message) {
  const originalRequest = String(message ?? "").trim();
  const normalizedText = normalize(originalRequest);

  // Greetings pass through immediately (check both original and normalized)
  if (isGreeting(originalRequest) || isGreeting(normalizedText)) {
    return {
      originalRequest,
      normalizedText,
      domains: [],
      domainScores: {},
      primaryIntent: "greeting",
      voiceIntents: {},
      requiredCapabilities: [],
      selectedAgents: [],
      executionStrategy: "single",
      dependencies: null,
      requiresApproval: false,
      noBuyConstraint: false,
      confidence: "high",
      needsClarification: false,
    };
  }

  // Structural pattern: "how much X do I have" → inventory (product quantity query)
  if (
    /\bhow much\b.{1,40}\bdo i have\b/i.test(originalRequest) ||
    /\bhow many\b.{1,40}\bdo i have\b/i.test(originalRequest) ||
    /\bhow much\b.{1,40}\bleft\b/i.test(originalRequest) ||
    /\bdo we have\b.{0,40}\bin stock\b/i.test(originalRequest)
  ) {
    return {
      originalRequest,
      normalizedText,
      domains: [DOMAINS.INVENTORY],
      domainScores: { [DOMAINS.INVENTORY]: 2 },
      primaryIntent: "check_stock",
      voiceIntents: { [DOMAINS.INVENTORY]: "check_stock" },
      requiredCapabilities: capabilitiesForDomains([DOMAINS.INVENTORY]),
      selectedAgents: [AGENTS.INVENTORY],
      executionStrategy: "single",
      dependencies: null,
      requiresApproval: false,
      noBuyConstraint: false,
      confidence: "high",
      needsClarification: false,
      timeContext: extractTimeContext(normalizedText),
    };
  }

  // Agent delegation requests ("connect me with Erin", "ask Bob")
  const delegationTarget = extractDelegationTarget(originalRequest);
  if (delegationTarget) {
    const agentNameMap = {
      alice: DOMAINS.MANAGEMENT,
      bob: DOMAINS.INVENTORY,
      carol: DOMAINS.SALES,
      dave: DOMAINS.PROCUREMENT,
      erin: DOMAINS.FINANCE,
      grace: DOMAINS.REPORTS,
      reports: DOMAINS.REPORTS,
      frank: DOMAINS.BILLING,
      billing: DOMAINS.BILLING,
      manager: DOMAINS.MANAGEMENT,
      inventory: DOMAINS.INVENTORY,
      sales: DOMAINS.SALES,
      procurement: DOMAINS.PROCUREMENT,
      finance: DOMAINS.FINANCE,
    };
    const targetLower = delegationTarget.toLowerCase();
    const mappedDomain = agentNameMap[targetLower];
    if (mappedDomain) {
      const agentId = DOMAIN_TO_AGENT[mappedDomain];
      const voiceIntent = defaultVoiceIntentForDomain(mappedDomain, normalizedText);
      return {
        originalRequest,
        normalizedText,
        domains: [mappedDomain],
        domainScores: { [mappedDomain]: 3 },
        primaryIntent: voiceIntent ?? `${mappedDomain}_review`,
        voiceIntents: voiceIntent ? { [mappedDomain]: voiceIntent } : {},
        requiredCapabilities: capabilitiesForDomains([mappedDomain]),
        selectedAgents: [agentId],
        executionStrategy: "single",
        dependencies: null,
        requiresApproval: false,
        noBuyConstraint: hasNoBuyConstraint(originalRequest),
        confidence: "high",
        needsClarification: false,
        timeContext: extractTimeContext(normalizedText),
      };
    }
  }

  // Domain detection
  const domainScores = scoreDomains(normalizedText);
  const confidence = domainConfidence(domainScores);
  const domains = Object.entries(domainScores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([d]) => d);

  // Exclude management from multi-agent selection when explicit specialists are available
  // (management is added back as synthesizer when multi-domain)
  const specialistDomains = domains.filter((d) => d !== DOMAINS.MANAGEMENT);

  // For "full store report", "business performance report", etc. — include all specialist domains
  const isFullAudit =
    (domains.includes(DOMAINS.MANAGEMENT) ||
      /\b(?:business performance|store performance|full store|business report|store report|complete report|daily report|business overview|full report)\b/.test(
        normalizedText,
      )) &&
    /\b(?:full|complete|comprehensive|all|entire|store audit|business audit|daily report|store report|daily business report|business performance|store performance|business overview|prepare.+report|full report)\b/.test(
      normalizedText,
    );

  const effectiveDomains = isFullAudit
    ? [DOMAINS.INVENTORY, DOMAINS.SALES, DOMAINS.PROCUREMENT, DOMAINS.FINANCE]
    : specialistDomains.length > 0
      ? specialistDomains
      : domains;

  const clarificationNeeded = needsClarification(normalizedText, effectiveDomains, confidence);

  if (clarificationNeeded && effectiveDomains.length === 0) {
    return {
      originalRequest,
      normalizedText,
      domains: [],
      domainScores,
      primaryIntent: "unknown",
      voiceIntents: {},
      requiredCapabilities: [],
      selectedAgents: [],
      executionStrategy: "single",
      dependencies: null,
      requiresApproval: false,
      noBuyConstraint: false,
      confidence: "low",
      needsClarification: true,
      clarificationQuestion: buildClarificationQuestion([]),
    };
  }

  // Build voice intent map for each domain
  const voiceIntents = {};
  for (const domain of effectiveDomains) {
    const intent = defaultVoiceIntentForDomain(domain, normalizedText);
    if (intent) voiceIntents[domain] = intent;
  }

  // Select agents for detected domains
  const selectedAgentIds = effectiveDomains.map((d) => DOMAIN_TO_AGENT[d]).filter(Boolean);

  // Dependency detection
  const dependencies = detectDependencies(effectiveDomains, normalizedText);
  const executionStrategy = dependencies
    ? "dependency_based"
    : selectedAgentIds.length === 1
      ? "single"
      : "parallel";

  // Approval needed if procurement draft PO is requested
  const requiresApproval =
    effectiveDomains.includes(DOMAINS.PROCUREMENT) &&
    /\b(?:prepare|draft|create|make|place)\b.*\b(?:purchase order|order|po)\b/.test(normalizedText);

  const noBuyConstraint = hasNoBuyConstraint(originalRequest);

  const primaryIntent = primaryIntentLabel(effectiveDomains, normalizedText);
  const timeContext = extractTimeContext(normalizedText);

  return {
    originalRequest,
    normalizedText,
    domains: effectiveDomains,
    domainScores,
    primaryIntent,
    voiceIntents,
    requiredCapabilities: capabilitiesForDomains(effectiveDomains),
    selectedAgents: selectedAgentIds,
    executionStrategy,
    dependencies,
    requiresApproval,
    noBuyConstraint,
    confidence,
    needsClarification: false,
    timeContext,
  };
}
