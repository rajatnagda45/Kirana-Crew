"use client";
import { useEffect, useState } from "react";
import {
  Store,
  Package,
  Users,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  Clock,
  Loader2,
  Zap,
  ShoppingCart,
  BarChart3,
  ArrowRight,
  Bot,
  Activity,
  RefreshCw,
  MessageSquare,
} from "lucide-react";
import { useStudio, runtimeRequest } from "@/lib/store";
import { fetchNammaOps, type NammaOpsDashboard } from "@/lib/hooks/useNammaOps";

const s = {
  page: {
    padding: "24px 28px",
    overflowY: "auto" as const,
    height: "100%",
    color: "var(--kirana-foreground)",
  },
  header: { marginBottom: 28 },
  title: {
    fontFamily: "var(--font-display,system-ui)",
    fontSize: 26,
    fontWeight: 800,
    color: "var(--kirana-foreground)",
    margin: 0,
  },
  subtitle: { fontSize: 13, color: "var(--kirana-muted-foreground)", margin: "4px 0 0" },
  grid: (cols: number) => ({
    display: "grid",
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gap: 16,
    marginBottom: 24,
  }),
  card: {
    background: "var(--kirana-card)",
    border: "1px solid var(--kirana-border)",
    borderRadius: 14,
    padding: 20,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--kirana-muted-foreground)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    marginBottom: 8,
  },
  cardValue: {
    fontFamily: "var(--font-display,system-ui)",
    fontSize: 32,
    fontWeight: 800,
    color: "var(--kirana-foreground)",
    lineHeight: 1,
  },
  cardSubValue: { fontSize: 12, color: "var(--kirana-muted-foreground)", marginTop: 6 },
  cardIcon: (color: string) => ({
    width: 36,
    height: 36,
    borderRadius: 10,
    background: `color-mix(in oklab,${color} 15%,transparent)`,
    display: "grid",
    placeItems: "center",
    color,
    marginBottom: 12,
  }),
  sectionTitle: {
    fontFamily: "var(--font-display,system-ui)",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--kirana-foreground)",
    margin: "0 0 14px",
  },
  alert: (kind: "warn" | "error" | "info") => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 10,
    border: `1px solid ${kind === "error" ? "color-mix(in oklab,var(--kirana-destructive) 40%,transparent)" : kind === "warn" ? "color-mix(in oklab,orange 40%,transparent)" : "var(--kirana-border)"}`,
    background:
      kind === "error"
        ? "color-mix(in oklab,var(--kirana-destructive) 8%,transparent)"
        : kind === "warn"
          ? "color-mix(in oklab,orange 8%,transparent)"
          : "var(--kirana-accent)",
    fontSize: 13,
    color: "var(--kirana-foreground)",
    marginBottom: 8,
  }),
  actionBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--kirana-border)",
    background: "var(--kirana-card)",
    color: "var(--kirana-foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    textAlign: "left" as const,
    width: "100%",
  },
};

interface WorkforceSummary {
  online: number;
  busy: number;
  idle: number;
  offline: number;
  failed: number;
}

