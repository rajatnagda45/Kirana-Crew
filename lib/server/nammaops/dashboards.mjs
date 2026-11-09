import { randomUUID } from "node:crypto";
import { aggregateSales, analyseStock, rankSuppliers, stockByItem } from "./calculations.mjs";
import { addDays, forecastItem } from "./forecast.mjs";

/**
 * ERPNext-style management dashboards (Stock, Buying, Selling, Accounts, CRM, Analytics,
 * Payables, Receivables, GST, Stock Ledger). Builders are deterministic over governed reads:
 * every ERP value comes from `ErpBinding.call` under the READ-only dashboard principal, so
 * Phase C grants, input validation and invocation audit apply exactly as for the agents.
 * A capability that is not available never fails a dashboard; its sections are listed in
 * `sections_unavailable` instead.
 */
export const DASHBOARDS = Object.freeze([
  "stock",
  "buying",
  "selling",
  "accounts",
  "crm",
  "analytics",
  "payables",
  "receivables",
  "gst",
  "stock-ledger",
]);
export const DASHBOARD_PRINCIPAL = "nammaops-dashboard-reader";
export const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const AGE_BUCKETS = ["Not due", "0-30", "31-60", "61-90", "90+"];

const fail = (status, message) => Object.assign(new Error(message), { status });
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export const round = (value, digits = 2) =>
  Math.round(Number(value || 0) * 10 ** digits) / 10 ** digits;
const sum = (rows, pick) => round(rows.reduce((total, row) => total + Number(pick(row) || 0), 0));
const validDay = (value) =>
  DATE.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** `?from=&to=` → a checked range. Defaults: to = today, from = to − 30 days. */
