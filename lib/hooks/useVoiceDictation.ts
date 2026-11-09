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

/**
 * Response/dictation language preference.
 *
 * "hl"    Hinglish – Roman-script mixed Hindi-English. This is the default for kirana shopkeepers.
 * "auto"  Auto-detect from input script/words (server-side detection).
 * "hi-IN" Hindi – Devanagari script responses.
 * "en-IN" English.
 * "kn-IN" Kannada.
 *
 * "hl" is a first-class language mode — not a sub-mode of Hindi.
 * For STT it maps to hi-IN (Gnani handles Hinglish speech via Hindi recognition).
 */
export type DictationLanguage = "auto" | "hl" | "en-IN" | "hi-IN" | "kn-IN";

/** Language picker options. Order: Hinglish first (kirana default), then others. */
export const DICTATION_LANGUAGES: ReadonlyArray<{ id: DictationLanguage; label: string }> = [
  { id: "hl", label: "Hinglish" },
  { id: "auto", label: "Auto Detect" },
  { id: "hi-IN", label: "हिंदी" },
  { id: "en-IN", label: "English" },
  { id: "kn-IN", label: "ಕನ್ನಡ" },
];

const DICTATION_LANGUAGE_IDS = new Set(DICTATION_LANGUAGES.map((entry) => entry.id));

/** True when the string is one of the composer's language ids (localStorage input). */
export function isDictationLanguage(value: unknown): value is DictationLanguage {
  return typeof value === "string" && DICTATION_LANGUAGE_IDS.has(value as DictationLanguage);
}

/**
 * Code sent to the server speech-to-text provider.
 * 'auto' and 'hl' both use Gnani indic-auto so Hinglish speech is correctly transcribed.
 */
export function sttLanguageCode(language: DictationLanguage): string {
  if (language === "auto" || language === "hl") return "indic-auto";
  return language;
}

/** The Web Speech API has no auto-detect and no Hinglish, so both map to hi-IN for the browser. */
export function webSpeechLanguage(language: DictationLanguage): string {
  if (language === "auto" || language === "hl") return "hi-IN";
  return language;
}

interface UseDictationOptions {
  /** Called when recognition delivers a confirmed final transcript segment. */
  onFinalTranscript: (text: string) => void;
  /** Composer language: `auto` lets the server detect Hindi/Hinglish/Kannada/English. */
  language?: DictationLanguage;
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
function useBrowserDictation({ onFinalTranscript, language = "auto" }: UseDictationOptions) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Two-pass render: "supported" reads window APIs, which do not exist on the server. Starting
  // false on BOTH sides keeps server and first client render identical (no hydration mismatch);
  // the real answer is set right after mount.
  const [supported, setSupported] = useState(false);

  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const finalCb = useRef(onFinalTranscript);
  // Keep the callback ref current without mutating it during render.
  useEffect(() => {
    finalCb.current = onFinalTranscript;
  });

  useEffect(() => {
    if (typeof window !== "undefined")
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only input (server has none); the value is only knowable after mount, which is what keeps SSR and hydration identical
      setSupported(
        !!(window as SpeechRecognitionWindow).SpeechRecognition ||
          !!(window as SpeechRecognitionWindow).webkitSpeechRecognition,
      );
  }, []);

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
    rec.lang = webSpeechLanguage(language);
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
  }, [supported, stop, language]);

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
export function useVoiceDictation({ onFinalTranscript, language = "auto" }: UseDictationOptions) {
  const browser = useBrowserDictation({ onFinalTranscript, language });
  const [engine, setEngine] = useState<"gnani" | "browser">("gnani");
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const recording = useRef<WavRecording | null>(null);
  const finalCb = useRef(onFinalTranscript);
  useEffect(() => {
    finalCb.current = onFinalTranscript;
  });

  // Two-pass render, same as `supported` above: navigator does not exist on the server, so the
  // first render (client and server alike) says "no mic" and the mount effect corrects it.
  const [micAvailable, setMicAvailable] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined")
      // eslint-disable-next-line react-hooks/set-state-in-effect -- same as `supported` above: navigator does not exist on the server
      setMicAvailable(!!navigator.mediaDevices?.getUserMedia);
  }, []);
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
      // "auto" maps to Gnani's `indic-auto`: its own Indic language detection, which also
      // handles Hindi–English mixtures. Explicit codes (en-IN/hi-IN/kn-IN) pass through.
      form.set("language", sttLanguageCode(language));
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
  }, [useBrowser, browser, language]);

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
