"use client";
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { isStaleRunning, useWorkflowDetail, STALE_RUN_MS } from "@/lib/hooks/useNammaOps";
import {
  isActiveStatus,
  statusInfo,
  workflowLabel,
  type WorkflowSummary,
} from "@/lib/workflow-contract";
import { ClarificationPanel } from "./ClarificationPanel";
import { canAnswerHere, readAnsweredLinks } from "./clarify";
import { ReportView, StatusPill } from "./ReportView";
import { durationMs, formatDateTime, formatDay, formatDuration } from "./reports/format";
import { explain } from "./reports/helpers";
import { panel, TONE_COLOR, ui } from "./styles";

/** The one short line a history row shows under its summary, or null. Written in plain words. */
export function rowNote(run: WorkflowSummary): { text: string; tone: "warn" | "bad" } | null {
  const info = statusInfo(run.status);
  switch (run.status) {
    case "needs_clarification":
      return { text: "Waiting for your answer. Open this run to answer.", tone: "warn" };
    case "partial":
      return {
        text: "Partially completed. Open the report to see what could not be checked.",
        tone: "warn",
      };
    case "blocked":
    case "failed":
      return {
        text: [info.explain, run.error ? explain(run.error).text : null].filter(Boolean).join(" "),
        tone: "bad",
      };
    case "uncertain":
    case "interrupted":
    case "outcome_unknown":
    case "stopped":
      return {
        text: [info.explain, run.error ? explain(run.error).text : null].filter(Boolean).join(" "),
        tone: "warn",
      };
    case "awaiting_approval":
      return { text: "Waiting for your approval.", tone: "warn" };
    default:
      return null;
  }
}

/** Chips for what the run was asked: products, day or range, quantity. */
function inputChips(run: WorkflowSummary): string[] {
  const i = run.intent;
  if (!i) return [];
  const chips: string[] = [];
  if (i.products?.length) chips.push(i.products.join(", "));
  const from = formatDay(i.date);
  const to = formatDay(i.to);
  if (from) chips.push(to && to !== from ? `${from} to ${to}` : from);
  if (i.qty) chips.push(`Quantity ${i.qty}`);
  if (i.po_name) chips.push(i.po_name);
  if (i.focus) chips.push(i.focus === "new" ? "New dues" : "Due soon");
  return chips;
}

function RunDetails({
  run,
  open,
  onStart,
  onOpenRun,
}: {
  run: WorkflowSummary;
  open: boolean;
  onStart: (intent: Record<string, unknown>) => Promise<WorkflowSummary>;
  onOpenRun: (run: WorkflowSummary) => void;
}) {
  const { view, loading, error, missing, retry } = useWorkflowDetail(
    run.id,
    open,
    run.status,
    run.finished_at,
  );
  if (!open) return null;
  if (!view && loading)
    return (
      <p role="status" aria-busy="true" style={{ ...ui.muted, margin: "12px 0 0" }}>
        Loading the report…
      </p>
    );
  if (!view)
    return (
      <div role="alert" style={{ ...panel(missing ? "warn" : "bad"), marginTop: 12 }}>
        <span>
          {missing
            ? "This run is no longer stored, so its report cannot be shown."
            : `The report could not be loaded. ${error ?? ""}`}
          {!missing && (
            <button type="button" onClick={retry} style={{ ...ui.btn(), marginLeft: 10 }}>
              Try again
            </button>
          )}
        </span>
      </div>
    );
  return (
    <div
      id={`run-${run.id}-report`}
      style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--kirana-border)" }}
    >
      <ReportView
        view={view}
        compactHeader
        hideHeadline={view.status === "needs_clarification" && canAnswerHere(view)}
      />
      {view.status === "needs_clarification" && canAnswerHere(view) && (
        <ClarificationPanel view={view} onStart={onStart} onStarted={onOpenRun} />
      )}
    </div>
  );
}

