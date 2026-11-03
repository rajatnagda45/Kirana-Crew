"use client";
import { useEffect, useState } from "react";
import {
  ShoppingCart,
  Users,
  Loader2,
  Play,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { fetchNammaOps, type WorkflowView, useNammaOpsApprovals } from "@/lib/hooks/useNammaOps";
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
  sectionTitle: {
    fontFamily: "var(--font-display,system-ui)",
    fontSize: 17,
    fontWeight: 700,
    color: "var(--kirana-foreground)",
    margin: "0 0 14px",
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

type RunState = {
  id: string;
  status: string;
  result?: Record<string, unknown>;
  error?: string;
} | null;

function WorkflowRunner({
  action,
  icon: Icon,
  label,
  desc,
  argDef,
  color,
}: {
  action: string;
  icon: typeof ShoppingCart;
  label: string;
  desc: string;
  argDef?: { key: string; placeholder: string };
  color: string;
}) {
  const [argVal, setArgVal] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunState>(null);
  const [open, setOpen] = useState(false);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const payload: Record<string, unknown> = { action };
      if (argDef && argVal) {
        payload[argDef.key] =
          argDef.key === "products"
            ? argVal
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : argVal;
      }
      const r = await fetchNammaOps<{ workflow: WorkflowView }>("/workflows", payload);
      const wfId = r.workflow.id;
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const d = await fetchNammaOps<{ workflow: WorkflowView }>(
          `/workflows/${encodeURIComponent(wfId)}`,
        );
        if (["completed", "failed", "stopped", "interrupted"].includes(d.workflow.status)) {
          const res_ = d.workflow.result as Record<string, unknown> | undefined;
          setResult({ id: wfId, status: d.workflow.status, result: res_, error: d.workflow.error });
          setOpen(true);
          if (d.workflow.status === "failed") toast.error(`${label} failed`);
          else toast.success(`${label} completed`);
          break;
        }
        if (i === 59) {
          setResult({ id: wfId, status: "timeout", error: "Workflow timed out" });
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={s.card}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
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
          <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: "3px 0 0" }}>
            {desc}
          </p>
        </div>
      </div>
      {argDef && (
        <input
          type="text"
          placeholder={argDef.placeholder}
          value={argVal}
          onChange={(e) => setArgVal(e.target.value)}
          style={{
            display: "block",
            width: "100%",
            padding: "7px 10px",
            borderRadius: 7,
            border: "1px solid var(--kirana-border)",
            background: "var(--kirana-accent)",
            color: "var(--kirana-foreground)",
            fontSize: 13,
            marginBottom: 10,
            boxSizing: "border-box",
          }}
        />
      )}
      <button
        type="button"
        onClick={() => void run()}
        disabled={loading}
        style={{ ...s.btn(true), width: "100%", justifyContent: "center" }}
      >
        {loading ? (
          <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
        ) : (
          <Play size={13} />
        )}
        {loading ? "Running…" : `Run ${label}`}
      </button>

      {result && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: "none",
              border: "none",
              color: "var(--kirana-primary)",
              cursor: "pointer",
              fontSize: 12,
              padding: 0,
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {result.status === "completed" ? "View result" : `Status: ${result.status}`}
          </button>
          {open && (
            <div style={{ marginTop: 8 }}>
              {result.status === "completed" && result.result ? (
                <ResultDisplay action={action} result={result.result} />
              ) : (
                <p style={{ fontSize: 12, color: "var(--kirana-destructive)", margin: 0 }}>
                  {result.error ?? result.status}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultDisplay({ action, result }: { action: string; result: Record<string, unknown> }) {
  if (action === "supplier_comparison") {
    const suppliers = result.suppliers as
      | Array<{
          name: string;
          unit_price?: number;
          lead_days?: number;
          currency?: string;
          rank?: number;
        }>
      | undefined;
    if (suppliers?.length) {
      return (
        <div>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--kirana-muted-foreground)",
              textTransform: "uppercase",
              margin: "0 0 8px",
            }}
          >
            Ranked Suppliers
          </p>
          {suppliers.map((s, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 12px",
                borderRadius: 8,
                background: "var(--kirana-accent)",
                marginBottom: 6,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display,system-ui)",
                  fontSize: 15,
                  fontWeight: 800,
                  color: "var(--kirana-primary)",
                  width: 20,
                  textAlign: "center",
                }}
              >
                #{s.rank ?? i + 1}
              </span>
              <span style={{ flex: 1, fontWeight: 600, color: "var(--kirana-foreground)" }}>
                {s.name}
              </span>
              {s.unit_price != null && (
                <span style={{ color: "var(--kirana-success)", fontWeight: 600 }}>
                  {s.currency ?? "₹"}
                  {s.unit_price}
                </span>
              )}
              {s.lead_days != null && (
                <span style={{ color: "var(--kirana-muted-foreground)" }}>{s.lead_days}d lead</span>
              )}
            </div>
          ))}
        </div>
      );
    }
  }
  if (action === "prepare_reorder") {
    const reorder = result.reorder as
      | {
          draftPoId?: string;
          total?: number;
          currency?: string;
          items?: Array<{ item_name: string; qty: number; supplier?: string; unit_price?: number }>;
        }
      | undefined;
    if (reorder?.items?.length) {
      return (
        <div>
          {reorder.draftPoId && (
            <p style={{ fontSize: 12, color: "var(--kirana-success)", margin: "0 0 8px" }}>
              Draft PO created: {reorder.draftPoId}
            </p>
          )}
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--kirana-muted-foreground)",
              textTransform: "uppercase",
              margin: "0 0 8px",
            }}
          >
            Reorder Items
          </p>
          {reorder.items.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 10,
                padding: "7px 12px",
                borderRadius: 8,
                background: "var(--kirana-accent)",
                marginBottom: 6,
                fontSize: 12,
              }}
            >
              <span style={{ flex: 1, fontWeight: 600, color: "var(--kirana-foreground)" }}>
                {item.item_name}
              </span>
              <span style={{ color: "var(--kirana-muted-foreground)" }}>Qty: {item.qty}</span>
              {item.supplier && (
                <span style={{ color: "var(--kirana-primary)" }}>{item.supplier}</span>
              )}
              {item.unit_price != null && (
                <span style={{ color: "var(--kirana-success)", fontWeight: 600 }}>
                  {reorder.currency ?? "₹"}
                  {item.unit_price}
                </span>
              )}
            </div>
          ))}
          {reorder.total != null && (
            <p
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "var(--kirana-primary)",
                margin: "8px 0 0",
              }}
            >
              Total: {reorder.currency ?? "₹"}
              {reorder.total}
            </p>
          )}
        </div>
      );
    }
  }
  return (
    <pre
      style={{
        fontSize: 11,
        color: "var(--kirana-muted-foreground)",
        background: "var(--kirana-accent)",
        borderRadius: 8,
        padding: 10,
        overflowX: "auto",
        maxHeight: 200,
        overflowY: "auto",
        margin: 0,
      }}
    >
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}

