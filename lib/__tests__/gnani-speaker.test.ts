import { afterEach, describe, expect, it, vi } from "vitest";
import { GnaniSpeaker } from "../voice/gnaniSpeaker";
import { gnaniTtsProvider, takeSseEvents } from "../server/tts.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function fakeContext() {
  const started: Array<{ at: number; duration: number }> = [];
  const context = {
    currentTime: 0,
    destination: {},
    createBuffer: (_c: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel() {},
    }),
    createBufferSource: () => {
      const source: Any = {
        connect() {},
        disconnect() {},
        stop() {},
        start(at: number) {
          started.push({ at, duration: source.buffer.duration });
        },
      };
      return source;
    },
  } as unknown as AudioContext;
  return { started, context };
}

const requests: Any[] = [];
function pcm(samples: number) {
  return new Uint8Array(samples * 2).fill(1);
}
function mockStream(chunksPerSentence: Uint8Array[][] | "fail") {
  vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: Any) => {
      requests.push(JSON.parse(init.body));
      if (chunksPerSentence === "fail")
        return { ok: false, status: 502, json: async () => ({ error: "Gnani down" }) };
      const parts = chunksPerSentence[call++] ?? [];
      let i = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "24000" },
        body: {
          getReader: () => ({
            read: async () =>
              i < parts.length ? { value: parts[i++], done: false } : { done: true },
            cancel: async () => {},
          }),
        },
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  requests.length = 0;
});

