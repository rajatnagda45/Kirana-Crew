/** Indian number formatting (lakh/crore grouping) for dashboards. */
const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const inr2 = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

export function formatINR(value: number | null | undefined, { exact = false } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return (exact || Math.abs(value) < 100 ? inr2 : inr).format(value);
}

/** ₹1.2K, ₹3.4L (lakh), ₹1.1Cr (crore). */
export function formatINRCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return num.format(value);
}

export type Unit = "INR" | "count" | "pct" | "days" | "x" | "text" | string | undefined;

export function formatValue(value: unknown, unit: Unit, { compact = false } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "number") return String(value);
  switch (unit) {
    case "INR":
      return compact ? formatINRCompact(value) : formatINR(value);
    case "pct":
      return `${formatNumber(value)}%`;
    case "days":
      return `${formatNumber(value)} d`;
    case "x":
      return `${formatNumber(value)}×`;
    default:
      return formatNumber(value);
  }
}
