import { describe, expect, it } from "vitest";
import { createIntentUnderstanding, redactSecrets } from "../server/nammaops/intent-llm.mjs";
import { createDeadline } from "../server/nammaops/turn-deadline.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const TODAY = "2026-11-04";
const WORKFORCE: Any = {
  agents: [{ role: "sales", name: "Sales Agent", purpose: "Understand sales." }],
  voice_departments: { seats: [{ voice_name: "Carol", department: "sales", title: "Sales" }] },
};
const GOOD = { intent: "sales_summary", day: "2026-11-02", confidence: 0.95 };

type Call = { model: string; prompt: string; signal: AbortSignal | undefined; config: Any };

/** A fake Gemini: per-model behaviour, records every request and whether it was aborted. */
function fake(behaviour: Record<string, (call: Call) => Promise<Any>>) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      models: {
        generateContent: async ({ model, contents, config }: Any) => {
          const call = {
            model,
            prompt: contents[0].parts[0].text,
            signal: config.abortSignal,
            config,
          };
          calls.push(call);
          return behaviour[model](call);
        },
      },
    },
  };
}
const hang = (call: Call) =>
  new Promise<Any>((_, reject) =>
    call.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
  );
const answer = (value: Any) => async () => ({ text: JSON.stringify(value) });
const make = (client: Any) =>
  createIntentUnderstanding({
    env: {},
    client,
    workforce: () => WORKFORCE,
    today: () => TODAY,
    seatNames: () => ["Carol"],
  });

describe("turn deadline", () => {
  it("counts down on a monotonic clock and never goes negative", () => {
    let t = 1000;
    const d = createDeadline(15000, { now: () => t });
    expect(d.remaining()).toBe(15000);
    t += 4000;
    expect(d.budget(4000)).toBe(4000);
    expect(d.waitMs()).toBe(9500);
    t += 20000;
    expect(d.remaining()).toBe(0);
    expect(d.expired()).toBe(true);
    expect(d.waitMs()).toBe(0);
  });
});

describe("secrets never reach the model", () => {
  it("redacts PIN-shaped digits around a pin word or in a bare digit reply", () => {
    expect(redactSecrets("my pin is 482913")).toBe("my pin is [digits]");
    expect(redactSecrets("482913")).toBe("[digits]");
    expect(redactSecrets("4 8 2 9 1 3")).toBe("[digits]");
    expect(redactSecrets("sales on 2026-11-02")).toBe("sales on 2026-11-02");
    expect(redactSecrets("stock above 5000 units")).toBe("stock above 5000 units");
  });

  it("keeps the PIN out of the request body, message and history alike", async () => {
    const f = fake({ "gemini-flash-lite-latest": answer(GOOD) });
    await make(f.client).prime("approve with pin 482913", {
      history: [{ role: "user", text: "the passcode is 771155" }],
    });
    expect(f.calls[0].prompt).not.toMatch(/482913|771155/);
    expect(f.calls[0].prompt).toContain("[digits]");
  });
});

