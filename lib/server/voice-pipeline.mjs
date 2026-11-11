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
import { inAskedLanguage } from "./nammaops/reply-language.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTtsProvider, validSpeech, MAX_TTS_CHARS, GNANI_TTS_VOICES } from "./tts.mjs";
import {
  DEFAULT_SPEAKER,
  NOTHING_HEARD,
  NOTHING_HEARD_HI,
  SPEAKER_FOR_ACTION,
  UNDERSTOOD_NOTHING,
  UNDERSTOOD_NOTHING_HI,
  spokenAnswer,
} from "./nammaops/spoken.mjs";
import { resolveResponseLang } from "./nammaops/lang-detect.mjs";
import {
  clarifyIntent,
  resolveIntent,
  toWorkflowIntent,
  validateIntent,
} from "./nammaops/intent-contract.mjs";

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
/**
 * One spoken turn through the shared intent contract (the same resolve, validate and clarify steps
 * as chat). Falls back to the keyword reader on the raw text when the contract has no store
 * question for it, so nothing the old path answered is lost.
 * @returns {Promise<{ clarify: string[] } | { intent: object, owner: string | null } | { text: string }>}
 */
async function understandTurn(nammaops, transcript) {
  const today = nammaops.workflows.today();
  await nammaops.intents?.prime?.(transcript);
  const resolved = resolveIntent(transcript, {
    intents: nammaops.intents,
    today,
    seats: (nammaops.voice?.departments?.seats ?? []).map((seat) => seat.voice_name),
  });
  if (resolved.status !== "ok" || resolved.args.workflow_id) return { text: transcript };
  const valid = validateIntent(resolved.args);
  if (!valid.ok) return { text: transcript };
  const clarification = clarifyIntent(valid.args, transcript, today);
  if (clarification) return { clarify: clarification.questions };
  return { intent: toWorkflowIntent(valid.args, today), owner: resolved.department ?? null };
}

/**
 * @param {any} runtime
 * @param {VoiceAudio & { langPref?: string }} audio
 *   `langPref` is the user's explicit language preference (e.g. 'hl', 'hi-IN'); when provided it
 *   overrides STT-detected language for response text. TTS voice/language is set separately.
 */
export async function voiceQuery(runtime, { bytes, mime, language, langPref }) {
  runtime.estop?.assertClear?.();
  const nammaops = runtime.nammaops;
  if (!nammaops) throw fail(503, "NammaOps is not available.");
  const t0 = performance.now();
  const heard = await transcribe(runtime, { bytes, mime, language });
  // Resolve effective response language: explicit preference wins over STT-detected language.
  const responseLang = resolveResponseLang(langPref ?? null, heard.transcript);
  const t1 = performance.now();
  let workflow = null;
  let answer; // on-screen text
  let spoken; // short conversational version for the speaker
  let role = DEFAULT_SPEAKER;
  if (!heard.transcript.trim()) {
    const isHinglish = responseLang === "hl" || responseLang === "hi";
    answer = spoken = isHinglish ? NOTHING_HEARD_HI : NOTHING_HEARD;
  } else {
    try {
      const plan = await understandTurn(nammaops, heard.transcript);
      // The shared contract asked instead of guessing (an unclear period, a future day).
      if (plan.clarify) answer = spoken = plan.clarify.join(" ");
      else {
        const started = nammaops.workflows.start(
          plan.intent ? { intent: plan.intent } : { text: heard.transcript },
          { origin: "voice" },
        );
        const finished = await Promise.race([
          started.done,
          new Promise((resolve) => setTimeout(() => resolve(null), WORKFLOW_WAIT_MS)),
        ]);
        const view = finished ?? nammaops.workflows.view(started.workflow.id);
        const action = view.intent?.action ?? null;
        // The voice is the specialist who really ran it (from the workflow's own tasks): one
        // specialist speaks as themselves, several are voiced by the manager who coordinated them.
        // The action table is only the fallback when no step has run yet.
        const ran = [
          ...new Set(
            (view.tasks ?? []).filter((task) => task.role !== "manager").map((task) => task.role),
          ),
        ];
        const owner = plan.owner ?? SPEAKER_FOR_ACTION[action] ?? null;
        role =
          owner && owner !== "manager" && ran.includes(owner)
            ? owner
            : ran.length === 1
              ? ran[0]
              : ran.length > 1
                ? DEFAULT_SPEAKER
                : (SPEAKER_FOR_ACTION[action] ?? DEFAULT_SPEAKER);
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
          ? spokenAnswer(view.result, {
              today: nammaops.workflows.today(),
              fallback: answer,
              language: responseLang,
            })
          : "Still working on it. Check the Workflows page for the result.";
      }
    } catch (error) {
      if (![400, 409, 422].includes(error.status)) throw error;
      answer = error.message;
      const isHinglish = responseLang === "hl" || responseLang === "hi";
      spoken =
        error.status === 422
          ? isHinglish
            ? UNDERSTOOD_NOTHING_HI
            : UNDERSTOOD_NOTHING
          : error.message;
    }
  }
  // Answer in the language the owner spoke (detected from what they said, not from the upload's
  // language hint). English stays untouched and makes no extra call.
  const t2 = performance.now();
  let speechLanguage = heard.language ?? undefined;
  if (heard.transcript.trim()) {
    const [shown, voiced] = await Promise.all([
      inAskedLanguage(runtime, heard.transcript, answer),
      inAskedLanguage(runtime, heard.transcript, spoken),
    ]);
    answer = shown.text;
    spoken = voiced.text;
    if (voiced.language) speechLanguage = voiced.language.tts;
  }
  const t2b = performance.now();
  const agent = { role, ...agentVoices(runtime)[role] };
  const spoken_out = await speakText(runtime, spoken, {
    language: speechLanguage,
    voice: agent.voice,
  });
  const t3 = performance.now();
  // Where the time goes in one spoken turn, so slow replies can be traced to a stage.
  const timings = {
    stt_ms: Math.round(t1 - t0),
    workflow_ms: Math.round(t2 - t1),
    translate_ms: Math.round(t2b - t2),
    tts_ms: Math.round(t3 - t2b),
    total_ms: Math.round(t3 - t0),
  };
  console.info(`[voice] turn timings ${JSON.stringify(timings)}`);
  return { heard, workflow, answer, spoken, agent, ...spoken_out, timings };
}
