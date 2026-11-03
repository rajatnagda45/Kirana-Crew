"use client";
/**
 * Dependency-free SVG charts for the management dashboards. Categorical colour is assigned in a
 * fixed order (--kirana-chart-1..6, validated for the dark surface) and never cycled: a 7th
 * category folds into "Other". Text always uses text tokens; colour carries identity only.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { DashboardChart } from "@/lib/hooks/useDashboard";
import { formatValue } from "@/lib/format";

const SERIES = [1, 2, 3, 4, 5, 6].map((n) => `var(--kirana-chart-${n})`);
const OTHER = "var(--kirana-chart-other)";
const GRID = "var(--kirana-chart-grid)";
const INK = "var(--kirana-foreground)";
const MUTED = "var(--kirana-muted-foreground)";
const SURFACE = "var(--kirana-card)";
const W = 640;

const fmt = (v: number | null | undefined, unit?: string, compact = true) =>
  v === null || v === undefined ? "—" : formatValue(v, unit, { compact });

/** Rounded 4px end on the data side only; the baseline side stays square. */
function barPath(x: number, y: number, w: number, h: number, horizontal = false) {
  if (w <= 0 || h <= 0) return "";
  const r = Math.min(4, horizontal ? w / 2 : h / 2, horizontal ? h / 2 : w / 2);
  if (horizontal)
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(max: number) {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function Legend({ names, colors }: { names: string[]; colors: string[] }) {
  if (names.length < 2) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginBottom: 8 }}>
      {names.map((name, i) => (
        <span
          key={name}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: MUTED,
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: 3, background: colors[i] }} />
          {name}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        left: `${(x / W) * 100}%`,
        top: y,
        transform: `translate(${x > W * 0.6 ? "-100%" : "8px"}, -50%)`,
        pointerEvents: "none",
        background: "var(--kirana-popover)",
        border: "1px solid var(--kirana-border)",
        borderRadius: 8,
        padding: "6px 9px",
        fontSize: 12,
        color: INK,
        whiteSpace: "nowrap",
        zIndex: 5,
        boxShadow: "0 6px 18px rgba(0,0,0,.35)",
      }}
    >
      {children}
    </div>
  );
}

const Empty = () => (
  <div style={{ height: 160, display: "grid", placeItems: "center", color: MUTED, fontSize: 13 }}>
    No data in this range
  </div>
);