export default function OverviewPage({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const { state } = useStudio();
  const [dashboard, setDashboard] = useState<NammaOpsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetchNammaOps<{ dashboard: NammaOpsDashboard }>("/dashboard");
      setDashboard(res.dashboard ?? (res as unknown as NammaOpsDashboard));
    } catch {
      /* backend may not have NammaOps set up yet */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  const seats = state.seats;
  const tasks = state.tasks;
  const connected = state.connection === "connected";

  const activeTasks = tasks.filter((t) => ["running", "submitted", "queued"].includes(t.status));
  const failedTasks = tasks.filter((t) => t.status === "failed");
  const doneTasks = tasks.filter((t) => t.status === "completed");
  const pendingApprovals = tasks.filter((t) => t.status === "waiting_approval");

  const workforce: WorkforceSummary = seats.reduce(
    (acc, s) => {
      if (!s.assigned) {
        acc.offline++;
        return acc;
      }
      if (s.status === "running") {
        acc.online++;
        acc.busy++;
      } else if (s.status === "failed") {
        acc.online++;
        acc.failed++;
      } else {
        acc.online++;
        acc.idle++;
      }
      return acc;
    },
    { online: 0, busy: 0, idle: 0, offline: 0, failed: 0 },
  );

  const latestStock = dashboard?.latest?.stock_check;
  const latestReport = dashboard?.latest?.daily_report;
  const latestReorder = dashboard?.latest?.prepare_reorder;

  const stockResult = latestStock?.result as Record<string, unknown> | undefined;
  const reportResult = latestReport?.result as Record<string, unknown> | undefined;

  const lowStock = (
    (stockResult?.stock as Array<{ qty?: number; reorder_level?: number; item_name?: string }>) ??
    []
  ).filter(
    (i) =>
      typeof i.qty === "number" && typeof i.reorder_level === "number" && i.qty <= i.reorder_level,
  );

  const salesTotal = (reportResult?.sales as { total?: number; currency?: string } | undefined)
    ?.total;
  const currency = (reportResult?.sales as { currency?: string } | undefined)?.currency ?? "₹";

  const alerts: Array<{ kind: "warn" | "error" | "info"; text: string }> = [];
  if (!connected)
    alerts.push({ kind: "error", text: "Gateway disconnected — agent tasks cannot run." });
  if (failedTasks.length > 0)
    alerts.push({
      kind: "error",
      text: `${failedTasks.length} task${failedTasks.length > 1 ? "s" : ""} failed. Check the Tasks panel.`,
    });
  if (pendingApprovals.length > 0)
    alerts.push({
      kind: "warn",
      text: `${pendingApprovals.length} task${pendingApprovals.length > 1 ? "s" : ""} waiting for your approval.`,
    });
  if (lowStock.length > 0)
    alerts.push({
      kind: "warn",
      text: `${lowStock.length} product${lowStock.length > 1 ? "s" : ""} at or below reorder level.`,
    });
  if (workforce.failed > 0)
    alerts.push({
      kind: "error",
      text: `${workforce.failed} agent${workforce.failed > 1 ? "s" : ""} in failed state.`,
    });

  const quickActions = [
    {
      icon: MessageSquare,
      label: "Talk to AI Manager",
      view: "chat",
      color: "var(--kirana-primary)",
    },
    { icon: Package, label: "Check inventory", view: "inventory", color: "var(--kirana-success)" },
    { icon: Zap, label: "Run workflow", view: "workflows", color: "oklch(0.7 0.18 260)" },
    { icon: Users, label: "View AI Workforce", view: "workers", color: "oklch(0.7 0.15 30)" },
    {
      icon: ShoppingCart,
      label: "Procurement",
      view: "procurement",
      color: "oklch(0.65 0.18 310)",
    },
    { icon: BarChart3, label: "Analytics", view: "analytics", color: "oklch(0.75 0.12 200)" },
    { icon: Store, label: "Open 3D Store", view: "store", color: "var(--kirana-primary)" },
  ];

  if (loading)
    return (
      <div style={{ ...s.page, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2
          size={28}
          style={{ animation: "spin 1s linear infinite", color: "var(--kirana-primary)" }}
        />
      </div>
    );

  return (
    <div style={s.page}>
      {/* Header */}
      <div
        style={{
          ...s.header,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <h1 style={s.title}>Command Center</h1>
          <p style={s.subtitle}>
            {connected
              ? `Connected · ${seats.filter((s) => s.assigned).length} agents active`
              : "Disconnected from gateway"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 14px",
            borderRadius: 9,
            border: "1px solid var(--kirana-border)",
            background: "var(--kirana-card)",
            color: "var(--kirana-muted-foreground)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <RefreshCw
            size={13}
            style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}
          />
          Refresh
        </button>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <p style={{ ...s.sectionTitle, marginBottom: 10 }}>Alerts</p>
          {alerts.map((a, i) => (
            <div key={i} style={s.alert(a.kind)}>
              <AlertCircle
                size={16}
                style={{
                  flexShrink: 0,
                  marginTop: 1,
                  color: a.kind === "error" ? "var(--kirana-destructive)" : "orange",
                }}
              />
              {a.text}
            </div>
          ))}
        </div>
      )}

      {/* Business KPIs */}
      <div style={s.grid(4)}>
        <div style={s.card}>
          <div style={s.cardIcon("var(--kirana-primary)")}>
            <TrendingUp size={18} />
          </div>
          <p style={s.cardLabel}>Today&apos;s Sales</p>
          {latestReport ? (
            <>
              <p style={s.cardValue}>
                {salesTotal != null ? `${currency}${salesTotal.toFixed(0)}` : "—"}
              </p>
              <p style={s.cardSubValue}>From {latestReport.intent?.date ?? "latest report"}</p>
            </>
          ) : (
            <>
              <p style={{ ...s.cardValue, fontSize: 16, color: "var(--kirana-muted-foreground)" }}>
                Run daily report
              </p>
              <p style={s.cardSubValue}>No report yet · go to Workflows</p>
            </>
          )}
        </div>
        <div style={s.card}>
          <div style={s.cardIcon("var(--kirana-success)")}>
            <Package size={18} />
          </div>
          <p style={s.cardLabel}>Low-Stock Items</p>
          <p style={s.cardValue}>
            {lowStock.length > 0 ? lowStock.length : latestStock ? "0" : "—"}
          </p>
          <p style={s.cardSubValue}>
            {latestStock
              ? `From stock check · ${lowStock.length === 0 ? "all clear" : "needs reorder"}`
              : "No stock check run yet"}
          </p>
        </div>
        <div style={s.card}>
          <div style={s.cardIcon("oklch(0.7 0.15 30)")}>
            <CheckCircle size={18} />
          </div>
          <p style={s.cardLabel}>Tasks Done</p>
          <p style={s.cardValue}>{doneTasks.length}</p>
          <p style={s.cardSubValue}>
            {activeTasks.length} active · {failedTasks.length} failed
          </p>
        </div>
        <div style={s.card}>
          <div style={s.cardIcon("oklch(0.7 0.18 260)")}>
            <Users size={18} />
          </div>
          <p style={s.cardLabel}>AI Workforce</p>
          <p style={s.cardValue}>{workforce.online}</p>
          <p style={s.cardSubValue}>
            {workforce.busy} busy · {workforce.idle} idle · {workforce.offline} offline
          </p>
        </div>
      </div>

      {/* Workforce + Active Tasks */}
      <div style={{ ...s.grid(2), alignItems: "start" }}>
        {/* Workforce status */}
        <div style={s.card}>
          <p style={s.sectionTitle}>AI Workforce</p>
          {seats.filter((s) => s.assigned).length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)" }}>
              No agents assigned yet. Run setup via Integrations.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {seats
                .filter((s) => s.assigned)
                .map((seat) => (
                  <div
                    key={seat.seatId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 10,
                      background: "var(--kirana-accent)",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background:
                          seat.status === "running"
                            ? "var(--kirana-success)"
                            : seat.status === "failed"
                              ? "var(--kirana-destructive)"
                              : "var(--kirana-muted-foreground)",
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--kirana-foreground)",
                      }}
                    >
                      {seat.label}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--kirana-primary)",
                        textTransform: "capitalize",
                      }}
                    >
                      {seat.roleTitle ?? seat.status}
                    </span>
                    {seat.status === "running" && (
                      <Activity
                        size={13}
                        style={{ color: "var(--kirana-success)", animation: "pulse 2s infinite" }}
                      />
                    )}
                  </div>
                ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => onNavigate?.("workers")}
            style={{ ...s.actionBtn, marginTop: 12, color: "var(--kirana-primary)" }}
          >
            Manage Workforce <ArrowRight size={14} style={{ marginLeft: "auto" }} />
          </button>
        </div>

        {/* Active tasks */}
        <div style={s.card}>
          <p style={s.sectionTitle}>Active Tasks</p>
          {activeTasks.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)" }}>
              No tasks running. Ask Alice to start a workflow.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activeTasks.slice(0, 5).map((t) => (
                <div
                  key={t.taskId}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    background: "var(--kirana-accent)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <Loader2
                      size={11}
                      style={{
                        color: "var(--kirana-primary)",
                        animation: "spin 1s linear infinite",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        color: "var(--kirana-primary)",
                        fontWeight: 600,
                        textTransform: "capitalize",
                      }}
                    >
                      {t.status.replace(/_/g, " ")}
                    </span>
                    {t.actorName && (
                      <span style={{ color: "var(--kirana-muted-foreground)" }}>
                        · {t.actorName}
                      </span>
                    )}
                  </div>
                  <p
                    style={{
                      color: "var(--kirana-foreground)",
                      margin: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.message}
                  </p>
                </div>
              ))}
              {activeTasks.length > 5 && (
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--kirana-muted-foreground)",
                    textAlign: "center",
                  }}
                >
                  +{activeTasks.length - 5} more
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => onNavigate?.("tasks")}
            style={{ ...s.actionBtn, marginTop: 12, color: "var(--kirana-primary)" }}
          >
            All Tasks <ArrowRight size={14} style={{ marginLeft: "auto" }} />
          </button>
        </div>
      </div>

      {/* Recent Workflows */}
      {dashboard?.latest && Object.keys(dashboard.latest).length > 0 && (
        <div style={{ ...s.card, marginBottom: 24 }}>
          <p style={s.sectionTitle}>Recent Workflow Results</p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))",
              gap: 12,
            }}
          >
            {Object.entries(dashboard.latest).map(
              ([kind, wf]) =>
                wf && (
                  <div
                    key={kind}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: "1px solid var(--kirana-border)",
                      background: "var(--kirana-accent)",
                    }}
                  >
                    <p
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--kirana-primary)",
                        textTransform: "uppercase",
                        margin: "0 0 4px",
                      }}
                    >
                      {kind.replace(/_/g, " ")}
                    </p>
                    <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
                      {wf.status === "completed"
                        ? "✓ Completed"
                        : wf.status === "failed"
                          ? "✗ Failed"
                          : wf.status}
                    </p>
                    {wf.completedAt && (
                      <p
                        style={{
                          fontSize: 10,
                          color: "var(--kirana-muted-foreground)",
                          margin: "2px 0 0",
                        }}
                      >
                        {new Date(wf.completedAt).toLocaleTimeString()}
                      </p>
                    )}
                  </div>
                ),
            )}
          </div>
          <button
            type="button"
            onClick={() => onNavigate?.("workflows")}
            style={{ ...s.actionBtn, marginTop: 12, color: "var(--kirana-primary)" }}
          >
            View all workflows <ArrowRight size={14} style={{ marginLeft: "auto" }} />
          </button>
        </div>
      )}

      {/* Quick Actions */}
      <div style={{ ...s.card, marginBottom: 24 }}>
        <p style={s.sectionTitle}>Quick Actions</p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))",
            gap: 10,
          }}
        >
          {quickActions.map(({ icon: Icon, label, view, color }) => (
            <button
              key={view}
              type="button"
              onClick={() => onNavigate?.(view)}
              style={{
                ...s.actionBtn,
                flexDirection: "column",
                gap: 6,
                padding: 14,
                alignItems: "flex-start",
              }}
            >
              <Icon size={18} style={{ color }} />
              <span style={{ fontSize: 12, color: "var(--kirana-foreground)" }}>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Low stock products */}
      {lowStock.length > 0 && (
        <div style={{ ...s.card, marginBottom: 24 }}>
          <p style={s.sectionTitle}>Low-Stock Products</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {lowStock.slice(0, 8).map((item, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 12px",
                  borderRadius: 9,
                  background: "var(--kirana-accent)",
                  fontSize: 12,
                }}
              >
                <AlertCircle size={13} style={{ color: "orange", flexShrink: 0 }} />
                <span style={{ flex: 1, color: "var(--kirana-foreground)", fontWeight: 500 }}>
                  {item.item_name}
                </span>
                <span style={{ color: "var(--kirana-muted-foreground)" }}>
                  Stock: {item.qty} · Reorder: {item.reorder_level}
                </span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onNavigate?.("inventory")}
            style={{ ...s.actionBtn, marginTop: 10, color: "var(--kirana-primary)" }}
          >
            View inventory <ArrowRight size={14} style={{ marginLeft: "auto" }} />
          </button>
        </div>
      )}

      {/* Pending approvals */}
      {(dashboard?.approvals?.length ?? 0) > 0 && (
        <div style={s.card}>
          <p style={s.sectionTitle}>Pending Approvals</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(dashboard?.approvals ?? [])
              .filter((a) => a.status === "pending")
              .map((a) => (
                <div
                  key={a.id}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: "1px solid color-mix(in oklab,orange 40%,transparent)",
                    background: "color-mix(in oklab,orange 8%,transparent)",
                    fontSize: 12,
                  }}
                >
                  <p
                    style={{
                      fontWeight: 600,
                      color: "var(--kirana-foreground)",
                      margin: "0 0 4px",
                    }}
                  >
                    {a.payload?.commandText ?? "Purchase order approval"}
                  </p>
                  {a.payload?.total != null && (
                    <p style={{ color: "var(--kirana-muted-foreground)", margin: 0 }}>
                      Total: {a.payload.currency ?? "₹"}
                      {a.payload.total}
                    </p>
                  )}
                </div>
              ))}
          </div>
          <button
            type="button"
            onClick={() => onNavigate?.("procurement")}
            style={{ ...s.actionBtn, marginTop: 10, color: "orange" }}
          >
            Review approvals <ArrowRight size={14} style={{ marginLeft: "auto" }} />
          </button>
        </div>
      )}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}`}</style>
    </div>
  );
}
