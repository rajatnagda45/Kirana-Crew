import { describe, expect, it, vi } from "vitest";
import {
  createReplyTranslator,
  detectLanguage,
  inAskedLanguage,
  keepsFigures,
} from "../server/nammaops/reply-language.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("which language the owner asked in", () => {
  it.each([
    ["Check the stock of milk and rice.", null],
    ["Carol, aaj ki total kitni sale hui aur sabse zyaada kya bika?", "hinglish"],
    ["Bob, kaunsi cheez reorder level se neeche hai aur kitna stock bacha hai?", "hinglish"],
    ["बॉब, कौन सी चीज़ रीऑर्डर लेवल से नीचे है?", "hi"],
    ["ಬಾಬ್, ಆರ್ಡರ್ ಮಟ್ಟಕ್ಕಿಂತ ಕೆಳಗೆ ಏನು ಇದೆ ಮತ್ತು ಎಷ್ಟು ಸ್ಟಾಕ್ ಉಳಿದಿದೆ?", "kn"],
    ["nanage innu stock eshtu ide helu", "kn"],
    ["create bill of customer rohan with item 1 kg kabuli Chana", null],
  ])("%s -> %s", (text, code) => {
    expect(detectLanguage(text)?.code ?? null).toBe(code);
  });

  it("gives Gnani the matching language code", () => {
    expect(detectLanguage("आज की बिक्री बताओ")?.tts).toBe("hi-IN");
    expect(detectLanguage("aaj ki sale kya hai batao")?.tts).toBe("hi-en");
  });
});

describe("figures survive translation", () => {
  it("accepts a translation that keeps every number and rejects one that changes a figure", () => {
    const english = "Sales: ₹4,17,540 from 169 bills. Best day 2026-10-24.";
    expect(keepsFigures(english, "बिक्री: ₹4,17,540, 169 बिल. सबसे अच्छा दिन 2026-10-24.")).toBe(true);
    expect(keepsFigures(english, "बिक्री: ₹4,17,450, 169 बिल. 2026-10-24.")).toBe(false);
    expect(keepsFigures(english, "बिक्री: ₹4,17,540 और बिल.")).toBe(false);
  });

  it("falls back to the English answer when the model changes a number or the script is wrong", async () => {
    const english = "5 products at or below reorder level. Coconut Hair Oil 200ml: 4 Nos.";
    const model = (text: string) => ({
      models: { generateContent: vi.fn(async () => ({ text })) },
    });
    const hi = detectLanguage("बॉब, स्टॉक बताओ")!;
    const good = createReplyTranslator({
      client: model("5 प्रोडक्ट रीऑर्डर लेवल पर या नीचे हैं। Coconut Hair Oil 200ml: 4 Nos।") as Any,
    });
    expect(await good(english, hi)).toContain("रीऑर्डर");
    const changed = createReplyTranslator({
      client: model("6 प्रोडक्ट रीऑर्डर लेवल से नीचे हैं। Coconut Hair Oil 200ml: 4 Nos।") as Any,
    });
    expect(await changed(english, hi)).toBe(english);
    const wrongScript = createReplyTranslator({ client: model(english) as Any });
    expect(await wrongScript(english, hi)).toBe(english);
  });

  it("rejects a translation that slips into another script, and retries without thinking when it is refused", async () => {
    const english = "5 products low. Total 295.";
    const kn = detectLanguage("ಬಾಬ್, ಸ್ಟಾಕ್ ಎಷ್ಟು ಇದೆ")!;
    const slip = createReplyTranslator({
      client: { models: { generateContent: vi.fn(async () => ({ text: "5 ಉತ್ಪನ್ನ کمی ಇವೆ. ಒಟ್ಟು 295." })) } } as Any,
    });
    expect(await slip(english, kn)).toBe(english);
    const calls: Any[] = [];
    const picky = createReplyTranslator({
      client: {
        models: {
          generateContent: vi.fn(async (args: Any) => {
            calls.push(args.config.thinkingConfig);
            if (args.config.thinkingConfig) throw new Error("Thinking level MINIMAL is not supported");
            return { text: "5 ಉತ್ಪನ್ನಗಳು ಕಡಿಮೆ ಇವೆ. ಒಟ್ಟು 295." };
          }),
        },
      } as Any,
    });
    expect(await picky(english, kn)).toContain("ಒಟ್ಟು 295");
    expect(calls).toEqual([{ thinkingLevel: "MINIMAL" }, undefined]);
  });

  it("falls back when the model call fails", async () => {
    const translate = createReplyTranslator({
      client: { models: { generateContent: vi.fn(async () => Promise.reject(new Error("boom"))) } } as Any,
    });
    expect(await translate("Total ₹295.", detectLanguage("kitna hua batao aaj")!)).toBe(
      "Total ₹295.",
    );
  });
});

describe("inAskedLanguage", () => {
  it("leaves an English question alone and never calls the translator", async () => {
    const translator = vi.fn();
    const out = await inAskedLanguage({ replyTranslator: translator }, "How much udhaar?", "Udhaar ₹10.");
    expect(out).toEqual({ text: "Udhaar ₹10.", language: null });
    expect(translator).not.toHaveBeenCalled();
  });

  it("translates for a Hinglish question", async () => {
    const translator = vi.fn(async () => "Udhaar ₹10 baaki hai.");
    const out = await inAskedLanguage(
      { replyTranslator: translator },
      "kitna udhaar baaki hai batao",
      "Udhaar ₹10 pending.",
    );
    expect(out.text).toBe("Udhaar ₹10 baaki hai.");
    expect(out.language?.code).toBe("hinglish");
  });
});
