"use client";
import { useState } from "react";
import {
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Package,
  BarChart3,
  TrendingUp,
  ShoppingCart,
  Users,
} from "lucide-react";
import {
  useNammaOpsWorkflows,
  useNammaOpsApprovals,
  fetchNammaOps,
  type WorkflowView,
} from "@/lib/hooks/useNammaOps";
import { toast } from "sonner";

const s = {
  page: {
    padding: "24px 28px",
    overflowY: "auto" as const,
    height: "100%",
    color: "var(--kirana-foreground)",
  },
  title: {
    fontFamily: "var(--font-display,system-ui)",
    fontSize: 26,
    fontWeight: 800,
    color: "var(--kirana-foreground)",
    margin: "0 0 4px",
  },
  card: {
    background: "var(--kirana-card)",
    border: "1px solid var(--kirana-border)",
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
  },
  pill: (color: string) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 700,
    background: `color-mix(in oklab,${color} 15%,transparent)`,
    color,
  }),
  btn: (primary?: boolean) => ({
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 9,
    border: primary ? "none" : "1px solid var(--kirana-border)",
    background: primary ? "var(--kirana-primary)" : "var(--kirana-card)",
    color: primary ? "var(--kirana-primary-foreground)" : "var(--kirana-foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  }),
};

const WORKFLOW_DEFS = [
  {
    action: "stock_check",
    icon: Package,
    label: "Stock Check",
    desc: "Inventory Agent reads all product stock levels and flags items at or below reorder level.",
    color: "var(--kirana-success)",
    args: [],
  },
  {
    action: "daily_report",
    icon: BarChart3,
    label: "Daily Report",
    desc: "Sales + Finance Agents compute today's revenue, transaction count, top products, and profit & loss.",
    color: "var(--kirana-primary)",
    args: [
      {
        key: "date",
        label: "Date (YYYY-MM-DD)",
        placeholder: new Date().toISOString().slice(0, 10),
      },
    ],
  },
  {
    action: "prepare_reorder",
    icon: ShoppingCart,
    label: "Prepare Reorder",
    desc: "Inventory + Procurement Agents identify low-stock items, find suppliers, and draft purchase orders for your approval.",
    color: "oklch(0.65 0.18 310)",
    args: [],
  },
  {
    action: "demand_forecast",
    icon: TrendingUp,
    label: "Demand Forecast",
    desc: "Inventory Agent analyses recent stock movements and projects demand for the next period.",
    color: "oklch(0.7 0.18 260)",
    args: [],
  },
  {
    action: "supplier_comparison",
    icon: Users,
    label: "Supplier Comparison",
    desc: "Procurement Agent fetches quotations from all registered suppliers and ranks them by price and lead time.",
    color: "oklch(0.7 0.15 30)",
    args: [
      { key: "products", label: "Products (comma-separated)", placeholder: "Atta, Rice, Sugar" },
    ],
  },
];

function statusColor(status: string) {
  if (status === "completed") return "var(--kirana-success)";
  if (status === "failed" || status === "stopped") return "var(--kirana-destructive)";
  if (["running", "submitted", "queued"].includes(status)) return "var(--kirana-primary)";
  return "var(--kirana-muted-foreground)";
}

function WorkflowDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<WorkflowView | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const toggle = async () => {
    if (!open && !detail) {
      setLoading(true);
      try {
        const r = await fetchNammaOps<{ workflow: WorkflowView }>(
          `/workflows/${encodeURIComponent(id)}`,
        );
        setDetail(r.workflow);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    }
    setOpen((v) => !v);
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 0",
          background: "none",
          border: "none",
          color: "var(--kirana-primary)",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {loading ? "Loading…" : open ? "Hide details" : "View details"}
      </button>
      {open && detail && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--kirana-border)" }}>
          {detail.tasks && detail.tasks.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--kirana-muted-foreground)",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Agent Tasks
              </p>
              {detail.tasks.map((t) => (
                <div
                  key={t.taskId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 0",
                    fontSize: 12,
                    borderBottom:
                      "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: statusColor(t.status),
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: "var(--kirana-primary)", fontWeight: 600, minWidth: 80 }}>
                    {t.role ?? "agent"}
                  </span>
                  <span
                    style={{ color: "var(--kirana-muted-foreground)", textTransform: "capitalize" }}
                  >
                    {t.status.replace(/_/g, " ")}
                  </span>
                  {t.retryCount != null && t.retryCount > 0 && (
                    <span style={{ color: "orange", fontSize: 10 }}>retry #{t.retryCount}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {detail.result && (
            <pre
              style={{
                fontSize: 11,
                color: "var(--kirana-muted-foreground)",
                background: "var(--kirana-accent)",
                borderRadius: 8,
                padding: 10,
                overflowX: "auto",
                margin: 0,
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {JSON.stringify(detail.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function WorkflowsPage() {
  const { workflows, loading, reload, start } = useNammaOpsWorkflows();
  const { approvals, decide } = useNammaOpsApprovals();
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const handleRun = async (action: string) => {
    setRunning(action);
    try {
      const wfArgs: Record<string, unknown> = { action };
      if (args[`${action}_date`]) wfArgs.date = args[`${action}_date`];
      if (args[`${action}_products`]) {
        wfArgs.products = args[`${action}_products`]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      await start(wfArgs);
      toast.success(`${action.replace(/_/g, " ")} started`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start workflow");
    } finally {
      setRunning(null);
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await decide(id, "approve", pin || undefined);
      toast.success("Approved");
      setApprovingId(null);
      setPin("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Approval failed");
    }
  };

  const handleReject = async (id: string) => {
    try {
      await decide(id, "reject");
      toast.success("Rejected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rejection failed");
    }
  };

  const pendingApprovals = approvals.filter((a) => a.status === "pending");

  return (
    <div style={s.page}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={s.title}>Workflows</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            Run coordinated multi-agent business workflows
          </p>
        </div>
        <button type="button" onClick={() => void reload()} style={s.btn()}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Pending Approvals */}
      {pendingApprovals.length > 0 && (
        <div
          style={{
            ...s.card,
            borderColor: "color-mix(in oklab,orange 40%,transparent)",
            background: "color-mix(in oklab,orange 5%,var(--kirana-card))",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-display,system-ui)",
              fontSize: 15,
              fontWeight: 700,
              color: "orange",
              margin: "0 0 12px",
            }}
          >
            ⚠ {pendingApprovals.length} Approval{pendingApprovals.length > 1 ? "s" : ""} Required
          </p>
          {pendingApprovals.map((a) => (
            <div
              key={a.id}
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                background: "var(--kirana-card)",
                border: "1px solid var(--kirana-border)",
                marginBottom: 8,
              }}
            >
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--kirana-foreground)",
                  margin: "0 0 4px",
                }}
              >
                {a.payload?.commandText ?? "Purchase order approval required"}
              </p>
              {a.payload?.detail && (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--kirana-muted-foreground)",
                    margin: "0 0 8px",
                  }}
                >
                  {a.payload.detail}
                </p>
              )}
              {a.payload?.total != null && (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--kirana-primary)",
                    margin: "0 0 10px",
                    fontWeight: 600,
                  }}
                >
                  Total: {a.payload.currency ?? "₹"}
                  {a.payload.total}
                </p>
              )}
              {approvingId === a.id ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="password"
                    placeholder="Owner PIN (if required)"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "6px 10px",
                      borderRadius: 7,
                      border: "1px solid var(--kirana-border)",
                      background: "var(--kirana-accent)",
                      color: "var(--kirana-foreground)",
                      fontSize: 13,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void handleApprove(a.id)}
                    style={{ ...s.btn(true), padding: "6px 12px" }}
                  >
                    Confirm Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => setApprovingId(null)}
                    style={{ ...s.btn(), padding: "6px 12px" }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setApprovingId(a.id)}
                    style={{ ...s.btn(true), padding: "6px 12px" }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleReject(a.id)}
                    style={{ ...s.btn(), padding: "6px 12px", color: "var(--kirana-destructive)" }}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Workflow launchers */}
      <div style={{ marginBottom: 28 }}>
        <p
          style={{
            fontFamily: "var(--font-display,system-ui)",
            fontSize: 17,
            fontWeight: 700,
            color: "var(--kirana-foreground)",
            margin: "0 0 14px",
          }}
        >
          Available Workflows
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))",
            gap: 14,
          }}
        >
          {WORKFLOW_DEFS.map(({ action, icon: Icon, label, desc, color, args: argDefs }) => (
            <div key={action} style={s.card}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    background: `color-mix(in oklab,${color} 15%,transparent)`,
                    display: "grid",
                    placeItems: "center",
                    color,
                    flexShrink: 0,
                  }}
                >
                  <Icon size={18} />
                </div>
                <div style={{ flex: 1 }}>
                  <p
                    style={{
                      fontFamily: "var(--font-display,system-ui)",
                      fontSize: 15,
                      fontWeight: 700,
                      color: "var(--kirana-foreground)",
                      margin: 0,
                    }}
                  >
                    {label}
                  </p>
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--kirana-muted-foreground)",
                      margin: "3px 0 0",
                    }}
                  >
                    {desc}
                  </p>
                </div>
              </div>
              {argDefs.map((arg) => (
                <input
                  key={arg.key}
                  type="text"
                  placeholder={arg.placeholder}
                  value={args[`${action}_${arg.key}`] ?? ""}
                  onChange={(e) =>
                    setArgs((prev) => ({ ...prev, [`${action}_${arg.key}`]: e.target.value }))
                  }
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--kirana-border)",
                    background: "var(--kirana-accent)",
                    color: "var(--kirana-foreground)",
                    fontSize: 13,
                    marginBottom: 8,
                    boxSizing: "border-box",
                  }}
                />
              ))}
              <button
                type="button"
                onClick={() => void handleRun(action)}
                disabled={running === action}
                style={{
                  ...s.btn(true),
                  width: "100%",
                  justifyContent: "center",
                  opacity: running === action ? 0.7 : 1,
                }}
              >
                {running === action ? (
                  <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
                ) : (
                  <Play size={13} />
                )}
                {running === action ? "Starting…" : `Run ${label}`}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Run history */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-display,system-ui)",
              fontSize: 17,
              fontWeight: 700,
              color: "var(--kirana-foreground)",
              margin: 0,
            }}
          >
            Run History
          </p>
          <span style={{ fontSize: 12, color: "var(--kirana-muted-foreground)" }}>
            {workflows.length} runs
          </span>
        </div>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
            <Loader2
              size={22}
              style={{ animation: "spin 1s linear infinite", color: "var(--kirana-primary)" }}
            />
          </div>
        ) : workflows.length === 0 ? (
          <div style={{ ...s.card, textAlign: "center", padding: 40 }}>
            <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 14 }}>
              No workflows run yet. Start one above.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {workflows.map((wf) => (
              <div key={wf.id} style={s.card}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <p
                        style={{
                          fontFamily: "var(--font-display,system-ui)",
                          fontSize: 14,
                          fontWeight: 700,
                          color: "var(--kirana-foreground)",
                          margin: 0,
                        }}
                      >
                        {wf.intent?.action?.replace(/_/g, " ") ?? wf.id}
                      </p>
                      {wf.intent?.products && wf.intent.products.length > 0 && (
                        <span style={{ fontSize: 11, color: "var(--kirana-muted-foreground)" }}>
                          · {wf.intent.products.join(", ")}
                        </span>
                      )}
                      {wf.intent?.date && (
                        <span style={{ fontSize: 11, color: "var(--kirana-muted-foreground)" }}>
                          · {wf.intent.date}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={s.pill(statusColor(wf.status))}>
                        {wf.status === "completed" ? (
                          <CheckCircle size={10} />
                        ) : wf.status === "failed" ? (
                          <XCircle size={10} />
                        ) : (
                          <Clock size={10} />
                        )}{" "}
                        {wf.status}
                      </span>
                      {wf.durationMs != null && (
                        <span style={{ fontSize: 11, color: "var(--kirana-muted-foreground)" }}>
                          {(wf.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--kirana-muted-foreground)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {wf.startedAt ? new Date(wf.startedAt).toLocaleString() : ""}
                  </span>
                </div>
                {wf.error && (
                  <p
                    style={{ fontSize: 12, color: "var(--kirana-destructive)", margin: "0 0 8px" }}
                  >
                    {wf.error}
                  </p>
                )}
                <WorkflowDetail id={wf.id} />
              </div>
            ))}
          </div>
        )}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
