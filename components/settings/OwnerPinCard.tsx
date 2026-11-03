"use client";
import { useCallback, useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { toast } from "sonner";
import { fetchNammaOps } from "@/lib/hooks/useNammaOps";

type PinStatus = { source: "settings" | "environment" | "default"; updated_at: string | null };

const SOURCE: Record<PinStatus["source"], string> = {
  settings: "Set in Settings",
  environment: "From NAMMAOPS_OWNER_PIN",
  default: "Starter PIN 1234, change it",
};

/**
 * The owner approval PIN. It gates every purchase-order submission (and future Stage 2 actions).
 * The server stores only a salted hash; the PIN is never returned. Changing it needs the current
 * PIN, and 5 wrong tries lock it for 5 minutes.
 */
export default function OwnerPinCard() {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      fetchNammaOps<{ owner_pin: PinStatus }>("/owner-pin")
        .then((r) => setStatus(r.owner_pin))
        .catch(() => setStatus(null)),
    [],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = async () => {
    if (!/^\d{4,8}$/.test(next)) return toast.error("The new PIN must be 4 to 8 digits.");
    if (next !== confirm) return toast.error("The new PINs do not match.");
    setSaving(true);
    try {
      const r = await fetchNammaOps<{ owner_pin: PinStatus }>("/owner-pin", {
        current_pin: current,
        new_pin: next,
      });
      setStatus(r.owner_pin);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Approval PIN changed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the PIN");
    } finally {
      setSaving(false);
    }
  };

  const input: React.CSSProperties = {
    width: 120,
    padding: "7px 10px",
    borderRadius: 8,
    border: "1px solid var(--kirana-border)",
    background: "var(--kirana-secondary)",
    color: "var(--kirana-foreground)",
    fontSize: 14,
    letterSpacing: 3,
  };
  const tone = status?.source === "default" ? "var(--kirana-primary)" : "var(--kirana-success)";

  return (
    <div
      style={{
        background: "var(--kirana-card)",
        border: "1px solid var(--kirana-border)",
        borderRadius: 14,
        padding: 20,
        marginBottom: 16,
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-display,system-ui)",
          fontSize: 16,
          fontWeight: 700,
          margin: "0 0 6px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Shield size={16} style={{ color: "var(--kirana-primary)" }} />
        Owner PIN (Approval Gate)
        {status && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 8,
              fontWeight: 600,
              background: `color-mix(in oklab,${tone} 12%,transparent)`,
              color: tone,
            }}
          >
            {SOURCE[status.source]}
          </span>
        )}
      </p>
      <p style={{ fontSize: 12.5, color: "var(--kirana-muted-foreground)", margin: "0 0 14px" }}>
        Required before any purchase order is submitted to ERPNext. Stored only as a salted hash.
        Five wrong attempts lock approvals for 5 minutes.
        {status?.updated_at ? ` Last changed ${new Date(status.updated_at).toLocaleString()}.` : ""}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}
      >
        {(
          [
            ["Current PIN", current, setCurrent, "current-password"],
            ["New PIN", next, setNext, "new-password"],
            ["Confirm new PIN", confirm, setConfirm, "new-password"],
          ] as const
        ).map(([label, value, set, auto]) => (
          <label key={label} style={{ fontSize: 12, color: "var(--kirana-muted-foreground)" }}>
            {label}
            <br />
            <input
              type="password"
              inputMode="numeric"
              autoComplete={auto}
              maxLength={8}
              value={value}
              onChange={(e) => set(e.target.value.replace(/\D/g, ""))}
              style={input}
            />
          </label>
        ))}
        <button
          type="submit"
          disabled={saving || !current || !next}
          style={{
            padding: "8px 16px",
            borderRadius: 9,
            border: "none",
            background: "var(--kirana-primary)",
            color: "var(--kirana-primary-foreground)",
            fontWeight: 700,
            fontSize: 13,
            cursor: saving ? "wait" : "pointer",
            opacity: !current || !next ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Change PIN"}
        </button>
      </form>
    </div>
  );
}
