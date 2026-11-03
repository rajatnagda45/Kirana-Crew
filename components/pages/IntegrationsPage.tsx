"use client";
import { useEffect, useState } from "react";
import {
  Plug,
  CheckCircle,
  XCircle,
  AlertCircle,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { useNammaOpsBinding, fetchNammaOps } from "@/lib/hooks/useNammaOps";
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
    marginBottom: 14,
  },
};

function statusIcon(state: string, avail: string) {
  if (avail === "available")
    return <CheckCircle size={14} style={{ color: "var(--kirana-success)", flexShrink: 0 }} />;
  if (avail === "unavailable" && state === "registered")
    return <AlertCircle size={14} style={{ color: "orange", flexShrink: 0 }} />;
  if (state === "not_discovered" || state === "unbound")
    return <XCircle size={14} style={{ color: "var(--kirana-destructive)", flexShrink: 0 }} />;
  return (
    <AlertCircle size={14} style={{ color: "var(--kirana-muted-foreground)", flexShrink: 0 }} />
  );
}

const INTEGRATIONS = [
  {
    id: "openclaw",
    name: "OpenClaw Gateway",
    provider: "OpenClaw / Agent runtime",
    desc: "Primary agent execution environment. Agents run here as independent processes connected via WebSocket.",
    docs: "Configured via GATEWAY_URL + GATEWAY_TOKEN env vars.",
    configKeys: ["GATEWAY_URL", "GATEWAY_TOKEN"],
  },
  {
    id: "erp-fixture",
    name: "ERPNext (Fixture)",
    provider: "Synthetic fixture data",
    desc: "TEST FIXTURE — 40-item kirana store with synthetic data. All 5 agents can read from this. Not real business data.",
    docs: "Active by default. Switch to live ERPNext with NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json",
    configKeys: [],
  },
  {
    id: "erp-live",
    name: "ERPNext (Live)",
    provider: "Real ERPNext instance",
    desc: "Connect your production ERPNext for real inventory, sales, and financial data.",
    docs: "Requires ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET env vars + binding.hvgerp.json.",
    configKeys: ["ERPNEXT_URL", "ERPNEXT_API_KEY (secret)", "ERPNEXT_API_SECRET (secret)"],
  },
  {
    id: "gnani",
    name: "Gnani AI (Voice)",
    provider: "Gnani.ai",
    desc: "Prisma STT (speech-to-text) and Timbre TTS (text-to-speech) for Kannada, Hindi, and English voice interaction.",
    docs: "Requires GNANI_API_KEY. Currently not connected — API key not configured.",
    configKeys: ["GNANI_API_KEY (secret)"],
  },
  {
    id: "nightshift",
    name: "Nightshift (Local LLM)",
    provider: "Self-hosted",
    desc: "Run agents against a local or self-hosted language model via the Nightshift provider.",
    docs: "Requires AGENT_PROVIDER=nightshift + NIGHTSHIFT_API_KEY env vars.",
    configKeys: ["AGENT_PROVIDER=nightshift", "NIGHTSHIFT_API_KEY"],
  },
  {
    id: "evon",
    name: "Evon v3.3",
    provider: "Self-hosted only",
    desc: "Self-hosted agent runtime. Documentation at docs/EVON.md.",
    docs: "Must be self-hosted. Not available as a cloud service.",
    configKeys: [],
  },
];

