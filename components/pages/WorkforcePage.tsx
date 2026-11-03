"use client";
import { useEffect, useState } from "react";
import {
  Users,
  Bot,
  Activity,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  Loader2,
  ChevronRight,
  ChevronDown,
  Zap,
} from "lucide-react";
import { runtimeRequest, useStudio } from "@/lib/store";
import type { SeatState } from "@/types/game";

const AGENT_PROFILES: Record<
  string,
  { role: string; dept: string; color: string; desc: string; tools: string[] }
> = {
  alice: {
    role: "Manager",
    dept: "Management",
    color: "var(--kirana-primary)",
    desc: "Coordinates all store operations. Understands owner requests, delegates to specialists, and presents a unified answer.",
    tools: ["Orchestrate agents", "Summarize results", "Present approvals"],
  },
  bob: {
    role: "Inventory",
    dept: "Stock",
    color: "var(--kirana-success)",
    desc: "Monitors all product stock levels. Reads item details, balances, warehouses, and stock movements. Flags low-stock products.",
    tools: [
      "erp.items.list",
      "erp.stock.balance",
      "erp.warehouses.list",
      "erp.stock.ledger",
      "erp.stock.movements",
    ],
  },
  carol: {
    role: "Sales",
    dept: "Revenue",
    color: "oklch(0.7 0.18 260)",
    desc: "Analyses sales performance. Reads sales and POS invoices, customer records, and computes totals and top products.",
    tools: [
      "erp.sales_invoices.list",
      "erp.pos_invoices.list",
      "erp.customers.list",
      "erp.items.list",
      "erp.sales.history",
    ],
  },
  dave: {
    role: "Procurement",
    dept: "Purchasing",
    color: "oklch(0.65 0.18 310)",
    desc: "Manages supplier relationships and purchases. Compares quotations, calculates reorder quantities, and drafts purchase orders.",
    tools: [
      "erp.suppliers.list",
      "erp.supplier_quotations.list",
      "erp.item_prices.get",
      "erp.po.create_draft",
      "erp.po.get",
    ],
  },
  erin: {
    role: "Finance",
    dept: "Accounts",
    color: "oklch(0.7 0.15 30)",
    desc: "Produces financial summaries from posted accounting data. Reads P&L, general ledger, purchase invoices, and payment records.",
    tools: ["erp.pnl", "erp.gl", "erp.purchase_invoices.list", "erp.payments.summary"],
  },
  frank: {
    role: "Billing",
    dept: "Counter",
    color: "var(--kirana-muted-foreground)",
    desc: "Visual character at the billing counter. Not an independent backend agent — represented in the 3D store only.",
    tools: [],
  },
  grace: {
    role: "Reports",
    dept: "Analytics",
    color: "var(--kirana-muted-foreground)",
    desc: "Visual character in the store. Not an independent backend agent — represented in the 3D store only.",
    tools: [],
  },
};

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
    marginBottom: 14,
  },
  btn: (primary?: boolean) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 14px",
    borderRadius: 9,
    border: primary ? "none" : "1px solid var(--kirana-border)",
    background: primary ? "var(--kirana-primary)" : "var(--kirana-card)",
    color: primary ? "var(--kirana-primary-foreground)" : "var(--kirana-foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  }),
};

