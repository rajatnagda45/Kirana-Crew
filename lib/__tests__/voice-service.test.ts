import { describe, expect, it } from "vitest";
import { VoiceService, sanitizeTurns } from "../server/voice.mjs";
import { TaskDatabase } from "../server/task-db.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("client-relayed turn timings", () => {
  it("keeps only known fields as bounded integers, at most 20 turns", () => {
    const turns = sanitizeTurns([
      {
        speech_to_tool_ms: 900,
        tool_ms: 7600,
        speech_to_text_ms: 9100,
        speech_to_audio_ms: 9700,
        transcript: "owner said something private",
      },
      { speech_to_tool_ms: -5, tool_ms: 1.5, speech_to_text_ms: "fast", speech_to_audio_ms: 9e9 },
      null,
      ...Array.from({ length: 30 }, () => ({ tool_ms: 1 })),
    ]);
    expect(turns).toHaveLength(20);
    const all = sanitizeTurns([
      { speech_to_tool_ms: 900, tool_ms: 7600, speech_to_text_ms: 9100, speech_to_audio_ms: 9700, transcript: "x" },
      { speech_to_tool_ms: -5, tool_ms: 1.5, speech_to_text_ms: "fast", speech_to_audio_ms: 9e9 },
    ]);
    expect(all[0]).toEqual({
      speech_to_tool_ms: 900,
      tool_ms: 7600,
      speech_to_text_ms: 9100,
      speech_to_audio_ms: 9700,
    });
    expect(all[1]).toEqual({
      speech_to_tool_ms: null,
      tool_ms: null,
      speech_to_text_ms: null,
      speech_to_audio_ms: null,
    });
  });
});

const selection = { seatId: "alice", bindingRevision: 1, sessionKey: "agent:main:main" };
const identity = {
  seatId: "alice",
  agentId: "main",
  bindingRevision: 1,
  gatewayId: "gateway-1",
  sessionKey: selection.sessionKey,
};
function setup() {
  const messages = new Map<string, Record<string, unknown>>();
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    ...identity,
    taskId: `task-${index}`,
    message: `Request ${index}`,
    status: "completed",
    createdAt: `2026-10-25T00:00:0${8 - index}Z`,
    result: `Result ${index}` as string | undefined,
    error: undefined as string | undefined,
  }));
  const service = new VoiceService({
    gatewayId: identity.gatewayId,
    resolve: () => ({
      seat: { seatId: "alice", label: "Alice", binding: { revision: 1 } },
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
    }),
    roleLocks: new Set(),
    management: { busyAgent: () => false, busySession: () => false },
    gateway: { status: "connected", capabilities: () => ({ "chat.send": { available: true } }) },
    reviews: { blocksLane: () => false },
    db: {
      tasksForSession: () => tasks,
      messages: () => [...messages.values()],
      record: () => ({ id: "call-1", ...identity, name: "Alice" }),
      getMessage: (id: string) => messages.get(id),
      saveMessage: (message: Record<string, unknown>) =>
        messages.set(message.id as string, message),
    },
  });
  return { service, tasks, messages };
}

