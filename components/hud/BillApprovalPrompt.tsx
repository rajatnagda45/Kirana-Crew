"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useDialog } from "@/components/ui/useDialog";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const POLL_MS = 15_000;
const DISMISSED_KEY = "kiranacrew:bill-approval-later";

/** What differs between the two documents the owner can approve here. Layout and flow are shared. */
const KINDS: Record<string, { eyebrow: string; note: string; approve: string; rejected: string }> =
  {
    sales_invoice: {
      eyebrow: "Bill waiting for your approval",
      note: "This is a draft. Nothing is billed, and stock and accounts stay unchanged, until you enter your PIN.",
      approve: "Approve and bill",
      rejected: "rejected, nothing billed.",
    },
    purchase_order: {
      eyebrow: "Purchase order waiting for your approval",
      note: "This is a draft purchase order. Nothing is ordered from the supplier until you enter your PIN.",
      approve: "Approve and order",
      rejected: "rejected, nothing ordered.",
    },
  };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/nammaops${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

const loadDismissed = (): string[] => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
};
const saveDismissed = (ids: string[]) => {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    /* storage unavailable: "later" then lasts until the page reloads */
  }
};

/**
 * Pops up when Frank has drafted a customer bill, or Dave a purchase order, that waits for the
 * owner's PIN (same layout and flow for both). "Approve and bill" / "Approve and order"
 * sends the PIN to the same governed approval endpoint the KiranaCrew panel uses; "Later" hides the
 * popup for that bill and opens the KiranaCrew tab, where the bill stays until it is approved,
 * rejected or expires. The PIN is never stored or logged here.
 */
