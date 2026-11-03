/**
 * Routing evaluation suite — KiranaCrew Intelligent Agent Routing Engine.
 *
 * Tests the deterministic routing layer (classifyIntent + routeIntent).
 * Does NOT make ERP calls or start a real server.
 *
 * Metrics measured per test:
 *   - Agent selection precision (no extra agents)
 *   - Agent selection recall (no missing agents)
 *   - Exact-set accuracy (selected === expected)
 *   - Clarification accuracy (clarification requested only when needed)
 *   - Approval enforcement (requiresApproval set correctly)
 *   - No-buy constraint enforcement
 */

import { describe, it, expect } from "vitest";
import { classifyIntent } from "../../server/routing/intent-classifier.mjs";
import { routeIntent } from "../../server/routing/agent-router.mjs";
import { AGENTS, DOMAINS } from "../../server/routing/capability-registry.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Route a message with all five agent seats available.
 * Returns { intent, decision }.
 */
function route(message) {
  const intent = classifyIntent(message);
  const allSeats = [
    { seatId: "s1", label: "Alice" },
    { seatId: "s2", label: "Bob" },
    { seatId: "s3", label: "Carol" },
    { seatId: "s4", label: "Dave" },
    { seatId: "s5", label: "Erin" },
  ];
  const decision = routeIntent(intent, allSeats);
  return { intent, decision };
}

