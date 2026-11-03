"use client";
import { useEffect, useState } from "react";
import { ShoppingCart, TrendingUp, Loader2, Play, RefreshCw } from "lucide-react";
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

interface SalesData {
  total?: number;
  count?: number;
  avg?: number;
  currency?: string;
  top_products?: Array<{ item_name: string; qty: number; revenue?: number }>;
  invoices?: Array<{
    name: string;
    customer?: string;
    total: number;
    status?: string;
    date?: string;
  }>;
}

export default function SalesPage() {
  const [data, setData] = useState<SalesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [wfStatus, setWfStatus] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dataSource, setDataSource] = useState("");

  const run = async () => {
    setLoading(true);
    setData(null);
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
            const res = d.workflow.result as Record<string, unknown>;
            setData({
              total: (res.sales as SalesData)?.total,
              count: (res.sales as SalesData)?.count,
              avg: (res.sales as SalesData)?.avg,
              currency: (res.sales as SalesData)?.currency,
              top_products: res.top_products as SalesData["top_products"],
            });
            setDataSource((res.source as string) ?? "fixture");
            toast.success("Sales data ready");
          } else {
            toast.error("Failed: " + (d.workflow.error ?? "unknown"));
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

  useEffect(() => {
    fetchNammaOps<{
      dashboard: { latest?: { daily_report?: WorkflowView }; data_source?: string };
    }>("/dashboard")
      .then((r) => {
        const wf = r.dashboard?.latest?.daily_report;
        if (wf?.status === "completed" && wf.result) {
          const res = wf.result as Record<string, unknown>;
          setData({
            total: (res.sales as SalesData)?.total,
            count: (res.sales as SalesData)?.count,
            avg: (res.sales as SalesData)?.avg,
            currency: (res.sales as SalesData)?.currency,
            top_products: res.top_products as SalesData["top_products"],
          });
          setDataSource(r.dashboard.data_source ?? "fixture");
          if (wf.intent?.date) setDate(wf.intent.date);
        }
      })
      .catch(() => {});
  }, []);

  const currency = data?.currency ?? "₹";

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
          <h1 style={s.title}>Sales & Billing</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            {data
              ? `Sales data for ${date} · ${dataSource.includes("erpnext") ? "ERPNext live" : "Fixture"}`
              : "Run a daily report to see sales data"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{
              padding: "7px 12px",
              borderRadius: 9,
              border: "1px solid var(--kirana-border)",
              background: "var(--kirana-card)",
              color: "var(--kirana-foreground)",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button type="button" onClick={() => void run()} disabled={loading} style={s.btn(true)}>
            {loading ? (
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Play size={13} />
            )}
            {loading ? wfStatus || "Running…" : "Load Sales"}
          </button>
        </div>
      </div>

      {!data && !loading && (
        <div style={{ ...s.card, textAlign: "center", padding: 60 }}>
          <ShoppingCart
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
            No sales data
          </p>
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 13, margin: "0 0 16px" }}>
            Carol (Sales Agent) reads from erp.sales_invoices.list and erp.pos_invoices.list. Run a
            daily report to load data.
          </p>
          <button type="button" onClick={() => void run()} style={s.btn(true)}>
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
            Carol (Sales Agent) is fetching sales data…
          </p>
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3,1fr)",
              gap: 14,
              marginBottom: 24,
            }}
          >
            {[
              {
                label: "Total Revenue",
                value: data.total != null ? `${currency}${data.total.toFixed(0)}` : "—",
                color: "var(--kirana-primary)",
              },
              { label: "Transactions", value: data.count ?? "—", color: "var(--kirana-success)" },
              {
                label: "Avg Transaction",
                value: data.avg != null ? `${currency}${data.avg.toFixed(0)}` : "—",
                color: "oklch(0.7 0.18 260)",
              },
            ].map(({ label, value, color }) => (
              <div key={label} style={s.card}>
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
                    fontSize: 28,
                    fontWeight: 800,
                    color,
                    margin: 0,
                  }}
                >
                  {value}
                </p>
              </div>
            ))}
          </div>

          {(data.top_products?.length ?? 0) > 0 && (
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
                <TrendingUp
                  size={15}
                  style={{
                    verticalAlign: "middle",
                    marginRight: 6,
                    color: "var(--kirana-primary)",
                  }}
                />
                Top Products
              </p>
              {data.top_products!.slice(0, 10).map((p, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    padding: "9px 0",
                    borderBottom:
                      "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)",
                    fontSize: 13,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-display,system-ui)",
                      fontSize: 15,
                      fontWeight: 800,
                      color: "var(--kirana-primary)",
                      width: 24,
                    }}
                  >
                    #{i + 1}
                  </span>
                  <span style={{ flex: 1, color: "var(--kirana-foreground)", fontWeight: 500 }}>
                    {p.item_name}
                  </span>
                  <span style={{ color: "var(--kirana-muted-foreground)" }}>{p.qty} sold</span>
                  {p.revenue != null && (
                    <span style={{ color: "var(--kirana-success)", fontWeight: 700 }}>
                      {currency}
                      {p.revenue.toFixed(0)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
