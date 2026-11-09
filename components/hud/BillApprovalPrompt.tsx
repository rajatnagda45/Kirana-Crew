"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDialog } from "@/components/ui/useDialog";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const POLL_MS = 15_000;
const DISMISSED_KEY = "kiranacrew:bill-approval-later";

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
 * Pops up when Frank has drafted a customer bill that waits for the owner's PIN. "Approve and bill"
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
      setBills(
        (approvals ?? []).filter((row) => row.kind === "sales_invoice" && row.status === "pending"),
      );
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
          : `${bill.erp_document_name}: rejected, nothing billed.`,
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
      <p className="team-feedback" role="status">
        {result}
      </p>
    ) : null;

  return (
    <div className="ui-confirm-overlay">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Approve customer bill"
        tabIndex={-1}
        className="ui-confirm"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <h2>Approve bill {bill.erp_document_name}?</h2>
        <p>
          {bill.customer} · total ₹{bill.total}. It is a <strong>draft</strong>: nothing is billed,
          and stock and accounts are unchanged, until you enter your PIN.
        </p>
        <ul>
          {(bill.items ?? []).map((row: Any) => (
            <li key={row.item_code}>
              {row.qty} × {row.item_code} @ ₹{row.rate}
            </li>
          ))}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void decide("approve");
          }}
        >
          <label>
            Owner PIN{" "}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label="Owner PIN"
              value={pin}
              disabled={busy}
              onChange={(event) => setPin(event.target.value)}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <div className="ui-actions">
            <button type="button" className="pixel-button" disabled={busy} onClick={later}>
              Later
            </button>
            <button
              type="button"
              className="pixel-button"
              disabled={busy || !pin}
              onClick={() => void decide("reject")}
            >
              Reject
            </button>
            <button type="submit" className="pixel-button" disabled={busy || !pin}>
              Approve and bill
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
