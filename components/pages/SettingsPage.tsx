"use client";
import { useEffect, useState } from "react";
import { Settings, Mic, Database, Wifi, AlertCircle, CheckCircle } from "lucide-react";
import { fetchNammaOps } from "@/lib/hooks/useNammaOps";
import { useStudio } from "@/lib/store";
import OwnerPinCard from "@/components/settings/OwnerPinCard";
import AgentVoicesCard from "@/components/settings/AgentVoicesCard";

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

interface VoiceProviders {
  stt: { primary: string | null; fallback: string | null; configured: boolean };
  tts: { primary: string | null; fallback: string | null; configured: boolean };
  language: string;
}

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
  const [voice, setVoice] = useState<VoiceProviders | null>(null);

  useEffect(() => {
    // Voice status comes from the server, never from a constant.
    fetch("/api/tasks/voice/providers")
      .then((r) => r.json())
      .then((r) => setVoice(r.providers ?? null))
      .catch(() => setVoice(null));
    Promise.all([
      // GET /dashboard returns data_source and workforce at the top level.
      fetchNammaOps<{
        data_source?: string;
        workforce?: { agents?: Record<string, unknown> } | null;
      }>("/dashboard").catch(() => null),
    ]).then(([dash]) => {
      if (dash?.data_source) setDataSource(dash.data_source);
      const wc = Object.keys(dash?.workforce?.agents ?? {}).length;
      setAgentCount(wc);
      const rows: HealthRow[] = [
        {
          label: "Gateway connection",
          value: state.connection,
          ok: state.connection === "connected",
        },
        { label: "AI agents registered", value: `${wc} agents`, ok: wc > 0 },
        {
          label: "ERP data source",
          value: dash?.data_source ?? "not connected",
          ok: Boolean(dash?.data_source),
        },
        {
          label: "Seats available",
          value: `${state.seats.filter((seat) => seat.assigned).length} assigned`,
          ok: true,
        },
      ];
      setHealth(rows);
    });
  }, [state.connection, state.seats]);

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
              {dataSource.includes("erpnext")
                ? "Connected to your live ERPNext. Everything in the app is read from it, read-only."
                : "Not connected to ERPNext. The app has no built-in data, so dashboards and answers stay empty until it is."}
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
                : "color-mix(in oklab,var(--kirana-destructive) 12%,transparent)",
              color: dataSource.includes("erpnext")
                ? "var(--kirana-success)"
                : "var(--kirana-destructive)",
            }}
          >
            {dataSource.includes("erpnext") ? "ERPNext live" : "Not connected"}
          </span>
        </div>
        {!dataSource.includes("erpnext") && (
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
              To connect ERPNext:
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
        )}
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
              {voice
                ? `Speech-to-text: ${voice.stt.primary ?? "none"}${voice.stt.fallback ? ` (backup ${voice.stt.fallback})` : ""}. Spoken replies: ${voice.tts.primary ?? "none"}${voice.tts.fallback ? ` (backup ${voice.tts.fallback})` : ""}. Language: ${voice.language}.`
                : "Voice settings could not be read from the server."}
            </p>
          </div>
          <span
            style={{
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 8,
              fontWeight: 600,
              ...(voice?.stt.configured && voice?.tts.configured
                ? {
                    background: "color-mix(in oklab,var(--kirana-success) 12%,transparent)",
                    color: "var(--kirana-success)",
                  }
                : {
                    background: "color-mix(in oklab,orange 12%,transparent)",
                    color: "orange",
                  }),
            }}
          >
            {voice?.stt.configured && voice?.tts.configured
              ? "Active"
              : voice?.stt.configured || voice?.tts.configured
                ? "Partly configured"
                : "Not configured"}
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
              Spoken questions run the same governed, read-only workflows as typed ones: stock,
              sales, udhaar, expiry, suppliers, customers and store health.
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
            {dataSource.includes("erpnext") ? "Active" : "Waiting for ERPNext"}
          </span>
        </div>
        {!(voice?.stt.configured && voice?.tts.configured) && (
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
            and restart. Set AGENT_TOWN_STT_PROVIDER=gnani and AGENT_TOWN_TTS_PROVIDER=gnani too.
          </div>
        )}
      </div>

      {/* Owner PIN */}
      <OwnerPinCard />
      <AgentVoicesCard />

      {/* Runtime info */}
      <div style={s.card}>
        <p style={s.sectionTitle}>
          <Settings size={16} style={{ color: "var(--kirana-primary)" }} />
          Runtime Information
        </p>
        {[
          ["AI Agents", `${agentCount} NammaOps specialist(s) set up`],
          ["Database", "SQLite in-process (node:sqlite)"],
          ["ERP binding", dataSource || "not connected"],
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
