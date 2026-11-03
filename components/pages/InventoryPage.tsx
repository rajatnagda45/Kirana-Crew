"use client";
import { useEffect, useState } from "react";
import { Package, AlertCircle, RefreshCw, Loader2, TrendingDown, Search, Play } from "lucide-react";
import { fetchNammaOps, type WorkflowView } from "@/lib/hooks/useNammaOps";
import { toast } from "sonner";

interface StockItem {
  item_code?: string;
  item_name?: string;
  qty?: number;
  reorder_level?: number;
  uom?: string;
  category?: string;
  warehouse?: string;
}

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

function stockHealth(qty: number | undefined, reorder: number | undefined) {
  if (qty == null || reorder == null) return "unknown";
  if (qty === 0) return "out";
  if (qty <= reorder) return "low";
  if (qty <= reorder * 1.5) return "warn";
  return "ok";
}

function healthColor(h: string) {
  if (h === "out") return "var(--kirana-destructive)";
  if (h === "low") return "orange";
  if (h === "warn") return "oklch(0.75 0.12 80)";
  return "var(--kirana-success)";
}

export default function InventoryPage() {
  const [stock, setStock] = useState<StockItem[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowView | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "low" | "out">("all");

  const loadStock = async () => {
    setLoading(true);
    try {
      // Start stock_check workflow
      const r = await fetchNammaOps<{ workflow: WorkflowView }>("/workflows", {
        action: "stock_check",
      });
      const wfId = r.workflow.id;
      // Poll until completed or failed (max 30s)
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const detail = await fetchNammaOps<{ workflow: WorkflowView }>(
          `/workflows/${encodeURIComponent(wfId)}`,
        );
        if (["completed", "failed", "stopped"].includes(detail.workflow.status)) {
          setWorkflow(detail.workflow);
          const result = detail.workflow.result as Record<string, unknown> | undefined;
          const items =
            (result?.stock as StockItem[] | undefined) ??
            (result?.items as StockItem[] | undefined) ??
            [];
          setStock(items);
          if (detail.workflow.status === "failed")
            toast.error("Stock check failed: " + detail.workflow.error);
          break;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to check inventory");
    } finally {
      setLoading(false);
    }
  };

  // Try to load from dashboard first
  useEffect(() => {
    fetchNammaOps<{ dashboard: { latest?: { stock_check?: WorkflowView } } }>("/dashboard")
      .then((r) => {
        const wf = r.dashboard?.latest?.stock_check;
        if (wf?.status === "completed") {
          setWorkflow(wf);
          const result = wf.result as Record<string, unknown> | undefined;
          const items = (result?.stock as StockItem[] | undefined) ?? [];
          setStock(items);
        }
      })
      .catch(() => {});
  }, []);

  const filtered = stock.filter((item) => {
    const matchQuery =
      !query ||
      item.item_name?.toLowerCase().includes(query.toLowerCase()) ||
      item.item_code?.toLowerCase().includes(query.toLowerCase());
    const health = stockHealth(item.qty, item.reorder_level);
    const matchFilter =
      filter === "all" ||
      (filter === "low" && ["low", "warn"].includes(health)) ||
      (filter === "out" && health === "out");
    return matchQuery && matchFilter;
  });

  const lowCount = stock.filter((i) =>
    ["low", "out"].includes(stockHealth(i.qty, i.reorder_level)),
  ).length;
  const outCount = stock.filter((i) => stockHealth(i.qty, i.reorder_level) === "out").length;

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
          <h1 style={s.title}>Inventory</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            {workflow
              ? `Last checked: ${workflow.completedAt ? new Date(workflow.completedAt).toLocaleString() : "just now"} · Data source: ${workflow.result && (workflow.result as Record<string, unknown>).source === "erpnext_live" ? "ERPNext live" : "fixture"}`
              : "Run a stock check to see live data"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadStock()}
          disabled={loading}
          style={s.btn(true)}
        >
          {loading ? (
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
          ) : (
            <Play size={13} />
          )}
          {loading ? "Checking…" : "Run Stock Check"}
        </button>
      </div>

      {/* Summary cards */}
      {stock.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4,1fr)",
            gap: 14,
            marginBottom: 20,
          }}
        >
          {[
            { label: "Total Products", value: stock.length, color: "var(--kirana-primary)" },
            {
              label: "Adequate Stock",
              value: stock.filter((i) => stockHealth(i.qty, i.reorder_level) === "ok").length,
              color: "var(--kirana-success)",
            },
            { label: "Low / Warning", value: lowCount, color: "orange" },
            { label: "Out of Stock", value: outCount, color: "var(--kirana-destructive)" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ ...s.card, padding: 16 }}>
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
      )}

      {/* Search + filter */}
      {stock.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Search
              size={14}
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
              placeholder="Search products…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px 8px 32px",
                borderRadius: 9,
                border: "1px solid var(--kirana-border)",
                background: "var(--kirana-accent)",
                color: "var(--kirana-foreground)",
                fontSize: 13,
                boxSizing: "border-box",
              }}
            />
          </div>
          {(["all", "low", "out"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              style={{ ...s.btn(filter === f), padding: "7px 12px" }}
            >
              {f === "all" ? "All" : f === "low" ? "Low Stock" : "Out of Stock"}
            </button>
          ))}
        </div>
      )}

      {/* Stock table */}
      {loading && stock.length === 0 ? (
        <div style={{ ...s.card, textAlign: "center", padding: 60 }}>
          <Loader2
            size={28}
            style={{
              animation: "spin 1s linear infinite",
              color: "var(--kirana-primary)",
              margin: "0 auto 12px",
            }}
          />
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 14 }}>
            Inventory Agent is checking stock levels…
          </p>
        </div>
      ) : stock.length === 0 ? (
        <div style={{ ...s.card, textAlign: "center", padding: 60 }}>
          <Package
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
            No inventory data
          </p>
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 13, margin: "0 0 16px" }}>
            Run a stock check to load inventory data from the connected ERP system.
          </p>
          <button type="button" onClick={() => void loadStock()} style={s.btn(true)}>
            Run Stock Check
          </button>
        </div>
      ) : (
        <div style={s.card}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--kirana-border)" }}>
                  {[
                    "Product",
                    "Category",
                    "Warehouse",
                    "Stock",
                    "Reorder Level",
                    "Unit",
                    "Status",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 12px",
                        textAlign: "left",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--kirana-muted-foreground)",
                        textTransform: "uppercase",
                        letterSpacing: "0.4px",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((item, i) => {
                  const health = stockHealth(item.qty, item.reorder_level);
                  const color = healthColor(health);
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom:
                          "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)",
                      }}
                    >
                      <td
                        style={{
                          padding: "10px 12px",
                          color: "var(--kirana-foreground)",
                          fontWeight: 500,
                        }}
                      >
                        {item.item_name ?? item.item_code ?? "—"}
                        {item.item_code && item.item_name && (
                          <span
                            style={{
                              fontSize: 10,
                              color: "var(--kirana-muted-foreground)",
                              display: "block",
                            }}
                          >
                            {item.item_code}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "10px 12px", color: "var(--kirana-muted-foreground)" }}>
                        {item.category ?? "—"}
                      </td>
                      <td style={{ padding: "10px 12px", color: "var(--kirana-muted-foreground)" }}>
                        {item.warehouse ?? "—"}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          fontFamily: "var(--font-display,system-ui)",
                          fontWeight: 700,
                          color,
                        }}
                      >
                        {item.qty ?? "—"}
                      </td>
                      <td style={{ padding: "10px 12px", color: "var(--kirana-muted-foreground)" }}>
                        {item.reorder_level ?? "—"}
                      </td>
                      <td style={{ padding: "10px 12px", color: "var(--kirana-muted-foreground)" }}>
                        {item.uom ?? "—"}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "2px 8px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            background: `color-mix(in oklab,${color} 12%,transparent)`,
                            color,
                          }}
                        >
                          {health === "low" || health === "out" ? (
                            <AlertCircle size={10} />
                          ) : health === "warn" ? (
                            <TrendingDown size={10} />
                          ) : null}
                          {health === "ok"
                            ? "OK"
                            : health === "low"
                              ? "Low"
                              : health === "out"
                                ? "Out"
                                : "Warning"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p
                style={{
                  textAlign: "center",
                  padding: 24,
                  color: "var(--kirana-muted-foreground)",
                  fontSize: 13,
                }}
              >
                No products match your search.
              </p>
            )}
          </div>
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
