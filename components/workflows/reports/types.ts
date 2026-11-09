/**
 * The report model: a plain, serialisable description of one finished run, built from the saved
 * run record by the per-workflow builders. The React view, the print page, the plain-text copy and
 * the CSV export all read this one model, so they can never disagree.
 */

export type CellKind = "text" | "money" | "qty" | "count" | "percent" | "days" | "date" | "status";

/**
 * One value, kept typed. `value` is the raw figure (a number, an ISO date, text) for CSV; `display`
 * is what the owner reads. `value: null` means the figure is not available. A genuine zero keeps
 * `value: 0`, so "zero" and "not available" never look alike.
 */
export interface Cell {
  kind: CellKind;
  value: string | number | null;
  display: string;
  /** Unit label for quantities ("kg", "Nos"). Included in `display`, kept for CSV headers. */
  unit?: string;
  tone?: "good" | "warn" | "bad";
}

export interface Column {
  key: string;
  label: string;
  align?: "left" | "right";
}

export type Row = Record<string, Cell>;

export interface TableSection {
  kind: "table";
  id: string;
  title: string;
  intro?: string;
  columns: Column[];
  rows: Row[];
  /** Rows shown before "Show all". CSV and print always include every row. */
  limit?: number;
  /** Shown instead of an empty table. */
  empty?: string;
}

export interface ListSection {
  kind: "list";
  id: string;
  title: string;
  items: Array<{ text: string; detail?: string; tone?: "good" | "warn" | "bad" }>;
  empty?: string;
}

export interface NoteSection {
  kind: "note";
  id: string;
  title?: string;
  text: string;
  tone?: "good" | "warn" | "bad";
}

export type Section = TableSection | ListSection | NoteSection;

export interface Metric {
  label: string;
  value: Cell;
  hint?: string;
}

export type NoticeSeverity = "info" | "warn" | "error";

export interface Notice {
  severity: NoticeSeverity;
  /** What kind of gap this is: a check that did not run, a figure that is missing, a server warning... */
  kind: "partial" | "unchecked" | "unavailable" | "warning" | "blocked" | "failed" | "info";
  text: string;
  /** The server's own words, shown under the plain explanation when they add something. */
  detail?: string;
}

export interface ReportModel {
  action: string;
  title: string;
  status: string;
  statusLabel: string;
  statusExplain: string;
  /** The saved one-line summary, or null when the run has none. */
  headline: string | null;
  /** "8 Nov 2026" or "1 Nov 2026 to 7 Nov 2026"; null when the run has no period. */
  period: string | null;
  /** Server timestamps, formatted. Duration only when both timestamps exist and are in order. */
  run: { started: string | null; finished: string | null; duration: string | null };
  /** Caveats first: shown above the figures. */
  notices: Notice[];
  metrics: Metric[];
  sections: Section[];
  /** Actions that follow from the data, each built from real figures. */
  recommendations: string[];
}
