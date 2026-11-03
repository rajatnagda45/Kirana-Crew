/**
 * Provider-independent text-to-speech, mirroring stt.mjs. Selected by AGENT_TOWN_TTS_PROVIDER
 * (`gnani` | `gemini` | `fixture`); unset means 503, never a guess. AGENT_TOWN_TTS_FALLBACK
 * (e.g. `gemini`) is used only when the primary has an outage.
 *
 * Interface: { name, verifiesSpeech, contractVerified, synthesize({ text, language, voice })
 *   -> { bytes: Buffer, mime: string, provider: string } }
 */
import { isProviderOutage } from "./stt.mjs";

export const MAX_TTS_CHARS = 2000;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const VOICE = /^[A-Za-z0-9_.-]{1,64}$/;
const GNANI_TIMEOUT_MS = 30_000;
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_SAMPLE_RATE = 24000;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** @param {{ text?: unknown, language?: unknown, voice?: unknown }} input */
export function validSpeech({ text, language, voice }) {
  if (typeof text !== "string" || !text.trim()) throw fail(400, "text is required.");
  if (text.length > MAX_TTS_CHARS) throw fail(413, `text exceeds ${MAX_TTS_CHARS} characters.`);
  if (language !== undefined && (typeof language !== "string" || !LANGUAGE.test(language)))
    throw fail(400, "Invalid language.");
  if (voice !== undefined && (typeof voice !== "string" || !VOICE.test(voice)))
    throw fail(400, "Invalid voice.");
  return { text: text.trim(), language, voice };
}

/** 16-bit mono PCM -> WAV container (Gemini TTS returns raw PCM). */
export function pcmToWav(pcm, sampleRate = GEMINI_SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Test-only: 100 ms of silence. Proves the wiring, says nothing about speech. */
export function fixtureTtsProvider() {
  return {
    name: "fixture",
    verifiesSpeech: false,
    contractVerified: true,
    synthesize: async () => ({
      bytes: pcmToWav(Buffer.alloc(GEMINI_SAMPLE_RATE / 5)),
      mime: "audio/wav",
      provider: "fixture",
    }),
  };
}

/** Gnani Timbre TTS inference route on api.vachana.ai (verified with a live call, 2026-11-03). */
export const GNANI_TTS_URL = "https://api.vachana.ai/api/v1/tts/inference";
export const GNANI_TTS_MODELS = Object.freeze(["timbre-v2.5", "timbre-v3.0"]);
export const GNANI_TTS_VOICES = Object.freeze([
  "Avinash",
  "Shivani",
  "Lakshmi",
  "Kalpana",
  "Shubham",
  "Prakash",
  "Devansh",
  "Yashraj",
  "Chetana",
  "Vasudha",
  "Harshad",
  "Riyaa",
  "Tarika",
]);
const GNANI_SAMPLE_RATE = 24000;

/**
 * Gnani Timbre TTS. Request: { text, model, voice, language_code } with the key only in the
 * X-API-Key-ID header. Response: raw 24 kHz mono 16-bit PCM (application/octet-stream), which is
 * wrapped as WAV here; an audio/* body that is already a container is passed through.
 * An URL given as just the host gets the inference path appended.
 * @param {{ apiKey?: string, url?: string, model?: string, voice?: string, language?: string,
 *   fetchImpl?: any }} [options]
 */
export function gnaniTtsProvider({
  apiKey,
  url,
  model = "timbre-v3.0",
  voice = "Avinash",
  language,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw fail(503, "GNANI_API_KEY is not configured.");
  if (!GNANI_TTS_MODELS.includes(model))
    throw fail(503, `GNANI_TTS_MODEL must be one of ${GNANI_TTS_MODELS.join(", ")}.`);
  // A model name in the voice setting is a known misconfiguration; fall back to the default voice.
  const defaultVoice = GNANI_TTS_VOICES.includes(voice) ? voice : "Avinash";
  const endpoint = !url
    ? GNANI_TTS_URL
    : /^https:\/\/[^/]+\/?$/.test(url)
      ? `${url.replace(/\/$/, "")}/api/v1/tts/inference`
      : url;
  return {
    name: "gnani-timbre",
    verifiesSpeech: true,
    contractVerified: true,
    /** @param {{ text: string, language?: string, voice?: string }} input */
    async synthesize({ text, language: requested, voice: requestedVoice }) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "X-API-Key-ID": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model,
            voice: GNANI_TTS_VOICES.includes(requestedVoice) ? requestedVoice : defaultVoice,
            language_code: requested || language || "en-IN",
          }),
          signal: AbortSignal.timeout(GNANI_TIMEOUT_MS),
        });
      } catch (error) {
        throw fail(
          error?.name === "TimeoutError" ? 504 : 502,
          error?.name === "TimeoutError" ? "Gnani TTS timed out." : "Gnani TTS is unreachable.",
        );
      }
      if (!response.ok)
        throw Object.assign(
          fail(502, `Gnani TTS rejected the request (HTTP ${response.status}).`),
          { upstreamStatus: response.status },
        );
      const type = String(response.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim();
      if (type === "application/json") {
        const body = await response.json().catch(() => null);
        const encoded = body?.audio_content ?? body?.audio;
        if (typeof encoded !== "string" || !encoded)
          throw fail(502, "Gnani TTS returned no audio.");
        return {
          bytes: pcmToWav(Buffer.from(encoded, "base64"), GNANI_SAMPLE_RATE),
          mime: "audio/wav",
          provider: "gnani-timbre",
        };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw fail(502, "Gnani TTS returned no audio.");
      // Already a container (WAV/MP3/OGG): pass through; raw PCM: wrap as 24 kHz WAV.
      const container =
        bytes.subarray(0, 4).toString("latin1") === "RIFF" ||
        bytes.subarray(0, 3).toString("latin1") === "ID3" ||
        bytes.subarray(0, 4).toString("latin1") === "OggS";
      if (container && type.startsWith("audio/"))
        return { bytes, mime: type, provider: "gnani-timbre" };
      return {
        bytes: pcmToWav(bytes, GNANI_SAMPLE_RATE),
        mime: "audio/wav",
        provider: "gnani-timbre",
      };
    },
  };
}

