"use client";
import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { fetchNammaOps, type WorkflowView } from "@/lib/hooks/useNammaOps";
import { isActiveStatus } from "@/lib/workflow-contract";

/**
 * Starts one durable NammaOps workflow (the same agent path as voice and chat) and reports its
 * real outcome. Dashboards are reads; anything an agent does still goes through a workflow.
 */
export function WorkflowAction({
  action,
  label,
  hint,
  onDone,
}: {
  action:
    "stock_check" | "prepare_reorder" | "daily_report" | "demand_forecast" | "supplier_comparison";
  label: string;
  hint?: string;
  onDone?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<{ status: string; summary?: string } | null>(null);

  const run = async () => {
    setRunning(true);
    setOutcome(null);
    try {
      const { workflow } = await fetchNammaOps<{ workflow: WorkflowView }>("/workflows", {
        intent: { action },
      });
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { workflow: view } = await fetchNammaOps<{ workflow: WorkflowView }>(
          `/workflows/${encodeURIComponent(workflow.id)}`,
        );
        if (!isActiveStatus(view.status)) {
          const summary =
            (view as unknown as { summary?: string }).summary ?? view.error ?? undefined;
          setOutcome({ status: view.status, summary: summary ?? undefined });
          if (["completed", "partial"].includes(view.status))
            toast.success(`${label}: ${view.status}`);
          else toast.error(`${label}: ${view.status}`);
          onDone?.();
          return;
        }
      }
      setOutcome({ status: "still running", summary: "Open Workflows to follow it." });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setOutcome({ status: "not started", summary: message });
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
        background: "var(--kirana-card)",
        border: "1px solid var(--kirana-border)",
        borderRadius: 12,
        padding: "10px 14px",
      }}
    >
      <button
        type="button"
        disabled={running}
        onClick={() => void run()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          padding: "7px 14px",
          borderRadius: 9,
          border: "none",
          background: "var(--kirana-primary)",
          color: "var(--kirana-primary-foreground)",
          fontWeight: 700,
          fontSize: 13,
          cursor: running ? "wait" : "pointer",
        }}
      >
        {running ? (
          <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
        ) : (
          <Play size={13} />
        )}
        {running ? "Running…" : label}
      </button>
      <span
        style={{ fontSize: 12.5, color: "var(--kirana-muted-foreground)", flex: 1, minWidth: 200 }}
      >
        {outcome ? (
          <>
            <b style={{ color: "var(--kirana-foreground)" }}>{outcome.status}</b>
            {outcome.summary ? ` · ${outcome.summary}` : ""}
          </>
        ) : (
          hint
        )}
      </span>
    </div>
  );
}
