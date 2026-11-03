import { randomBytes } from "node:crypto";
import { MAX_INSTRUCTIONS } from "./agent-profiles.mjs";
import { validAudio } from "./stt.mjs";
import { permissionDecision } from "./developer-config.mjs";

export const INPUT_NAMESPACE = "agent.task-input";
const MAX_TEXT = 30000;
const SESSION = /^[a-zA-Z0-9_-]{1,64}$/;

/** A refusal that is a truthful state, not a server fault. */
const refuse = (status, state, message) =>
  Object.assign(new Error(message), { status, state, body: { status: state, error: message } });
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * One execution path for text and transcribed voice. It resolves a configured agent, proves the
 * runtime binding and reviewed permissions, then hands the task to the existing seat runtime
 * (`TaskRuntime.submit`), which persists the task before the gateway is called. It never retries
 * and never reports a task as completed on delivery alone.
 */
export class AgentTasks {
  /** @param {any} runtime @param {{profiles: any, sttFactory?: () => any}} options */
  constructor(runtime, { profiles, sttFactory = () => null }) {
    this.runtime = runtime;
    this.profiles = profiles;
    this.sttFactory = sttFactory;
  }

  /** Reviewed-permission preflight through the existing router; per-task authorisation stays at dispatch. */
  preflight(profile, owner, resolved) {
    if (!profile.permissions.length) return;
    const operations = this.runtime.operations;
    if (!operations?.registry)
      throw refuse(409, "blocked", "Reviewed specialist permissions are not configured.");
    for (const manifestId of profile.permissions) {
      // A specialization's permission is effective only while its developer approval stands.
      if (profile.specialization_id) {
        const decision = permissionDecision(
          this.runtime.db,
          profile.specialization_id,
          manifestId,
        )?.decision;
        if (decision !== "approved")
          throw refuse(
            409,
            "blocked",
            `Permission ${manifestId} is not approved (${decision ?? "pending"}).`,
          );
      }
      const { manifest } = operations.registry.entry(manifestId) ?? {};
      if (!manifest) throw refuse(409, "blocked", `Reviewed manifest ${manifestId} is gone.`);
      const selection = operations.routing.selectTask({
        role: null,
        requirements: {
          capabilities: manifest.capabilities,
          tools: manifest.tools,
          permissions: manifest.permissions,
          maxRetries: manifest.limits.maxRetries,
          maxRuntimeSeconds: manifest.limits.maxRuntimeSeconds,
          maxToolCalls: manifest.limits.maxToolCalls,
        },
        pinned: {
          gatewayId: owner.gatewayId,
          sessionKey: resolved.sessionKey,
          seatId: profile.seat_id,
        },
        preflight: true,
      });
      if (selection.status !== "assigned" || selection.assignment?.seatId !== profile.seat_id)
        throw refuse(
          409,
          "blocked",
          `No eligible execution for permission ${manifestId}: ${selection.reason ?? "seat not selected"}`,
        );
    }
  }

  async submitText(request) {
    const { agent_id: agentId, input, session_id: sessionId } = request ?? {};
    if (typeof agentId !== "string" || !agentId) throw fail(400, "agent_id is required.");
    if (input?.type !== "text" || typeof input.text !== "string" || !input.text.trim())
      throw fail(400, 'input must be {"type":"text","text":"..."}.');
    if (input.text.length > MAX_TEXT) throw fail(413, `Text exceeds ${MAX_TEXT} characters.`);
    if (sessionId !== undefined && !SESSION.test(String(sessionId)))
      throw fail(400, "session_id must match [a-zA-Z0-9_-]{1,64}.");
    return this.run(agentId, { text: input.text, sessionId, meta: { input_type: "text" } });
  }

  async submitVoice({ agentId, sessionId, language, bytes, mime }) {
    if (typeof agentId !== "string" || !agentId) throw fail(400, "agent_id is required.");
    if (sessionId !== undefined && !SESSION.test(String(sessionId)))
      throw fail(400, "session_id must match [a-zA-Z0-9_-]{1,64}.");
    const audio = validAudio({ bytes, mime, language });
    if (!this.profiles.get(agentId)) throw fail(404, "Agent not found.");
    let stt;
    try {
      stt = this.sttFactory();
    } catch (error) {
      throw refuse(503, "unavailable", error.message);
    }
    if (!stt)
      throw refuse(
        503,
        "unavailable",
        "No speech-to-text provider is configured (set AGENT_TOWN_STT_PROVIDER).",
      );
    const result = await stt.transcribe({ bytes, mime: audio.type, language: audio.language });
    return this.run(agentId, {
      text: result.transcript,
      sessionId,
      meta: {
        input_type: "voice",
        transcript: result.transcript,
        stt_provider: result.provider,
        stt_request_id: result.requestId,
        stt_verifies_recognition: stt.verifiesRecognition === true,
        ...(result.fallbackUsed
          ? { stt_fallback_used: true, stt_fallback_from: result.fallbackFrom }
          : {}),
        language: audio.language,
        audio_mime: audio.type,
        audio_bytes: bytes.length,
      },
    });
  }

