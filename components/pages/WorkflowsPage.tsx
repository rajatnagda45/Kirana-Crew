"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  useNammaOpsApprovals,
  useNammaOpsBinding,
  useNammaOpsWorkflows,
} from "@/lib/hooks/useNammaOps";
import type { WorkflowIntent, WorkflowSummary } from "@/lib/workflow-contract";
import { ApprovalsCard } from "@/components/workflows/ApprovalsCard";
import { RunHistory } from "@/components/workflows/RunHistory";
import { WORKFLOW_DEFS } from "@/components/workflows/definitions";
import { WorkflowCards, type ReorderState } from "@/components/workflows/WorkflowCards";
import { ui } from "@/components/workflows/styles";

/** Purchase-order drafts need this capability. Anything but "available" counts as off. */
const PO_DRAFT_CAPABILITY = "erp.po.create_draft";

/**
 * Workflows: run a business check, then read its report in plain language. The report itself is
 * built from the saved run record by components/workflows/reports; nothing is recomputed here.
 */
export default function WorkflowsPage() {
  const { workflows, loading, error, stalled, reload, start } = useNammaOpsWorkflows();
  const { approvals, decide, reload: reloadApprovals } = useNammaOpsApprovals();
  const { binding, loading: bindingLoading, error: bindingError } = useNammaOpsBinding();
  const [starting, setStarting] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  // Purchase orders: derived from the live binding, defaulting to the safe "off" state.
  const reorder: ReorderState = useMemo(() => {
    if (bindingLoading) return "checking";
    if (bindingError) return "unknown";
    const row = binding.find((b) => b.business_capability === PO_DRAFT_CAPABILITY);
    return row?.tool && row.availability === "available" ? "available" : "disabled";
  }, [binding, bindingLoading, bindingError]);

  // A card whose ERP connection is not set up says so, instead of offering a button that can only
  // produce a blocked run. (While the binding is loading, or if it cannot be read, nothing is hidden:
  // these workflows only read, and a blocked run is explained.)
  const unavailable = useMemo(() => {
    if (bindingLoading || bindingError) return {};
    const off: Record<string, string> = {};
    for (const def of WORKFLOW_DEFS) {
      const missing = (def.needs ?? []).some((need) => {
        const row = binding.find((b) => b.business_capability === need);
        return !row || row.availability !== "available";
      });
      if (missing)
        off[def.action] =
          "This check is not connected to your ERP data yet, so it cannot run. Nothing is wrong with your data.";
    }
    return off;
  }, [binding, bindingLoading, bindingError]);

  // A run waiting for approval has an approval to show: fetch it when such a run appears.
  const awaiting = workflows
    .filter((w) => w.status === "awaiting_approval")
    .map((w) => w.id)
    .join(",");
  useEffect(() => {
    if (awaiting) void reloadApprovals();
  }, [awaiting, reloadApprovals]);

  const openRun = useCallback((run: Pick<WorkflowSummary, "id">) => {
    setOpened((prev) => ({ ...prev, [run.id]: true }));
  }, []);

  const run = useCallback(
    async (intent: WorkflowIntent, label: string) => {
      setStarting(intent.action);
      try {
        // The API takes a validated intent; the card has already checked the inputs.
        const started = await start({ intent });
        openRun(started);
        toast.success(`${label} started`);
      } finally {
        setStarting(null);
      }
    },
    [start, openRun],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      style={{
        padding: "24px clamp(12px, 3vw, 28px)",
        overflowY: "auto",
        height: "100%",
        color: "var(--kirana-foreground)",
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ ...ui.heading, fontSize: 26, fontWeight: 800, margin: "0 0 4px" }}>
            Workflows
          </h1>
          <p style={{ ...ui.muted, fontSize: 13, margin: 0 }}>
            Run a business check and read the result in plain language.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-busy={refreshing || undefined}
          style={ui.btn()}
        >
          <RefreshCw
            size={13}
            aria-hidden="true"
            style={refreshing ? { animation: "wf-spin 1s linear infinite" } : undefined}
          />{" "}
          Refresh
        </button>
      </header>

      <ApprovalsCard
        approvals={approvals}
        onDecide={(id, action, pin) => decide(id, action, pin)}
      />

      <WorkflowCards onRun={run} starting={starting} reorder={reorder} unavailable={unavailable} />

      <RunHistory
        workflows={workflows}
        loading={loading}
        error={error}
        stalled={stalled}
        refreshing={refreshing}
        opened={opened}
        onToggle={(id) => setOpened((prev) => ({ ...prev, [id]: !prev[id] }))}
        onOpenRun={openRun}
        onStart={start}
        onRetry={() => void refresh()}
      />
      <style>{`@keyframes wf-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){*{animation-duration:0.01ms!important}}`}</style>
    </div>
  );
}
