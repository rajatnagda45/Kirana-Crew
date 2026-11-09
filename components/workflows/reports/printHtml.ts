/**
 * The printable page for a report: one self-contained HTML string, light theme, system fonts, no
 * reliance on the app's CSS variables. It is written into a hidden iframe and printed from there,
 * which avoids fighting the dark, fixed-height app shell. Every table row is included.
 */
import type { ReportModel, Section } from "./types";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const STYLE = `
  @page { margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  .meta { color: #555; margin: 0 0 10px; }
  .summary { font-size: 14px; margin: 10px 0; padding: 8px 10px; border-left: 4px solid #444; background: #f4f4f4; }
  .notice { margin: 4px 0; padding: 6px 9px; border: 1px solid #999; border-radius: 4px; }
  .notice.warn, .notice.error { border-color: #b36b00; background: #fff6e5; }
  .metrics { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
  .metric { border: 1px solid #bbb; border-radius: 4px; padding: 6px 10px; min-width: 130px; }
  .metric b { display: block; font-size: 15px; }
  .metric small { color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
  th, td { border: 1px solid #bbb; padding: 3px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  td.r, th.r { text-align: right; }
  tr { break-inside: avoid; }
  ul { margin: 4px 0 8px; padding-left: 18px; }
  .foot { margin-top: 18px; color: #666; font-size: 10px; }
`;

function sectionHtml(section: Section): string {
  if (section.kind === "note")
    return `${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ""}<p>${escapeHtml(section.text)}</p>`;
  if (section.kind === "list")
    return `<h2>${escapeHtml(section.title)}</h2><ul>${
      section.items
        .map((i) => `<li><b>${escapeHtml(i.text)}</b>${i.detail ? ` ${escapeHtml(i.detail)}` : ""}</li>`)
        .join("") || `<li>${escapeHtml(section.empty ?? "None.")}</li>`
    }</ul>`;
  const head = section.columns
    .map((c) => `<th${c.align === "right" ? ' class="r"' : ""}>${escapeHtml(c.label)}</th>`)
    .join("");
  const body = section.rows
    .map(
      (row) =>
        `<tr>${section.columns
          .map((c) => `<td${c.align === "right" ? ' class="r"' : ""}>${escapeHtml(row[c.key]?.display ?? "")}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<h2>${escapeHtml(section.title)}</h2>${section.intro ? `<p class="meta">${escapeHtml(section.intro)}</p>` : ""}${
    section.rows.length
      ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      : `<p>${escapeHtml(section.empty ?? "No rows.")}</p>`
  }`;
}

/** @param storeName shown in the header when known (the app has no store-name setting yet) */
export function printHtml(model: ReportModel, options: { storeName?: string; printedAt?: string } = {}): string {
  const when = [
    model.run.started ? `Run ${model.run.started}` : null,
    model.run.duration ? `took ${model.run.duration}` : null,
  ].filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(model.title)}${
    model.period ? ` – ${escapeHtml(model.period)}` : ""
  }</title><style>${STYLE}</style></head><body>
<h1>${escapeHtml(options.storeName ? `${options.storeName}: ${model.title}` : model.title)}</h1>
<p class="meta">${escapeHtml(
    [model.statusLabel, model.period, ...when].filter(Boolean).join(" · "),
  )}</p>
${model.headline ? `<div class="summary">${escapeHtml(model.headline)}</div>` : ""}
${model.notices
  .map((n) => `<div class="notice ${n.severity}">${escapeHtml(n.text)}</div>`)
  .join("")}
${
  model.metrics.length
    ? `<div class="metrics">${model.metrics
        .map(
          (m) =>
            `<div class="metric"><small>${escapeHtml(m.label)}</small><b>${escapeHtml(m.value.display)}</b>${
              m.hint ? `<small>${escapeHtml(m.hint)}</small>` : ""
            }</div>`,
        )
        .join("")}</div>`
    : ""
}
${model.sections.map(sectionHtml).join("\n")}
${
  model.recommendations.length
    ? `<h2>Suggested next steps</h2><ul>${model.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
    : ""
}
<p class="foot">${escapeHtml(options.printedAt ? `Printed ${options.printedAt}. ` : "")}Figures come from ERPNext records and were not estimated unless marked.</p>
</body></html>`;
}
