"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isActiveStatus,
  normalizeWorkflow,
  type WorkflowSummary,
  type WorkflowView,
} from "@/lib/workflow-contract";

// ── Types ──────────────────────────────────────────────────────────────────
// The workflow types are the server's own contract (lib/workflow-contract.ts). They are re-exported
// here because other pages import them from this module.

export type {
  Clarification,
  TimelineEvent,
  WorkflowIntent,
  WorkflowListItem,
  WorkflowSummary,
  WorkflowTask,
  WorkflowView,
} from "@/lib/workflow-contract";

/** One owner approval, as GET /approvals returns it (lib/server/nammaops/owner-approvals.mjs). */
export interface NammaOpsApproval {
  id: string;
  workflow_id?: string;
  /** "purchase_order" or "sales_invoice". */
  kind: string;
  action?: string;
  erp_document_type?: string;
  erp_document_name?: string;
  supplier?: string;
  customer?: string;
  items?: Array<{ item_code?: string; qty?: number; rate?: number }>;
  total?: number;
  document_state?: string;
  /** pending, submitting, submitted, rejected, expired, invalidated, uncertain or failed. */
  status: string;
  requested_at?: string;
  expires_at?: string;
  decided_at?: string;
  error?: string;
  /** @deprecated The server sends flat records; only ProcurementPage still reads this. */
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
  mode?: string;
  tool: string | null;
  capability_id: string | null;
  state: string;
  availability: string;
  risk: string | null;
}

// ── Fetchers ───────────────────────────────────────────────────────────────

let memorySession: string | null = null;
/** One id per browser tab. The PIN proof and the approval it unlocks are bound to this session. */
export function approvalSession(): string {
  try {
    let id = window.sessionStorage.getItem("nammaops-approval-session");
    if (!id) {
      id = `panel_${crypto.randomUUID()}`;
      window.sessionStorage.setItem("nammaops-approval-session", id);
    }
    return id;
  } catch {
    // Storage can be blocked; a per-page id still binds the approval to this page.
    memorySession ??= `panel_${crypto.randomUUID()}`;
    return memorySession;
  }
}

/**
 * GET (no body) or POST (JSON body) against /api/runtime/nammaops. The body is read defensively: an
 * HTML or empty error page gives "NammaOps error 502", not a JSON parse failure.
 */
