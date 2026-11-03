import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  createTtsProvider,
  fallbackTtsProvider,
  gnaniTtsProvider,
  geminiTtsProvider,
  pcmToWav,
  rateLimiter,
  validSpeech,
} from "../server/tts.mjs";
import { createSttProvider, fallbackProvider, isProviderOutage } from "../server/stt.mjs";
import { handleAgentApi, agentRoute } from "../server/agent-api.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const err = (status: number, upstreamStatus?: number) =>
  Object.assign(new Error(`e${status}`), { status, upstreamStatus });

describe("STT fallback (Gnani Prisma primary, Gemini optional)", () => {
  it("treats only outages as fallback-worthy", () => {
    expect(isProviderOutage(err(504))).toBe(true);
    expect(isProviderOutage(err(502))).toBe(true);
    expect(isProviderOutage(err(502, 503))).toBe(true);
    expect(isProviderOutage(err(502, 401))).toBe(false);
    expect(isProviderOutage(err(422))).toBe(false);
    expect(isProviderOutage(err(400))).toBe(false);
  });

  it("falls back on an outage and reports which provider produced the transcript", async () => {
    const primary = {
      name: "gnani-prisma",
      verifiesRecognition: true,
      transcribe: vi.fn().mockRejectedValue(err(504)),
    };
    const secondary = {
      name: "gemini",
      verifiesRecognition: true,
      transcribe: vi.fn().mockResolvedValue({ transcript: "haalu", provider: "gemini" }),
    };
    const result = await fallbackProvider(primary, secondary).transcribe({});
    expect(result).toMatchObject({
      provider: "gemini",
      fallbackUsed: true,
      fallbackFrom: "gnani-prisma",
    });
  });

  it("never falls back when the primary rejected the request", async () => {
    const primary = { name: "gnani-prisma", transcribe: vi.fn().mockRejectedValue(err(502, 401)) };
    const secondary = { name: "gemini", transcribe: vi.fn() };
    await expect(fallbackProvider(primary, secondary).transcribe({})).rejects.toThrow("e502");
    expect(secondary.transcribe).not.toHaveBeenCalled();
  });

  it("is configured by env; an unconfigured fallback leaves the primary alone", () => {
    expect(createSttProvider({})).toBeNull();
    expect(
      createSttProvider({
        AGENT_TOWN_STT_PROVIDER: "gnani",
        GNANI_API_KEY: "k",
        AGENT_TOWN_STT_FALLBACK: "gemini",
      })!.name,
    ).toBe("gnani-prisma");
    expect(
      createSttProvider({
        AGENT_TOWN_STT_PROVIDER: "gnani",
        GNANI_API_KEY: "k",
        AGENT_TOWN_STT_FALLBACK: "gemini",
        GEMINI_API_KEY: "g",
      })!.name,
    ).toBe("gnani-prisma+gemini");
  });
});

