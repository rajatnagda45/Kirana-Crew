export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const AUDIO_TYPES = new Map([
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/flac", "flac"],
  ["audio/aac", "aac"],
  ["audio/mp4", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/webm", "webm"],
]);
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^indic-auto$/;
const GNANI_URL = "https://api.vachana.ai/stt/v3";
const GNANI_TIMEOUT_MS = 60_000;
// gemini-2.5-flash is retired for this key; the intent classifier already runs on this alias.
const GEMINI_MODEL = "gemini-flash-latest";

const fail = (status, message) => Object.assign(new Error(message), { status });

/** @param {{ bytes?: Buffer, mime?: string, language?: string }} input */
export function validAudio({ bytes, mime, language }) {
  const type = String(mime ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!AUDIO_TYPES.has(type)) throw fail(415, `Unsupported audio type: ${type || "missing"}.`);
  if (!bytes?.length) throw fail(400, "Audio file is empty.");
  if (bytes.length > MAX_AUDIO_BYTES)
    throw fail(413, `Audio exceeds ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`);
  if (language !== undefined && language !== "" && !LANGUAGE.test(language))
    throw fail(400, "Invalid language hint.");
  return { type, language: language || undefined };
}

const transcriptOf = (value, provider) => {
  if (typeof value !== "string" || !value.trim())
    throw fail(422, `${provider} returned no transcript.`);
  return value.trim().slice(0, 30000);
};

/**
 * Test-only adapter. It returns a fixed transcript for any audio, so it proves the
 * transcription-to-task wiring and says nothing about speech recognition.
 */
export function fixtureProvider(transcript = "Fixture transcript") {
  return {
    name: "fixture",
    verifiesRecognition: false,
    transcribe: async () => ({ transcript, provider: "fixture" }),
  };
}

/** Gnani Prisma v2.5 REST. Only documented fields are sent; the key never leaves the header. */
/** @param {{ apiKey?: string, fetchImpl?: any, url?: string, defaultLanguage?: string }} [options] */
export function gnaniProvider({
  apiKey,
  fetchImpl = fetch,
  url = GNANI_URL,
  defaultLanguage,
} = {}) {
  if (!apiKey) throw fail(503, "GNANI_API_KEY is not configured.");
  return {
    name: "gnani-prisma",
    verifiesRecognition: true,
    /** @param {{ bytes: Buffer, mime: string, language?: string }} input */
    async transcribe({ bytes, mime, language: requested }) {
      // Gnani requires language_code (422 without it); en-IN when nothing is configured.
      const language = requested || defaultLanguage || "en-IN";
      const form = new FormData();
      // Gnani infers the audio format from the file extension: a bare "audio" name is a 400.
      const extension = AUDIO_TYPES.get(String(mime).split(";")[0].trim().toLowerCase()) ?? "wav";
      form.set("audio_file", new Blob([bytes], { type: mime }), `audio.${extension}`);
      form.set("format", "transcribe");
      if (language) {
        form.set("language_code", language);
        form.set("preferred_language", language);
      }
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "X-API-Key-ID": apiKey },
          body: form,
          signal: AbortSignal.timeout(GNANI_TIMEOUT_MS),
        });
      } catch (error) {
        throw fail(
          error?.name === "TimeoutError" ? 504 : 502,
          error?.name === "TimeoutError" ? "Gnani STT timed out." : "Gnani STT is unreachable.",
        );
      }
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success === false)
        throw Object.assign(
          fail(502, `Gnani STT rejected the request (HTTP ${response.status}).`),
          { upstreamStatus: response.status },
        );
      return {
        transcript: transcriptOf(body?.transcript, "Gnani"),
        provider: "gnani-prisma",
        requestId: typeof body?.request_id === "string" ? body.request_id : undefined,
      };
    },
  };
}