export async function fetchNammaOps<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = `/api/runtime/nammaops${path}`;
  const res = await fetch(url, {
    method: body !== undefined ? "POST" : "GET",
    headers:
      body !== undefined
        ? { "Content-Type": "application/json", Origin: window.location.origin }
        : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = (await Promise.resolve()
    .then(() => res.json())
    .catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error || `NammaOps error ${res.status}`);
  return data as T;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const messageOf = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

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

/** First poll after a start, and the base of the back-off. */
export const POLL_BASE_MS = 2000;
export const POLL_MAX_MS = 30_000;
/** Consecutive failed polls before polling stops and the page offers "Try again". */
export const POLL_MAX_FAILURES = 5;
/** A run still "running" after this long is shown as possibly interrupted, and is no longer polled. */
export const STALE_RUN_MS = 20 * 60_000;

/** True for a run that is marked running but has been for so long that the server probably restarted. */
export function isStaleRunning(run: WorkflowSummary, now = Date.now()): boolean {
  if (!isActiveStatus(run.status)) return false;
  const started = Date.parse(run.created_at ?? "");
  return Number.isFinite(started) && now - started > STALE_RUN_MS;
}

/**
 * The run history, polled only while a run is genuinely executing.
 *  - One request at a time (no overlap), aborted on unmount, stale answers dropped.
 *  - Only `running` runs younger than STALE_RUN_MS keep polling; completed, partial, blocked, failed,
 *    uncertain, interrupted, needs_clarification and awaiting_approval runs never do.
 *  - Waits while the tab is hidden; backs off 2 s, 4 s, ... 30 s after a failure and stops after
 *    POLL_MAX_FAILURES, when `stalled` is true until `reload()` is called.
 *  - `loading` is true only for the first load, so refreshes never flash a spinner.
 */
export function useNammaOpsWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const [hasActive, setHasActive] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (inflight.current) return; // never two requests at once
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const result = await fetchNammaOps<{ workflows?: unknown[] }>(
        "/workflows",
        undefined,
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      const list = (result.workflows ?? []).map((raw) => normalizeWorkflow<WorkflowSummary>(raw));
      setWorkflows(list);
      // Decided here, when the list arrives, not during render: is a run genuinely executing?
      const now = Date.now();
      setHasActive(list.some((w) => isActiveStatus(w.status) && !isStaleRunning(w, now)));
      setError(null);
      setStalled(false);
      failures.current = 0;
    } catch (e) {
      if (isAbort(e) || !alive.current) return;
      failures.current += 1;
      setError(messageOf(e, "Failed to load workflows"));
      if (failures.current >= POLL_MAX_FAILURES) setStalled(true);
    } finally {
      if (inflight.current === controller) inflight.current = null;
      if (alive.current) setLoading(false);
    }
  }, []);

  /** Manual refresh: clears a stalled state and tries again right away. */
  const reload = useCallback(async () => {
    failures.current = 0;
    setStalled(false);
    await load();
  }, [load]);

  const start = useCallback(
    async (intent: Record<string, unknown>) => {
      const result = await fetchNammaOps<{ workflow: WorkflowSummary }>("/workflows", intent);
      await load();
      return normalizeWorkflow<WorkflowSummary>(result.workflow);
    },
    [load],
  );

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      alive.current = false;
      // Forget the aborted request at once. React's development StrictMode runs this cleanup and then
      // the effect again straight away; if the guard still held the old request, that second load
      // would be skipped and the history would stay empty.
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (!hasActive || stalled) return;
    let cancelled = false;
    const schedule = (ms: number) => {
      if (!cancelled) timer.current = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      if (cancelled || document.hidden) return; // resumes on visibilitychange
      await load();
      schedule(Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** failures.current));
    };
    const onVisible = () => {
      if (document.hidden || cancelled) return;
      clearTimeout(timer.current);
      void tick();
    };
    schedule(POLL_BASE_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasActive, stalled, load]);

  return { workflows, loading, error, stalled, hasActive, reload, start };
}

/**
 * One run's full record (GET /workflows/:id), fetched when `enabled` and again whenever the run's
 * status or finish time changes in the list. Answers that arrive out of order are dropped.
 */
export function useWorkflowDetail(
  id: string,
  enabled: boolean,
  status?: string,
  finishedAt?: string | null,
) {
  const [view, setView] = useState<WorkflowView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetchNammaOps<{ workflow?: unknown }>(
      `/workflows/${encodeURIComponent(id)}`,
      undefined,
      controller.signal,
    )
      .then((r) => {
        if (mine !== seq.current) return;
        setView(normalizeWorkflow<WorkflowView>(r.workflow));
        setError(null);
        setMissing(false);
      })
      .catch((e) => {
        if (isAbort(e) || mine !== seq.current) return;
        const text = messageOf(e, "Could not load this report");
        setMissing(/not found|404/i.test(text));
        setError(text);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    return () => controller.abort();
  }, [id, enabled, status, finishedAt, attempt]);

  return { view, loading, error, missing, retry };
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
      // The server reads `pin` for both approve and reject, bound to this tab's session.
      await fetchNammaOps(`/approvals/${encodeURIComponent(id)}/${action}`, {
        pin,
        session: approvalSession(),
      });
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

  const reload = useCallback(() => {
    setLoading(true);
    return fetchNammaOps<{ binding: BindingStatus[] }>("/binding")
      .then((r) => {
        setBinding(r.binding ?? []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return { binding, loading, error, reload };
}
