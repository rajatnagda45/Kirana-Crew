"use client";
import { useCallback, useEffect, useState } from "react";
import { Volume2 } from "lucide-react";
import { toast } from "sonner";
import { fetchNammaOps } from "@/lib/hooks/useNammaOps";
import { playBase64Audio } from "@/lib/voice/wavRecorder";

type Voices = Record<string, { name: string; voice: string; custom: boolean }>;

const ROLE_LABEL: Record<string, string> = {
  manager: "Manager",
  inventory: "Inventory",
  sales: "Sales",
  procurement: "Procurement",
  finance: "Finance",
};
const INTRO: Record<string, string> = {
  manager: "I am your store manager. Ask me how the shop is doing.",
  inventory: "I look after your stock and tell you what is running low.",
  sales: "I track your sales and your best customers.",
  procurement: "I watch your suppliers and your purchase orders.",
  finance: "I keep an eye on your udhaar and your accounts.",
};

/**
 * Each specialist speaks in its own Gnani Timbre voice. Choose one per agent and tap the speaker
 * to hear it (a short preview is synthesised, then cached). Changes apply to the next answer.
 */
export default function AgentVoicesCard() {
  const [voices, setVoices] = useState<Voices | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetchNammaOps<{ voices: Voices; available: string[] }>("/voices")
        .then((r) => {
          setVoices(r.voices);
          setAvailable(r.available);
        })
        .catch(() => setVoices(null)),
    [],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const choose = async (role: string, voice: string) => {
    try {
      const r = await fetchNammaOps<{ voices: Voices }>("/voices", { voices: { [role]: voice } });
      setVoices(r.voices);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the voice");
    }
  };

  const preview = async (role: string, name: string, voice: string) => {
    setPlaying(role);
    try {
      const res = await fetch("/api/tasks/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({
          text: `Hello, I am ${name}. ${INTRO[role]}`,
          voice,
          language: "en-IN",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Preview failed (${res.status})`);
      await playBase64Audio(body.speech.audio_base64, body.speech.mime);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not play the preview");
    } finally {
      setPlaying(null);
    }
  };

  const select: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid var(--kirana-border)",
    background: "var(--kirana-secondary)",
    color: "var(--kirana-foreground)",
    fontSize: 13,
  };

  return (
    <div
      style={{
        background: "var(--kirana-card)",
        border: "1px solid var(--kirana-border)",
        borderRadius: 14,
        padding: 20,
        marginBottom: 16,
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-display,system-ui)",
          fontSize: 16,
          fontWeight: 700,
          margin: "0 0 6px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Volume2 size={16} style={{ color: "var(--kirana-primary)" }} />
        Agent voices (Gnani Timbre)
      </p>
      <p style={{ fontSize: 12.5, color: "var(--kirana-muted-foreground)", margin: "0 0 14px" }}>
        Each specialist answers in its own voice, so you can tell who is speaking. Tap the speaker
        to hear a voice. Changes apply to the next answer.
      </p>
      {!voices ? (
        <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: 0 }}>
          Voices are not available (NammaOps is not running).
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {Object.entries(voices).map(([role, v]) => (
            <div
              key={role}
              style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
            >
              <span style={{ width: 150, fontSize: 13.5, fontWeight: 600 }}>
                {v.name}
                <span style={{ color: "var(--kirana-muted-foreground)", fontWeight: 400 }}>
                  {" "}
                  · {ROLE_LABEL[role] ?? role}
                </span>
              </span>
              <select
                id={`voice-${role}`}
                aria-label={`${v.name} voice`}
                value={v.voice}
                onChange={(e) => void choose(role, e.target.value)}
                style={select}
              >
                {available.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={playing !== null}
                onClick={() => void preview(role, v.name, v.voice)}
                aria-label={`Hear ${v.name}'s voice`}
                style={{
                  ...select,
                  cursor: playing ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Volume2 size={14} /> {playing === role ? "Playing…" : "Hear"}
              </button>
              {!v.custom && (
                <span style={{ fontSize: 11.5, color: "var(--kirana-muted-foreground)" }}>
                  default
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
