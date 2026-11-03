/**
 * Capability registry for KiranaCrew agents.
 *
 * Every entry is grounded in config/nammaops/workforce.json — only capabilities backed by
 * actual ERP tools in the binding are listed here. Do not add a capability that no tool
 * can execute, and do not grant agents permissions they do not hold.
 */

export const DOMAINS = Object.freeze({
  INVENTORY: "inventory",
  SALES: "sales",
  PROCUREMENT: "procurement",
  FINANCE: "finance",
  MANAGEMENT: "management",
});

export const AGENTS = Object.freeze({
  MANAGER: "nammaops-manager",
  INVENTORY: "nammaops-inventory",
  SALES: "nammaops-sales",
  PROCUREMENT: "nammaops-procurement",
  FINANCE: "nammaops-finance",
});

/** Seat labels used in voice_departments and the UI. Presentation only — authorizes nothing. */
export const VOICE_NAMES = Object.freeze({
  [AGENTS.MANAGER]: "Alice",
  [AGENTS.INVENTORY]: "Bob",
  [AGENTS.SALES]: "Carol",
  [AGENTS.PROCUREMENT]: "Dave",
  [AGENTS.FINANCE]: "Erin",
});

/** Role strings as used in workforce.json. */
export const ROLES = Object.freeze({
  [AGENTS.MANAGER]: "manager",
  [AGENTS.INVENTORY]: "inventory",
  [AGENTS.SALES]: "sales",
  [AGENTS.PROCUREMENT]: "procurement",
  [AGENTS.FINANCE]: "finance",
});

/**
 * Capability-to-agent index.
 * Array values allow future fallback agents; for now each capability has one primary agent.
 * Grounded in: workforce.json business_capabilities + erp-binding tool names.
 */
export const CAPABILITY_INDEX = Object.freeze({
  // ── Inventory (Bob) ── erp.items.list, erp.stock.balance, erp.warehouses.list,
  //                       erp.stock.ledger, erp.stock.movements
  "inventory.items_list": [AGENTS.INVENTORY],
  "inventory.stock_balance": [AGENTS.INVENTORY],
  "inventory.warehouses": [AGENTS.INVENTORY],
  "inventory.stock_ledger": [AGENTS.INVENTORY],
  "inventory.stock_movements": [AGENTS.INVENTORY],
  "inventory.low_stock_detection": [AGENTS.INVENTORY],
  "inventory.reorder_check": [AGENTS.INVENTORY],

  // ── Sales (Carol) ── erp.sales_invoices.list, erp.pos_invoices.list,
  //                     erp.customers.list, erp.items.list, erp.sales.history
  "sales.invoices": [AGENTS.SALES],
  "sales.pos_invoices": [AGENTS.SALES],
  "sales.customers": [AGENTS.SALES],
  "sales.history": [AGENTS.SALES],
  "sales.items_lookup": [AGENTS.SALES],
  "sales.daily_summary": [AGENTS.SALES],
  "sales.top_products": [AGENTS.SALES],
  "sales.trends": [AGENTS.SALES],
  "sales.revenue": [AGENTS.SALES],

  // ── Procurement (Dave) ── erp.suppliers.list, erp.supplier_quotations.list,
  //                          erp.item_prices.get, erp.po.create_draft, erp.po.get, erp.po.open
  "procurement.suppliers": [AGENTS.PROCUREMENT],
  "procurement.quotations": [AGENTS.PROCUREMENT],
  "procurement.item_prices": [AGENTS.PROCUREMENT],
  "procurement.draft_po": [AGENTS.PROCUREMENT],
  "procurement.open_pos": [AGENTS.PROCUREMENT],
  "procurement.reorder_recommendation": [AGENTS.PROCUREMENT],
  "procurement.demand_forecast": [AGENTS.PROCUREMENT],
  "procurement.supplier_comparison": [AGENTS.PROCUREMENT],

  // ── Finance (Erin) ── erp.pnl, erp.gl, erp.purchase_invoices.list, erp.payments.summary
  "finance.pnl": [AGENTS.FINANCE],
  "finance.general_ledger": [AGENTS.FINANCE],
  "finance.purchase_invoices": [AGENTS.FINANCE],
  "finance.payments": [AGENTS.FINANCE],
  "finance.summary": [AGENTS.FINANCE],
  "finance.expense_analysis": [AGENTS.FINANCE],

  // ── Management (Alice) ── coordinator, no direct ERP access
  "management.orchestration": [AGENTS.MANAGER],
  "management.synthesis": [AGENTS.MANAGER],
  "management.delegation": [AGENTS.MANAGER],
  "management.approval_presentation": [AGENTS.MANAGER],
  "management.business_profit": [AGENTS.MANAGER], // daily_report workflow via manager
});

/**
 * Primary capabilities that define each domain.
 * Used to resolve "which agents does this domain need?"
 */
export const DOMAIN_CAPABILITIES = Object.freeze({
  [DOMAINS.INVENTORY]: [
    "inventory.stock_balance",
    "inventory.low_stock_detection",
    "inventory.items_list",
    "inventory.reorder_check",
  ],
  [DOMAINS.SALES]: ["sales.daily_summary", "sales.top_products", "sales.invoices", "sales.revenue"],
  [DOMAINS.PROCUREMENT]: [
    "procurement.suppliers",
    "procurement.reorder_recommendation",
    "procurement.demand_forecast",
    "procurement.quotations",
  ],
  [DOMAINS.FINANCE]: [
    "finance.pnl",
    "finance.summary",
    "finance.general_ledger",
    "finance.payments",
  ],
  [DOMAINS.MANAGEMENT]: ["management.synthesis", "management.orchestration"],
});

