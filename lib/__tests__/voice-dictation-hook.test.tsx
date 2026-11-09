// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  DICTATION_LANGUAGES,
  isDictationLanguage,
  sttLanguageCode,
  useVoiceDictation,
  webSpeechLanguage,
} from "../hooks/useVoiceDictation";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

afterEach(cleanup);

/**
 * The mic in the chat composer button reads exactly these fields:
 *   disabled={!dictation.supported}, title = supported ? "Dictate message" : "Voice input not
 * supported in this browser". This probe records the value the hook returned on EVERY render,
 * including the very first one, so the test proves the two-pass render: the first render must
 * agree with the server (unsupported), only a later render may say "supported".
 */
function probe(log: (supported: boolean, title: string) => void, props: Any = {}) {
  const Probe = (outer: Any) => {
    const d = useVoiceDictation({ onFinalTranscript: () => {}, language: "auto", ...outer });
    const supported = Boolean(d.supported);
    const title = supported ? "Dictate message" : "Voice input not supported in this browser";
    log(supported, title);
    return (
      <button type="button" disabled={!supported} title={title}>
        mic
      </button>
    );
  };
  return Probe;
}

/** jsdom has neither SpeechRecognition nor mediaDevices; hand the test the one it should see. */
function withBrowserOverrides({ mediaDevices, speech }: { mediaDevices?: boolean; speech?: boolean }) {
  const original = window.navigator.mediaDevices;
  const windowAny = window as Any;
  if (mediaDevices) {
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({} as MediaStream) },
    });
  }
  if (speech) windowAny.SpeechRecognition = class {};
  return () => {
    if (mediaDevices) {
      Object.defineProperty(window.navigator, "mediaDevices", {
        configurable: true,
        value: original ?? undefined,
      });
    }
    delete windowAny.SpeechRecognition;
  };
}

describe("dictation language mapping", () => {
  it("auto means Gnani indic-auto (Prisma supports Hinglish and detects Indic languages)", () => {
    expect(sttLanguageCode("auto")).toBe("indic-auto");
  });

  it("explicit composer codes pass through to the server untouched", () => {
    expect(sttLanguageCode("en-IN")).toBe("en-IN");
    expect(sttLanguageCode("hi-IN")).toBe("hi-IN");
    expect(sttLanguageCode("kn-IN")).toBe("kn-IN");
  });

  it("the browser recogniser has no auto-detect: auto falls back to en-IN there only", () => {
    expect(webSpeechLanguage("auto")).toBe("en-IN");
    expect(webSpeechLanguage("hi-IN")).toBe("hi-IN");
    expect(webSpeechLanguage("kn-IN")).toBe("kn-IN");
  });

  it("the picker offers exactly Auto, English, Hindi and Kannada", () => {
    expect(DICTATION_LANGUAGES.map((entry) => entry.id)).toEqual([
      "auto",
      "en-IN",
      "hi-IN",
      "kn-IN",
    ]);
  });

  it("localStorage validation accepts only real ids", () => {
    expect(isDictationLanguage("hi-IN")).toBe(true);
    expect(isDictationLanguage("auto")).toBe(true);
    expect(isDictationLanguage("indic-auto")).toBe(false);
    expect(isDictationLanguage("en-US")).toBe(false);
    expect(isDictationLanguage(null)).toBe(false);
  });
});

describe("dictation support is resolved after mount, not during the server render", () => {
  it("server STT available: first render says unsupported (matching the server), mount says supported", async () => {
    const restore = withBrowserOverrides({ mediaDevices: true });
    try {
      const seen: boolean[] = [];
      const titles: string[] = [];
      const Probe = probe((supported, title) => {
        seen.push(supported);
        titles.push(title);
      });
      render(<Probe />);
      await waitFor(() => expect(seen[seen.length - 1]).toBe(true));
      expect(seen[0]).toBe(false); // identical to what the server rendered
      expect(titles[0]).toContain("not supported");
      expect(titles[titles.length - 1]).toBe("Dictate message");
    } finally {
      restore();
    }
  });

  it("browser recogniser fallback follows the same two-pass render", async () => {
    const restore = withBrowserOverrides({ mediaDevices: false, speech: true });
    try {
      const seen: boolean[] = [];
      const Probe = probe((supported) => seen.push(supported));
      render(<Probe />);
      await waitFor(() => expect(seen[seen.length - 1]).toBe(true));
      expect(seen[0]).toBe(false);
    } finally {
      restore();
    }
  });

  it("a browser with neither engine stays unsupported, disabled and labelled as such", () => {
    const restore = withBrowserOverrides({ mediaDevices: false, speech: false });
    try {
      const seen: boolean[] = [];
      const Probe = probe((supported) => seen.push(supported));
      render(<Probe />);
      expect(seen.every((value) => value === false)).toBe(true);
      const mic = document.querySelector("button") as HTMLButtonElement;
      expect(mic.disabled).toBe(true);
      expect(mic.title).toMatch(/not supported/);
    } finally {
      restore();
    }
  });
});
