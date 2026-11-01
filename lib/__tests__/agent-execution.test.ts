import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProfiles } from "../server/agent-profiles.mjs";
import { AgentTasks } from "../server/agent-tasks.mjs";
import { agentRoute, handleAgentApi } from "../server/agent-api.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import {
  createSttProvider,
  fixtureProvider,
  geminiProvider,
  gnaniProvider,
  validAudio,
} from "../server/stt.mjs";
import { Readable } from "node:stream";

// Everything here runs against a stub gateway/runtime. Nothing in this file talks to OpenClaw,
// Gemini or Gnani, so a pass is not evidence of live execution or of speech recognition.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const open: TaskDatabase[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

const manifest = {
  capabilities: ["decompose_task"],
  tools: ["agent.message"],
  permissions: { dataAccess: "none", sensitiveWrites: "denied" },
  limits: { maxRetries: 1, maxRuntimeSeconds: 300, maxToolCalls: 4 },
};

function harness({ status = "connected", provider = "openclaw", select = "assigned" } = {}) {
  const db = new TaskDatabase(":memory:") as Any;
  open.push(db);
  const submitted: Any[] = [];
  const order: string[] = [];
  const owner: Any = {
    gatewayId: "gw",
    gateway: { provider, status },
    db,
    resolve: (seatId: string, key?: string) => {
      if (seatId === "no-binding")
        throw new Error("This seat has no available backend agent binding.");
      return {
        seat: { seatId, binding: { revision: 7 } },
        agentId: "backend",
        sessionKey: key ?? "agent:backend:main",
      };
    },
    submit: vi.fn((input: Any) => {
      // Mirrors TaskRuntime.submit: the durable row exists before any gateway call.
      db.insertTask({
        taskId: input.taskId,
        gatewayId: "gw",
        agentId: "backend",
        sessionKey: input.sessionKey,
        bindingRevision: input.bindingRevision,
        seatId: input.seatId,
        message: input.message,
        status: "queued",
        createdAt: "2026-10-31T00:00:00.000Z",
      });
      order.push("task-row");
      submitted.push(input);
    }),
    cancel: vi.fn(async (id: string) => db.updateTask(id, { status: "cancel_requested" })),
  };
  const selectTask = vi.fn(() =>
    select === "assigned"
      ? { status: "assigned", assignment: { seatId: "seat-a" } }
      : { status: "no_eligible_agent", reason: "No reviewed, currently bound specialist." },
  );
  const runtime: Any = {
    db,
    seatOwner: () => owner,
    taskOwner: () => owner,
    estop: { status: () => ({ engaged: false }) },
    operations: {
      registry: {
        entry: (id: string) => (id === "planner" ? { manifest } : undefined),
        grantsFor: (id: string) => (id === "planner" ? [{ seatId: "seat-a" }] : []),
      },
      routing: { selectTask },
    },
  };
  const stt = { current: fixtureProvider("Research three ways to reduce wastage.") as Any };
  runtime.profiles = new AgentProfiles(runtime);
  runtime.agentTasks = new AgentTasks(runtime, {
    profiles: runtime.profiles,
    sttFactory: () => stt.current,
  });
  return { runtime, owner, db, submitted, order, selectTask, stt };
}

const analyst = {
  agent_id: "inventory-analyst-01",
  name: "Inventory Analyst",
  specialization: "Inventory analysis",
  instructions: "Analyze inventory questions and report evidence clearly.",
  runtime: "openclaw",
  seat_id: "seat-a",
  workspace: "agents/inventory-analyst-01",
};

