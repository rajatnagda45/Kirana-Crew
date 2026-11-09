"use client";
import { Component, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Copy,
  Download,
  Info,
  Loader2,
  Printer,
  XCircle,
} from "lucide-react";
import { statusInfo, type Tone, type WorkflowView } from "@/lib/workflow-contract";
import { copyText, downloadFile, printHtmlDocument } from "./export";
import { csvFileName, tableToCsv } from "./reports/csv";
import { formatDateTime } from "./reports/format";
import { buildReport } from "./reports";
import { printHtml } from "./reports/printHtml";
import { exportableTables, summaryText, toPlainText } from "./reports/text";
import type { Cell, Notice, ReportModel, Section, TableSection } from "./reports/types";
import { panel, TONE_COLOR, ui } from "./styles";

const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

const h3: CSSProperties = { ...ui.heading, fontSize: 15, fontWeight: 700, margin: "18px 0 8px" };

export function StatusPill({ status }: { status: string }) {
  const info = statusInfo(status);
  const Icon =
    info.tone === "good"
      ? CheckCircle
      : info.tone === "bad"
        ? XCircle
        : info.tone === "active"
          ? Loader2
          : info.tone === "warn"
            ? AlertTriangle
            : Clock;
  return (
    <span style={ui.pill(TONE_COLOR[info.tone])} data-status={status}>
      <Icon
        size={11}
        aria-hidden="true"
        style={info.tone === "active" ? { animation: "wf-spin 1s linear infinite" } : undefined}
      />
      {info.label}
    </span>
  );
}

const cellColor = (cell: Cell): string | undefined =>
  cell.tone ? TONE_COLOR[cell.tone] : cell.value === null ? "var(--kirana-muted-foreground)" : undefined;

