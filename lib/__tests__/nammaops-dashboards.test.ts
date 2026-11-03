import { describe, expect, it, vi } from "vitest";
import { loadBinding } from "../server/nammaops/erp-binding.mjs";
import {
  DASHBOARDS,
  DASHBOARD_PRINCIPAL,
  abcClass,
  ageBucket,
  ageing,
  parseRange,
  taxable,
} from "../server/nammaops/dashboards.mjs";
import { ServiceRegistry } from "../server/service-registry.mjs";
import { TODAY, get, ready, setup } from "./nammaops-harness";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cardValue = (body: Any, id: string) => body.cards.find((c: Any) => c.id === id)?.value;

describe("dashboard helpers", () => {
  it("validates ranges", () => {
    expect(parseRange({}, TODAY)).toEqual({ from: "2026-10-03", to: TODAY });
    expect(() => parseRange({ from: "2026-13-01" }, TODAY)).toThrow(/YYYY-MM-DD/);
    expect(() => parseRange({ from: "2026-11-02", to: "2026-11-01" }, TODAY)).toThrow(/before/);
    expect(() => parseRange({ from: "2025-01-01", to: TODAY }, TODAY)).toThrow(/exceed/);
  });

  it("ages by days past due and bucket totals add up to the outstanding total", () => {
    expect(ageBucket("2026-11-05", TODAY)).toBe("Not due");
    expect(ageBucket("2026-10-20", TODAY)).toBe("0-30");
    expect(ageBucket("2026-09-01", TODAY)).toBe("61-90");
    expect(ageBucket("2026-07-01", TODAY)).toBe("90+");
    const aged = ageing(
      [
        { due_date: "2026-11-05", outstanding_amount: 100 },
        { due_date: "2026-10-01", outstanding_amount: 50.5 },
        { due_date: "2026-06-01", outstanding_amount: 25 },
      ],
      TODAY,
    );
    const bucketSum = Object.values(aged.totals).reduce((a: number, b: Any) => a + b, 0);
    expect(bucketSum).toBeCloseTo(aged.total);
    expect(aged.total).toBe(175.5);
  });

  it("classifies ABC by cumulative revenue share and backs out GST", () => {
    const rows = abcClass([
      { item_code: "a", value: 700 },
      { item_code: "b", value: 200 },
      { item_code: "c", value: 60 },
      { item_code: "d", value: 40 },
    ]);
    expect(rows.map((r: Any) => r.class)).toEqual(["A", "B", "C", "C"]);
    expect(taxable(105, 5)).toBe(100);
    expect(taxable(118, 18)).toBe(100);
  });
});

