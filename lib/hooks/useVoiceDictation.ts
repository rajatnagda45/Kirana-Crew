"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
export function useVoiceDictation({ onFinalTranscript, lang = "en-IN" }: UseDictationOptions) {
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
