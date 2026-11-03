"use client";
import { useEffect, useState } from "react";
import { Users, Loader2, RefreshCw, Search, AlertCircle } from "lucide-react";

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

interface Customer {
  name: string;
  customer_name?: string;
  customer_group?: string;
  customer_type?: string;
  mobile_no?: string;
  email_id?: string;
  territory?: string;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/erp/customers");
      const data = (await res.json()) as { customers?: Customer[]; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `Server error ${res.status}`);
      } else {
        setCustomers(data.customers ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  const filtered = customers.filter((c) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.customer_name ?? "").toLowerCase().includes(q) ||
      (c.customer_group ?? "").toLowerCase().includes(q) ||
      (c.mobile_no ?? "").includes(q)
    );
  });

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
          <h1 style={s.title}>Customers</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            {customers.length > 0
              ? `${customers.length} customers · ERPNext live`
              : "Customer records from ERPNext"}
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} style={s.btn()}>
          {loading ? (
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
          ) : (
            <RefreshCw size={13} />
          )}
          Refresh
        </button>
      </div>

      {error && (
        <div
          style={{
            ...s.card,
            borderColor: "color-mix(in oklab,var(--kirana-destructive) 40%,transparent)",
            background: "color-mix(in oklab,var(--kirana-destructive) 6%,var(--kirana-card))",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <AlertCircle
            size={16}
            style={{ color: "var(--kirana-destructive)", flexShrink: 0, marginTop: 2 }}
          />
          <div>
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--kirana-destructive)",
                margin: "0 0 3px",
              }}
            >
              Could not load customers
            </p>
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
              {error}
            </p>
          </div>
        </div>
      )}

      {loading && customers.length === 0 && (
        <div style={{ ...s.card, textAlign: "center", padding: 48 }}>
          <Loader2
            size={28}
            style={{
              animation: "spin 1s linear infinite",
              color: "var(--kirana-primary)",
              margin: "0 auto 12px",
            }}
          />
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 14 }}>
            Loading customers from ERPNext…
          </p>
        </div>
      )}

      {!loading && !error && customers.length === 0 && (
        <div style={{ ...s.card, textAlign: "center", padding: 60 }}>
          <Users
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
            No customers found
          </p>
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 13, margin: "0 0 16px" }}>
            No customer records in ERPNext, or credentials are not configured.
          </p>
          <button type="button" onClick={() => void load()} style={s.btn(true)}>
            Try again
          </button>
        </div>
      )}

      {customers.length > 0 && (
        <>
          {/* Summary */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3,1fr)",
              gap: 14,
              marginBottom: 20,
            }}
          >
            {[
              { label: "Total Customers", value: customers.length, color: "var(--kirana-primary)" },
              {
                label: "Individual",
                value:
                  customers.filter((c) => c.customer_type === "Individual").length ||
                  customers.length,
                color: "var(--kirana-success)",
              },
              {
                label: "With Mobile",
                value: customers.filter((c) => c.mobile_no).length,
                color: "oklch(0.7 0.15 30)",
              },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ ...s.card, marginBottom: 0, padding: 16 }}>
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
              </div>
            ))}
          </div>

          {/* Search */}
          <div style={{ position: "relative", marginBottom: 16 }}>
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
              placeholder="Search by name, group, mobile…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px 8px 30px",
                borderRadius: 8,
                border: "1px solid var(--kirana-border)",
                background: "var(--kirana-accent)",
                color: "var(--kirana-foreground)",
                fontSize: 13,
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>

          {/* Table */}
          <div style={s.card}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--kirana-border)" }}>
                  {["Customer", "Group", "Type", "Mobile", "Territory"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "6px 12px",
                        textAlign: "left",
                        fontSize: 10,
                        fontWeight: 700,
                        color: "var(--kirana-muted-foreground)",
                        textTransform: "uppercase",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 100).map((c, i) => (
                  <tr
                    key={c.name}
                    style={{
                      borderBottom:
                        "1px solid color-mix(in oklab,var(--kirana-border) 40%,transparent)",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "var(--kirana-accent)")
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "9px 12px" }}>
                      <p style={{ color: "var(--kirana-foreground)", fontWeight: 600, margin: 0 }}>
                        {c.customer_name ?? c.name}
                      </p>
                      <p
                        style={{
                          color: "var(--kirana-muted-foreground)",
                          fontSize: 11,
                          margin: 0,
                          fontFamily: "monospace",
                        }}
                      >
                        {c.name}
                      </p>
                    </td>
                    <td style={{ padding: "9px 12px", color: "var(--kirana-muted-foreground)" }}>
                      {c.customer_group ?? "—"}
                    </td>
                    <td style={{ padding: "9px 12px" }}>
                      {c.customer_type && (
                        <span
                          style={{
                            fontSize: 11,
                            padding: "2px 7px",
                            borderRadius: 5,
                            background: "var(--kirana-accent)",
                            color: "var(--kirana-foreground)",
                          }}
                        >
                          {c.customer_type}
                        </span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "9px 12px",
                        color: "var(--kirana-muted-foreground)",
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      {c.mobile_no ?? "—"}
                    </td>
                    <td style={{ padding: "9px 12px", color: "var(--kirana-muted-foreground)" }}>
                      {c.territory ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 100 && (
              <p
                style={{
                  fontSize: 11,
                  color: "var(--kirana-muted-foreground)",
                  margin: "10px 0 0",
                  textAlign: "center",
                }}
              >
                Showing 100 of {filtered.length} customers
              </p>
            )}
            {filtered.length === 0 && query && (
              <p
                style={{
                  fontSize: 13,
                  color: "var(--kirana-muted-foreground)",
                  margin: "16px 0",
                  textAlign: "center",
                }}
              >
                No customers match &quot;{query}&quot;
              </p>
            )}
          </div>
        </>
      )}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
