"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startWavRecording, type WavRecording } from "@/lib/voice/wavRecorder";

// ── Minimal SpeechRecognition typings (not in older TS dom libs) ──────────────
interface SpeechRecognitionResultItem {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionResultItem;
  [index: number]: SpeechRecognitionResultItem;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

export type DictationStatus =
  "idle" | "listening" | "processing" | "error" | "unsupported" | "denied";

interface UseDictationOptions {
  /** Called when recognition delivers a confirmed final transcript segment. */
  onFinalTranscript: (text: string) => void;
  /** BCP-47 language tag — defaults to "en-IN" for Indian kirana context. */
  lang?: string;
}

/**
 * STT-only dictation hook using the Web Speech API.
 * Delivers transcripts to `onFinalTranscript`; caller places them in the
 * composer and the user explicitly presses Send. Nothing is auto-submitted.
 *
 * This is intentionally separate from the Gemini voice-call system
 * (VoiceProvider / GeminiVoiceClient) which drives the Live Store assistant.
 */
/** Browser Web Speech dictation: last-resort fallback when no server speech-to-text is configured. */
function useBrowserDictation({ onFinalTranscript, lang = "en-IN" }: UseDictationOptions) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const finalCb = useRef(onFinalTranscript);
  // Keep the callback ref current without mutating it during render.
  useEffect(() => {
    finalCb.current = onFinalTranscript;
  });

  const supported =
    typeof window !== "undefined" &&
    (!!(window as SpeechRecognitionWindow).SpeechRecognition ||
      !!(window as SpeechRecognitionWindow).webkitSpeechRecognition);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try {
        rec.stop();
      } catch {
        // already stopped
      }
      recRef.current = null;
    }
    setStatus("idle");
    setInterimTranscript("");
  }, []);

  const start = useCallback(() => {
    if (!supported) {
      setStatus("unsupported");
      setError("Voice input is not supported in this browser. Try Chrome or Edge.");
      return;
    }
    if (recRef.current) stop();

    const win = window as SpeechRecognitionWindow;
    const SpeechAPI = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!SpeechAPI) {
      setStatus("unsupported");
      setError("Speech recognition unavailable.");
      return;
    }

    const rec = new SpeechAPI();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = lang;
    recRef.current = rec;

    rec.onstart = () => {
      setStatus("listening");
      setError(null);
      setInterimTranscript("");
    };

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const part = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          const trimmed = part.trim();
          if (trimmed) {
            setInterimTranscript("");
            finalCb.current(trimmed);
          }
        } else {
          interim += part;
        }
      }
      if (interim) setInterimTranscript(interim);
    };

    rec.onend = () => {
      recRef.current = null;
      setStatus("idle");
      setInterimTranscript("");
    };

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      recRef.current = null;
      setInterimTranscript("");
      switch (event.error) {
        case "not-allowed":
        case "permission-denied":
          setStatus("denied");
          setError("Microphone access denied. Allow mic in browser site settings.");
          break;
        case "no-speech":
          setStatus("idle");
          setError("No speech detected. Tap the mic and speak clearly.");
          break;
        case "network":
          setStatus("error");
          setError("Network error during voice recognition. Check your connection.");
          break;
        case "audio-capture":
          setStatus("error");
          setError("No microphone found. Connect a mic and try again.");
          break;
        case "service-not-allowed":
          setStatus("error");
          setError("Voice recognition service is not available.");
          break;
        default:
          setStatus("error");
          setError(`Voice input failed: ${event.error}`);
      }
    };

    try {
      rec.start();
    } catch {
      recRef.current = null;
      setStatus("error");
      setError("Could not start voice input.");
    }
  }, [supported, stop, lang]);

  // Cleanup on unmount
  useEffect(() => () => stop(), [stop]);

  return {
    supported,
    status,
    isListening: status === "listening",
    interimTranscript,
    error,
    start,
    stop,
  };
}

/**
 * Dictation for the chat composer. Gnani Prisma (server speech-to-text, with Gemini only as the
 * server's outage fallback) is primary: tap to record, tap again to transcribe. When the server
 * has no speech-to-text configured, it falls back to the browser's Web Speech recogniser. The
 * transcript is placed in the composer; nothing is sent automatically.
 */
export function useVoiceDictation({ onFinalTranscript, lang = "en-IN" }: UseDictationOptions) {
  const browser = useBrowserDictation({ onFinalTranscript, lang });
  const [engine, setEngine] = useState<"gnani" | "browser">("gnani");
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const recording = useRef<WavRecording | null>(null);
  const finalCb = useRef(onFinalTranscript);
  useEffect(() => {
    finalCb.current = onFinalTranscript;
  });

  const micAvailable = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const useBrowser = engine === "browser" || !micAvailable;

  const stop = useCallback(async () => {
    if (useBrowser) return browser.stop();
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    setStatus("processing");
    try {
      const audio = await current.stop();
      const form = new FormData();
      form.set("audio", audio, "speech.wav");
      form.set("language", lang);
      const res = await fetch("/api/tasks/voice/transcribe", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) {
        // No server speech-to-text: use the browser recogniser from now on.
        setEngine("browser");
        setStatus("idle");
        setError("Gnani speech-to-text is not configured; using the browser recogniser.");
        return;
      }
      if (!res.ok) throw new Error(body.error || `Transcription failed (${res.status}).`);
      const text = String(body.transcription?.transcript ?? "").trim();
      setProvider(body.transcription?.provider ?? null);
      if (!text) {
        setStatus("idle");
        setError("No speech detected. Tap the mic and speak clearly.");
        return;
      }
      finalCb.current(text);
      setStatus("idle");
      setError(null);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Voice input failed.");
    }
  }, [useBrowser, browser, lang]);

  const start = useCallback(async () => {
    if (useBrowser) return browser.start();
    if (recording.current) return;
    setError(null);
    try {
      recording.current = await startWavRecording(() => void stop());
      setStatus("listening");
    } catch (e) {
      const name = (e as DOMException)?.name;
      setStatus(name === "NotAllowedError" ? "denied" : "error");
      setError(
        name === "NotAllowedError"
          ? "Microphone access denied. Allow mic in browser site settings."
          : "Could not start the microphone.",
      );
    }
  }, [useBrowser, browser, stop]);

  useEffect(() => () => recording.current?.cancel(), []);

  if (useBrowser) return { ...browser, engine: "browser" as const, provider: null };
  return {
    supported: micAvailable,
    status,
    isListening: status === "listening",
    // Never put placeholder text here: the composer sends interim text as part of the message.
    interimTranscript: "",
    error,
    start: () => void start(),
    stop: () => void stop(),
    engine: "gnani" as const,
    provider,
  };
}
