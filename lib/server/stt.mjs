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
const GEMINI_MODEL = "gemini-2.5-flash";

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
/** @param {{ apiKey?: string, fetchImpl?: any, url?: string }} [options] */
export function gnaniProvider({ apiKey, fetchImpl = fetch, url = GNANI_URL } = {}) {
  if (!apiKey) throw fail(503, "GNANI_API_KEY is not configured.");
  return {
    name: "gnani-prisma",
    verifiesRecognition: true,
    /** @param {{ bytes: Buffer, mime: string, language?: string }} input */
    async transcribe({ bytes, mime, language }) {
      const form = new FormData();
      form.set("audio_file", new Blob([bytes], { type: mime }), "audio");
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
        throw fail(502, `Gnani STT rejected the request (HTTP ${response.status}).`);
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
 * Selected by AGENT_TOWN_STT_PROVIDER. Unset means voice tasks return 503, never a guess.
 * @param {Record<string, string | undefined>} [env]
 * @param {Record<string, any>} [overrides]
 */
export function createSttProvider(env = process.env, overrides = {}) {
  const name = env.AGENT_TOWN_STT_PROVIDER?.trim();
  if (!name) return null;
  if (name === "gnani") return gnaniProvider({ apiKey: env.GNANI_API_KEY, ...overrides });
  if (name === "gemini") return geminiProvider({ apiKey: env.GEMINI_API_KEY, ...overrides });
  if (name === "fixture")
    return fixtureProvider(env.AGENT_TOWN_STT_FIXTURE_TRANSCRIPT || undefined);
  throw new Error(`Unknown AGENT_TOWN_STT_PROVIDER: ${name}`);
}
