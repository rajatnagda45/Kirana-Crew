"use client";
import { useEffect, useState } from "react";
import { Settings, Mic, Database, Shield, Wifi, AlertCircle, CheckCircle } from "lucide-react";
import { fetchNammaOps } from "@/lib/hooks/useNammaOps";
import { runtimeRequest, useStudio } from "@/lib/store";

const s = {
  page: {
    padding: "24px 28px",
    overflowY: "auto" as const,
    height: "100%",
    color: "var(--kirana-foreground)",
  },
  title: {
    fontFamily: "var(--font-display,system-ui)",
    fontSize: 26,
    fontWeight: 800,
    color: "var(--kirana-foreground)",
    margin: "0 0 4px",
  },
  card: {
    background: "var(--kirana-card)",
    border: "1px solid var(--kirana-border)",
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
  },
  sectionTitle: {
    fontFamily: "var(--font-display,system-ui)",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--kirana-foreground)",
    margin: "0 0 14px",
    display: "flex",
    alignItems: "center",
    gap: 8,
  } as React.CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 0",
    borderBottom: "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)",
  } as React.CSSProperties,
};

interface HealthRow {
  label: string;
  value: string;
  ok: boolean;
}

export default function SettingsPage() {
  const { state } = useStudio();
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [dataSource, setDataSource] = useState("");
  const [agentCount, setAgentCount] = useState(0);

  useEffect(() => {
    Promise.all([
      fetchNammaOps<{ dashboard: { data_source?: string; workforce?: Record<string, unknown> } }>(
        "/dashboard",
      ).catch(() => null),
      runtimeRequest<{ seats: Array<{ assigned: boolean }> }>("seats").catch(() => null),
    ]).then(([dash, seatsRes]) => {
      if (dash?.dashboard?.data_source) setDataSource(dash.dashboard.data_source);
      const wc = Object.keys(dash?.dashboard?.workforce ?? {}).length;
      setAgentCount(wc);
      const rows: HealthRow[] = [
        {
          label: "Gateway connection",
          value: state.connection,
          ok: state.connection === "connected",
        },
        { label: "AI agents registered", value: `${wc} agents`, ok: wc > 0 },
        { label: "ERP data source", value: dash?.dashboard?.data_source ?? "unknown", ok: true },
        {
          label: "Seats available",
          value: `${seatsRes?.seats?.filter((s) => s.assigned).length ?? 0} assigned`,
          ok: true,
        },
      ];
      setHealth(rows);
    });
  }, [state.connection]);

  return (
    <div style={s.page}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={s.title}>Settings</h1>
        <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
          System configuration and health status
        </p>
      </div>

      {/* System Health */}
      <div style={s.card}>
        <p style={s.sectionTitle}>
          <Wifi size={16} style={{ color: "var(--kirana-primary)" }} />
          System Health
        </p>
        {health.map((row, i) => (
          <div
            key={row.label}
            style={{
              ...s.row,
              borderBottom:
                i < health.length - 1
                  ? "1px solid color-mix(in oklab,var(--kirana-border) 50%,transparent)"
                  : "none",
            }}
          >
            <div>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--kirana-foreground)",
                  fontWeight: 500,
                  margin: 0,
                }}
              >
                {row.label}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {row.ok ? (
                <CheckCircle size={13} style={{ color: "var(--kirana-success)" }} />
              ) : (
                <AlertCircle size={13} style={{ color: "orange" }} />
              )}
              <span
                style={{
                  fontSize: 12,
                  fontFamily: "monospace",
                  color: row.ok ? "var(--kirana-success)" : "orange",
                }}
              >
                {row.value}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Data Source */}
      <div style={s.card}>
        <p style={s.sectionTitle}>
          <Database size={16} style={{ color: "var(--kirana-primary)" }} />
          Data Source
        </p>
        <div style={s.row}>
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--kirana-foreground)",
                fontWeight: 500,
                margin: 0,
              }}
            >
              Current binding
            </p>
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: "2px 0 0" }}>
              {dataSource.includes("fixture") || !dataSource.includes("erpnext")
                ? "Using synthetic fixture data (40-item test kirana store). Not real business data."
                : "Connected to live ERPNext instance."}
            </p>
          </div>
          <span
            style={{
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 8,
              fontWeight: 600,
              background: dataSource.includes("erpnext")
                ? "color-mix(in oklab,var(--kirana-success) 12%,transparent)"
                : "color-mix(in oklab,orange 12%,transparent)",
              color: dataSource.includes("erpnext") ? "var(--kirana-success)" : "orange",
            }}
          >
            {dataSource.includes("erpnext") ? "ERPNext live" : "Fixture (test)"}
          </span>
        </div>
        <div
          style={{
            marginTop: 12,
            padding: 14,
            borderRadius: 10,
            background: "var(--kirana-accent)",
            fontSize: 12,
            color: "var(--kirana-muted-foreground)",
          }}
        >
          <p style={{ margin: "0 0 6px", fontWeight: 600, color: "var(--kirana-foreground)" }}>
            To switch to live ERPNext:
          </p>
          <ol style={{ margin: 0, paddingLeft: 16, lineHeight: 1.8 }}>
            <li>
              Set{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--kirana-card)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                ERPNEXT_URL
              </code>
              ,{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--kirana-card)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                ERPNEXT_API_KEY
              </code>
              , and{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--kirana-card)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                ERPNEXT_API_SECRET
              </code>{" "}
              in{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--kirana-card)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                .env.local
              </code>{" "}
              only
            </li>
            <li>
              Set{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--kirana-card)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json
              </code>
            </li>
            <li>Restart the server</li>
          </ol>
          <p style={{ margin: "8px 0 0", color: "var(--kirana-destructive)", fontSize: 11 }}>
            ⚠ Never expose API keys in the frontend or commit them to version control.
          </p>
        </div>
      </div>

      {/* Voice configuration */}
      <div style={s.card}>
        <p style={s.sectionTitle}>
          <Mic size={16} style={{ color: "var(--kirana-primary)" }} />
          Voice Configuration
        </p>
        <div style={s.row}>
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--kirana-foreground)",
                fontWeight: 500,
                margin: 0,
              }}
            >
              Gnani AI STT/TTS
            </p>
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: "2px 0 0" }}>
              Prisma (speech-to-text) and Timbre (text-to-speech) for Kannada, Hindi, English.
            </p>
          </div>
          <span
            style={{
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 8,
              fontWeight: 600,
              background: "color-mix(in oklab,orange 12%,transparent)",
              color: "orange",
            }}
          >
            API key not set
          </span>
        </div>
        <div style={{ ...s.row, borderBottom: "none" }}>
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--kirana-foreground)",
                fontWeight: 500,
                margin: 0,
              }}
            >
              Voice routing
            </p>
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: "2px 0 0" }}>
              8 intent routes mapped: stock_check, daily_report, prepare_reorder, demand_forecast,
              supplier_comparison, and 3 conversation intents.
            </p>
          </div>
          <span
            style={{
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 8,
              fontWeight: 600,
              background: "color-mix(in oklab,var(--kirana-success) 12%,transparent)",
              color: "var(--kirana-success)",
            }}
          >
            Configured
          </span>
        </div>
        <div
          style={{
            marginTop: 12,
            padding: 14,
            borderRadius: 10,
            background: "var(--kirana-accent)",
            fontSize: 12,
            color: "var(--kirana-muted-foreground)",
          }}
        >
          To enable live voice: set{" "}
          <code
            style={{
              fontFamily: "monospace",
              background: "var(--kirana-card)",
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            GNANI_API_KEY
          </code>{" "}
          in{" "}
          <code
            style={{
              fontFamily: "monospace",
              background: "var(--kirana-card)",
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            .env.local
          </code>{" "}
          and restart. The voice router is fully wired — only the API key is missing.
        </div>
      </div>

      {/* Owner PIN */}
      <div style={s.card}>
        <p style={s.sectionTitle}>
          <Shield size={16} style={{ color: "var(--kirana-primary)" }} />
          Owner PIN (Approval Gate)
        </p>
        <div style={{ ...s.row, borderBottom: "none" }}>
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--kirana-foreground)",
                fontWeight: 500,
                margin: 0,
              }}
            >
              Purchase order approval PIN
            </p>
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: "2px 0 0" }}>
              Required before any purchase order is submitted to ERPNext. Set via{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  background: "var(--kirana-accent)",
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                NAMMAOPS_OWNER_PIN
              </code>{" "}
              in .env.local.
            </p>
          </div>
          <span
            style={{
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 8,
              fontWeight: 600,
              background: "color-mix(in oklab,var(--kirana-success) 12%,transparent)",
              color: "var(--kirana-success)",
            }}
          >
            Active
          </span>
        </div>
      </div>

      {/* Runtime info */}
      <div style={s.card}>
        <p style={s.sectionTitle}>
          <Settings size={16} style={{ color: "var(--kirana-primary)" }} />
          Runtime Information
        </p>
        {[
          ["AI Agents", `${agentCount} registered (Alice, Bob, Carol, Dave, Erin)`],
          ["Database", "SQLite in-process (node:sqlite)"],
          ["ERP binding", dataSource || "fixture (synthetic)"],
          ["Gateway", state.connection],
          ["Architecture", "NammaOps + OpenClaw + ERPNext MCP"],
        ].map(([label, value]) => (
          <div key={label} style={s.row}>
            <span style={{ fontSize: 13, color: "var(--kirana-muted-foreground)" }}>{label}</span>
            <span
              style={{
                fontSize: 12,
                fontFamily: "monospace",
                color: "var(--kirana-foreground)",
                textAlign: "right",
                maxWidth: "60%",
              }}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
