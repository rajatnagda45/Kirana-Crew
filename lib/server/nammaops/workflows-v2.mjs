/**
 * Stage 1 (intelligence) workflows: receivables_report, expiry_check, purchase_status,
 * supplier_performance, customer_insights and store_health_report.
 *
 * They run on the existing Workflows runner: every ERP read is a governed call made inside a
 * specialist step under that agent's own identity, results are computed deterministically, and
 * the Manager consolidates. Nothing here writes to ERP.
 */
import { analyseStock, resolveProducts, stockByItem } from "./calculations.mjs";
import { addDays } from "./forecast.mjs";
import { ageing, daysBetween, round } from "./dashboards.mjs";

export const V2_INTENTS = [
  "receivables_report",
  "expiry_check",
  "purchase_status",
  "supplier_performance",
  "customer_insights",
  "store_health_report",
];
/** Item groups treated as perishable when prioritising expiry. */
const PERISHABLE = /dairy|bakery|bread|milk|curd|egg|fruit|vegetable|meat|fish|fresh/i;
const sum = (rows, pick) => round(rows.reduce((total, row) => total + Number(pick(row) || 0), 0));

/** Owner wording for the new workflows; checked before the original five. */
export function parseV2(lower) {
  if (
    /\b(problems?|issues?|health|biggest|what('s| is) wrong|how is my (shop|store))\b/.test(lower)
  )
    return { action: "store_health_report" };
  if (
    /\b(udhaar|udhar|credit|receivables?|outstanding|dues?|owes?|owed|collect|not paid|unpaid)\b/.test(
      lower,
    )
  )
    return { action: "receivables_report" };
  if (/\b(expir\w*|expiry|best before|shelf life)\b/.test(lower)) return { action: "expiry_check" };
  const productsAfter = (re) =>
    ((re.exec(lower) ?? [])[1] ?? "")
      .split(/,|\band\b|&/)
      .map((part) => part.replace(/\b(the|our|my|of|deliveries|delivery|orders?)\b/g, "").trim())
      .filter(Boolean);
  if (
    /\bsuppliers?\b|\bvendors?\b/.test(lower) &&
    /\b(delay\w*|late|performance|reliab\w*|on.time|slow)\b/.test(lower)
  )
    return {
      action: "supplier_performance",
      products: productsAfter(
        /\b(?:delaying|delay|for|of|our)\s+(?:our\s+)?([a-z ,&]+?)\s*(?:deliver\w*|orders?)?[.?!]*$/,
      ),
    };
  if (
    /\b(purchase orders?|po status|deliver\w*|received|pending orders?|orders? (status|pending))\b/.test(
      lower,
    )
  )
    return { action: "purchase_status" };
  if (
    /\bcustomers?\b/.test(lower) &&
    /\b(every week|weekly|regular|loyal|inactive|stopped|best|top|high.value|frequent\w*|insights?|which)\b/.test(
      lower,
    )
  )
    return { action: "customer_insights" };
  return null;
}

async function readSlices(call, businessId, from, to, key) {
  const rows = [];
  for (let start = from; start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    rows.push(
      ...((await call(businessId, { from_date: start, to_date: end < to ? end : to }))[key] ?? []),
    );
  }
  return rows;
}

// ---- Finance: udhaar ---------------------------------------------------------------------
async function receivablesReport(wf, workflowId, intent, workforce) {
  const asOf = wf.today();
  const finance = await wf.step(
    workflowId,
    workforce,
    "finance",
    "Read receivables and age the udhaar",
    async ({ call }) => {
      const data = await call("erp.receivables.aging", { as_of: asOf });
      const aged = ageing(data.invoices ?? [], asOf);
      const limits = new Map((data.customers ?? []).map((c) => [c.name, c]));
      const byCustomer = new Map();
      for (const row of aged.rows) {
        const entry = byCustomer.get(row.customer) ?? {
          customer: row.customer,
          outstanding: 0,
          invoices: [],
          oldest_days_overdue: 0,
          partially_paid: 0,
        };
        entry.outstanding = round(entry.outstanding + Number(row.outstanding_amount));
        entry.oldest_days_overdue = Math.max(entry.oldest_days_overdue, row.days_overdue);
        const partial = Number(row.outstanding_amount) < Number(row.grand_total);
        if (partial) entry.partially_paid += 1;
        entry.invoices.push({
          invoice: row.name,
          posting_date: row.posting_date,
          due_date: row.due_date,
          grand_total: Number(row.grand_total),
          outstanding: Number(row.outstanding_amount),
          days_overdue: row.days_overdue,
          partially_paid: partial,
        });
        byCustomer.set(row.customer, entry);
      }
      const customers = [...byCustomer.values()].map((c) => {
        const limit = limits.get(c.customer)?.credit_limit ?? null;
        return {
          ...c,
          credit_limit: limit,
          over_limit: limit ? c.outstanding > limit : false,
          // Older and larger dues first; anything not yet due waits.
          priority: c.oldest_days_overdue > 0 ? round(c.outstanding * c.oldest_days_overdue) : 0,
        };
      });
      customers.sort((a, b) => b.priority - a.priority || b.outstanding - a.outstanding);
      return {
        aged,
        customers,
        summary: `${customers.length} customer(s) owe ${aged.total}; ${customers.filter((c) => c.oldest_days_overdue > 30).length} have an invoice overdue by more than 30 days.`,
      };
    },
  );
  // Only invoices that are themselves more than 30 days past due count towards this figure.
  const over30Rows = finance.aged.rows.filter((r) => r.days_overdue > 30);
  const over30 = {
    customers: new Set(over30Rows.map((r) => r.customer)).size,
    amount: sum(over30Rows, (r) => r.outstanding_amount),
  };
  return {
    status: "completed",
    result: {
      kind: "receivables_report",
      as_of: asOf,
      total_outstanding: finance.aged.total,
      overdue: round(finance.aged.total - finance.aged.totals["Not due"]),
      buckets: finance.aged.totals,
      overdue_over_30_days: over30,
      partial_payments: finance.customers.reduce((n, c) => n + c.partially_paid, 0),
      collection_priority: finance.customers
        .filter((c) => c.priority > 0)
        .map(({ invoices, ...c }) => ({ ...c, invoices: invoices.length })),
      customers: finance.customers,
      sources: { capability: "erp.receivables.aging" },
    },
  };
}

// ---- Inventory: expiry -------------------------------------------------------------------
async function expiryCheck(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const inventory = await wf.step(
    workflowId,
    workforce,
    "inventory",
    "Read batches and value stock at risk of expiry",
    async ({ call }) => {
      const [{ batches }, { valuations }, { items }] = await Promise.all([
        call("erp.batches.list", {}),
        call("erp.items.valuation", {}),
        call("erp.items.list", {}),
      ]);
      const masters = new Map(valuations.map((v) => [v.item_code, v]));
      const names = new Map(items.map((i) => [i.item_code, i.item_name]));
      const rows = (batches ?? [])
        .filter((b) => Number(b.qty) > 0 && b.expiry_date)
        .map((b) => {
          const master = masters.get(b.item_code) ?? {};
          const days = daysBetween(today, b.expiry_date);
          const rate = Number(master.valuation_rate);
          const group =
            master.item_group ?? items.find((i) => i.item_code === b.item_code)?.item_group ?? null;
          return {
            batch_no: b.batch_no,
            item_code: b.item_code,
            item_name: names.get(b.item_code) ?? b.item_code,
            item_group: group,
            perishable: PERISHABLE.test(`${group ?? ""} ${names.get(b.item_code) ?? ""}`),
            qty: Number(b.qty),
            expiry_date: b.expiry_date,
            days_left: days,
            value_at_risk: Number.isFinite(rate) ? round(Number(b.qty) * rate) : null,
            window:
              days < 0
                ? "expired"
                : days <= 7
                  ? "7_days"
                  : days <= 15
                    ? "15_days"
                    : days <= 30
                      ? "30_days"
                      : "later",
          };
        })
        .filter((row) => row.window !== "later")
        // Perishables first, then soonest expiry, then value.
        .sort(
          (a, b) =>
            Number(b.perishable) - Number(a.perishable) ||
            a.days_left - b.days_left ||
            (b.value_at_risk ?? 0) - (a.value_at_risk ?? 0),
        );
      return {
        rows,
        tracked: (batches ?? []).length,
        summary: `${(batches ?? []).length} batch(es) read; ${rows.length} expired or expiring within 30 days.`,
      };
    },
  );
  const windows = {};
  for (const key of ["expired", "7_days", "15_days", "30_days"]) {
    const rows = inventory.rows.filter((r) => r.window === key);
    windows[key] = {
      batches: rows.length,
      qty: sum(rows, (r) => r.qty),
      value: sum(rows, (r) => r.value_at_risk),
    };
  }
  return {
    status: "completed",
    result: {
      kind: "expiry_check",
      as_of: today,
      batches_tracked: inventory.tracked,
      windows,
      value_at_risk: sum(inventory.rows, (r) => r.value_at_risk),
      unvalued_batches: inventory.rows.filter((r) => r.value_at_risk === null).length,
      items: inventory.rows,
      ...(inventory.tracked
        ? {}
        : { note: "No batch-tracked stock was returned by ERP, so expiry cannot be checked." }),
    },
  };
}

// ---- Procurement: purchase lifecycle -----------------------------------------------------
function purchaseLines(open, today) {
  return (open ?? []).flatMap((po) =>
    po.items.map((line) => ({
      purchase_order: po.name,
      supplier: po.supplier,
      item_code: line.item_code,
      ordered_qty: line.ordered_qty ?? null,
      received_qty: line.received_qty ?? null,
      pending_qty: Number(line.pending_qty),
      expected: po.schedule_date,
      days_late:
        po.schedule_date && Number(line.pending_qty) > 0
          ? Math.max(0, daysBetween(po.schedule_date, today))
          : 0,
      rate: line.rate ?? null,
    })),
  );
}

async function purchaseStatus(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const procurement = await wf.step(
    workflowId,
    workforce,
    "procurement",
    "Track open purchase orders, deliveries and supplier bills",
    async ({ call }) => {
      const [{ purchase_orders }, payables, { items }] = await Promise.all([
        call("erp.po.open", {}),
        call("erp.payables.aging", { as_of: today }),
        call("erp.items.list", {}),
      ]);
      const names = new Map(items.map((i) => [i.item_code, i.item_name]));
      const lines = purchaseLines(purchase_orders, today).map((l) => ({
        ...l,
        item_name: names.get(l.item_code) ?? l.item_code,
      }));
      const aged = ageing(payables.invoices ?? [], today);
      return {
        lines,
        aged,
        summary: `${purchase_orders.length} open purchase order(s), ${lines.filter((l) => l.days_late > 0).length} late line(s); ${aged.rows.length} unpaid supplier bill(s).`,
      };
    },
  );
  const late = procurement.lines
    .filter((l) => l.days_late > 0)
    .sort((a, b) => b.days_late - a.days_late);
  return {
    status: "completed",
    result: {
      kind: "purchase_status",
      as_of: today,
      open_orders: new Set(procurement.lines.map((l) => l.purchase_order)).size,
      lines: procurement.lines,
      delayed: late,
      partially_received: procurement.lines.filter((l) => l.received_qty > 0 && l.pending_qty > 0)
        .length,
      payables: {
        total: procurement.aged.total,
        overdue: round(procurement.aged.total - procurement.aged.totals["Not due"]),
        bills: procurement.aged.rows.map((r) => ({
          bill: r.name,
          supplier: r.supplier,
          due_date: r.due_date,
          outstanding: Number(r.outstanding_amount),
          days_overdue: r.days_overdue,
        })),
      },
    },
  };
}

async function supplierPerformance(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const from = addDays(today, -89);
  const procurement = await wf.step(
    workflowId,
    workforce,
    "procurement",
    "Score suppliers on delivery, price and dues",
    async ({ call }) => {
      const [{ suppliers }, { quotations }, { purchase_orders }, payables, { items }] =
        await Promise.all([
          call("erp.suppliers.list", {}),
          call("erp.supplier_quotations.list", {}),
          call("erp.po.open", {}),
          call("erp.payables.aging", { as_of: today }),
          call("erp.items.list", {}),
        ]);
      let focus = null;
      if (intent.products?.length) {
        const { resolved, clarifications } = resolveProducts(intent.products, items);
        if (clarifications.length)
          return { clarifications, summary: "Product needs clarification." };
        focus = new Set(resolved.map((r) => r.item.item_code));
      }
      const bills = await readSlices(call, "erp.purchase_invoices.list", from, today, "invoices");
      const lines = purchaseLines(purchase_orders, today).filter(
        (l) => !focus || focus.has(l.item_code),
      );
      const quotes = quotations.filter((q) => !focus || focus.has(q.item_code));
      const scores = suppliers.map((s) => {
        const own = lines.filter((l) => l.supplier === s.name);
        const late = own.filter((l) => l.days_late > 0);
        // Price variance: invoiced rate vs the supplier's own quotation for the same item.
        const variances = [];
        for (const bill of bills.filter((b) => b.supplier === s.name))
          for (const line of bill.items ?? []) {
            if (focus && !focus.has(line.item_code)) continue;
            const quote = quotes.find(
              (q) => q.supplier === s.name && q.item_code === line.item_code,
            );
            if (quote && Number(quote.rate) > 0)
              variances.push(
                round(((Number(line.rate) - Number(quote.rate)) / Number(quote.rate)) * 100, 1),
              );
          }
        const owed = (payables.invoices ?? []).filter((b) => b.supplier === s.name);
        return {
          supplier: s.name,
          quoted_lead_time_days: s.lead_time_days ?? null,
          on_time_rate: s.on_time_rate ?? null,
          open_lines: own.length,
          late_lines: late.length,
          max_days_late: late.length ? Math.max(...late.map((l) => l.days_late)) : 0,
          late_items: [...new Set(late.map((l) => l.item_code))],
          price_variance_pct: variances.length
            ? round(variances.reduce((a, b) => a + b, 0) / variances.length, 1)
            : null,
          quotations: quotes.filter((q) => q.supplier === s.name).length,
          outstanding: sum(owed, (b) => b.outstanding_amount),
        };
      });
      const relevant = focus ? scores.filter((s) => s.open_lines || s.quotations) : scores;
      relevant.sort(
        (a, b) =>
          b.late_lines - a.late_lines ||
          b.max_days_late - a.max_days_late ||
          (a.on_time_rate ?? 1) - (b.on_time_rate ?? 1),
      );
      return {
        scores: relevant,
        focus: focus ? [...focus] : null,
        summary: `${relevant.length} supplier(s) scored; ${relevant.filter((s) => s.late_lines).length} with late deliveries.`,
      };
    },
  );
  if (procurement.clarifications)
    return { status: "needs_clarification", clarifications: procurement.clarifications };
  return {
    status: "completed",
    result: {
      kind: "supplier_performance",
      as_of: today,
      products: procurement.focus,
      suppliers: procurement.scores,
      delaying: procurement.scores.filter((s) => s.late_lines > 0),
      price_basis:
        "Invoiced rate vs the same supplier's quotation for the same item, last 90 days.",
    },
  };
}

// ---- Sales: customer intelligence --------------------------------------------------------
async function customerInsights(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const from = addDays(today, -83); // 12 full weeks
  const sales = await wf.step(
    workflowId,
    workforce,
    "sales",
    "Analyse named-customer purchase history",
    async ({ call }) => {
      const [invoices, { customers }, { items }] = await Promise.all([
        readSlices(call, "erp.sales_invoices.list", from, today, "invoices"),
        call("erp.customers.list", {}),
        call("erp.items.list", {}),
      ]);
      const names = new Map(items.map((i) => [i.item_code, i.item_name]));
      const named = invoices.filter((i) => i.customer && i.customer !== "Walk-in Customer");
      const returns = invoices.filter((i) => i.is_return || Number(i.grand_total) < 0);
      const stats = new Map();
      for (const inv of named) {
        const s = stats.get(inv.customer) ?? {
          customer: inv.customer,
          invoices: 0,
          sales: 0,
          weeks: new Set(),
          last: null,
          products: new Map(),
        };
        s.invoices += 1;
        s.sales = round(s.sales + Number(inv.grand_total));
        s.weeks.add(Math.floor(daysBetween(from, inv.posting_date) / 7));
        s.last = !s.last || inv.posting_date > s.last ? inv.posting_date : s.last;
        for (const line of inv.items ?? [])
          s.products.set(line.item_code, (s.products.get(line.item_code) ?? 0) + Number(line.qty));
        stats.set(inv.customer, s);
      }
      const rows = [...stats.values()].map((s) => ({
        customer: s.customer,
        invoices: s.invoices,
        sales: s.sales,
        average_bill: round(s.sales / s.invoices),
        active_weeks: s.weeks.size,
        last_purchase: s.last,
        days_since_last: daysBetween(s.last, today),
        favourite_products: [...s.products]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([code, qty]) => ({ item: names.get(code) ?? code, qty })),
      }));
      rows.sort((a, b) => b.sales - a.sales);
      return {
        rows,
        customers: customers.length,
        returns: returns.map((r) => ({
          invoice: r.name,
          customer: r.customer,
          amount: Number(r.grand_total),
        })),
        summary: `${rows.length} named customer(s) bought in the last 12 weeks.`,
      };
    },
  );
  const rows = sales.rows;
  const weekly = rows.filter((r) => r.active_weeks >= 8);
  const regular = rows.filter((r) => r.invoices >= 3);
  const inactive = regular.filter((r) => r.days_since_last > 21);
  const cutoff = rows.length ? rows[Math.max(0, Math.ceil(rows.length * 0.2) - 1)].sales : 0;
  return {
    status: "completed",
    result: {
      kind: "customer_insights",
      period: { from_date: from, to_date: today },
      named_customers: sales.customers,
      buying_customers: rows.length,
      weekly_buyers: weekly,
      regular_customers: regular.length,
      inactive_regulars: inactive,
      high_value: rows.filter((r) => r.sales >= cutoff).slice(0, 10),
      customers: rows,
      returns: {
        count: sales.returns.length,
        amount: sum(sales.returns, (r) => r.amount),
        invoices: sales.returns,
      },
      discounts: {
        status: "not_available",
        reason: "Invoice discounts are not returned by the governed sales tools.",
      },
      definitions: {
        weekly: "Bought in at least 8 of the last 12 weeks.",
        regular: "At least 3 invoices in 12 weeks.",
        inactive: "A regular with no purchase in the last 21 days.",
        high_value: "Top 20% of named customers by sales.",
      },
    },
  };
}

// ---- Manager: store health ---------------------------------------------------------------
async function storeHealthReport(wf, workflowId, intent, workforce) {
  const today = wf.today();
  const yesterday = addDays(today, -1);
  const week = { from_date: addDays(today, -7), to_date: yesterday };
  const [sales, inventory, finance, procurement] = [
    await wf.step(
      workflowId,
      workforce,
      "sales",
      "Compare yesterday's sales with the past week",
      async ({ call }) => {
        const read = async (period) => [
          ...((await call("erp.sales_invoices.list", period)).invoices ?? []),
          ...((await call("erp.pos_invoices.list", period)).invoices ?? []),
        ];
        const recent = await read(week);
        const yday = sum(
          recent.filter((i) => i.posting_date === yesterday),
          (i) => i.grand_total,
        );
        const prior = recent.filter((i) => i.posting_date < yesterday);
        const average = round(sum(prior, (i) => i.grand_total) / 6);
        return { yday, average, summary: `Yesterday ${yday} vs 6-day average ${average}.` };
      },
      { optional: true },
    ),
    await wf.step(
      workflowId,
      workforce,
      "inventory",
      "Check low stock and near expiry",
      async ({ call }) => {
        const [{ items }, { bins }, { valuations }, { batches }] = await Promise.all([
          call("erp.items.list", {}),
          call("erp.stock.balance", {}),
          call("erp.items.valuation", {}),
          call("erp.batches.list", {}),
        ]);
        const { rows, low } = analyseStock(items, stockByItem(bins));
        const rate = new Map(valuations.map((v) => [v.item_code, Number(v.valuation_rate)]));
        const out = rows.filter((r) => r.available <= 0);
        const expiring = (batches ?? []).filter(
          (b) => Number(b.qty) > 0 && b.expiry_date && daysBetween(today, b.expiry_date) <= 7,
        );
        const expired = expiring.filter((b) => daysBetween(today, b.expiry_date) < 0);
        const value = (list) =>
          round(list.reduce((s, b) => s + Number(b.qty) * (rate.get(b.item_code) || 0), 0));
        return {
          low,
          out,
          batches_tracked: (batches ?? []).length,
          expired_value: value(expired),
          expiring_value: value(expiring.filter((b) => !expired.includes(b))),
          summary: `${low.length} low, ${out.length} out of stock; ${expiring.length} batch(es) expired or expiring within 7 days.`,
        };
      },
      { optional: true },
    ),
    await wf.step(
      workflowId,
      workforce,
      "finance",
      "Check udhaar and the past week's profit",
      async ({ call }) => {
        const data = await call("erp.receivables.aging", { as_of: today });
        const aged = ageing(data.invoices ?? [], today);
        const limits = new Map((data.customers ?? []).map((c) => [c.name, c.credit_limit]));
        const over30 = aged.rows.filter((r) => r.days_overdue > 30);
        const owed = new Map();
        for (const r of aged.rows)
          owed.set(r.customer, (owed.get(r.customer) ?? 0) + Number(r.outstanding_amount));
        const overLimit = [...owed]
          .filter(([c, v]) => limits.get(c) && v > limits.get(c))
          .map(([c]) => c);
        let pnl = null;
        try {
          pnl = await call("erp.pnl", week);
        } catch {
          pnl = null; // No posted P&L for the week is reported as unknown, not as zero.
        }
        return {
          total: aged.total,
          over30: {
            customers: new Set(over30.map((r) => r.customer)).size,
            amount: sum(over30, (r) => r.outstanding_amount),
          },
          overLimit,
          pnl,
          summary: `Udhaar ${aged.total}; ${sum(over30, (r) => r.outstanding_amount)} overdue >30 days.`,
        };
      },
      { optional: true },
    ),
    await wf.step(
      workflowId,
      workforce,
      "procurement",
      "Check supplier deliveries",
      async ({ call }) => {
        const { purchase_orders } = await call("erp.po.open", {});
        const late = purchaseLines(purchase_orders, today).filter((l) => l.days_late > 0);
        return { late, summary: `${late.length} purchase order line(s) delivered late.` };
      },
      { optional: true },
    ),
  ];
  const problems = [];
  const add = (area, severity, title, detail, impact = 0) =>
    problems.push({ area, severity, title, detail, impact: round(impact) });
  if (inventory.ok) {
    if (inventory.out.length)
      add(
        "inventory",
        3,
        `${inventory.out.length} item(s) out of stock`,
        inventory.out
          .slice(0, 5)
          .map((r) => r.item_name)
          .join(", "),
      );
    if (inventory.expired_value > 0)
      add(
        "inventory",
        3,
        "Expired stock on the shelf",
        `Value ${inventory.expired_value}; remove and write off.`,
        inventory.expired_value,
      );
    if (inventory.low.length)
      add(
        "inventory",
        2,
        `${inventory.low.length} item(s) at or below reorder level`,
        inventory.low
          .slice(0, 5)
          .map((r) => `${r.item_name} (${r.available})`)
          .join(", "),
      );
    if (inventory.expiring_value > 0)
      add(
        "inventory",
        2,
        "Stock expiring within 7 days",
        `Value ${inventory.expiring_value}; sell first or discount.`,
        inventory.expiring_value,
      );
  }
  if (finance.ok) {
    if (finance.over30.amount > 0)
      add(
        "finance",
        finance.over30.amount > 10000 ? 3 : 2,
        "Udhaar overdue more than 30 days",
        `${finance.over30.customers} customer(s) owe ${finance.over30.amount}.`,
        finance.over30.amount,
      );
    if (finance.overLimit.length)
      add("finance", 3, "Customers over their credit limit", finance.overLimit.join(", "));
    if (finance.pnl && finance.pnl.net_profit < 0)
      add(
        "finance",
        3,
        "Loss over the past week",
        `Posted net profit ${finance.pnl.net_profit}.`,
        -finance.pnl.net_profit,
      );
  }
  if (procurement.ok && procurement.late.length)
    add(
      "procurement",
      2,
      "Late supplier deliveries",
      procurement.late
        .slice(0, 4)
        .map((l) => `${l.supplier}: ${l.item_code} ${l.days_late} day(s) late`)
        .join("; "),
    );
  if (sales.ok && sales.average > 0 && sales.yday < sales.average * 0.7)
    add(
      "sales",
      2,
      "Sales dropped yesterday",
      `${sales.yday} vs average ${sales.average} (${round((1 - sales.yday / sales.average) * 100, 0)}% lower).`,
      sales.average - sales.yday,
    );
  problems.sort((a, b) => b.severity - a.severity || b.impact - a.impact);
  const checks = { sales, inventory, finance, procurement };
  const unchecked = Object.entries(checks)
    .filter(([, s]) => !s.ok)
    .map(([area, s]) => ({ area, reason: s.error }));
  // No batch data means expiry was not checked, which is not the same as "nothing expiring".
  if (inventory.ok && !inventory.batches_tracked)
    unchecked.push({ area: "expiry", reason: "No batch-tracked stock was returned by ERP." });
  return {
    status: unchecked.length ? "partial" : "completed",
    result: {
      kind: "store_health_report",
      as_of: today,
      problems: problems.slice(0, 5),
      all_problems: problems.length,
      unchecked,
      snapshot: {
        sales_yesterday: sales.ok ? sales.yday : null,
        sales_average: sales.ok ? sales.average : null,
        low_stock: inventory.ok ? inventory.low.length : null,
        out_of_stock: inventory.ok ? inventory.out.length : null,
        udhaar: finance.ok ? finance.total : null,
        net_profit_7_days: finance.ok && finance.pnl ? finance.pnl.net_profit : null,
        late_deliveries: procurement.ok ? procurement.late.length : null,
      },
    },
  };
}

export const V2_RUNNERS = {
  receivables_report: receivablesReport,
  expiry_check: expiryCheck,
  purchase_status: purchaseStatus,
  supplier_performance: supplierPerformance,
  customer_insights: customerInsights,
  store_health_report: storeHealthReport,
};

const inr = (v) => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** Numbers an optional model reply must reproduce exactly. */
export function keyFiguresV2(result) {
  switch (result.kind) {
    case "receivables_report":
      return {
        total_outstanding: result.total_outstanding,
        overdue_30_amount: result.overdue_over_30_days.amount,
      };
    case "expiry_check":
      return { batches_at_risk: result.items.length, value_at_risk: result.value_at_risk };
    case "purchase_status":
      return { open_orders: result.open_orders, delayed_lines: result.delayed.length };
    case "supplier_performance":
      return { suppliers_scored: result.suppliers.length, delaying: result.delaying.length };
    case "customer_insights":
      return {
        buying_customers: result.buying_customers,
        weekly_buyers: result.weekly_buyers.length,
      };
    case "store_health_report":
      return { problems: result.problems.length };
    default:
      return null;
  }
}

/** Deterministic owner-facing summary. */
export function summarizeV2(result) {
  switch (result.kind) {
    case "receivables_report": {
      const top = result.collection_priority
        .slice(0, 3)
        .map((c) => `${c.customer} ${inr(c.outstanding)} (${c.oldest_days_overdue} days)`);
      return `Udhaar pending ${inr(result.total_outstanding)}, ${inr(result.overdue)} overdue. ${result.overdue_over_30_days.customers} customer(s) have not paid for more than 30 days (${inr(result.overdue_over_30_days.amount)}).${top.length ? ` Collect first: ${top.join("; ")}.` : ""}${result.partial_payments ? ` ${result.partial_payments} invoice(s) are partly paid.` : ""}`;
    }
    case "expiry_check": {
      if (!result.batches_tracked) return result.note;
      const w = result.windows;
      const first = result.items
        .slice(0, 3)
        .map(
          (r) => `${r.item_name} ${r.qty} (${r.days_left < 0 ? "expired" : `${r.days_left} days`})`,
        );
      return `Expired ${w.expired.batches} batch(es) worth ${inr(w.expired.value)}; within 7 days ${w["7_days"].batches} (${inr(w["7_days"].value)}), 15 days ${w["15_days"].batches} (${inr(w["15_days"].value)}), 30 days ${w["30_days"].batches} (${inr(w["30_days"].value)}). Total at risk ${inr(result.value_at_risk)}.${first.length ? ` Act on: ${first.join("; ")}.` : ""}`;
    }
    case "purchase_status":
      return `${result.open_orders} open purchase order(s); ${result.delayed.length} line(s) late${
        result.delayed.length
          ? ` (${result.delayed
              .slice(0, 3)
              .map((l) => `${l.supplier}: ${l.item_name} ${l.days_late} days`)
              .join("; ")})`
          : ""
      }; ${result.partially_received} partly received. Supplier bills unpaid ${inr(result.payables.total)}, ${inr(result.payables.overdue)} overdue.`;
    case "supplier_performance":
      return result.delaying.length
        ? `${result.delaying.map((s) => `${s.supplier} is late on ${s.late_lines} line(s), up to ${s.max_days_late} day(s)${s.on_time_rate !== null ? `, on-time rate ${Math.round(s.on_time_rate * 100)}%` : ""}`).join("; ")}.`
        : `No late deliveries${result.products ? ` for ${result.products.join(", ")}` : ""} among ${result.suppliers.length} supplier(s).`;
    case "customer_insights":
      return `${result.buying_customers} named customer(s) bought in 12 weeks; ${result.weekly_buyers.length} buy every week${
        result.weekly_buyers.length
          ? ` (${result.weekly_buyers
              .slice(0, 4)
              .map((c) => c.customer)
              .join(", ")})`
          : ""
      }. Top customers: ${
        result.high_value
          .slice(0, 3)
          .map((c) => `${c.customer} ${inr(c.sales)}`)
          .join(", ") || "none"
      }. ${result.inactive_regulars.length} regular(s) inactive for 3+ weeks${
        result.inactive_regulars.length
          ? ` (${result.inactive_regulars
              .slice(0, 3)
              .map((c) => c.customer)
              .join(", ")})`
          : ""
      }. Returns: ${result.returns.count}.`;
    case "store_health_report":
      return result.problems.length
        ? `Top ${result.problems.length} problem(s): ${result.problems.map((p, i) => `${i + 1}. ${p.title} — ${p.detail}`).join(" ")}${result.unchecked.length ? ` Not checked: ${result.unchecked.map((u) => u.area).join(", ")}.` : ""}`
        : `No problems found in sales, stock, expiry, udhaar or deliveries.${result.unchecked.length ? ` Not checked: ${result.unchecked.map((u) => u.area).join(", ")}.` : ""}`;
    default:
      return null;
  }
}
