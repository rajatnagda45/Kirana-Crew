import { describe, expect, it } from "vitest";
import { HVGERP_READS, createAdapter } from "../mcp/hvgerp-adapter-server.mjs";

// UNIT ONLY. A tiny hvgerp double with latency, to check the adapter's caching and parallelism
// keep results identical while cutting round trips. Nothing here talks to ERPNext.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const page = (data: Any[], extra: Any = {}) => ({
  count: data.length,
  returned: data.length,
  has_more: false,
  data,
  ...extra,
});
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeHv({ delay = 5, pageLimit = Infinity, failItemsOnce = false } = {}) {
  const calls: Array<{ name: string; arguments: Any }> = [];
  let active = 0;
  let peak = 0;
  let itemsFailures = failItemsOnce ? 1 : 0;
  const sales = [
    { name: "S-1", posting_date: "2026-11-01", status: "Paid" },
    { name: "S-2", posting_date: "2026-11-02", status: "Paid" },
    { name: "S-3", posting_date: "2026-11-03", status: "Paid" },
    { name: "S-4", posting_date: "2026-11-04", status: "Paid" },
  ];
  const doc = (name: string, date: string, pos = false) => ({
    data: {
      name,
      posting_date: date,
      docstatus: 1,
      customer: "Walk-in",
      grand_total: 10,
      is_pos: pos,
      items: [{ item_code: "MILK", qty: 1, amount: 10 }],
    },
  });
  const inWindow = (rows: Any[], from: string, to: string) =>
    rows.filter((row) => row.posting_date >= from && row.posting_date <= to);
  const limited = (rows: Any[]) =>
    rows.length > pageLimit
      ? page(rows.slice(0, pageLimit), { has_more: true, count: rows.length })
      : page(rows);
  const handlers: Record<string, (args: Any) => Any> = {
    erpnext_item_list: () => {
      if (itemsFailures > 0) {
        itemsFailures -= 1;
        throw new Error("ERPNext busy");
      }
      return page([
        { name: "MILK", item_code: "MILK", item_name: "Milk", stock_uom: "Nos" },
        { name: "RICE", item_code: "RICE", item_name: "Rice", stock_uom: "Kg" },
      ]);
    },
    erpnext_item_get: (args) => ({ data: { name: args.name, reorder_levels: [] } }),
    erpnext_sales_invoice_list: (args) =>
      limited(inWindow(sales, args.date_from, args.date_to)),
    erpnext_sales_invoice_get: (args) =>
      doc(args.name, sales.find((row) => row.name === args.name)!.posting_date),
    erpnext_doc_list: (args) => {
      if (args.doctype === "POS Invoice") {
        const pos = [{ name: "P-1", posting_date: "2026-11-02", docstatus: 1 }];
        const [, , from] = args.filters[0];
        const [, , to] = args.filters[1];
        return page(inWindow(pos, from, to));
      }
      return page([]);
    },
    erpnext_doc_get: (args) => doc(args.name, "2026-11-02", true),
  };
  return {
    calls,
    get peak() {
      return peak;
    },
    listTools: async () => ({
      tools: HVGERP_READS.map((name) => ({ name, annotations: { readOnlyHint: true } })),
    }),
    async callTool({ name, arguments: args }: Any) {
      calls.push({ name, arguments: args });
      active += 1;
      peak = Math.max(peak, active);
      try {
        await tick(delay);
        const body = handlers[name]?.(args) ?? page([]);
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      } catch (error: Any) {
        return { isError: true, content: [{ type: "text", text: error.message }] };
      } finally {
        active -= 1;
      }
    },
  };
}
const parse = (result: Any) => JSON.parse(result.content[0].text);
const count = (hv: Any, name: string) => hv.calls.filter((c: Any) => c.name === name).length;

describe("adapter timing metadata", () => {
  it("reports hvgerp round trips and cache use outside the business payload", async () => {
    const hv: Any = fakeHv();
    const adapter = createAdapter({ client: hv });
    const cold = await adapter.call("list_items");
    expect(cold._meta.nammaops).toMatchObject({ hv_calls: 3, cache_hits: 0, cache_misses: 1 });
    expect(parse(cold)).not.toHaveProperty("_meta");
    const warm = await adapter.call("list_items");
    expect(warm._meta.nammaops).toMatchObject({ hv_calls: 0, cache_hits: 1 });
    expect(parse(warm).items).toEqual(parse(cold).items);
  });
});

