import type { Clarification, WorkflowTask, WorkflowView } from "@/lib/workflow-contract";
import { text as textCell } from "./format";
import type { Cell, Column, Metric, Notice, Row, Section, TableSection } from "./types";

export type Rec = Record<string, unknown>;

/** What a builder receives. `result` is never null here (builders are skipped when it is). */
export interface BuildContext {
  view: WorkflowView;
  result: Rec;
  tasks: WorkflowTask[];
}

/** What a builder returns; `buildReport` adds the title, status and the common notices. */
export interface Part {
  period?: string | null;
  notices?: Notice[];
  metrics?: Metric[];
  sections?: Section[];
  recommendations?: string[];
}

export type Builder = (ctx: BuildContext) => Part;

// ── Safe access: results come from a server, so nothing is assumed ─────────

export const rec = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};

export const recs = (value: unknown): Rec[] =>
  Array.isArray(value)
    ? value.filter((item): item is Rec => !!item && typeof item === "object" && !Array.isArray(item))
    : [];

export const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];

export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

// ── Plain-English reasons ──────────────────────────────────────────────────

/**
 * Explains a server error or warning in everyday words. Only patterns seen in real runs are
 * mapped; anything else is shown as the server wrote it. The server's words are kept as `detail`.
 */
export function explain(raw: string | undefined): { text: string; detail?: string } {
  const original = (raw ?? "").trim();
  if (!original) return { text: "No reason was given." };
  const clipped = original.length > 280 ? `${original.slice(0, 277)}…` : original;
  if (/No posted profit and loss/i.test(original))
    return {
      text: "No posted accounting entries were found for this period.",
      detail: clipped,
    };
  if (/not enabled in this deployment|writes are disabled|read-only|disabled pending/i.test(original))
    return {
      text: "Live purchase-order creation is switched off, so no purchase order can be created right now.",
      detail: clipped,
    };
  if (/Unknown capability/i.test(original))
    return {
      text: "This check is not connected to your ERP data yet, so it could not run.",
      detail: clipped,
    };
  if (/No batch-tracked stock/i.test(original))
    return {
      text: "This store does not currently track product batches, so expiry cannot be checked.",
      detail: clipped,
    };
  return { text: clipped };
}

export const notice = (
  severity: Notice["severity"],
  kind: Notice["kind"],
  text: string,
  detail?: string,
): Notice => ({ severity, kind, text, ...(detail ? { detail } : {}) });

// ── Tables ─────────────────────────────────────────────────────────────────

export function table(
  id: string,
  title: string,
  columns: Column[],
  rows: Row[],
  extra: Partial<Pick<TableSection, "intro" | "limit" | "empty">> = {},
): TableSection {
  return { kind: "table", id, title, columns, rows, limit: 25, ...extra };
}

export const right = (key: string, label: string): Column => ({ key, label, align: "right" });
export const left = (key: string, label: string): Column => ({ key, label });

export function metric(label: string, value: Cell, hint?: string): Metric {
  return { label, value, ...(hint ? { hint } : {}) };
}

/** A name from the first present field, else "Not available". */
export const nameCell = (...values: unknown[]): Cell => {
  const found = values.find((v) => typeof v === "string" && v.trim() !== "");
  return textCell(found);
};

/** Question text for a clarification, built from its structured fields (never from the run summary). */
export function clarificationQuestion(c: Clarification): string {
  if (c.question) return c.question;
  switch (c.reason) {
    case "missing_product":
      return "Which product should I use?";
    case "ambiguous":
      return `“${c.requested}” matches more than one product. Which one do you mean?`;
    case "unknown":
      return `I could not find “${c.requested}”. Type the product name, or pick a product group.`;
    case "missing_quantity":
      return `How many ${c.requested || "units"}?`;
    case "missing_items":
      return "Which items should be on the bill?";
    case "ambiguous_customer":
      return `“${c.requested}” matches more than one customer. Which one do you mean?`;
    case "unknown_customer":
      return `I could not find the customer “${c.requested}”.`;
    default:
      return c.requested ? `Please clarify: ${c.requested}` : "More information is needed.";
  }
}