describe("TTS providers", () => {
  it("validates input", () => {
    expect(() => validSpeech({ text: "" })).toThrow(/required/);
    expect(() => validSpeech({ text: "x".repeat(2001) })).toThrow(/exceeds/);
    expect(() => validSpeech({ text: "hi", language: "../x" })).toThrow(/language/);
    expect(validSpeech({ text: " namaskara ", language: "kn-IN" })).toEqual({
      text: "namaskara",
      language: "kn-IN",
      voice: undefined,
    });
  });

  it("is unset without a provider, needs a Gnani key, and rejects an unknown Timbre model", () => {
    expect(createTtsProvider({})).toBeNull();
    expect(() => createTtsProvider({ AGENT_TOWN_TTS_PROVIDER: "gnani" })).toThrow(/GNANI_API_KEY/);
    expect(() =>
      createTtsProvider({
        AGENT_TOWN_TTS_PROVIDER: "gnani",
        GNANI_API_KEY: "k",
        GNANI_TTS_MODEL: "timbre-v9",
      }),
    ).toThrow(/GNANI_TTS_MODEL/);
  });

  it("Gnani Timbre: verified request shape, key only in the header, raw PCM wrapped as 24 kHz WAV", async () => {
    const pcm = new Uint8Array(480); // 10 ms of 24 kHz 16-bit mono
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(pcm, { headers: { "content-type": "application/octet-stream" } }),
      );
    // A host-only URL (as it was configured) gets the inference path; a model name in the
    // voice setting falls back to a real voice.
    const tts = gnaniTtsProvider({
      apiKey: "secret",
      url: "https://api.vachana.ai",
      voice: "timbre-v3.0",
      language: "kn-IN",
      fetchImpl,
    });
    const out = await tts.synthesize({ text: "Stock check complete" });
    expect(tts.contractVerified).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.vachana.ai/api/v1/tts/inference");
    expect(init.headers["X-API-Key-ID"]).toBe("secret");
    expect(JSON.parse(init.body)).toEqual({
      text: "Stock check complete",
      model: "timbre-v3.0",
      voice: "Avinash",
      language_code: "kn-IN",
    });
    expect(init.body).not.toContain("secret");
    expect(out).toMatchObject({ mime: "audio/wav", provider: "gnani-timbre" });
    expect(out.bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(out.bytes.readUInt32LE(24)).toBe(24000);
    expect(out.bytes.length).toBe(44 + pcm.length);
  });

  it("Gnani Timbre: a named voice is passed through and a real audio container is not re-wrapped", async () => {
    const wav = pcmToWav(Buffer.alloc(4), 24000);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(wav, { headers: { "content-type": "audio/wav" } }));
    const out = await gnaniTtsProvider({ apiKey: "k", fetchImpl }).synthesize({
      text: "hi",
      voice: "Lakshmi",
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).voice).toBe("Lakshmi");
    expect(out.bytes.length).toBe(wav.length);
  });

  it("Gemini: wraps raw PCM in a WAV container", async () => {
    const client = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          candidates: [
            { content: { parts: [{ inlineData: { data: Buffer.alloc(8).toString("base64") } }] } },
          ],
        }),
      },
    };
    const out = await geminiTtsProvider({ client }).synthesize({ text: "hello" });
    expect(out.mime).toBe("audio/wav");
    expect(out.bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(out.bytes.length).toBe(44 + 8);
    expect(pcmToWav(Buffer.alloc(2)).readUInt32LE(24)).toBe(24000);
  });

  it("falls back from Gnani to Gemini only on an outage", async () => {
    const primary: Any = { name: "gnani-timbre", synthesize: vi.fn().mockRejectedValue(err(503)) };
    const secondary: Any = {
      name: "gemini",
      synthesize: vi
        .fn()
        .mockResolvedValue({ bytes: Buffer.alloc(1), mime: "audio/wav", provider: "gemini" }),
    };
    expect(await fallbackTtsProvider(primary, secondary).synthesize({ text: "x" })).toMatchObject({
      provider: "gemini",
      fallbackUsed: true,
    });
  });

  it("rate limits within the window", () => {
    let t = 0;
    const limit = rateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    limit();
    limit();
    expect(() => limit()).toThrow(/Too many/);
    t = 1000;
    expect(() => limit()).not.toThrow();
  });
});

describe("POST /api/tasks/voice/speak", () => {
  const call = async (runtime: Any, body: Any) => {
    const req: Any = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: "POST", headers: {} });
    try {
      return await handleAgentApi(runtime, req, agentRoute("/api/tasks/voice/speak")!);
    } catch (error: Any) {
      return { status: error.status, body: { error: error.message } };
    }
  };
  const base = () => ({
    profiles: {},
    agentTasks: {},
    estop: { assertClear: () => {} },
    ttsFactory: () => createTtsProvider({ AGENT_TOWN_TTS_PROVIDER: "fixture" }),
  });

  it("speaks through the configured provider and labels the result honestly", async () => {
    const res: Any = await call(base(), { text: "Stock is low for milk." });
    expect(res.status).toBe(200);
    expect(res.body.speech).toMatchObject({
      provider: "fixture",
      mime: "audio/wav",
      verifies_speech: false,
      provider_contract_verified: true,
    });
    expect(Buffer.from(res.body.speech.audio_base64, "base64").subarray(0, 4).toString()).toBe(
      "RIFF",
    );
  });

  it("is 503 without a provider, 423 under emergency stop, 400 on bad input", async () => {
    expect((await call({ ...base(), ttsFactory: () => null }, { text: "x" })).status).toBe(503);
    const stopped = {
      ...base(),
      estop: {
        assertClear: () => {
          throw Object.assign(new Error("Emergency stop is engaged."), { status: 423 });
        },
      },
    };
    expect((await call(stopped, { text: "x" })).status).toBe(423);
    expect((await call(base(), { text: "" })).status).toBe(400);
  });
});

