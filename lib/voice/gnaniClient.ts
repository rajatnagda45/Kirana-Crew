/** One spoken question to the Gnani pipeline (shared by push-to-talk and hands-free live mode). */
export interface GnaniAnswer {
  heard: string;
  answer: string;
  spoken: string;
  sttProvider: string | null;
  ttsProvider: string | null;
  fallbackUsed: boolean;
  cached: boolean;
  agent: { role: string; name: string; voice: string } | null;
  workflow: { id: string; action: string | null; status: string } | null;
  audio: { base64: string; mime: string } | null;
}

export type GnaniResult =
  | { kind: "ok"; value: GnaniAnswer }
  /** The Gnani path cannot serve this (not configured, server error, unreachable): use the backup. */
  | { kind: "unavailable"; reason: string }
  /** The request itself was refused (rate limit, emergency stop, bad audio): do not fall back. */
  | { kind: "refused"; message: string };

export async function askGnani(audio: Blob, language: string): Promise<GnaniResult> {
  const form = new FormData();
  form.set("audio", audio, "question.wav");
  form.set("language", language);
  let res: Response;
  try {
    res = await fetch("/api/runtime/nammaops/voice-query", { method: "POST", body: form });
  } catch {
    return { kind: "unavailable", reason: "The voice service could not be reached." };
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 503 || res.status >= 500)
    return { kind: "unavailable", reason: body.error || `Voice service error ${res.status}.` };
  if (!res.ok)
    return { kind: "refused", message: body.error || `Voice request failed (${res.status}).` };
  return {
    kind: "ok",
    value: {
      heard: body.heard?.transcript ?? "",
      answer: body.answer ?? "",
      spoken: body.spoken ?? body.answer ?? "",
      sttProvider: body.heard?.provider ?? null,
      ttsProvider: body.speech?.provider ?? null,
      fallbackUsed: Boolean(body.heard?.fallback_used || body.speech?.fallback_used),
      cached: Boolean(body.speech?.cached),
      agent: body.agent ?? null,
      workflow: body.workflow ?? null,
      audio: body.speech?.audio_base64
        ? { base64: body.speech.audio_base64, mime: body.speech.mime ?? "audio/wav" }
        : null,
    },
  };
}
