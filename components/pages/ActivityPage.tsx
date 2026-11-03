"use client";
import { useEffect, useState } from "react";
import {
  Activity,
  RefreshCw,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  FileText,
  Package,
  ShoppingCart,
} from "lucide-react";
import { runtimeRequest, useStudio } from "@/lib/store";
import type { TaskItem } from "@/types/game";

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
  btn: (active?: boolean) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid var(--kirana-border)",
    background: active
      ? "color-mix(in oklab,var(--kirana-primary) 15%,transparent)"
      : "var(--kirana-card)",
    color: active ? "var(--kirana-primary)" : "var(--kirana-muted-foreground)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: active ? 700 : 400,
  }),
};

function statusIcon(status: string) {
  if (status === "completed")
    return <CheckCircle size={13} style={{ color: "var(--kirana-success)", flexShrink: 0 }} />;
  if (status === "failed")
    return <XCircle size={13} style={{ color: "var(--kirana-destructive)", flexShrink: 0 }} />;
  if (status === "running")
    return <Activity size={13} style={{ color: "var(--kirana-primary)", flexShrink: 0 }} />;
  return <Clock size={13} style={{ color: "var(--kirana-muted-foreground)", flexShrink: 0 }} />;
}

function statusColor(status: string) {
  if (status === "completed") return "var(--kirana-success)";
  if (status === "failed") return "var(--kirana-destructive)";
  if (status === "running") return "var(--kirana-primary)";
  return "var(--kirana-muted-foreground)";
}

interface Evidence {
  evidenceId: string;
  taskId: string;
  source: string;
  retrievedAt: string;
  revision: number;
}

