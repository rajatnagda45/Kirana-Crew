"use client";
import { useEffect, useState } from "react";
import { BarChart3, TrendingUp, Loader2, RefreshCw } from "lucide-react";
import { fetchNammaOps, type WorkflowView } from "@/lib/hooks/useNammaOps";

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
};

interface StockItem {
  item_name: string;
  qty: number;
  reorder_level?: number;
  uom?: string;
}
interface SalesItem {
  item_name: string;
  qty: number;
  revenue?: number;
}

export default function AnalyticsPage() {
  const [stock, setStock] = useState<StockItem[]>([]);
  const [topSales, setTopSales] = useState<SalesItem[]>([]);
  const [loadingStock, setLoadingStock] = useState(false);
  const [loadingSales, setLoadingSales] = useState(false);
  const [dataSource, setDataSource] = useState("");

  const loadAll = async () => {
    setLoadingStock(true);
    setLoadingSales(true);

    // Load from dashboard first
    fetchNammaOps<{
      dashboard: {
        latest?: { stock_check?: WorkflowView; daily_report?: WorkflowView };
        data_source?: string;
      };
    }>("/dashboard")
      .then((r) => {
        const d = r.dashboard;
        if (d.data_source) setDataSource(d.data_source);
        const sc = d.latest?.stock_check;
        if (sc?.status === "completed" && sc.result) {
          const items = (sc.result as Record<string, unknown>).items as StockItem[] | undefined;
          if (items?.length) {
            setStock(items);
            setLoadingStock(false);
          }
        }
        const dr = d.latest?.daily_report;
        if (dr?.status === "completed" && dr.result) {
          const tp = (dr.result as Record<string, unknown>).top_products as SalesItem[] | undefined;
          if (tp?.length) {
            setTopSales(tp);
            setLoadingSales(false);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        setLoadingStock(false);
        setLoadingSales(false);
      });
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, []);

  // Compute bar chart widths from stock levels
  const maxQty = Math.max(...stock.map((i) => i.qty), 1);
  const lowStock = stock.filter((i) => i.qty < (i.reorder_level ?? 10));
  const outOfStock = stock.filter((i) => i.qty === 0);
  const adequate = stock.filter((i) => i.qty >= (i.reorder_level ?? 10));

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
          <h1 style={s.title}>Analytics & Reports</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            Charts derived from NammaOps workflow results ·{" "}
            {dataSource.includes("erpnext") ? "ERPNext live" : "Fixture data"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadAll()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 14px",
            borderRadius: 9,
            border: "1px solid var(--kirana-border)",
            background: "var(--kirana-card)",
            color: "var(--kirana-foreground)",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Summary KPIs */}
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}
      >
        {[
          { label: "Total Products", value: stock.length || "—", color: "var(--kirana-primary)" },
          {
            label: "Adequate Stock",
            value: adequate.length || "—",
            color: "var(--kirana-success)",
          },
          { label: "Low / Warning", value: lowStock.length || "—", color: "orange" },
          {
            label: "Out of Stock",
            value: outOfStock.length || "—",
            color: "var(--kirana-destructive)",
          },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ ...s.card, marginBottom: 0 }}>
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Inventory bar chart */}
        <div style={s.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <BarChart3 size={16} style={{ color: "var(--kirana-primary)" }} />
            <p
              style={{
                fontFamily: "var(--font-display,system-ui)",
                fontSize: 15,
                fontWeight: 700,
                color: "var(--kirana-foreground)",
                margin: 0,
              }}
            >
              Inventory Levels
            </p>
            {loadingStock && (
              <Loader2
                size={13}
                style={{
                  animation: "spin 1s linear infinite",
                  color: "var(--kirana-primary)",
                  marginLeft: "auto",
                }}
              />
            )}
          </div>
          {stock.length === 0 && !loadingStock ? (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <BarChart3
                size={28}
                style={{ color: "var(--kirana-muted-foreground)", margin: "0 auto 8px" }}
              />
              <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
                Run stock_check workflow to load inventory data.
              </p>
            </div>
          ) : (
            <div>
              {stock.slice(0, 15).map((item) => {
                const pct = Math.round((item.qty / maxQty) * 100);
                const isLow = item.qty < (item.reorder_level ?? 10);
                const isOut = item.qty === 0;
                const barColor = isOut
                  ? "var(--kirana-destructive)"
                  : isLow
                    ? "orange"
                    : "var(--kirana-success)";
                return (
                  <div key={item.item_name} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 11,
                        marginBottom: 3,
                      }}
                    >
                      <span
                        style={{
                          color: "var(--kirana-foreground)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "65%",
                        }}
                      >
                        {item.item_name}
                      </span>
                      <span style={{ color: barColor, fontWeight: 600, flexShrink: 0 }}>
                        {item.qty} {item.uom ?? ""}
                      </span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 3,
                        background: "var(--kirana-accent)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          borderRadius: 3,
                          background: barColor,
                          width: `${Math.max(pct, 2)}%`,
                          transition: "width 0.4s ease",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
              {stock.length > 15 && (
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--kirana-muted-foreground)",
                    margin: "8px 0 0",
                  }}
                >
                  +{stock.length - 15} more items · Go to Inventory for full view
                </p>
              )}
            </div>
          )}
        </div>

        {/* Top sales chart */}
        <div style={s.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <TrendingUp size={16} style={{ color: "var(--kirana-primary)" }} />
            <p
              style={{
                fontFamily: "var(--font-display,system-ui)",
                fontSize: 15,
                fontWeight: 700,
                color: "var(--kirana-foreground)",
                margin: 0,
              }}
            >
              Top Selling Products
            </p>
            {loadingSales && (
              <Loader2
                size={13}
                style={{
                  animation: "spin 1s linear infinite",
                  color: "var(--kirana-primary)",
                  marginLeft: "auto",
                }}
              />
            )}
          </div>
          {topSales.length === 0 && !loadingSales ? (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <TrendingUp
                size={28}
                style={{ color: "var(--kirana-muted-foreground)", margin: "0 auto 8px" }}
              />
              <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
                Run daily_report workflow on the Finance page to load sales data.
              </p>
            </div>
          ) : (
            <div>
              {(() => {
                const maxRev = Math.max(...topSales.map((i) => i.revenue ?? i.qty), 1);
                return topSales.slice(0, 10).map((item, idx) => {
                  const val = item.revenue ?? item.qty;
                  const pct = Math.round((val / maxRev) * 100);
                  return (
                    <div key={item.item_name} style={{ marginBottom: 8 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 11,
                          marginBottom: 3,
                        }}
                      >
                        <span
                          style={{
                            color: "var(--kirana-foreground)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: "65%",
                          }}
                        >
                          <span
                            style={{
                              fontFamily: "var(--font-display,system-ui)",
                              fontWeight: 800,
                              color: "var(--kirana-primary)",
                              marginRight: 5,
                            }}
                          >
                            #{idx + 1}
                          </span>
                          {item.item_name}
                        </span>
                        <span
                          style={{ color: "var(--kirana-success)", fontWeight: 600, flexShrink: 0 }}
                        >
                          {item.revenue != null
                            ? `₹${item.revenue.toFixed(0)}`
                            : `${item.qty} sold`}
                        </span>
                      </div>
                      <div
                        style={{
                          height: 6,
                          borderRadius: 3,
                          background: "var(--kirana-accent)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            borderRadius: 3,
                            background: `color-mix(in oklab,var(--kirana-primary) ${40 + Math.round((1 - idx / 10) * 60)}%,var(--kirana-success))`,
                            width: `${Math.max(pct, 2)}%`,
                            transition: "width 0.4s ease",
                          }}
                        />
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Data health note */}
      <div
        style={{
          ...s.card,
          background: "color-mix(in oklab,var(--kirana-primary) 5%,var(--kirana-card))",
          borderColor: "color-mix(in oklab,var(--kirana-primary) 20%,transparent)",
        }}
      >
        <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
          <strong style={{ color: "var(--kirana-primary)" }}>How this works:</strong> Analytics are
          derived from live workflow results, not static data. Run &quot;Stock Check&quot; in
          Workflows to refresh inventory charts. Run &quot;Daily Report&quot; in Finance to refresh
          sales charts. Data source: {dataSource || "fixture (synthetic)"}
        </p>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