describe("Gnani voice for Gemini Live replies", () => {
  it("speaks the first sentence at once, batches the rest into one request, in the agent voice, with chunks back to back", async () => {
    mockStream([[pcm(2400), pcm(2400)], [pcm(4800)], [pcm(2400)]]);
    const { context, started } = fakeContext();
    const speaker = new GnaniSpeaker(context, "Kalpana");
    speaker.feed("Udhaar pending is 49,509 rupees. 9 customers ");
    speaker.feed("Udhaar pending is 49,509 rupees. 9 customers are overdue. Collect first");
    speaker.feed("Udhaar pending is 49,509 rupees. 9 customers are overdue. Collect first", true);
    await vi.waitFor(() => expect(started.length).toBe(3));
    // The first sentence goes out alone at once; what arrives meanwhile goes out as one request.
    expect(requests.map((b) => b.text)).toEqual([
      "Udhaar pending is 49,509 rupees.",
      "9 customers are overdue. Collect first",
    ]);
    expect(requests.every((b) => b.voice === "Kalpana")).toBe(true);
    // Each chunk starts exactly where the previous one ends: no gaps, no overlap.
    for (let i = 1; i < started.length; i++)
      expect(started[i].at).toBeCloseTo(started[i - 1].at + started[i - 1].duration, 6);
  });

  it("speaks a sentence that ends the text so far without waiting for the reply to finish", async () => {
    mockStream([[pcm(2400)], [pcm(2400)]]);
    const { context, started } = fakeContext();
    const speaker = new GnaniSpeaker(context, null);
    speaker.feed("Stock is low.");
    await vi.waitFor(() => expect(requests.map((b) => b.text)).toEqual(["Stock is low."]));
    speaker.feed("Stock is low. Order more rice.");
    await vi.waitFor(() => expect(started.length).toBe(2));
    expect(requests.map((b) => b.text)).toEqual(["Stock is low.", "Order more rice."]);
  });

  it("waits briefly after a digit and a full stop in case it is a decimal point", async () => {
    vi.useFakeTimers();
    try {
      mockStream([[pcm(2400)]]);
      const { context } = fakeContext();
      const speaker = new GnaniSpeaker(context, null);
      speaker.feed("Margin is 49.");
      expect(requests).toHaveLength(0);
      speaker.feed("Margin is 49.5 percent.");
      vi.advanceTimersByTime(300);
      expect(requests.map((b) => b.text)).toEqual(["Margin is 49.5 percent."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks a number ending in a full stop once nothing more arrives", async () => {
    vi.useFakeTimers();
    try {
      mockStream([[pcm(2400)]]);
      const { context } = fakeContext();
      const speaker = new GnaniSpeaker(context, null);
      speaker.feed("Total is 49.");
      vi.advanceTimersByTime(300);
      expect(requests.map((b) => b.text)).toEqual(["Total is 49."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a sample that straddles two network chunks", async () => {
    mockStream([[new Uint8Array([1, 0, 2]), new Uint8Array([0, 3, 0])]]);
    const { context, started } = fakeContext();
    new GnaniSpeaker(context, null).feed("Hello there.", true);
    await vi.waitFor(() => expect(started.length).toBe(2));
    expect(started.reduce((n, s) => n + s.duration * 24000, 0)).toBeCloseTo(3, 3);
  });

  it("reports a failure without playing anything, and stop clears the queue", async () => {
    mockStream("fail");
    const { context, started } = fakeContext();
    const onFailure = vi.fn();
    const speaker = new GnaniSpeaker(context, "Harshad", "en-IN", onFailure);
    speaker.feed("Hello there. ", true);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith("Gnani down"));
    expect(speaker.failed).toBe(true);
    expect(started.length).toBe(0);
    speaker.stop();
    expect(speaker.speaking).toBe(false);
  });

  it("ignores text with nothing to say", () => {
    mockStream([]);
    const { context } = fakeContext();
    new GnaniSpeaker(context, null).feed("... !!! ", true);
    expect(requests).toHaveLength(0);
  });
});

describe("Gnani streaming provider", () => {
  it("parses server-sent events split across network chunks", () => {
    const first = takeSseEvents(
      'event: start\ndata: {"status":"streaming_started"}\n\nevent: chunk\ndata: {"chun',
    );
    expect(first.events).toEqual([{ event: "start", data: '{"status":"streaming_started"}' }]);
    const second = takeSseEvents(
      `${first.rest}k_index":1,"audio":"AAA="}\r\n\r\nevent: complete\r\ndata: {}\r\n\r\n`,
    );
    expect(second.events.map((e) => e.event)).toEqual(["chunk", "complete"]);
    expect(second.rest).toBe("");
  });

  it("yields PCM chunks in order, asks for raw 24 kHz mono, and fails when Gnani sends an error", async () => {
    const sse = (parts: string[]) => ({
      ok: true,
      status: 200,
      body: (async function* () {
        for (const p of parts) yield Buffer.from(p);
      })(),
    });
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    let body: Any;
    const fetchImpl = vi.fn(async (_url: string, init: Any) => {
      body = JSON.parse(init.body);
      return sse([
        'event: start\ndata: {"status":"streaming_started"}\n\n',
        `event: chunk\ndata: {"chunk_index":1,"audio":"${b64("ab")}","is_final":false}\n\nevent: chu`,
        `nk\ndata: {"chunk_index":2,"audio":"${b64("cd")}","is_final":false}\n\n`,
        'event: complete\ndata: {"chunk_index":3,"audio":"","is_final":true}\n\n',
      ]);
    });
    const tts = gnaniTtsProvider({ apiKey: "k", fetchImpl });
    const out: string[] = [];
    for await (const chunk of tts.stream({ text: "Hi", voice: "Kalpana", language: "en-IN" }))
      out.push(chunk.toString());
    expect(out).toEqual(["ab", "cd"]);
    expect(body).toMatchObject({
      voice: "Kalpana",
      language: "en-IN",
      audio_config: { sample_rate: 24000, encoding: "linear_pcm", container: "raw" },
    });

    const failing = gnaniTtsProvider({
      apiKey: "k",
      fetchImpl: async () => sse(['event: error\ndata: {"type":"x","message":"bad voice"}\n\n']),
    });
    await expect(
      (async () => {
        for await (const _ of failing.stream({ text: "Hi" })) void _;
      })(),
    ).rejects.toThrow("bad voice");
  });
});