/**
 * Full agent metadata.
 * voiceIntents: the NammaOps voice-router intent keys this agent owns (empty → use direct path).
 * defaultVoiceIntent: intent used for a generic "check X" query for this domain.
 * usesVoiceRouter: whether this agent is accessible via nammaops.voice.query().
 */
export const AGENT_REGISTRY = Object.freeze({
  [AGENTS.MANAGER]: {
    agentId: AGENTS.MANAGER,
    role: ROLES[AGENTS.MANAGER],
    label: VOICE_NAMES[AGENTS.MANAGER],
    domain: DOMAINS.MANAGEMENT,
    capabilities: Object.keys(CAPABILITY_INDEX).filter((k) =>
      CAPABILITY_INDEX[k].includes(AGENTS.MANAGER),
    ),
    voiceIntents: ["business_profit"],
    defaultVoiceIntent: "business_profit",
    usesVoiceRouter: true,
    readOnly: true,
    parallelCompatible: true,
    approvalRequired: false,
    description: "Coordinates store operations and synthesizes specialist results.",
  },
  [AGENTS.INVENTORY]: {
    agentId: AGENTS.INVENTORY,
    role: ROLES[AGENTS.INVENTORY],
    label: VOICE_NAMES[AGENTS.INVENTORY],
    domain: DOMAINS.INVENTORY,
    capabilities: Object.keys(CAPABILITY_INDEX).filter((k) =>
      CAPABILITY_INDEX[k].includes(AGENTS.INVENTORY),
    ),
    voiceIntents: ["list_products", "check_stock", "demand_forecast"],
    defaultVoiceIntent: "check_stock",
    usesVoiceRouter: true,
    readOnly: true,
    parallelCompatible: true,
    approvalRequired: false,
    description: "Monitors all product stock levels and reports low-stock items.",
  },
  [AGENTS.SALES]: {
    agentId: AGENTS.SALES,
    role: ROLES[AGENTS.SALES],
    label: VOICE_NAMES[AGENTS.SALES],
    domain: DOMAINS.SALES,
    capabilities: Object.keys(CAPABILITY_INDEX).filter((k) =>
      CAPABILITY_INDEX[k].includes(AGENTS.SALES),
    ),
    voiceIntents: ["sales_summary", "top_selling_products"],
    defaultVoiceIntent: "sales_summary",
    usesVoiceRouter: true,
    readOnly: true,
    parallelCompatible: true,
    approvalRequired: false,
    description: "Analyses sales performance from invoices and POS data.",
  },
  [AGENTS.PROCUREMENT]: {
    agentId: AGENTS.PROCUREMENT,
    role: ROLES[AGENTS.PROCUREMENT],
    label: VOICE_NAMES[AGENTS.PROCUREMENT],
    domain: DOMAINS.PROCUREMENT,
    capabilities: Object.keys(CAPABILITY_INDEX).filter((k) =>
      CAPABILITY_INDEX[k].includes(AGENTS.PROCUREMENT),
    ),
    voiceIntents: ["demand_forecast", "supplier_comparison", "prepare_purchase_order"],
    defaultVoiceIntent: "demand_forecast",
    usesVoiceRouter: true,
    readOnly: false,
    parallelCompatible: true,
    approvalRequired: true,
    description: "Manages supplier relationships and prepares draft purchase orders.",
  },
  [AGENTS.FINANCE]: {
    agentId: AGENTS.FINANCE,
    role: ROLES[AGENTS.FINANCE],
    label: VOICE_NAMES[AGENTS.FINANCE],
    domain: DOMAINS.FINANCE,
    capabilities: Object.keys(CAPABILITY_INDEX).filter((k) =>
      CAPABILITY_INDEX[k].includes(AGENTS.FINANCE),
    ),
    voiceIntents: ["business_profit", "receivables_report"],
    defaultVoiceIntent: "business_profit",
    usesVoiceRouter: true,
    readOnly: true,
    parallelCompatible: true,
    approvalRequired: false,
    description: "Produces financial summaries from posted accounting data (P&L, GL, payments).",
  },
});

/** Reverse lookup: domain → primary agent ID. */
export const DOMAIN_TO_AGENT = Object.freeze({
  [DOMAINS.INVENTORY]: AGENTS.INVENTORY,
  [DOMAINS.SALES]: AGENTS.SALES,
  [DOMAINS.PROCUREMENT]: AGENTS.PROCUREMENT,
  [DOMAINS.FINANCE]: AGENTS.FINANCE,
  [DOMAINS.MANAGEMENT]: AGENTS.MANAGER,
});

/** Get agents that serve a domain. Returns primary agents only. */
export function agentsForDomain(domain) {
  const primary = DOMAIN_TO_AGENT[domain];
  return primary ? [AGENT_REGISTRY[primary]] : [];
}

/** Get agents that own a capability. */
export function agentsForCapability(capability) {
  const agentIds = CAPABILITY_INDEX[capability] ?? [];
  return agentIds.map((id) => AGENT_REGISTRY[id]).filter(Boolean);
}

/** Get primary capabilities for a set of domains. */
export function capabilitiesForDomains(domains) {
  return [...new Set(domains.flatMap((d) => DOMAIN_CAPABILITIES[d] ?? []))];
}

/** Get the agent registry entry for a seat label (e.g. "Bob" → AGENT_REGISTRY[AGENTS.INVENTORY]). */
export function agentForLabel(label) {
  const lower = String(label ?? "").toLowerCase();
  return Object.values(AGENT_REGISTRY).find((a) => a.label.toLowerCase() === lower) ?? null;
}