describe("Gnani Prisma STT request", () => {
  it("names the upload by its real extension and always sends a language", async () => {
    const { gnaniProvider } = await import("../server/stt.mjs");
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, transcript: "check milk stock" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const out = await gnaniProvider({ apiKey: "k", fetchImpl }).transcribe({
      bytes: Buffer.from("RIFF"),
      mime: "audio/wav",
    });
    expect(out.transcript).toBe("check milk stock");
    const form = fetchImpl.mock.calls[0][1].body as FormData;
    // Gnani returns 400 for a bare "audio" filename and 422 without language_code.
    expect((form.get("audio_file") as File).name).toBe("audio.wav");
    expect(form.get("language_code")).toBe("en-IN");
  });
});

describe("Gnani-first voice pipeline", () => {
  it("voiceQuery: audio -> transcript -> governed workflow -> spoken summary, no agent task", async () => {
    const { ready } = await import("./nammaops-harness");
    const { voiceQuery } = await import("../server/voice-pipeline.mjs");
    const ctx: Any = await ready();
    ctx.runtime.sttFactory = () => ({
      name: "gnani-prisma",
      verifiesRecognition: true,
      transcribe: async () => ({
        transcript: "How much udhaar is pending?",
        provider: "gnani-prisma",
      }),
    });
    ctx.runtime.ttsFactory = () => createTtsProvider({ AGENT_TOWN_TTS_PROVIDER: "fixture" });
    const out: Any = await voiceQuery(ctx.runtime, {
      bytes: pcmToWav(Buffer.alloc(320), 16000),
      mime: "audio/wav",
      language: "en-IN",
    });
    expect(out.heard).toMatchObject({
      transcript: "How much udhaar is pending?",
      provider: "gnani-prisma",
    });
    expect(out.workflow).toMatchObject({ action: "receivables_report", status: "completed" });
    expect(out.answer).toMatch(/Udhaar pending/);
    expect(out.speech).toMatchObject({ provider: "fixture", mime: "audio/wav" });
    expect(ctx.runtime.seatOwner().submit).not.toHaveBeenCalled(); // no OpenClaw task was started
  });

  it("voiceQuery: an unsupported request is answered with the explanation, not guessed", async () => {
    const { ready } = await import("./nammaops-harness");
    const { voiceQuery } = await import("../server/voice-pipeline.mjs");
    const ctx: Any = await ready();
    ctx.runtime.sttFactory = () => ({
      name: "gnani-prisma",
      transcribe: async () => ({ transcript: "sing me a song", provider: "gnani-prisma" }),
    });
    ctx.runtime.ttsFactory = () => null;
    const out: Any = await voiceQuery(ctx.runtime, {
      bytes: pcmToWav(Buffer.alloc(320), 16000),
      mime: "audio/wav",
    });
    expect(out.workflow).toBeNull();
    expect(out.answer).toMatch(/Please rephrase/);
    expect(out.speech).toBeNull();
    expect(out.speech_unavailable).toMatch(/text-to-speech/);
  });

  it("reports providers without secrets", async () => {
    const { voiceProviders } = await import("../server/voice-pipeline.mjs");
    const p = voiceProviders({
      AGENT_TOWN_STT_PROVIDER: "gnani",
      AGENT_TOWN_STT_FALLBACK: "gemini",
      AGENT_TOWN_TTS_PROVIDER: "gnani",
      GNANI_API_KEY: "super-secret-key",
      GEMINI_API_KEY: "another-secret",
    });
    expect(p.stt).toMatchObject({ primary: "gnani", fallback: "gemini", configured: true });
    expect(p.tts).toMatchObject({ primary: "gnani", configured: true });
    expect(JSON.stringify(p)).not.toMatch(/secret/);
  });
});