function IntegrationCard({
  integ,
  gatewayConnected,
  dataSource,
}: {
  integ: (typeof INTEGRATIONS)[0];
  gatewayConnected: boolean;
  dataSource: string;
}) {
  const [open, setOpen] = useState(false);

  let status: "connected" | "partial" | "disconnected" = "disconnected";
  if (integ.id === "openclaw") status = gatewayConnected ? "connected" : "disconnected";
  if (integ.id === "erp-fixture")
    status =
      dataSource === "fixture (synthetic, not real ERPNext data)" || !dataSource
        ? "connected"
        : "disconnected";
  if (integ.id === "erp-live")
    status =
      dataSource === "erpnext_live" || dataSource?.includes("erpnext")
        ? "connected"
        : "disconnected";
  if (integ.id === "gnani") status = "disconnected";
  if (integ.id === "nightshift") status = "disconnected";
  if (integ.id === "evon") status = "partial";

  const statusColor =
    status === "connected"
      ? "var(--kirana-success)"
      : status === "partial"
        ? "orange"
        : "var(--kirana-muted-foreground)";
  const statusLabel =
    status === "connected"
      ? "Connected"
      : status === "partial"
        ? "Manual setup required"
        : "Not configured";

  return (
    <div style={s.card}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: `color-mix(in oklab,${statusColor} 14%,transparent)`,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <Plug size={18} style={{ color: statusColor }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <h3
              style={{
                fontFamily: "var(--font-display,system-ui)",
                fontSize: 15,
                fontWeight: 700,
                color: "var(--kirana-foreground)",
                margin: 0,
              }}
            >
              {integ.name}
            </h3>
            <span
              style={{
                fontSize: 11,
                padding: "2px 7px",
                borderRadius: 5,
                background: `color-mix(in oklab,${statusColor} 12%,transparent)`,
                color: statusColor,
                fontWeight: 600,
              }}
            >
              {statusLabel}
            </span>
          </div>
          <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: "0 0 4px" }}>
            {integ.desc}
          </p>
          <p style={{ fontSize: 11, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            Provider: {integ.provider}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            background: "none",
            border: "none",
            color: "var(--kirana-muted-foreground)",
            cursor: "pointer",
            padding: 4,
          }}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--kirana-border)" }}>
          <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: "0 0 8px" }}>
            {integ.docs}
          </p>
          {integ.configKeys.length > 0 && (
            <div>
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--kirana-muted-foreground)",
                  textTransform: "uppercase",
                  margin: "0 0 6px",
                }}
              >
                Required configuration
              </p>
              {integ.configKeys.map((key) => (
                <div
                  key={key}
                  style={{
                    display: "inline-block",
                    padding: "2px 8px",
                    borderRadius: 5,
                    background: "var(--kirana-accent)",
                    color: "var(--kirana-foreground)",
                    fontFamily: "monospace",
                    fontSize: 11,
                    marginRight: 6,
                    marginBottom: 4,
                  }}
                >
                  {key.includes("(secret)") ? `${key.split(" ")[0]}=*****` : key}
                </div>
              ))}
              <p
                style={{ fontSize: 11, color: "var(--kirana-muted-foreground)", margin: "8px 0 0" }}
              >
                ⚠ API keys and secrets must be set as environment variables in .env.local only —
                never exposed in the frontend.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function IntegrationsPage() {
  const { state } = useStudio();
  const { binding, loading: bindingLoading } = useNammaOpsBinding();
  const [dashboard, setDashboard] = useState<{ data_source?: string } | null>(null);
  const [services, setServices] = useState<Array<{ id: string; name: string; status: string }>>([]);

  useEffect(() => {
    fetchNammaOps<{ dashboard: { data_source?: string } }>("/dashboard")
      .then((r) => setDashboard(r.dashboard))
      .catch(() => {});
    runtimeRequest<{ services: typeof services }>("services")
      .then((r) => setServices(r.services ?? []))
      .catch(() => {});
  }, []);

  const gatewayConnected = state.connection === "connected";
  const dataSource = dashboard?.data_source ?? "";

  const availableCapabilities = binding.filter((b) => b.availability === "available").length;
  const totalCapabilities = binding.length;

  return (
    <div style={s.page}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={s.title}>Integrations</h1>
        <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
          External service connections and API configuration
        </p>
      </div>

      {/* Summary */}
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 24 }}
      >
        {[
          {
            label: "Gateway",
            value: state.connection,
            color: gatewayConnected ? "var(--kirana-success)" : "var(--kirana-destructive)",
          },
          {
            label: "ERP Capabilities",
            value: `${availableCapabilities} / ${totalCapabilities}`,
            color: availableCapabilities > 0 ? "var(--kirana-success)" : "orange",
          },
          {
            label: "Data Source",
            value: dataSource.includes("erpnext")
              ? "ERPNext live"
              : dataSource.includes("fixture")
                ? "Fixture (test)"
                : "Unknown",
            color: dataSource.includes("erpnext") ? "var(--kirana-success)" : "orange",
          },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ ...s.card, padding: 16, marginBottom: 0 }}>
            <p
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--kirana-muted-foreground)",
                textTransform: "uppercase",
                margin: "0 0 6px",
              }}
            >
              {label}
            </p>
            <p
              style={{
                fontFamily: "var(--font-display,system-ui)",
                fontSize: 17,
                fontWeight: 700,
                color,
                margin: 0,
              }}
            >
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* Integration cards */}
      <div style={{ marginBottom: 24 }}>
        <p
          style={{
            fontFamily: "var(--font-display,system-ui)",
            fontSize: 17,
            fontWeight: 700,
            color: "var(--kirana-foreground)",
            margin: "0 0 14px",
          }}
        >
          Connected Services
        </p>
        {INTEGRATIONS.map((integ) => (
          <IntegrationCard
            key={integ.id}
            integ={integ}
            gatewayConnected={gatewayConnected}
            dataSource={dataSource}
          />
        ))}
      </div>

      {/* ERP capability matrix */}
      {binding.length > 0 && (
        <div style={s.card}>
          <p
            style={{
              fontFamily: "var(--font-display,system-ui)",
              fontSize: 15,
              fontWeight: 700,
              color: "var(--kirana-foreground)",
              margin: "0 0 14px",
            }}
          >
            ERP Business Capabilities
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--kirana-border)" }}>
                  {["Capability", "Tool", "Risk", "State", "Availability"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "6px 10px",
                        textAlign: "left",
                        fontSize: 10,
                        fontWeight: 700,
                        color: "var(--kirana-muted-foreground)",
                        textTransform: "uppercase",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {binding.map((b, i) => (
                  <tr
                    key={i}
                    style={{
                      borderBottom:
                        "1px solid color-mix(in oklab,var(--kirana-border) 40%,transparent)",
                    }}
                  >
                    <td
                      style={{
                        padding: "7px 10px",
                        color: "var(--kirana-foreground)",
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                    >
                      {b.business_capability}
                    </td>
                    <td
                      style={{
                        padding: "7px 10px",
                        color: "var(--kirana-muted-foreground)",
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                    >
                      {b.tool ?? "—"}
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background:
                            b.risk === "READ"
                              ? "color-mix(in oklab,var(--kirana-success) 12%,transparent)"
                              : "color-mix(in oklab,orange 12%,transparent)",
                          color: b.risk === "READ" ? "var(--kirana-success)" : "orange",
                          fontWeight: 600,
                        }}
                      >
                        {b.risk ?? "—"}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "7px 10px",
                        color: "var(--kirana-muted-foreground)",
                        fontSize: 11,
                      }}
                    >
                      {b.state}
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {statusIcon(b.state, b.availability)}
                        <span
                          style={{
                            fontSize: 11,
                            color:
                              b.availability === "available"
                                ? "var(--kirana-success)"
                                : "var(--kirana-muted-foreground)",
                          }}
                        >
                          {b.availability}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
