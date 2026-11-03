"use client";
import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Database,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Chart } from "./charts";
import { formatValue } from "@/lib/format";
import {
  useDashboard,
  type DashboardCard,
  type DashboardTable,
  type DateRange,
  type ManagementDashboard,
} from "@/lib/hooks/useDashboard";

const INK = "var(--kirana-foreground)";
const MUTED = "var(--kirana-muted-foreground)";

export const panel: React.CSSProperties = {
  background: "var(--kirana-card)",
  border: "1px solid var(--kirana-border)",
  borderRadius: 14,
  padding: 16,
  minWidth: 0,
};

const TONE = {
  ok: { color: "var(--kirana-success)", Icon: CheckCircle2, label: "OK" },
  warn: { color: "var(--kirana-primary)", Icon: CircleAlert, label: "Attention" },
  bad: { color: "var(--kirana-destructive)", Icon: AlertTriangle, label: "Action needed" },
} as const;

/** ERPNext "Number Card". Status tone is shown with an icon + label, never colour alone. */
export function NumberCard({ card }: { card: DashboardCard }) {
  const tone = card.tone && card.tone !== "ok" ? TONE[card.tone] : null;
  return (
    <div style={{ ...panel, padding: "14px 16px" }}>
      <div
        style={{
          fontSize: 12,
          color: MUTED,
          marginBottom: 6,
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        {card.label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          color: INK,
          fontFamily: "var(--font-display,system-ui)",
        }}
        title={typeof card.value === "number" ? formatValue(card.value, card.unit) : undefined}
      >
        {formatValue(card.value, card.unit, {
          compact: card.unit === "INR" && Math.abs(Number(card.value)) >= 1e5,
        })}
      </div>
      {tone && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11.5,
            color: tone.color,
            display: "flex",
            gap: 5,
            alignItems: "center",
          }}
        >
          <tone.Icon size={13} /> {tone.label}
        </div>
      )}
    </div>
  );
}

