"use client";

import { useMemo } from "react";
import { Mic, MicOff, Zap } from "lucide-react";
import { useVoice } from "@/lib/voice/VoiceProvider";
import { useStudio } from "@/lib/store";
import { MAIN_SESSION_KEY } from "@/lib/reducer";
import { isVisibleChatMessage } from "@/lib/constants";

type DelegationEntry = { seatId: string; label: string; status: string };

export default function KiranaVoicePanel() {
  const voice = useVoice();
  const { state } = useStudio();

  const activeSessionKey = state.activeSessionKey ?? MAIN_SESSION_KEY;

  const recentMessages = useMemo(
    () =>
      state.chatMessages
        .filter((m) => m.sessionKey === activeSessionKey && isVisibleChatMessage(m))
        .slice(-6),
    [state.chatMessages, activeSessionKey],
  );

  const activeTasks = useMemo(
    () =>
      state.tasks.filter(
        (t) =>
          t.sessionKey === activeSessionKey &&
          t.status !== "completed" &&
          t.status !== "stopped" &&
          t.status !== "failed" &&
          t.status !== "interrupted",
      ),
    [state.tasks, activeSessionKey],
  );

  const delegations: DelegationEntry[] = useMemo(() => {
    const seen = new Set<string>();
    return activeTasks
      .filter((t) => t.seatId && !seen.has(t.seatId) && seen.add(t.seatId))
      .slice(0, 4)
      .map((t) => {
        const seat = state.seats.find((s) => s.seatId === t.seatId);
        return {
          seatId: t.seatId!,
          label: seat?.label ?? t.seatId!,
          status: t.status,
        };
      });
  }, [activeTasks, state.seats]);

  const isActive = voice.active;
  const isMuted = voice.muted;

  const statusLabel =
    voice.status === "connecting"
      ? "Connecting…"
      : voice.status === "listening"
        ? "Listening"
        : voice.status === "speaking"
          ? "Speaking"
          : voice.status === "thinking"
            ? "Processing"
            : voice.status === "muted"
              ? "Muted"
              : isActive
                ? "Ready"
                : "Tap to speak";

  const statusClass =
    voice.status === "listening"
      ? "kv-status--listening"
      : voice.status === "speaking"
        ? "kv-status--speaking"
        : voice.status === "thinking"
          ? "kv-status--thinking"
          : "";

  function handleMic() {
    if (!isActive) {
      voice.setMode("voice");
      voice.start();
    } else if (isMuted) {
      voice.toggleMute();
    } else {
      voice.toggleMute();
    }
  }

  return (
    <aside className="kirana-voice-panel" aria-label="KiranaCrew Voice Assistant">
      {/* Header */}
      <div className="kv-header">
        <div className="kv-header__title">
          <Zap size={14} aria-hidden="true" className="kv-header__zap" />
          KiranaCrew Assistant
        </div>
        <span className="kv-badge">AI</span>
      </div>

      <p className="kv-tagline">Talk to your AI store team in Kannada, Hindi or English.</p>

      {/* Mic button + waveform */}
      <div className="kv-mic-area">
        <div
          className={`kv-waveform ${isActive && !isMuted ? "kv-waveform--active" : ""}`}
          aria-hidden="true"
        >
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <span
              key={i}
              className="kv-waveform__bar"
              style={{ "--i": i } as React.CSSProperties}
            />
          ))}
        </div>
        <button
          type="button"
          className={`kv-mic-btn ${isActive ? "kv-mic-btn--active" : ""} ${isMuted ? "kv-mic-btn--muted" : ""}`}
          onClick={handleMic}
          aria-label={isActive ? (isMuted ? "Unmute" : "Mute mic") : "Start voice assistant"}
          title={statusLabel}
        >
          {isMuted ? <MicOff size={32} /> : <Mic size={32} />}
        </button>
        <div
          className={`kv-waveform kv-waveform--right ${isActive && !isMuted ? "kv-waveform--active" : ""}`}
          aria-hidden="true"
        >
          {[7, 6, 5, 4, 3, 2, 1].map((i) => (
            <span
              key={i}
              className="kv-waveform__bar"
              style={{ "--i": i } as React.CSSProperties}
            />
          ))}
        </div>
      </div>

      <div className={`kv-status ${statusClass}`}>{statusLabel}</div>

      {/* Live transcript */}
      {recentMessages.length > 0 && (
        <div className="kv-transcript">
          <div className="kv-section-label">Live Transcript</div>
          <div className="kv-transcript__messages">
            {recentMessages.map((msg) => (
              <div
                key={msg.id}
                className={`kv-transcript__msg kv-transcript__msg--${msg.role === "user" ? "user" : "ai"}`}
              >
                <span className="kv-transcript__role">
                  {msg.role === "user" ? "You" : (msg.actorName ?? "AI")}
                </span>
                <span className="kv-transcript__text">
                  {msg.content?.slice(0, 90)}
                  {(msg.content?.length ?? 0) > 90 ? "…" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent delegation */}
      {delegations.length > 0 && (
        <div className="kv-delegation">
          <div className="kv-section-label">Delegation Progress</div>
          {delegations.map((d) => (
            <div key={d.seatId} className="kv-delegation__row">
              <span className={`kv-delegation__dot kv-delegation__dot--${d.status}`} />
              <span className="kv-delegation__name">{d.label}</span>
              <span className="kv-delegation__status">{d.status}</span>
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="kv-footer">
        <span className="kv-footer__powered">Powered by</span>
        <span className="kv-footer__brand">Gnani AI</span>
        <span className="kv-footer__stack">Prisma STT · Timbre TTS · Evon (planned)</span>
      </div>
    </aside>
  );
}
