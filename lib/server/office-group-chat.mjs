export const OFFICE_GROUP_SESSION = "office:group:main";
import { classifyOfficeIntent } from "./office-intent.mjs";
import { dataIntent, purchaseOrderId } from "./task-intent.mjs";
import { investigationView } from "./inventory-office-api.mjs";
import { officeLead } from "./office-lead.mjs";
import { businessIntent, formatBusinessReply } from "./nammaops/group-business.mjs";
import { classifyIntent } from "./routing/intent-classifier.mjs";
import { routeIntent, explainRouting } from "./routing/agent-router.mjs";
import { buildPlan, TASK_STATUS } from "./routing/task-planner.mjs";
import { recordTrace } from "./routing/routing-telemetry.mjs";
import { AGENTS, AGENT_REGISTRY, DOMAINS } from "./routing/capability-registry.mjs";
// Settled for a group turn. An unknown outcome is never retried, so it settles the turn too;
// otherwise one stuck agent would hold the whole office conversation.
const finished = new Set(["completed", "failed", "stopped", "interrupted", "outcome_unknown"]);
// How long a turn waits for an unavailable teammate before skipping it with a note.
const UNAVAILABLE_GRACE_MS = 2 * 60 * 1000;
const safeTurnId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(value);
const MAX_SUPPORTING = 2;
/** " · Source: LIVE …" from the task's recorded query event, when it read any data. */
const sourceLine = (task) => {
  const read = (task.timeline ?? []).findLast((event) => event.source);
  return read ? ` · Source: ${read.source}` : "";
};
// What a message asks for, and which seat roles serve it.
const RELEVANCE = [
  [/\b(?:plan\w*|steps?|schedule|roadmap|prioriti\w*|organi[sz]e)\b/i, /plan/i],
  [
    /\b(?:analy\w*|assess\w*|investigat\w*|data|numbers?|metrics?|trends?|why|cause|calculat\w*)\b/i,
    /analy|data/i,
  ],
  [/\b(?:review\w*|risks?|check\w*|verify|critique|wrong|flaws?)\b/i, /critic|review/i],
  [/\b(?:research\w*|sources?|search\w*|web|docs?|manuals?|articles?)\b/i, /research/i],
];

/** The office lead answers; at most two others join, chosen by role relevance in roster order.
 * Greetings go to the lead alone. Without a lead, the first available agent leads. */
