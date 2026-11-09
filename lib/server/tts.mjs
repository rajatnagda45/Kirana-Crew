/**
 * Provider-independent text-to-speech, mirroring stt.mjs. Selected by AGENT_TOWN_TTS_PROVIDER
 * (`gnani` | `gemini` | `fixture`); unset means 503, never a guess. AGENT_TOWN_TTS_FALLBACK
 * (e.g. `gemini`) is used only when the primary has an outage.
 *
 * Interface: { name, verifiesSpeech, contractVerified, synthesize({ text, language, voice })
 *   -> { bytes: Buffer, mime: string, provider: string } }
 */
import { WebSocket } from "ws";
import { isProviderOutage } from "./stt.mjs";

export const MAX_TTS_CHARS = 2000;
// `auto` (script detection) and `hi-en` (Hinglish) are documented Timbre values; `hi-en` fits the pattern.
const LANGUAGE = /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/;
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
/** Server-sent events: audio arrives in chunks while it is still being synthesised (first sound sooner). */
export const GNANI_TTS_SSE_URL = "https://api.vachana.ai/api/v1/tts/sse";
/** Streaming asks for raw 16-bit mono PCM at a rate we choose, so nothing has to be guessed. */
export const GNANI_STREAM_SAMPLE_RATE = 24000;
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
/** Realtime WebSocket endpoint (server-side only: browsers cannot set the X-API-Key-ID upgrade header). */
export const GNANI_TTS_WS_URL = "wss://api.vachana.ai/api/v1/tts";
const WS_CONNECT_TIMEOUT_MS = 5_000;
const WS_IDLE_MS = 20_000;
const SPEED_WORDS = Object.freeze({ slow: 0.85, medium: 1.0, fast: 1.15 });

/** Timbre accepts 0.85-1.15 or slow|medium|fast; anything else is dropped (server default 1.0). */
export function clampSpeed(speed) {
  const value = typeof speed === "string" ? (SPEED_WORDS[speed] ?? Number(speed)) : speed;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(1.15, Math.max(0.85, value));
}

/**
 * Realtime Timbre over one reusable WebSocket. One request is in flight at a time; after `complete`
 * the socket idles (closed after WS_IDLE_MS) so the next sentence skips the TCP/TLS handshake. An
 * abort, an `error` message or an early close terminates the socket, which also stops upstream work.
 * `open` is injectable for tests: (url, headers) -> ws-like emitter with send/close/terminate/readyState.
 */
