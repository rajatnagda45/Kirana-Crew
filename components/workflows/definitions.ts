/**
 * The workflow cards: what each one is called, what it does in plain words, and which inputs it
 * takes. Only parameters the API really accepts are offered (the Ajv intent schema in
 * lib/server/nammaops/workflows.mjs), and `buildIntent` checks them before anything is sent.
 * Pure data and functions, no React.
 */
import type { WorkflowIntent } from "@/lib/workflow-contract";

export type FieldType = "date" | "products" | "number" | "select" | "checkbox" | "text";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** One plain sentence under the label. */
  help?: string;
  example?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Checkbox default. */
  checked?: boolean;
}

export interface WorkflowDef {
  action: string;
  label: string;
  /** Plain business wording, no internal agent names. */
  description: string;
  icon: string;
  color: string;
  fields: FieldDef[];
  /**
   * ERP capabilities this workflow cannot run without. When the binding reports one as unavailable
   * the card says so instead of offering a button that can only produce a blocked run.
   */
  needs?: string[];
  /** "reorder" is the one card whose normal action writes to the ERP (see WorkflowCards). */
  special?: "reorder";
}

const periodFields = (what: string): FieldDef[] => [
  { key: "date", label: "From", type: "date", help: `Leave both dates empty for ${what}.` },
  { key: "to", label: "To", type: "date", help: "Up to 31 days." },
];

export const WORKFLOW_DEFS: WorkflowDef[] = [
  {
    action: "stock_check",
    label: "Stock Check",
    description: "Finds products that are running low and suggests what to buy.",
    icon: "Package",
    color: "var(--kirana-success)",
    fields: [
      { key: "products", label: "Only these products (optional)", type: "products", example: "Milk, Rice", help: "Separate names with commas. Leave empty to check everything." },
    ],
  },
  {
    action: "daily_report",
    label: "Daily Report",
    description: "Sales, number of bills, top products and profit for a day.",
    icon: "BarChart3",
    color: "var(--kirana-primary)",
    fields: [
      { key: "date", label: "Day", type: "date", help: "Leave empty for today." },
      { key: "to", label: "Until (optional)", type: "date", help: "Fill this to report a range of up to 31 days." },
      { key: "with_profit", label: "Include profit", type: "checkbox", checked: true, help: "Profit comes only from posted accounting entries." },
    ],
  },
  {
    action: "prepare_reorder",
    label: "Prepare Reorder",
    description: "Drafts purchase orders for low-stock products, for your approval.",
    icon: "ShoppingCart",
    color: "oklch(0.65 0.18 310)",
    special: "reorder",
    fields: [],
  },
  {
    action: "demand_forecast",
    label: "Demand Forecast",
    description: "Estimates how much you will sell in the next 7 and 30 days, from your past sales.",
    icon: "TrendingUp",
    color: "oklch(0.7 0.18 260)",
    fields: [
      { key: "products", label: "Only these products (optional)", type: "products", example: "Milk, Rice", help: "Separate names with commas. Leave empty to forecast everything." },
    ],
  },
  {
    action: "supplier_comparison",
    label: "Supplier Comparison",
    description: "Compares supplier quotations for the products you choose, by price and delivery time.",
    icon: "Users",
    color: "oklch(0.7 0.15 30)",
    fields: [
      { key: "products", label: "Products to compare", type: "products", required: true, example: "Atta, Rice, Sugar", help: "Type the product names, separated by commas." },
      { key: "qty", label: "Quantity (optional)", type: "number", help: "Leave empty to use each product's usual reorder quantity." },
    ],
  },
  {
    action: "receivables_report",
    label: "Udhaar Report",
    description: "Shows who owes you money, how old the dues are, and who to collect from first.",
    icon: "HandCoins",
    color: "oklch(0.72 0.16 60)",
    fields: [
      {
        key: "focus",
        label: "Show",
        type: "select",
        options: [
          { value: "", label: "All unpaid dues" },
          { value: "new", label: "New dues from the last 7 days" },
          { value: "due_soon", label: "Dues falling due in the next 7 days" },
        ],
      },
    ],
  },
  {
    action: "expiry_check",
    label: "Expiry Check",
    description: "Finds stock that is expiring soon and the money at risk.",
    icon: "CalendarClock",
    color: "oklch(0.65 0.2 25)",
    fields: [],
  },
  {
    action: "purchase_status",
    label: "Purchase Status",
    description: "Open purchase orders, late deliveries and unpaid supplier bills.",
    icon: "Truck",
    color: "oklch(0.7 0.14 200)",
    fields: [],
  },
  {
    action: "supplier_performance",
    label: "Supplier Performance",
    description: "How reliable each supplier is: late deliveries, and prices against their quotations.",
    icon: "Gauge",
    color: "oklch(0.7 0.15 150)",
    fields: [
      { key: "products", label: "Only these products (optional)", type: "products", example: "Milk, Curd", help: "Looks only at suppliers of these products. Leave empty for all suppliers." },
    ],
  },
  {
    action: "customer_insights",
    label: "Customer Insights",
    description: "Regular and high-value customers, and regulars who have stopped coming.",
    icon: "UserCheck",
    color: "oklch(0.72 0.14 290)",
    fields: [],
  },
  {
    action: "store_health_report",
    label: "Store Health",
    description: "The biggest problems in the shop today, from sales, stock, udhaar, expiry and supplier delays.",
    icon: "HeartPulse",
    color: "var(--kirana-primary)",
    fields: [],
  },
  {
    action: "business_report",
    label: "Business Report",
    description: "Sales, profit, dues and stock for a week or month, compared with the period before.",
    icon: "FileText",
    color: "oklch(0.7 0.16 230)",
    fields: periodFields("the last 7 days"),
  },
  {
    action: "billing_summary",
    label: "Billing Summary",
    description: "Bills raised, average bill, returns and unpaid bills.",
    icon: "Receipt",
    color: "oklch(0.72 0.13 120)",
    fields: periodFields("today"),
  },
  {
    action: "payments_summary",
    label: "Payments Summary",
    description: "Money received and paid out in a period.",
    icon: "Wallet",
    color: "oklch(0.7 0.14 170)",
    fields: periodFields("the month so far"),
    needs: ["erp.payments.summary"],
  },
  {
    action: "purchase_order_lookup",
    label: "Purchase Order Lookup",
    description: "Looks up one purchase order by its number.",
    icon: "Search",
    color: "oklch(0.7 0.1 250)",
    needs: ["erp.po.get"],
    fields: [
      { key: "po_name", label: "Purchase order number", type: "text", required: true, example: "PUR-ORD-2026-00004", help: "As printed on the order." },
    ],
  },
];

