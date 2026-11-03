"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowListItem {
  id: string;
  intent?: { action: string; products?: string[]; date?: string; qty?: number };
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface WorkflowView extends WorkflowListItem {
  tasks?: Array<{
    taskId: string;
    role?: string;
    status: string;
    result?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
    seatId?: string;
    retryCount?: number;
  }>;
  result?: Record<string, unknown>;
  timeline?: Array<{ at: string; stage: string; data?: unknown }>;
  /** Inventory stock_check result */
  stock?: Array<{
    item_code?: string;
    item_name?: string;
    qty?: number;
    reorder_level?: number;
    uom?: string;
    category?: string;
    warehouse?: string;
  }>;
  /** Daily report result */
  sales?: { total?: number; count?: number; avg?: number; currency?: string };
  topProducts?: Array<{ item_name: string; qty: number; revenue: number }>;
  pnl?: { income?: number; expense?: number; profit?: number; currency?: string };
  /** Supplier comparison result */
  suppliers?: Array<{
    name: string;
    item?: string;
    unit_price?: number;
    lead_days?: number;
    currency?: string;
    rank?: number;
  }>;
  /** Reorder result */
  reorder?: {
    draftPoId?: string;
    items?: Array<{ item_name: string; qty: number; supplier?: string; unit_price?: number }>;
    total?: number;
    currency?: string;
  };
}

export interface NammaOpsApproval {
  id: string;
  workflowId?: string;
  kind: "approve" | "reject";
  status: "pending" | "approved" | "rejected" | "reconciled";
  createdAt?: string;
  settledAt?: string;
  payload?: { commandText?: string; detail?: string; total?: number; currency?: string };
}

export interface NammaOpsDashboard {
  workforce: Record<
    string,
    {
      role: string;
      seat_id?: string;
      agent_id?: string;
      status?: string;
      specialization_id?: string;
    }
  > | null;
  binding: Array<{
    business_capability: string;
    tool: string | null;
    state: string;
    availability: string;
    risk: string | null;
  }>;
  latest: Record<string, WorkflowView | null>;
  approvals: NammaOpsApproval[];
  data_source: string;
}

export interface BindingStatus {
  business_capability: string;
  tool: string | null;
  capability_id: string | null;
  state: string;
  availability: string;
  risk: string | null;
}

// ── Fetchers ───────────────────────────────────────────────────────────────

export async function fetchNammaOps<T>(path: string, body?: unknown): Promise<T> {
  const url = `/api/runtime/nammaops${path}`;
  const res = await fetch(url, {
    method: body !== undefined ? "POST" : "GET",
    headers:
      body !== undefined
        ? { "Content-Type": "application/json", Origin: window.location.origin }
        : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `NammaOps error ${res.status}`);
  return data as T;
}

// ── Hooks ──────────────────────────────────────────────────────────────────

export function useNammaOpsDashboard() {
  const [data, setData] = useState<NammaOpsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchNammaOps<{ body: NammaOpsDashboard }>("/dashboard");
      // API wraps response in { body: ... } via the runtime handler
      const r = result as unknown as Record<string, NammaOpsDashboard>;
      setData(r.dashboard ?? (result as unknown as NammaOpsDashboard));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  return { data, loading, error, reload: load };
}

export function useNammaOpsWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchNammaOps<{ workflows: WorkflowListItem[] }>("/workflows");
      setWorkflows(result.workflows ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workflows");
    } finally {
      setLoading(false);
    }
  }, []);

  const start = useCallback(
    async (intent: Record<string, unknown>) => {
      const result = await fetchNammaOps<{ workflow: WorkflowListItem }>("/workflows", intent);
      await load();
      return result.workflow;
    },
    [load],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Poll for active workflows
  const activeRef = useRef(false);
  useEffect(() => {
    const hasActive = workflows.some(
      (w) => !["completed", "failed", "stopped", "interrupted"].includes(w.status),
    );
    if (hasActive && !activeRef.current) {
      activeRef.current = true;
      const interval = setInterval(() => void load(), 2000);
      return () => {
        clearInterval(interval);
        activeRef.current = false;
      };
    }
    activeRef.current = false;
  }, [workflows, load]);

  return { workflows, loading, error, reload: load, start };
}

export function useNammaOpsApprovals() {
  const [approvals, setApprovals] = useState<NammaOpsApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchNammaOps<{ approvals: NammaOpsApproval[] }>("/approvals");
      setApprovals(result.approvals ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, []);

  const decide = useCallback(
    async (id: string, action: "approve" | "reject", pin?: string) => {
      await fetchNammaOps(
        `/approvals/${encodeURIComponent(id)}/${action}`,
        pin ? { owner_pin: pin } : {},
      );
      await load();
    },
    [load],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  return { approvals, loading, error, reload: load, decide };
}

export function useNammaOpsBinding() {
  const [binding, setBinding] = useState<BindingStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchNammaOps<{ binding: BindingStatus[] }>("/binding")
      .then((r) => setBinding(r.binding ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, []);

  return { binding, loading, error };
}
