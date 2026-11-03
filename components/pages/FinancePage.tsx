"use client";
import { useEffect, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  BarChart3,
  Loader2,
  Play,
  RefreshCw,
  Calendar,
} from "lucide-react";
import { fetchNammaOps, type WorkflowView } from "@/lib/hooks/useNammaOps";
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
  btn: (primary?: boolean) => ({
    display: "inline-flex",
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

interface ReportResult {
  sales?: { total?: number; count?: number; avg?: number; currency?: string };
  top_products?: Array<{ item_name: string; qty: number; revenue?: number }>;
  pnl?: { income?: number; expense?: number; profit?: number; currency?: string };
  purchase_invoices?: Array<{ supplier?: string; total?: number; status?: string }>;
  payments?: { total_paid?: number; total_outstanding?: number; currency?: string };
}

export default function FinancePage() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<ReportResult | null>(null);
  const [wfStatus, setWfStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [dataSource, setDataSource] = useState<string>("");

  const runReport = async () => {
    setLoading(true);
    setReport(null);
    setWfStatus("");
    try {
      const r = await fetchNammaOps<{ workflow: WorkflowView }>("/workflows", {
        action: "daily_report",
        date,
      });
      const id = r.workflow.id;
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const d = await fetchNammaOps<{ workflow: WorkflowView }>(
          `/workflows/${encodeURIComponent(id)}`,
        );
        setWfStatus(d.workflow.status);
        if (["completed", "failed", "stopped"].includes(d.workflow.status)) {
          if (d.workflow.status === "completed") {
            const res = d.workflow.result as ReportResult | undefined;
            setReport(res ?? null);
            setDataSource(
              ((d.workflow.result as Record<string, unknown>)?.source as string) ?? "fixture",
            );
            toast.success("Daily report ready");
          } else {
            toast.error("Report failed: " + (d.workflow.error ?? "unknown error"));
          }
          break;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  // Load from dashboard on mount
  useEffect(() => {
    fetchNammaOps<{ dashboard: { latest?: { daily_report?: WorkflowView } } }>("/dashboard")
      .then((r) => {
        const wf = r.dashboard?.latest?.daily_report;
        if (wf?.status === "completed" && wf.result) {
          setReport(wf.result as ReportResult);
          setDataSource(((wf.result as Record<string, unknown>)?.source as string) ?? "fixture");
          if (wf.intent?.date) setDate(wf.intent.date);
        }
      })
      .catch(() => {});
  }, []);

  const currency = report?.sales?.currency ?? report?.pnl?.currency ?? "₹";
  const profit = report?.pnl?.profit;
  const profitColor =
    profit == null
      ? "var(--kirana-muted-foreground)"
      : profit >= 0
        ? "var(--kirana-success)"
        : "var(--kirana-destructive)";

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
          <h1 style={s.title}>Finance</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            {report
              ? `Report for ${date} · Source: ${dataSource === "erpnext_live" ? "ERPNext live" : "fixture (synthetic)"}`
              : "Generate a daily report to see financial data"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              borderRadius: 9,
              border: "1px solid var(--kirana-border)",
              background: "var(--kirana-card)",
            }}
          >
            <Calendar size={13} style={{ color: "var(--kirana-muted-foreground)" }} />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{
                background: "none",
                border: "none",
                color: "var(--kirana-foreground)",
                fontSize: 13,
                outline: "none",
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => void runReport()}
            disabled={loading}
            style={s.btn(true)}
          >
            {loading ? (
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Play size={13} />
            )}
            {loading ? (wfStatus ? wfStatus.replace(/_/g, " ") : "Running…") : "Run Daily Report"}
          </button>
        </div>
      </div>

      {!report && !loading && (
        <div style={{ ...s.card, textAlign: "center", padding: 60 }}>
          <BarChart3
            size={36}
            style={{ color: "var(--kirana-muted-foreground)", margin: "0 auto 12px" }}
          />
          <p
            style={{
              color: "var(--kirana-foreground)",
              fontSize: 15,
              fontWeight: 600,
              margin: "0 0 6px",
            }}
          >
            No financial data
          </p>
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 13, margin: "0 0 16px" }}>
            Run the daily report for {date} to load sales, P&L, and payment data from the connected
            ERP system.
          </p>
          <button type="button" onClick={() => void runReport()} style={s.btn(true)}>
            Run Daily Report
          </button>
        </div>
      )}

      {loading && (
        <div style={{ ...s.card, textAlign: "center", padding: 40 }}>
          <Loader2
            size={28}
            style={{
              animation: "spin 1s linear infinite",
              color: "var(--kirana-primary)",
              margin: "0 auto 12px",
            }}
          />
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 14 }}>
            Finance & Sales Agents are compiling your report…
          </p>
          {wfStatus && (
            <p style={{ fontSize: 12, color: "var(--kirana-primary)", margin: "4px 0 0" }}>
              {wfStatus.replace(/_/g, " ")}
            </p>
          )}
        </div>
      )}

      {report && (
        <>
          {/* KPI row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4,1fr)",
              gap: 14,
              marginBottom: 20,
            }}
          >
            {[
              {
                label: "Total Revenue",
                value:
                  report.sales?.total != null ? `${currency}${report.sales.total.toFixed(0)}` : "—",
                sub: `${report.sales?.count ?? 0} transactions`,
                color: "var(--kirana-primary)",
                icon: TrendingUp,
              },
              {
                label: "Avg Transaction",
                value:
                  report.sales?.avg != null ? `${currency}${report.sales.avg.toFixed(0)}` : "—",
                sub: "Per invoice",
                color: "var(--kirana-success)",
                icon: BarChart3,
              },
              {
                label: "Gross Profit",
                value: profit != null ? `${currency}${Math.abs(profit).toFixed(0)}` : "—",
                sub: profit != null ? (profit >= 0 ? "Profit" : "Loss") : "Unavailable",
                color: profitColor,
                icon: profit != null && profit >= 0 ? TrendingUp : TrendingDown,
              },
              {
                label: "Expenses",
                value:
                  report.pnl?.expense != null ? `${currency}${report.pnl.expense.toFixed(0)}` : "—",
                sub: "Total outgoings",
                color: "var(--kirana-destructive)",
                icon: TrendingDown,
              },
            ].map(({ label, value, sub, color, icon: Icon }) => (
              <div key={label} style={s.card}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 9,
                    background: `color-mix(in oklab,${color} 15%,transparent)`,
                    display: "grid",
                    placeItems: "center",
                    color,
                    marginBottom: 10,
                  }}
                >
                  <Icon size={16} />
                </div>
                <p
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--kirana-muted-foreground)",
                    textTransform: "uppercase",
                    margin: "0 0 6px",
                  }}
                >
                  {label}
                </p>
                <p
                  style={{
                    fontFamily: "var(--font-display,system-ui)",
                    fontSize: 26,
                    fontWeight: 800,
                    color,
                    margin: 0,
                  }}
                >
                  {value}
                </p>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--kirana-muted-foreground)",
                    margin: "4px 0 0",
                  }}
                >
                  {sub}
                </p>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Top products */}
            {(report.top_products?.length ?? 0) > 0 && (
              <div style={s.card}>
                <p
                  style={{
                    fontFamily: "var(--font-display,system-ui)",
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--kirana-foreground)",
                    margin: "0 0 14px",
                  }}
                >
                  Top Products
                </p>
                {report.top_products!.slice(0, 8).map((p, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "7px 0",
                      borderBottom:
                        "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)",
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-display,system-ui)",
                        fontSize: 14,
                        fontWeight: 800,
                        color: "var(--kirana-primary)",
                        width: 20,
                      }}
                    >
                      #{i + 1}
                    </span>
                    <span style={{ flex: 1, color: "var(--kirana-foreground)", fontWeight: 500 }}>
                      {p.item_name}
                    </span>
                    <span style={{ color: "var(--kirana-muted-foreground)" }}>Qty: {p.qty}</span>
                    {p.revenue != null && (
                      <span style={{ color: "var(--kirana-success)", fontWeight: 600 }}>
                        {currency}
                        {p.revenue.toFixed(0)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* P&L summary */}
            <div style={s.card}>
              <p
                style={{
                  fontFamily: "var(--font-display,system-ui)",
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--kirana-foreground)",
                  margin: "0 0 14px",
                }}
              >
                Profit & Loss Summary
              </p>
              {report.pnl ? (
                <div>
                  {[
                    { label: "Income", value: report.pnl.income, color: "var(--kirana-success)" },
                    {
                      label: "Expenses",
                      value: report.pnl.expense,
                      color: "var(--kirana-destructive)",
                    },
                    {
                      label: "Net Profit / Loss",
                      value: report.pnl.profit,
                      color: profitColor,
                      bold: true,
                    },
                  ].map(({ label, value, color, bold }) => (
                    <div
                      key={label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "8px 0",
                        borderBottom:
                          "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)",
                        fontSize: 13,
                      }}
                    >
                      <span
                        style={{ color: "var(--kirana-foreground)", fontWeight: bold ? 700 : 400 }}
                      >
                        {label}
                      </span>
                      <span style={{ color, fontWeight: bold ? 800 : 600 }}>
                        {value != null ? `${currency}${Math.abs(value).toFixed(0)}` : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 13 }}>
                  P&L data unavailable from the report.
                </p>
              )}

              {report.payments && (
                <div style={{ marginTop: 16 }}>
                  <p
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "var(--kirana-muted-foreground)",
                      textTransform: "uppercase",
                      margin: "0 0 8px",
                    }}
                  >
                    Payments
                  </p>
                  <div style={{ display: "flex", gap: 12 }}>
                    {report.payments.total_paid != null && (
                      <div
                        style={{
                          flex: 1,
                          padding: "8px 12px",
                          borderRadius: 8,
                          background: "color-mix(in oklab,var(--kirana-success) 8%,transparent)",
                          border:
                            "1px solid color-mix(in oklab,var(--kirana-success) 20%,transparent)",
                          fontSize: 12,
                        }}
                      >
                        <p style={{ color: "var(--kirana-muted-foreground)", margin: "0 0 2px" }}>
                          Total Paid
                        </p>
                        <p style={{ color: "var(--kirana-success)", fontWeight: 700, margin: 0 }}>
                          {currency}
                          {report.payments.total_paid.toFixed(0)}
                        </p>
                      </div>
                    )}
                    {report.payments.total_outstanding != null && (
                      <div
                        style={{
                          flex: 1,
                          padding: "8px 12px",
                          borderRadius: 8,
                          background: "color-mix(in oklab,orange 8%,transparent)",
                          border: "1px solid color-mix(in oklab,orange 20%,transparent)",
                          fontSize: 12,
                        }}
                      >
                        <p style={{ color: "var(--kirana-muted-foreground)", margin: "0 0 2px" }}>
                          Outstanding
                        </p>
                        <p style={{ color: "orange", fontWeight: 700, margin: 0 }}>
                          {currency}
                          {report.payments.total_outstanding.toFixed(0)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              ...s.card,
              background: "color-mix(in oklab,var(--kirana-primary) 5%,var(--kirana-card))",
              borderColor: "color-mix(in oklab,var(--kirana-primary) 20%,transparent)",
            }}
          >
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
              <strong style={{ color: "var(--kirana-primary)" }}>Data source:</strong>{" "}
              {dataSource === "erpnext_live"
                ? "Live ERPNext data"
                : "Fixture synthetic data (not real business records). Connect your ERPNext instance to see real financial data."}
            </p>
          </div>
        </>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
