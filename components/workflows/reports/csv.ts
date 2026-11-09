/**
 * CSV for a report table. Raw values, not display strings: numbers stay numbers and dates stay
 * ISO, so a spreadsheet can sort and add them. RFC 4180 quoting, CRLF lines and a UTF-8 BOM (Excel
 * on Windows needs it to read Kannada or Hindi names).
 */
import type { Cell, TableSection } from "./types";

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Spreadsheets run a text cell that starts with = + - @ as a formula. Names in the data come from
 * customers and suppliers, so such cells get a leading apostrophe. Real numbers are untouched, and
 * so are text cells that are only a plain number.
 */
export function guardCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value) && !PLAIN_NUMBER.test(value)) return `'${value}`;
  return value;
}

function csvField(cell: Cell | undefined): string {
  if (!cell || cell.value === null || cell.value === undefined) return "";
  const raw = typeof cell.value === "number" ? String(cell.value) : guardCell(cell.value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function tableToCsv(table: Pick<TableSection, "columns" | "rows">, bom = true): string {
  const header = table.columns.map((column) =>
    csvField({ kind: "text", value: column.label, display: column.label }),
  );
  const lines = [
    header.join(","),
    ...table.rows.map((row) => table.columns.map((column) => csvField(row[column.key])).join(",")),
  ];
  return `${bom ? "﻿" : ""}${lines.join("\r\n")}\r\n`;
}

/** A safe file name such as "stock-check-products-running-low-2026-11-08.csv". */
export function csvFileName(parts: Array<string | undefined | null>): string {
  const slug = parts
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "report"}.csv`;
}