/** Assert that exactly the expected agents (and no others) are selected. */
function expectExactAgents(decision, expectedAgentIds, msg = "") {
  const selected = new Set(decision.selectedAgents);
  const expected = new Set(expectedAgentIds);
  const missing = [...expected].filter((id) => !selected.has(id));
  const extra = [...selected].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${msg}\n  Expected: [${[...expected].join(", ")}]\n  Got: [${[...selected].join(", ")}]` +
        (missing.length ? `\n  Missing: [${missing.join(", ")}]` : "") +
        (extra.length ? `\n  Extra (unnecessary): [${extra.join(", ")}]` : ""),
    );
  }
}

/** Assert that all expected agents appear (superset check, allows synthesis agents). */
function expectContainsAgents(decision, expectedAgentIds, msg = "") {
  for (const id of expectedAgentIds) {
    if (!decision.selectedAgents.includes(id)) {
      throw new Error(
        `${msg}\n  Missing required agent: ${id}\n  Got: [${decision.selectedAgents.join(", ")}]`,
      );
    }
  }
}

// ── Test data ─────────────────────────────────────────────────────────────────

// ── 1. Single-agent requests ──────────────────────────────────────────────────

describe("Single-agent routing — Inventory (Bob)", () => {
  it("check inventory", () => {
    const { decision } = route("check inventory");
    expectExactAgents(decision, [AGENTS.INVENTORY], "check inventory");
    expect(decision.executionStrategy).toBe("single");
  });

  it("show low-stock products", () => {
    const { decision } = route("show low-stock products");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
    expect(decision.domains).toContain(DOMAINS.INVENTORY);
  });

  it("how much milk do I have?", () => {
    const { decision } = route("how much milk do I have?");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
  });

  it("what items need restocking?", () => {
    const { decision } = route("what items need restocking?");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
  });

  it("tell me what's running low", () => {
    const { decision } = route("tell me what's running low");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
  });

  it("kitna stock hai? (Hindi)", () => {
    const { decision } = route("kitna stock hai?");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
  });

  it("check stock", () => {
    const { intent, decision } = route("check stock");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
    expect(intent.primaryIntent).toMatch(/check_stock|inventory/);
  });

  it("inspect available products", () => {
    const { decision } = route("inspect available products");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
  });

  it("which products are almost finished?", () => {
    const { decision } = route("which products are almost finished?");
    expectExactAgents(decision, [AGENTS.INVENTORY]);
  });
});

describe("Single-agent routing — Sales (Carol)", () => {
  it("analyze today's sales", () => {
    const { decision } = route("analyze today's sales");
    expectExactAgents(decision, [AGENTS.SALES], "analyze today's sales");
    expect(decision.executionStrategy).toBe("single");
  });

  it("how much did I earn today?", () => {
    const { decision } = route("how much did I earn today?");
    expectExactAgents(decision, [AGENTS.SALES]);
  });

  it("show me top selling products", () => {
    const { decision } = route("show me top selling products");
    expectExactAgents(decision, [AGENTS.SALES]);
  });

  it("what's our revenue today?", () => {
    const { decision } = route("what's our revenue today?");
    expectExactAgents(decision, [AGENTS.SALES]);
  });

  it("review sales report", () => {
    const { decision } = route("review sales report");
    expectExactAgents(decision, [AGENTS.SALES]);
  });

  it("aaj ki bikri dikhao (Hindi sales)", () => {
    const { decision } = route("aaj ki bikri dikhao");
    expectExactAgents(decision, [AGENTS.SALES]);
  });
});

describe("Single-agent routing — Finance (Erin)", () => {
  it("check finance", () => {
    const { decision } = route("check finance");
    expectExactAgents(decision, [AGENTS.FINANCE], "check finance");
    expect(decision.executionStrategy).toBe("single");
  });

  it("check finances", () => {
    const { decision } = route("check finances");
    expectExactAgents(decision, [AGENTS.FINANCE]);
  });

  it("review financial records", () => {
    const { decision } = route("review financial records");
    expectExactAgents(decision, [AGENTS.FINANCE]);
  });

  it("show me P&L", () => {
    const { decision } = route("show me P&L");
    expectExactAgents(decision, [AGENTS.FINANCE]);
  });

  it("check general ledger", () => {
    const { decision } = route("check general ledger");
    expectExactAgents(decision, [AGENTS.FINANCE]);
  });

  it("what are my expenses?", () => {
    const { decision } = route("what are my expenses?");
    expectExactAgents(decision, [AGENTS.FINANCE]);
  });

  it("payment summary", () => {
    const { decision } = route("payment summary");
    expectExactAgents(decision, [AGENTS.FINANCE]);
  });

  it("am I making a profit?", () => {
    const { decision } = route("am I making a profit?");
    expectContainsAgents(decision, [AGENTS.FINANCE]);
  });
});

describe("Single-agent routing — Procurement (Dave)", () => {
  it("find suppliers", () => {
    const { decision } = route("find suppliers");
    expectExactAgents(decision, [AGENTS.PROCUREMENT], "find suppliers");
    expect(decision.executionStrategy).toBe("single");
  });

  it("check procurement", () => {
    const { decision } = route("check procurement");
    expectExactAgents(decision, [AGENTS.PROCUREMENT]);
  });

  it("compare suppliers", () => {
    const { decision } = route("compare suppliers");
    expectExactAgents(decision, [AGENTS.PROCUREMENT]);
  });

  it("which supplier has the best price?", () => {
    const { decision } = route("which supplier has the best price?");
    expectExactAgents(decision, [AGENTS.PROCUREMENT]);
  });

  it("show purchase orders", () => {
    const { decision } = route("show purchase orders");
    expectExactAgents(decision, [AGENTS.PROCUREMENT]);
  });
});

// ── 2. Two-agent requests ─────────────────────────────────────────────────────

describe("Two-agent routing", () => {
  it("check finance and inventory", () => {
    const { decision } = route("check finance and inventory");
    expectExactAgents(decision, [AGENTS.INVENTORY, AGENTS.FINANCE], "check finance and inventory");
    expect(decision.executionStrategy).toBe("parallel");
  });

  it("check inventory and finance", () => {
    const { decision } = route("check inventory and finance");
    expectContainsAgents(decision, [AGENTS.INVENTORY, AGENTS.FINANCE]);
  });

  it("find suppliers for low-stock products", () => {
    const { decision } = route("find suppliers for low-stock products");
    expectExactAgents(
      decision,
      [AGENTS.INVENTORY, AGENTS.PROCUREMENT],
      "find suppliers for low-stock products",
    );
    expect(decision.executionStrategy).toBe("dependency_based");
    expect(decision.dependencies).toBeDefined();
    expect(decision.dependencies?.length).toBeGreaterThan(0);
  });

  it("check stock and find suppliers for running low items", () => {
    const { decision } = route("check stock and find suppliers for running low items");
    expectContainsAgents(decision, [AGENTS.INVENTORY, AGENTS.PROCUREMENT]);
    expect(decision.executionStrategy).toBe("dependency_based");
  });

  it("compare sales and inventory", () => {
    const { decision } = route("compare sales and inventory");
    expectContainsAgents(decision, [AGENTS.INVENTORY, AGENTS.SALES]);
    expect(decision.executionStrategy).toBe("parallel");
  });

  it("review purchase invoices and suppliers", () => {
    const { decision } = route("review purchase invoices and suppliers");
    expectContainsAgents(decision, [AGENTS.PROCUREMENT, AGENTS.FINANCE]);
  });

  it("finance and inventory", () => {
    const { decision } = route("finance and inventory");
    expectContainsAgents(decision, [AGENTS.INVENTORY, AGENTS.FINANCE]);
  });
});

// ── 3. Three-agent requests ───────────────────────────────────────────────────

describe("Three-agent routing", () => {
  it("analyze sales, stock and profit", () => {
    const { decision } = route("analyze sales, stock and profit");
    expectContainsAgents(decision, [AGENTS.INVENTORY, AGENTS.SALES, AGENTS.FINANCE]);
  });

  it("check procurement costs and financial impact", () => {
    const { decision } = route("check procurement costs and financial impact");
    expectContainsAgents(decision, [AGENTS.PROCUREMENT, AGENTS.FINANCE]);
  });

  it("identify fast-selling products and their inventory levels", () => {
    const { decision } = route("identify fast-selling products and their inventory levels");
    expectContainsAgents(decision, [AGENTS.INVENTORY, AGENTS.SALES]);
  });
});

// ── 4. Four/Five-agent requests ───────────────────────────────────────────────

describe("Multi-agent routing — full store", () => {
  it("prepare a business performance report", () => {
    const { decision } = route("prepare a business performance report");
    // Should involve at least 3 specialist domains
    expect(decision.selectedAgents.length).toBeGreaterThanOrEqual(3);
  });

  it("analyze inventory, sales, procurement and finances", () => {
    const { decision } = route("analyze inventory, sales, procurement and finances");
    expectContainsAgents(decision, [
      AGENTS.INVENTORY,
      AGENTS.SALES,
      AGENTS.PROCUREMENT,
      AGENTS.FINANCE,
    ]);
  });

  it("conduct a complete store audit", () => {
    const { decision } = route("conduct a complete store audit using all five agents");
    expect(decision.selectedAgents.length).toBeGreaterThanOrEqual(4);
  });

  it("prepare my daily business report", () => {
    const { decision } = route("prepare my daily business report");
    expect(decision.selectedAgents.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 5. Synonym variation tests ────────────────────────────────────────────────

describe("Synonym variation — inventory", () => {
  const inventoryMessages = [
    "check inventory",
    "inspect stock",
    "review available products",
    "find products running low",
    "tell me what needs restocking",
    "show stock levels",
    "which items are low?",
    "stock check",
  ];

  for (const msg of inventoryMessages) {
    it(`"${msg}" → Bob`, () => {
      const { decision } = route(msg);
      expect(decision.selectedAgents).toContain(AGENTS.INVENTORY);
    });
  }
});

describe("Synonym variation — sales", () => {
  const salesMessages = [
    "check sales",
    "how much did I sell today?",
    "show revenue",
    "analyze billing",
    "what were today's transactions?",
  ];

  for (const msg of salesMessages) {
    it(`"${msg}" → Carol`, () => {
      const { decision } = route(msg);
      expect(decision.selectedAgents).toContain(AGENTS.SALES);
    });
  }
});

describe("Synonym variation — finance", () => {
  const financeMessages = [
    "check finance",
    "show financial records",
    "review accounting",
    "P&L report",
    "profit and loss",
    "check expenses",
    "payment summary",
  ];

  for (const msg of financeMessages) {
    it(`"${msg}" → Erin`, () => {
      const { decision } = route(msg);
      expect(decision.selectedAgents).toContain(AGENTS.FINANCE);
    });
  }
});

describe("Synonym variation — procurement", () => {
  const procMessages = [
    "find suppliers",
    "check procurement",
    "review vendors",
    "supplier prices",
    "compare quotations",
  ];

  for (const msg of procMessages) {
    it(`"${msg}" → Dave`, () => {
      const { decision } = route(msg);
      expect(decision.selectedAgents).toContain(AGENTS.PROCUREMENT);
    });
  }
});

// ── 6. Agent delegation tests ─────────────────────────────────────────────────

describe("Agent delegation — 'connect me with X'", () => {
  it("connect me with finance agent → Erin", () => {
    const { decision } = route("connect me with finance agent");
    expectExactAgents(decision, [AGENTS.FINANCE]);
  });

  it("talk to finance → Erin", () => {
    const { decision } = route("talk to finance");
    expect(decision.selectedAgents).toContain(AGENTS.FINANCE);
  });

  it("ask Erin → Erin", () => {
    const { decision } = route("ask Erin");
    expect(decision.selectedAgents).toContain(AGENTS.FINANCE);
  });

  it("connect me with Bob → Bob", () => {
    const { decision } = route("connect me with Bob");
    expect(decision.selectedAgents).toContain(AGENTS.INVENTORY);
  });
});

// ── 7. Negation and constraint tests ─────────────────────────────────────────

describe("Negation and constraints", () => {
  it("check low stock but don't order anything", () => {
    const { decision } = route("check low stock but don't order anything");
    expect(decision.selectedAgents).toContain(AGENTS.INVENTORY);
    expect(decision.noBuyConstraint).toBe(true);
  });

  it("review finances without changing records", () => {
    const { decision } = route("review finances without changing records");
    expect(decision.selectedAgents).toContain(AGENTS.FINANCE);
  });

  it("find suppliers but don't create a purchase order", () => {
    const { intent, decision } = route("find suppliers but don't create a purchase order");
    expect(decision.selectedAgents).toContain(AGENTS.PROCUREMENT);
    expect(intent.noBuyConstraint).toBe(true);
  });

  it("check inventory — read only", () => {
    const { decision } = route("check inventory - just check, read only");
    expect(decision.selectedAgents).toContain(AGENTS.INVENTORY);
    expect(decision.requiresApproval).toBe(false);
  });
});

// ── 8. Approval enforcement ───────────────────────────────────────────────────

describe("Approval enforcement", () => {
  it("prepare purchase order → requiresApproval", () => {
    const { intent } = route("prepare a purchase order for low stock items");
    expect(intent.requiresApproval).toBe(true);
    expect(intent.selectedAgents).toContain(AGENTS.PROCUREMENT);
  });

  it("check suppliers → no approval needed", () => {
    const { intent } = route("check suppliers");
    expect(intent.requiresApproval).toBe(false);
  });

  it("check inventory → no approval needed", () => {
    const { intent } = route("check inventory");
    expect(intent.requiresApproval).toBe(false);
  });
});

// ── 9. Ambiguity / clarification tests ───────────────────────────────────────

describe("Ambiguity — clarification handling", () => {
  it("very short unknown message → no crash", () => {
    const { intent, decision } = route("??");
    // Should not throw; may need clarification or return empty agents
    expect(intent).toBeDefined();
    expect(decision).toBeDefined();
  });

  it("greeting → no agents selected, no crash", () => {
    const { intent, decision } = route("hello");
    expect(intent.primaryIntent).toBe("greeting");
    expect(decision.selectedAgents.length).toBe(0);
  });

  it("hi good morning → greeting", () => {
    const { intent } = route("hi good morning");
    expect(intent.primaryIntent).toBe("greeting");
  });
});

// ── 10. Precision — do NOT invoke extra agents ────────────────────────────────

describe("Precision — no unnecessary agent invocations", () => {
  it("'check inventory' must NOT select Carol, Dave or Erin", () => {
    const { decision } = route("check inventory");
    expect(decision.selectedAgents).not.toContain(AGENTS.SALES);
    expect(decision.selectedAgents).not.toContain(AGENTS.PROCUREMENT);
    expect(decision.selectedAgents).not.toContain(AGENTS.FINANCE);
  });

  it("'review sales' must NOT select Bob, Dave or Erin", () => {
    const { decision } = route("review sales");
    expect(decision.selectedAgents).not.toContain(AGENTS.INVENTORY);
    expect(decision.selectedAgents).not.toContain(AGENTS.PROCUREMENT);
    expect(decision.selectedAgents).not.toContain(AGENTS.FINANCE);
  });

  it("'check finance' must NOT select Bob, Carol or Dave", () => {
    const { decision } = route("check finance");
    expect(decision.selectedAgents).not.toContain(AGENTS.INVENTORY);
    expect(decision.selectedAgents).not.toContain(AGENTS.SALES);
    expect(decision.selectedAgents).not.toContain(AGENTS.PROCUREMENT);
  });

  it("'find suppliers' must NOT select Carol or Erin", () => {
    const { decision } = route("find suppliers");
    expect(decision.selectedAgents).not.toContain(AGENTS.SALES);
    expect(decision.selectedAgents).not.toContain(AGENTS.FINANCE);
  });
});

// ── 11. Execution strategy tests ─────────────────────────────────────────────

describe("Execution strategy", () => {
  it("single domain → single strategy", () => {
    const { decision } = route("check inventory");
    expect(decision.executionStrategy).toBe("single");
  });

  it("two independent domains → parallel", () => {
    const { decision } = route("check finance and inventory");
    expect(decision.executionStrategy).toBe("parallel");
  });

  it("inventory then procurement (dependency) → dependency_based", () => {
    const { decision } = route("find suppliers for products running low");
    expect(decision.executionStrategy).toBe("dependency_based");
  });
});

// ── 12. Confidence scoring ────────────────────────────────────────────────────

describe("Confidence scoring", () => {
  it("explicit domain keyword → high or medium confidence", () => {
    const { intent } = route("check inventory stock levels");
    expect(["high", "medium"]).toContain(intent.confidence);
  });

  it("clear multi-domain → medium or high", () => {
    const { intent } = route("check finance and inventory");
    expect(["high", "medium"]).toContain(intent.confidence);
  });
});

// ── 13. Domain detection accuracy ────────────────────────────────────────────

describe("Domain detection", () => {
  it("detects inventory domain from 'stock'", () => {
    const { intent } = route("review stock");
    expect(intent.domains).toContain(DOMAINS.INVENTORY);
  });

  it("detects sales domain from 'revenue'", () => {
    const { intent } = route("show revenue");
    expect(intent.domains).toContain(DOMAINS.SALES);
  });

  it("detects finance domain from 'accounting'", () => {
    const { intent } = route("check accounting records");
    expect(intent.domains).toContain(DOMAINS.FINANCE);
  });

  it("detects procurement domain from 'vendors'", () => {
    const { intent } = route("show vendors");
    expect(intent.domains).toContain(DOMAINS.PROCUREMENT);
  });

  it("detects multiple domains correctly", () => {
    const { intent } = route("check sales and stock");
    expect(intent.domains).toContain(DOMAINS.INVENTORY);
    expect(intent.domains).toContain(DOMAINS.SALES);
  });
});

// ── 14. Acceptance criteria from spec ────────────────────────────────────────

describe("Spec acceptance criteria (Section 22)", () => {
  const cases = [
    { request: "Check inventory", expected: [AGENTS.INVENTORY] },
    { request: "Review today's sales", expected: [AGENTS.SALES] },
    { request: "Check financial records", expected: [AGENTS.FINANCE] },
    { request: "Find suppliers", expected: [AGENTS.PROCUREMENT] },
    { request: "Check finance and inventory", expected: [AGENTS.INVENTORY, AGENTS.FINANCE] },
    { request: "Find suppliers for low stock", expected: [AGENTS.INVENTORY, AGENTS.PROCUREMENT] },
    { request: "Analyze sales and inventory", expected: [AGENTS.SALES, AGENTS.INVENTORY] },
  ];

  for (const { request, expected } of cases) {
    it(`"${request}" → [${expected.join(", ")}]`, () => {
      const { decision } = route(request);
      expectContainsAgents(decision, expected, request);
    });
  }
});
