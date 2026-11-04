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
import { toast } from "sonner";
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
    id: "erp-live",
    name: "ERPNext (live)",
    provider: "Your ERPNext site, read-only",
    desc: "All inventory, sales, procurement and finance answers and dashboards are read from your live ERPNext through governed, read-only tools. The app has no built-in data.",
    docs: "Requires ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET and NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json.",
    configKeys: ["ERPNEXT_URL", "ERPNEXT_API_KEY (secret)", "ERPNEXT_API_SECRET (secret)"],
  },
  {
    id: "gnani",
    name: "Gnani AI (Voice)",
    provider: "Gnani.ai",
    desc: "Prisma STT (speech-to-text) and Timbre TTS (text-to-speech) for Kannada, Hindi, and English voice interaction.",
    docs: "Primary voice provider: speech-to-text, spoken replies and the hands-free Live mode. Gemini is used only if Gnani is unreachable.",
    configKeys: [
      "GNANI_API_KEY (secret)",
      "AGENT_TOWN_STT_PROVIDER=gnani",
      "AGENT_TOWN_TTS_PROVIDER=gnani",
    ],
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

interface ServiceStatus {
  id: string;
  status: string;
  available?: boolean;
}
interface VoiceProviders {
  stt: { configured: boolean };
  tts: { configured: boolean };
}

function IntegrationCard({
  integ,
  gatewayConnected,
  serviceById,
  voice,
}: {
  integ: (typeof INTEGRATIONS)[0];
  gatewayConnected: boolean;
  serviceById: Record<string, ServiceStatus>;
  voice: VoiceProviders | null;
}) {
  const [open, setOpen] = useState(false);

  let status: "connected" | "partial" | "disconnected" = "disconnected";
  if (integ.id === "openclaw") status = gatewayConnected ? "connected" : "disconnected";
  // Every status below comes from the running server, never from a constant.
  const fromService = (id: string) => {
    const service = serviceById[id];
    if (!service) return "disconnected" as const;
    return service.available
      ? ("connected" as const)
      : service.status === "unverified"
        ? ("partial" as const)
        : ("disconnected" as const);
  };
  if (integ.id === "erp-live") status = fromService("erpnext");
  if (integ.id === "nightshift") status = fromService("nightshift");
  if (integ.id === "gnani")
    status =
      voice?.stt.configured && voice?.tts.configured
        ? "connected"
        : voice?.stt.configured || voice?.tts.configured
          ? "partial"
          : "disconnected";

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
        ? integ.id === "erp-live" || integ.id === "nightshift"
          ? "Configured, not checked recently"
          : "Manual setup required"
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
  const { binding, loading: bindingLoading, reload: reloadBinding } = useNammaOpsBinding();
  const [dashboard, setDashboard] = useState<{ data_source?: string } | null>(null);
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [voice, setVoice] = useState<VoiceProviders | null>(null);
  const [settingUp, setSettingUp] = useState(false);

  // Discovery and grants happen only through the existing setup path (Phase C review + grants).
  const setupWorkforce = async () => {
    setSettingUp(true);
    try {
      const { setup } = await fetchNammaOps<{
        setup: { blockers: string[]; disabled: Array<{ business_capability: string }> };
      }>("/setup", {});
      if (setup.blockers.length)
        toast.error(`Setup finished with blockers: ${setup.blockers.join("; ")}`);
      else toast.success("Workforce set up: ERP capabilities discovered, reviewed and granted.");
      await reloadBinding();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Setup failed");
    } finally {
      setSettingUp(false);
    }
  };

  useEffect(() => {
    // GET /dashboard returns data_source at the top level.
    fetchNammaOps<{ data_source?: string }>("/dashboard")
      .then((r) => setDashboard({ data_source: r.data_source }))
      .catch(() => {});
    runtimeRequest<{ services: ServiceStatus[] }>("services")
      .then((r) => setServices(r.services ?? []))
      .catch(() => {});
    fetch("/api/tasks/voice/providers")
      .then((r) => r.json())
      .then((r) => setVoice(r.providers ?? null))
      .catch(() => {});
  }, []);

  const gatewayConnected = state.connection === "connected";
  const dataSource = dashboard?.data_source ?? "";
  const serviceById = Object.fromEntries(services.map((service) => [service.id, service]));

  const availableCapabilities = binding.filter((b) => b.availability === "available").length;
  const totalCapabilities = binding.length;

  return (
    <div style={s.page}>
      <div
        style={{
          marginBottom: 24,
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={s.title}>Integrations</h1>
          <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
            External service connections and API configuration
          </p>
        </div>
        {!bindingLoading && availableCapabilities < totalCapabilities && (
          <button
            type="button"
            disabled={settingUp}
            onClick={() => void setupWorkforce()}
            title="Discover ERP tools, review them and grant each agent its capabilities (POST /api/nammaops/setup)"
            style={{
              padding: "8px 14px",
              borderRadius: 9,
              border: "none",
              background: "var(--kirana-primary)",
              color: "var(--kirana-primary-foreground)",
              fontWeight: 700,
              fontSize: 13,
              cursor: settingUp ? "wait" : "pointer",
            }}
          >
            {settingUp ? "Setting up…" : "Set up workforce"}
          </button>
        )}
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
            value: dataSource.includes("erpnext") ? "ERPNext live" : "Not connected",
            color: dataSource.includes("erpnext")
              ? "var(--kirana-success)"
              : "var(--kirana-destructive)",
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
            serviceById={serviceById}
            voice={voice}
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