describe("authoritative call continuity", () => {
  it("refreshes older requested outcomes and active work without exposing foreign tasks", () => {
    const { service, tasks } = setup();
    tasks[6].status = "running";
    tasks[6].result = "";
    tasks[7].status = "failed";
    tasks[7].result = undefined;
    tasks[7].error = "Backend confirmed failure";
    tasks.push({ ...tasks[7], taskId: "foreign", seatId: "bob", result: "Bob private result" });
    const context = service.context({ ...selection, taskIds: ["task-7", "foreign"] });
    expect(context.tasks.map((task: { taskId: string }) => task.taskId)).toEqual([
      "task-7",
      "task-6",
      "task-0",
      "task-1",
      "task-2",
      "task-3",
      "task-4",
    ]);
    expect(context.tasks[0]).toMatchObject({
      status: "failed",
      result: "Backend confirmed failure",
      createdAt: tasks[7].createdAt,
    });
    expect(JSON.stringify(context)).not.toContain("Bob private");
    tasks[6].status = "completed";
    tasks[6].result = "New confirmed result";
    expect(service.context({ ...selection, taskIds: ["task-6"] }).tasks[0]).toMatchObject({
      status: "completed",
      result: "New confirmed result",
    });
  });

  it("bounds requested outcome IDs and rejects stale binding revisions", () => {
    const { service } = setup();
    for (const taskIds of ["task-0", Array(21).fill("task-0"), [null], ["x".repeat(101)]])
      expect(() => service.context({ ...selection, taskIds })).toThrow();
    expect(() => service.context({ ...selection, bindingRevision: 2 })).toThrow(/binding changed/);
  });

  it("persists an interrupted assistant fragment and keeps retries immutable", () => {
    const { service } = setup();
    const input = {
      callId: "call-1",
      id: "assistant-fragment",
      role: "assistant",
      content: "The draft should include",
      interrupted: true,
      timestamp: "2026-10-25T00:00:00Z",
    };
    expect(service.finalize(input)).toMatchObject({ interrupted: true, streaming: false });
    expect(service.context(selection).conversation).toEqual([
      { role: "assistant", text: input.content, interrupted: true },
    ]);
    expect(service.finalize(input)).toMatchObject({ interrupted: true });
    expect(() => service.finalize({ ...input, interrupted: undefined })).toThrow(
      /already finalized/,
    );
    expect(() => service.finalize({ ...input, id: "user", role: "user" })).toThrow(/finalized/);
    expect(() => service.finalize({ ...input, id: "bad", interrupted: "yes" })).toThrow(
      /finalized/,
    );
  });
});

describe("abandoned call reaper", () => {
  const NOW = Date.parse("2026-11-08T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  function reaperSetup() {
    const db = new TaskDatabase(":memory:") as Any;
    const service = new VoiceService({ gatewayId: "gw-1", db } as Any) as Any;
    const call = (id: string, extra: Record<string, unknown>) =>
      db.saveRecord("voiceCall", id, {
        gatewayId: "gw-1",
        seatId: "alice",
        name: "Alice",
        status: "provisioned",
        durationMs: 0,
        usageReports: [],
        ...extra,
      });
    return { db, service, call };
  }

  it("closes calls that never reported an end, and only those", () => {
    const { db, service, call } = reaperSetup();
    call("stale-provisioned", { createdAt: ago(11 * 60_000) });
    call("fresh-provisioned", { createdAt: ago(5 * 60_000) });
    call("silent-connected", {
      createdAt: ago(8 * 60_000),
      status: "connected",
      updatedAt: ago(4 * 60_000),
      durationMs: 123_000,
    });
    call("live-connected", {
      createdAt: ago(2 * 60_000),
      status: "connected",
      updatedAt: ago(30_000),
    });
    call("already-ended", {
      createdAt: ago(60 * 60_000),
      status: "ended",
      endedAt: ago(59 * 60_000),
    });
    call("other-gateway", { createdAt: ago(60 * 60_000), gatewayId: "gw-2" });

    expect(service.reap({ now: NOW })).toBe(2);
    const get = (id: string) => db.record("voiceCall", id);
    expect(get("stale-provisioned")).toMatchObject({
      status: "ended",
      diagnostic: { code: "abandoned", phase: "connection" },
    });
    expect(get("stale-provisioned").endedAt).toBeTruthy();
    expect(get("silent-connected")).toMatchObject({
      status: "ended",
      durationMs: 123_000, // what the browser reported is kept
      diagnostic: { code: "abandoned", phase: "call" },
    });
    expect(get("fresh-provisioned").status).toBe("provisioned");
    expect(get("live-connected").status).toBe("connected");
    expect(get("already-ended").diagnostic).toBeUndefined();
    expect(get("other-gateway").status).toBe("provisioned");
    expect(service.reap({ now: NOW })).toBe(0); // idempotent
  });

  it("does not let a late heartbeat reopen a reaped call", () => {
    const { db, service, call } = reaperSetup();
    call("late", { createdAt: ago(9 * 60_000), status: "connected", updatedAt: ago(5 * 60_000), sequence: 3 });
    service.reap({ now: NOW });
    const after = service.report({ callId: "late", sequence: 99, status: "connected", durationMs: 5 });
    expect(after.status).toBe("ended");
    expect(db.record("voiceCall", "late").status).toBe("ended");
  });
});