/** Sortable plain table; first 12 rows with "show all". */
export function DataTable({ table, title }: { table: DashboardTable; title?: string }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? table.rows.filter((row) =>
          Object.values(row).some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(q),
          ),
        )
      : table.rows;
    if (!sort) return matched;
    return [...matched].sort((a, b) => {
      const x = a[sort.key],
        y = b[sort.key];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (
        (typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y))) * sort.dir
      );
    });
  }, [table.rows, sort, query]);
  const shown = all ? rows : rows.slice(0, 12);
  return (
    <div style={panel}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          alignItems: "center",
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        {title && <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: INK }}>{title}</h3>}
        {table.rows.length > 12 && (
          <input
            type="search"
            placeholder="Search…"
            aria-label={`Search ${title ?? "table"}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              background: "var(--kirana-secondary)",
              border: "1px solid var(--kirana-border)",
              color: INK,
              borderRadius: 8,
              padding: "5px 9px",
              fontSize: 12.5,
              minWidth: 180,
            }}
          />
        )}
      </div>
      {!table.rows.length ? (
        <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>No rows.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th
                    key={c.key}
                    onClick={() =>
                      setSort((s) => ({
                        key: c.key,
                        dir: s?.key === c.key && s.dir === -1 ? 1 : -1,
                      }))
                    }
                    style={{
                      textAlign:
                        c.unit || typeof table.rows[0]?.[c.key] === "number" ? "right" : "left",
                      padding: "7px 10px",
                      color: MUTED,
                      fontWeight: 600,
                      borderBottom: "1px solid var(--kirana-border)",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                    aria-sort={
                      sort?.key === c.key
                        ? sort.dir === 1
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    {c.label}
                    {sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr
                  key={i}
                  style={{
                    borderBottom:
                      "1px solid color-mix(in oklab,var(--kirana-border) 60%,transparent)",
                  }}
                >
                  {table.columns.map((c) => (
                    <td
                      key={c.key}
                      style={{
                        padding: "7px 10px",
                        color: INK,
                        textAlign: c.unit || typeof row[c.key] === "number" ? "right" : "left",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatValue(row[c.key], c.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 12 && (
            <button type="button" onClick={() => setAll((v) => !v)} style={linkButton}>
              {all ? "Show fewer" : `Show all ${rows.length} rows`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const linkButton: React.CSSProperties = {
  marginTop: 8,
  background: "none",
  border: "none",
  color: "var(--kirana-primary)",
  cursor: "pointer",
  fontSize: 12.5,
  padding: 0,
};

const localDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("en-CA");
};

const PRESETS: Array<{ id: string; label: string; days: number }> = [
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "365", label: "1 year", days: 365 },
];

/** Date range in one row above the charts: presets plus a custom from/to. */
export function DateRangeFilter({
  value,
  onChange,
}: {
  value: DateRange & { preset?: string };
  onChange: (r: DateRange & { preset?: string }) => void;
}) {
  const active = value.preset ?? "30";
  const btn = (on: boolean): React.CSSProperties => ({
    padding: "6px 11px",
    borderRadius: 8,
    border: "1px solid var(--kirana-border)",
    background: on ? "color-mix(in oklab,var(--kirana-primary) 16%,transparent)" : "transparent",
    color: on ? "var(--kirana-primary)" : MUTED,
    fontSize: 12.5,
    fontWeight: on ? 700 : 500,
    cursor: "pointer",
  });
  const input: React.CSSProperties = {
    background: "var(--kirana-secondary)",
    border: "1px solid var(--kirana-border)",
    color: INK,
    borderRadius: 8,
    padding: "5px 8px",
    fontSize: 12.5,
    colorScheme: "dark",
  };
  return (
    <div
      style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
      role="group"
      aria-label="Date range"
    >
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          style={btn(active === p.id)}
          onClick={() => onChange({ preset: p.id, from: localDay(-(p.days - 1)), to: localDay() })}
        >
          {p.label}
        </button>
      ))}
      <input
        type="date"
        aria-label="From"
        style={input}
        value={value.from ?? ""}
        onChange={(e) =>
          onChange({
            preset: "custom",
            from: e.target.value || undefined,
            to: value.to ?? localDay(),
          })
        }
      />
      <span style={{ color: MUTED, fontSize: 12 }}>to</span>
      <input
        type="date"
        aria-label="To"
        style={input}
        value={value.to ?? ""}
        onChange={(e) =>
          onChange({ preset: "custom", from: value.from, to: e.target.value || undefined })
        }
      />
    </div>
  );
}

/** Where the numbers come from, stated plainly (fixture vs live, verification). */
export function SourceBadge({ data }: { data: ManagementDashboard }) {
  const live = data.source === "erpnext";
  return (
    <span
      title={`Correlation ${data.correlation_id} · ${data.invocation_ids.length} governed ERP reads`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        padding: "4px 9px",
        borderRadius: 999,
        border: "1px solid var(--kirana-border)",
        color: live ? "var(--kirana-success)" : "var(--kirana-primary)",
      }}
    >
      <Database size={12} />
      {live ? "Live ERPNext · read, not reconciled" : "Test fixture · synthetic data"}
      <span style={{ color: MUTED }}>· {data.invocation_ids.length} governed reads</span>
    </span>
  );
}

export function Unavailable({ items }: { items: ManagementDashboard["sections_unavailable"] }) {
  if (!items.length) return null;
  return (
    <div
      style={{
        ...panel,
        borderColor: "color-mix(in oklab,var(--kirana-destructive) 50%,var(--kirana-border))",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          color: INK,
          fontWeight: 700,
          fontSize: 13.5,
          marginBottom: 6,
        }}
      >
        <ShieldAlert size={15} color="var(--kirana-destructive)" /> Some sections are unavailable
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, color: MUTED, fontSize: 12.5 }}>
        {items.map((item) => (
          <li key={item.capability}>
            <code>{item.capability}</code> ({item.status}): {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartCard({
  title,
  children,
  wide,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div style={{ ...panel, gridColumn: wide ? "1 / -1" : undefined }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 700, color: INK }}>{title}</h3>
      {children}
    </div>
  );
}

export interface DashboardViewProps {
  name: string;
  title: string;
  subtitle: string;
  /** Chart ids in display order; ids listed in `wide` span the full row. */
  charts?: string[];
  wide?: string[];
  tables?: Array<{ id: string; title: string }>;
  /** Existing workflow controls for this area (kept from the hackathon pages). */
  actions?: ReactNode;
  children?: ReactNode;
  /** Ranges do not apply to point-in-time dashboards (stock, ageing). */
  ranged?: boolean;
  /** Point-in-time dashboards show an "as of" date picker instead. */
}

/** ERPNext workspace layout: number cards, a chart grid, then tables. */
export function DashboardView({
  name,
  title,
  subtitle,
  charts,
  wide = [],
  tables = [],
  actions,
  children,
  ranged = true,
}: DashboardViewProps) {
  const [range, setRange] = useState<DateRange & { preset?: string }>({});
  const { data, error, loading, refresh } = useDashboard(name, { from: range.from, to: range.to });
  const chartIds = charts ?? Object.keys(data?.charts ?? {});
  return (
    <div style={{ padding: "22px 26px 40px", overflowY: "auto", height: "100%", color: INK }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "flex-start",
          marginBottom: 14,
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "var(--font-display,system-ui)",
              fontSize: 26,
              fontWeight: 800,
              margin: "0 0 4px",
            }}
          >
            {title}
          </h1>
          <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>{subtitle}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {data && <SourceBadge data={data} />}
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh"
            style={{
              ...linkButton,
              marginTop: 0,
              display: "inline-flex",
              gap: 5,
              alignItems: "center",
              color: MUTED,
            }}
          >
            <RefreshCw
              size={13}
              style={loading ? { animation: "spin 1s linear infinite" } : undefined}
            />{" "}
            Refresh
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        {ranged ? (
          <DateRangeFilter value={range} onChange={setRange} />
        ) : (
          <label
            style={{ fontSize: 12.5, color: MUTED, display: "flex", gap: 8, alignItems: "center" }}
          >
            As of
            <input
              type="date"
              value={range.to ?? ""}
              onChange={(e) => setRange({ to: e.target.value || undefined })}
              style={{
                background: "var(--kirana-secondary)",
                border: "1px solid var(--kirana-border)",
                color: INK,
                borderRadius: 8,
                padding: "5px 8px",
                fontSize: 12.5,
                colorScheme: "dark",
              }}
            />
          </label>
        )}
        {data && (
          <span style={{ fontSize: 12, color: MUTED }}>
            {ranged ? `${data.range.from} → ${data.range.to}` : `As of ${data.range.to}`}
          </span>
        )}
      </div>

      {actions && <div style={{ marginBottom: 16 }}>{actions}</div>}

      {error && (
        <div style={{ ...panel, color: INK, marginBottom: 16 }}>
          <b>Could not load this dashboard.</b> <span style={{ color: MUTED }}>{error}</span>
          {/not set up/i.test(error) && (
            <p style={{ color: MUTED, fontSize: 12.5, margin: "6px 0 0" }}>
              Open Integrations and choose “Set up workforce” to discover and grant the ERP
              capabilities.
            </p>
          )}
        </div>
      )}
      {!data && loading && <p style={{ color: MUTED, fontSize: 13 }}>Loading governed ERP data…</p>}

      {data && (
        <div
          style={{
            display: "grid",
            gap: 14,
            opacity: loading ? 0.6 : 1,
            transition: "opacity .15s",
          }}
        >
          <Unavailable items={data.sections_unavailable} />
          {data.disclaimer && (
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                color: MUTED,
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <CircleAlert size={13} /> {data.disclaimer}
            </p>
          )}
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))",
            }}
          >
            {data.cards.map((card) => (
              <NumberCard key={card.id} card={card} />
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))",
            }}
          >
            {chartIds
              .filter((id) => data.charts[id])
              .map((id) => (
                <ChartCard key={id} title={data.charts[id].title ?? id} wide={wide.includes(id)}>
                  <Chart chart={data.charts[id]} />
                </ChartCard>
              ))}
          </div>
          {children}
          {tables
            .filter((t) => data.tables[t.id])
            .map((t) => (
              <DataTable key={t.id} title={t.title} table={data.tables[t.id]} />
            ))}
        </div>
      )}
    </div>
  );
}