export function selectParticipants(available, message, leadSeatId) {
  const lead = available.find((seat) => seat.seatId === leadSeatId) ?? available[0];
  if (!lead) return [];
  if (greeting.test(message)) return [lead];
  // A teammate addressed by name ("Bob, ..." at the start, or "@Carol" anywhere) always joins.
  // A bare word is not an address: seats may be labelled "plan" or "review".
  const named = available.filter((seat) => {
    const name = seat.label.replace(/[^\w]/g, "");
    return (
      seat !== lead && !!name && new RegExp(`^\\s*${name}\\s*[,:]|@${name}\\b`, "i").test(message)
    );
  });
  const supporting = available
    .filter((seat) => seat !== lead && !named.includes(seat))
    .map((seat, index) => ({
      seat,
      index,
      score: RELEVANCE.filter(
        ([asks, serves]) => asks.test(message) && serves.test(`${seat.roleTitle} ${seat.label}`),
      ).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SUPPORTING)
    .map((item) => item.seat);
  return [lead, ...named, ...supporting].slice(0, 1 + MAX_SUPPORTING + named.length);
}
function specialistIntent(message) {
  const team = /^(?:please\s+)?(?:assign|ask|get)\s+(?:the\s+)?team\s+to\s+(.+)$/i.exec(
    message.trim(),
  );
  if (team) return { kind: "team_request", goal: team[1].trim() };
  const match =
    /^(?:please\s+)?(?:assign|hire)\s+(?:a\s+)?(?:specialist\s+to\s+)?(research|maintenance(?:\s+specialist)?(?:\s+to)?\s+review)\s+(.+)$/i.exec(
      message.trim(),
    );
  if (!match) return null;
  return {
    kind: "specialist_request",
    specialistKind: /^research/i.test(match[1]) ? "research" : "maintenance-manual",
    goal: match[2].trim(),
  };
}
const greeting = /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[!?.\s]*$/i;
const refersToPrevious =
  /^(?:follow[ -]?up|continue|make (?:it|that)|expand (?:it|that)|shorten (?:it|that)|summarize (?:that|the previous)|use (?:the )?(?:previous|earlier|above)|based on (?:the )?(?:previous|earlier|above))\b/i;

function contribution(seat, index, total) {
  const role = (seat.roleTitle ?? "").toLowerCase();
  if (/critic|verif/.test(role))
    return "Challenge the current proposal: give one specific risk or missing check.";
  if (/planner/.test(role))
    return "Turn the findings into a short actionable plan. Do not repeat the analysis.";
  if (/analyst/.test(role))
    return "Identify the main facts and assumptions. Do not present an unverified conclusion as fact.";
  if (index === total - 1 && total > 1)
    return "Synthesize the distinct contributions into a concise answer, preserving open questions.";
  if (index === 0) return "Start with one focused answer or useful question.";
  return "Add one concrete point the earlier teammates missed. Do not rewrite their answers.";
}

/** One durable office turn. Each available seat sees earlier teammates' replies. */
export class OfficeGroupChat {
  constructor(runtime, { defaultScenarioId = "default" } = {}) {
    this.runtime = runtime;
    this.defaultScenarioId = defaultScenarioId;
    this.routing = new Set();
    this.specialistRouting = new Set();
    this.running = false;
    this.again = false;
    this.closed = false;
    this.unsubscribe = runtime.db.subscribe((event) => {
      if (event.kind === "task" || event.kind === "seat") this.schedule();
      if (
        [
          "orchestration",
          "operation.evidence",
          "operation.verification",
          "operation.reasoning",
          "composer.task",
        ].includes(event.kind)
      )
        this.bridge();
    });
  }
  messages() {
    return this.runtime.db.messages(OFFICE_GROUP_SESSION);
  }
  send(input) {
    this.runtime.estop?.assertClear();
    if (
      !input ||
      !safeTurnId(input.turnId) ||
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 32000
    )
      throw Object.assign(new Error("A valid turn ID and message are required."), { status: 400 });
    const id = `group_user_${input.turnId}`;
    const existing = this.runtime.db.getMessage(id);
    if (existing) {
      if (existing.content !== input.message.trim())
        throw Object.assign(new Error("Turn ID already belongs to another message."), {
          status: 409,
        });
      this.schedule();
      return existing;
    }
    const pending = this.messages().find(
      (message) => message.role === "user" && message.source === "group" && !this.done(message),
    );
    if (pending)
      throw Object.assign(new Error("The office is still working on the previous turn."), {
        status: 409,
      });
    const intent =
      specialistIntent(input.message) ??
      this.intelligentBusinessIntent(input.message) ??
      this.businessIntent(input.message) ??
      dataIntent(input.message) ??
      classifyOfficeIntent(input.message.trim(), {
        defaultScenarioId: this.defaultScenarioId,
      });
    if (!["data_request", "business_query", "multi_agent_query"].includes(intent.kind))
      this.runtime.require("chat.send");
    let participants = (this.runtime.rosterSeats?.() ?? this.runtime.db.seats())
      .filter((seat) => {
        const owner = this.owner(seat);
        return (
          seat.assigned &&
          seat.binding?.agentId &&
          owner.seatView(owner.db.getSeat(seat.seatId) ?? seat).binding.available
        );
      })
      .map((seat) => ({
        seatId: seat.seatId,
        label: seat.label,
        roleTitle: seat.roleTitle,
        sessionKey: seat.binding.sessionKey,
        bindingRevision: seat.binding.revision,
        gatewayId: this.owner(seat).gatewayId,
      }));
    if (!participants.length && intent.kind === "ordinary")
      throw Object.assign(new Error("No available office agents are bound to seats."), {
        status: 409,
      });
    participants = selectParticipants(
      participants,
      input.message.trim(),
      officeLead(this.runtime)?.seatId,
    );
    if (!["ordinary"].includes(intent.kind)) participants = [];
    const message = {
      id,
      runId: "",
      role: "user",
      source: "group",
      content: input.message.trim(),
      sessionKey: OFFICE_GROUP_SESSION,
      timestamp: new Date().toISOString(),
      groupTurnId: input.turnId,
      participants,
      ...(intent.kind !== "ordinary" ? { officeIntent: intent.kind } : {}),
      ...(intent.kind === "multi_agent_query" ? { routingPlan: intent.plan } : {}),
    };
    this.runtime.db.saveMessage(message);
    if (intent.kind !== "ordinary") {
      this.route(message, intent);
      return message;
    }
    this.schedule();
    return message;
  }
  /** The runtime that holds a seat or a recorded participant; older turns used this runtime. */
  owner(seat) {
    if (seat.gatewayId)
      return (
        (this.runtime.peers ?? []).find((peer) => peer.gatewayId === seat.gatewayId) ?? this.runtime
      );
    return this.runtime.seatOwner?.(seat.seatId) ?? this.runtime;
  }
  done(turn) {
    if (turn.officeIntent === "business_query")
      return (
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_business`) ||
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_blocked`)
      );
    if (turn.officeIntent === "multi_agent_query")
      return (
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_synthesis`) ||
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_blocked`)
      );
    if (turn.officeIntent === "data_request")
      return (
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_report`) ||
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_blocked`)
      );
    return turn.participants.every(
      (_, index) => !!this.runtime.db.getMessage(`group_reply_grp_${turn.groupTurnId}_${index}`),
    );
  }
  route(turn, classified) {
    if (this.routing.has(turn.groupTurnId)) return;
    this.routing.add(turn.groupTurnId);
    try {
      const intent =
        classified ??
        specialistIntent(turn.content) ??
        this.intelligentBusinessIntent(turn.content) ??
        this.businessIntent(turn.content) ??
        dataIntent(turn.content) ??
        classifyOfficeIntent(turn.content, {
          defaultScenarioId: this.defaultScenarioId,
        });
      if (intent.kind === "multi_agent_query") {
        void this.routeMultiAgent(turn, intent);
        return;
      }
      if (intent.kind === "business_query") {
        void this.routeBusiness(turn, intent);
        return;
      }
      if (intent.kind === "specialist_request") {
        void this.routeSpecialist(turn, intent);
        return;
      }
      if (intent.kind === "team_request") {
        this.routeTeam(turn, intent);
        return;
      }
      if (intent.kind === "data_request")
        return this.routeComposer(
          turn,
          intent.goal,
          purchaseOrderId(intent.goal)
            ? `Supplier delivery investigation (${purchaseOrderId(intent.goal)})`
            : "Data task",
        );
      if (intent.missing.length) {
        this.post(
          turn,
          "missing",
          `To start the inventory investigation, provide: ${intent.missing.join(", ")}.`,
        );
        return;
      }
      // Inventory work runs in the automated, verified Work pipeline; the legacy manual-step
      // investigation is never started from chat, where nobody would advance it.
      return this.routeComposer(turn, intent.submission.goal, "Inventory investigation");
    } finally {
      this.routing.delete(turn.groupTurnId);
    }
  }
  /** Start (or rejoin) the Work pipeline task for this turn and report its progress here. */
  routeComposer(turn, goal, label) {
    try {
      if (!this.runtime.composer) throw new Error("The task composer is unavailable.");
      const task = this.runtime.composer.create({
        submissionId: `group_${turn.groupTurnId}`,
        goal,
      });
      if (!this.runtime.db.record("office.groupComposer", turn.groupTurnId))
        this.runtime.db.saveRecord(
          "office.groupComposer",
          turn.groupTurnId,
          { taskId: task.id },
          0,
        );
      this.post(
        turn,
        "started",
        `${label} started · ${task.id} · status ${task.status.replaceAll("_", " ")}. Progress is reported here as it happens.\n\n[Open report](/work/${encodeURIComponent(task.id)})`,
      );
      this.bridge();
    } catch (error) {
      this.post(turn, "blocked", `${label} blocked: ${error.message}`);
    }
  }
  /** A store question for the NammaOps voice router, only when NammaOps is configured. */
  businessIntent(message) {
    if (!this.runtime.nammaops?.voice) return null;
    const parsed = businessIntent(message, {
      today: this.runtime.nammaops.workflows.today(),
      seats: this.seatDepartments().map((entry) => entry.label),
    });
    return parsed ? { kind: "business_query", ...parsed } : null;
  }

  /**
   * Intelligent multi-domain intent detection using the routing engine.
   *
   * Returns { kind: "multi_agent_query", plan, decision } when the message requires multiple
   * agents or when a single-domain query was not caught by businessIntent() (e.g. "check finance").
   *
   * Falls back to the existing businessIntent() path for single-domain voice-router queries
   * that are already handled there.
   *
   * Returns null to let the ordinary chat path handle everything else.
   */
  intelligentBusinessIntent(message) {
    if (!this.runtime.nammaops?.voice) return null;

    let intent;
    try {
      intent = classifyIntent(message);
    } catch {
      return null;
    }

    // Nothing detected or greeting
    if (intent.domains.length === 0 || intent.primaryIntent === "greeting") return null;

    // Clarification needed
    if (intent.needsClarification) return null; // let ordinary path handle

    const availableSeats = this.seatDepartments();

    // Single-domain query: check if businessIntent() already handles it.
    // If so, let the existing path run to avoid double-routing.
    if (intent.domains.length === 1) {
      const singleDomain = intent.domains[0];
      // Finance has no voice-router path — must use multi_agent_query
      if (singleDomain !== DOMAINS.FINANCE) {
        // For non-finance single-domain queries, let businessIntent() handle it
        // (it has more precise pattern matching for those cases).
        // Only intercept if the existing businessIntent() would return null.
        const existing = this.businessIntent(message);
        if (existing) return null; // existing path handles it
      }
    }

    // Build routing decision
    const decision = routeIntent(intent, availableSeats);
    if (decision.selectedAgents.length === 0) return null;

    // Record telemetry
    try {
      recordTrace(this.runtime.db, `intent_${Date.now()}`, decision);
    } catch {
      /* telemetry must never break routing */
    }

    // Multi-domain or finance-only → route as multi_agent_query
    return { kind: "multi_agent_query", decision, plan: null };
  }

  /**
   * Execute a multi-agent plan: run voice-router agents in parallel, Erin via direct task,
   * then post a synthesis message.
   */
  async routeMultiAgent(turn, intent) {
    if (this.specialistRouting.has(turn.groupTurnId)) return;
    this.specialistRouting.add(turn.groupTurnId);
    try {
      const decision = intent.decision;
      const seats = this.seatDepartments();

      // Post an announcement so the user knows work is starting
      const agentLabels = decision.selectedAgents
        .map((id) => AGENT_REGISTRY[id]?.label ?? id)
        .join(", ");
      const strategyNote =
        decision.executionStrategy === "parallel"
          ? "working in parallel"
          : decision.executionStrategy === "dependency_based"
            ? "working in sequence"
            : "working on this";
      this.post(
        turn,
        "multi_started",
        `I'll coordinate this request. ${agentLabels} ${strategyNote}.\n\n${explainRouting(decision)}`,
      );

      // Build execution groups based on strategy
      const groups = this.buildExecutionGroups(decision);

      const allResults = [];

      for (const group of groups) {
        // Run each group; within a group, all agents run in parallel
        const groupPromises = group.map((agentId) =>
          this.runAgentForMulti(turn, agentId, decision, allResults),
        );
        const groupResults = await Promise.allSettled(groupPromises);

        for (const r of groupResults) {
          if (r.status === "fulfilled" && r.value) allResults.push(r.value);
        }
      }

      // Post synthesis
      this.postMultiAgentSynthesis(turn, allResults, decision);
    } catch (error) {
      this.post(turn, "blocked", `Multi-agent request blocked: ${error.message}`);
    } finally {
      this.specialistRouting.delete(turn.groupTurnId);
    }
  }

  /**
   * Build execution groups from a routing decision.
   * Each group is an array of agent IDs that can run in parallel.
   */
  buildExecutionGroups(decision) {
    const { selectedAgents, executionStrategy, dependencies } = decision;
    if (selectedAgents.length === 0) return [];
    if (executionStrategy === "single") return [[selectedAgents[0]]];

    if (executionStrategy === "dependency_based" && dependencies?.length > 0) {
      const upstreamSet = new Set(dependencies.map((d) => d.upstream));
      const downstreamSet = new Set(dependencies.map((d) => d.downstream));
      const upstream = selectedAgents.filter((id) => upstreamSet.has(id));
      const downstream = selectedAgents.filter((id) => downstreamSet.has(id));
      const independent = selectedAgents.filter(
        (id) => !upstreamSet.has(id) && !downstreamSet.has(id),
      );
      const groups = [];
      if (upstream.length > 0 || independent.length > 0) groups.push([...upstream, ...independent]);
      if (downstream.length > 0) groups.push(downstream);
      return groups;
    }

    return [selectedAgents]; // parallel: all in one group
  }

  /**
   * Run a single agent's portion of a multi-agent query.
   * Voice-router agents use nammaops.voice.query(); Erin uses direct task submission.
   */
  async runAgentForMulti(turn, agentId, decision, previousResults) {
    const meta = AGENT_REGISTRY[agentId];
    if (!meta) return null;
    const seats = this.seatDepartments();
    const seat = seats.find((s) => s.label.toLowerCase() === meta.label.toLowerCase());
    if (!seat) {
      return {
        agentId,
        label: meta.label,
        domain: meta.domain,
        status: "unavailable",
        content: `${meta.label} (${meta.domain}) is not currently available.`,
      };
    }

    // Every NammaOps department (Erin included) answers through the governed voice router. Only an
    // agent without a router path falls back to a direct task.
    if (!meta.usesVoiceRouter) {
      return this.runDirectAgentTask(turn, seat, agentId, meta, decision, previousResults);
    }

    // Voice-router path (Bob, Carol, Dave, Alice/manager)
    const voiceIntent = decision.voiceIntents?.[meta.domain];
    if (!voiceIntent) return null;

    // Build args, injecting context from upstream results for dependency cases
    const args = this.buildVoiceArgs(agentId, voiceIntent, decision, previousResults);

    try {
      const callId = `group_${turn.groupTurnId}_${meta.domain}`;
      const actionId = `group_ma_${meta.domain}`;
      const response = await this.runtime.nammaops.voice.query({
        call: { id: callId, name: seat.label },
        actionId,
        args,
      });
      const formatted = formatBusinessReply(response);
      return {
        agentId,
        label: meta.label,
        domain: meta.domain,
        status: "completed",
        content: formatted,
      };
    } catch (error) {
      return {
        agentId,
        label: meta.label,
        domain: meta.domain,
        status: "failed",
        content: `${meta.label} encountered an error: ${error.message}`,
      };
    }
  }

  /** Build voice query args, possibly enriched with upstream results (dependency case). */
  buildVoiceArgs(agentId, voiceIntent, decision, previousResults) {
    const args = { intent: voiceIntent };

    // For procurement depending on inventory: pass low-stock product names to Dave
    if (agentId === AGENTS.PROCUREMENT && decision.dependencies?.length > 0) {
      const inventoryResult = previousResults.find((r) => r.domain === DOMAINS.INVENTORY);
      if (inventoryResult?.content) {
        // Extract product names from Bob's check_stock response text
        // The check_stock response lists low-stock items like: "ProductName: X units in stock, reorder level Y (low)"
        const lowStockMatches = inventoryResult.content.matchAll(/^([A-Z][^\n:]+?):\s+\d+/gm);
        const products = [...lowStockMatches].map((m) => m[1].trim()).slice(0, 10);
        if (products.length > 0) args.products = products;
      }
    }

    return args;
  }

  /**
   * Run Erin (or any direct-path agent) via the ordinary task mechanism.
   * Returns a Promise that resolves when the task completes or times out.
   */
  runDirectAgentTask(turn, seat, agentId, meta, decision, previousResults) {
    const taskId = `grp_ma_${turn.groupTurnId}_${meta.domain}`;
    const replyId = `group_reply_${taskId}`;

    // Check if already completed (idempotency)
    const existing = this.runtime.db.getMessage(replyId);
    if (existing) {
      return Promise.resolve({
        agentId,
        label: meta.label,
        domain: meta.domain,
        status: "completed",
        content: existing.content,
      });
    }

    const existingTask = this.runtime.db.getTask(taskId);
    const finished = new Set(["completed", "failed", "stopped", "interrupted", "outcome_unknown"]);

    // Build context from previous results
    const prevContext =
      previousResults.length > 0
        ? `Previous findings from the team:\n${previousResults.map((r) => `${r.label}: ${r.content.slice(0, 400)}`).join("\n\n")}`
        : "";

    const owner = this.runtime.seatOwner?.(seat.seatId) ?? this.runtime;
    const currentSeat = owner.db.getSeat(seat.seatId);
    if (!currentSeat?.assigned || !currentSeat.binding?.available) {
      return Promise.resolve({
        agentId,
        label: meta.label,
        domain: meta.domain,
        status: "unavailable",
        content: `${meta.label} is not currently available.`,
      });
    }

    // Build instruction based on domain
    const TIMEOUT_MS = 45000;
    const instruction =
      agentId === AGENTS.FINANCE
        ? `Review financial records for the store: check the profit and loss report, general ledger, and payment summary. Report actual figures from posted accounting data only. Do not estimate profit from sales numbers. Keep your answer under 200 words.${prevContext ? `\n\nContext: ${prevContext}` : ""}`
        : `Review your area and report findings. Use your tools. Report only verified data.${prevContext ? `\n\nContext: ${prevContext}` : ""}`;

    return new Promise((resolve) => {
      // If task already submitted, wait for it
      if (existingTask && !finished.has(existingTask.status)) {
        const unsub = this.runtime.db.subscribe((event) => {
          if (event.kind !== "task") return;
          const t = owner.db.getTask(taskId);
          if (t && finished.has(t.status)) {
            unsub();
            const content =
              t.status === "completed"
                ? t.result || owner.db.getMessage(`assistant_${taskId}`)?.content || "Completed."
                : `${meta.label}: could not complete (${t.status}).`;
            resolve({ agentId, label: meta.label, domain: meta.domain, status: t.status, content });
          }
        });
        setTimeout(() => {
          unsub();
          resolve({
            agentId,
            label: meta.label,
            domain: meta.domain,
            status: "timeout",
            content: `${meta.label}: did not respond in time.`,
          });
        }, TIMEOUT_MS);
        return;
      }

      // Submit new task
      try {
        owner.submit({
          taskId,
          seatId: seat.seatId,
          sessionKey: currentSeat.binding.sessionKey,
          bindingRevision: currentSeat.binding.revision,
          message: `Office request (multi-agent): ${turn.content}\n\nYour task: ${instruction}\n\nReply in at most 200 words. Focus on actual data from your tools.`,
          context: `You are part of a coordinated multi-agent response. ${prevContext}`.slice(
            0,
            3000,
          ),
        });
      } catch (err) {
        resolve({
          agentId,
          label: meta.label,
          domain: meta.domain,
          status: "failed",
          content: `${meta.label}: could not be assigned (${err.message}).`,
        });
        return;
      }

      const unsub = this.runtime.db.subscribe((event) => {
        if (event.kind !== "task") return;
        const t = owner.db.getTask(taskId);
        if (t && finished.has(t.status)) {
          unsub();
          const content =
            t.status === "completed"
              ? t.result || owner.db.getMessage(`assistant_${taskId}`)?.content || "Completed."
              : `${meta.label}: could not complete (${t.status}).`;
          // Persist a reply message so this turn is idempotent
          this.runtime.db.saveMessage({
            id: replyId,
            runId: t.runId ?? "",
            taskId,
            role: t.status === "completed" ? "assistant" : "system",
            source: "group",
            seatId: seat.seatId,
            actorName: meta.label,
            content,
            sessionKey: OFFICE_GROUP_SESSION,
            timestamp: new Date().toISOString(),
            groupTurnId: turn.groupTurnId,
          });
          resolve({ agentId, label: meta.label, domain: meta.domain, status: t.status, content });
        }
      });

      setTimeout(() => {
        unsub();
        resolve({
          agentId,
          label: meta.label,
          domain: meta.domain,
          status: "timeout",
          content: `${meta.label}: did not respond in time.`,
        });
      }, TIMEOUT_MS);
    });
  }

  /** Combine all agent results into a unified synthesis message. */
  postMultiAgentSynthesis(turn, results, decision) {
    if (results.length === 0) {
      this.post(turn, "synthesis", "No agents were able to respond to this request.");
      return;
    }

    const lead = officeLead(this.runtime);
    const sections = [];

    for (const r of results) {
      const header = `**${r.label} — ${r.domain.charAt(0).toUpperCase() + r.domain.slice(1)}**`;
      sections.push(`${header}\n${r.content}`);
    }

    // Add routing context section
    const domainList = decision.domains.join(", ");
    const sourceLine = `Source: multi-agent response · domains: ${domainList} · strategy: ${decision.executionStrategy}`;

    const synthesis = sections.join("\n\n---\n\n") + `\n\n${sourceLine}`;

    this.post(turn, "synthesis", synthesis, null, {
      seatId: lead?.seatId,
      actorName: lead ? `${lead.label} (coordinating)` : "Store Crew",
    });
  }
  /** Bound, assigned seats with the NammaOps department they speak for. */
  seatDepartments() {
    return (this.runtime.rosterSeats?.() ?? this.runtime.db.seats())
      .filter((seat) => seat.assigned && seat.binding?.agentId)
      .map((seat) => ({
        seatId: seat.seatId,
        label: seat.label,
        department: this.runtime.nammaops?.voice?.department(seat.label)?.department ?? null,
      }))
      .filter((seat) => seat.department);
  }
  /** The department agent runs the same router voice uses and answers in its own name. */
  async routeBusiness(turn, intent) {
    if (this.specialistRouting.has(turn.groupTurnId)) return;
    this.specialistRouting.add(turn.groupTurnId);
    try {
      const seats = this.seatDepartments();
      const speaker =
        seats.find((seat) => seat.label.toLowerCase() === intent.addressed?.toLowerCase()) ??
        seats.find((seat) => seat.department === intent.department) ??
        seats.find((seat) => seat.department === "manager") ??
        seats[0];
      if (!speaker) throw new Error("No NammaOps department agent is bound to a seat.");
      const response = await this.runtime.nammaops.voice.query({
        call: { id: `group_${turn.groupTurnId}`, name: speaker.label },
        actionId: "group",
        args: intent.args,
      });
      this.post(turn, "business", formatBusinessReply(response), null, {
        seatId: speaker.seatId,
        actorName: speaker.label,
      });
    } catch (error) {
      this.post(turn, "blocked", `Business request blocked: ${error.message}`);
    } finally {
      this.specialistRouting.delete(turn.groupTurnId);
    }
  }
  async routeSpecialist(turn, intent) {
    if (this.specialistRouting.has(turn.groupTurnId)) return;
    this.specialistRouting.add(turn.groupTurnId);
    try {
      if (!this.runtime.operations?.requestSpecialist)
        throw new Error("Specialist operations are unavailable.");
      const result = await this.runtime.operations.requestSpecialist({
        requestId: `group_${turn.groupTurnId}`,
        goal: intent.goal,
        kind: intent.specialistKind,
      });
      const decision = result.executionDecision;
      const routedVia = decision
        ? ` Routed to ${decision.runtime} (model provider ${decision.modelProvider}): ${decision.reason[0]}.`
        : "";
      const blockedBy = result.reason ? ` Blocked: ${result.reason}.` : "";
      this.post(
        turn,
        "specialist",
        `${result.status.toUpperCase()} · ${result.incidentId} · ${result.role}.${routedVia}${blockedBy} Open Employees to follow the assignment. Completion still requires evidence and verification.`,
        result.incidentId,
      );
    } catch (error) {
      this.post(turn, "blocked", `Specialist assignment blocked: ${error.message}`);
    } finally {
      this.specialistRouting.delete(turn.groupTurnId);
    }
  }
  /** The Team Lead splits the goal; its progress is posted back into this conversation. */
  routeTeam(turn, intent) {
    try {
      if (!this.runtime.teamLead) throw new Error("The Team Lead is unavailable.");
      const run = this.runtime.teamLead.start({
        requestId: `group_${turn.groupTurnId}`,
        goal: intent.goal,
        groupTurnId: turn.groupTurnId,
      });
      if (run.status === "planning")
        this.post(
          turn,
          "team-plan",
          `Team Lead is splitting the work into distinct assignments · open /team/${run.id}`,
        );
    } catch (error) {
      this.post(turn, "blocked", `Team run blocked: ${error.message}`);
    }
  }
  post(turn, stage, content, incidentId = null, speaker = null) {
    const id = `group_bridge_${turn.groupTurnId}_${stage}`;
    const existing = this.runtime.db.getMessage(id);
    if (existing && (stage !== "report" || existing.content === content)) return;
    const lead = officeLead(this.runtime);
    this.runtime.db.saveMessage({
      id,
      runId: "",
      role: "assistant",
      source: "group",
      // The office-lead seat (Alice by default) speaks for the Team Lead, unless a department
      // agent answers a store question in its own name.
      ...(speaker?.seatId
        ? { seatId: speaker.seatId }
        : !speaker && lead
          ? { seatId: lead.seatId }
          : {}),
      actorName: speaker?.actorName ?? (lead ? `${lead.label} (office lead)` : "Office lead"),
      content,
      sessionKey: OFFICE_GROUP_SESSION,
      timestamp: new Date().toISOString(),
      groupTurnId: turn.groupTurnId,
      ...(incidentId ? { incidentId } : {}),
    });
  }
  bridge() {
    for (const turn of this.messages().filter((entry) =>
      ["data_request", "inventory_shortage_investigation"].includes(entry.officeIntent),
    )) {
      const link = this.runtime.db.record("office.groupComposer", turn.groupTurnId);
      if (!link || !this.runtime.composer) continue;
      const task = this.runtime.composer.get(link.taskId);
      const reportLink = `[Open report](/work/${encodeURIComponent(task.id)})`;
      // One line per real execution event, posted once each; terminal results follow below.
      for (const event of task.timeline ?? [])
        if (
          [
            "memory_recalled",
            "query_submitted",
            "query_result",
            "query_failed",
            "policy_applied",
            "analyzing",
            "reviewing",
            "memory_saved",
          ].includes(event.event)
        )
          this.post(
            turn,
            `timeline_${task.id}_${event.event}_${event.at}`,
            `${task.id} · ${event.event.replaceAll("_", " ")} · ${event.actor}\n${event.detail}`,
          );
      if (["completed", "unresolved"].includes(task.status)) {
        const report = task.report;
        const refs =
          report?.sourceReferences
            ?.map((ref) => `${ref.evidenceId} — ${ref.source} / ${ref.recordId}`)
            .join("\n") ?? "";
        this.post(
          turn,
          "report",
          `${task.status === "completed" && report?.verified ? "Verified report" : "Unverified / blocked"} · ${task.id}${sourceLine(task)}\n\n${report?.summary || task.error || "No verified deliverable was produced."}\n\n${report?.scope ?? ""}\n\n${refs}\n\n${reportLink}`,
        );
      } else if (
        ["needs_clarification", "needs_confirmation", "approval_required"].includes(task.status)
      ) {
        this.post(
          turn,
          `clarify_${task.revision}`,
          `${task.route.clarification ?? "Review the task scope before execution."}\n\n${reportLink}`,
        );
      }
    }
    for (const turn of this.messages().filter(
      (entry) => entry.officeIntent === "inventory_shortage_investigation",
    )) {
      const link = this.runtime.db.record("office.groupIncident", turn.groupTurnId);
      if (!link) continue;
      let root;
      try {
        root = investigationView(this.runtime, link.incidentId);
      } catch {
        continue;
      }
      const views = [root];
      if (root.revisedIncidentId) {
        try {
          views.push(investigationView(this.runtime, root.revisedIncidentId));
        } catch {
          /* revision not yet ready */
        }
      }
      for (const view of views) {
        if (view.evidence.length)
          this.post(
            turn,
            `evidence_${view.incidentId}`,
            `Evidence collected for ${view.incidentId}: ${view.evidence.map((item) => item.evidenceId).join(", ")}.`,
            view.incidentId,
          );
        if (view.report) {
          const { verdict, reconciliation, evidenceIds } = view.report;
          const source = view.evidence.length
            ? view.synthetic
              ? "SYNTHETIC DATA"
              : "live Zetaris"
            : "no source evidence";
          this.post(
            turn,
            `verdict_${view.report.verificationId}`,
            `${verdict.toUpperCase()} · ${view.incidentId}\nDiscrepancy: ${reconciliation?.discrepancy ?? "unknown"}; explained: ${reconciliation?.explained ?? "unknown"}; unexplained: ${reconciliation?.unexplained ?? "unknown"}.\nEvidence IDs: ${evidenceIds.length ? evidenceIds.join(", ") : "none"}. Source: ${source}.`,
            view.incidentId,
          );
        } else if (["blocked", "failed", "unresolved", "outcome_unknown"].includes(view.status)) {
          this.post(
            turn,
            `status_${view.incidentId}_${view.status}`,
            `${view.status.toUpperCase()} · ${view.incidentId}. No verified explanation is available.`,
            view.incidentId,
          );
        }
      }
    }
  }
  schedule() {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    queueMicrotask(() => {
      if (this.closed) return;
      for (const turn of this.messages().filter((entry) =>
        [
          "inventory_shortage_investigation",
          "specialist_request",
          "data_request",
          "business_query",
          "multi_agent_query",
        ].includes(entry.officeIntent),
      ))
        if (
          !this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_blocked`) &&
          !this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_specialist`) &&
          !this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_business`) &&
          !this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_synthesis`)
        )
          this.route(turn);
      this.bridge();
      void this.advance();
    });
  }
  async advance() {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        for (const turn of this.messages().filter(
          (message) =>
            message.role === "user" && message.source === "group" && !message.officeIntent,
        )) {
          for (const [index, participant] of turn.participants.entries()) {
            const taskId = `grp_${turn.groupTurnId}_${index}`;
            const replyId = `group_reply_${taskId}`;
            if (this.runtime.db.getMessage(replyId)) continue;
            // Group messages live here; the turn's task, seat and reply live with the seat owner.
            const owner = this.owner(participant);
            const task = owner.db.getTask(taskId);
            if (task && !finished.has(task.status)) return;
            if (task) {
              const content =
                task.status === "completed"
                  ? task.result ||
                    owner.db.getMessage(`assistant_${taskId}`)?.content ||
                    "Completed without a text reply."
                  : `${participant.label}: could not complete this turn (${task.status.replaceAll("_", " ")}).`;
              this.runtime.db.saveMessage({
                id: replyId,
                runId: task.runId ?? "",
                taskId,
                role: task.status === "completed" ? "assistant" : "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            const seat = owner.db.getSeat(participant.seatId);
            if (
              !seat?.assigned ||
              seat.binding?.revision !== participant.bindingRevision ||
              seat.binding?.sessionKey !== participant.sessionKey
            ) {
              this.runtime.db.saveMessage({
                id: replyId,
                runId: "",
                role: "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content: `${participant.label}: agent binding changed; this teammate was skipped.`,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            if (!owner.seatView(seat).binding.available) {
              const waited = Date.now() - Date.parse(turn.timestamp);
              if (!(waited >= UNAVAILABLE_GRACE_MS)) {
                // Nothing else wakes this turn if the agent never returns: re-check later.
                clearTimeout(this.waitTimer);
                this.waitTimer = setTimeout(
                  () => this.schedule(),
                  Math.max(1000, UNAVAILABLE_GRACE_MS - (waited || 0)),
                );
                this.waitTimer.unref?.();
                return;
              }
              this.runtime.db.saveMessage({
                id: replyId,
                runId: "",
                role: "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content: `${participant.label}: agent unavailable for ${Math.round(UNAVAILABLE_GRACE_MS / 60000)} minutes; skipped this turn.`,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            const history = this.messages();
            const previousTurn = refersToPrevious.test(turn.content)
              ? history
                  .filter(
                    (entry) =>
                      entry.source === "group" && entry.role === "user" && entry.id !== turn.id,
                  )
                  .at(-1)
              : null;
            const discussion = history
              .filter(
                (entry) =>
                  entry.source === "group" &&
                  ["user", "assistant"].includes(entry.role) &&
                  (entry.groupTurnId === turn.groupTurnId ||
                    entry.groupTurnId === previousTurn?.groupTurnId),
              )
              .slice(-10)
              .map(
                (entry) =>
                  `${entry.role === "user" ? "You" : entry.actorName}: ${entry.content.slice(0, 500)}`,
              )
              .join("\n\n");
            try {
              owner.submit({
                taskId,
                seatId: participant.seatId,
                sessionKey: participant.sessionKey,
                bindingRevision: participant.bindingRevision,
                message: `Office request: ${turn.content}\nYour contribution: ${contribution(seat, index, turn.participants.length)} Reply in at most 120 words. Address the request directly; skip greetings and repeated introductions.`,
                context:
                  `Office group discussion (background, not verified evidence). Share your work and build on teammates' findings. Do not claim verified success without verification.\n\n${discussion}`.slice(
                    0,
                    6000,
                  ),
              });
            } catch (error) {
              this.runtime.db.saveMessage({
                id: replyId,
                runId: "",
                role: "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content:
                  error.status === 409
                    ? `${participant.label}: agent is unavailable or its binding changed.`
                    : `${participant.label}: could not assign this teammate.`,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            return;
          }
        }
      } while (this.again && !this.closed);
    } finally {
      this.running = false;
      if (this.again) this.schedule();
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.waitTimer);
    this.unsubscribe();
  }
}