describe("dashboards over the governed fixture ERP", () => {
  it("refuses before setup and validates the endpoint inputs", async () => {
    const fresh = setup();
    expect((await get(fresh, "/api/nammaops/dashboards/stock")).status).toBe(409);
    const ctx = await ready();
    expect((await get(ctx, "/api/nammaops/dashboards")).body.dashboards).toEqual([...DASHBOARDS]);
    expect((await get(ctx, "/api/nammaops/dashboards/nope")).status).toBe(404);
    expect((await get(ctx, "/api/nammaops/dashboards/stock?from=bad")).status).toBe(400);
    expect((await get(ctx, "/api/nammaops/dashboards/stock?limit=5")).status).toBe(400);
  });

  it("builds every dashboard with the common envelope and audited invocations", async () => {
    const ctx = await ready();
    for (const name of DASHBOARDS) {
      const { status, body } = await get(
        ctx,
        `/api/nammaops/dashboards/${name}?from=2026-10-03&to=${TODAY}`,
      );
      expect(status, name).toBe(200);
      expect(body).toMatchObject({
        dashboard: name,
        source: "fixture",
        verification: "synthetic_fixture",
        range: { from: "2026-10-03", to: TODAY },
      });
      expect(body.sections_unavailable, name).toEqual([]);
      expect(body.cards.length, name).toBeGreaterThan(0);
      expect(body.invocation_ids.length, name).toBeGreaterThan(0);
      // Every read is recorded by the governed gateway under the READ-only dashboard principal.
      const audited = ctx.runtime.mcpGateway
        .invocations({ agentId: DASHBOARD_PRINCIPAL })
        .filter((row: Any) => row.correlation_id === body.correlation_id);
      expect(audited.length, name).toBe(body.invocation_ids.length);
      expect(audited.every((row: Any) => row.status === "completed")).toBe(true);
    }
    expect(ctx.runtime.services.get("erpnext").status).toBe("available");
  });

  it("computes stock value from bins × valuation rates", async () => {
    const ctx = await ready();
    const { body } = await get(ctx, "/api/nammaops/dashboards/stock");
    const rates = new Map(ctx.data.item_master.map((m: Any) => [m.item_code, m.valuation_rate]));
    const expected =
      Math.round(
        ctx.data.bins.reduce(
          (s: number, b: Any) => s + b.actual_qty * Number(rates.get(b.item_code)),
          0,
        ) * 100,
      ) / 100;
    expect(cardValue(body, "total_stock_value")).toBeCloseTo(expected, 1);
    expect(cardValue(body, "total_warehouses")).toBe(2);
    // The hackathon low-stock result is unchanged by the larger catalogue.
    expect(
      body.tables.stock.rows.filter((r: Any) => r.status === "low").map((r: Any) => r.item_code),
    ).toEqual(["MILK-500", "OIL-SUN-1L"]);
  });

  it("ages receivables and payables consistently with the fixture's outstanding amounts", async () => {
    const ctx = await ready();
    const recv = (await get(ctx, "/api/nammaops/dashboards/receivables")).body;
    const outstanding = ctx.data.sales_invoices
      .filter((i: Any) => i.posting_date <= TODAY && i.outstanding_amount > 0)
      .reduce((s: number, i: Any) => s + i.outstanding_amount, 0);
    expect(cardValue(recv, "total_receivable")).toBeCloseTo(outstanding, 1);
    const buckets = recv.charts.receivables_ageing.series[0].values.reduce(
      (a: number, b: number) => a + b,
      0,
    );
    expect(buckets).toBeCloseTo(outstanding, 1);
    const pay = (await get(ctx, "/api/nammaops/dashboards/payables")).body;
    const owed = ctx.data.purchase_invoices.reduce(
      (s: number, i: Any) => s + i.outstanding_amount,
      0,
    );
    expect(cardValue(pay, "total_payable")).toBeCloseTo(owed, 1);
  });

  it("GST: tax heads add up and the dashboard is labelled indicative", async () => {
    const ctx = await ready();
    const { body } = await get(ctx, "/api/nammaops/dashboards/gst?from=2026-09-01&to=2026-10-31");
    const out = body.tables.summary.rows[0];
    expect(cardValue(body, "output_tax")).toBeCloseTo(out.cgst + out.sgst + out.igst, 1);
    expect(cardValue(body, "net_gst_payable")).toBeCloseTo(
      cardValue(body, "output_tax") - cardValue(body, "input_tax_credit"),
      1,
    );
    // The Tamil Nadu wholesale customer is an inter-state supply: IGST, not CGST/SGST.
    expect(out.igst).toBeGreaterThan(0);
    expect(body.disclaimer).toMatch(/not a GST filing/);
  });

  it("an empty range gives zero sales, not an error", async () => {
    const ctx = await ready();
    const { status, body } = await get(
      ctx,
      "/api/nammaops/dashboards/selling?from=2026-01-01&to=2026-01-31",
    );
    expect(status).toBe(200);
    expect(cardValue(body, "total_sales_amount")).toBe(0);
    expect(cardValue(body, "invoice_count")).toBe(0);
  });

  it("the dashboard principal can read but is never allowed to draft or submit", async () => {
    const ctx = await ready();
    const binding = ctx.nammaops.binding;
    await expect(
      binding.call(DASHBOARD_PRINCIPAL, "erp.po.create_draft", {
        supplier: "Bengaluru Wholesale Traders",
        items: [{ item_code: "MILK-500", qty: 1, rate: 1 }],
      }),
    ).rejects.toMatchObject({ workflowStatus: "blocked" });
    await expect(
      binding.call(DASHBOARD_PRINCIPAL, "erp.po.submit", { name: "PUR-ORD-FX-0001" }),
    ).rejects.toMatchObject({ workflowStatus: "blocked" });
  });

  it("a capability disabled in the binding becomes sections_unavailable, not a failure", async () => {
    const binding = loadBinding();
    binding.capabilities["erp.gst.summary"] = {
      tool: null,
      risk: "READ",
      disabled: "Not reviewed for this ERP.",
    };
    const ctx = await ready({ binding });
    const { status, body } = await get(ctx, "/api/nammaops/dashboards/gst");
    expect(status).toBe(200);
    expect(body.sections_unavailable).toEqual([
      expect.objectContaining({
        capability: "erp.gst.summary",
        status: "blocked",
        reason: expect.stringMatching(/^disabled_in_binding/),
      }),
    ]);
    // Missing data is unknown, never a zero tax liability.
    for (const card of body.cards) expect(card.value, card.id).toBeNull();
  });
});

describe("ServiceRegistry: ERPNext as an optional service", () => {
  it("is unconfigured without a binding and never exposes ERP credentials", () => {
    expect(new ServiceRegistry().get("erpnext")).toMatchObject({
      status: "unconfigured",
      configuration: { configured: false },
    });
    const env = {
      ERPNEXT_URL: "https://private-erp.example.com",
      ERPNEXT_API_KEY: "private-key",
      ERPNEXT_API_SECRET: "private-secret",
    };
    const live = new ServiceRegistry({
      env,
      erp: () => ({ shape: "hvgerp", serverId: "erpnext-live", stdioAllowed: true }),
    });
    expect(live.get("erpnext")).toMatchObject({
      status: "unverified",
      configuration: { configured: true, shape: "hvgerp" },
    });
    const json = JSON.stringify(live.snapshot());
    for (const secret of Object.values(env)) expect(json).not.toContain(secret);
    const missing = new ServiceRegistry({
      erp: () => ({ shape: "hvgerp", serverId: "erpnext-live", stdioAllowed: false }),
    }).get("erpnext");
    expect(missing.configuration.missing).toEqual(
      expect.arrayContaining(["ERPNEXT_URL", expect.stringMatching(/ALLOWLIST/)]),
    );
  });

  it("records governed call outcomes as observations", async () => {
    const ctx = await ready();
    const observe = vi.spyOn(ctx.runtime.services, "observe");
    await ctx.nammaops.binding.call(DASHBOARD_PRINCIPAL, "erp.items.list", {});
    expect(observe).toHaveBeenCalledWith("erpnext", "available");
  });
});
