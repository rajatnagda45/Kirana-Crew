import { createHash } from "node:crypto";
import Ajv from "ajv";
import { addDays } from "./forecast.mjs";
import { summarizeV2 } from "./workflows-v2.mjs";

/** One record per voice business question: which voice agent asked, which workflow answered. */
export const VOICE_CONSULT_NAMESPACE = "nammaops.voice_consult";

/**
 * Voice business intents -> the existing deterministic workflows. A voice intent never maps to a
 * workflow that does not compute what it asks for (for example, supplier comparison is its own
 * quotation comparison, not a demand forecast).
 */
export const VOICE_INTENTS = Object.freeze({
  // The product catalogue is the Inventory specialist's full stock read, listed in full.
  list_products: "stock_check",
  check_stock: "stock_check",
  sales_summary: "daily_report",
  top_selling_products: "daily_report",
  business_profit: "daily_report",
  demand_forecast: "demand_forecast",
  supplier_comparison: "supplier_comparison",
  prepare_purchase_order: "prepare_reorder",
  // Stage 1 workflows (named like the workflow they run).
  receivables_report: "receivables_report",
  expiry_check: "expiry_check",
  purchase_status: "purchase_status",
  supplier_performance: "supplier_performance",
  customer_insights: "customer_insights",
  store_health_report: "store_health_report",
  business_report: "business_report",
  billing_summary: "billing_summary",
  // Finance and procurement reads over the live ERP (read-only).
  payments_summary: "payments_summary",
  gst_summary: "gst_summary",
  purchase_order_lookup: "purchase_order_lookup",
  // Frank prepares a DRAFT customer bill; the owner approves it with their PIN (a separate action).
  prepare_bill: "prepare_bill",
});
const PRODUCT_INTENTS = new Set([
  "list_products",
  "check_stock",
  "demand_forecast",
  "supplier_comparison",
  "prepare_purchase_order",
  "supplier_performance",
]);
const DAY_INTENTS = new Set(["sales_summary", "top_selling_products", "business_profit"]);

const fail = (status, message) => Object.assign(new Error(message), { status });
const validateArgs = new Ajv({ allErrors: true }).compile({
  type: "object",
  properties: {
    intent: { enum: Object.keys(VOICE_INTENTS) },
    products: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 60 },
    },
    day: { type: "string", pattern: "^(today|yesterday|\\d{4}-\\d{2}-\\d{2})$" },
    /** Last day (inclusive) of a multi-day sales report. */
    to: { type: "string", pattern: "^(today|yesterday|\\d{4}-\\d{2}-\\d{2})$" },
    qty: { type: "integer", minimum: 1, maximum: 100000 },
    workflow_id: { type: "string", pattern: "^wf_[a-z0-9]{1,40}$" },
    /** receivables_report only: all udhaar, udhaar raised in the period, or what falls due soon. */
    focus: { enum: ["all", "new", "due_soon"] },
    /** purchase_order_lookup only: the ERPNext purchase order id, such as PUR-ORD-2026-00004. */
    po_name: { type: "string", pattern: "^[A-Za-z0-9 _.-]{1,64}$" },
    /** prepare_bill only: the customer's name (else the walk-in customer) and what they bought. */
    customer: { type: "string", minLength: 1, maxLength: 140 },
    lines: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          product: { type: "string", minLength: 1, maxLength: 60 },
          quantity: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          unit: { type: "string", maxLength: 12 },
        },
        required: ["product"],
        additionalProperties: false,
      },
    },
  },
  anyOf: [{ required: ["intent"] }, { required: ["workflow_id"] }],
  additionalProperties: false,
});

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const unique = (values) => [...new Set(values.filter(Boolean))];

/**
 * Server-side router for the `nammaops_business_query` voice tool. It starts an existing NammaOps
 * workflow (specialists read ERP data under their own identities through Phase C governance) and
 * returns only facts computed by that workflow. The voice seat's department is presentation: it is
 * never used to authorize a call. This router never approves or submits a purchase: approval is
 * the separate `approve_by_voice` action, which needs the owner's PIN.
 */
export class VoiceRouter {
  /** @param {{workflows: any, binding: any, db: () => any, departments?: any, waitMs?: number}} options */
  constructor({ workflows, binding, db, departments, waitMs = 20000 }) {
    this.workflows = workflows;
    this.binding = binding;
    this.db = db;
    this.departments = departments ?? { seats: [], background: [] };
    this.waitMs = waitMs;
  }

