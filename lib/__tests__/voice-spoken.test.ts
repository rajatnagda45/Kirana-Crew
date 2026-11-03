import { describe, expect, it, vi } from "vitest";
import { nameList, rupees, spokenAnswer, SPEAKER_FOR_ACTION } from "../server/nammaops/spoken.mjs";
import { agentVoices, saveAgentVoices, speakText, voiceQuery } from "../server/voice-pipeline.mjs";
import { pcmToWav } from "../server/tts.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Synthetic TEST FIXTURE only. Speech providers are stubs that record what they were asked to say.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function stubs(ctx: Any, transcript: string) {
  const said: Array<{ text: string; voice?: string }> = [];
  ctx.runtime.sttFactory = () => ({
    name: "gnani-prisma",
    verifiesRecognition: true,
    transcribe: async () => ({ transcript, provider: "gnani-prisma" }),
  });
  ctx.runtime.ttsFactory = () => ({
    name: "gnani-timbre",
    contractVerified: true,
    synthesize: vi.fn(async ({ text, voice }: Any) => {
      said.push({ text, voice });
      return {
        bytes: pcmToWav(Buffer.alloc(200), 44100),
        mime: "audio/wav",
        provider: "gnani-timbre",
      };
    }),
  });
  return said;
}
const audio = { bytes: pcmToWav(Buffer.alloc(320), 16000), mime: "audio/wav", language: "en-IN" };