/** Gemini TTS via generateContent with an AUDIO response (raw 24 kHz PCM, wrapped as WAV). */
/** @param {{ apiKey?: string, client?: any, model?: string, voice?: string }} [options] */
export function geminiTtsProvider({
  apiKey,
  client,
  model = GEMINI_TTS_MODEL,
  voice = "Kore",
} = {}) {
  if (!apiKey && !client) throw fail(503, "GEMINI_API_KEY is not configured.");
  return {
    name: "gemini",
    verifiesSpeech: true,
    contractVerified: true,
    /** @param {{ text: string, language?: string, voice?: string }} input */
    async synthesize({ text, voice: requested }) {
      const ai = client ?? new (await import("@google/genai")).GoogleGenAI({ apiKey });
      let response;
      try {
        response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: requested || voice } },
            },
          },
        });
      } catch {
        throw fail(502, "Gemini TTS request failed.");
      }
      const data = response?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData
        ?.data;
      if (typeof data !== "string" || !data) throw fail(502, "Gemini TTS returned no audio.");
      return {
        bytes: pcmToWav(Buffer.from(data, "base64")),
        mime: "audio/wav",
        provider: "gemini",
      };
    },
  };
}

function namedTtsProvider(name, env, overrides = {}) {
  if (name === "gnani")
    return gnaniTtsProvider({
      apiKey: env.GNANI_API_KEY,
      url: env.GNANI_TTS_URL || undefined,
      model: env.GNANI_TTS_MODEL || undefined,
      voice: env.GNANI_TTS_VOICE || undefined,
      language: env.GNANI_LANGUAGE || undefined,
      ...overrides,
    });
  if (name === "gemini")
    return geminiTtsProvider({
      apiKey: env.GEMINI_API_KEY,
      ...(env.GEMINI_TTS_MODEL ? { model: env.GEMINI_TTS_MODEL } : {}),
      ...overrides,
    });
  if (name === "fixture") return fixtureTtsProvider();
  throw new Error(`Unknown text-to-speech provider: ${name}`);
}

/** Primary with an outage-only fallback; the result names the provider that spoke. */
export function fallbackTtsProvider(primary, secondary) {
  return {
    name: `${primary.name}+${secondary.name}`,
    verifiesSpeech: primary.verifiesSpeech && secondary.verifiesSpeech,
    contractVerified: primary.contractVerified && secondary.contractVerified,
    async synthesize(input) {
      try {
        return { ...(await primary.synthesize(input)), fallbackUsed: false };
      } catch (error) {
        if (!isProviderOutage(error)) throw error;
        return {
          ...(await secondary.synthesize(input)),
          fallbackUsed: true,
          fallbackFrom: primary.name,
        };
      }
    },
  };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {{ primary?: Record<string, any>, fallback?: Record<string, any> }} [overrides]
 */
export function createTtsProvider(env = process.env, overrides = {}) {
  const name = env.AGENT_TOWN_TTS_PROVIDER?.trim();
  if (!name) return null;
  if (!["gnani", "gemini", "fixture"].includes(name))
    throw new Error(`Unknown AGENT_TOWN_TTS_PROVIDER: ${name}`);
  const primary = namedTtsProvider(name, env, overrides.primary);
  const fallback = env.AGENT_TOWN_TTS_FALLBACK?.trim();
  if (!fallback || fallback === name) return primary;
  try {
    return fallbackTtsProvider(primary, namedTtsProvider(fallback, env, overrides.fallback));
  } catch {
    return primary;
  }
}

/** Sliding-window limiter (per process), shared by the speak endpoint. */
export function rateLimiter({ limit = 6, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = [];
  return () => {
    const t = now();
    while (hits.length && t - hits[0] >= windowMs) hits.shift();
    if (hits.length >= limit) throw fail(429, "Too many speech requests; try again shortly.");
    hits.push(t);
  };
}
