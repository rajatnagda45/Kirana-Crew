/**
 * Number, date and duration formatting for reports, in Indian conventions (₹, lakh/crore grouping,
 * day-month-year). Every formatter keeps three states apart: a real zero ("₹0"), a missing figure
 * ("Not available") and a check that was skipped ("Not checked").
 */
import type { Cell } from "./types";

export const NOT_AVAILABLE = "Not available";
export const NOT_CHECKED = "Not checked";

/** A finite number, from a number or a numeric string (ERP sometimes sends "0"). Else null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const rupees = (fraction: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  });
const wholeRupees = rupees(0);
const paiseRupees = rupees(2);
const plain = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

/** ₹12,500 for whole amounts, ₹20,606.83 when there are paise. Negative: -₹500. */
export function formatRupees(value: number): string {
  return (Number.isInteger(value) ? wholeRupees : paiseRupees).format(value);
}

export const formatQuantity = (value: number): string => plain.format(value);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "8 Nov 2026" from "2026-11-08". A date-only string is read as a local date: `new Date("2026-11-08")`
 * is UTC midnight, which shows the previous day west of Greenwich.
 */
export function formatDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const month = MONTHS[Number(m) - 1];
  if (!month || Number(d) < 1 || Number(d) > 31) return null;
  return `${Number(d)} ${month} ${y}`;
}

const parseTime = (value: unknown): number | null => {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

/** "8 Nov 2026, 5:01 pm" in the viewer's time zone (or `timeZone`), or null if unparseable. */
export function formatDateTime(value: unknown, timeZone?: string): string | null {
  const time = parseTime(value);
  if (time === null) return null;
  const parts = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(new Date(time));
  // Newer ICU puts a narrow no-break space before am/pm; use a plain space so output is stable.
  return parts
    .replace(/[  ]/g, " ")
    .replace(/\bam\b/i, "am")
    .replace(/\bpm\b/i, "pm");
}

/** Milliseconds between two timestamps, only when both are valid and the end is not before the start. */
export function durationMs(start: unknown, end: unknown): number | null {
  const a = parseTime(start);
  const b = parseTime(end);
  if (a === null || b === null || b < a) return null;
  return b - a;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return "under 1 second";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
}

/** "total_sales" -> "Total sales". */
export function humanize(key: string): string {
  const text = key.replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
}

/** "8 Nov 2026" for one day, "1 Nov 2026 to 7 Nov 2026" for a range. Null when there is no period. */
export function formatPeriod(from: unknown, to?: unknown): string | null {
  const a = formatDay(from);
  const b = formatDay(to);
  if (a && b && a !== b) return `${a} to ${b}`;
  return a ?? b;
}

// ── Cells ─────────────────────────────────────────────────────────────────

const missing = (kind: Cell["kind"], display = NOT_AVAILABLE): Cell => ({
  kind,
  value: null,
  display,
});

export const text = (value: unknown): Cell => {
  if (value === null || value === undefined || value === "") return missing("text");
  return { kind: "text", value: String(value), display: String(value) };
};

export const money = (value: unknown): Cell => {
  const n = toNumber(value);
  return n === null ? missing("money") : { kind: "money", value: n, display: formatRupees(n) };
};

export const qty = (value: unknown, unit?: string): Cell => {
  const n = toNumber(value);
  if (n === null) return missing("qty");
  const label = unit ? ` ${unit}` : "";
  return { kind: "qty", value: n, unit, display: `${formatQuantity(n)}${label}` };
};

export const count = (value: unknown): Cell => {
  const n = toNumber(value);
  return n === null ? missing("count") : { kind: "count", value: n, display: formatQuantity(n) };
};

/** `value` is already a percentage (12.5 means 12.5%). */
export const percent = (value: unknown): Cell => {
  const n = toNumber(value);
  return n === null
    ? missing("percent")
    : { kind: "percent", value: n, display: `${formatQuantity(n)}%` };
};

export const days = (value: unknown): Cell => {
  const n = toNumber(value);
  return n === null
    ? missing("days")
    : { kind: "days", value: n, display: `${formatQuantity(n)} day${n === 1 ? "" : "s"}` };
};

export const day = (value: unknown): Cell => {
  const display = formatDay(value);
  return display === null || typeof value !== "string"
    ? missing("date")
    : { kind: "date", value: value.slice(0, 10), display };
};

export const statusCell = (display: string, tone?: Cell["tone"]): Cell => ({
  kind: "status",
  value: display,
  display,
  ...(tone ? { tone } : {}),
});

/** A figure that belongs to a check that did not run. */
export const notChecked = (kind: Cell["kind"] = "text"): Cell => missing(kind, NOT_CHECKED);
