"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { startVad, type VadHandle } from "@/lib/voice/vad";
import { askGnani, type GnaniAnswer } from "@/lib/voice/gnaniClient";
import { playClip, type Playback } from "@/lib/voice/wavRecorder";

export type LiveState = "off" | "listening" | "hearing" | "thinking" | "speaking";

const ACK_TEXT = "Let me check.";

/**
 * A short spoken acknowledgement in the manager's voice, played the moment the user stops talking
 * so the wait for the answer does not feel dead. The server caches it, so after the first time it
 * costs nothing.
 */
async function fetchAck(voice: string | null, language: string): Promise<Playback | null> {
  try {
    const res = await fetch("/api/tasks/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({ text: ACK_TEXT, language, ...(voice ? { voice } : {}) }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return playClip(body.speech.audio_base64, body.speech.mime);
  } catch {
    return null;
  }
}

/** Live mode switches itself off after this long without any speech (the mic stays off after). */
export const LIVE_IDLE_MS = 2 * 60 * 1000;

/**
 * Hands-free voice. The microphone is analysed locally by the VAD (free); nothing is uploaded
 * until a full utterance has been heard. Then: Gnani speech-to-text -> governed NammaOps workflow
 * -> Gnani speech in the answering agent's own voice, and listening resumes. Talking over the
 * answer interrupts it. `onUnavailable` fires when Gnani cannot serve the request so the caller can
 * start the Gemini backup.
 */
export function useGnaniLive({
  language = "en-IN",
  onUnavailable,
  onTurn,
}: {
  language?: string;
  onUnavailable: (reason: string) => void;
  onTurn?: (turn: GnaniAnswer) => void;
}) {
  const [state, setState] = useState<LiveState>("off");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<GnaniAnswer | null>(null);
  const vad = useRef<VadHandle | null>(null);
  const playback = useRef<Playback | null>(null);
  const busy = useRef(false);
  const managerVoice = useRef<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef({ onUnavailable, onTurn });
  useEffect(() => {
    callbacks.current = { onUnavailable, onTurn };
  });

  const stop = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    playback.current?.stop();
    playback.current = null;
    vad.current?.stop();
    vad.current = null;
    busy.current = false;
    setLevel(0);
    setState("off");
  }, []);

  const armIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      stop();
      setError("Live voice turned off after 2 minutes of silence.");
    }, LIVE_IDLE_MS);
  }, [stop]);

  const handleUtterance = useCallback(
    async (wav: Blob) => {
      if (busy.current) return;
      busy.current = true;
      armIdleTimer();
      setState("thinking");
      vad.current?.setSuppressed(true);
      // Start the acknowledgement and the real question together.
      const ack = fetchAck(managerVoice.current, language);
      try {
        const result = await askGnani(wav, language);
        if (result.kind === "unavailable") {
          void ack.then((clip) => clip?.stop());
          stop();
          callbacks.current.onUnavailable(result.reason);
          return;
        }
        if (result.kind === "refused") {
          void ack.then((clip) => clip?.stop());
          setError(result.message);
          return;
        }
        // Let the acknowledgement finish before the answer starts (never two voices at once).
        const clip = await ack;
        if (clip) {
          setState("speaking");
          await clip.done;
        }
        setError(null);
        setLastTurn(result.value);
        callbacks.current.onTurn?.(result.value);
        if (result.value.audio) {
          setState("speaking");
          playback.current = playClip(result.value.audio.base64, result.value.audio.mime);
          await playback.current.done;
          playback.current = null;
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Voice request failed.");
      } finally {
        busy.current = false;
        if (vad.current) {
          vad.current.setSuppressed(false);
          setState("listening");
          armIdleTimer();
        }
      }
    },
    [language, stop, armIdleTimer],
  );

  const start = useCallback(async () => {
    if (vad.current) return;
    setError(null);
    // Remember the manager's voice for the acknowledgement; failure just means the default voice.
    void fetch("/api/runtime/nammaops/voices")
      .then((r) => r.json())
      .then((b) => {
        managerVoice.current = b?.voices?.manager?.voice ?? null;
      })
      .catch(() => {});
    try {
      vad.current = await startVad({
        onSpeechStart: () => {
          setState((s) => (s === "listening" ? "hearing" : s));
          armIdleTimer();
        },
        onUtterance: (wav) => void handleUtterance(wav),
        // Talking over the answer cuts it off, and the interruption itself is heard next.
        onBargeIn: () => playback.current?.stop(),
        onLevel: (value, hearing) => {
          setLevel(value);
          setState((s) =>
            s === "listening" && hearing
              ? "hearing"
              : s === "hearing" && !hearing
                ? "listening"
                : s,
          );
        },
      });
      setState("listening");
      armIdleTimer();
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(
        name === "NotAllowedError"
          ? "Microphone access denied. Allow mic in browser site settings."
          : "Could not start the microphone.",
      );
      setState("off");
    }
  }, [handleUtterance, armIdleTimer]);

  const toggle = useCallback(() => {
    if (state === "off") void start();
    else stop();
  }, [state, start, stop]);

  useEffect(() => stop, [stop]);

  return { state, level, error, lastTurn, active: state !== "off", toggle, stop };
}
