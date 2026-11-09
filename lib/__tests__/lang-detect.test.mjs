/**
 * Tests for the KiranaCrew language detection and preference resolution system.
 * Covers all 5 language modes: Hinglish ('hl'), Hindi Devanagari ('hi'), English ('en'),
 * Kannada ('kn'), and Auto detect.
 */
import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  isHindi,
  isHinglish,
  isKannada,
  normLang,
  resolveResponseLang,
} from "../server/nammaops/lang-detect.mjs";

describe("detectLanguage", () => {
  describe("Hinglish (Roman-script Hindi-English mix) → 'hl'", () => {
    it("detects 'aaj' as Hinglish", () =>
      expect(detectLanguage("Aaj ki sales kitni hui?")).toBe("hl"));
    it("detects 'kya' as Hinglish", () =>
      expect(detectLanguage("kya stock bacha hai?")).toBe("hl"));
    it("detects 'kitna' as Hinglish", () => expect(detectLanguage("Kitna profit hua?")).toBe("hl"));
    it("detects 'udhaar' as Hinglish", () =>
      expect(detectLanguage("udhaar pending hai kitna")).toBe("hl"));
    it("detects 'mujhe batao' as Hinglish", () =>
      expect(detectLanguage("mujhe bata aaj ki report")).toBe("hl"));
    it("detects 'bikri' as Hinglish", () =>
      expect(detectLanguage("aaj ki bikri kya rahi")).toBe("hl"));
    it("detects 'zyada' as Hinglish", () =>
      expect(detectLanguage("sabse zyada kya bika")).toBe("hl"));
    it("detects 'nahi' as Hinglish", () =>
      expect(detectLanguage("stock khatam nahi hua na?")).toBe("hl"));
    it("detects 'pichhle' as Hinglish", () =>
      expect(detectLanguage("pichhle mahine ki report do")).toBe("hl"));
    it("detects 'saara' as Hinglish", () =>
      expect(detectLanguage("saara maal check karo")).toBe("hl"));
  });

  describe("Hindi Devanagari → 'hi'", () => {
    it("detects Devanagari as Hindi", () =>
      expect(detectLanguage("आज की बिक्री क्या थी?")).toBe("hi"));
    it("detects mixed Devanagari-English as Hindi", () =>
      expect(detectLanguage("आज stock कितना है")).toBe("hi"));
    it("detects pure Devanagari text", () =>
      expect(detectLanguage("मुझे आज की रिपोर्ट चाहिए")).toBe("hi"));
  });

  describe("English → 'en'", () => {
    it("detects plain English", () => expect(detectLanguage("What is today's stock?")).toBe("en"));
    it("detects English business queries", () =>
      expect(detectLanguage("Show me today's sales report")).toBe("en"));
    it("detects English with numbers", () =>
      expect(detectLanguage("I need the report for October")).toBe("en"));
  });

  describe("Kannada → 'kn'", () => {
    it("detects Kannada script", () =>
      expect(detectLanguage("ಇವತ್ತು ಸ್ಟಾಕ್ ಎಷ್ಟು ಇದೆ?")).toBe("kn"));
    it("detects Kannada Roman words", () =>
      expect(detectLanguage("illi stock enu ega")).toBe("kn"));
    it("detects 'nodi' as Kannada", () =>
      expect(detectLanguage("nodi stock check maadi")).toBe("kn"));
  });

  describe("Hinglish is NOT classified as English", () => {
    it("'kya kya stock bacha hai' is Hinglish not English", () =>
      expect(detectLanguage("kya kya stock bacha hai")).toBe("hl"));
    it("'aaj ki report do' is Hinglish not English", () =>
      expect(detectLanguage("aaj ki report do")).toBe("hl"));
  });

  describe("edge cases", () => {
    it("empty string → 'en'", () => expect(detectLanguage("")).toBe("en"));
    it("null → 'en'", () => expect(detectLanguage(null)).toBe("en"));
    it("undefined → 'en'", () => expect(detectLanguage(undefined)).toBe("en"));
  });
});

