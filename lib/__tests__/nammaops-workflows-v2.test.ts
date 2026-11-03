import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { parseCommand } from "../server/nammaops/workflows.mjs";
import { handleNammaOpsApi, nammaopsRoute } from "../server/nammaops/api.mjs";
import { TODAY, ready, setup } from "./nammaops-harness";

// Synthetic TEST FIXTURE only (fixture "today" is 2026-11-01).
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const run = async (ctx: Any, text: string) => ctx.nammaops.workflows.start({ text }).done;

describe("owner wording for the new workflows", () => {
  it.each([
    [
      "How much udhaar is pending, and who has not paid for more than 30 days?",
      "receivables_report",
    ],
    ["Which products will expire this month?", "expiry_check"],
    ["What is the status of our purchase orders?", "purchase_status"],
    ["Which supplier is delaying our milk deliveries?", "supplier_performance"],
    ["Which customers buy from us every week?", "customer_insights"],
    ["Tell me the five biggest problems in my shop today.", "store_health_report"],
    // The original five are unchanged.
    ["Check the stock of milk.", "stock_check"],
    ["Compare supplier quotations for milk and sugar", "supplier_comparison"],
    ["Tell me how much business I did today", "daily_report"],
  ])("%s -> %s", (text, action) => {
    expect(parseCommand(text, TODAY).action).toBe(action);
  });

  it("extracts the product for supplier delays", () => {
    expect(parseCommand("Which supplier is delaying our milk deliveries?", TODAY)).toEqual({
      action: "supplier_performance",
      products: ["milk"],
    });
  });
});