export function parseRange(query, today) {
  const to = query?.to ?? today;
  const from = query?.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (!validDay(from) || !validDay(to)) throw fail(400, "from and to must be YYYY-MM-DD dates.");
  if (to < from) throw fail(400, "to must not be before from.");
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS)
    throw fail(400, `The range may not exceed ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}

// ---------- pure helpers (exported for tests) ----------

/** Ageing bucket by days past due (ERPNext's default "Due Date" ageing basis). */
export function ageBucket(dueDate, asOf) {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return "Not due";
  if (overdue <= 30) return "0-30";
  if (overdue <= 60) return "31-60";
  if (overdue <= 90) return "61-90";
  return "90+";
}

/** Outstanding per ageing bucket; bucket totals always add up to the total outstanding. */
export function ageing(invoices, asOf) {
  const totals = Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, 0]));
  const rows = invoices.map((invoice) => {
    const bucket = ageBucket(invoice.due_date ?? invoice.posting_date, asOf);
    totals[bucket] = round(totals[bucket] + Number(invoice.outstanding_amount || 0));
    return {
      ...invoice,
      days_overdue: Math.max(0, daysBetween(invoice.due_date ?? invoice.posting_date, asOf)),
      bucket,
    };
  });
  return { rows, totals, total: sum(invoices, (row) => row.outstanding_amount) };
}

/**
 * ABC classification by cumulative revenue share (including the item): A up to 80 %, B up to
 * 95 %, C the rest. The single largest item is always A.
 */
export function abcClass(rows) {
  const total = rows.reduce((acc, row) => acc + row.value, 0);
  let running = 0;
  return [...rows]
    .sort((a, b) => b.value - a.value)
    .map((row, index) => {
      running += row.value;
      const after = total ? running / total : 1;
      return {
        ...row,
        share_pct: total ? round((row.value / total) * 100, 1) : 0,
        class: index === 0 || after <= 0.8 + 1e-9 ? "A" : after <= 0.95 + 1e-9 ? "B" : "C",
      };
    });
}

/** Taxable value backed out of a tax-inclusive amount. */
export const taxable = (amount, rate) =>
  round((Number(amount || 0) * 100) / (100 + Number(rate || 0)));

/** Label series for a range: daily up to 45 days, weekly beyond. */
export function periods(from, to) {
  const days = daysBetween(from, to) + 1;
  const step = days <= 45 ? 1 : 7;
  const out = [];
  for (let start = from; start <= to; start = addDays(start, step)) {
    const end = addDays(start, step - 1);
    out.push({
      start,
      end: end < to ? end : to,
      label: step === 1 ? start.slice(5) : `wk ${start.slice(5)}`,
    });
  }
  return out;
}
const periodIndex = (list, day) => list.findIndex((p) => day >= p.start && day <= p.end);

const card = (id, label, value, unit = "count", extra = {}) => ({
  id,
  label,
  value,
  unit,
  ...extra,
});
const chart = (type, labels, series, extra = {}) => ({ type, labels, series, ...extra });
const table = (columns, rows) => ({
  columns: columns.map(([key, label, unit]) => ({ key, label, ...(unit ? { unit } : {}) })),
  rows,
});
const topN = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);

// ---------- builder context ----------

/**
 * @param {{ binding: any, today: () => string, now?: () => Date, workforce: () => any }} deps
 */
export function createDashboards({ binding, today, now = () => new Date(), workforce }) {
  async function build(name, query = {}) {
    if (!DASHBOARDS.includes(name)) throw fail(404, "Unknown dashboard.");
    if (!workforce())
      throw fail(409, "The NammaOps workforce is not set up yet (POST /api/nammaops/setup).");
    const range = parseRange(query, today());
    const correlationId = `dash:${name}:${randomUUID()}`;
    const invocations = [];
    const unavailable = [];
    const failedCapabilities = new Set();

    /**
     * One governed read. Returns null (and records why) when the capability is not usable.
     * `tolerant` reads treat a tool-level failure (e.g. "no posted P&L for this week") as a gap
     * for that call only; a policy block still marks the capability unavailable.
     */
    async function read(businessId, args = {}, sections = [], { tolerant = false } = {}) {
      if (failedCapabilities.has(businessId)) return null;
      try {
        const { data, invocation_id } = await binding.call(DASHBOARD_PRINCIPAL, businessId, args, {
          correlationId,
        });
        invocations.push(invocation_id);
        return data;
      } catch (error) {
        if (error.invocation_id) invocations.push(error.invocation_id);
        if (tolerant && error.workflowStatus === "failed") return null;
        failedCapabilities.add(businessId);
        const disabled = binding.binding.capabilities[businessId]?.disabled;
        unavailable.push({
          sections,
          capability: businessId,
          status: error.workflowStatus ?? "failed",
          reason: disabled
            ? `disabled_in_binding: ${disabled}`
            : String(error.message ?? "unavailable").slice(0, 240),
        });
        return null;
      }
    }
    /**
     * A date-ranged read in 7-day slices (keeps each governed response small). A read that returns
     * one row per invoice line passes `days = 1`, so a busy slice stays under the response cap.
     */
    async function readRange(businessId, key, from, to, sections, days = 7) {
      const rows = [];
      for (let start = from; start <= to; start = addDays(start, days)) {
        const end = addDays(start, days - 1);
        const data = await read(
          businessId,
          { from_date: start, to_date: end < to ? end : to },
          sections,
        );
        if (!data) return null;
        rows.push(...(data[key] ?? []));
      }
      return rows;
    }

    const ctx = { range, today: today(), read, readRange };
    const body = await BUILDERS[name](ctx);
    const shape = binding.binding.shape;
    return {
      dashboard: name,
      source: shape === "fixture" ? "fixture" : "erpnext",
      verification: shape === "fixture" ? "synthetic_fixture" : "live_read_unverified",
      generated_at: now().toISOString(),
      range,
      cards: body.cards ?? [],
      charts: body.charts ?? {},
      tables: body.tables ?? {},
      ...(body.disclaimer ? { disclaimer: body.disclaimer } : {}),
      sections_unavailable: unavailable,
      invocation_ids: invocations,
      correlation_id: correlationId,
    };
  }
  return { list: () => [...DASHBOARDS], build };
}

// ---------- shared loaders ----------

async function catalogue(ctx, sections) {
  const [items, valuation] = await Promise.all([
    ctx.read("erp.items.list", {}, sections),
    ctx.read("erp.items.valuation", {}, sections),
  ]);
  const masters = new Map((valuation?.valuations ?? []).map((row) => [row.item_code, row]));
  const list = (items?.items ?? []).map((item) => ({
    ...item,
    item_group: item.item_group ?? masters.get(item.item_code)?.item_group ?? null,
  }));
  return { items: list, masters, names: new Map(list.map((i) => [i.item_code, i.item_name])) };
}

async function salesInvoices(ctx, from, to, sections) {
  const [sales, pos] = await Promise.all([
    ctx.readRange("erp.sales_invoices.list", "invoices", from, to, sections),
    ctx.readRange("erp.pos_invoices.list", "invoices", from, to, sections),
  ]);
  if (!sales && !pos) return null;
  return [...(sales ?? []), ...(pos ?? [])];
}

// ---------- builders ----------

const BUILDERS = {
  async stock(ctx) {
    const { from, to } = ctx.range;
    const { items, masters } = await catalogue(ctx, ["cards", "stock_table"]);
    const [balance, warehouses, movements] = await Promise.all([
      ctx.read("erp.stock.balance", {}, ["cards", "charts", "stock_table"]),
      ctx.read("erp.warehouses.list", {}, ["total_warehouses"]),
      ctx.readRange("erp.stock.movements", "entries", from, to, ["fast_movers"]),
    ]);
    const bins = balance?.bins ?? [];
    const { rows, low } = analyseStock(items, stockByItem(bins));
    const rate = (code) => Number(masters.get(code)?.valuation_rate ?? NaN);
    const valued = rows.map((row) => ({
      ...row,
      valuation_rate: Number.isFinite(rate(row.item_code)) ? rate(row.item_code) : null,
      stock_value: Number.isFinite(rate(row.item_code))
        ? round(row.available * rate(row.item_code))
        : null,
    }));
    const byGroup = new Map();
    for (const row of valued)
      if (row.stock_value !== null)
        byGroup.set(
          row.item_group ?? "Ungrouped",
          round((byGroup.get(row.item_group ?? "Ungrouped") ?? 0) + row.stock_value),
        );
    const byWarehouse = new Map();
    for (const bin of bins) {
      const value = Number.isFinite(rate(bin.item_code)) ? bin.actual_qty * rate(bin.item_code) : 0;
      byWarehouse.set(bin.warehouse, round((byWarehouse.get(bin.warehouse) ?? 0) + value));
    }
    const out = new Map();
    for (const row of movements ?? [])
      if (Number(row.actual_qty) < 0 && row.voucher_type === "Sales Invoice")
        out.set(row.item_code, round((out.get(row.item_code) ?? 0) - Number(row.actual_qty)));
    const names = new Map(items.map((i) => [i.item_code, i.item_name]));
    const fast = topN(out, 10);
    const groups = topN(byGroup, 12);
    const shortages = low
      .slice()
      .sort((a, b) => b.shortage - a.shortage)
      .slice(0, 12);
    return {
      cards: [
        card(
          "total_stock_value",
          "Total Stock Value",
          sum(valued, (r) => r.stock_value),
          "INR",
        ),
        card("total_active_items", "Items In Stock", valued.filter((r) => r.available > 0).length),
        card("low_stock", "Below Reorder Level", low.length, "count", {
          tone: low.length ? "warn" : "ok",
        }),
        card(
          "out_of_stock",
          "Out Of Stock",
          valued.filter((r) => r.available <= 0).length,
          "count",
          {
            tone: valued.some((r) => r.available <= 0) ? "bad" : "ok",
          },
        ),
        card("total_warehouses", "Warehouses", warehouses?.warehouses?.length ?? null),
      ],
      charts: {
        stock_value_by_item_group: chart(
          "donut",
          groups.map(([g]) => g),
          [{ name: "Stock value", values: groups.map(([, v]) => v) }],
          { unit: "INR", title: "Stock Value by Item Group" },
        ),
        warehouse_wise_stock_value: chart(
          "bar",
          [...byWarehouse.keys()],
          [{ name: "Stock value", values: [...byWarehouse.values()] }],
          { unit: "INR", title: "Warehouse wise Stock Value" },
        ),
        item_shortage_summary: chart(
          "bar",
          shortages.map((r) => r.item_name),
          [
            { name: "Shortage", values: shortages.map((r) => r.shortage) },
            { name: "Available", values: shortages.map((r) => r.available) },
          ],
          { title: "Item Shortage Summary" },
        ),
        fast_movers: chart(
          "bar",
          fast.map(([code]) => names.get(code) ?? code),
          [{ name: "Units sold", values: fast.map(([, qty]) => qty) }],
          { title: "Fast-moving Items" },
        ),
      },
      tables: {
        stock: table(
          [
            ["item_code", "Item"],
            ["item_name", "Name"],
            ["item_group", "Group"],
            ["available", "Available"],
            ["reorder_level", "Reorder Level"],
            ["status", "Status"],
            ["valuation_rate", "Valuation Rate", "INR"],
            ["stock_value", "Stock Value", "INR"],
          ],
          valued.map((row) => {
            const { warehouses, ...rest } = row;
            void warehouses;
            return rest;
          }),
        ),
      },
    };
  },

  async buying(ctx) {
    const { from, to } = ctx.range;
    const today = ctx.today;
    const [suppliers, quotations, open, bills, catalog] = await Promise.all([
      ctx.read("erp.suppliers.list", {}, ["active_suppliers"]),
      ctx.read("erp.supplier_quotations.list", {}, ["supplier_quotations"]),
      ctx.read("erp.po.open", {}, ["open_purchase_orders"]),
      ctx.readRange("erp.purchase_invoices.list", "invoices", from, to, [
        "purchase_trend",
        "top_suppliers",
      ]),
      catalogue(ctx, []),
    ]);
    const invoices = (bills ?? []).filter((b) => b.docstatus === undefined || b.docstatus === 1);
    const span = periods(from, to);
    const trend = span.map(() => 0);
    const bySupplier = new Map();
    for (const bill of invoices) {
      const i = periodIndex(span, bill.posting_date);
      if (i >= 0) trend[i] = round(trend[i] + Number(bill.grand_total || 0));
      bySupplier.set(
        bill.supplier,
        round((bySupplier.get(bill.supplier) ?? 0) + Number(bill.grand_total || 0)),
      );
    }
    const quotes = quotations?.quotations ?? [];
    const expiring = quotes.filter(
      (q) => q.valid_till && q.valid_till >= today && daysBetween(today, q.valid_till) <= 7,
    );
    const orders = (open?.purchase_orders ?? []).map((po) => ({
      name: po.name,
      supplier: po.supplier,
      schedule_date: po.schedule_date,
      lines: po.items.length,
      pending_qty: sum(po.items, (row) => row.pending_qty),
      overdue: Boolean(po.schedule_date && po.schedule_date < today),
    }));
    const total = sum(invoices, (b) => b.grand_total);
    const top = topN(bySupplier, 10);
    return {
      cards: [
        card("total_purchase_amount", "Purchase Amount", total, "INR"),
        card("purchase_bills", "Purchase Bills", invoices.length),
        card(
          "average_order_value",
          "Average Bill Value",
          invoices.length ? round(total / invoices.length) : 0,
          "INR",
        ),
        card("active_suppliers", "Suppliers", suppliers?.suppliers?.length ?? null),
        card("purchase_orders_to_receive", "Purchase Orders to Receive", orders.length, "count", {
          tone: orders.some((o) => o.overdue) ? "warn" : "ok",
        }),
        card("quotations_expiring", "Quotations Expiring (7d)", expiring.length, "count", {
          tone: expiring.length ? "warn" : "ok",
        }),
      ],
      charts: {
        purchase_trend: chart(
          "line",
          span.map((p) => p.label),
          [{ name: "Purchases", values: trend }],
          {
            unit: "INR",
            title: "Purchase Trends",
          },
        ),
        top_suppliers: chart(
          "bar",
          top.map(([s]) => s),
          [{ name: "Billed", values: top.map(([, v]) => v) }],
          {
            unit: "INR",
            title: "Top Suppliers",
          },
        ),
      },
      tables: {
        open_purchase_orders: table(
          [
            ["name", "Purchase Order"],
            ["supplier", "Supplier"],
            ["schedule_date", "Expected"],
            ["lines", "Lines"],
            ["pending_qty", "Pending Qty"],
            ["overdue", "Overdue"],
          ],
          orders,
        ),
        supplier_quotations: table(
          [
            ["name", "Quotation"],
            ["supplier", "Supplier"],
            ["item_name", "Item"],
            ["rate", "Rate", "INR"],
            ["lead_time_days", "Lead Time (days)"],
            ["valid_till", "Valid Till"],
            ["status", "Status"],
          ],
          quotes.map((q) => ({
            name: q.name,
            supplier: q.supplier,
            item_name: catalog.names.get(q.item_code) ?? q.item_code,
            rate: q.rate,
            lead_time_days: q.lead_time_days ?? null,
            valid_till: q.valid_till ?? null,
            status:
              q.valid_till && q.valid_till < today
                ? "expired"
                : expiring.includes(q)
                  ? "expiring"
                  : "valid",
          })),
        ),
      },
    };
  },

  async selling(ctx) {
    const { from, to } = ctx.range;
    const [invoices, catalog] = await Promise.all([
      salesInvoices(ctx, from, to, ["cards", "charts", "top_products"]),
      catalogue(ctx, []),
    ]);
    const all = invoices ?? [];
    const totals = aggregateSales(all, catalog.items);
    const span = periods(from, to);
    const trend = span.map(() => 0);
    const weekday = WEEKDAYS.map(() => ({ total: 0, days: new Set() }));
    const byGroup = new Map();
    const byItem = new Map();
    for (const invoice of all) {
      const i = periodIndex(span, invoice.posting_date);
      if (i >= 0) trend[i] = round(trend[i] + Number(invoice.grand_total || 0));
      const dow = new Date(`${invoice.posting_date}T00:00:00Z`).getUTCDay();
      weekday[dow].total += Number(invoice.grand_total || 0);
      weekday[dow].days.add(invoice.posting_date);
      for (const line of invoice.items ?? []) {
        const group = catalog.masters.get(line.item_code)?.item_group ?? "Ungrouped";
        byGroup.set(group, round((byGroup.get(group) ?? 0) + Number(line.amount || 0)));
        byItem.set(
          line.item_code,
          round((byItem.get(line.item_code) ?? 0) + Number(line.amount || 0)),
        );
      }
    }
    const pos = all.filter((invoice) => invoice.is_pos);
    const todays = all.filter((invoice) => invoice.posting_date === to);
    const items = topN(byItem, 10);
    const groups = topN(byGroup, 12);
    return {
      cards: [
        card("total_sales_amount", "Total Sales Amount", totals.total_sales, "INR"),
        card(
          "sales_on_last_day",
          `Sales on ${to}`,
          sum(todays, (r) => r.grand_total),
          "INR",
        ),
        card("invoice_count", "Invoices", totals.transaction_count),
        card(
          "average_bill_value",
          "Average Bill Value",
          totals.transaction_count ? round(totals.total_sales / totals.transaction_count) : 0,
          "INR",
        ),
        card(
          "pos_share",
          "Counter (POS) Share",
          totals.total_sales
            ? round((sum(pos, (r) => r.grand_total) / totals.total_sales) * 100, 1)
            : 0,
          "pct",
        ),
      ],
      charts: {
        sales_trend: chart(
          "line",
          span.map((p) => p.label),
          [{ name: "Sales", values: trend }],
          {
            unit: "INR",
            title: "Sales Trends",
          },
        ),
        top_items: chart(
          "bar",
          items.map(([code]) => catalog.names.get(code) ?? code),
          [{ name: "Sales", values: items.map(([, v]) => v) }],
          { unit: "INR", title: "Item-wise Sales" },
        ),
        sales_by_item_group: chart(
          "donut",
          groups.map(([g]) => g),
          [{ name: "Sales", values: groups.map(([, v]) => v) }],
          { unit: "INR", title: "Sales by Item Group" },
        ),
        weekday_pattern: chart(
          "bar",
          WEEKDAYS,
          [
            {
              name: "Average sales",
              values: weekday.map((d) => (d.days.size ? round(d.total / d.days.size) : 0)),
            },
          ],
          { unit: "INR", title: "Average Sales by Weekday" },
        ),
      },
      tables: {
        top_products: table(
          [
            ["item_code", "Item"],
            ["item_name", "Name"],
            ["qty", "Qty"],
            ["amount", "Amount", "INR"],
          ],
          totals.top_products,
        ),
      },
    };
  },

  async accounts(ctx) {
    const { from, to } = ctx.range;
    const span = weekly(from, to);
    const pnl = [];
    const cash = [];
    let pnlGaps = 0;
    for (const p of span) {
      const [profit, payments] = await Promise.all([
        ctx.read("erp.pnl", { from_date: p.start, to_date: p.end }, ["profit_and_loss"], {
          tolerant: true,
        }),
        ctx.read("erp.payments.summary", { from_date: p.start, to_date: p.end }, ["cash_flow"]),
      ]);
      if (!profit) pnlGaps += 1;
      pnl.push(profit);
      cash.push(payments);
    }
    const [receivables, payables] = await Promise.all([
      ctx.read("erp.receivables.aging", { as_of: to }, ["receivables"]),
      ctx.read("erp.payables.aging", { as_of: to }, ["payables"]),
    ]);
    const income = sum(pnl, (r) => r?.income);
    const expense = sum(pnl, (r) => r?.expense);
    const net = sum(pnl, (r) => r?.net_profit);
    return {
      cards: [
        card("income", "Income", income, "INR"),
        card("expense", "Expense", expense, "INR"),
        card("net_profit", "Net Profit", net, "INR", { tone: net < 0 ? "bad" : "ok" }),
        card("net_margin", "Net Margin", income ? round((net / income) * 100, 1) : 0, "pct"),
        card(
          "total_incoming_payment",
          "Payments Received",
          cash.some(Boolean) ? sum(cash, (r) => r?.received) : null,
          "INR",
        ),
        card(
          "total_outgoing_payment",
          "Payments Made",
          cash.some(Boolean) ? sum(cash, (r) => r?.paid) : null,
          "INR",
        ),
        card(
          "receivables",
          "Receivables",
          receivables ? sum(receivables.invoices, (r) => r.outstanding_amount) : null,
          "INR",
        ),
        card(
          "payables",
          "Payables",
          payables ? sum(payables.invoices, (r) => r.outstanding_amount) : null,
          "INR",
        ),
      ],
      charts: {
        profit_and_loss: chart(
          "bar",
          span.map((p) => p.label),
          [
            { name: "Income", values: pnl.map((r) => (r ? r.income : null)) },
            { name: "Expense", values: pnl.map((r) => (r ? r.expense : null)) },
            { name: "Net profit", values: pnl.map((r) => (r ? r.net_profit : null)) },
          ],
          { unit: "INR", title: "Profit and Loss", gaps: pnlGaps },
        ),
        cash_flow: chart(
          "line",
          span.map((p) => p.label),
          [
            { name: "Received", values: cash.map((r) => (r ? r.received : null)) },
            { name: "Paid", values: cash.map((r) => (r ? r.paid : null)) },
          ],
          { unit: "INR", title: "Cash Flow" },
        ),
      },
      tables: {
        periods: table(
          [
            ["period", "Period"],
            ["income", "Income", "INR"],
            ["expense", "Expense", "INR"],
            ["net_profit", "Net Profit", "INR"],
            ["received", "Received", "INR"],
            ["paid", "Paid", "INR"],
          ],
          span.map((p, i) => ({
            period: `${p.start} – ${p.end}`,
            income: pnl[i]?.income ?? null,
            expense: pnl[i]?.expense ?? null,
            net_profit: pnl[i]?.net_profit ?? null,
            received: cash[i]?.received ?? null,
            paid: cash[i]?.paid ?? null,
          })),
        ),
      },
      ...(pnlGaps
        ? {
            disclaimer: `${pnlGaps} period(s) have no posted profit and loss; they are shown as gaps, not zero.`,
          }
        : {}),
    };
  },

  async crm(ctx) {
    const { from, to } = ctx.range;
    const [customers, invoices, receivables] = await Promise.all([
      ctx.read("erp.customers.list", {}, ["cards", "customer_group_mix", "customers"]),
      salesInvoices(ctx, from, to, ["active_customers", "top_customers"]),
      ctx.read("erp.receivables.aging", { as_of: to }, ["outstanding"]),
    ]);
    const list = customers?.customers ?? [];
    const named = (invoices ?? []).filter((i) => i.customer && i.customer !== "Walk-in Customer");
    const stats = new Map();
    for (const invoice of named) {
      const row = stats.get(invoice.customer) ?? { invoices: 0, sales: 0 };
      row.invoices += 1;
      row.sales = round(row.sales + Number(invoice.grand_total || 0));
      stats.set(invoice.customer, row);
    }
    const outstanding = new Map();
    for (const inv of receivables?.invoices ?? [])
      outstanding.set(
        inv.customer,
        round((outstanding.get(inv.customer) ?? 0) + Number(inv.outstanding_amount)),
      );
    const groups = new Map();
    for (const c of list)
      groups.set(
        c.customer_group ?? "Unassigned",
        (groups.get(c.customer_group ?? "Unassigned") ?? 0) + 1,
      );
    const repeat = [...stats.values()].filter((row) => row.invoices >= 2).length;
    const newCustomers = list.filter((c) => c.since && c.since >= from && c.since <= to).length;
    const top = topN(new Map([...stats].map(([k, v]) => [k, v.sales])), 10);
    const walkIn = (invoices ?? []).filter((i) => i.customer === "Walk-in Customer");
    return {
      cards: [
        card("total_customers", "Customers", customers ? list.length : null),
        card("active_customers", "Active Customers", stats.size),
        card("new_customers", "New Customers", newCustomers),
        card(
          "repeat_rate",
          "Repeat Rate",
          stats.size ? round((repeat / stats.size) * 100, 1) : 0,
          "pct",
        ),
        card(
          "walk_in_sales",
          "Walk-in Sales",
          sum(walkIn, (r) => r.grand_total),
          "INR",
        ),
        card("top_customer", "Top Customer", top[0]?.[0] ?? null, "text"),
      ],
      charts: {
        customer_group_mix: chart(
          "donut",
          [...groups.keys()],
          [{ name: "Customers", values: [...groups.values()] }],
          {
            title: "Customers by Group",
          },
        ),
        top_customers: chart(
          "bar",
          top.map(([c]) => c),
          [{ name: "Sales", values: top.map(([, v]) => v) }],
          {
            unit: "INR",
            title: "Top Customers",
          },
        ),
      },
      tables: {
        customers: table(
          [
            ["name", "Customer"],
            ["customer_group", "Group"],
            ["invoices", "Invoices"],
            ["sales", "Sales", "INR"],
            ["outstanding", "Outstanding", "INR"],
            ["credit_limit", "Credit Limit", "INR"],
          ],
          list
            .map((c) => ({
              name: c.name,
              customer_group: c.customer_group ?? null,
              invoices: stats.get(c.name)?.invoices ?? 0,
              sales: stats.get(c.name)?.sales ?? 0,
              outstanding: outstanding.get(c.name) ?? 0,
              credit_limit: c.credit_limit ?? null,
            }))
            .sort((a, b) => b.sales - a.sales),
        ),
      },
    };
  },

  async analytics(ctx) {
    const { from, to } = ctx.range;
    const today = ctx.today;
    const historyFrom = addDays(today, -90);
    const yesterday = addDays(today, -1);
    const [catalog, balance, invoices, lines, ledger, open, quotations, suppliers] =
      await Promise.all([
        catalogue(ctx, ["gross_margin", "abc"]),
        ctx.read("erp.stock.balance", {}, ["turnover", "forecasts"]),
        salesInvoices(ctx, from, to, ["gross_margin", "abc"]),
        ctx.readRange("erp.sales.history", "lines", historyFrom, yesterday, ["forecasts"]),
        ctx.readRange("erp.stock.movements", "entries", historyFrom, yesterday, ["forecasts"]),
        ctx.read("erp.po.open", {}, ["forecasts"]),
        ctx.read("erp.supplier_quotations.list", {}, ["forecasts"]),
        ctx.read("erp.suppliers.list", {}, ["forecasts"]),
      ]);
    const masters = catalog.masters;
    const revenue = new Map();
    const cost = new Map();
    let unvalued = 0;
    for (const invoice of invoices ?? [])
      for (const line of invoice.items ?? []) {
        const master = masters.get(line.item_code);
        revenue.set(
          line.item_code,
          round((revenue.get(line.item_code) ?? 0) + taxable(line.amount, master?.gst_rate ?? 0)),
        );
        if (Number.isFinite(Number(master?.valuation_rate)))
          cost.set(
            line.item_code,
            round(
              (cost.get(line.item_code) ?? 0) + Number(line.qty) * Number(master.valuation_rate),
            ),
          );
        else unvalued += 1;
      }
    const totalRevenue = round([...revenue.values()].reduce((a, b) => a + b, 0));
    const cogs = round([...cost.values()].reduce((a, b) => a + b, 0));
    const stock = stockByItem(balance?.bins ?? []);
    const stockValue = round(
      [...stock].reduce(
        (acc, [code, row]) => acc + row.qty * Number(masters.get(code)?.valuation_rate ?? 0),
        0,
      ),
    );
    const days = daysBetween(from, to) + 1;
    const turnover = stockValue ? round((cogs / stockValue) * (365 / days), 1) : null;
    const abc = abcClass(
      [...revenue].map(([code, value]) => ({
        item_code: code,
        item_name: catalog.names.get(code) ?? code,
        value,
        margin_pct: value ? round(((value - (cost.get(code) ?? 0)) / value) * 100, 1) : null,
      })),
    );
    const counts = { A: 0, B: 0, C: 0 };
    for (const row of abc) counts[row.class] += 1;
    const byGroup = new Map();
    for (const [code, value] of revenue) {
      const group = masters.get(code)?.item_group ?? "Ungrouped";
      const row = byGroup.get(group) ?? { revenue: 0, cost: 0 };
      row.revenue = round(row.revenue + value);
      row.cost = round(row.cost + (cost.get(code) ?? 0));
      byGroup.set(group, row);
    }
    const groups = [...byGroup].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 10);
    // Forecast the top items (same deterministic forecastItem the demand_forecast workflow uses).
    const incoming = new Map();
    for (const po of open?.purchase_orders ?? [])
      for (const row of po.items)
        incoming.set(
          row.item_code,
          (incoming.get(row.item_code) ?? 0) + Number(row.pending_qty || 0),
        );
    const leadTime = (code) => {
      const leads = (quotations?.quotations ?? [])
        .filter((q) => q.item_code === code)
        .map(
          (q) =>
            q.lead_time_days ??
            (suppliers?.suppliers ?? []).find((s) => s.name === q.supplier)?.lead_time_days,
        )
        .filter((v) => Number.isFinite(Number(v)));
      return leads.length ? Math.min(...leads.map(Number)) : undefined;
    };
    const forecasts =
      lines && ledger
        ? abc.slice(0, 8).map((row) => {
            const item = catalog.items.find((i) => i.item_code === row.item_code) ?? row;
            const f = forecastItem({
              item,
              lines,
              ledger,
              today,
              available: stock.get(row.item_code)?.qty ?? 0,
              incoming: incoming.get(row.item_code) ?? 0,
              leadTimeDays: leadTime(row.item_code),
            });
            return {
              item_code: row.item_code,
              item_name: row.item_name,
              status: f.status,
              average_daily: f.average_daily_demand ?? null,
              next_7_days: f.forecast?.next_7_days ?? null,
              next_30_days: f.forecast?.next_30_days ?? null,
              days_of_cover: f.recommendation?.days_of_cover ?? null,
              suggested_qty: f.recommendation?.suggested_qty ?? null,
              method: f.method?.label ?? null,
            };
          })
        : [];
    return {
      cards: [
        card("revenue", "Revenue (ex-GST)", totalRevenue, "INR"),
        card("cogs", "Cost of Goods Sold", cogs, "INR"),
        card(
          "gross_margin",
          "Gross Margin",
          totalRevenue ? round(((totalRevenue - cogs) / totalRevenue) * 100, 1) : 0,
          "pct",
        ),
        card("inventory_turnover", "Inventory Turnover (annualised)", turnover, "x"),
        card(
          "days_of_inventory",
          "Days of Inventory",
          cogs ? round(stockValue / (cogs / days), 1) : null,
          "days",
        ),
        card("a_class_items", "A-class Items", counts.A),
      ],
      charts: {
        abc_classification: chart(
          "donut",
          ["A", "B", "C"],
          [{ name: "Items", values: [counts.A, counts.B, counts.C] }],
          {
            title: "ABC Classification (by revenue)",
          },
        ),
        margin_by_group: chart(
          "bar",
          groups.map(([g]) => g),
          [
            { name: "Revenue", values: groups.map(([, v]) => v.revenue) },
            { name: "Cost", values: groups.map(([, v]) => v.cost) },
          ],
          { unit: "INR", title: "Revenue vs Cost by Item Group" },
        ),
        forecast_next_7_days: chart(
          "bar",
          forecasts.map((f) => f.item_name),
          [{ name: "Forecast units (7d)", values: forecasts.map((f) => f.next_7_days) }],
          { title: "7-day Demand Forecast (top items)" },
        ),
      },
      tables: {
        abc: table(
          [
            ["item_code", "Item"],
            ["item_name", "Name"],
            ["value", "Revenue", "INR"],
            ["share_pct", "Share %", "pct"],
            ["margin_pct", "Margin %", "pct"],
            ["class", "Class"],
          ],
          abc,
        ),
        forecasts: table(
          [
            ["item_name", "Item"],
            ["status", "Status"],
            ["next_7_days", "Next 7d"],
            ["next_30_days", "Next 30d"],
            ["days_of_cover", "Days of Cover"],
            ["suggested_qty", "Suggested Order"],
          ],
          forecasts,
        ),
      },
      ...(unvalued
        ? {
            disclaimer: `${unvalued} sales line(s) have no valuation rate; their cost is not counted.`,
          }
        : {}),
    };
  },

  async payables(ctx) {
    const { to } = ctx.range;
    const [payables, suppliers, quotations, open] = await Promise.all([
      ctx.read("erp.payables.aging", { as_of: to }, ["cards", "payables_ageing", "payables"]),
      ctx.read("erp.suppliers.list", {}, ["supplier_scorecard"]),
      ctx.read("erp.supplier_quotations.list", {}, ["supplier_scorecard"]),
      ctx.read("erp.po.open", {}, ["supplier_scorecard"]),
    ]);
    const aged = ageing(payables?.invoices ?? [], to);
    const bySupplier = new Map();
    for (const row of aged.rows)
      bySupplier.set(
        row.supplier,
        round((bySupplier.get(row.supplier) ?? 0) + Number(row.outstanding_amount)),
      );
    const quotes = quotations?.quotations ?? [];
    const list = suppliers?.suppliers ?? [];
    // A supplier "wins" an item when rankSuppliers picks it for the item's largest quoted need.
    const wins = new Map();
    for (const code of new Set(quotes.map((q) => q.item_code))) {
      const ranking = rankSuppliers(code, 1, quotes, list, ctx.today);
      if (ranking.choice)
        wins.set(ranking.choice.supplier, (wins.get(ranking.choice.supplier) ?? 0) + 1);
    }
    const openBy = new Map();
    for (const po of open?.purchase_orders ?? [])
      openBy.set(po.supplier, (openBy.get(po.supplier) ?? 0) + 1);
    const dueSoon = aged.rows.filter(
      (r) => r.bucket === "Not due" && daysBetween(to, r.due_date) <= 7,
    );
    const overdue = round(aged.total - aged.totals["Not due"]);
    const top = topN(bySupplier, 10);
    return {
      cards: [
        card("total_payable", "Total Payable", payables ? aged.total : null, "INR"),
        card("overdue_payable", "Overdue", payables ? overdue : null, "INR", {
          tone: overdue > 0 ? "warn" : "ok",
        }),
        card(
          "due_next_7_days",
          "Due in Next 7 Days",
          sum(dueSoon, (r) => r.outstanding_amount),
          "INR",
        ),
        card("suppliers_with_dues", "Suppliers with Dues", bySupplier.size),
      ],
      charts: {
        payables_ageing: chart(
          "aging",
          AGE_BUCKETS,
          [{ name: "Outstanding", values: AGE_BUCKETS.map((b) => aged.totals[b]) }],
          {
            unit: "INR",
            title: "Accounts Payable Ageing",
          },
        ),
        payable_by_supplier: chart(
          "bar",
          top.map(([s]) => s),
          [{ name: "Outstanding", values: top.map(([, v]) => v) }],
          {
            unit: "INR",
            title: "Outstanding by Supplier",
          },
        ),
      },
      tables: {
        payables: table(
          [
            ["name", "Bill"],
            ["supplier", "Supplier"],
            ["posting_date", "Date"],
            ["due_date", "Due"],
            ["grand_total", "Amount", "INR"],
            ["outstanding_amount", "Outstanding", "INR"],
            ["days_overdue", "Days Overdue"],
            ["bucket", "Ageing"],
          ],
          aged.rows.sort((a, b) => b.days_overdue - a.days_overdue),
        ),
        supplier_scorecard: table(
          [
            ["supplier", "Supplier"],
            ["lead_time_days", "Lead Time (days)"],
            ["on_time_rate", "On-time %", "pct"],
            ["quotations", "Quotations"],
            ["best_price_items", "Best-price Items"],
            ["open_orders", "Open POs"],
            ["outstanding", "Outstanding", "INR"],
          ],
          list.map((s) => ({
            supplier: s.name,
            lead_time_days: s.lead_time_days ?? null,
            on_time_rate:
              s.on_time_rate !== undefined && s.on_time_rate !== null
                ? round(s.on_time_rate * 100, 1)
                : null,
            quotations: quotes.filter((q) => q.supplier === s.name).length,
            best_price_items: wins.get(s.name) ?? 0,
            open_orders: openBy.get(s.name) ?? 0,
            outstanding: bySupplier.get(s.name) ?? 0,
          })),
        ),
      },
    };
  },

  async receivables(ctx) {
    const { to } = ctx.range;
    const data = await ctx.read("erp.receivables.aging", { as_of: to }, [
      "cards",
      "receivables_ageing",
      "customers",
      "collection_list",
    ]);
    const aged = ageing(data?.invoices ?? [], to);
    const limits = new Map((data?.customers ?? []).map((c) => [c.name, c]));
    const byCustomer = new Map();
    for (const row of aged.rows) {
      const entry = byCustomer.get(row.customer) ?? { outstanding: 0, oldest: 0, invoices: 0 };
      entry.outstanding = round(entry.outstanding + Number(row.outstanding_amount));
      entry.oldest = Math.max(entry.oldest, row.days_overdue);
      entry.invoices += 1;
      byCustomer.set(row.customer, entry);
    }
    const customers = [...byCustomer].map(([name, row]) => {
      const limit = limits.get(name)?.credit_limit ?? null;
      return {
        customer: name,
        customer_group: limits.get(name)?.customer_group ?? null,
        invoices: row.invoices,
        outstanding: row.outstanding,
        credit_limit: limit,
        utilisation_pct: limit ? round((row.outstanding / limit) * 100, 1) : null,
        over_limit: limit ? row.outstanding > limit : false,
        oldest_days_overdue: row.oldest,
      };
    });
    const collection = customers
      .filter((c) => c.oldest_days_overdue > 0)
      .map((c) => ({ ...c, priority: round(c.outstanding * Math.max(1, c.oldest_days_overdue)) }))
      .sort((a, b) => b.priority - a.priority);
    const overdue = round(aged.total - aged.totals["Not due"]);
    const top = customers
      .slice()
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 10);
    return {
      cards: [
        card("total_receivable", "Total Receivable (Udhaar)", data ? aged.total : null, "INR"),
        card("overdue_receivable", "Overdue", data ? overdue : null, "INR", {
          tone: overdue > 0 ? "warn" : "ok",
        }),
        card("customers_with_dues", "Customers with Dues", customers.length),
        card(
          "over_credit_limit",
          "Over Credit Limit",
          customers.filter((c) => c.over_limit).length,
          "count",
          {
            tone: customers.some((c) => c.over_limit) ? "bad" : "ok",
          },
        ),
      ],
      charts: {
        receivables_ageing: chart(
          "aging",
          AGE_BUCKETS,
          [{ name: "Outstanding", values: AGE_BUCKETS.map((b) => aged.totals[b]) }],
          {
            unit: "INR",
            title: "Accounts Receivable Ageing",
          },
        ),
        receivable_by_customer: chart(
          "bar",
          top.map((c) => c.customer),
          [
            { name: "Outstanding", values: top.map((c) => c.outstanding) },
            { name: "Credit limit", values: top.map((c) => c.credit_limit) },
          ],
          { unit: "INR", title: "Outstanding vs Credit Limit" },
        ),
      },
      tables: {
        customers: table(
          [
            ["customer", "Customer"],
            ["customer_group", "Group"],
            ["invoices", "Invoices"],
            ["outstanding", "Outstanding", "INR"],
            ["credit_limit", "Credit Limit", "INR"],
            ["utilisation_pct", "Utilisation %", "pct"],
            ["over_limit", "Over Limit"],
            ["oldest_days_overdue", "Oldest Overdue (days)"],
          ],
          customers.sort((a, b) => b.outstanding - a.outstanding),
        ),
        collection_list: table(
          [
            ["customer", "Customer"],
            ["outstanding", "Outstanding", "INR"],
            ["oldest_days_overdue", "Oldest Overdue (days)"],
            ["priority", "Priority Score"],
          ],
          collection,
        ),
        invoices: table(
          [
            ["name", "Invoice"],
            ["customer", "Customer"],
            ["posting_date", "Date"],
            ["due_date", "Due"],
            ["outstanding_amount", "Outstanding", "INR"],
            ["days_overdue", "Days Overdue"],
            ["bucket", "Ageing"],
          ],
          aged.rows.sort((a, b) => b.days_overdue - a.days_overdue),
        ),
      },
    };
  },

  async gst(ctx) {
    const { from, to } = ctx.range;
    const [lines, catalog] = await Promise.all([
      ctx.readRange("erp.gst.summary", "lines", from, to, ["cards", "charts", "tables"], 1),
      catalogue(ctx, []),
    ]);
    const rows = lines ?? [];
    const outward = rows.filter((l) => l.direction === "outward");
    const inward = rows.filter((l) => l.direction === "inward");
    const totals = (list) => ({
      taxable_value: sum(list, (l) => l.taxable_value),
      cgst: sum(list, (l) => l.cgst),
      sgst: sum(list, (l) => l.sgst),
      igst: sum(list, (l) => l.igst),
    });
    const tax = (t) => round(t.cgst + t.sgst + t.igst);
    const out = totals(outward);
    const itc = totals(inward);
    const slabs = [...new Set(rows.map((l) => l.gst_rate))].sort((a, b) => a - b);
    const bySlab = slabs.map((rate) => ({
      gst_rate: rate,
      ...totals(outward.filter((l) => l.gst_rate === rate)),
    }));
    const hsn = new Map();
    for (const line of outward) {
      const key = `${line.hsn_code ?? "—"}|${line.gst_rate}`;
      const row = hsn.get(key) ?? {
        hsn_code: line.hsn_code ?? null,
        gst_rate: line.gst_rate,
        items: new Set(),
        qty: 0,
        taxable_value: 0,
        tax: 0,
      };
      row.items.add(catalog.names.get(line.item_code) ?? line.item_code);
      row.qty = round(row.qty + Number(line.qty || 0));
      row.taxable_value = round(row.taxable_value + line.taxable_value);
      row.tax = round(row.tax + line.cgst + line.sgst + line.igst);
      hsn.set(key, row);
    }
    const b2b = outward.filter((l) => l.party_type === "B2B");
    const b2c = outward.filter((l) => l.party_type !== "B2B");
    // Live ERPNext lines carry ERPNext's own tax fields (gst_treatment); the fixture's do not.
    const recorded = rows.some((l) => l.gst_treatment !== undefined);
    // When no outward line says whether the buyer had a GSTIN, B2B and B2C are unknown, not B2C.
    const partyUnknown = Boolean(outward.length) && !outward.some((l) => l.party_type);
    return {
      cards: [
        // Unavailable GST data is unknown (null), never shown as a zero liability.
        card("outward_taxable", "Outward Taxable Value", lines ? out.taxable_value : null, "INR"),
        card("output_tax", "Output GST", lines ? tax(out) : null, "INR"),
        card("input_tax_credit", "Input Tax Credit", lines ? tax(itc) : null, "INR"),
        card(
          "net_gst_payable",
          "Net GST Payable",
          lines ? round(tax(out) - tax(itc)) : null,
          "INR",
        ),
        card(
          "b2b_invoices",
          "B2B Invoices",
          lines && !partyUnknown ? new Set(b2b.map((l) => l.document)).size : null,
        ),
      ],
      charts: {
        tax_by_slab: chart(
          "bar",
          slabs.map((r) => `${r}%`),
          [
            { name: "CGST", values: bySlab.map((s) => s.cgst) },
            { name: "SGST", values: bySlab.map((s) => s.sgst) },
            { name: "IGST", values: bySlab.map((s) => s.igst) },
          ],
          { unit: "INR", title: "Output Tax by GST Slab", stacked: true },
        ),
        b2b_vs_b2c: chart(
          "donut",
          partyUnknown ? ["Not classified (no GSTIN on invoices)"] : ["B2B", "B2C"],
          [
            {
              name: "Taxable value",
              values: partyUnknown
                ? [sum(outward, (l) => l.taxable_value)]
                : [sum(b2b, (l) => l.taxable_value), sum(b2c, (l) => l.taxable_value)],
            },
          ],
          { unit: "INR", title: "B2B vs B2C (taxable value)" },
        ),
        output_vs_itc: chart(
          "bar",
          ["CGST", "SGST", "IGST"],
          [
            { name: "Output tax", values: [out.cgst, out.sgst, out.igst] },
            { name: "Input tax credit", values: [itc.cgst, itc.sgst, itc.igst] },
          ],
          { unit: "INR", title: "Output Tax vs Input Tax Credit" },
        ),
      },
      tables: {
        summary: table(
          [
            ["head", "Head"],
            ["taxable_value", "Taxable Value", "INR"],
            ["cgst", "CGST", "INR"],
            ["sgst", "SGST", "INR"],
            ["igst", "IGST", "INR"],
            ["total_tax", "Total Tax", "INR"],
          ],
          [
            { head: "Outward supplies (3.1a)", ...out, total_tax: tax(out) },
            { head: "Input tax credit (4A)", ...itc, total_tax: tax(itc) },
            {
              head: "Net payable",
              taxable_value: null,
              cgst: round(out.cgst - itc.cgst),
              sgst: round(out.sgst - itc.sgst),
              igst: round(out.igst - itc.igst),
              total_tax: round(tax(out) - tax(itc)),
            },
          ],
        ),
        by_slab: table(
          [
            ["gst_rate", "GST %", "pct"],
            ["taxable_value", "Taxable Value", "INR"],
            ["cgst", "CGST", "INR"],
            ["sgst", "SGST", "INR"],
            ["igst", "IGST", "INR"],
          ],
          bySlab,
        ),
        hsn_summary: table(
          [
            ["hsn_code", "HSN"],
            ["gst_rate", "GST %", "pct"],
            ["items", "Items"],
            ["qty", "Qty"],
            ["taxable_value", "Taxable Value", "INR"],
            ["tax", "Tax", "INR"],
          ],
          [...hsn.values()]
            .map((row) => ({ ...row, items: [...row.items].slice(0, 4).join(", ") }))
            .sort((a, b) => b.taxable_value - a.taxable_value),
        ),
      },
      disclaimer: recorded
        ? "Indicative only, not a GST filing. Taxable values and tax amounts are as ERPNext recorded them on each invoice line; reconcile with your GSTR-1/3B in the GST portal."
        : "Indicative only, not a GST filing. Line amounts are treated as tax-inclusive; reconcile with your GSTR-1/3B in the GST portal.",
    };
  },

  async "stock-ledger"(ctx) {
    const { from, to } = ctx.range;
    const today = ctx.today;
    const lookback = addDays(to, -89) < from ? addDays(to, -89) : from;
    const [catalog, movements, batches] = await Promise.all([
      catalogue(ctx, ["stock_ageing", "expiry"]),
      ctx.readRange("erp.stock.movements", "entries", lookback, to, ["movements", "stock_ageing"]),
      ctx.read("erp.batches.list", {}, ["expiry"]),
    ]);
    const all = movements ?? [];
    const inRange = all.filter((m) => m.posting_date >= from && m.posting_date <= to);
    const span = periods(from, to);
    const inward = span.map(() => 0);
    const outward = span.map(() => 0);
    const byType = new Map();
    for (const m of inRange) {
      const qty = Number(m.actual_qty || 0);
      const i = periodIndex(span, m.posting_date);
      if (i >= 0 && qty >= 0) inward[i] = round(inward[i] + qty);
      else if (i >= 0) outward[i] = round(outward[i] - qty);
      byType.set(m.voucher_type, round((byType.get(m.voucher_type) ?? 0) + Math.abs(qty)));
    }
    const rate = (code) => Number(catalog.masters.get(code)?.valuation_rate ?? 0);
    // Stock ageing: days since the item's last inward movement (90+ when none in the window).
    const lastIn = new Map();
    for (const m of all)
      if (
        Number(m.actual_qty) > 0 &&
        (!lastIn.has(m.item_code) || m.posting_date > lastIn.get(m.item_code))
      )
        lastIn.set(m.item_code, m.posting_date);
    const latestBalance = new Map();
    for (const m of all)
      if (m.qty_after_transaction !== undefined)
        latestBalance.set(m.item_code, {
          day: m.posting_date,
          qty: Number(m.qty_after_transaction),
        });
    const ageTotals = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    for (const item of catalog.items) {
      const qty = latestBalance.get(item.item_code)?.qty;
      if (!qty || qty <= 0) continue;
      const days = lastIn.has(item.item_code) ? daysBetween(lastIn.get(item.item_code), to) : 91;
      const bucket = days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
      ageTotals[bucket] = round(ageTotals[bucket] + qty * rate(item.item_code));
    }
    const expiryBuckets = {
      Expired: 0,
      "≤30 days": 0,
      "31-60 days": 0,
      "61-90 days": 0,
      "> 90 days": 0,
    };
    const batchRows = (batches?.batches ?? [])
      .filter((b) => Number(b.qty) > 0)
      .map((b) => {
        const left = b.expiry_date ? daysBetween(today, b.expiry_date) : null;
        const value = round(Number(b.qty) * rate(b.item_code));
        const bucket =
          left === null
            ? null
            : left < 0
              ? "Expired"
              : left <= 30
                ? "≤30 days"
                : left <= 60
                  ? "31-60 days"
                  : left <= 90
                    ? "61-90 days"
                    : "> 90 days";
        if (bucket) expiryBuckets[bucket] = round(expiryBuckets[bucket] + value);
        return {
          batch_no: b.batch_no,
          item_name: catalog.names.get(b.item_code) ?? b.item_code,
          qty: Number(b.qty),
          expiry_date: b.expiry_date ?? null,
          days_left: left,
          value,
          status: bucket ?? "no expiry",
        };
      })
      .sort((a, b) => (a.days_left ?? 1e9) - (b.days_left ?? 1e9));
    const typeKeys = topN(byType, 8);
    return {
      cards: [
        card(
          "inward_qty",
          "Units In",
          sum(
            inRange.filter((m) => m.actual_qty > 0),
            (m) => m.actual_qty,
          ),
        ),
        card(
          "outward_qty",
          "Units Out",
          -sum(
            inRange.filter((m) => m.actual_qty < 0),
            (m) => m.actual_qty,
          ),
        ),
        card(
          "expired_value",
          "Expired Stock Value",
          batches ? expiryBuckets.Expired : null,
          "INR",
          {
            tone: expiryBuckets.Expired ? "bad" : "ok",
          },
        ),
        card(
          "expiring_30_value",
          "Expiring ≤30 Days",
          batches ? expiryBuckets["≤30 days"] : null,
          "INR",
          {
            tone: expiryBuckets["≤30 days"] ? "warn" : "ok",
          },
        ),
        card("batches_tracked", "Batches Tracked", batches ? batchRows.length : null),
      ],
      charts: {
        stock_movement: chart(
          "bar",
          span.map((p) => p.label),
          [
            { name: "In", values: inward },
            { name: "Out", values: outward },
          ],
          { title: "Stock Movement" },
        ),
        movement_by_type: chart(
          "donut",
          typeKeys.map(([t]) => t),
          [{ name: "Units", values: typeKeys.map(([, v]) => v) }],
          {
            title: "Movement by Voucher Type",
          },
        ),
        stock_ageing: chart(
          "aging",
          Object.keys(ageTotals),
          [{ name: "Stock value", values: Object.values(ageTotals) }],
          {
            unit: "INR",
            title: "Stock Ageing (days since last receipt)",
          },
        ),
        expiry: chart(
          "aging",
          Object.keys(expiryBuckets),
          [{ name: "Stock value", values: Object.values(expiryBuckets) }],
          {
            unit: "INR",
            title: "Batch Expiry",
          },
        ),
      },
      tables: {
        movements: table(
          [
            ["posting_date", "Date"],
            ["item_name", "Item"],
            ["voucher_type", "Voucher Type"],
            ["actual_qty", "Qty In/Out"],
            ["qty_after_transaction", "Balance"],
          ],
          inRange
            .slice()
            .sort((a, b) => b.posting_date.localeCompare(a.posting_date))
            .slice(0, 300)
            .map((m) => ({
              posting_date: m.posting_date,
              item_name: catalog.names.get(m.item_code) ?? m.item_code,
              voucher_type: m.voucher_type,
              actual_qty: Number(m.actual_qty),
              qty_after_transaction: m.qty_after_transaction ?? null,
            })),
        ),
        batches: table(
          [
            ["batch_no", "Batch"],
            ["item_name", "Item"],
            ["qty", "Qty"],
            ["expiry_date", "Expiry"],
            ["days_left", "Days Left"],
            ["value", "Value", "INR"],
            ["status", "Status"],
          ],
          batchRows,
        ),
      },
      ...(inRange.length > 300
        ? { disclaimer: `Showing the latest 300 of ${inRange.length} movements.` }
        : {}),
    };
  },
};

/** Weekly periods for P&L and cash-flow reads (fewer governed calls for short ranges). */
function weekly(from, to) {
  const out = [];
  for (let start = from; start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    out.push({ start, end: end < to ? end : to, label: `wk ${start.slice(5)}` });
  }
  return out;
}
