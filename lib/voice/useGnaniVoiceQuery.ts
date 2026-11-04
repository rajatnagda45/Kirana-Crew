"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { askGnani } from "@/lib/voice/gnaniClient";
import { playBase64Audio, startWavRecording, type WavRecording } from "@/lib/voice/wavRecorder";

export type GnaniVoiceState = "idle" | "recording" | "thinking" | "speaking";

export interface GnaniVoiceTurn {
  heard: string;
  answer: string;
  sttProvider: string | null;
  ttsProvider: string | null;
  workflow: { id: string; action: string | null; status: string } | null;
  agent: { role: string; name: string; voice: string } | null;
}

/**
 * Push-to-talk business questions through the Gnani pipeline:
 * mic -> Gnani STT -> governed NammaOps workflow -> Gnani TTS -> speaker.
 * `onUnavailable` is called when the Gnani path cannot serve the request (no provider configured,
 * server error or network failure), so the caller can fall back to Gemini Live.
 */
export function useGnaniVoiceQuery({
  language = "en-IN",
  onUnavailable,
  onTurn,
}: {
  language?: string;
  onUnavailable: (reason: string) => void;
  onTurn?: (turn: GnaniVoiceTurn) => void;
}) {
  const [state, setState] = useState<GnaniVoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<GnaniVoiceTurn | null>(null);
  const recording = useRef<WavRecording | null>(null);
  const callbacks = useRef({ onUnavailable, onTurn });
  useEffect(() => {
    callbacks.current = { onUnavailable, onTurn };
  });

  const send = useCallback(async () => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    setState("thinking");
    try {
      const audio = await current.stop();
      const result = await askGnani(audio, language);
      if (result.kind === "unavailable") {
        setState("idle");
        callbacks.current.onUnavailable(result.reason);
        return;
      }
      if (result.kind === "refused") throw new Error(result.message);
      const turn: GnaniVoiceTurn = {
        heard: result.value.heard,
        answer: result.value.answer,
        sttProvider: result.value.sttProvider,
        ttsProvider: result.value.ttsProvider,
        workflow: result.value.workflow,
        agent: result.value.agent,
      };
      setLastTurn(turn);
      callbacks.current.onTurn?.(turn);
      if (result.value.audio) {
        setState("speaking");
        await playBase64Audio(result.value.audio.base64, result.value.audio.mime);
      }
      setState("idle");
      setError(null);
    } catch (e) {
      setState("idle");
      setError(e instanceof Error ? e.message : "Voice request failed.");
    }
  }, [language]);

  const start = useCallback(async () => {
    if (recording.current) return;
    setError(null);
    try {
      recording.current = await startWavRecording(() => void send());
      setState("recording");
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(
        name === "NotAllowedError"
          ? "Microphone access denied. Allow mic in browser site settings."
          : "Could not start the microphone.",
      );
    }
  }, [send]);

  /** Tap once to start speaking, tap again to send. */
  const toggle = useCallback(() => {
    if (state === "recording") void send();
    else if (state === "idle") void start();
  }, [state, send, start]);

  useEffect(() => () => recording.current?.cancel(), []);

  return { state, error, lastTurn, toggle, busy: state !== "idle" };
}