describe("Stage 1 workflows over the governed fixture ERP", () => {
  it("receivables_report: totals, 30-day overdue, partial payments and a collection order", async () => {
    const ctx = await ready();
    const view = await run(
      ctx,
      "How much udhaar is pending, and who has not paid for more than 30 days?",
    );
    expect(view.status).toBe("completed");
    const open = ctx.data.sales_invoices.filter(
      (i: Any) => i.posting_date <= TODAY && i.outstanding_amount > 0,
    );
    const total = open.reduce((s: number, i: Any) => s + i.outstanding_amount, 0);
    expect(view.result.total_outstanding).toBeCloseTo(total, 1);
    const over30 = open.filter(
      (i: Any) => (Date.parse(TODAY) - Date.parse(i.due_date)) / 86400000 > 30,
    );
    expect(view.result.overdue_over_30_days.amount).toBeCloseTo(
      over30.reduce((s: number, i: Any) => s + i.outstanding_amount, 0),
      1,
    );
    expect(view.result.partial_payments).toBe(
      open.filter((i: Any) => i.outstanding_amount < i.grand_total).length,
    );
    const priorities = view.result.collection_priority.map((c: Any) => c.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    // Every read was a governed call by the Finance specialist.
    const finance = view.tasks.find((t: Any) => t.role === "finance");
    expect(finance.evidence.map((e: Any) => e.business_capability)).toEqual([
      "erp.receivables.aging",
    ]);
    expect(view.summary).toMatch(/Udhaar pending ₹/);
  });

  it("expiry_check: windows, value at risk and perishables first", async () => {
    const ctx = await ready();
    const view = await run(ctx, "Which products will expire this month?");
    const r = view.result;
    expect(r.windows.expired.batches).toBe(2); // milk 10-30, cola 10-25
    expect(r.windows["7_days"].batches).toBe(3); // milk, curd, bread
    expect(r.windows["15_days"].batches).toBe(1); // eggs
    expect(r.windows["30_days"].batches).toBe(3); // biscuits, noodles, poha
    expect(r.items[0].perishable).toBe(true);
    expect(r.value_at_risk).toBeCloseTo(
      r.items.reduce((s: number, i: Any) => s + i.value_at_risk, 0),
      1,
    );
  });

  it("purchase_status: ordered vs received, late lines and supplier dues", async () => {
    const ctx = await ready();
    const view = await run(ctx, "What is the status of our purchase orders?");
    const r = view.result;
    expect(r.open_orders).toBe(4);
    expect(r.delayed.map((l: Any) => [l.item_code, l.days_late])).toEqual([
      ["CURD-400", 5],
      ["BREAD-400", 4],
    ]);
    expect(r.partially_received).toBe(2);
    expect(r.payables.total).toBeGreaterThan(0);
  });

  it("supplier_performance: names the supplier delaying a product", async () => {
    const ctx = await ready();
    const view = await run(ctx, "Which supplier is delaying our curd deliveries?");
    expect(view.result.delaying.map((s: Any) => s.supplier)).toEqual(["City Dairy Distributors"]);
    expect(view.summary).toMatch(/City Dairy Distributors is late on 1 line/);
  });

  it("customer_insights: ranks named customers and states what is not available", async () => {
    const ctx = await ready();
    const view = await run(ctx, "Which customers buy from us every week?");
    const r = view.result;
    expect(r.customers.length).toBeGreaterThan(0);
    expect(r.high_value[0].sales).toBe(Math.max(...r.customers.map((c: Any) => c.sales)));
    expect(r.customers.every((c: Any) => c.customer !== "Walk-in Customer")).toBe(true);
    expect(r.discounts.status).toBe("not_available");
  });

  it("store_health_report: combines all four specialists into the top problems", async () => {
    const ctx = await ready();
    const view = await run(ctx, "Tell me the five biggest problems in my shop today.");
    expect(view.status).toBe("completed");
    expect(new Set(view.tasks.map((t: Any) => t.role))).toEqual(
      new Set(["sales", "inventory", "finance", "procurement", "manager"]),
    );
    const titles = view.result.problems.map((p: Any) => p.title);
    expect(titles.length).toBeLessThanOrEqual(5);
    expect(titles).toContain("Expired stock on the shelf");
    // Late deliveries are found, but rank below the more severe problems in this fixture.
    expect(view.result.snapshot.late_deliveries).toBe(2);
    expect(view.result.all_problems).toBeGreaterThanOrEqual(titles.length);
    const severities = view.result.problems.map((p: Any) => p.severity);
    expect(severities).toEqual([...severities].sort((a, b) => b - a));
  });
});

describe("owner approval PIN", () => {
  const call = async (ctx: Any, method: string, path: string, body?: unknown): Promise<Any> => {
    const req: Any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: {}, socket: { remoteAddress: "127.0.0.1" } });
    try {
      return await handleNammaOpsApi(ctx.runtime, req, nammaopsRoute(path) as Any);
    } catch (error: Any) {
      return { status: error.status, body: { error: error.message } };
    }
  };

  it("starts at 1234 when nothing is configured, and the owner can change it", async () => {
    const ctx = setup({ env: { NAMMAOPS_OWNER_PIN: "" } });
    expect((await call(ctx, "GET", "/api/nammaops/owner-pin")).body.owner_pin.source).toBe(
      "default",
    );
    expect(() => ctx.nammaops.approvals.checkPin("1234")).not.toThrow();
    const wrong = await call(ctx, "POST", "/api/nammaops/owner-pin", {
      current_pin: "0000",
      new_pin: "5678",
    });
    expect(wrong.status).toBe(403);
    expect(
      (await call(ctx, "POST", "/api/nammaops/owner-pin", { current_pin: "1234", new_pin: "12" }))
        .status,
    ).toBe(400);
    const changed = await call(ctx, "POST", "/api/nammaops/owner-pin", {
      current_pin: "1234",
      new_pin: "5678",
    });
    expect(changed.body.owner_pin.source).toBe("settings");
    expect(() => ctx.nammaops.approvals.checkPin("1234")).toThrow(/incorrect/);
    expect(() => ctx.nammaops.approvals.checkPin("5678")).not.toThrow();
    // Only a salted hash is stored, never the PIN.
    expect(JSON.stringify(ctx.runtime.db.record("nammaops.owner-pin", "current"))).not.toContain(
      "5678",
    );
  });

  it("locks after five wrong attempts", () => {
    const ctx = setup();
    for (let i = 0; i < 5; i += 1)
      expect(() => ctx.nammaops.approvals.checkPin("0000")).toThrow(/incorrect/);
    expect(() => ctx.nammaops.approvals.checkPin("4826")).toThrow(/Too many/);
  });
});

