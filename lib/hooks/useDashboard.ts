"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export interface DashboardCard {
  id: string;
  label: string;
  value: number | string | null;
  unit: string;
  tone?: "ok" | "warn" | "bad";
}
export interface DashboardSeries {
  name: string;
  values: Array<number | null>;
}
export interface DashboardChart {
  type: "line" | "bar" | "donut" | "aging";
  title?: string;
  unit?: string;
  labels: string[];
  series: DashboardSeries[];
  stacked?: boolean;
}
export interface DashboardTable {
  columns: Array<{ key: string; label: string; unit?: string }>;
  rows: Array<Record<string, unknown>>;
}
export interface ManagementDashboard {
  dashboard: string;
  source: "fixture" | "erpnext";
  verification: "synthetic_fixture" | "live_read_unverified";
  generated_at: string;
  range: { from: string; to: string };
  cards: DashboardCard[];
  charts: Record<string, DashboardChart>;
  tables: Record<string, DashboardTable>;
  disclaimer?: string;
  sections_unavailable: Array<{
    sections: string[];
    capability: string;
    status: string;
    reason: string;
  }>;
  invocation_ids: string[];
  correlation_id: string;
}

export interface DateRange {
  from?: string;
  to?: string;
}

/**
 * One management dashboard from the governed NammaOps API. Stale requests are aborted when the
 * range changes; no data library is used (same fetch path as fetchNammaOps).
 */
export function useDashboard(name: string, range: DateRange = {}) {
  const [data, setData] = useState<ManagementDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const query = new URLSearchParams();
    if (range.from) query.set("from", range.from);
    if (range.to) query.set("to", range.to);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/runtime/nammaops/dashboards/${encodeURIComponent(name)}${query.size ? `?${query}` : ""}`,
        { signal: abort.signal },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Dashboard error ${res.status}`);
      setData(body as ManagementDashboard);
      setError(null);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    } finally {
      if (controller.current === abort) setLoading(false);
    }
  }, [name, range.from, range.to]);

  useEffect(() => {
    // Data fetch on mount / range change; state is set from the fetch result.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => controller.current?.abort();
  }, [load]);

  return { data, error, loading, refresh: load };
}
