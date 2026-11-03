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

  it("returns 503 when unset or when the Gnani Timbre endpoint is not configured", () => {
    expect(createTtsProvider({})).toBeNull();
    expect(() =>
      createTtsProvider({ AGENT_TOWN_TTS_PROVIDER: "gnani", GNANI_API_KEY: "k" }),
    ).toThrow(/GNANI_TTS_URL/);
  });

  it("Gnani: key only in the header, audio body passed through, contract marked unverified", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
      );
    const tts = gnaniTtsProvider({ apiKey: "secret", url: "https://tts.example/v1", fetchImpl });
    const out = await tts.synthesize({ text: "hello", language: "hi-IN" });
    expect(out).toMatchObject({ mime: "audio/mpeg", provider: "gnani-timbre" });
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(tts.contractVerified).toBe(false);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["X-API-Key-ID"]).toBe("secret");
    expect(init.body).not.toContain("secret");
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