describe("workforce identities on a shared backend agent", () => {
  it("gives every specialist its own session on the shared agent, with its own ERP allowlist", async () => {
    const ctx = setup({ backend: "main" });
    const report = await ctx.nammaops.setup({});
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
    const profiles = ctx.runtime.profiles
      .list()
      .filter((p: Any) => p.agent_id.startsWith("nammaops-"));
    expect(profiles).toHaveLength(5);
    const sessions = profiles.map((p: Any) => p.session_key);
    expect(new Set(sessions).size).toBe(5);
    for (const p of profiles) expect(p.session_key).toBe(`agent:main:${p.agent_id}`);
    // Separate governance subjects: each specialist keeps only its own grants.
    const grants = ctx.runtime.governance.grants();
    const subjectOf = (agentId: string) =>
      `specialization:${profiles.find((p: Any) => p.agent_id === agentId).specialization_id}`;
    const caps = (agentId: string) =>
      grants.filter((g: Any) => g.subject === subjectOf(agentId)).map((g: Any) => g.capability_id);
    expect(caps("nammaops-manager")).toEqual([]);
    expect(caps("nammaops-finance").some((c: string) => c.endsWith("get_stock_balance"))).toBe(
      false,
    );
    expect(caps("nammaops-inventory").some((c: string) => c.endsWith("list_receivables"))).toBe(
      false,
    );
  });

  it("permits each specialist's own reads and denies others", async () => {
    const ctx = await ready();
    const call = (agent: string, cap: string, args: Any = {}) =>
      ctx.nammaops.binding.call(agent, cap, args);
    await expect(
      call("nammaops-finance", "erp.receivables.aging", { as_of: TODAY }),
    ).resolves.toBeTruthy();
    await expect(call("nammaops-manager", "erp.items.list")).rejects.toMatchObject({
      workflowStatus: "blocked",
    });
    await expect(call("nammaops-finance", "erp.stock.balance")).rejects.toMatchObject({
      workflowStatus: "blocked",
    });
    await expect(call("nammaops-sales", "erp.po.submit", { name: "X" })).rejects.toMatchObject({
      workflowStatus: "blocked",
    });
  });

  it("leaves a profile's session alone if it already exists, and says so", async () => {
    const ctx = await ready(); // no backend agent: profiles use the seat default session
    const again = await ctx.nammaops.setup({});
    expect(again.blockers).toEqual([]);
    expect(again.warnings).toEqual([]); // no backend agent known, nothing to compare
  });
});

describe("fixed access check", () => {
  it("allows each specialist's own read and denies cross-role and write calls, all audited", async () => {
    const ctx = await ready();
    const { accessCheck } = await import("../server/nammaops/access-check.mjs");
    const out = await accessCheck({
      binding: ctx.nammaops.binding,
      today: () => TODAY,
      mcpGateway: ctx.runtime.mcpGateway,
    });
    expect(out.passed).toBe(true);
    const allowed = out.results.filter((r: Any) => r.outcome === "allowed");
    expect(allowed.map((r: Any) => r.agent)).toEqual([
      "nammaops-inventory",
      "nammaops-sales",
      "nammaops-procurement",
      "nammaops-finance",
    ]);
    for (const r of allowed) expect(r.invocation_id).toMatch(/^inv/);
    // Denied calls that reached the gateway are recorded as denied invocations.
    const denied = ctx.runtime.mcpGateway
      .invocations({})
      .filter((inv: Any) => inv.correlation_id === "access-check" && inv.status !== "completed");
    expect(denied.length).toBeGreaterThan(0);
    // The PO was never submitted.
    expect(ctx.nammaops.approvals.list().length).toBe(0);
  });
});
