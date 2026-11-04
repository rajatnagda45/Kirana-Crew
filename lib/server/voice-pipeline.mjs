/**
 * Gnani-first voice pipeline. Speech-to-text and text-to-speech run through the configured
 * providers (AGENT_TOWN_STT_PROVIDER / AGENT_TOWN_TTS_PROVIDER, normally `gnani`), with the
 * configured fallback (normally `gemini`) used only when the primary has an outage.
 *
 * `voiceQuery` answers a spoken business question end to end without any OpenClaw agent:
 * audio -> transcript -> governed NammaOps workflow (read-only ERP calls as the specialists)
 * -> deterministic summary -> speech. Nothing here writes to ERP or starts an agent task.
 */
import { createSttProvider, validAudio } from "./stt.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTtsProvider, validSpeech, MAX_TTS_CHARS, GNANI_TTS_VOICES } from "./tts.mjs";
import {
  DEFAULT_SPEAKER,
  NOTHING_HEARD,
  SPEAKER_FOR_ACTION,
  UNDERSTOOD_NOTHING,
  spokenAnswer,
} from "./nammaops/spoken.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const WORKFLOW_WAIT_MS = 90_000;

/** Which providers are configured, without keys or URLs. */
/** @param {Record<string, string | undefined>} [env] */
export function voiceProviders(env = process.env) {
  const describe = (factory, primaryKey, fallbackKey) => {
    const primary = env[primaryKey]?.trim() || null;
    const fallback = env[fallbackKey]?.trim() || null;
    let configured = false;
    let reason = null;
    try {
      configured = Boolean(factory(env));
      if (!configured) reason = `${primaryKey} is not set.`;
    } catch (error) {
      reason = String(error.message).slice(0, 200);
    }
    return { primary, fallback, configured, ...(reason ? { reason } : {}) };
  };
  return {
    stt: describe(createSttProvider, "AGENT_TOWN_STT_PROVIDER", "AGENT_TOWN_STT_FALLBACK"),
    tts: describe(createTtsProvider, "AGENT_TOWN_TTS_PROVIDER", "AGENT_TOWN_TTS_FALLBACK"),
    language: env.GNANI_LANGUAGE?.trim() || "en-IN",
  };
}

function provider(factory, label) {
  let instance;
  try {
    instance = factory();
  } catch (error) {
    throw fail(503, error.message);
  }
  if (!instance) throw fail(503, `No ${label} provider is configured.`);
  return instance;
}

/** Audio -> transcript. Throws 4xx for bad audio, 5xx when no provider could transcribe. */
/** @typedef {{ bytes: Buffer, mime: string, language?: string }} VoiceAudio */
/** @param {any} runtime @param {VoiceAudio} audio */
export async function transcribe(runtime, { bytes, mime, language }) {
  const audio = validAudio({ bytes, mime, language });
  runtime.sttLimit?.();
  const stt = provider(() => runtime.sttFactory?.(), "speech-to-text");
  const result = await stt.transcribe({ bytes, mime: audio.type, language: audio.language });
  return {
    transcript: result.transcript,
    provider: result.provider,
    fallback_used: result.fallbackUsed === true,
    ...(result.fallbackUsed ? { fallback_from: result.fallbackFrom } : {}),
    verifies_recognition: stt.verifiesRecognition === true,
    language: audio.language ?? null,
  };
}

export const VOICE_NAMESPACE = "nammaops.voices";
const ROLES = ["manager", "inventory", "sales", "procurement", "finance", "reports", "billing"];

function defaultVoices() {
  try {
    return JSON.parse(readFileSync(resolve("config/nammaops/voices.json"), "utf8")).roles;
  } catch {
    return {};
  }
}

/** Each specialist's voice: owner overrides from Settings over the shipped defaults. */
export function agentVoices(runtime) {
  const defaults = defaultVoices();
  const saved = runtime.db?.record?.(VOICE_NAMESPACE, "current")?.voices ?? {};
  return Object.fromEntries(
    ROLES.map((role) => [
      role,
      {
        name: defaults[role]?.name ?? role,
        voice: GNANI_TTS_VOICES.includes(saved[role])
          ? saved[role]
          : (defaults[role]?.voice ?? "Avinash"),
        custom: GNANI_TTS_VOICES.includes(saved[role]),
      },
    ]),
  );
}

