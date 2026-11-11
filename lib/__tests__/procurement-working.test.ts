import { describe, expect, it } from "vitest";
import { analyseStock } from "../server/nammaops/calculations.mjs";
import { ready } from "./nammaops-harness";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const item = (code: string, level: number, reorderQty: number) => ({
  item_code: code,
  item_name: code,
  reorder_level: level,
  reorder_qty: reorderQty,
});
const stock = (qty: Record<string, number>) =>
  new Map(Object.entries(qty).map(([code, n]) => [code, { qty: n, warehouses: [] }]));

describe("reorder-level quantity rule is unchanged (characterization)", () => {
  // These pin the existing rule: max(reorder qty, 2 x reorder level - available) when
  // available <= reorder level. Exposing the working must never change these numbers.
  it.each([
    // [level, reorderQty, available, expected]
    [6, 14, 4, 14], // reorder quantity wins (14 > 12 - 4 = 8)
    [9, 5, 4, 14], // refill wins (18 - 4 = 14 > 5)
    [3, 7, 0, 7], // out of stock: 6 - 0 = 6 < 7
    [6, 0, 6, 6], // exactly at the level counts as low; no reorder quantity set
  ])("level %i, reorder qty %i, stock %i -> buy %i", (level, reorderQty, available, expected) => {
    const { rows, low } = analyseStock([item("A", level, reorderQty)], stock({ A: available }));
    expect(low).toHaveLength(1);
    expect(rows[0].recommended_qty).toBe(expected);
  });

  it("recommends nothing above the reorder level or with no level set", () => {
    const { rows, low } = analyseStock(
      [item("A", 6, 14), { item_code: "B", item_name: "B" }],
      stock({ A: 7, B: 1 }),
    );
    expect(low).toHaveLength(0);
    expect(rows.map((row: Any) => row.recommended_qty)).toEqual([0, 0]);
  });

  it("exposes the inputs of the rule without changing the result", () => {
    const [refill] = analyseStock([item("A", 9, 5)], stock({ A: 4 })).rows;
    expect(refill).toMatchObject({
      recommended_qty: 14,
      target_stock: 18,
      reorder_qty: 5,
      refill_qty: 14,
      quantity_basis: "refill_to_target",
    });
    const [fixed] = analyseStock([item("A", 6, 14)], stock({ A: 4 })).rows;
    expect(fixed).toMatchObject({
      recommended_qty: 14,
      refill_qty: 8,
      quantity_basis: "reorder_quantity",
    });
  });
});

describe("recommendations show their working", () => {
  const ask = async (ctx: Any, intent: string, actionId: string) =>
    ctx.nammaops.voice.query({
      call: { id: `call-${actionId}`, name: "Dave" },
      actionId,
      args: { intent },
    });

  it("a reorder-level Buy line states stock, level, target and the rule, plus what it ignores", async () => {
    const ctx: Any = await ready();
    const out: Any = await ask(ctx, "check_stock", "w-stock");
    expect(out.recommendations.length).toBeGreaterThan(0);
    for (const line of out.recommendations)
      expect(line).toMatch(
        /^Buy \d+ .+\. Stock \d+(\.\d+)?, reorder level \d+, target \d+: buy the larger of the reorder quantity \d+ and \d+ - \d+(\.\d+)? = -?\d+(\.\d+)?\.$/,
      );
    expect(out.limitations.join(" ")).toMatch(
      /Open purchase orders and the sales forecast are not counted/,
    );
  });

  it("a forecast Order line states its working and the note explains how it differs from the alert", async () => {
    const ctx: Any = await ready();
    const out: Any = await ask(ctx, "demand_forecast", "w-forecast");
    for (const line of out.recommendations)
      expect(line).toMatch(
        /Working: lead-time demand [\d.]+ \+ safety stock [\d.]+ - stock [\d.]+ - incoming [\d.]+\./,
      );
    expect(out.limitations.join(" ")).toMatch(/differ from the reorder-level alert/);
  });

  it('never says "no purchase is needed" when some quantities could not be worked out', async () => {
    const ctx: Any = await ready();
    const out: Any = await ask(ctx, "demand_forecast", "w-forecast-2");
    const unknown = out.limitations.some((note: string) => /lead time unknown/.test(note));
    if (!out.recommendations.length && unknown)
      expect(out.facts.join(" ")).not.toMatch(/No purchase is needed/);
  });
});

