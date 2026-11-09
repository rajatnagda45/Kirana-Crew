/** Plain-text forms of a report, for "Copy summary" and "Copy full report". Every table row is included. */
import type { ReportModel, Section, TableSection } from "./types";

const dash = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ");

/** Title, period, the saved summary, and a caveat when the run was only partly completed. */
export function summaryText(model: ReportModel): string {
  const lines = [dash([model.title, model.period]), model.headline ?? model.statusLabel];
  if (model.status === "partial")
    lines.push("Note: partially completed. Some checks could not be finished.");
  return lines.join("\n");
}

function sectionText(section: Section): string[] {
  if (section.kind === "note") return [section.title ? `${section.title}: ${section.text}` : section.text];
  if (section.kind === "list")
    return [
      section.title,
      ...(section.items.length
        ? section.items.map((item) => `- ${item.text}${item.detail ? ` (${item.detail})` : ""}`)
        : [section.empty ?? "None."]),
    ];
  const rows = section.rows.map((row) =>
    section.columns.map((column) => row[column.key]?.display ?? "").join(" | "),
  );
  return [
    section.title,
    ...(section.intro ? [section.intro] : []),
    ...(rows.length
      ? [section.columns.map((c) => c.label).join(" | "), ...rows]
      : [section.empty ?? "No rows."]),
  ];
}

export function toPlainText(model: ReportModel): string {
  const lines: string[] = [dash([model.title, model.statusLabel]), ""];
  const when = dash([
    model.run.started ? `Started ${model.run.started}` : null,
    model.run.finished ? `finished ${model.run.finished}` : null,
    model.run.duration ? `took ${model.run.duration}` : null,
  ]);
  if (model.period) lines.push(`Period: ${model.period}`);
  if (when) lines.push(`Run: ${when}`);
  if (model.headline) lines.push("", model.headline);
  if (model.notices.length)
    lines.push("", "Please note:", ...model.notices.map((n) => `- ${n.text}`));
  if (model.metrics.length)
    lines.push(
      "",
      "Key figures:",
      ...model.metrics.map(
        (m) => `- ${m.label}: ${m.value.display}${m.hint ? ` (${m.hint})` : ""}`,
      ),
    );
  for (const section of model.sections) lines.push("", ...sectionText(section));
  if (model.recommendations.length)
    lines.push("", "Suggested next steps:", ...model.recommendations.map((r) => `- ${r}`));
  return `${lines.join("\n").trim()}\n`;
}

/** The tables worth exporting: those that have rows. */
export const exportableTables = (model: ReportModel): TableSection[] =>
  model.sections.filter((s): s is TableSection => s.kind === "table" && s.rows.length > 0);
