"use client";
import { useState } from "react";
import {
  BarChart3,
  CalendarClock,
  FileText,
  Gauge,
  HandCoins,
  HeartPulse,
  Info,
  Landmark,
  Loader2,
  Package,
  Play,
  Receipt,
  Search,
  ShoppingCart,
  TrendingUp,
  Truck,
  UserCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { WorkflowIntent } from "@/lib/workflow-contract";
import {
  buildIntent,
  REORDER_SUGGESTION_ACTION,
  WORKFLOW_DEFS,
  type FieldDef,
  type FieldValues,
  type WorkflowDef,
} from "./definitions";
import { panel, ui } from "./styles";

const ICONS: Record<string, LucideIcon> = {
  Package,
  BarChart3,
  ShoppingCart,
  TrendingUp,
  Users,
  HandCoins,
  CalendarClock,
  Truck,
  Gauge,
  UserCheck,
  HeartPulse,
  FileText,
  Receipt,
  Wallet,
  Landmark,
  Search,
};

/** Whether the ERP will create purchase-order drafts. Anything but "available" is treated as off. */
export type ReorderState = "available" | "disabled" | "checking" | "unknown";

export interface WorkflowCardsProps {
  /** Starts a run. Rejects with the server's message, which the card shows. */
  onRun: (intent: WorkflowIntent, label: string) => Promise<void>;
  /** The action currently being started, so only that card shows a spinner. */
  starting: string | null;
  reorder: ReorderState;
  /** action -> why that card cannot run right now (its ERP connection is not set up). */
  unavailable?: Record<string, string>;
}

function Field({
  def,
  field,
  value,
  error,
  onChange,
}: {
  def: WorkflowDef;
  field: FieldDef;
  value: string | boolean | undefined;
  error?: string;
  onChange: (value: string | boolean) => void;
}) {
  const id = `wf-${def.action}-${field.key}`;
  const hint = `${id}-hint`;
  const describedBy =
    [field.help || field.example ? hint : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const common = {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
    "aria-required": field.required || undefined,
  } as const;

  return (
    <div style={{ marginBottom: 10 }}>
      {field.type === "checkbox" ? (
        <label
          htmlFor={id}
          style={{ ...ui.label, display: "flex", alignItems: "center", gap: 8, margin: 0 }}
        >
          <input
            {...common}
            type="checkbox"
            checked={value === undefined ? !!field.checked : value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.label}
        </label>
      ) : (
        <>
          <label htmlFor={id} style={ui.label}>
            {field.label}
            {field.required && (
              <span aria-hidden="true" style={{ color: "var(--kirana-destructive)" }}>
                {" "}
                *
              </span>
            )}
          </label>
          {field.type === "select" ? (
            <select
              {...common}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              style={ui.input}
            >
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              {...common}
              type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
              {...(field.type === "number"
                ? { min: 1, step: 1, inputMode: "numeric" as const }
                : {})}
              {...(field.type === "text" || field.type === "products"
                ? { autoComplete: "off" }
                : {})}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              style={ui.input}
            />
          )}
        </>
      )}
      {(field.help || field.example) && (
        <p id={hint} style={{ ...ui.muted, margin: "3px 0 0" }}>
          {field.help}
          {field.example ? ` Example: ${field.example}` : ""}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          style={{ margin: "3px 0 0", fontSize: 12, color: "var(--kirana-destructive)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

function ReorderNote({ state }: { state: ReorderState }) {
  if (state === "available") return null;
  const text =
    state === "checking"
      ? "Checking whether purchase orders can be created…"
      : state === "unknown"
        ? "Could not check whether purchase orders can be created, so they are treated as unavailable."
        : "Purchase orders cannot be created right now. Creating them in the ERP is switched off, so nothing can be ordered from here.";
  return (
    <div style={panel("warn")} role="note">
      <Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{text}</span>
    </div>
  );
}

function Card({
  def,
  starting,
  reorder,
  onRun,
  unavailable,
}: {
  def: WorkflowDef;
  starting: string | null;
  reorder: ReorderState;
  unavailable?: string;
} & Pick<WorkflowCardsProps, "onRun">) {
  const [values, setValues] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const Icon = ICONS[def.icon] ?? Package;
  const isReorder = def.special === "reorder";
  const reorderOff = isReorder && reorder !== "available";

  const run = async (target: WorkflowDef, label: string) => {
    const { intent, errors: found } = buildIntent(target, values);
    setErrors(found);
    setFailure(null);
    if (!intent) return;
    try {
      await onRun(intent, label);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Could not start this report.");
    }
  };

  // Prepare Reorder, when purchase orders are off, offers the read-only suggestions instead.
  const target = reorderOff
    ? ({ ...def, action: REORDER_SUGGESTION_ACTION, fields: [] } as WorkflowDef)
    : def;
  const label = reorderOff ? "Reorder suggestions (read-only)" : def.label;
  const busy = starting === target.action;

  return (
    <form
      aria-labelledby={`wf-${def.action}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(target, label);
      }}
      style={{ ...ui.card, marginBottom: 0, minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
        <div
          aria-hidden="true"
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: `color-mix(in oklab,${def.color} 15%,transparent)`,
            display: "grid",
            placeItems: "center",
            color: def.color,
            flexShrink: 0,
          }}
        >
          <Icon size={18} />
        </div>
        <div style={{ flex: 1 }}>
          {/* The badges sit beside the heading, not inside it, so the card's accessible name stays its title. */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <h3
              id={`wf-${def.action}-title`}
              style={{ ...ui.heading, fontSize: 15, fontWeight: 700 }}
            >
              {def.label}
            </h3>
            {unavailable && (
              <span style={ui.pill("var(--kirana-muted-foreground)")}>Not available yet</span>
            )}
            {reorderOff && (
              <span style={ui.pill("var(--kirana-primary)")}>Purchase orders off</span>
            )}
          </div>
          <p style={{ ...ui.muted, margin: "3px 0 0", fontSize: 12 }}>{def.description}</p>
        </div>
      </div>

      {unavailable && (
        <div style={panel("warn")} role="note">
          <Info size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{unavailable}</span>
        </div>
      )}
      {isReorder && <ReorderNote state={reorder} />}
      {reorderOff && (
        <p style={{ ...ui.muted, margin: "0 0 10px" }}>
          The button below shows what is running low and the best supplier for each product. Nothing
          is ordered.
        </p>
      )}
      {!reorderOff &&
        !unavailable &&
        def.fields.map((field) => (
          <Field
            key={field.key}
            def={def}
            field={field}
            value={values[field.key]}
            error={errors[field.key]}
            onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
          />
        ))}

      {failure && (
        <p
          role="alert"
          style={{ margin: "0 0 8px", fontSize: 12, color: "var(--kirana-destructive)" }}
        >
          {failure}
        </p>
      )}
      {!unavailable && (
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy || undefined}
          style={{
            ...ui.btn(true),
            width: "100%",
            justifyContent: "center",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? (
            <Loader2
              size={13}
              aria-hidden="true"
              style={{ animation: "wf-spin 1s linear infinite" }}
            />
          ) : (
            <Play size={13} aria-hidden="true" />
          )}
          {busy ? "Starting…" : `Run ${label}`}
        </button>
      )}
    </form>
  );
}

export function WorkflowCards({ onRun, starting, reorder, unavailable }: WorkflowCardsProps) {
  return (
    <section aria-labelledby="wf-available" style={{ marginBottom: 28 }}>
      <h2
        id="wf-available"
        style={{ ...ui.heading, fontSize: 17, fontWeight: 700, margin: "0 0 14px" }}
      >
        Available workflows
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(min(280px,100%),1fr))",
          gap: 14,
        }}
      >
        {WORKFLOW_DEFS.map((def) => (
          <Card
            key={def.action}
            def={def}
            starting={starting}
            reorder={reorder}
            onRun={onRun}
            unavailable={unavailable?.[def.action]}
          />
        ))}
      </div>
    </section>
  );
}
