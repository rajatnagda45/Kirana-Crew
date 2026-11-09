/**
 * Fallback for a result the page has no specific layout for (a new workflow, or a changed shape).
 * It never shows raw JSON: top-level figures become tiles, lists of records become tables and lists
 * of text become bullet lists. The only raw view is the "Advanced" box.
 */
import { count, day, humanize, money, percent, qty, text, toNumber } from "./format";
import { metric, rec, recs, strings, table, type Builder, type Rec } from "./helpers";
import type { Cell, Column, Metric, Row, Section } from "./types";

const MONEY_KEY =
  /(total|amount|value|revenue|sales|price|rate|outstanding|income|expense|profit|cost|paid|received|owed)/i;
const PERCENT_KEY = /(pct|percent)/i;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

/** A cell for one scalar, guessed from its key. Null for objects and arrays. */
export function scalarCell(key: string, value: unknown): Cell | null {
  if (value === null || value === undefined) return text(null);
  if (typeof value === "number")
    return MONEY_KEY.test(key)
      ? money(value)
      : PERCENT_KEY.test(key)
        ? percent(value)
        : Number.isInteger(value)
          ? count(value)
          : qty(value);
  if (typeof value === "boolean") return text(value ? "Yes" : "No");
  if (typeof value === "string") {
    if (DATE_LIKE.test(value) && value.length <= 10) return day(value);
    const n = toNumber(value);
    if (n !== null && MONEY_KEY.test(key)) return money(n);
    return text(value.length > 160 ? `${value.slice(0, 157)}…` : value);
  }
  return null;
}

const MAX_METRICS = 16;
const MAX_COLUMNS = 6;

export const generic: Builder = ({ result }) => {
  const metrics: Metric[] = [];
  const sections: Section[] = [];

  for (const [key, value] of Object.entries(result)) {
    if (key === "kind") continue;
    const cell = scalarCell(key, value);
    if (cell) {
      if (metrics.length < MAX_METRICS) metrics.push(metric(humanize(key), cell));
      continue;
    }
    if (Array.isArray(value)) {
      const rows = recs(value);
      const words = strings(value);
      if (rows.length) {
        const first = rows[0] as Rec;
        const keys = Object.keys(first)
          .filter((k) => scalarCell(k, first[k]) !== null)
          .slice(0, MAX_COLUMNS);
        const columns: Column[] = keys.map((k) => ({
          key: k,
          label: humanize(k),
          align: typeof first[k] === "number" ? "right" : "left",
        }));
        const tableRows: Row[] = rows.map((row) =>
          Object.fromEntries(keys.map((k) => [k, scalarCell(k, row[k]) ?? text(null)])),
        );
        sections.push(table(`list-${key}`, humanize(key), columns, tableRows));
      } else if (words.length) {
        sections.push({
          kind: "list",
          id: `list-${key}`,
          title: humanize(key),
          items: words.map((w) => ({ text: w })),
        });
      }
      continue;
    }
    // One level of nesting: { totals: { a: 1, b: 2 } } becomes "Totals: A", "Totals: B".
    for (const [childKey, childValue] of Object.entries(rec(value))) {
      const child = scalarCell(childKey, childValue);
      if (child && metrics.length < MAX_METRICS)
        metrics.push(metric(`${humanize(key)}: ${humanize(childKey)}`, child));
    }
  }
  return { metrics, sections };
};