/** The read-only action offered in place of Prepare Reorder when purchase orders cannot be created. */
export const REORDER_SUGGESTION_ACTION = "stock_check";

export type FieldValues = Record<string, string | boolean | undefined>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PO = /^[A-Za-z0-9 _.-]{1,64}$/;
const MAX_RANGE_DAYS = 31;

/** Names from "Milk, rice ,, MILK": trimmed, empties removed, duplicates dropped (case-blind). */
export function parseProducts(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

const dayNumber = (value: string) => Date.UTC(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10)) / 86_400_000;

/**
 * Turns what the owner typed into the intent the API takes, or says what is wrong in plain words.
 * Only fields the workflow defines are read, so no unsupported key can reach the server.
 */
export function buildIntent(
  def: WorkflowDef,
  values: FieldValues,
): { intent?: WorkflowIntent; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const intent: WorkflowIntent = { action: def.action };
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string).trim() : "");

  for (const field of def.fields) {
    const raw = text(field.key);
    if (field.type === "checkbox") {
      if (field.key === "with_profit" && values[field.key] === false) intent.with_profit = false;
      continue;
    }
    if (!raw) {
      if (field.required) errors[field.key] = `${field.label} is needed.`;
      continue;
    }
    switch (field.type) {
      case "date":
        if (!DAY.test(raw)) errors[field.key] = "Choose a date.";
        else if (field.key === "date") intent.date = raw;
        else if (field.key === "to") intent.to = raw;
        break;
      case "products": {
        const names = parseProducts(raw);
        if (names.length > 20) errors[field.key] = "Use at most 20 products.";
        else if (names.some((n) => n.length > 60)) errors[field.key] = "Each product name must be under 60 characters.";
        else if (names.length) intent.products = names;
        else if (field.required) errors[field.key] = `${field.label} is needed.`;
        break;
      }
      case "number": {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 100000) errors[field.key] = "Enter a whole number from 1 to 100000.";
        else intent.qty = n;
        break;
      }
      case "select":
        if (field.key === "focus" && (raw === "new" || raw === "due_soon")) intent.focus = raw;
        break;
      case "text":
        if (field.key === "po_name") {
          if (!PO.test(raw)) errors[field.key] = "Use letters, numbers, spaces, dots, dashes or underscores only.";
          else intent.po_name = raw;
        }
        break;
    }
  }

  // A range needs a start, ends after it starts, and stays within the 31 days the server allows.
  if (intent.to && !intent.date) errors.to = "Choose the start date as well.";
  if (intent.date && intent.to) {
    const span = dayNumber(intent.to) - dayNumber(intent.date);
    if (span < 0) errors.to = "The end date is before the start date.";
    else if (span + 1 > MAX_RANGE_DAYS) errors.to = `A report covers at most ${MAX_RANGE_DAYS} days.`;
  }
  return Object.keys(errors).length ? { errors } : { intent, errors };
}

export const definitionFor = (action: string | undefined): WorkflowDef | undefined =>
  WORKFLOW_DEFS.find((def) => def.action === action);