  async run(agentId, { text, sessionId, meta }) {
    const profile = this.profiles.get(agentId);
    if (!profile) throw fail(404, "Agent not found.");
    if (this.runtime.estop?.status().engaged)
      throw refuse(409, "blocked", "Emergency stop is engaged.");
    const owner = this.runtime.seatOwner(profile.seat_id);
    if (owner.gateway.provider !== profile.runtime)
      throw refuse(409, "blocked", `Seat now runs on ${owner.gateway.provider}.`);
    if (owner.gateway.status !== "connected")
      throw refuse(503, "unavailable", `Runtime ${profile.runtime} is not connected.`);
    let resolved;
    try {
      resolved = owner.resolve(profile.seat_id, profile.session_key);
    } catch (error) {
      throw refuse(409, "blocked", `Runtime binding unavailable: ${error.message}`);
    }
    this.preflight(profile, owner, resolved);

    const taskId = `agt_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
    this.runtime.db.saveRecord(INPUT_NAMESPACE, taskId, {
      agent_id: agentId,
      agent_version: profile.version,
      session_id: sessionId ?? null,
      provider: profile.runtime,
      seat_id: profile.seat_id,
      text,
      ...meta,
    });
    // Instructions are background context only; they carry no permissions and are capped.
    const context =
      `Agent role: ${profile.name} (${profile.specialization}).\n` +
      `Instructions:\n${profile.instructions.slice(0, MAX_INSTRUCTIONS)}`;
    try {
      owner.submit({
        taskId,
        message: text,
        seatId: profile.seat_id,
        sessionKey: resolved.sessionKey,
        bindingRevision: resolved.seat.binding.revision,
        context,
      });
    } catch (error) {
      if (error.status === 409) throw refuse(409, "blocked", error.message);
      throw error;
    }
    return this.view(taskId);
  }

  messagesOf(task) {
    return this.runtime
      .taskOwner(task)
      .db.messages(task.sessionKey)
      .filter(
        (message) => message.taskId === task.taskId || (task.runId && message.runId === task.runId),
      );
  }

  view(taskId) {
    const task = this.runtime.db.getTask(taskId);
    if (!task) return null;
    const input = this.runtime.db.record(INPUT_NAMESPACE, taskId);
    return {
      task_id: task.taskId,
      agent_id: input?.agent_id ?? null,
      // The runtime's own status is passed through; uncertain and stopped are not collapsed.
      status: task.status,
      input: input
        ? {
            type: input.input_type,
            text: input.text,
            transcript: input.transcript,
            stt_provider: input.stt_provider,
            language: input.language,
          }
        : { type: "text", text: task.message },
      session_id: input?.session_id ?? null,
      provider: input?.provider ?? null,
      started_at: task.createdAt,
      completed_at: task.completedAt ?? null,
      result: task.result ?? null,
      error: task.error ?? null,
      correlation: {
        run_id: task.runId ?? null,
        session_key: task.sessionKey,
        backend_agent_id: task.agentId,
        gateway_id: task.gatewayId,
        binding_revision: task.bindingRevision,
      },
    };
  }

  events(taskId) {
    const task = this.runtime.db.getTask(taskId);
    if (!task) return null;
    return {
      task_id: taskId,
      events: this.runtime.db.taskEvents(taskId),
      tool_events: this.messagesOf(task)
        .filter((message) => message.role === "tool")
        .map((message) => ({
          tool: message.toolName,
          input: message.toolInput,
          output: message.toolOutput,
          at: message.timestamp,
        })),
    };
  }

  async cancel(taskId) {
    const task = this.runtime.db.getTask(taskId);
    if (!task) throw fail(404, "Task not found.");
    await this.runtime.taskOwner(task).cancel(taskId, {});
    return this.view(taskId);
  }
}
