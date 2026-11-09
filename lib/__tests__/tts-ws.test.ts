import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { clampSpeed, gnaniTtsProvider, validSpeech } from "../server/tts.mjs";

type Script = (socket: FakeSocket, request?: unknown) => void;

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  terminated = false;
  constructor(private script: Script) {
    super();
    queueMicrotask(() => this.emit("open"));
  }
  send(data: string) {
    const request = JSON.parse(data);
    this.sent.push(request);
    queueMicrotask(() => this.script(this, request));
  }
  json(message: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.terminated = true;
    this.close();
  }
}

const audio = (bytes: number[]) => ({
  type: "audio",
  data: { chunk_index: 1, audio: Buffer.from(bytes).toString("base64"), is_final: false },
});
const happy: Script = (socket) => {
  socket.json({ type: "start", request_id: "r" });
  socket.json(audio([1, 2]));
  socket.json(audio([3, 4]));
  socket.json({ type: "complete", data: { chunk_index: 3, audio: "", is_final: true } });
};

function provider(script: Script) {
  const sockets: FakeSocket[] = [];
  const headers: unknown[] = [];
  const p = gnaniTtsProvider({
    apiKey: "key",
    transport: "ws",
    wsOpen: (_url: string, h: unknown) => {
      headers.push(h);
      const socket = new FakeSocket(script);
      sockets.push(socket);
      return socket;
    },
  });
  return { p, sockets, headers };
}

const collect = async (gen: AsyncGenerator<Buffer>) => {
  const out: number[] = [];
  for await (const chunk of gen) out.push(...chunk);
  return out;
};

describe("gnani realtime websocket", () => {
  it("streams audio chunks, sends the key header and the documented payload", async () => {
    const { p, sockets, headers } = provider(happy);
    const bytes = await collect(p.stream({ text: "hi", voice: "Shivani", speed: "fast" }));
    expect(bytes).toEqual([1, 2, 3, 4]);
    expect(headers[0]).toEqual({ "X-API-Key-ID": "key" });
    expect(sockets[0].sent[0]).toMatchObject({
      text: "hi",
      voice: "Shivani",
      model: "timbre-v3.0",
      speed: 1.15,
      audio_config: { sample_rate: 24000, container: "raw", encoding: "linear_pcm" },
    });
  });

  it("reuses the warm socket for the next sentence", async () => {
    const { p, sockets } = provider(happy);
    await collect(p.stream({ text: "one" }));
    await collect(p.stream({ text: "two" }));
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(2);
  });

  it("surfaces an error message and drops the socket", async () => {
    const { p, sockets } = provider((s) => s.json({ type: "error", message: "bad voice" }));
    await expect(collect(p.stream({ text: "x" }))).rejects.toThrow("bad voice");
    expect(sockets[0].terminated).toBe(true);
  });

  it("retries once on a fresh socket when it closes before any audio", async () => {
    let calls = 0;
    const { p, sockets } = provider((s) => {
      calls += 1;
      if (calls === 1) s.close();
      else happy(s, null);
    });
    expect(await collect(p.stream({ text: "x" }))).toEqual([1, 2, 3, 4]);
    expect(sockets).toHaveLength(2);
  });

  it("closes the socket when the caller aborts", async () => {
    const controller = new AbortController();
    const { p, sockets } = provider((s) => {
      s.json(audio([9]));
    });
    const out: number[] = [];
    for await (const chunk of p.stream({ text: "x", signal: controller.signal })) {
      out.push(...chunk);
      controller.abort();
    }
    expect(out).toEqual([9]);
    expect(sockets[0].terminated).toBe(true);
  });
});

describe("speed and language", () => {
  it("clamps speed to 0.85-1.15 and maps the word shortcuts", () => {
    expect(clampSpeed(2)).toBe(1.15);
    expect(clampSpeed(0.1)).toBe(0.85);
    expect(clampSpeed("slow")).toBe(0.85);
    expect(clampSpeed("medium")).toBe(1);
    expect(clampSpeed("nope")).toBeUndefined();
    expect(clampSpeed(undefined)).toBeUndefined();
  });

  it("accepts auto and hi-en", () => {
    expect(validSpeech({ text: "a", language: "auto" }).language).toBe("auto");
    expect(validSpeech({ text: "a", language: "hi-en" }).language).toBe("hi-en");
  });
});
