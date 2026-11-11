/**
 * The NammaOps workflow API contract as the server actually sends it (lib/server/nammaops/
 * workflows.mjs). Pure types and helpers, no React, so the report builders and the hooks share one
 * definition. Field names are the server's own (`created_at`, `finished_at`, ...).
 */

export type WorkflowStatus =
  | "running"
  | "completed"
  | "partial"
  | "needs_clarification"
  | "awaiting_approval"
  | "blocked"
  | "failed"
  | "uncertain"
  | "interrupted"
  | "outcome_unknown"
  | "stopped";

export interface WorkflowIntent {
  action: string;
  products?: string[];
  date?: string;
  to?: string;
  with_profit?: boolean;
  focus?: "new" | "due_soon";
  qty?: number;
  po_name?: string;
  customer?: string;
  lines?: Array<{ product: string; quantity?: number; unit?: string }>;
}

/** One row of GET /workflows. */
export interface WorkflowSummary {
  id: string;
  intent?: WorkflowIntent;
  /** A WorkflowStatus; typed as string so an unexpected value never breaks the page. */
  status: string;
  created_at?: string;
  finished_at?: string | null;
  summary?: string | null;
  /** Present on blocked / failed / interrupted runs. */
  error?: string;
}

export interface WorkflowTask {
  id?: string;
  workflow_id?: string;
  role?: string;
  agent_name?: string;
  title?: string;
  status: string;
  started_at?: string;
  finished_at?: string | null;
  summary?: string;
  error?: string;
}

export interface Clarification {
  requested: string;
  reason: string;
  options?: string[];
  categories?: Record<string, string[]>;
  question?: string;
}

export interface TimelineEvent {
  at: string;
  type: string;
  agent?: string;
  detail?: string;
  document?: string;
}

/** GET /workflows/:id (`workflow`). */
export interface WorkflowView extends WorkflowSummary {
  command?: string | null;
  origin?: { channel?: string };
  result?: Record<string, unknown> | null;
  clarifications?: Clarification[];
  timeline?: TimelineEvent[];
  tasks?: WorkflowTask[];
  reasoning?: unknown;
}

/** Kept as an alias: older code imports this name. */
export type WorkflowListItem = WorkflowSummary;

// ── Status rules ───────────────────────────────────────────────────────────

/** Statuses in which the server is genuinely still executing the run. Only these are polled. */
export const ACTIVE_STATUSES: readonly string[] = ["running", "queued", "submitted"];

export const isActiveStatus = (status: string | undefined): boolean =>
  ACTIVE_STATUSES.includes(String(status));

/** Everything that is not actively executing: finished, or waiting on the owner. */
export const isSettledStatus = (status: string | undefined): boolean => !isActiveStatus(status);

export type Tone = "good" | "warn" | "bad" | "active" | "neutral";

export interface StatusInfo {
  label: string;
  tone: Tone;
  /** One plain-English sentence for the report header. */
  explain: string;
}

const STATUS_INFO: Record<string, StatusInfo> = {
  running: { label: "Running", tone: "active", explain: "This report is still being prepared." },
  completed: { label: "Completed", tone: "good", explain: "Every check finished." },
  partial: {
    label: "Partially completed",
    tone: "warn",
    explain: "Some checks could not be finished. The figures cover only what was checked.",
  },
  needs_clarification: {
    label: "Needs your answer",
    tone: "warn",
    explain: "More information is needed before this can run.",
  },
  awaiting_approval: {
    label: "Waiting for your approval",
    tone: "warn",
    explain: "Nothing is final until you approve it.",
  },
  blocked: {
    label: "Blocked",
    tone: "bad",
    explain: "This could not run, and nothing was changed.",
  },
  failed: { label: "Failed", tone: "bad", explain: "This run did not finish." },
  uncertain: {
    label: "Outcome uncertain",
    tone: "warn",
    explain: "It is not certain what happened. Check before trying again.",
  },
  interrupted: {
    label: "Interrupted",
    tone: "warn",
    explain: "The server restarted while this was running, so it did not finish.",
  },
  outcome_unknown: {
    label: "Outcome unknown",
    tone: "warn",
    explain: "The server restarted while this ran. Check the ERP before trying again.",
  },
  stopped: { label: "Stopped", tone: "bad", explain: "This run was stopped." },
};

export function statusInfo(status: string | undefined): StatusInfo {
  return (
    STATUS_INFO[String(status)] ?? {
      label: String(status || "Unknown"),
      tone: "neutral",
      explain: "",
    }
  );
}

/** Owner-facing names for the workflow actions. */
export const WORKFLOW_LABELS: Record<string, string> = {
  stock_check: "Stock Check",
  daily_report: "Daily Report",
  prepare_reorder: "Prepare Reorder",
  demand_forecast: "Demand Forecast",
  supplier_comparison: "Supplier Comparison",
  receivables_report: "Udhaar Report",
  expiry_check: "Expiry Check",
  purchase_status: "Purchase Status",
  procurement_overview: "Procurement Overview",
  supplier_performance: "Supplier Performance",
  customer_insights: "Customer Insights",
  store_health_report: "Store Health",
  business_report: "Business Report",
  billing_summary: "Billing Summary",
  payments_summary: "Payments Summary",
  gst_summary: "GST Summary",
  purchase_order_lookup: "Purchase Order Lookup",
  prepare_bill: "Prepare Bill",
};

export const workflowLabel = (action: string | undefined): string =>
  (action && WORKFLOW_LABELS[action]) ||
  (action ? action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Workflow");

// ── Tolerant mapping ───────────────────────────────────────────────────────

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/**
 * Maps whatever the server returned onto the contract above. The server uses snake_case; a few
 * older camelCase spellings are accepted so a stale cached response cannot blank the page.
 */
export function normalizeWorkflow<T extends WorkflowSummary = WorkflowSummary>(raw: unknown): T {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const finished = r.finished_at ?? r.completedAt ?? r.finishedAt;
  return {
    ...r,
    id: str(r.id) ?? "",
    status: str(r.status) ?? "unknown",
    created_at: str(r.created_at) ?? str(r.startedAt) ?? str(r.createdAt),
    finished_at: typeof finished === "string" && finished ? finished : null,
    summary: typeof r.summary === "string" ? r.summary : null,
    error: str(r.error),
  } as unknown as T;
}
