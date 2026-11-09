/**
 * Turns one saved run (GET /workflows/:id) into a ReportModel. Pure: no React, no network.
 * A builder that throws never blanks the page: the generic layout takes over with a notice.
 */
import {
  statusInfo,
  workflowLabel,
  type WorkflowTask,
  type WorkflowView,
} from "@/lib/workflow-contract";
import { durationMs, formatDateTime, formatDuration, formatPeriod } from "./format";
import { generic } from "./generic";
import { clarificationQuestion, explain, notice, rec, str, type Builder, type Part } from "./helpers";
import { demandForecast, expiryCheck, stockCheck } from "./inventory";
import {
  purchaseStatus,
  receivablesReport,
  storeHealthReport,
  supplierComparison,
  supplierPerformance,
} from "./purchasing";
import { billingSummary, businessReport, customerInsights, dailyReport, paymentsSummary } from "./sales";
import type { Notice, ReportModel } from "./types";

/** One builder per `intent.action`. Workflows not listed here use the generic layout. */
export const BUILDERS: Record<string, Builder> = {
  stock_check: stockCheck,
  expiry_check: expiryCheck,
  demand_forecast: demandForecast,
  daily_report: dailyReport,
  business_report: businessReport,
  billing_summary: billingSummary,
  payments_summary: paymentsSummary,
  customer_insights: customerInsights,
  receivables_report: receivablesReport,
  purchase_status: purchaseStatus,
  supplier_comparison: supplierComparison,
  supplier_performance: supplierPerformance,
  store_health_report: storeHealthReport,
};

const ORDER: Record<Notice["severity"], number> = { error: 0, warn: 1, info: 2 };

/** Notices that follow from the run status alone. */
function statusNotices(view: WorkflowView): Notice[] {
  const info = statusInfo(view.status);
  const why = view.error ? explain(view.error) : null;
  switch (view.status) {
    case "partial":
      return [
        notice(
          "warn",
          "partial",
          "Partially completed. The figures below cover only the checks that finished. Anything marked “Not available” or “Not checked” could not be confirmed.",
        ),
      ];
    case "blocked":
    case "failed":
      return [
        notice(
          "error",
          view.status === "blocked" ? "blocked" : "failed",
          `${info.explain}${why ? ` ${why.text}` : ""}`,
          why?.detail ?? view.error,
        ),
      ];
    case "uncertain":
    case "interrupted":
    case "outcome_unknown":
    case "stopped":
      return [notice("warn", "failed", `${info.explain}${why ? ` ${why.text}` : ""}`, why?.detail)];
    case "awaiting_approval":
      return [notice("warn", "info", info.explain)];
    case "running":
      return [notice("info", "info", info.explain)];
    default:
      return [];
  }
}

/** One notice for every step that did not complete, in plain words. */
function taskNotices(tasks: WorkflowTask[]): Notice[] {
  return tasks
    .filter((task) => ["failed", "blocked", "uncertain"].includes(task.status))
    .map((task) => {
      const why = explain(task.error);
      const what = task.title ?? task.role ?? "A step";
      return notice(
        task.status === "blocked" ? "error" : "warn",
        task.status === "blocked" ? "blocked" : "unchecked",
        `Not done: ${what}. ${why.text}`,
        why.detail ?? task.error,
      );
    });
}

/** Same server reason shown twice (a builder notice and its failed step) is shown once. */
function dedupe(notices: Notice[]): Notice[] {
  const seen = new Set<string>();
  return notices.filter((n) => {
    const key = n.detail ?? n.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildReport(view: WorkflowView, options: { timeZone?: string } = {}): ReportModel {
  const action = view.intent?.action ?? str(rec(view.result).kind) ?? "";
  const info = statusInfo(view.status);
  const tasks = view.tasks ?? [];
  const hasResult = !!view.result && typeof view.result === "object";
  const ctx = { view, result: rec(view.result), tasks };

  let part: Part = {};
  let formatFailed = false;
  if (hasResult) {
    try {
      part = (BUILDERS[action] ?? generic)(ctx);
    } catch {
      formatFailed = true;
      try {
        part = generic(ctx);
      } catch {
        part = {};
      }
    }
  }

  const notices = dedupe([
    ...statusNotices(view),
    ...(part.notices ?? []),
    ...taskNotices(tasks),
    ...(formatFailed
      ? [notice("info", "info", "This report could not be laid out in the usual way, so a simpler layout is shown.")]
      : []),
  ]).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

  const recommendations = [...(part.recommendations ?? [])];
  if (action === "prepare_reorder" && view.status === "blocked")
    recommendations.push(
      "To see what to reorder and from which supplier without creating a purchase order, run “Reorder suggestions (read-only)”. Nothing is ordered.",
    );

  const clarifications = view.clarifications ?? [];
  const headline =
    view.status === "needs_clarification" && clarifications.length
      ? clarifications.map(clarificationQuestion).join(" ")
      : str(view.summary) ?? null;

  const ms = durationMs(view.created_at, view.finished_at);
  return {
    action,
    title: workflowLabel(action),
    status: view.status,
    statusLabel: info.label,
    statusExplain: info.explain,
    headline,
    period: part.period ?? formatPeriod(view.intent?.date, view.intent?.to),
    run: {
      started: formatDateTime(view.created_at, options.timeZone),
      finished: formatDateTime(view.finished_at, options.timeZone),
      duration: ms === null || view.status === "running" ? null : formatDuration(ms),
    },
    notices,
    metrics: part.metrics ?? [],
    sections: part.sections ?? [],
    recommendations,
  };
}