export default function BillApprovalPrompt({ onLater }: { onLater: () => void }) {
  const [bills, setBills] = useState<Any[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read browser-only preference after hydration
    setDismissed(loadDismissed());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { approvals } = await call<{ approvals: Any[] }>("/dashboard");
      setBills((approvals ?? []).filter((row) => row.kind in KINDS && row.status === "pending"));
    } catch {
      /* the KiranaCrew tab reports connection problems; the popup just stays quiet */
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (!closed) void refresh();
    };
    run();
    const poll = setInterval(run, POLL_MS);
    const events = new EventSource("/api/runtime/events");
    events.onmessage = (event) => {
      try {
        if (!/^nammaops\./.test(JSON.parse(event.data).kind)) return;
      } catch {
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, 300);
    };
    return () => {
      closed = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      events.close();
    };
  }, [refresh]);

  const bill = bills.find((row) => !dismissed.includes(row.id)) ?? null;
  const later = () => {
    if (!bill) return;
    const next = [...dismissed, bill.id];
    setDismissed(next);
    saveDismissed(next);
    setPin("");
    setError("");
    onLater();
  };
  const ref = useDialog(Boolean(bill), later);
  const lastBill = useRef<string | null>(null);
  useEffect(() => {
    // A different bill starts with an empty PIN box and no stale message.
    if (bill?.id !== lastBill.current) {
      lastBill.current = bill?.id ?? null;
      setPin("");
      setError("");
    }
  }, [bill?.id]);

  const decide = async (action: "approve" | "reject") => {
    if (!bill || !pin) return;
    setBusy(true);
    setError("");
    try {
      const { approval } = await call<{ approval: Any }>(`/approvals/${bill.id}/${action}`, {
        pin,
      });
      setResult(
        action === "approve"
          ? `${bill.erp_document_name}: ${approval.status}`
          : `${bill.erp_document_name}: ${(KINDS[bill.kind] ?? KINDS.sales_invoice).rejected}`,
      );
      setTimeout(() => setResult(""), 8000);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  if (!bill)
    return result ? (
      <p role="status" style={styles.toast}>
        {result}
      </p>
    ) : null;

  const text = KINDS[bill.kind] ?? KINDS.sales_invoice;
  const party = bill.kind === "purchase_order" ? `from ${bill.supplier}` : `for ${bill.customer}`;
  const total = Number(bill.total);
  const money = (value: unknown) =>
    Number.isFinite(Number(value))
      ? `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
      : "";
  const waiting = bills.filter((row) => !dismissed.includes(row.id)).length;

  return (
    <div
      style={styles.overlay}
      onMouseDown={(event) => event.target === event.currentTarget && later()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bill-approval-title"
        tabIndex={-1}
        style={styles.card}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Close and decide later"
          onClick={later}
          style={styles.close}
        >
          ×
        </button>
        <p style={styles.eyebrow}>
          {text.eyebrow}
          {waiting > 1 ? ` · ${waiting} waiting` : ""}
        </p>
        <h2 id="bill-approval-title" style={styles.title}>
          {bill.erp_document_name} {party}
        </h2>
        <ul style={styles.items}>
          {(bill.items ?? []).map((row: Any) => (
            <li key={row.item_code} style={styles.item}>
              <span>
                {row.qty} × {row.item_code}
              </span>
              <span style={styles.muted}>at {money(row.rate)}</span>
            </li>
          ))}
        </ul>
        <p style={styles.total}>
          Total <strong style={styles.amount}>{Number.isFinite(total) ? money(total) : ""}</strong>
        </p>
        <p style={styles.note}>{text.note}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void decide("approve");
          }}
        >
          <label htmlFor="bill-approval-pin" style={styles.label}>
            Owner PIN
          </label>
          <input
            id="bill-approval-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Enter your PIN"
            value={pin}
            disabled={busy}
            onChange={(event) => setPin(event.target.value)}
            style={styles.input}
          />
          {error ? (
            <p role="alert" style={styles.error}>
              {error}
            </p>
          ) : null}
          <div style={styles.actions}>
            <button type="button" disabled={busy} onClick={later} style={styles.secondary}>
              Later
            </button>
            <button
              type="button"
              disabled={busy || !pin}
              onClick={() => void decide("reject")}
              style={{
                ...styles.secondary,
                color: "var(--kirana-destructive)",
                opacity: busy || !pin ? 0.5 : 1,
              }}
            >
              Reject
            </button>
            <button
              type="submit"
              disabled={busy || !pin}
              style={{ ...styles.primary, opacity: busy || !pin ? 0.5 : 1 }}
            >
              {busy ? "Saving…" : text.approve}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The app's own dark-theme tokens (app/globals.css), the same ones the Workflows page uses. */
const styles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "rgba(0,0,0,0.6)",
    backdropFilter: "blur(2px)",
  },
  card: {
    position: "relative",
    width: "min(440px, 100%)",
    maxHeight: "calc(100vh - 32px)",
    overflowY: "auto",
    boxSizing: "border-box",
    padding: "24px 24px 20px",
    borderRadius: 16,
    background: "var(--kirana-card)",
    color: "var(--kirana-foreground)",
    border: "1px solid var(--kirana-border)",
    boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
    fontFamily: "inherit",
    outline: "none",
  },
  close: {
    position: "absolute",
    top: 10,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: "var(--kirana-muted-foreground)",
    fontSize: 24,
    lineHeight: 1,
    cursor: "pointer",
  },
  eyebrow: {
    margin: "0 0 6px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--kirana-primary)",
  },
  title: { margin: "0 28px 14px 0", fontSize: 19, fontWeight: 700, lineHeight: 1.25 },
  items: { listStyle: "none", margin: 0, padding: 0, borderTop: "1px solid var(--kirana-border)" },
  item: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "9px 0",
    fontSize: 14,
    borderBottom: "1px solid var(--kirana-border)",
  },
  muted: { color: "var(--kirana-muted-foreground)", whiteSpace: "nowrap" },
  total: { display: "flex", justifyContent: "space-between", margin: "12px 0 4px", fontSize: 14 },
  amount: { color: "var(--kirana-primary)", fontSize: 20 },
  note: { margin: "0 0 16px", fontSize: 12, color: "var(--kirana-muted-foreground)" },
  label: { display: "block", marginBottom: 6, fontSize: 12, fontWeight: 600 },
  input: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    padding: "11px 12px",
    borderRadius: 9,
    border: "1px solid var(--kirana-border)",
    background: "var(--kirana-accent)",
    color: "var(--kirana-foreground)",
    fontSize: 16,
    letterSpacing: "0.2em",
  },
  error: { margin: "8px 0 0", fontSize: 13, color: "var(--kirana-destructive)" },
  actions: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18, flexWrap: "wrap" },
  secondary: {
    padding: "10px 16px",
    borderRadius: 9,
    border: "1px solid var(--kirana-border)",
    background: "var(--kirana-card)",
    color: "var(--kirana-foreground)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  primary: {
    padding: "10px 18px",
    borderRadius: 9,
    border: "none",
    background: "var(--kirana-primary)",
    color: "var(--kirana-primary-foreground)",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  toast: {
    position: "fixed",
    right: 16,
    bottom: 16,
    zIndex: 1000,
    margin: 0,
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--kirana-border)",
    background: "var(--kirana-card)",
    color: "var(--kirana-foreground)",
    fontSize: 13,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  },
};