function NoticeList({ notices }: { notices: Notice[] }) {
  if (!notices.length) return null;
  const tone = (n: Notice): Tone => (n.severity === "error" ? "bad" : n.severity === "warn" ? "warn" : "neutral");
  return (
    <ul aria-label="Things to know before relying on these figures" style={{ listStyle: "none", padding: 0, margin: "0 0 12px" }}>
      {notices.map((n, i) => {
        const Icon = n.severity === "error" ? XCircle : n.severity === "warn" ? AlertTriangle : Info;
        return (
          <li key={i} style={panel(tone(n))}>
            <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: TONE_COLOR[tone(n)] }} />
            <div>
              <span>{n.text}</span>
              {n.detail && n.detail !== n.text && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ ...ui.muted, cursor: "pointer" }}>Technical detail</summary>
                  <code style={{ ...ui.muted, wordBreak: "break-word" }}>{n.detail}</code>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Metrics({ model }: { model: ReportModel }) {
  if (!model.metrics.length) return null;
  return (
    <dl
      aria-label="Key figures"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(170px,100%),1fr))", gap: 10, margin: "0 0 4px" }}
    >
      {model.metrics.map((m) => (
        <div
          key={m.label}
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--kirana-border)", background: "var(--kirana-secondary)" }}
        >
          <dt style={ui.muted}>{m.label}</dt>
          <dd style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, fontFamily: "var(--font-display,system-ui)", color: cellColor(m.value) ?? "var(--kirana-foreground)" }}>
            {m.value.display}
          </dd>
          {m.hint && <dd style={{ ...ui.muted, margin: "2px 0 0" }}>{m.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

function TableView({ table }: { table: TableSection }) {
  const [all, setAll] = useState(false);
  const limit = table.limit ?? 25;
  const shown = all ? table.rows : table.rows.slice(0, limit);
  return (
    <section aria-label={table.title}>
      <h3 style={h3}>{table.title}</h3>
      {table.intro && <p style={{ ...ui.muted, margin: "-4px 0 8px" }}>{table.intro}</p>}
      {table.rows.length === 0 ? (
        <p style={{ ...ui.muted, margin: 0 }}>{table.empty ?? "Nothing to show."}</p>
      ) : (
        <>
          <div role="region" aria-label={`${table.title} table`} tabIndex={0} style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.key} scope="col" style={{ textAlign: c.align ?? "left", padding: "6px 10px", borderBottom: "1px solid var(--kirana-border)", color: "var(--kirana-muted-foreground)", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, i) => (
                  <tr key={i}>
                    {table.columns.map((c, ci) => {
                      const cell = row[c.key];
                      const Tag = ci === 0 ? "th" : "td";
                      return (
                        <Tag
                          key={c.key}
                          {...(ci === 0 ? { scope: "row" as const } : {})}
                          style={{ textAlign: c.align ?? "left", padding: "6px 10px", borderBottom: "1px solid var(--kirana-border)", fontWeight: ci === 0 ? 600 : 400, color: cell ? cellColor(cell) : undefined }}
                        >
                          {cell?.display ?? ""}
                        </Tag>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.rows.length > limit && (
            <button type="button" aria-expanded={all} onClick={() => setAll(!all)} style={{ ...ui.btn(), marginTop: 8 }}>
              {all ? `Show first ${limit}` : `Show all ${table.rows.length} rows`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function SectionView({ section }: { section: Section }) {
  if (section.kind === "table") return <TableView table={section} />;
  if (section.kind === "note")
    return (
      <section aria-label={section.title ?? "Note"} style={{ margin: "12px 0" }}>
        {section.title && <h3 style={h3}>{section.title}</h3>}
        <div style={panel(section.tone ?? "neutral")}>{section.text}</div>
      </section>
    );
  return (
    <section aria-label={section.title}>
      <h3 style={h3}>{section.title}</h3>
      {section.items.length === 0 ? (
        <p style={{ ...ui.muted, margin: 0 }}>{section.empty ?? "Nothing to show."}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {section.items.map((item, i) => (
            <li key={i} style={panel(section.items[i].tone ?? "neutral")}>
              <div>
                <strong>{item.text}</strong>
                {item.detail && <div style={{ ...ui.muted, marginTop: 2 }}>{item.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Actions({ model, view }: { model: ReportModel; view: WorkflowView }) {
  const [feedback, setFeedback] = useState("");
  const tables = useMemo(() => exportableTables(model), [model]);
  const [pick, setPick] = useState(0);
  const say = (ok: boolean, good: string, bad: string) => setFeedback(ok ? good : bad);

  const download = () => {
    const table = tables[Math.min(pick, tables.length - 1)];
    if (!table) return;
    const name = csvFileName([model.title, table.title, model.period ?? view.created_at?.slice(0, 10)]);
    say(downloadFile(name, tableToCsv(table)), `Downloaded ${name}`, "Could not download the file.");
  };

  return (
    <div role="group" aria-label="Copy, print or download this report" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "0 0 14px" }}>
      <button type="button" style={ui.btn()} onClick={async () => say(await copyText(summaryText(model)), "Summary copied.", "Could not copy. Select the text and copy it instead.")}>
        <Copy size={13} aria-hidden="true" /> Copy summary
      </button>
      <button type="button" style={ui.btn()} onClick={async () => say(await copyText(toPlainText(model)), "Full report copied.", "Could not copy. Select the text and copy it instead.")}>
        <Copy size={13} aria-hidden="true" /> Copy full report
      </button>
      <button
        type="button"
        style={ui.btn()}
        onClick={() =>
          say(
            printHtmlDocument(printHtml(model, { printedAt: formatDateTime(new Date().toISOString()) ?? undefined })),
            "Opening the print window…",
            "Could not open the print window.",
          )
        }
      >
        <Printer size={13} aria-hidden="true" /> Print
      </button>
      {tables.length > 0 && (
        <>
          {tables.length > 1 && (
            <>
              <label htmlFor={`csv-${view.id}`} style={SR_ONLY}>
                Table to download
              </label>
              <select id={`csv-${view.id}`} value={pick} onChange={(e) => setPick(Number(e.target.value))} style={{ ...ui.input, width: "auto", maxWidth: "100%" }}>
                {tables.map((t, i) => (
                  <option key={t.id} value={i}>
                    {t.title}
                  </option>
                ))}
              </select>
            </>
          )}
          <button type="button" style={ui.btn()} onClick={download}>
            <Download size={13} aria-hidden="true" /> Download CSV
          </button>
        </>
      )}
      <span role="status" aria-live="polite" style={ui.muted}>
        {feedback}
      </span>
    </div>
  );
}

function Advanced({ view }: { view: WorkflowView }) {
  const [open, setOpen] = useState(false);
  return (
    <details style={{ marginTop: 18 }} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ ...ui.muted, cursor: "pointer" }}>Advanced: raw data</summary>
      {open && (
        <pre style={{ ...ui.muted, maxHeight: 320, overflow: "auto", background: "var(--kirana-accent)", borderRadius: 8, padding: 10, margin: "8px 0 0" }}>
          {JSON.stringify({ result: view.result, tasks: view.tasks, timeline: view.timeline, error: view.error }, null, 2)}
        </pre>
      )}
    </details>
  );
}

/** Keeps one bad report from taking the page down: shows the saved summary and the raw data instead. */
class ReportBoundary extends Component<{ view: WorkflowView; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const { view } = this.props;
    return (
      <div role="alert">
        <div style={panel("warn")}>This report could not be displayed in the usual way.</div>
        {view.summary && <p style={{ fontSize: 14 }}>{view.summary}</p>}
        <Advanced view={view} />
      </div>
    );
  }
}

function Report({ view, compactHeader, hideHeadline }: { view: WorkflowView; compactHeader?: boolean; hideHeadline?: boolean }) {
  const model = useMemo(() => buildReport(view), [view]);
  const info = statusInfo(view.status);
  const when = [
    model.run.started && `Started ${model.run.started}`,
    model.run.finished && `Finished ${model.run.finished}`,
    model.run.duration && `Took ${model.run.duration}`,
  ].filter(Boolean);
  // A run that is only asking a question has no report to copy or print yet.
  const showActions =
    view.status !== "running" &&
    view.status !== "needs_clarification" &&
    (model.headline || model.metrics.length || model.sections.length);

  return (
    <article aria-label={`${model.title} report`} data-report-status={view.status}>
      {compactHeader ? (
        model.period && <p style={{ ...ui.muted, margin: "0 0 10px" }}>Period: {model.period}</p>
      ) : (
      <header style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <h2 style={{ ...ui.heading, fontSize: 18, fontWeight: 800 }}>{model.title}</h2>
          <StatusPill status={view.status} />
          {model.period && <span style={ui.muted}>{model.period}</span>}
        </div>
        {when.length > 0 && <p style={{ ...ui.muted, margin: "4px 0 0" }}>{when.join(" · ")}</p>}
        {info.explain && view.status !== "completed" && (
          <p style={{ ...ui.muted, margin: "4px 0 0" }}>{info.explain}</p>
        )}
      </header>
      )}

      {model.headline && !hideHeadline && (
        <p
          style={{ margin: "0 0 14px", padding: "12px 14px", borderRadius: 10, borderLeft: `4px solid ${TONE_COLOR[info.tone]}`, background: "var(--kirana-secondary)", fontSize: 15, lineHeight: 1.5, color: "var(--kirana-foreground)", overflowWrap: "anywhere" }}
        >
          {model.headline}
        </p>
      )}

      <NoticeList notices={model.notices} />
      {showActions && <Actions model={model} view={view} />}
      <Metrics model={model} />
      {model.sections.map((s) => (
        <SectionView key={s.id} section={s} />
      ))}
      {model.recommendations.length > 0 && (
        <section aria-label="What to do next">
          <h3 style={h3}>What to do next</h3>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6 }}>
            {model.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}
      <Advanced view={view} />
      <style>{`@keyframes wf-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){[data-status="running"] svg{animation:none!important}}`}</style>
    </article>
  );
}

/** `compactHeader`: leave out the title, status and times (the run history row above shows them). */
export function ReportView({
  view,
  compactHeader,
  hideHeadline,
}: {
  view: WorkflowView;
  compactHeader?: boolean;
  /** Leave out the headline (the question is shown by the answer form instead). */
  hideHeadline?: boolean;
}) {
  return (
    <ReportBoundary view={view}>
      <Report view={view} compactHeader={compactHeader} hideHeadline={hideHeadline} />
    </ReportBoundary>
  );
}