describe("adapter cache", () => {
  it("shares one in-flight load between concurrent callers", async () => {
    const hv: Any = fakeHv({ delay: 20 });
    const adapter = createAdapter({ client: hv });
    const [a, b] = await Promise.all([adapter.call("list_items"), adapter.call("list_items")]);
    expect(parse(a).items).toEqual(parse(b).items);
    expect(count(hv, "erpnext_item_list")).toBe(1);
    expect(count(hv, "erpnext_item_get")).toBe(2);
  });

  it("does not keep a failed load: the next call retries", async () => {
    const hv: Any = fakeHv({ failItemsOnce: true });
    const adapter = createAdapter({ client: hv });
    await expect(adapter.call("list_items")).rejects.toThrow(/ERPNext busy/);
    expect(parse(await adapter.call("list_items")).items).toHaveLength(2);
  });

  it("expires after the configured TTL", async () => {
    let now = 1_000;
    const hv: Any = fakeHv();
    const adapter = createAdapter({ client: hv, now: () => now, cacheMs: 1_000 });
    await adapter.call("list_items");
    now += 999;
    await adapter.call("list_items");
    expect(count(hv, "erpnext_item_list")).toBe(1);
    now += 2;
    await adapter.call("list_items");
    expect(count(hv, "erpnext_item_list")).toBe(2);
  });
});

describe("adapter parallel reads keep results identical", () => {
  it("reads sales and POS together, sales lines first", async () => {
    const hv: Any = fakeHv({ delay: 20 });
    const adapter = createAdapter({ client: hv });
    const { lines } = parse(
      await adapter.call("list_sales_lines", { from_date: "2026-11-01", to_date: "2026-11-04" }),
    );
    expect(lines.map((row: Any) => row.document)).toEqual(["S-1", "S-2", "S-3", "S-4", "P-1"]);
    // The POS header list did not wait for every sales invoice detail.
    const order = hv.calls.map((c: Any) => c.name);
    expect(order.indexOf("erpnext_doc_list")).toBeLessThan(
      order.lastIndexOf("erpnext_sales_invoice_get"),
    );
  });

  it("splits partial windows in parallel and keeps chronological order", async () => {
    const hv: Any = fakeHv({ pageLimit: 1 });
    const adapter = createAdapter({ client: hv });
    const { invoices } = parse(
      await adapter.call("list_sales_invoices", { from_date: "2026-11-01", to_date: "2026-11-04" }),
    );
    expect(invoices.map((row: Any) => row.name)).toEqual(["S-1", "S-2", "S-3", "S-4"]);
  });

  it("sends the first request to a fresh hvgerp alone, then reads in parallel", async () => {
    const hv: Any = fakeHv({ delay: 15 });
    const adapter = createAdapter({ client: hv });
    const spans: Array<{ start: number; end: number }> = [];
    const original = hv.callTool.bind(hv);
    hv.callTool = async (request: Any) => {
      const span = { start: performance.now(), end: 0 };
      spans.push(span);
      try {
        return await original(request);
      } finally {
        span.end = performance.now();
      }
    };
    await adapter.call("list_receivables", { as_of: "2026-11-04" });
    // Receivables makes two independent reads; on a fresh hvgerp the second waits for the first.
    expect(spans).toHaveLength(2);
    expect(spans[1].start).toBeGreaterThanOrEqual(spans[0].end);
    await Promise.all([
      adapter.call("list_sales_invoices", { from_date: "2026-11-01", to_date: "2026-11-04" }),
      adapter.call("list_pos_invoices", { from_date: "2026-11-01", to_date: "2026-11-04" }),
    ]);
    expect(hv.peak).toBeGreaterThan(1);
  });

  it("never exceeds the process-wide hvgerp concurrency limit", async () => {
    const hv: Any = fakeHv({ delay: 10 });
    const adapter = createAdapter({ client: hv, concurrency: 3 });
    await Promise.all([
      adapter.call("list_sales_invoices", { from_date: "2026-11-01", to_date: "2026-11-04" }),
      adapter.call("list_pos_invoices", { from_date: "2026-11-01", to_date: "2026-11-04" }),
      adapter.call("list_items"),
    ]);
    expect(hv.peak).toBeLessThanOrEqual(3);
  });
});