describe("procurement overview: a defined, read-only answer", () => {
  const READS = new Set([
    "erp.suppliers.list",
    "erp.supplier_quotations.list",
    "erp.po.open",
    "erp.items.list",
  ]);

  it("answers from suppliers, open orders and quotations using read capabilities only", async () => {
    const ctx: Any = await ready();
    const out: Any = await ctx.nammaops.voice.query({
      call: { id: "call-overview", name: "Dave" },
      actionId: "ov-1",
      args: { intent: "procurement_overview" },
    });
    expect(out.status).toBe("completed");
    expect(out.facts.join(" ")).toMatch(/supplier/i);
    expect(out.facts.join(" ")).toMatch(/open purchase order/i);
    const view = ctx.nammaops.workflows.view(out.workflow_id);
    const used = view.tasks.flatMap((task: Any) =>
      task.evidence.map((e: Any) => e.business_capability),
    );
    expect(used.length).toBeGreaterThan(0);
    for (const capability of used) expect(READS.has(capability)).toBe(true);
    expect(used).not.toContain("erp.po.create_draft");
    expect(used).not.toContain("erp.po.submit");
  });

  it("says what it cannot show instead of inventing it", async () => {
    const ctx: Any = await ready();
    const out: Any = await ctx.nammaops.voice.query({
      call: { id: "call-overview-2", name: "Dave" },
      actionId: "ov-2",
      args: { intent: "procurement_overview" },
    });
    expect(out.limitations.join(" ")).toMatch(/needs the Inventory stock read/);
  });

  it('"tell me about procurement" is a procurement overview, not a demand forecast', async () => {
    const { resolveIntent } = await import("../server/nammaops/intent-contract.mjs");
    const seats = ["Alice", "Bob", "Carol", "Dave"];
    for (const text of [
      "tell me about procurement",
      "bob tell me about procurement",
      "Bob, tell me about procurement",
    ]) {
      const hit: Any = resolveIntent(text, { today: "2026-11-01", seats });
      expect(hit.status).toBe("ok");
      expect(hit.args.intent).toBe("procurement_overview");
      expect(hit.department).toBe("procurement");
    }
  });

  it("a procurement overview carries no PIN and cannot be turned into a write", async () => {
    const { validateIntent } = await import("../server/nammaops/intent-contract.mjs");
    expect(validateIntent({ intent: "procurement_overview" })).toMatchObject({ ok: true });
    expect(validateIntent({ intent: "procurement_overview", pin: "1234" })).toMatchObject({
      ok: false,
    });
  });
});

describe("a valid intent never implies permission", () => {
  it("governance still decides every read; Manager has no ERP grant and writes stay denied", async () => {
    const ctx: Any = await ready();
    const call = (agentId: string, capability: string, args: Any = {}) =>
      ctx.runtime.mcpGateway.invoke({
        agentId,
        capabilityId: ctx.nammaops.binding.capabilityId(capability),
        arguments: args,
      });
    for (const capability of [
      "erp.suppliers.list",
      "erp.supplier_quotations.list",
      "erp.po.open",
    ]) {
      expect((await call("nammaops-procurement", capability)).status).toBe("completed");
      expect((await call("nammaops-manager", capability)).status).toBe("denied");
      expect((await call("nammaops-sales", capability)).status).toBe("denied");
    }
    expect(
      (await call("nammaops-procurement", "erp.po.submit", { name: "PUR-ORD-FX-0001" })).status,
    ).toBe("denied");
  });
});