describe("spoken answers", () => {
  it("formats rupees and name lists the way a person says them", () => {
    expect(rupees(49509.38)).toBe("49,509 rupees");
    expect(rupees(1_234_567)).toBe("12.3 lakh rupees");
    expect(rupees(25_000_000)).toBe("2.5 crore rupees");
    expect(rupees(-500)).toBe("minus 500 rupees");
    expect(nameList(["A"])).toBe("A");
    expect(nameList(["A", "B", "C"])).toBe("A, B and C");
    expect(nameList(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });

  it("never reads parentheses, item(s) or lists, and stays short", () => {
    const text = spokenAnswer(
      {
        kind: "stock_check",
        rows: Array.from({ length: 40 }, (_, i) => ({ item_code: `I${i}` })),
        low: [
          { item_name: "Coconut Hair Oil 200ml", available: 4 },
          { item_name: "Coriander Powder 200g", available: 2 },
          { item_name: "Millet Flakes 500g", available: 0 },
          { item_name: "Urad Dal 1kg", available: 4 },
        ],
      },
      { today: TODAY },
    );
    expect(text).not.toMatch(/[()]/);
    expect(text).not.toMatch(/item\(s\)/);
    expect(text).toMatch(
      /running low: Coconut Hair Oil 200ml, Coriander Powder 200g, Millet Flakes 500g and 1 more\./,
    );
    expect(text).toMatch(/Millet Flakes 500g is out of stock\./);
    expect(text.length).toBeLessThan(320);
  });

  it("says udhaar in plain sentences using only the verified figures", () => {
    const text = spokenAnswer({
      kind: "receivables_report",
      total_outstanding: 49509.38,
      overdue_over_30_days: { customers: 9, amount: 20606.83 },
      collection_priority: [{ customer: "Jivin Cheema" }, { customer: "Yasmin Kamdar" }],
    });
    expect(text).toBe(
      "Udhaar pending is 49,509 rupees. 9 customers have not paid for over thirty days, 20,607 rupees in all. Collect first from Jivin Cheema and Yasmin Kamdar.",
    );
  });

  it("is honest when data is missing", () => {
    expect(spokenAnswer({ kind: "expiry_check", batches_tracked: 0 })).toMatch(
      /no batch dates are recorded/,
    );
  });

  it("gives every workflow a speaker", () => {
    for (const action of [
      "stock_check",
      "daily_report",
      "receivables_report",
      "purchase_status",
      "store_health_report",
    ])
      expect(SPEAKER_FOR_ACTION[action as keyof typeof SPEAKER_FOR_ACTION]).toBeTruthy();
  });
});

describe("each agent has its own voice", () => {
  it("ships five distinct default voices and lets the owner override them", async () => {
    const ctx: Any = await ready();
    const defaults = agentVoices(ctx.runtime);
    expect(new Set(Object.values(defaults).map((v: Any) => v.voice)).size).toBe(5);
    const saved = saveAgentVoices(ctx.runtime, { sales: "Tarika" });
    expect(saved.sales).toMatchObject({ voice: "Tarika", custom: true });
    expect(saved.finance.custom).toBe(false);
    expect(() => saveAgentVoices(ctx.runtime, { sales: "NoSuchVoice" })).toThrow(/Unknown voice/);
    expect(() => saveAgentVoices(ctx.runtime, { janitor: "Avinash" })).toThrow(/Unknown role/);
  });

  it("speaks a stock answer as Bob and an udhaar answer as Erin, in short sentences", async () => {
    const ctx: Any = await ready();
    const voices = agentVoices(ctx.runtime);
    const said = stubs(ctx, "Please check the stock of milk");
    const stock: Any = await voiceQuery(ctx.runtime, audio);
    expect(stock.agent).toMatchObject({
      role: "inventory",
      name: "Bob",
      voice: voices.inventory.voice,
    });
    expect(said.at(-1)).toMatchObject({ voice: voices.inventory.voice });
    expect(said.at(-1)!.text).toBe(stock.spoken);
    expect(stock.spoken.length).toBeLessThan(stock.answer.length + 1);

    const udhaarSaid = stubs(ctx, "How much udhaar is pending");
    const udhaar: Any = await voiceQuery(ctx.runtime, audio);
    expect(udhaar.agent).toMatchObject({
      role: "finance",
      name: "Erin",
      voice: voices.finance.voice,
    });
    expect(udhaarSaid.at(-1)!.voice).toBe(voices.finance.voice);
    expect(udhaar.spoken).toMatch(/^Udhaar pending is [\d,]+ rupees\./);
    expect(udhaar.spoken).not.toMatch(/[()]/);
  });

  it("answers an unsupported request with one short line, not the long help text", async () => {
    const ctx: Any = await ready();
    const said = stubs(ctx, "sing me a song");
    const out: Any = await voiceQuery(ctx.runtime, audio);
    expect(out.workflow).toBeNull();
    expect(out.agent.role).toBe("manager");
    expect(said.at(-1)!.text).toBe(
      "Sorry, I did not catch that. You can ask about stock, sales, udhaar, expiry, suppliers or customers.",
    );
    expect(out.answer.length).toBeGreaterThan(said.at(-1)!.text.length); // screen keeps the full help
  });

  it("says so when nothing was heard", async () => {
    const ctx: Any = await ready();
    const said = stubs(ctx, "   ");
    const out: Any = await voiceQuery(ctx.runtime, audio);
    expect(out.workflow).toBeNull();
    expect(said.at(-1)!.text).toBe("I did not hear anything. Please try again.");
  });
});

describe("text-to-speech cache", () => {
  it("serves a repeated phrase from memory without another synthesis", async () => {
    const ctx: Any = await ready();
    const said = stubs(ctx, "x");
    const a: Any = await speakText(ctx.runtime, "Your udhaar report is ready.", {
      voice: "Avinash",
    });
    const b: Any = await speakText(ctx.runtime, "Your udhaar report is ready.", {
      voice: "Avinash",
    });
    expect(a.speech.cached).toBeUndefined();
    expect(b.speech.cached).toBe(true);
    expect(said).toHaveLength(1);
    // A different voice is a different clip.
    await speakText(ctx.runtime, "Your udhaar report is ready.", { voice: "Lakshmi" });
    expect(said).toHaveLength(2);
  });

  it("never caches the backup provider's voice", async () => {
    const ctx: Any = await ready();
    let calls = 0;
    ctx.runtime.ttsFactory = () => ({
      name: "gnani-timbre+gemini",
      contractVerified: true,
      synthesize: async () => {
        calls += 1;
        return {
          bytes: Buffer.alloc(100),
          mime: "audio/wav",
          provider: "gemini",
          fallbackUsed: true,
          fallbackFrom: "gnani-timbre",
        };
      },
    });
    await speakText(ctx.runtime, "Backup voice test sentence one.", { voice: "Avinash" });
    await speakText(ctx.runtime, "Backup voice test sentence one.", { voice: "Avinash" });
    expect(calls).toBe(2);
  });
});

describe("POST /api/tasks/voice/speak", () => {
  it("passes the agent's voice through and serves a repeated acknowledgement from the cache", async () => {
    const { Readable } = await import("node:stream");
    const { handleAgentApi, agentRoute } = await import("../server/agent-api.mjs");
    const said: Array<{ text: string; voice?: string }> = [];
    const runtime: Any = {
      profiles: {},
      agentTasks: {},
      estop: { assertClear: () => {} },
      ttsFactory: () => ({
        name: "gnani-timbre",
        verifiesSpeech: true,
        contractVerified: true,
        synthesize: async ({ text, voice }: Any) => {
          said.push({ text, voice });
          return { bytes: Buffer.alloc(64), mime: "audio/wav", provider: "gnani-timbre" };
        },
      }),
    };
    const speak = async (body: Any) => {
      const req: Any = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method: "POST", headers: {} });
      return (await handleAgentApi(runtime, req, agentRoute("/api/tasks/voice/speak")!))
        .body as Any;
    };
    const first = await speak({
      text: "Let me check cache test.",
      voice: "Shivani",
      language: "en-IN",
    });
    const second = await speak({
      text: "Let me check cache test.",
      voice: "Shivani",
      language: "en-IN",
    });
    expect(said).toEqual([{ text: "Let me check cache test.", voice: "Shivani" }]);
    expect(first.speech.cached).toBeUndefined();
    expect(second.speech.cached).toBe(true);
    expect(second.speech.provider_contract_verified).toBe(true);
  });
});
