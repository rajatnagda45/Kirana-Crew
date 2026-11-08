import { describe, expect, it } from "vitest";
import { VoiceService, sanitizeTurns } from "../server/voice.mjs";

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