  get source() {
    return this.binding.binding.shape === "fixture" ? "fixture" : "erpnext_live";
  }

  /** The department a voice seat speaks for, by seat label. Presentation only. */
  department(seatLabel) {
    const label = String(seatLabel ?? "")
      .trim()
      .toLowerCase();
    const seat = (this.departments.seats ?? []).find(
      (row) => row.voice_name.toLowerCase() === label,
    );
    if (!seat) return null;
    return {
      department: seat.department,
      title: seat.title,
      colleagues: (this.departments.seats ?? [])
        .filter((row) => row !== seat)
        .map((row) => ({ name: row.voice_name, department: row.department, title: row.title })),
      background: (this.departments.background ?? []).map((row) => ({
        department: row.department,
        title: row.title,
      })),
    };
  }

  /** @param {{call: any, actionId: string, args: any}} input */
  async query({ call, actionId, args, waitMs }) {
    const received = performance.now();
    const department = this.department(call.name);
    if (!department) throw fail(403, `${call.name} is not a NammaOps department voice agent.`);
    if (!validateArgs(args))
      throw fail(400, "Invalid business query. Choose a supported intent and plain product names.");
    const db = this.db();
    const consults = db.records(VOICE_CONSULT_NAMESPACE);

    // Follow-up on a workflow this call started (for example one that was still running).
    if (args.workflow_id) {
      const own = consults.find(
        (row) => row.workflow_id === args.workflow_id && row.call_id === call.id,
      );
      if (!own) throw fail(404, "No business query with that workflow ID in this call.");
      return this.result(this.workflows.view(own.workflow_id), own.intent, department);
    }

    // One spoken tool call starts at most one workflow, across HTTP retries.
    const key = createHash("sha256")
      .update(JSON.stringify([call.id, actionId]))
      .digest("hex");
    const previous = db.record(VOICE_CONSULT_NAMESPACE, key);
    if (previous) {
      if (previous.intent !== args.intent)
        throw fail(409, "Voice action ID was already used for another request.");
      return this.result(this.workflows.view(previous.workflow_id), previous.intent, department);
    }

    const today = this.workflows.today();
    const date =
      !args.day || args.day === "today"
        ? today
        : args.day === "yesterday"
          ? addDays(today, -1)
          : args.day;
    if (DAY_INTENTS.has(args.intent) && date > today)
      return this.contract({
        status: "clarification_required",
        intent: args.intent,
        department,
        clarification_required: true,
        clarification_questions: [`${date} is in the future. Which day do you mean?`],
      });
    const action = VOICE_INTENTS[args.intent];
    const products = PRODUCT_INTENTS.has(args.intent) ? (args.products ?? []) : undefined;
    const end =
      args.to === "today"
        ? today
        : args.to === "yesterday"
          ? addDays(today, -1)
          : (args.to ?? null);
    const intent = {
      action,
      ...(products ? { products } : {}),
      ...(action === "daily_report" ? { date } : {}),
      ...(action === "daily_report" && end && end !== date ? { to: end } : {}),
      // Only a profit question reads the posted P&L; sales questions stay about sales.
      ...(action === "daily_report" && args.intent !== "business_profit"
        ? { with_profit: false }
        : {}),
      ...((action === "business_report" || action === "billing_summary") && args.day
        ? { date, ...(end ? { to: end } : {}) }
        : {}),
      // With no day named, payments and GST cover the month so far (the workflow's default).
      ...((action === "payments_summary" || action === "gst_summary") && args.day
        ? { date, ...(end ? { to: end } : {}) }
        : {}),
      ...(action === "prepare_bill"
        ? { ...(args.customer ? { customer: args.customer.trim() } : {}), lines: args.lines ?? [] }
        : {}),
      ...(action === "purchase_order_lookup" && args.po_name
        ? { po_name: args.po_name.trim().toUpperCase() }
        : {}),
      ...(action === "supplier_comparison" && args.qty ? { qty: args.qty } : {}),
      ...(action === "receivables_report" && args.focus && args.focus !== "all"
        ? {
            focus: args.focus,
            ...(args.focus === "new" ? { date, ...(end ? { to: end } : {}) } : {}),
          }
        : {}),
    };

    let started;
    try {
      started = this.workflows.start(
        { intent },
        {
          origin: {
            channel: "voice",
            call_id: call.id,
            voice_agent: call.name,
            voice_department: department.department,
            voice_intent: args.intent,
          },
        },
      );
    } catch (error) {
      if (!(error.status >= 400 && error.status < 500)) throw error;
      return this.contract({
        status: "unavailable",
        intent: args.intent,
        department,
        limitations: [error.message],
      });
    }
    const workflowId = started.workflow.id;
    db.saveRecord(
      VOICE_CONSULT_NAMESPACE,
      key,
      {
        call_id: call.id,
        action_id: actionId,
        voice_agent: call.name,
        voice_department: department.department,
        intent: args.intent,
        workflow_intent: intent,
        workflow_id: workflowId,
        status: "running",
        consulted: [],
        at: new Date().toISOString(),
      },
      0,
    );
    this.workflows.save(
      workflowId,
      {},
      {
        type: "VOICE_CONSULT",
        agent: "manager",
        detail: `${call.name} (${department.title}) asked by voice: ${args.intent}`,
      },
    );
    const startedMs = performance.now();
    let timer;
    let timedOut = false;
    const view = await Promise.race([
      started.done,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(this.workflows.view(workflowId));
        }, waitMs ?? this.waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    const waited = performance.now();
    const response = this.result(view, args.intent, department);
    const record = db.record(VOICE_CONSULT_NAMESPACE, key);
    db.saveRecord(
      VOICE_CONSULT_NAMESPACE,
      key,
      {
        ...Object.fromEntries(
          Object.entries(record).filter(([name]) => !["id", "revision"].includes(name)),
        ),
        status: response.status,
        consulted: response.consulted,
        finished_at: new Date().toISOString(),
        // Trace: workflow_id is the correlation id on every governed ERP invocation of this query.
        timing: {
          trace_id: workflowId,
          setup_ms: Math.round(startedMs - received),
          workflow_wait_ms: Math.round(waited - startedMs),
          total_ms: Math.round(performance.now() - received),
          timed_out: timedOut,
        },
      },
      record.revision,
    );
    return response;
  }

  contract({ status, intent, department, workflow_id = null, ...rest }) {
    return {
      status,
      intent,
      source: this.source,
      workflow_id,
      voice_department: department?.department ?? null,
      consulted: rest.consulted ?? [],
      facts: rest.facts ?? [],
      recommendations: rest.recommendations ?? [],
      evidence: rest.evidence ?? [],
      documents: (rest.documents ?? []).slice(0, 20),
      documents_total: (rest.documents ?? []).length,
      result: rest.result ?? null, // raw workflow result for language-aware rendering
      limitations: [
        this.source === "fixture"
          ? "Data source: NammaOps test fixture (synthetic data), not live ERPNext."
          : `Data source: ${this.binding.binding.data_label ?? "live ERPNext"}.`,
        ...(rest.limitations ?? []),
      ],
      clarification_required: rest.clarification_required ?? false,
      clarification_questions: rest.clarification_questions ?? [],
      approval_required: rest.approval_required ?? false,
      approvals: rest.approvals ?? [],
      speak_rule:
        "Say only these facts, recommendations and limitations. Do not add numbers, products or outcomes that are not listed here.",
    };
  }

  /** Workflow view -> the voice contract. Facts come only from the workflow's computed result. */
  result(view, intent, department) {
    if (!view)
      return this.contract({
        status: "unavailable",
        intent,
        department,
        limitations: ["The workflow record was not found."],
      });
    const evidence = view.tasks.map((task) => ({
      department: task.role,
      agent: task.agent_name,
      task_id: task.id,
      step: task.title,
      status: task.status,
      capabilities: unique(task.evidence.map((row) => row.business_capability)),
      invocation_ids: task.evidence.map((row) => row.invocation_id),
    }));
    const consulted = unique(
      view.tasks.filter((task) => task.role !== "manager").map((task) => task.role),
    );
    const base = { intent, department, workflow_id: view.id, evidence, consulted };
    if (view.status === "running")
      return this.contract({
        ...base,
        status: "running",
        limitations: [
          `Still running. Ask again with workflow_id ${view.id} for the result; nothing is final yet.`,
        ],
      });
    if (view.status === "needs_clarification") {
      // Recorded categories let the speaker offer real products for an unknown word (for
      // example "pulses" -> the Staples items), instead of saying the data is missing.
      const categories = (view.clarifications ?? []).find((row) => row.categories)?.categories;
      return this.contract({
        ...base,
        status: "clarification_required",
        facts: categories
          ? Object.entries(categories).map(
              ([group, names]) =>
                `${group} (${plural(names.length, "product")}): ${names.join(", ")}.`,
            )
          : [],
        limitations: categories
          ? [
              "The requested name is not a recorded product or category. Offer the closest recorded products from these categories and ask which one; do not claim a product exists unless it is listed.",
            ]
          : [],
        clarification_required: true,
        clarification_questions: (view.clarifications ?? []).map((row) =>
          row.reason === "missing_product"
            ? "Which product should I compare suppliers for?"
            : row.reason === "ambiguous"
              ? `"${row.requested}" could be ${row.options.join(" or ")}. Which one?`
              : row.reason === "missing_quantity"
                ? `How many ${row.requested} should be on the bill?`
                : row.reason === "missing_items"
                  ? "What did the customer buy, and how many of each?"
                  : row.reason === "unit_mismatch"
                    ? row.question
                    : row.reason === "ambiguous_customer"
                      ? `"${row.requested}" could be ${row.options.join(" or ")}. Which customer?`
                      : row.reason === "unknown_customer"
                        ? `I could not find a customer called "${row.requested}". Which customer, or should I use Walk-in Customer?`
                        : `I could not find "${row.requested}" in the product list. Which product do you mean?`,
        ),
      });
    }
    const expected = VOICE_INTENTS[intent];
    if (!view.result || view.result.kind !== expected)
      return this.contract({
        ...base,
        status: "unavailable",
        limitations: [view.error ?? `The ${expected} workflow did not produce a result.`],
      });
    const shaped = SHAPERS[intent](view.result, { today: this.workflows.today() });
    return this.contract({
      ...base,
      ...shaped,
      result: view.result, // raw result included for language-aware chat rendering
      status:
        shaped.status ??
        (view.status === "awaiting_approval"
          ? "awaiting_approval"
          : view.status === "partial"
            ? "partial"
            : "completed"),
      limitations: [...(shaped.limitations ?? [])],
    });
  }
}

const supplierText = (choice) =>
  choice
    ? `${choice.supplier} at ${choice.rate} per unit${choice.lead_time_days !== null ? `, ${plural(choice.lead_time_days, "day")} lead time` : ""}`
    : null;

const SHAPERS = {
  /** Every product, grouped by its ERP category, with current stock. Never truncated. */
  list_products(result) {
    const groups = new Map();
    for (const row of result.rows) {
      const group = row.item_group || "Other";
      groups.set(group, [...(groups.get(group) ?? []), row]);
    }
    const facts = [
      `${plural(result.rows.length, "product")} in ${groups.size} ${groups.size === 1 ? "category" : "categories"}.`,
      ...[...groups].map(
        ([group, rows]) =>
          `${group} (${rows.length}): ${rows.map((row) => `${row.item_name} ${row.available}${row.status === "low" ? " (low)" : ""}`).join(", ")}.`,
      ),
    ];
    return {
      facts,
      recommendations: result.low.length
        ? [
            `${plural(result.low.length, "product")} at or below reorder level: ${result.low.map((row) => row.item_name).join(", ")}.`,
          ]
        : [],
      limitations: ["Numbers after each product are units in stock now."],
    };
  },

  check_stock(result) {
    const rows = result.rows;
    const describe = (row) =>
      `${row.item_name}: ${row.available} ${row.uom ?? "units"} in stock` +
      (row.reorder_level !== null
        ? `, reorder level ${row.reorder_level}${row.status === "low" ? " (low)" : ""}`
        : " (no reorder level set)");
    const facts =
      rows.length <= 8
        ? rows.map(describe)
        : [
            `${plural(rows.length, "product")} checked; ${result.low.length} at or below reorder level.`,
            ...result.low.map(describe),
          ];
    const recommendations = result.low.map((row) => {
      const ranking = result.recommendations?.find((item) => item.item_code === row.item_code);
      const supplier = supplierText(ranking?.choice);
      return `Buy ${row.recommended_qty} ${row.item_name}${supplier ? ` from ${supplier}` : ""}.`;
    });
    const limitations = [];
    if (!["available", "not_needed"].includes(result.recommendations_status))
      limitations.push(`Supplier comparison was not available: ${result.recommendations_status}`);
    for (const row of rows.filter((item) => item.status === "no_reorder_level"))
      limitations.push(`${row.item_name} has no reorder level, so low stock cannot be judged.`);
    return { facts, recommendations, limitations };
  },

  sales_summary(result, { today } = {}) {
    const inr = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    const ranged = Boolean(result.by_day);
    const span = ranged
      ? `${result.period.from_date} to ${result.period.to_date}`
      : result.period.from_date;
    if (!result.transaction_count)
      return {
        status: "no_data",
        facts: [
          result.period.from_date === today && !ranged
            ? `No sales have been billed yet today (${span}).`
            : `No submitted sales are recorded for ${span}.`,
        ],
        limitations: result.warnings,
      };
    const facts = [
      `Sales ${ranged ? "from" : "on"} ${span}: ${inr(result.total_sales)} from ${plural(result.transaction_count, "bill")}, an average of ${inr(result.total_sales / result.transaction_count)} a bill.`,
    ];
    if (result.top_products?.length)
      facts.push(
        `Top sellers: ${result.top_products
          .slice(0, 3)
          .map((row) => `${row.item_name} (${row.qty} sold, ${inr(row.amount)})`)
          .join(", ")}.`,
      );
    if (ranged) {
      facts.push(
        `Day by day: ${result.by_day.map((row) => `${row.date} ${inr(row.total)} (${plural(row.transactions, "bill")})`).join(", ")}.`,
      );
      const sorted = [...result.by_day].sort((a, b) => b.total - a.total);
      if (sorted.length > 2)
        facts.push(
          `Best day ${sorted[0].date} (${inr(sorted[0].total)}), quietest ${sorted.at(-1).date} (${inr(sorted.at(-1).total)}).`,
        );
    }
    return {
      facts,
      documents: result.invoice_refs,
      limitations: [...result.warnings],
    };
  },

  top_selling_products(result) {
    if (!result.top_products?.length)
      return {
        status: "no_data",
        facts: [
          `No submitted sales are recorded for ${result.period.from_date}, so there is no ranking.`,
        ],
      };
    return {
      facts: result.top_products.map(
        (row, index) =>
          `#${index + 1} on ${result.period.from_date}: ${row.item_name}, ${row.qty} sold for ${inr(row.amount)}.`,
      ),
      documents: result.invoice_refs,
      limitations: [
        `Ranked by sales amount (top ${result.top_products.length}) from ${plural(result.transaction_count, "submitted transaction")}.`,
      ],
    };
  },

  business_profit(result) {
    if (result.profit?.status !== "verified")
      return {
        status: "unavailable",
        facts: [],
        limitations: [
          `Profit for ${result.period.from_date} could not be verified from posted accounting data${result.profit?.reason ? `: ${result.profit.reason}` : "."}`,
          "Profit is never estimated from sales or purchase orders.",
          ...result.warnings,
        ],
      };
    return {
      facts: [
        `Net profit on ${result.period.from_date}: ${inr(result.profit.net_profit)} (income ${inr(result.profit.income)}, expense ${inr(result.profit.expense)}), from the posted Profit and Loss report.`,
      ],
      limitations: result.warnings,
    };
  },

  demand_forecast(result) {
    const ok = result.items.filter((row) => row.status === "ok");
    const facts = ok
      .slice(0, 8)
      .map(
        (row) =>
          `${row.item_name}: about ${row.forecast.next_7_days} expected to sell in the next 7 days (${row.method.label}); ${row.current_stock} in stock${row.incoming_stock ? `, ${row.incoming_stock} incoming` : ""}.`,
      );
    if (ok.length > 8)
      facts.push(`${ok.length - 8} more product(s) forecast; ask about one by name.`);
    const recommendations = ok
      .filter((row) => row.recommendation?.suggested_qty > 0)
      .map((row) => {
        const supplier = supplierText(row.supplier_comparison?.choice);
        return `Order ${row.recommendation.suggested_qty} ${row.item_name} (${row.recommendation.stockout_risk} stockout risk)${supplier ? `, best quotation ${supplier}` : ""}.`;
      });
    const limitations = [
      `${result.label}, from sales ${result.history_window.from} to ${result.history_window.to}.`,
    ];
    for (const row of result.items) {
      if (row.status === "insufficient_evidence")
        limitations.push(
          `${row.item_name}: not enough sales history to forecast (${row.history.observed_days} observed day(s)).`,
        );
      else if (row.history.censored_stockout_days.length)
        limitations.push(
          `${row.item_name}: ${row.history.censored_stockout_days.length} stockout day(s) excluded from the history.`,
        );
      if (row.recommendation?.status === "no_lead_time")
        limitations.push(`${row.item_name}: supplier lead time unknown, so no order quantity.`);
    }
    if (result.supply_status !== "available")
      limitations.push(
        `Incoming orders and supplier quotations were not available: ${result.supply_status}`,
      );
    if (!recommendations.length) facts.push("No purchase is needed for the forecast period.");
    return { facts, recommendations, limitations };
  },

  supplier_comparison(result) {
    const facts = [];
    const recommendations = [];
    const limitations = [];
    for (const row of result.items) {
      facts.push(
        `${row.item_name}: ${plural(row.considered.length, "quotation")} compared for ${row.qty} unit(s)${row.list_price ? `; standard buying price ${row.list_price.rate}` : ""}.`,
      );
      for (const quote of row.considered)
        facts.push(
          `${row.item_name} from ${quote.supplier} (${quote.quotation}): ${quote.rate} per unit, ${quote.lead_time_days ?? "unknown"}-day lead time, ${quote.suitable ? "can supply" : quote.not_suitable_because.join(", ")}.`,
        );
      if (row.choice)
        recommendations.push(`Best for ${row.item_name}: ${supplierText(row.choice)}.`);
      else limitations.push(`${row.item_name}: ${row.blocker}`);
      if (row.qty_basis !== "requested")
        limitations.push(
          `${row.item_name}: compared for ${row.qty} unit(s), the ${row.qty_basis === "reorder_quantity" ? "item's reorder quantity" : "minimum"}; say a quantity to compare for another amount.`,
        );
      for (const quote of row.considered)
        if (quote.missing.length)
          limitations.push(
            `${quote.supplier} quotation for ${row.item_name} is missing: ${quote.missing.join(", ")}.`,
          );
    }
    const documents = result.items.flatMap((row) => row.considered.map((quote) => quote.quotation));
    limitations.push(
      "Ranking rule: can supply the quantity and still valid, then lowest rate, shortest lead time, best on-time rate.",
    );
    return { facts, recommendations, limitations, documents };
  },

  receivables_report(result) {
    const inr = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    const over = result.overdue_over_30_days;
    return {
      facts: [
        ...(result.period_new
          ? [
              `New udhaar ${result.period_new.from_date === result.period_new.to_date ? `on ${result.period_new.from_date}` : `from ${result.period_new.from_date} to ${result.period_new.to_date}`}: ${inr(result.period_new.amount)} still unpaid across ${plural(result.period_new.invoices, "invoice")}${
                result.period_new.customers.length
                  ? ` (${result.period_new.customers
                      .slice(0, 5)
                      .map((c) => `${c.customer} ${inr(c.amount)}`)
                      .join(", ")})`
                  : ""
              }.`,
            ]
          : []),
        ...(result.due_soon
          ? [
              `Due in the next ${result.due_soon.days} days: ${inr(result.due_soon.amount)} from ${plural(result.due_soon.customers.length, "customer")}${
                result.due_soon.customers.length
                  ? ` (${result.due_soon.customers
                      .slice(0, 5)
                      .map((c) => `${c.customer} ${inr(c.amount)} by ${c.due_date}`)
                      .join(", ")})`
                  : ""
              }. Already overdue, so collectible now: ${inr(result.overdue)}.`,
            ]
          : []),
        `Udhaar pending ${inr(result.total_outstanding)}, of which ${inr(result.overdue)} is overdue.`,
        `${plural(over.customers, "customer")} ${over.customers === 1 ? "has" : "have"} an invoice more than 30 days overdue (${inr(over.amount)}).`,
        ...result.collection_priority
          .slice(0, 5)
          .map(
            (row) =>
              `${row.customer}: ${inr(row.outstanding)}, oldest ${row.oldest_days_overdue} days overdue.`,
          ),
      ],
      limitations: result.partial_payments
        ? [
            `${plural(result.partial_payments, "invoice")} ${result.partial_payments === 1 ? "is" : "are"} partly paid.`,
          ]
        : [],
    };
  },

  expiry_check(result) {
    if (!result.batches_tracked)
      return { status: "no_data", facts: [], limitations: [result.note ?? "No batch data."] };
    return { facts: summarizeV2(result).split(/(?<=\.)\s+/) };
  },

  purchase_status(result) {
    return { facts: summarizeV2(result).split(/(?<=\.)\s+/) };
  },

  supplier_performance(result) {
    return { facts: summarizeV2(result).split(/(?<=\.)\s+/), limitations: [result.price_basis] };
  },

  customer_insights(result) {
    return {
      facts: summarizeV2(result).split(/(?<=\.)\s+/),
      limitations: [result.discounts.reason],
    };
  },

  billing_summary(result) {
    return {
      facts: summarizeV2(result).split(/(?<=\.)\s+/),
      limitations: result.notes,
    };
  },

  prepare_bill(result) {
    return {
      facts: [
        `${result.already_pending ? "Bill" : "Draft bill"} ${result.bill} for ${result.customer}${result.customer_defaulted ? " (no customer was named, so Walk-in Customer)" : ""}.`,
        ...result.lines.map(
          (row) => `${row.understood}: rate ${inr(row.rate)}, ${inr(row.amount)}.`,
        ),
        `Total ${inr(result.total)}.`,
        "It is only a draft. Nothing is billed, and stock and accounts are unchanged, until the owner approves it with their PIN.",
      ],
      documents: [result.bill],
      recommendations: [
        "Confirm the products and quantities with the owner. They approve with their PIN in the NammaOps panel, or aloud through approve_by_voice (you never handle the PIN).",
      ],
      approval_required: true,
      approvals: result.approvals.map((approvalId) => ({
        approval_id: approvalId,
        bill: result.bill,
        where: "NammaOps panel (owner PIN), or aloud with approve_by_voice (owner PIN)",
      })),
    };
  },

  payments_summary(result) {
    return { facts: summarizeV2(result).split(/(?<=\.)\s+/) };
  },

  gst_summary(result) {
    return {
      facts: summarizeV2(result).split(/(?<=\.)\s+/),
      limitations: result.notes,
    };
  },

  purchase_order_lookup(result) {
    return {
      status: result.found ? undefined : "no_data",
      facts: summarizeV2(result).split(/(?<=\.)\s+/),
      documents: result.found ? [result.name] : [],
    };
  },

  business_report(result) {
    return {
      facts: summarizeV2(result).split(/(?<=\.)\s+/),
      limitations: [
        ...(result.profit.status === "verified" ? [] : ["Profit is not verified in the accounts."]),
        ...result.notes,
      ],
    };
  },

  store_health_report(result) {
    return {
      facts: result.problems.map((p, i) => `${i + 1}. ${p.title}: ${p.detail}`),
      limitations: result.unchecked.map((u) => `${u.area} was not checked: ${u.reason}`),
    };
  },

  prepare_purchase_order(result) {
    const names = new Map((result.low ?? []).map((row) => [row.item_code, row.item_name]));
    if (!result.orders?.length)
      return {
        facts: [result.note ?? "No draft purchase order was created."],
        limitations: (result.unplaced ?? []).map((row) => `${row.item_code}: ${row.reason}`),
      };
    return {
      facts: result.orders.map(
        (po) =>
          `Draft purchase order ${po.name} for ${po.supplier}: ${po.items.map((row) => `${row.qty} ${row.item_name ?? names.get(row.item_code) ?? row.item_code}`).join(", ")}; total ${po.grand_total}. It is a draft and has not been sent.`,
      ),
      documents: result.orders.map((po) => po.name),
      recommendations: [
        "The owner approves a draft with their PIN, in the NammaOps panel or aloud through approve_by_voice (you never handle the PIN); a draft is rejected in the panel.",
      ],
      approval_required: true,
      approvals: result.approvals.map((approvalId, index) => ({
        approval_id: approvalId,
        purchase_order: result.orders[index]?.name ?? null,
        where: "NammaOps panel (owner PIN), or aloud with approve_by_voice (owner PIN)",
      })),
      limitations: [
        "Quantities come from each product's reorder level; ask for a demand forecast to compare with recent sales.",
        ...(result.unplaced ?? []).map((row) => `${row.item_code} was not ordered: ${row.reason}`),
      ],
    };
  },
};