/** Temporary Gemini STT via generateContent. The browser Gemini Live path is separate. */
/** @param {{ apiKey?: string, client?: any, model?: string }} [options] */
export function geminiProvider({ apiKey, client, model = GEMINI_MODEL } = {}) {
  if (!apiKey && !client) throw fail(503, "GEMINI_API_KEY is not configured.");
  return {
    name: "gemini",
    verifiesRecognition: true,
    /** @param {{ bytes: Buffer, mime: string, language?: string }} input */
    async transcribe({ bytes, mime, language }) {
      const ai = client ?? new (await import("@google/genai")).GoogleGenAI({ apiKey });
      let response;
      try {
        response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Transcribe this audio verbatim${language ? ` (language ${language})` : ""}. Return only the transcript.`,
                },
                { inlineData: { mimeType: mime, data: Buffer.from(bytes).toString("base64") } },
              ],
            },
          ],
        });
      } catch {
        throw fail(502, "Gemini STT request failed.");
      }
      return { transcript: transcriptOf(response?.text, "Gemini"), provider: "gemini" };
    },
  };
}

/**
 * True when a provider failure is an outage (unreachable, timeout or upstream 5xx) rather than a
 * rejected request (upstream 4xx) or an empty transcript. Only outages may fall back.
 */
export function isProviderOutage(error) {
  if (![502, 503, 504].includes(error?.status)) return false;
  const upstream = Number(error?.upstreamStatus);
  return !(upstream >= 400 && upstream < 500);
}

/**
 * Primary provider with an optional fallback used only on an outage. The result names the
 * provider that actually produced the transcript and whether the fallback was used.
 */
export function fallbackProvider(primary, secondary) {
  return {
    name: `${primary.name}+${secondary.name}`,
    verifiesRecognition:
      primary.verifiesRecognition === true && secondary.verifiesRecognition === true,
    async transcribe(input) {
      try {
        return { ...(await primary.transcribe(input)), fallbackUsed: false };
      } catch (error) {
        if (!isProviderOutage(error)) throw error;
        const result = await secondary.transcribe(input);
        return {
          ...result,
          fallbackUsed: true,
          fallbackFrom: primary.name,
          fallbackReason: String(error.message).slice(0, 200),
        };
      }
    },
  };
}

function namedSttProvider(name, env, overrides) {
  if (name === "gnani")
    return gnaniProvider({
      apiKey: env.GNANI_API_KEY,
      defaultLanguage: env.GNANI_LANGUAGE?.trim() || undefined,
      ...overrides,
    });
  if (name === "gemini") return geminiProvider({ apiKey: env.GEMINI_API_KEY, ...overrides });
  if (name === "fixture")
    return fixtureProvider(env.AGENT_TOWN_STT_FIXTURE_TRANSCRIPT || undefined);
  throw new Error(`Unknown speech-to-text provider: ${name}`);
}

/**
 * Selected by AGENT_TOWN_STT_PROVIDER. Unset means voice tasks return 503, never a guess.
 * AGENT_TOWN_STT_FALLBACK (e.g. `gemini`) is tried only when the primary has an outage.
 * @param {Record<string, string | undefined>} [env]
 * @param {Record<string, any>} [overrides]
 */
export function createSttProvider(env = process.env, overrides = {}) {
  const name = env.AGENT_TOWN_STT_PROVIDER?.trim();
  if (!name) return null;
  if (!["gnani", "gemini", "fixture"].includes(name))
    throw new Error(`Unknown AGENT_TOWN_STT_PROVIDER: ${name}`);
  const primary = namedSttProvider(name, env, overrides);
  const fallback = env.AGENT_TOWN_STT_FALLBACK?.trim();
  if (!fallback || fallback === name) return primary;
  let secondary;
  try {
    secondary = namedSttProvider(fallback, env, overrides.fallback ?? {});
  } catch {
    // An unconfigured fallback never blocks the primary; it is simply not available.
    return primary;
  }
  return fallbackProvider(primary, secondary);
}