function RunRow({
  run,
  open,
  onToggle,
  onStart,
  onOpenRun,
  answeredBy,
}: {
  run: WorkflowSummary;
  open: boolean;
  onToggle: () => void;
  onStart: (intent: Record<string, unknown>) => Promise<WorkflowSummary>;
  onOpenRun: (run: WorkflowSummary) => void;
  /** The newer run that answered this one, if it is still in the list. */
  answeredBy?: WorkflowSummary;
}) {
  const info = statusInfo(run.status);
  const ms = durationMs(run.created_at, run.finished_at);
  const started = formatDateTime(run.created_at);
  const finished = formatDateTime(run.finished_at);
  const running = isActiveStatus(run.status);
  const stale = isStaleRunning(run);
  const sinceStart = running ? durationMs(run.created_at, new Date().toISOString()) : null;
  const note = rowNote(run);
  const chips = inputChips(run);
  const headRef = useRef<HTMLButtonElement>(null);

  // A run that was just started or answered is brought into view when it opens.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) headRef.current?.scrollIntoView?.({ block: "nearest" });
    wasOpen.current = open;
  }, [open]);

  return (
    <li
      style={{ ...ui.card, marginBottom: 0, minWidth: 0 }}
      data-run-id={run.id}
      data-run-status={run.status}
    >
      <div
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 6 }}
      >
        <h3 style={{ ...ui.heading, fontSize: 15, fontWeight: 700 }}>
          {workflowLabel(run.intent?.action)}
        </h3>
        <StatusPill status={run.status} />
        {chips.map((chip) => (
          <span key={chip} style={ui.muted}>
            · {chip}
          </span>
        ))}
      </div>

      <p style={{ ...ui.muted, margin: "0 0 6px" }}>
        {[
          started && `Started ${started}`,
          finished && `Finished ${finished}`,
          ms !== null && !running && `Took ${formatDuration(ms)}`,
          running && sinceStart !== null && `Running for ${formatDuration(sinceStart)}`,
        ]
          .filter(Boolean)
          .join(" · ") || "Time not recorded"}
      </p>

      {!open && run.summary && run.status !== "needs_clarification" && (
        <p
          style={{
            margin: "0 0 6px",
            fontSize: 14,
            lineHeight: 1.45,
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitLineClamp: open ? "unset" : 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {run.summary}
        </p>
      )}
      {!open && note && !answeredBy && (
        <p
          role={note.tone === "bad" ? "alert" : undefined}
          style={{ margin: "0 0 6px", fontSize: 13, color: TONE_COLOR[note.tone] }}
        >
          {note.text}
        </p>
      )}
      {answeredBy && (
        <p style={{ margin: "0 0 6px", fontSize: 13 }}>
          Answered.{" "}
          <button
            type="button"
            onClick={() => onOpenRun(answeredBy)}
            style={{ ...ui.btn(), padding: "2px 8px" }}
          >
            See the new run
          </button>
        </p>
      )}
      {stale && (
        <p role="note" style={{ margin: "0 0 6px", fontSize: 13, color: TONE_COLOR.warn }}>
          Still marked as running after {Math.round(STALE_RUN_MS / 60_000)} minutes. If the server
          was restarted, this run probably did not finish. Use Refresh to check.
        </p>
      )}

      <button
        ref={headRef}
        type="button"
        aria-expanded={open}
        aria-controls={`run-${run.id}-report`}
        onClick={onToggle}
        style={{ ...ui.btn(), marginTop: 4 }}
      >
        {open ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )}
        {open ? "Hide report" : info.tone === "active" ? "View progress" : "View report"}
      </button>
      <RunDetails run={run} open={open} onStart={onStart} onOpenRun={onOpenRun} />
    </li>
  );
}

export function RunHistory({
  workflows,
  loading,
  error,
  stalled,
  refreshing,
  opened,
  onToggle,
  onOpenRun,
  onStart,
  onRetry,
}: {
  workflows: WorkflowSummary[];
  loading: boolean;
  error: string | null;
  stalled: boolean;
  refreshing?: boolean;
  opened: Record<string, boolean>;
  onToggle: (id: string) => void;
  onOpenRun: (run: WorkflowSummary) => void;
  onStart: (intent: Record<string, unknown>) => Promise<WorkflowSummary>;
  onRetry: () => void;
}) {
  const links = readAnsweredLinks();
  const byId = new Map(workflows.map((w) => [w.id, w]));
  return (
    <section aria-labelledby="wf-history">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <h2 id="wf-history" style={{ ...ui.heading, fontSize: 17, fontWeight: 700 }}>
          Run history
        </h2>
        <span style={ui.muted}>
          {workflows.length} run{workflows.length === 1 ? "" : "s"}
        </span>
      </div>

      {(stalled || (error && workflows.length === 0)) && (
        <div role="alert" style={panel("bad")}>
          <span>
            {stalled
              ? "Lost connection to the server. Updates have stopped."
              : `Could not load the run history. ${error ?? ""}`}
            <button type="button" onClick={onRetry} style={{ ...ui.btn(), marginLeft: 10 }}>
              <RefreshCw size={13} aria-hidden="true" /> Try again
            </button>
          </span>
        </div>
      )}

      {loading ? (
        <div
          role="status"
          aria-busy="true"
          style={{ display: "flex", justifyContent: "center", padding: 40 }}
        >
          <Loader2
            size={22}
            aria-label="Loading run history"
            style={{ animation: "wf-spin 1s linear infinite", color: "var(--kirana-primary)" }}
          />
        </div>
      ) : workflows.length === 0 ? (
        !error && (
          <div style={{ ...ui.card, textAlign: "center", padding: 40 }}>
            <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 14, margin: 0 }}>
              Nothing has been run yet. Choose a workflow above to start.
            </p>
          </div>
        )
      ) : (
        <ul
          aria-busy={refreshing || undefined}
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {workflows.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              open={!!opened[run.id]}
              onToggle={() => onToggle(run.id)}
              onStart={onStart}
              onOpenRun={onOpenRun}
              answeredBy={links[run.id] ? byId.get(links[run.id]) : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