export default function ActivityPage() {
  const { state } = useStudio();
  const [archived, setArchived] = useState<TaskItem[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [tab, setTab] = useState<"tasks" | "evidence">("tasks");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const load = async (reset = false) => {
    setLoading(true);
    try {
      const newOffset = reset ? 0 : offset;
      const [historyRes, overviewRes] = await Promise.all([
        runtimeRequest<{ tasks: TaskItem[]; nextOffset: number }>("history", {
          offset: newOffset,
          limit: 50,
        }),
        runtimeRequest<{ evidence: Evidence[] }>("office-overview").catch(() => ({ evidence: [] })),
      ]);
      const tasks = historyRes.tasks ?? [];
      setArchived((prev) => (reset ? tasks : [...prev, ...tasks]));
      setHasMore(tasks.length === 50);
      setOffset(newOffset + tasks.length);
      setEvidence((overviewRes as { evidence?: Evidence[] }).evidence ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(true);
  }, []);

  const allTasks = [
    ...new Map([...archived, ...state.tasks].map((t) => [t.taskId, t])).values(),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const filtered = allTasks.filter((t) => {
    const matchQ =
      !query ||
      t.message.toLowerCase().includes(query.toLowerCase()) ||
      t.actorName?.toLowerCase().includes(query.toLowerCase());
    const matchS = filterStatus === "all" || t.status === filterStatus;
    return matchQ && matchS;
  });

  const statusCounts = allTasks.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

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
          <h1 style={s.title}>Activity & Audit Logs</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            {allTasks.length} tasks · {evidence.length} evidence records
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          style={{ ...s.btn(), color: "var(--kirana-foreground)" }}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          {
            label: "Completed",
            count: statusCounts["completed"] ?? 0,
            color: "var(--kirana-success)",
          },
          { label: "Running", count: statusCounts["running"] ?? 0, color: "var(--kirana-primary)" },
          {
            label: "Failed",
            count: statusCounts["failed"] ?? 0,
            color: "var(--kirana-destructive)",
          },
          {
            label: "Submitted",
            count: statusCounts["submitted"] ?? 0,
            color: "var(--kirana-muted-foreground)",
          },
        ].map(({ label, count, color }) => (
          <div
            key={label}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border: "1px solid var(--kirana-border)",
              background: "var(--kirana-card)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }}
            />
            <span style={{ fontSize: 12, color: "var(--kirana-muted-foreground)" }}>{label}</span>
            <span
              style={{
                fontFamily: "var(--font-display,system-ui)",
                fontWeight: 700,
                fontSize: 14,
                color,
              }}
            >
              {count}
            </span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 16,
          borderBottom: "1px solid var(--kirana-border)",
          paddingBottom: 0,
        }}
      >
        {(["tasks", "evidence"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              border: "none",
              background: "none",
              color: tab === t ? "var(--kirana-primary)" : "var(--kirana-muted-foreground)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: tab === t ? 700 : 400,
              borderBottom: tab === t ? "2px solid var(--kirana-primary)" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {t === "tasks" ? "Task History" : "Evidence Records"}
          </button>
        ))}
      </div>

      {tab === "tasks" && (
        <>
          {/* Search + filter */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
            <div style={{ position: "relative", flex: 1 }}>
              <Search
                size={13}
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--kirana-muted-foreground)",
                }}
              />
              <input
                type="text"
                placeholder="Search tasks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "7px 10px 7px 30px",
                  borderRadius: 8,
                  border: "1px solid var(--kirana-border)",
                  background: "var(--kirana-accent)",
                  color: "var(--kirana-foreground)",
                  fontSize: 13,
                  boxSizing: "border-box",
                }}
              />
            </div>
            {["all", "completed", "running", "failed", "submitted"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilterStatus(s)}
                style={
                  s === filterStatus
                    ? {
                        ...(s === "all"
                          ? {
                              padding: "6px 10px",
                              borderRadius: 8,
                              border: "1px solid var(--kirana-border)",
                              background: "var(--kirana-primary)",
                              color: "var(--kirana-primary-foreground)",
                              cursor: "pointer",
                              fontSize: 11,
                              fontWeight: 700,
                            }
                          : {
                              padding: "6px 10px",
                              borderRadius: 8,
                              border: "1px solid var(--kirana-border)",
                              background: "var(--kirana-primary)",
                              color: "var(--kirana-primary-foreground)",
                              cursor: "pointer",
                              fontSize: 11,
                              fontWeight: 700,
                            }),
                      }
                    : {
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--kirana-border)",
                        background: "var(--kirana-card)",
                        color: "var(--kirana-muted-foreground)",
                        cursor: "pointer",
                        fontSize: 11,
                      }
                }
              >
                {s}
              </button>
            ))}
          </div>

          {loading && filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40 }}>
              <Loader2
                size={24}
                style={{
                  animation: "spin 1s linear infinite",
                  color: "var(--kirana-primary)",
                  margin: "0 auto",
                }}
              />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ ...s.card, textAlign: "center", padding: 40 }}>
              <Activity
                size={32}
                style={{ color: "var(--kirana-muted-foreground)", margin: "0 auto 12px" }}
              />
              <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 14 }}>
                No tasks match your search.
              </p>
            </div>
          ) : (
            <div style={s.card}>
              {filtered.slice(0, 100).map((task, i) => (
                <div
                  key={task.taskId}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px 0",
                    borderBottom:
                      i < filtered.length - 1
                        ? "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)"
                        : "none",
                  }}
                >
                  {statusIcon(task.status)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        fontSize: 13,
                        color: "var(--kirana-foreground)",
                        fontWeight: 500,
                        margin: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.message}
                    </p>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginTop: 3,
                        fontSize: 11,
                        color: "var(--kirana-muted-foreground)",
                      }}
                    >
                      {task.actorName && <span>{task.actorName}</span>}
                      <span style={{ color: statusColor(task.status), fontWeight: 600 }}>
                        {task.status.replace(/_/g, " ")}
                      </span>
                      {task.error && (
                        <span style={{ color: "var(--kirana-destructive)" }}>
                          · {task.error.slice(0, 60)}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--kirana-muted-foreground)",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {new Date(task.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
              {hasMore && (
                <div style={{ textAlign: "center", paddingTop: 12 }}>
                  <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    style={{
                      padding: "7px 16px",
                      borderRadius: 8,
                      border: "1px solid var(--kirana-border)",
                      background: "var(--kirana-card)",
                      color: "var(--kirana-foreground)",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    Load more
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === "evidence" && (
        <div>
          {evidence.length === 0 ? (
            <div style={{ ...s.card, textAlign: "center", padding: 40 }}>
              <FileText
                size={32}
                style={{ color: "var(--kirana-muted-foreground)", margin: "0 auto 12px" }}
              />
              <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 14 }}>
                No evidence records yet. Run a workflow to generate evidence.
              </p>
            </div>
          ) : (
            <div style={s.card}>
              {evidence.map((ev, i) => (
                <div
                  key={ev.evidenceId}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px 0",
                    borderBottom:
                      i < evidence.length - 1
                        ? "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)"
                        : "none",
                    fontSize: 12,
                  }}
                >
                  <FileText
                    size={13}
                    style={{ color: "var(--kirana-primary)", flexShrink: 0, marginTop: 1 }}
                  />
                  <div style={{ flex: 1 }}>
                    <p
                      style={{
                        color: "var(--kirana-foreground)",
                        fontWeight: 500,
                        margin: 0,
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                    >
                      {ev.evidenceId.slice(0, 20)}…
                    </p>
                    <p style={{ color: "var(--kirana-muted-foreground)", margin: "2px 0 0" }}>
                      {ev.source}
                    </p>
                  </div>
                  <span
                    style={{ color: "var(--kirana-muted-foreground)", flexShrink: 0, fontSize: 10 }}
                  >
                    {new Date(ev.retrievedAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