describe("analysis time limit", () => {
  it("asks the fast model first with minimal thinking and an abort signal", async () => {
    const f = fake({ "gemini-flash-lite-latest": answer(GOOD) });
    const u = make(f.client);
    await u.prime("sales on 2 nov");
    expect(f.calls.map((c) => c.model)).toEqual(["gemini-flash-lite-latest"]);
    expect(f.calls[0].config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(u.peek("sales on 2 nov")).toMatchObject({ args: { intent: "sales_summary" } });
  });

  it("aborts a hung model at the limit and leaves the message to the keyword reader", async () => {
    const f = fake({ "gemini-flash-lite-latest": hang, "gemini-flash-latest": hang });
    const u = make(f.client);
    const t = performance.now();
    await u.prime("sales on 2 nov", {
      deadline: createDeadline(15000, { now: () => 0 }), // plenty of turn left; the 7 s cap rules
    });
    const took = performance.now() - t;
    expect(took).toBeGreaterThan(6500);
    expect(took).toBeLessThan(8500);
    expect(f.calls.length).toBe(1); // budget was spent; the second model is not tried
    expect(f.calls[0].signal?.aborted).toBe(true);
    expect(u.peek("sales on 2 nov")).toBeNull();
    expect(u.stats().errors).toBe(1);
  }, 10000);

  it("falls over to the second model at once when the first fails fast, and skips a 429 model", async () => {
    const quota = async () => {
      throw new Error("429 RESOURCE_EXHAUSTED quota");
    };
    const f = fake({ "gemini-flash-lite-latest": quota, "gemini-flash-latest": answer(GOOD) });
    const u = make(f.client);
    await u.prime("sales on 2 nov");
    await u.prime("sales on 3 nov");
    expect(f.calls.map((c) => c.model)).toEqual([
      "gemini-flash-lite-latest",
      "gemini-flash-latest",
      "gemini-flash-latest", // the exhausted model is not asked again
    ]);
  });

  it("makes one model call for one message even when asked twice at once", async () => {
    const f = fake({ "gemini-flash-lite-latest": answer(GOOD) });
    const u = make(f.client);
    await Promise.all([u.prime("sales on 2 nov"), u.prime("sales on 2 nov")]);
    expect(f.calls.length).toBe(1);
  });

  it("does not cache a failure, so the next turn can try again", async () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n === 1) throw new Error("503 unavailable");
      return { text: JSON.stringify(GOOD) };
    };
    const f = fake({ "gemini-flash-lite-latest": flaky, "gemini-flash-latest": flaky });
    const u = make(f.client);
    await u.prime("sales on 2 nov");
    expect(u.peek("sales on 2 nov")).not.toBeNull(); // second model answered within the same turn
    expect(f.calls.length).toBe(2);
  });

  it("does not call the model when the turn has no time left", async () => {
    const f = fake({ "gemini-flash-lite-latest": answer(GOOD) });
    const u = make(f.client);
    await u.prime("sales on 2 nov", { deadline: createDeadline(100) });
    expect(f.calls.length).toBe(0);
  });
});

describe("late result", () => {
  it("watches the same workflow and posts once, even when attached twice", async () => {
    const { watchForResult } = await import("../server/nammaops/late-result.mjs");
    let polls = 0;
    const queries: Any[] = [];
    const voice = {
      query: async (q: Any) => {
        queries.push(q);
        polls += 1;
        return polls < 3 ? { status: "running" } : { status: "complete", facts: ["done"] };
      },
    };
    const posted: Any[] = [];
    const args = {
      voice,
      call: { id: "c1", name: "Frank" },
      intent: "demand_forecast",
      workflowId: "wf_1",
      post: (r: Any) => void posted.push(r),
      pollMs: 5,
    };
    const [a, b] = await Promise.all([watchForResult(args), watchForResult(args)]);
    expect([a, b].sort()).toEqual(["already_watching", "posted"]);
    expect(posted).toHaveLength(1);
    expect(queries.every((q) => q.args.workflow_id === "wf_1")).toBe(true); // never a new run
  });

  it("gives up cleanly when the workflow never finishes", async () => {
    const { watchForResult } = await import("../server/nammaops/late-result.mjs");
    const out = await watchForResult({
      voice: { query: async () => ({ status: "running" }) },
      call: { id: "c2", name: "Frank" },
      intent: "demand_forecast",
      workflowId: "wf_2",
      post: () => {
        throw new Error("must not post");
      },
      pollMs: 5,
      maxMs: 30,
    });
    expect(out).toBe("gave_up");
  });
});

describe("understood instruction", () => {
  it("is rebuilt from validated fields only", async () => {
    const { describeInstruction } = await import("../server/nammaops/intent-llm.mjs");
    expect(
      describeInstruction({
        intent: "prepare_bill",
        customer: "Rohan",
        lines: [{ product: "toor dal", quantity: 1, unit: "kg" }, { product: "milk" }],
      }),
    ).toBe("Prepare a bill for Rohan: 1 kg toor dal, milk");
    expect(
      describeInstruction({ intent: "sales_summary", day: "2026-11-02", to: "yesterday" }),
    ).toBe("Sales summary (2026-11-02 to yesterday)");
  });
});