/** @param {any} runtime @param {Record<string, string>} voices role -> Gnani voice */
export function saveAgentVoices(runtime, voices) {
  const next = {};
  for (const [role, voice] of Object.entries(voices ?? {})) {
    if (!ROLES.includes(role)) throw fail(400, `Unknown role: ${role}.`);
    if (!GNANI_TTS_VOICES.includes(voice)) throw fail(400, `Unknown voice for ${role}: ${voice}.`);
    next[role] = voice;
  }
  const current = runtime.db.record(VOICE_NAMESPACE, "current");
  runtime.db.saveRecord(
    VOICE_NAMESPACE,
    "current",
    { voices: { ...(current?.voices ?? {}), ...next } },
    current?.revision ?? 0,
  );
  return agentVoices(runtime);
}

// Repeated phrases (greetings, "I did not hear anything") are served from memory: no TTS call.
const CACHE_LIMIT = 40;
const CACHE_BYTES = 24 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;
const cacheKey = (text, voice, language) =>
  createHash("sha256")
    .update(`${voice}|${language ?? ""}|${text}`)
    .digest("hex");
function remember(key, value) {
  cache.set(key, value);
  cacheBytes += value.bytes;
  while (cache.size > CACHE_LIMIT || cacheBytes > CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).bytes;
    cache.delete(oldest);
  }
}
export const ttsCacheStats = () => ({ entries: cache.size, bytes: cacheBytes });

/** Text -> speech; returns { speech: null, speech_unavailable } when no provider can speak. */
/** @param {any} runtime @param {string} text @param {{ language?: string, voice?: string }} [options] */
export async function speakText(runtime, text, { language, voice } = {}) {
  try {
    const tts = provider(() => runtime.ttsFactory?.(), "text-to-speech");
    const speech = validSpeech({ text: String(text).slice(0, MAX_TTS_CHARS), language, voice });
    const key = cacheKey(speech.text, voice ?? "", language);
    const hit = cache.get(key);
    if (hit) return { speech: { ...hit, cached: true } };
    runtime.ttsLimit?.();
    const out = await tts.synthesize(speech);
    const value = {
      provider: out.provider,
      mime: out.mime,
      audio_base64: out.bytes.toString("base64"),
      bytes: out.bytes.length,
      voice: voice ?? null,
      provider_contract_verified: tts.contractVerified === true,
      ...(out.fallbackUsed ? { fallback_used: true, fallback_from: out.fallbackFrom } : {}),
    };
    if (!out.fallbackUsed) remember(key, value); // never cache the backup provider's voice
    return { speech: value };
  } catch (error) {
    return { speech: null, speech_unavailable: String(error.message).slice(0, 200) };
  }
}

/**
 * Spoken business question -> spoken answer through the NammaOps workflows. A request the
 * parser cannot map is answered (and spoken) with its explanation rather than guessed.
 */
/** @param {any} runtime @param {VoiceAudio} audio */
export async function voiceQuery(runtime, { bytes, mime, language }) {
  runtime.estop?.assertClear?.();
  const nammaops = runtime.nammaops;
  if (!nammaops) throw fail(503, "NammaOps is not available.");
  const heard = await transcribe(runtime, { bytes, mime, language });
  let workflow = null;
  let answer; // on-screen text
  let spoken; // short conversational version for the speaker
  let role = DEFAULT_SPEAKER;
  if (!heard.transcript.trim()) {
    answer = spoken = NOTHING_HEARD;
  } else {
    try {
      const started = nammaops.workflows.start({ text: heard.transcript }, { origin: "voice" });
      const finished = await Promise.race([
        started.done,
        new Promise((resolve) => setTimeout(() => resolve(null), WORKFLOW_WAIT_MS)),
      ]);
      const view = finished ?? nammaops.workflows.view(started.workflow.id);
      const action = view.intent?.action ?? null;
      role = SPEAKER_FOR_ACTION[action] ?? DEFAULT_SPEAKER;
      workflow = {
        id: view.id,
        action,
        status: finished ? view.status : "running",
        summary: view.summary ?? view.error ?? null,
      };
      answer = finished
        ? (view.summary ?? view.error ?? "The request finished without a summary.")
        : "Still working on it. Check the Workflows page for the result.";
      spoken = finished
        ? spokenAnswer(view.result, { today: nammaops.workflows.today(), fallback: answer })
        : "Still working on it. Check the Workflows page for the result.";
    } catch (error) {
      if (![400, 409, 422].includes(error.status)) throw error;
      answer = error.message;
      spoken = error.status === 422 ? UNDERSTOOD_NOTHING : error.message;
    }
  }
  const agent = { role, ...agentVoices(runtime)[role] };
  return {
    heard,
    workflow,
    answer,
    spoken,
    agent,
    ...(await speakText(runtime, spoken, {
      language: heard.language ?? undefined,
      voice: agent.voice,
    })),
  };
}