describe("isHinglish", () => {
  it("true for Roman Hinglish", () => expect(isHinglish("aaj ki report kya hai")).toBe(true));
  it("false for Devanagari", () => expect(isHinglish("आज की रिपोर्ट")).toBe(false));
  it("false for English", () => expect(isHinglish("show me today's report")).toBe(false));
});

describe("isHindi", () => {
  it("true for Devanagari", () => expect(isHindi("आज की बिक्री")).toBe(true));
  it("false for Hinglish Roman", () => expect(isHindi("aaj ki bikri kya rahi")).toBe(false));
});

describe("isKannada", () => {
  it("true for Kannada script", () => expect(isKannada("ಇವತ್ತು ಸ್ಟಾಕ್")).toBe(true));
  it("false for English", () => expect(isKannada("today's stock")).toBe(false));
});

describe("normLang", () => {
  it("hi-IN → 'hi'", () => expect(normLang("hi-IN")).toBe("hi"));
  it("kn-IN → 'kn'", () => expect(normLang("kn-IN")).toBe("kn"));
  it("hl → 'hl'", () => expect(normLang("hl")).toBe("hl"));
  it("en-IN → 'en'", () => expect(normLang("en-IN")).toBe("en"));
  it("unknown → 'en'", () => expect(normLang("fr-FR")).toBe("en"));
  it("null → 'en'", () => expect(normLang(null)).toBe("en"));
});

describe("resolveResponseLang", () => {
  describe("explicit Hinglish preference always wins", () => {
    it("'hl' pref + English input → 'hl'", () =>
      expect(resolveResponseLang("hl", "show me today's report")).toBe("hl"));
    it("'hl' pref + Devanagari input → 'hl'", () =>
      expect(resolveResponseLang("hl", "आज की रिपोर्ट")).toBe("hl"));
    it("'hl' pref + Kannada input → 'hl'", () =>
      expect(resolveResponseLang("hl", "ಇವತ್ತು ಸ್ಟಾಕ್")).toBe("hl"));
  });

  describe("explicit English preference", () => {
    it("'en-IN' pref + Hinglish input → 'en'", () =>
      expect(resolveResponseLang("en-IN", "aaj ki report kya hai")).toBe("en"));
    it("'en' pref + Hinglish input → 'en'", () =>
      expect(resolveResponseLang("en", "kya stock bacha hai")).toBe("en"));
  });

  describe("explicit Hindi preference", () => {
    it("'hi-IN' pref + Hinglish input → 'hi'", () =>
      expect(resolveResponseLang("hi-IN", "aaj ki report")).toBe("hi"));
  });

  describe("auto mode detects from text", () => {
    it("auto + Hinglish input → 'hl'", () =>
      expect(resolveResponseLang("auto", "aaj ki bikri kitni hui")).toBe("hl"));
    it("auto + Devanagari input → 'hi'", () =>
      expect(resolveResponseLang("auto", "आज की बिक्री क्या थी")).toBe("hi"));
    it("auto + English input → 'en'", () =>
      expect(resolveResponseLang("auto", "What is today's sales?")).toBe("en"));
    it("auto + empty input → 'en'", () => expect(resolveResponseLang("auto", "")).toBe("en"));
  });

  describe("null/undefined preference → auto-detects", () => {
    it("null pref + Hinglish input → 'hl'", () =>
      expect(resolveResponseLang(null, "aaj ki bikri kya rahi")).toBe("hl"));
    it("undefined pref + English input → 'en'", () =>
      expect(resolveResponseLang(undefined, "today's report")).toBe("en"));
  });

  describe("Kannada", () => {
    it("kn-IN pref → 'kn'", () => expect(resolveResponseLang("kn-IN", "show me stock")).toBe("kn"));
    it("auto + Kannada script → 'kn'", () =>
      expect(resolveResponseLang("auto", "ಇವತ್ತು ಸ್ಟಾಕ್ ಎಷ್ಟು ಇದೆ")).toBe("kn"));
  });
});
