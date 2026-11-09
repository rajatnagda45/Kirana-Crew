"use client";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { NammaOpsApproval } from "@/lib/hooks/useNammaOps";
import { formatDateTime, humanize, money, qty } from "./reports/format";
import { panel, ui } from "./styles";

const KIND: Record<string, string> = { purchase_order: "Purchase order", sales_invoice: "Sales invoice" };
/** Not actionable, but the owner should still see them (the outcome needs checking). */
const WATCH = new Set(["submitting", "uncertain"]);

export interface ApprovalsCardProps {
  approvals: NammaOpsApproval[];
  /** Approve or reject. The server needs the owner PIN for both; it rejects with its own message. */
  onDecide: (id: string, action: "approve" | "reject", pin: string) => Promise<void>;
}

function ApprovalItem({ approval, onDecide }: { approval: NammaOpsApproval } & Pick<ApprovalsCardProps, "onDecide">) {
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = approval.status === "pending";
  const what = KIND[approval.kind] ?? humanize(approval.kind);
  const party = approval.supplier ? `from ${approval.supplier}` : approval.customer ? `for ${approval.customer}` : "";
  const expires = formatDateTime(approval.expires_at);
  const pinId = `pin-${approval.id}`;

  const confirm = async () => {
    if (!mode || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDecide(approval.id, mode, pin);
      toast.success(mode === "approve" ? "Approved" : "Rejected");
      setMode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision was not saved.");
    } finally {
      setPin(""); // the PIN is not kept after an attempt
      setBusy(false);
    }
  };

  return (
    <li style={{ ...ui.card, marginBottom: 8, padding: "12px 14px" }}>
      <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 700 }}>
        {what}
        {approval.erp_document_name ? ` ${approval.erp_document_name}` : ""} {party}
      </p>
      {approval.items?.length ? (
        <ul style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: 12 }}>
          {approval.items.slice(0, 5).map((item, i) => (
            <li key={i}>
              {item.item_code ?? "Item"} × {qty(item.qty).display}
              {item.rate !== undefined ? ` at ${money(item.rate).display}` : ""}
            </li>
          ))}
          {approval.items.length > 5 && <li>and {approval.items.length - 5} more</li>}
        </ul>
      ) : null}
      <p style={{ ...ui.muted, margin: "0 0 8px" }}>
        {approval.total !== undefined && <strong style={{ color: "var(--kirana-primary)" }}>Total {money(approval.total).display}</strong>}
        {expires && pending ? ` · Approve before ${expires}` : ""}
        {!pending ? ` · ${humanize(approval.status)}` : ""}
      </p>
      {!pending && approval.status === "uncertain" && (
        <p style={{ ...ui.muted, margin: 0 }}>It is not certain whether this was submitted. Check the ERP before trying again.</p>
      )}

      {pending &&
        (mode ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 160px" }}>
              <label htmlFor={pinId} style={ui.label}>
                Owner PIN to {mode}
              </label>
              <input id={pinId} type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void confirm()} style={ui.input} />
            </div>
            <button type="button" disabled={busy || !pin} onClick={() => void confirm()} style={{ ...ui.btn(mode === "approve"), color: mode === "reject" ? "var(--kirana-destructive)" : undefined }}>
              {busy ? "Saving…" : `Confirm ${mode}`}
            </button>
            <button type="button" onClick={() => { setMode(null); setPin(""); setError(null); }} style={ui.btn()}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setMode("approve")} style={ui.btn(true)}>Approve</button>
            <button type="button" onClick={() => setMode("reject")} style={{ ...ui.btn(), color: "var(--kirana-destructive)" }}>Reject</button>
          </div>
        ))}
      {error && (
        <p role="alert" style={{ margin: "8px 0 0", fontSize: 13, color: "var(--kirana-destructive)" }}>{error}</p>
      )}
    </li>
  );
}

export function ApprovalsCard({ approvals, onDecide }: ApprovalsCardProps) {
  const shown = approvals.filter((a) => a.status === "pending" || WATCH.has(a.status));
  if (!shown.length) return null;
  const pending = shown.filter((a) => a.status === "pending").length;
  return (
    <section aria-labelledby="wf-approvals" style={{ ...panel("warn"), display: "block", padding: 16, marginBottom: 20 }}>
      <h2 id="wf-approvals" style={{ ...ui.heading, fontSize: 15, fontWeight: 700, margin: "0 0 10px", display: "flex", alignItems: "center", gap: 6 }}>
        <AlertTriangle size={15} aria-hidden="true" />
        {pending ? `${pending} approval${pending === 1 ? "" : "s"} waiting for you` : "Check these approvals"}
      </h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {shown.map((a) => (
          <ApprovalItem key={a.id} approval={a} onDecide={onDecide} />
        ))}
      </ul>
    </section>
  );
}