export function createGnaniWsClient({ url = GNANI_TTS_WS_URL, apiKey, open } = {}) {
  const connect =
    open ??
    ((target, headers) =>
      new WebSocket(target, { headers, handshakeTimeout: WS_CONNECT_TIMEOUT_MS }));
  let idle = null;
  let idleTimer = null;
  const drop = (socket) => {
    try {
      socket.terminate();
    } catch {
      /* already gone */
    }
  };
  const park = (socket) => {
    idle = socket;
    idleTimer = setTimeout(() => {
      if (idle === socket) idle = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }, WS_IDLE_MS);
    idleTimer.unref?.();
    socket.once("close", () => {
      if (idle === socket) idle = null;
    });
  };
  const take = () => {
    const socket = idle;
    idle = null;
    clearTimeout(idleTimer);
    return socket?.readyState === 1 ? socket : null;
  };
  const acquire = (signal) =>
    new Promise((resolve, reject) => {
      const warm = take();
      if (warm) return resolve(warm);
      const socket = connect(url, { "X-API-Key-ID": apiKey });
      const timer = setTimeout(() => {
        drop(socket);
        reject(Object.assign(fail(502, "Gnani TTS is unreachable."), { retryable: true }));
      }, WS_CONNECT_TIMEOUT_MS);
      const onAbort = () => {
        clearTimeout(timer);
        drop(socket);
        reject(Object.assign(new Error("aborted"), { aborted: true }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("open", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(socket);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(Object.assign(fail(502, "Gnani TTS is unreachable."), { retryable: true }));
      });
    });

  /** Open (and park) a socket ahead of the first sentence. Never throws. */
  async function warm() {
    try {
      if (!idle) park(await acquire());
    } catch {
      /* the first real request reports the failure */
    }
  }

  /** @returns {AsyncGenerator<Buffer>} PCM chunks for one request. */
  async function* request(payload, signal) {
    let socket;
    try {
      socket = await acquire(signal);
    } catch (error) {
      if (error?.aborted) return;
      throw error;
    }
    const queue = [];
    let wake = null;
    let finished = false;
    let failure = null;
    let sawAudio = false;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type === "audio" && message.data?.audio) {
        sawAudio = true;
        queue.push(Buffer.from(message.data.audio, "base64"));
      } else if (message.type === "complete") {
        finished = true;
      } else if (message.type === "error") {
        failure = fail(502, String(message.message ?? "Gnani TTS error.").slice(0, 160));
      }
      notify();
    };
    const onClose = () => {
      if (!finished && !failure)
        failure = Object.assign(fail(502, "Gnani TTS closed the connection."), {
          retryable: !sawAudio,
        });
      notify();
    };
    const onAbort = () => {
      finished = true;
      failure = failure ?? { aborted: true };
      notify();
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    let clean = false;
    try {
      if (signal?.aborted) return onAbort();
      socket.send(JSON.stringify(payload));
      for (;;) {
        if (queue.length) {
          yield queue.shift();
        } else if (failure) {
          if (failure.aborted) return;
          throw failure;
        } else if (finished) {
          if (!sawAudio) throw fail(502, "Gnani TTS returned no audio.");
          clean = true;
          return;
        } else {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (clean) park(socket);
      else drop(socket);
    }
  }

  return { request, warm };
}
/** Split buffered server-sent-event text into complete events; the incomplete tail is returned. */
export function takeSseEvents(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match) break;
    const block = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    let event = "message";
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    events.push({ event, data });
  }
  return { events, rest };
}

/**
 * Timbre returns headerless 16-bit mono PCM and does not say its rate. Measured 2026-11-03: at an
 * assumed 24 kHz speech ran at ~1.3 words/s and the male voices' pitch came out at 56 to 67 Hz
 * (slow, deep, "robotic"); Gnani's own recogniser understood 57% of words at 24 kHz and 96% at
 * 32 kHz or more; at 44.1 kHz the male voices sit at 104 to 123 Hz and the female at 211 to 221 Hz.
 * So the rate is about 44.1 kHz. Set GNANI_TTS_SAMPLE_RATE if Gnani documents otherwise.
 */
export const GNANI_DEFAULT_SAMPLE_RATE = 44100;

/**
 * Gnani Timbre TTS. Request: { text, model, voice, language_code } with the key only in the
 * X-API-Key-ID header. Response: raw 44.1 kHz mono 16-bit PCM (application/octet-stream), which is
 * wrapped as WAV here; an audio/* body that is already a container is passed through.
 * An URL given as just the host gets the inference path appended.
 * @param {{ apiKey?: string, url?: string, model?: string, voice?: string, language?: string,
 *   sampleRate?: number, fetchImpl?: any, transport?: "sse" | "ws", wsOpen?: any }} [options]
 */
export function gnaniTtsProvider({
  apiKey,
  url,
  model = "timbre-v3.0",
  voice = "Avinash",
  language,
  sampleRate = GNANI_DEFAULT_SAMPLE_RATE,
  fetchImpl = fetch,
  transport = "sse",
  wsOpen,
} = {}) {
  if (!apiKey) throw fail(503, "GNANI_API_KEY is not configured.");
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
    throw fail(503, "GNANI_TTS_SAMPLE_RATE must be an integer between 8000 and 96000.");
  if (!GNANI_TTS_MODELS.includes(model))
    throw fail(503, `GNANI_TTS_MODEL must be one of ${GNANI_TTS_MODELS.join(", ")}.`);
  // A model name in the voice setting is a known misconfiguration; fall back to the default voice.
  const defaultVoice = GNANI_TTS_VOICES.includes(voice) ? voice : "Avinash";
  const endpoint = !url
    ? GNANI_TTS_URL
    : /^https:\/\/[^/]+\/?$/.test(url)
      ? `${url.replace(/\/$/, "")}/api/v1/tts/inference`
      : url;
  const wsClient =
    transport === "ws"
      ? createGnaniWsClient({ apiKey, ...(wsOpen ? { open: wsOpen } : {}) })
      : null;
  const provider = {
    name: "gnani-timbre",
    verifiesSpeech: true,
    contractVerified: true,
    sampleRate: GNANI_STREAM_SAMPLE_RATE,
    /**
     * Stream raw PCM16 mono chunks (at `sampleRate`) as Gnani produces them.
     * @param {{ text: string, language?: string, voice?: string, speed?: number | string,
     *   signal?: AbortSignal, onTransport?: (transport: string) => void }} input
     * @returns {AsyncGenerator<Buffer>}
     */
    async *stream(input) {
      if (!wsClient) {
        input.onTransport?.("sse");
        return yield* provider.sseStream(input);
      }
      const { text, language: requested, voice: requestedVoice, speed, signal } = input;
      const payload = {
        text,
        model,
        voice: GNANI_TTS_VOICES.includes(requestedVoice) ? requestedVoice : defaultVoice,
        language: requested || language || "en-IN",
        ...(clampSpeed(speed) ? { speed: clampSpeed(speed) } : {}),
        audio_config: {
          sample_rate: GNANI_STREAM_SAMPLE_RATE,
          num_channels: 1,
          sample_width: 2,
          encoding: "linear_pcm",
          container: "raw",
        },
      };
      // One retry on a fresh socket if it dies before any audio; then fall back to SSE.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let sawAudio = false;
        try {
          for await (const chunk of wsClient.request(payload, signal)) {
            if (!sawAudio) input.onTransport?.(attempt ? "ws-retry" : "ws");
            sawAudio = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (sawAudio || signal?.aborted || !error?.retryable) throw error;
        }
      }
      input.onTransport?.("sse-fallback");
      yield* provider.sseStream(input);
    },
    warm: () => wsClient?.warm(),
    async *sseStream({ text, language: requested, voice: requestedVoice, speed, signal }) {
      let response;
      try {
        response = await fetchImpl(GNANI_TTS_SSE_URL, {
          method: "POST",
          headers: { "X-API-Key-ID": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model,
            voice: GNANI_TTS_VOICES.includes(requestedVoice) ? requestedVoice : defaultVoice,
            language: requested || language || "en-IN",
            ...(clampSpeed(speed) ? { speed: clampSpeed(speed) } : {}),
            audio_config: {
              sample_rate: GNANI_STREAM_SAMPLE_RATE,
              num_channels: 1,
              sample_width: 2,
              encoding: "linear_pcm",
              container: "raw",
            },
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(GNANI_TIMEOUT_MS)])
            : AbortSignal.timeout(GNANI_TIMEOUT_MS),
        });
      } catch (error) {
        if (signal?.aborted) return;
        throw fail(502, "Gnani TTS is unreachable.");
      }
      if (!response.ok || !response.body)
        throw Object.assign(
          fail(502, `Gnani TTS rejected the request (HTTP ${response.status}).`),
          {
            upstreamStatus: response.status,
          },
        );
      const decoder = new TextDecoder();
      let buffer = "";
      let sawAudio = false;
      for await (const part of response.body) {
        buffer += decoder.decode(part, { stream: true });
        const parsed = takeSseEvents(buffer);
        buffer = parsed.rest;
        for (const { event, data } of parsed.events) {
          if (!data) continue;
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === "error")
            throw fail(502, String(body.message ?? "Gnani TTS error.").slice(0, 160));
          if (event === "chunk" && body.audio) {
            sawAudio = true;
            yield Buffer.from(body.audio, "base64");
          }
          if (event === "complete") {
            if (!sawAudio) throw fail(502, "Gnani TTS returned no audio.");
            return;
          }
        }
      }
      if (!sawAudio) throw fail(502, "Gnani TTS returned no audio.");
    },
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
          bytes: pcmToWav(Buffer.from(encoded, "base64"), sampleRate),
          mime: "audio/wav",
          provider: "gnani-timbre",
        };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw fail(502, "Gnani TTS returned no audio.");
      // Already a container (WAV/MP3/OGG): pass through; raw PCM: wrap as WAV at the Timbre rate.
      const container =
        bytes.subarray(0, 4).toString("latin1") === "RIFF" ||
        bytes.subarray(0, 3).toString("latin1") === "ID3" ||
        bytes.subarray(0, 4).toString("latin1") === "OggS";
      if (container && type.startsWith("audio/"))
        return { bytes, mime: type, provider: "gnani-timbre" };
      return {
        bytes: pcmToWav(bytes, sampleRate),
        mime: "audio/wav",
        provider: "gnani-timbre",
      };
    },
  };
  return provider;
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
      sampleRate: env.GNANI_TTS_SAMPLE_RATE ? Number(env.GNANI_TTS_SAMPLE_RATE) : undefined,
      transport: env.GNANI_TTS_TRANSPORT === "ws" ? "ws" : "sse",
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
    // Live replies stream from Gnani only; a different provider's voice is never mixed in.
    ...(primary.stream
      ? { stream: primary.stream.bind(primary), sampleRate: primary.sampleRate }
      : {}),
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