export default function ProcurementPage() {
  const { approvals, decide, reload: reloadApprovals } = useNammaOpsApprovals();
  const [pin, setPin] = useState("");
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const pending = approvals.filter((a) => a.status === "pending");

  const handleApprove = async (id: string) => {
    try {
      await decide(id, "approve", pin || undefined);
      toast.success("Purchase order approved and submitted");
      setApprovingId(null);
      setPin("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Approval failed");
    }
  };

  return (
    <div style={s.page}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={s.title}>Suppliers & Procurement</h1>
        <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
          Find suppliers, compare quotations, and manage purchase orders
        </p>
      </div>

      {/* Pending approvals */}
      {pending.length > 0 && (
        <div style={{ ...s.card, borderColor: "color-mix(in oklab,orange 40%,transparent)" }}>
          <p style={s.sectionTitle}>⚠ Purchase Orders Awaiting Your Approval</p>
          {pending.map((a) => (
            <div
              key={a.id}
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                background: "var(--kirana-accent)",
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
                {a.payload?.commandText ?? "Purchase order"}
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
                    fontSize: 13,
                    color: "var(--kirana-primary)",
                    fontWeight: 700,
                    margin: "0 0 10px",
                  }}
                >
                  Total: {a.payload.currency ?? "₹"}
                  {a.payload.total}
                </p>
              )}
              {approvingId === a.id ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="password"
                    placeholder="Owner PIN (if set)"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "6px 10px",
                      borderRadius: 7,
                      border: "1px solid var(--kirana-border)",
                      background: "var(--kirana-card)",
                      color: "var(--kirana-foreground)",
                      fontSize: 13,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void handleApprove(a.id)}
                    style={s.btn(true)}
                  >
                    Confirm Approve
                  </button>
                  <button type="button" onClick={() => setApprovingId(null)} style={s.btn()}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={() => setApprovingId(a.id)} style={s.btn(true)}>
                    Approve & Submit PO
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(a.id, "reject").then(() => reloadApprovals())}
                    style={{ ...s.btn(), color: "var(--kirana-destructive)" }}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
        <div>
          <p style={s.sectionTitle}>Supplier Discovery & Comparison</p>
          <WorkflowRunner
            action="supplier_comparison"
            icon={Users}
            color="oklch(0.7 0.15 30)"
            label="Compare Suppliers"
            desc="Procurement Agent fetches quotations from all registered suppliers and ranks them by price and delivery lead time."
            argDef={{ key: "products", placeholder: "Products (e.g. Atta, Rice, Sugar)" }}
          />
        </div>
        <div style={{ paddingLeft: 16 }}>
          <p style={s.sectionTitle}>Reorder & Purchase Orders</p>
          <WorkflowRunner
            action="prepare_reorder"
            icon={ShoppingCart}
            color="oklch(0.65 0.18 310)"
            label="Prepare Reorder"
            desc="Inventory + Procurement Agents identify low-stock items, select the best supplier, and draft a purchase order for your approval."
          />
        </div>
      </div>

      <div
        style={{
          ...s.card,
          background: "color-mix(in oklab,var(--kirana-primary) 6%,var(--kirana-card))",
          borderColor: "color-mix(in oklab,var(--kirana-primary) 25%,transparent)",
        }}
      >
        <p
          style={{
            fontFamily: "var(--font-display,system-ui)",
            fontSize: 14,
            fontWeight: 700,
            color: "var(--kirana-primary)",
            margin: "0 0 8px",
          }}
        >
          How the approval flow works
        </p>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            fontSize: 13,
            color: "var(--kirana-foreground)",
          }}
        >
          {[
            "1. Run Prepare Reorder — Dave drafts a PO",
            "2. Alice presents the PO for your approval",
            "3. You approve (with optional PIN) or reject",
            "4. Only then is the PO submitted to ERPNext",
          ].map((step, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                padding: "8px 10px",
                background: "var(--kirana-accent)",
                borderRadius: 8,
                fontSize: 11,
                color: "var(--kirana-foreground)",
              }}
            >
              {step}
            </div>
          ))}
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