/** Vertical axis value ticks (recessive). */
function YGrid({
  max,
  top,
  height,
  left,
  unit,
}: {
  max: number;
  top: number;
  height: number;
  left: number;
  unit?: string;
}) {
  return (
    <>
      {[0, 0.5, 1].map((t) => {
        const y = top + height - t * height;
        return (
          <g key={t}>
            <line x1={left} x2={W - 8} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
            <text x={left - 6} y={y + 4} textAnchor="end" fontSize={11} fill={MUTED}>
              {fmt(max * t, unit)}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function LineChart({ chart }: { chart: DashboardChart }) {
  const [hover, setHover] = useState<number | null>(null);
  const { labels, series, unit } = chart;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!labels.length || !all.length) return <Empty />;
  const H = 220,
    top = 12,
    left = 56,
    bottom = 26;
  const height = H - top - bottom;
  const max = niceMax(Math.max(...all, 0));
  const x = (i: number) =>
    left + (labels.length === 1 ? 0 : (i / (labels.length - 1)) * (W - 8 - left));
  const y = (v: number) => top + height - (v / max) * height;
  const colors = series.map((_, i) => SERIES[i] ?? OTHER);
  const every = Math.ceil(labels.length / 8);
  return (
    <div>
      <Legend names={series.map((s) => s.name)} colors={colors} />
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={chart.title}>
          <YGrid max={max} top={top} height={height} left={left} unit={unit} />
          {labels.map((l, i) =>
            i % every === 0 ? (
              <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={11} fill={MUTED}>
                {l}
              </text>
            ) : null,
          )}
          {series.map((s, si) => {
            // Null values break the line: a gap is missing data, not zero.
            const segments: string[] = [];
            let current = "";
            s.values.forEach((v, i) => {
              if (v === null) {
                if (current) segments.push(current);
                current = "";
              } else current += `${current ? "L" : "M"}${x(i)},${y(v)}`;
            });
            if (current) segments.push(current);
            return segments.map((d, k) => (
              <path
                key={`${si}-${k}`}
                d={d}
                fill="none"
                stroke={colors[si]}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ));
          })}
          {hover !== null && (
            <>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={top}
                y2={top + height}
                stroke={MUTED}
                strokeDasharray="3 3"
              />
              {series.map((s, si) =>
                s.values[hover] !== null ? (
                  <circle
                    key={si}
                    cx={x(hover)}
                    cy={y(s.values[hover] as number)}
                    r={4.5}
                    fill={colors[si]}
                    stroke={SURFACE}
                    strokeWidth={2}
                  />
                ) : null,
              )}
            </>
          )}
          {labels.map((_, i) => (
            <rect
              key={i}
              x={x(i) - (W - left) / labels.length / 2}
              y={top}
              width={(W - left) / labels.length}
              height={height}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {hover !== null && (
          <Tooltip x={x(hover)} y={top + height / 2}>
            <div style={{ color: MUTED, marginBottom: 2 }}>{labels[hover]}</div>
            {series.map((s, si) => (
              <div key={s.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors[si] }} />
                {s.name}: <b>{fmt(s.values[hover], unit, false)}</b>
              </div>
            ))}
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function BarChart({ chart, single }: { chart: DashboardChart; single?: string }) {
  const [hover, setHover] = useState<{ i: number; s: number } | null>(null);
  const { labels, series, unit, stacked } = chart;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!labels.length || !all.length || all.every((v) => v === 0)) return <Empty />;
  const horizontal = labels.length > 6 || labels.some((l) => l.length > 10);
  const colors = series.map((_, i) =>
    single && series.length === 1 ? single : (SERIES[i] ?? OTHER),
  );
  const totals = labels.map((_, i) =>
    series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0),
  );
  const max = niceMax(stacked ? Math.max(...totals) : Math.max(...all, 0));
  const gap = 2;

  if (horizontal) {
    const left = 150,
      row = 26,
      top = 4;
    const H = top + labels.length * row + 20;
    const span = W - left - 60;
    const band = row - 6;
    const each = stacked ? band : Math.max(4, (band - gap * (series.length - 1)) / series.length);
    return (
      <div>
        <Legend names={series.map((s) => s.name)} colors={colors} />
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={chart.title}>
            <line x1={left} x2={left} y1={top} y2={H - 20} stroke={GRID} />
            {labels.map((label, i) => {
              let offset = 0;
              return (
                <g key={label + i}>
                  <text
                    x={left - 8}
                    y={top + i * row + row / 2 + 1}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={11.5}
                    fill={INK}
                  >
                    {label.length > 22 ? `${label.slice(0, 21)}…` : label}
                  </text>
                  {series.map((s, si) => {
                    const v = Math.max(0, s.values[i] ?? 0);
                    const w = (v / max) * span;
                    const x = left + (stacked ? offset : 0);
                    const y = top + i * row + 3 + (stacked ? 0 : si * (each + gap));
                    if (stacked) offset += w + (w ? gap : 0);
                    return (
                      <path
                        key={si}
                        d={barPath(x, y, Math.max(0, w - (stacked ? gap : 0)), each, true)}
                        fill={colors[si]}
                        opacity={hover && (hover.i !== i || hover.s !== si) ? 0.55 : 1}
                        onMouseEnter={() => setHover({ i, s: si })}
                        onMouseLeave={() => setHover(null)}
                      />
                    );
                  })}
                  {series.length === 1 && (
                    <text
                      x={left + ((series[0].values[i] ?? 0) / max) * span + 6}
                      y={top + i * row + row / 2 + 1}
                      dominantBaseline="middle"
                      fontSize={11}
                      fill={MUTED}
                    >
                      {fmt(series[0].values[i], unit)}
                    </text>
                  )}
                  <rect
                    x={0}
                    y={top + i * row}
                    width={W}
                    height={row}
                    fill="transparent"
                    onMouseEnter={() => setHover({ i, s: 0 })}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {hover && (
            <Tooltip x={left + 40} y={top + hover.i * row + row / 2}>
              <div style={{ color: MUTED, marginBottom: 2 }}>{labels[hover.i]}</div>
              {series.map((s) => (
                <div key={s.name}>
                  {series.length > 1 ? `${s.name}: ` : ""}
                  <b>{fmt(s.values[hover.i], unit, false)}</b>
                </div>
              ))}
            </Tooltip>
          )}
        </div>
      </div>
    );
  }

  const H = 220,
    top = 12,
    left = 56,
    bottom = 26;
  const height = H - top - bottom;
  const slot = (W - 8 - left) / labels.length;
  const band = Math.min(56, slot * 0.7);
  const each = stacked ? band : Math.max(3, (band - gap * (series.length - 1)) / series.length);
  return (
    <div>
      <Legend names={series.map((s) => s.name)} colors={colors} />
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={chart.title}>
          <YGrid max={max} top={top} height={height} left={left} unit={unit} />
          {labels.map((label, i) => {
            const x0 = left + i * slot + (slot - band) / 2;
            let stackTop = top + height;
            return (
              <g key={label + i}>
                {series.map((s, si) => {
                  const v = Math.max(0, s.values[i] ?? 0);
                  const h = (v / max) * height;
                  const x = stacked ? x0 : x0 + si * (each + gap);
                  const y = stacked ? stackTop - h : top + height - h;
                  if (stacked) stackTop -= h;
                  return (
                    <path
                      key={si}
                      d={barPath(x, y, each, Math.max(0, h - (stacked && h ? gap : 0)))}
                      fill={colors[si]}
                      opacity={hover && hover.i !== i ? 0.55 : 1}
                    />
                  );
                })}
                <text
                  x={left + i * slot + slot / 2}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fill={MUTED}
                >
                  {label}
                </text>
                <rect
                  x={left + i * slot}
                  y={top}
                  width={slot}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHover({ i, s: 0 })}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
        {hover && (
          <Tooltip x={left + hover.i * slot + slot / 2} y={top + height / 3}>
            <div style={{ color: MUTED, marginBottom: 2 }}>{labels[hover.i]}</div>
            {series.map((s, si) => (
              <div key={s.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors[si] }} />
                {series.length > 1 ? `${s.name}: ` : ""}
                <b>{fmt(s.values[hover.i], unit, false)}</b>
              </div>
            ))}
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function DonutChart({ chart }: { chart: DashboardChart }) {
  const [hover, setHover] = useState<number | null>(null);
  const slices = useMemo(() => {
    const rows = chart.labels
      .map((label, i) => ({ label, value: Math.max(0, chart.series[0]?.values[i] ?? 0) }))
      .filter((r) => r.value > 0);
    // Six fixed categorical slots; anything beyond folds into "Other" (never a generated hue).
    if (rows.length <= 6) return rows.map((r, i) => ({ ...r, color: SERIES[i] }));
    const head = rows.slice(0, 5).map((r, i) => ({ ...r, color: SERIES[i] }));
    const rest = rows.slice(5).reduce((a, r) => a + r.value, 0);
    return [...head, { label: `Other (${rows.length - 5})`, value: rest, color: OTHER }];
  }, [chart]);
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (!total) return <Empty />;
  const R = 78,
    r = 50,
    C = 100;
  // Cumulative start angles, computed up front (no mutation during render).
  const starts = slices.map(
    (_, i) =>
      -Math.PI / 2 + (slices.slice(0, i).reduce((a, x) => a + x.value, 0) / total) * Math.PI * 2,
  );
  const arcs = slices.map((s, i) => {
    const a0 = starts[i];
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, rr: number) => `${C + rr * Math.cos(rad)},${C + rr * Math.sin(rad)}`;
    const d =
      slices.length === 1
        ? `M${C - R},${C}A${R},${R} 0 1 1 ${C + R},${C}A${R},${R} 0 1 1 ${C - R},${C}M${C - r},${C}A${r},${r} 0 1 0 ${C + r},${C}A${r},${r} 0 1 0 ${C - r},${C}Z`
        : `M${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r},${r} 0 ${large} 0 ${p(a0, r)}Z`;
    return { ...s, d };
  });
  const focus = hover !== null ? arcs[hover] : null;
  return (
    <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
      <svg
        viewBox="0 0 200 200"
        width={180}
        height={180}
        role="img"
        aria-label={chart.title}
        style={{ flexShrink: 0 }}
      >
        {arcs.map((a, i) => (
          <path
            key={a.label}
            d={a.d}
            fill={a.color}
            stroke={SURFACE}
            strokeWidth={2}
            fillRule="evenodd"
            opacity={hover !== null && hover !== i ? 0.5 : 1}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        <text x={C} y={C - 4} textAnchor="middle" fontSize={focus ? 12 : 11} fill={MUTED}>
          {focus ? focus.label.slice(0, 16) : "Total"}
        </text>
        <text x={C} y={C + 16} textAnchor="middle" fontSize={16} fontWeight={700} fill={INK}>
          {fmt(focus ? focus.value : total, chart.unit)}
        </text>
      </svg>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, flex: 1, minWidth: 160 }}>
        {arcs.map((a, i) => (
          <li
            key={a.label}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12.5,
              padding: "3px 0",
              color: INK,
            }}
          >
            <span
              style={{ width: 10, height: 10, borderRadius: 3, background: a.color, flexShrink: 0 }}
            />
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {a.label}
            </span>
            <span style={{ color: MUTED }}>{Math.round((a.value / total) * 100)}%</span>
            <span style={{ minWidth: 64, textAlign: "right" }}>{fmt(a.value, chart.unit)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ordinal buckets (ageing, expiry): one hue, ordered left to right. */
export function AgingBars({ chart }: { chart: DashboardChart }) {
  return <BarChart chart={{ ...chart, labels: chart.labels }} single="var(--kirana-chart-1)" />;
}

export function Chart({ chart }: { chart: DashboardChart }) {
  if (chart.type === "line") return <LineChart chart={chart} />;
  if (chart.type === "donut") return <DonutChart chart={chart} />;
  if (chart.type === "aging") return <AgingBars chart={chart} />;
  return <BarChart chart={chart} />;
}
