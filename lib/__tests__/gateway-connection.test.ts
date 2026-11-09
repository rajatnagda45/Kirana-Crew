import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ServerGateway } from "../server/gateway-connection.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// A real loopback WebSocket server stands in for the OpenClaw gateway. No real gateway is used.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const audit = {
  protocol: 3,
  validators: new Set(),
  validate: () => true,
  capabilities: () => ({}),
};

/** `onConnect(socket, requestId, attempt)` decides how each handshake attempt goes. */
async function gatewayServer(onConnect: (socket: Any, id: string, attempt: number) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  let attempt = 0;
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.method === "connect") onConnect(socket, frame.id, attempt++);
    });
  });
  cleanup.push(() => new Promise((done) => wss.close(() => done(undefined))));
  return { url: `ws://127.0.0.1:${(wss.address() as Any).port}/`, attempts: () => attempt };
}
const helloOk = (socket: Any, id: string) =>
  socket.send(JSON.stringify({ type: "res", id, ok: true, payload: { type: "hello-ok" } }));

const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function gateway(url: string, extra: Record<string, unknown> = {}) {
  const client = new ServerGateway({
    url,
    token: "t",
    audit,
    origin: "http://127.0.0.1",
    retryBaseMs: 30,
    retryMaxMs: 120,
    ...extra,
  }) as Any;
  cleanup.push(() => {
    client.stopped = true;
    client.ws?.terminate();
    clearTimeout(client.timer);
  });
  return client;
}

describe("ServerGateway recovery", () => {
  it("recovers by itself when the gateway cuts the first handshake (restarting or busy)", async () => {
    // Attempt 0: the gateway drops the connection mid-handshake. Attempt 1: it answers normally.
    const server = await gatewayServer((socket, id, attempt) =>
      attempt === 0 ? socket.terminate() : helloOk(socket, id),
    );
    const client = gateway(server.url);
    const seen: string[] = [];
    client.subscribe((kind: string, status: string) => kind === "status" && seen.push(status));
    client.start();
    await until(() => client.status === "connected");
    expect(server.attempts()).toBe(2);
    expect(seen).toContain("auth_failed"); // reported while it was failing...
    expect(client.connectionFailure).toBeNull(); // ...and cleared once connected
    expect(client.attempts).toBe(0);
  });

  it("keeps a rejected credential final: no retry loop against the gateway", async () => {
    const server = await gatewayServer((socket, id) =>
      socket.send(JSON.stringify({ type: "res", id, ok: false, error: { message: "bad token" } })),
    );
    const client = gateway(server.url);
    client.start();
    await until(() => client.status === "auth_failed");
    await new Promise((resolve) => setTimeout(resolve, 400)); // several retry periods
    expect(client.connectionFailure).toBe("unauthorized");
    expect(server.attempts()).toBe(1);
    expect(client.status).toBe("auth_failed");
  });

  it("backs off between retries instead of reconnecting at a fixed pace", async () => {
    const stamps: number[] = [];
    const server = await gatewayServer((socket) => {
      stamps.push(Date.now());
      socket.terminate();
    });
    const client = gateway(server.url, { retryBaseMs: 40, retryMaxMs: 1000 });
    client.start();
    await until(() => stamps.length >= 4, 6000);
    const gaps = stamps.slice(1).map((stamp, i) => stamp - stamps[i]);
    // 40 ms, then about 80 ms, then about 160 ms (+/- jitter): each wait is longer than the first.
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[0] * 1.5);
  });
});
