/**
 * Lightweight language detection for kirana store voice and chat input.
 *
 * Priority: Devanagari script → 'hi' (Hindi)
 *           Kannada script    → 'kn'
 *           Hinglish keywords → 'hl' (Roman-script Hinglish — DISTINCT from Devanagari Hindi)
 *           Kannada Roman     → 'kn'
 *           default           → 'en'
 *
 * Language codes used throughout the backend:
 *   'hl'  Hinglish — Roman-script mixed Hindi-English (default for kirana shopkeepers)
 *   'hi'  Hindi — Devanagari script
 *   'kn'  Kannada (Kannada script or Roman transliteration)
 *   'en'  English
 *
 * No external dependency; purely regex-based so it never fails or adds latency.
 */

/** Unicode ranges for Indic scripts. */
const DEVANAGARI = /[ऀ-ॿ]/;
const KANNADA = /[ಀ-೿]/;

/**
 * Common Hindi words in Roman script used by shopkeepers mixing Hindi and English.
 * Match whole words only to avoid false positives inside English words.
 */
const HINGLISH_WORDS =
  /\b(aaj|kal|kya|kitna|kitne|kaisa|kaise|kab|kahan|kuch|bohot|bahut|bata|batao|hain|nahi|nai|mera|meri|apna|apni|karo|karna|dikhao|dekho|chahiye|lena|dena|becho|bikri|aaya|gaya|maal|dukan|rupye|paisa|lakh|crore|se\s+kuch|ke\s+baad|ki\s+report|stock\s+check\s+karo|kitna\s+stock|aaj\s+ki|kal\s+ki|abhi\s+tak|poora|sara|sabse|zyada|jyada|wala|wali|wale|yeh\s+bata|yeh\s+dikhao|mujhe\s+bata|kya\s+hai|kya\s+hua|theek\s+hai|theek\s+hain|pichhle|pichle|mahine|hafte|batao|dijiye|dijie|milao|milega|milegi|chahta|chahti|sab|saara|saari|udhaar|udhar|bacha|bache)\b/i;

/** Kannada words in Roman transliteration that are unambiguous store-domain words. */
const KANNADA_ROMAN =
  /\b(illi|enu|ega|yaavaga|yeshtu|gothilla|maadi|nodi|heli|bhai|anna|akka|amma)\b/i;

/**
 * Detect the language of a text string.
 * @param {string} text
 * @returns {'hl' | 'hi' | 'kn' | 'en'}
 */
export function detectLanguage(text) {
  if (!text || typeof text !== "string") return "en";
  if (DEVANAGARI.test(text)) return "hi"; // Devanagari script → pure Hindi
  if (KANNADA.test(text)) return "kn";
  if (HINGLISH_WORDS.test(text)) return "hl"; // Roman Hinglish — distinct from Devanagari Hindi
  if (KANNADA_ROMAN.test(text)) return "kn";
  return "en";
}

/** True when the text is Devanagari Hindi. */
export function isHindi(text) {
  return detectLanguage(text) === "hi";
}

/** True when the text is Roman-script Hinglish. */
export function isHinglish(text) {
  return detectLanguage(text) === "hl";
}

/** True when the text is primarily Kannada. */
export function isKannada(text) {
  return detectLanguage(text) === "kn";
}

/**
 * Normalise an IETF language tag (e.g. "hi-IN", "kn-IN") to our 2/2-char code.
 * Returns 'en' for anything unrecognised.
 * @param {string} tag
 * @returns {'hl' | 'hi' | 'kn' | 'en'}
 */
export function normLang(tag) {
  const t = String(tag ?? "")
    .toLowerCase()
    .slice(0, 5);
  if (t === "hl") return "hl"; // explicit Hinglish code
  if (t.startsWith("hi")) return "hi"; // hi-IN → Devanagari Hindi
  if (t.startsWith("kn")) return "kn";
  return "en";
}

/**
 * Resolve the effective response language from an explicit UI preference and the input text.
 *
 * @param {string | null | undefined} pref   UI selection: 'auto'|'hl'|'hi-IN'|'en-IN'|'kn-IN'|'hi'|'kn'|'en'
 * @param {string} [inputText]               The user's message (used when pref is 'auto')
 * @returns {'hl' | 'hi' | 'kn' | 'en'}
 */
export function resolveResponseLang(pref, inputText = "") {
  if (!pref || pref === "auto") return detectLanguage(inputText);
  if (pref === "hl") return "hl";
  const two = pref.slice(0, 2).toLowerCase();
  if (two === "hi") return "hi";
  if (two === "kn") return "kn";
  if (two === "en") return "en";
  return detectLanguage(inputText);
}
