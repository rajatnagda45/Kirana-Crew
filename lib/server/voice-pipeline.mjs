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
import { createTtsProvider, validSpeech, MAX_TTS_CHARS } from "./tts.mjs";

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

/** Text -> speech; returns null (with the reason) when no provider can speak, never throws. */
/** @param {any} runtime @param {string} text @param {string} [language] */
export async function speakText(runtime, text, language) {
  try {
    const tts = provider(() => runtime.ttsFactory?.(), "text-to-speech");
    const speech = validSpeech({ text: String(text).slice(0, MAX_TTS_CHARS), language });
    runtime.ttsLimit?.();
    const out = await tts.synthesize(speech);
    return {
      speech: {
        provider: out.provider,
        mime: out.mime,
        audio_base64: out.bytes.toString("base64"),
        bytes: out.bytes.length,
        provider_contract_verified: tts.contractVerified === true,
        ...(out.fallbackUsed ? { fallback_used: true, fallback_from: out.fallbackFrom } : {}),
      },
    };
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
  let answer;
  try {
    const started = nammaops.workflows.start({ text: heard.transcript }, { origin: "voice" });
    const finished = await Promise.race([
      started.done,
      new Promise((resolve) => setTimeout(() => resolve(null), WORKFLOW_WAIT_MS)),
    ]);
    const view = finished ?? nammaops.workflows.view(started.workflow.id);
    workflow = {
      id: view.id,
      action: view.intent?.action ?? null,
      status: finished ? view.status : "running",
      summary: view.summary ?? view.error ?? null,
    };
    answer = finished
      ? (view.summary ?? view.error ?? "The request finished without a summary.")
      : "Still working on it. Check the Workflows page for the result.";
  } catch (error) {
    if (![400, 409, 422].includes(error.status)) throw error;
    answer = error.message;
  }
  return {
    heard,
    workflow,
    answer,
    ...(await speakText(runtime, answer, heard.language ?? undefined)),
  };
}