function AgentCard({ seat }: { seat: SeatState }) {
  const name = seat.label.toLowerCase();
  const profile = AGENT_PROFILES[name];
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<Array<{ message: string; status: string; createdAt: string }>>(
    [],
  );
  const [loadingTasks, setLoadingTasks] = useState(false);

  const isBackendAgent = profile && profile.tools.length > 0;
  const color = profile?.color ?? "var(--kirana-muted-foreground)";

  const loadTasks = async () => {
    if (tasks.length > 0) {
      setOpen((v) => !v);
      return;
    }
    setLoadingTasks(true);
    try {
      const { tasks: all } = await runtimeRequest<{
        tasks: Array<{ message: string; status: string; createdAt: string; seatId?: string }>;
      }>("tasks");
      setTasks(all.filter((t: { seatId?: string }) => t.seatId === seat.seatId).slice(0, 10));
      setOpen(true);
    } catch {
      /* ignore */
    } finally {
      setLoadingTasks(false);
    }
  };

  return (
    <div style={s.card}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 13,
            background: `color-mix(in oklab,${color} 18%,transparent)`,
            display: "grid",
            placeItems: "center",
            color,
            flexShrink: 0,
            border: `1px solid color-mix(in oklab,${color} 30%,transparent)`,
          }}
        >
          {isBackendAgent ? <Bot size={22} /> : <Users size={22} />}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <h3
              style={{
                fontFamily: "var(--font-display,system-ui)",
                fontSize: 17,
                fontWeight: 700,
                color: "var(--kirana-foreground)",
                margin: 0,
              }}
            >
              {seat.label}
            </h3>
            <span style={{ fontSize: 12, color, fontWeight: 600 }}>{profile?.role ?? "Agent"}</span>
            {!isBackendAgent && (
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 5,
                  background: "var(--kirana-accent)",
                  color: "var(--kirana-muted-foreground)",
                }}
              >
                Visual only
              </span>
            )}
          </div>
          <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            {profile?.desc ?? "Agent"}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 6,
                background: `color-mix(in oklab,${seat.status === "running" ? "var(--kirana-success)" : seat.status === "failed" ? "var(--kirana-destructive)" : "var(--kirana-muted-foreground)"} 12%,transparent)`,
                color:
                  seat.status === "running"
                    ? "var(--kirana-success)"
                    : seat.status === "failed"
                      ? "var(--kirana-destructive)"
                      : "var(--kirana-muted-foreground)",
                fontWeight: 600,
              }}
            >
              <span
                style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }}
              />
              {seat.assigned ? seat.status : "offline"}
            </span>
            <span style={{ fontSize: 11, color: "var(--kirana-muted-foreground)" }}>
              {profile?.dept}
            </span>
            {seat.roleTitle && (
              <span style={{ fontSize: 11, color: "var(--kirana-muted-foreground)" }}>
                · {seat.roleTitle}
              </span>
            )}
          </div>
        </div>
        {isBackendAgent && (
          <button
            type="button"
            onClick={() => void loadTasks()}
            style={{ ...s.btn(), padding: "5px 10px", fontSize: 12 }}
          >
            {loadingTasks ? (
              <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
            ) : open ? (
              <ChevronDown size={11} />
            ) : (
              <ChevronRight size={11} />
            )}
            Tasks
          </button>
        )}
      </div>

      {/* Tools */}
      {isBackendAgent && profile.tools.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--kirana-border)" }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--kirana-muted-foreground)",
              textTransform: "uppercase",
              margin: "0 0 6px",
            }}
          >
            ERP Capabilities
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {profile.tools.map((tool) => (
              <span
                key={tool}
                style={{
                  fontSize: 10,
                  padding: "2px 7px",
                  borderRadius: 5,
                  background: "var(--kirana-accent)",
                  color,
                  fontFamily: "monospace",
                }}
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Task history */}
      {open && isBackendAgent && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--kirana-border)" }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--kirana-muted-foreground)",
              textTransform: "uppercase",
              margin: "0 0 8px",
            }}
          >
            Recent Tasks
          </p>
          {tasks.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)" }}>
              No tasks recorded for this agent.
            </p>
          ) : (
            tasks.map((t, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 0",
                  borderBottom:
                    "1px solid color-mix(in oklab,var(--kirana-border) 40%,transparent)",
                  fontSize: 12,
                }}
              >
                {t.status === "completed" ? (
                  <CheckCircle
                    size={11}
                    style={{ color: "var(--kirana-success)", flexShrink: 0 }}
                  />
                ) : t.status === "failed" ? (
                  <XCircle
                    size={11}
                    style={{ color: "var(--kirana-destructive)", flexShrink: 0 }}
                  />
                ) : t.status === "running" ? (
                  <Activity size={11} style={{ color: "var(--kirana-primary)", flexShrink: 0 }} />
                ) : (
                  <Clock
                    size={11}
                    style={{ color: "var(--kirana-muted-foreground)", flexShrink: 0 }}
                  />
                )}
                <span
                  style={{
                    flex: 1,
                    color: "var(--kirana-foreground)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.message}
                </span>
                <span
                  style={{ flexShrink: 0, fontSize: 10, color: "var(--kirana-muted-foreground)" }}
                >
                  {new Date(t.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function WorkforcePage() {
  const { state } = useStudio();
  const [overview, setOverview] = useState<{
    specialists?: Array<{
      id: string;
      role?: string;
      executionStatus: string;
      lifecycle: string;
      tools: string[];
    }>;
  } | null>(null);

  useEffect(() => {
    runtimeRequest<typeof overview>("office-overview")
      .then(setOverview)
      .catch(() => {});
  }, []);

  const assignedSeats = state.seats.filter((s) => s.assigned);
  const workingSeats = assignedSeats.filter((s) => s.status === "running");
  const failedSeats = assignedSeats.filter((s) => s.status === "failed");

  return (
    <div style={s.page}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={s.title}>AI Workforce</h1>
        <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
          {assignedSeats.length} agents assigned · {workingSeats.length} working ·{" "}
          {failedSeats.length} failed
        </p>
      </div>

      {/* Summary */}
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}
      >
        {[
          { label: "Total Agents", value: assignedSeats.length, color: "var(--kirana-primary)" },
          { label: "Working", value: workingSeats.length, color: "var(--kirana-success)" },
          {
            label: "Available",
            value: assignedSeats.filter((s) => s.status !== "running" && s.status !== "failed")
              .length,
            color: "var(--kirana-muted-foreground)",
          },
          {
            label: "Failed",
            value: failedSeats.length,
            color:
              failedSeats.length > 0
                ? "var(--kirana-destructive)"
                : "var(--kirana-muted-foreground)",
          },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ ...s.card, padding: 16, marginBottom: 0 }}>
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

      {/* Architecture note */}
      <div
        style={{
          ...s.card,
          background: "color-mix(in oklab,var(--kirana-primary) 5%,var(--kirana-card))",
          borderColor: "color-mix(in oklab,var(--kirana-primary) 20%,transparent)",
          marginBottom: 24,
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Zap size={16} style={{ color: "var(--kirana-primary)", marginTop: 2, flexShrink: 0 }} />
          <div>
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--kirana-primary)",
                margin: "0 0 3px",
              }}
            >
              5 Active Backend Agents · Alice, Bob, Carol, Dave, Erin
            </p>
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
              These agents have real ERP capabilities — they read your actual inventory, sales, and
              financial records through governed MCP tools. Frank and Grace are visual characters in
              the 3D store; they do not have independent agent backends.
            </p>
          </div>
        </div>
      </div>

      {/* Agent cards */}
      {assignedSeats.length === 0 ? (
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
            No agents assigned
          </p>
          <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 13 }}>
            Run NammaOps setup to configure your AI workforce.
          </p>
        </div>
      ) : (
        <div>
          {assignedSeats.map((seat) => (
            <AgentCard key={seat.seatId} seat={seat} />
          ))}
        </div>
      )}

      {/* Unassigned seats */}
      {state.seats.filter((s) => !s.assigned).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p
            style={{
              fontFamily: "var(--font-display,system-ui)",
              fontSize: 14,
              fontWeight: 700,
              color: "var(--kirana-muted-foreground)",
              margin: "0 0 10px",
            }}
          >
            Unassigned Seats
          </p>
          {state.seats
            .filter((s) => !s.assigned)
            .map((seat) => (
              <div key={seat.seatId} style={{ ...s.card, opacity: 0.6, padding: 14 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <Bot size={18} style={{ color: "var(--kirana-muted-foreground)" }} />
                  <span
                    style={{
                      fontSize: 14,
                      color: "var(--kirana-muted-foreground)",
                      fontWeight: 500,
                    }}
                  >
                    {seat.label}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--kirana-muted-foreground)" }}>
                    — unassigned
                  </span>
                </div>
              </div>
            ))}
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