describe("agent configuration", () => {
  it("creates, retrieves, lists and updates a profile without touching the seat", () => {
    const { runtime } = harness();
    const created = runtime.profiles.create(analyst);
    expect(created).toMatchObject({ agent_id: analyst.agent_id, version: 1, capabilities: [] });
    expect(runtime.profiles.get(analyst.agent_id).name).toBe("Inventory Analyst");
    expect(runtime.profiles.list()).toHaveLength(1);
    const updated = runtime.profiles.update(analyst.agent_id, {
      specialization: "Waste reduction",
    });
    expect(updated).toMatchObject({ specialization: "Waste reduction", version: 2 });
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("supports a second specialization by configuration only", () => {
    const { runtime } = harness();
    runtime.profiles.create(analyst);
    const second = runtime.profiles.create({
      ...analyst,
      agent_id: "procurement-analyst-01",
      name: "Procurement Analyst",
      specialization: "Supplier comparison",
      instructions: "Compare supplier quotes and state assumptions.",
      seat_id: "seat-b",
    });
    expect(second.specialization).toBe("Supplier comparison");
    expect(runtime.profiles.list().map((item: Any) => item.agent_id)).toEqual([
      "inventory-analyst-01",
      "procurement-analyst-01",
    ]);
  });

  it("rejects invalid identity, unknown fields, secrets and immutable changes", () => {
    const { runtime } = harness();
    expect(() => runtime.profiles.create({ ...analyst, agent_id: "bad id!" })).toThrow(/agent_id/);
    expect(() => runtime.profiles.create({ ...analyst, token: "secret" })).toThrow(/Unsupported/);
    expect(() => runtime.profiles.create({ ...analyst, workspace: "../escape" })).toThrow(
      /workspace/,
    );
    runtime.profiles.create(analyst);
    expect(() => runtime.profiles.create(analyst)).toThrow(/already exists/);
    for (const patch of [{ seat_id: "x" }, { runtime: "nightshift" }, { agent_id: "other" }])
      expect(() => runtime.profiles.update(analyst.agent_id, patch)).toThrow();
    expect(() => runtime.profiles.update("missing", { name: "x" })).toThrow(/not found/);
  });

  it("rejects a missing runtime binding and a runtime mismatch", () => {
    const { runtime } = harness();
    expect(() => runtime.profiles.create({ ...analyst, seat_id: "no-binding" })).toThrow(
      /binding unavailable/,
    );
    const other = harness({ provider: "nightshift" });
    expect(() => other.runtime.profiles.create(analyst)).toThrow(/runs on nightshift/);
  });

  it("keeps permissions to reviewed grants and separates them from capabilities", () => {
    const { runtime } = harness();
    expect(() => runtime.profiles.create({ ...analyst, permissions: ["unknown"] })).toThrow(
      /Unknown reviewed manifest/,
    );
    expect(() => runtime.profiles.create({ ...analyst, capabilities: ["decompose_task"] })).toThrow(
      /not authorised/,
    );
    expect(() =>
      runtime.profiles.create({
        ...analyst,
        permissions: ["planner"],
        capabilities: ["send_money"],
      }),
    ).toThrow(/not authorised/);
    const ok = runtime.profiles.create({
      ...analyst,
      permissions: ["planner"],
      capabilities: ["decompose_task"],
    });
    expect(ok.permissions).toEqual(["planner"]);
  });
});

describe("text task execution", () => {
  const request = {
    agent_id: analyst.agent_id,
    input: { type: "text", text: "Research three ways to reduce inventory wastage." },
    session_id: "demo-session-01",
  };

  it("persists the task and input record before returning, with instructions as context only", async () => {
    const { runtime, owner, submitted, db, order } = harness();
    runtime.profiles.create(analyst);
    const task = await runtime.agentTasks.submitText(request);
    expect(order).toEqual(["task-row"]);
    expect(db.getTask(task.task_id)).toMatchObject({ status: "queued", seatId: "seat-a" });
    expect(task).toMatchObject({
      agent_id: analyst.agent_id,
      status: "queued",
      session_id: "demo-session-01",
      provider: "openclaw",
      input: { type: "text" },
      correlation: { binding_revision: 7, backend_agent_id: "backend" },
    });
    expect(submitted[0].message).toBe(request.input.text);
    expect(submitted[0].context).toContain("Instructions:");
    expect(submitted[0].bindingRevision).toBe(7);
    expect(owner.submit).toHaveBeenCalledTimes(1);
  });

  it("validates the request and the agent", async () => {
    const { runtime } = harness();
    runtime.profiles.create(analyst);
    const { agentTasks } = runtime;
    await expect(agentTasks.submitText({ ...request, agent_id: "" })).rejects.toThrow(/agent_id/);
    await expect(agentTasks.submitText({ ...request, input: { type: "voice" } })).rejects.toThrow(
      /input must be/,
    );
    await expect(agentTasks.submitText({ ...request, session_id: "bad id" })).rejects.toThrow(
      /session_id/,
    );
    await expect(agentTasks.submitText({ ...request, agent_id: "nope" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("reports a gateway failure as unavailable without creating a task", async () => {
    const { runtime, owner, db } = harness({ status: "disconnected" });
    runtime.profiles.create({ ...analyst });
    await expect(runtime.agentTasks.submitText(request)).rejects.toMatchObject({
      status: 503,
      body: { status: "unavailable" },
    });
    expect(owner.submit).not.toHaveBeenCalled();
    expect(db.listTasks()).toHaveLength(0);
  });

  it("blocks when the binding disappears after configuration", async () => {
    const { runtime, owner } = harness();
    runtime.profiles.create(analyst);
    owner.resolve = () => {
      throw new Error("This seat has no available backend agent binding.");
    };
    await expect(runtime.agentTasks.submitText(request)).rejects.toMatchObject({
      status: 409,
      body: { status: "blocked" },
    });
  });

  it("blocks on a tool authorization failure and never escalates", async () => {
    const { runtime, owner, selectTask } = harness({ select: "none" });
    runtime.profiles.create({ ...analyst, permissions: ["planner"] });
    await expect(runtime.agentTasks.submitText(request)).rejects.toMatchObject({
      status: 409,
      body: { status: "blocked" },
    });
    expect(selectTask).toHaveBeenCalledWith(
      expect.objectContaining({
        preflight: true,
        pinned: expect.objectContaining({ seatId: "seat-a" }),
      }),
    );
    expect(owner.submit).not.toHaveBeenCalled();
  });

  it("routes a permitted task through the router preflight first", async () => {
    const { runtime, owner, selectTask } = harness();
    runtime.profiles.create({ ...analyst, permissions: ["planner"] });
    await runtime.agentTasks.submitText(request);
    expect(selectTask).toHaveBeenCalledTimes(1);
    expect(owner.submit).toHaveBeenCalledTimes(1);
  });

  it("blocks while the emergency stop is engaged", async () => {
    const { runtime } = harness();
    runtime.profiles.create(analyst);
    runtime.estop = { status: () => ({ engaged: true }) };
    await expect(runtime.agentTasks.submitText(request)).rejects.toMatchObject({ status: 409 });
  });

  it("keeps the runtime's real status and exposes persisted events and tool events", async () => {
    const { runtime, owner, db } = harness();
    runtime.profiles.create(analyst);
    const { task_id: id } = await runtime.agentTasks.submitText(request);
    db.updateTask(id, { status: "outcome_unknown", error: "Outcome unknown." });
    expect(runtime.agentTasks.view(id)).toMatchObject({
      status: "outcome_unknown",
      error: "Outcome unknown.",
      completed_at: null,
    });
    db.saveMessage({
      id: `tool_${id}_1`,
      taskId: id,
      sessionKey: "agent:backend:main",
      role: "tool",
      toolName: "test_fixture_echo",
      toolInput: "{}",
      toolOutput: "ok",
      timestamp: "2026-10-31T00:00:01.000Z",
    });
    db.updateTask(id, {
      status: "completed",
      result: "Report",
      completedAt: "2026-10-31T00:01:00Z",
    });
    const events = runtime.agentTasks.events(id);
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.tool_events).toEqual([expect.objectContaining({ tool: "test_fixture_echo" })]);
    expect(runtime.agentTasks.view(id)).toMatchObject({ status: "completed", result: "Report" });
    expect(owner.submit).toHaveBeenCalledTimes(1);
  });

  it("cancels through the owning runtime and returns 404 for unknown tasks", async () => {
    const { runtime, owner } = harness();
    runtime.profiles.create(analyst);
    const { task_id: id } = await runtime.agentTasks.submitText(request);
    expect((await runtime.agentTasks.cancel(id)).status).toBe("cancel_requested");
    expect(owner.cancel).toHaveBeenCalledWith(id, {});
    await expect(runtime.agentTasks.cancel("missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("speech-to-text providers", () => {
  const wav = Buffer.from("RIFF....WAVE");

  it("validates size, type, emptiness and language", () => {
    expect(validAudio({ bytes: wav, mime: "audio/wav; codecs=1", language: "hi-IN" }).type).toBe(
      "audio/wav",
    );
    expect(() => validAudio({ bytes: wav, mime: "text/plain" })).toThrow(/Unsupported/);
    expect(() => validAudio({ bytes: Buffer.alloc(0), mime: "audio/wav" })).toThrow(/empty/);
    expect(() =>
      validAudio({ bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mime: "audio/wav" }),
    ).toThrow(/exceeds/);
    expect(() => validAudio({ bytes: wav, mime: "audio/wav", language: "not a lang" })).toThrow(
      /language/,
    );
  });

  it("calls Gnani with only the documented fields and the key only in a header", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: Any) => {
      const form = init.body as FormData;
      expect([...form.keys()].sort()).toEqual(
        ["audio_file", "format", "language_code", "preferred_language"].sort(),
      );
      expect(form.has("model")).toBe(false);
      expect(init.headers).toEqual({ "X-API-Key-ID": "k-123" });
      return new Response(
        JSON.stringify({ success: true, request_id: "r1", transcript: " नमस्ते " }),
      );
    });
    const result = await gnaniProvider({ apiKey: "k-123", fetchImpl }).transcribe({
      bytes: wav,
      mime: "audio/wav",
      language: "hi-IN",
    });
    expect(result).toEqual({ transcript: "नमस्ते", provider: "gnani-prisma", requestId: "r1" });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.vachana.ai/stt/v3");
  });

  it("maps Gnani failures to truthful errors", async () => {
    const reject = (response: () => Promise<Response>) =>
      gnaniProvider({ apiKey: "k", fetchImpl: response as Any }).transcribe({
        bytes: wav,
        mime: "audio/wav",
      });
    await expect(reject(async () => new Response("{}", { status: 401 }))).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      reject(async () => new Response(JSON.stringify({ success: true, transcript: "" }))),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      reject(async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      }),
    ).rejects.toMatchObject({ status: 504 });
    expect(() => gnaniProvider({})).toThrow(/GNANI_API_KEY/);
  });

  it("transcribes with Gemini through an injected client", async () => {
    const generateContent = vi.fn(async () => ({ text: "hello world" }));
    const result = await geminiProvider({ client: { models: { generateContent } } }).transcribe({
      bytes: wav,
      mime: "audio/wav",
    });
    expect(result).toEqual({ transcript: "hello world", provider: "gemini" });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("selects providers from the environment and never defaults", () => {
    expect(createSttProvider({})).toBeNull();
    expect(createSttProvider({ AGENT_TOWN_STT_PROVIDER: "fixture" })?.verifiesRecognition).toBe(
      false,
    );
    expect(() => createSttProvider({ AGENT_TOWN_STT_PROVIDER: "gnani" })).toThrow(/GNANI_API_KEY/);
    expect(() => createSttProvider({ AGENT_TOWN_STT_PROVIDER: "x" })).toThrow(/Unknown/);
  });
});

describe("voice task execution", () => {
  const wav = Buffer.from("RIFF....WAVE");

  it("sends the transcript through the same pipeline and stores the metadata", async () => {
    const { runtime, submitted, db } = harness();
    runtime.profiles.create(analyst);
    const task = await runtime.agentTasks.submitVoice({
      agentId: analyst.agent_id,
      sessionId: "demo-session-01",
      language: "en-IN",
      bytes: wav,
      mime: "audio/wav",
    });
    expect(submitted[0].message).toBe("Research three ways to reduce wastage.");
    expect(task.input).toMatchObject({
      type: "voice",
      transcript: "Research three ways to reduce wastage.",
      stt_provider: "fixture",
      language: "en-IN",
    });
    const record = db.record("agent.task-input", task.task_id);
    expect(record).toMatchObject({ audio_bytes: wav.length, stt_verifies_recognition: false });
    expect(JSON.stringify(record)).not.toContain("RIFF");
  });

  it("returns unavailable when no STT provider is configured and never fabricates a transcript", async () => {
    const { runtime, owner, stt } = harness();
    runtime.profiles.create(analyst);
    stt.current = null;
    await expect(
      runtime.agentTasks.submitVoice({
        agentId: analyst.agent_id,
        bytes: wav,
        mime: "audio/wav",
      }),
    ).rejects.toMatchObject({ status: 503, body: { status: "unavailable" } });
    expect(owner.submit).not.toHaveBeenCalled();
  });

  it("rejects invalid audio before transcription", async () => {
    const { runtime } = harness();
    runtime.profiles.create(analyst);
    await expect(
      runtime.agentTasks.submitVoice({ agentId: analyst.agent_id, bytes: wav, mime: "video/mp4" }),
    ).rejects.toMatchObject({ status: 415 });
  });
});

describe("REST routing", () => {
  const call = (runtime: Any, method: string, path: string, body?: Buffer, type?: string) => {
    const req: Any = Readable.from(body ? [body] : []);
    req.method = method;
    req.headers = { "content-type": type ?? "application/json", "content-length": body?.length };
    return handleAgentApi(runtime, req, agentRoute(path) as Any);
  };

  it("maps both prefixes to one implementation and leaves existing routes alone", () => {
    expect(agentRoute("/api/agents")).toEqual({ area: "agents", rest: "" });
    expect(agentRoute("/api/runtime/agents/x")).toEqual({ area: "agents", rest: "/x" });
    expect(agentRoute("/api/tasks/t1/events")).toEqual({ area: "tasks", rest: "/t1/events" });
    expect(agentRoute("/api/runtime/agent-tasks/voice")).toEqual({ area: "tasks", rest: "/voice" });
    expect(agentRoute("/api/agents/discover")).toBeNull();
    expect(agentRoute("/api/runtime/tasks")).toBeNull();
    expect(agentRoute("/api/runtime/tasks/abc/cancel")).toBeNull();
  });

  it("serves create, get, submit, status and events over REST handlers", async () => {
    const { runtime } = harness();
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect((await call(runtime, "POST", "/api/agents", json(analyst))).status).toBe(201);
    expect((await call(runtime, "GET", `/api/agents/${analyst.agent_id}`)).status).toBe(200);
    const submitted: Any = await call(
      runtime,
      "POST",
      "/api/tasks",
      json({ agent_id: analyst.agent_id, input: { type: "text", text: "Hello" } }),
    );
    expect(submitted.status).toBe(202);
    const id = submitted.body.task.task_id;
    expect((await call(runtime, "GET", `/api/tasks/${id}`)).status).toBe(200);
    expect((await call(runtime, "GET", `/api/tasks/${id}/events`)).status).toBe(200);
    await expect(call(runtime, "GET", "/api/tasks/missing")).rejects.toMatchObject({ status: 404 });
  });

  it("accepts a multipart voice upload and rejects non-multipart or missing audio", async () => {
    const { runtime } = harness();
    runtime.profiles.create(analyst);
    const form = new FormData();
    form.set("agent_id", analyst.agent_id);
    form.set("session_id", "demo-session-01");
    form.set("audio", new Blob([Buffer.from("RIFF....WAVE")], { type: "audio/wav" }), "a.wav");
    const request = new Request("http://localhost/", { method: "POST", body: form });
    const body = Buffer.from(await request.arrayBuffer());
    const type = request.headers.get("content-type") as string;
    const ok: Any = await call(runtime, "POST", "/api/tasks/voice", body, type);
    expect(ok.status).toBe(202);
    expect(ok.body.task.input.type).toBe("voice");
    await expect(
      call(runtime, "POST", "/api/tasks/voice", json0(), "application/json"),
    ).rejects.toMatchObject({
      status: 415,
    });
    const empty = new FormData();
    empty.set("agent_id", analyst.agent_id);
    const emptyReq = new Request("http://localhost/", { method: "POST", body: empty });
    await expect(
      call(
        runtime,
        "POST",
        "/api/tasks/voice",
        Buffer.from(await emptyReq.arrayBuffer()),
        emptyReq.headers.get("content-type") as string,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

const json0 = () => Buffer.from("{}");
