/**
 * Handoff: moving a conversation (not permissions) from one specialist to another.
 *
 * The model only PROPOSES. The server owns the record, resolves the target from the roster, checks
 * the owner's consent from their own words, and consumes the handoff exactly once. Nothing a model
 * or the browser says is accepted as proof of consent, of a target seat, a session or a binding
 * revision. Each specialist keeps reading ERPNext under its own governed identity: a handoff gives
 * the target no extra grants.
 */
import { randomUUID } from "node:crypto";
import { seatChatSession } from "./delegation.mjs";

export const HANDOFF_NAMESPACE = "nammaops_handoff";
export const HANDOFF_TTL_MS = 2 * 60_000;
const MAX_PENDING = 600;
const MAX_TURNS = 8;
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

// JavaScript's \b only knows ASCII letters, so Hindi words are matched without it.
const NO_LATIN =
  /(?:^|[^a-z])(?:no|nope|nah|not|don'?t|do not|stop|cancel|never ?mind|later|wait|nahi|nahin|mat|ruko|rehne do)(?![a-z])/i;
const NO_DEVANAGARI = /नहीं|नही|मत\b|रुको|रहने दो|बाद में|कैंसल|(?:^|\s)ना(?:\s|$)/;
const YES_LATIN =
  /^[\s,.!]*(?:yes|yeah|yep|yup|sure|okay|ok|haan|han|ha|ji|theek hai|thik hai|please|go ahead|do it|connect|switch|put me through|kar do|karo|karwa do|karwao|karvao|jao|bilkul)(?![a-z])/i;
const YES_DEVANAGARI =
  /^[\s,.!]*(?:हाँ|हां|हा\b|जी|ठीक है|बिल्कुल|ज़रूर|जरूर|कर दो|करवाओ|करा दो|मिलाओ)/;
// "yes, but first ..." is a new request, not consent: leave those to the model check.
const HEDGE =
  /(?:^|[^a-z])(?:but|first|also|however|instead|then|and then)(?![a-z])|पहले|लेकिन|मगर/i;
const MAX_UNCLEAR = 3;

/**
 * Does the owner's own reply to "Shall I connect you to X?" agree? "no" always wins and a question
 * is never consent. A short reply that opens with an agreement ("Yes, connect me to Bob", "haan ji")
 * is accepted here; anything else goes to the optional model check, and without one stays undecided.
 * @returns {"yes" | "no" | "other" | "unclear"}
 */
export function plainConsent(reply) {
  const textValue = String(reply ?? "").trim();
  if (!textValue) return "unclear";
  if (NO_LATIN.test(textValue) || NO_DEVANAGARI.test(textValue)) return "no";
  if (/[?？]/.test(textValue)) return "other";
  const short = textValue.split(/\s+/).length <= 10;
  if (
    short &&
    !HEDGE.test(textValue) &&
    (YES_LATIN.test(textValue) || YES_DEVANAGARI.test(textValue))
  )
    return "yes";
  return "unclear";
}

/**
 * @param {any} runtime
 * @param {{ consent?: (reply: string) => Promise<"yes"|"no"|"other"|null>, now?: () => number, waitTries?: number }} [options]
 */
export function createHandoffs(runtime, { consent, now = Date.now, waitTries = 8 } = {}) {
  const db = () => runtime.db;
  const stamp = () => new Date(now()).toISOString();

  const get = (id) => (text(id, 100) ? db().record(HANDOFF_NAMESPACE, id) : null);
  const write = (record, patch) => {
    const { id, revision, ...rest } = record;
    // Compare-and-set on the revision: of two racing writers exactly one wins, the other gets 409.
    return db().saveRecord(HANDOFF_NAMESPACE, id, { ...rest, ...patch }, revision);
  };
  const live = (record) => {
    if (!record) throw fail(404, "Handoff not found.");
    if (record.status === "proposed" && Date.parse(record.expiresAt) <= now()) {
      try {
        write(record, { status: "expired" });
      } catch {
        /* another request already moved it */
      }
      throw fail(410, "That handoff expired. Ask again.");
    }
    return record;
  };

  /** The roster seat for a spoken or typed name or department, resolved on the server. */
  function targetSeat(name) {
    const wanted = String(name ?? "")
      .trim()
      .toLowerCase();
    if (!wanted) throw fail(400, "Say which teammate.");
    const departments = runtime.nammaops?.voice?.departments?.seats ?? [];
    const entry = departments.find(
      (row) => row.voice_name.toLowerCase() === wanted || row.department.toLowerCase() === wanted,
    );
    if (!entry) throw fail(404, `There is no teammate called ${name}.`);
    const seat = (runtime.rosterSeats?.() ?? db().seats()).find(
      (row) => row.assigned && String(row.label).toLowerCase() === entry.voice_name.toLowerCase(),
    );
    if (!seat) throw fail(409, `${entry.voice_name} is not on the team right now.`);
    return { seat, entry };
  }

  /** Everything that must hold for the target, checked on propose and again on accept. */
  function checkTarget(record) {
    runtime.estop?.assertClear?.();
    const { seat, agentId, sessionKey } = runtime.resolve(record.target.seatId); // throws if unavailable
    if (
      seat.binding.revision !== record.target.bindingRevision ||
      agentId !== record.target.agentId ||
      sessionKey !== record.target.sessionKey
    )
      throw fail(409, "The teammate's connection changed. Ask again.");
    const profile = runtime.profiles
      ?.list()
      .find(
        (p) => p.seat_id === record.target.seatId && String(p.agent_id).startsWith("nammaops-"),
      );
    if (!profile) throw fail(409, "That seat is not a store specialist.");
    return { seat, profile };
  }

  function checkSource(record) {
    const seat = db().getSeat(record.source.seatId);
    if (!seat?.assigned || seat.binding?.revision !== record.source.bindingRevision)
      throw fail(409, "This conversation changed. Ask again.");
    if (record.source.callId) {
      const call = db().record("voiceCall", record.source.callId);
      if (!call || call.endedAt || call.gatewayId !== runtime.gatewayId)
        throw fail(409, "The call has ended.");
    }
  }

  /** The bounded, server-built context the next specialist receives. */
  function buildPacket(record, history) {
    const turns = history.slice(-MAX_TURNS).map((m) => ({
      role: m.role,
      by: m.actorName ?? null,
      text: String(m.content ?? "").slice(0, 400),
      ...(m.workflowId ? { workflow_id: m.workflowId, intent: m.intent ?? null } : {}),
      // What an assistant said earlier is a claim, not evidence; only workflow results are.
      ...(m.role === "assistant" ? { unverified: true } : {}),
    }));
    return {
      from: record.source.name,
      to: record.target.name,
      owner_request: record.pending,
      reason: record.reason,
      recent_turns: turns,
      workflows: turns
        .filter((t) => t.workflow_id)
        .map((t) => ({ id: t.workflow_id, intent: t.intent })),
      note: "Earlier assistant statements are unverified context. Get figures from a workflow result.",
    };
  }

  return {
    get,

    /**
     * A specialist (or the model) proposes moving the conversation. Stores the proposal against the
     * source conversation; nothing moves until the owner consents.
     * @param {{ channel: "voice"|"chat", fromSeatId: string, sessionKey: string, callId?: string,
     *   target: string, pending?: string, reason?: string, triggerMessageId?: string }} input
     */
    propose(input) {
      runtime.estop?.assertClear?.();
      const source = db().getSeat(input.fromSeatId);
      if (!source?.assigned) throw fail(409, "This conversation has no assigned teammate.");
      const { seat, entry } = targetSeat(input.target);
      if (seat.seatId === input.fromSeatId)
        throw fail(409, `You are already talking to ${seat.label}.`);
      const resolved = runtime.resolve(seat.seatId); // target availability, isolated session
      const pending = String(input.pending ?? "")
        .trim()
        .slice(0, MAX_PENDING);
      const record = {
        status: "proposed",
        createdAt: stamp(),
        expiresAt: new Date(now() + HANDOFF_TTL_MS).toISOString(),
        source: {
          seatId: source.seatId,
          name: source.label,
          sessionKey: String(input.sessionKey),
          bindingRevision: source.binding.revision,
          agentId: source.binding.agentId,
          channel: input.channel,
          ...(input.callId ? { callId: input.callId } : {}),
        },
        target: {
          seatId: seat.seatId,
          name: seat.label,
          department: entry.department,
          title: entry.title,
          sessionKey: resolved.sessionKey,
          bindingRevision: seat.binding.revision,
          agentId: resolved.agentId,
        },
        pending,
        reason: String(input.reason ?? "").slice(0, 200) || `Owner asked for ${seat.label}.`,
        triggerMessageId: text(input.triggerMessageId, 200) ? input.triggerMessageId : null,
        // Marker in the source session: only owner turns AFTER this message can consent.
        afterMessageId: db().messages(String(input.sessionKey)).at(-1)?.id ?? null,
      };
      checkTarget(record);
      const history = db().messages(record.source.sessionKey);
      const saved = db().saveRecord(HANDOFF_NAMESPACE, `hof_${randomUUID().replace(/-/g, "")}`, {
        ...record,
        packet: buildPacket(record, history),
      });
      return { handoff_id: saved.id, target: record.target.name, confirm_required: true };
    },

    /**
     * Voice consent. `sourceMessageId` must be the owner's own finalised transcript of this call,
     * the FIRST owner turn after the proposal (a different request in between cancels it).
     */
    async confirmFromTranscript({ call, handoffId, sourceMessageId }) {
      const record = live(get(handoffId));
      if (record.status !== "proposed") throw fail(409, `That handoff is ${record.status}.`);
      if (record.source.callId !== call.id || record.source.seatId !== call.seatId)
        throw fail(403, "That handoff belongs to another conversation.");
      if (
        record.source.sessionKey !== call.sessionKey ||
        record.source.bindingRevision !== call.bindingRevision
      )
        throw fail(409, "This conversation changed. Ask again.");
      const latestOwnerTurn = () => {
        const all = db().messages(record.source.sessionKey);
        const marker = record.afterMessageId
          ? all.findIndex((m) => m.id === record.afterMessageId)
          : -1;
        return (
          all
            .slice(marker >= 0 ? marker + 1 : record.afterMessageId ? -20 : 0)
            .filter(
              (m) =>
                m.role === "user" &&
                m.source === "voice" &&
                m.runId === call.id &&
                m.id !== record.triggerMessageId &&
                !m.streaming,
            )
            // The owner may need to answer more than once ("what?" then "yes"): the latest turn
            // counts, and every earlier one was unclear (a no, question or other request would have
            // closed the proposal).
            .at(-1)
        );
      };
      let owner = latestOwnerTurn();
      // The model can call the tool a moment before the browser has saved the owner's last words.
      // Give that transcript a short chance to arrive instead of making the owner say it again.
      for (let wait = 0; wait < waitTries && owner?.id !== sourceMessageId; wait += 1) {
        if (db().getMessage(sourceMessageId) && owner) break; // saved, but it is not the latest turn
        await new Promise((resolve) => setTimeout(resolve, 300));
        owner = latestOwnerTurn();
      }
      if (!owner || owner.id !== sourceMessageId)
        throw fail(
          409,
          "I have not recorded the owner's answer yet. Ask them to say yes or no again.",
        );
      return this.decide(record, owner.content);
    },

    /** Apply the owner's reply text to a proposal (shared by voice, typed chat and tests). */
    async decide(record, reply) {
      let verdict = plainConsent(reply);
      if (verdict === "unclear" && consent) {
        try {
          verdict = (await consent(reply)) ?? "unclear";
        } catch {
          verdict = "unclear";
        }
      }
      if (verdict === "no") {
        write(record, { status: "declined", decidedAt: stamp() });
        return { status: "declined" };
      }
      if (verdict === "other") {
        write(record, { status: "cancelled", decidedAt: stamp() });
        return { status: "cancelled" };
      }
      if (verdict === "unclear") {
        const tries = (record.unclear ?? 0) + 1;
        if (tries >= MAX_UNCLEAR) {
          write(record, { status: "cancelled", decidedAt: stamp(), unclear: tries });
          return { status: "cancelled" };
        }
        write(record, { unclear: tries });
        return { status: "unclear" };
      }
      return this.accept(record.id, { by: "owner_transcript" });
    },

    /**
     * proposed -> accepted. Re-checks source and target, then compare-and-sets so two racing
     * requests cannot both succeed. For chat this also writes the target-side handover message.
     */
    accept(id, { by = "owner_click" } = {}) {
      const record = live(get(id));
      if (record.status !== "proposed") throw fail(409, `That handoff is ${record.status}.`);
      checkSource(record);
      checkTarget(record);
      const history = db().messages(record.source.sessionKey);
      const accepted = write(record, {
        status: "accepted",
        decidedAt: stamp(),
        decidedBy: by,
        packet: buildPacket(record, history),
      });
      const result = { status: "accepted", handoff_id: id, target: record.target };
      if (record.source.channel === "chat") {
        // Chat has no call to restart: the switch is consumed here and the server writes the note.
        const consumed = write(accepted, { status: "consumed", consumedAt: stamp() });
        // The note goes where the owner sees the teammate's chat (the seat's visible conversation),
        // not the seat's internal binding key, which the chat view never shows.
        let visible = record.target.sessionKey;
        try {
          visible = seatChatSession(runtime, record.target.seatId, record.target.agentId);
        } catch {
          // keep the binding key: the note is still saved, as before
        }
        db().saveMessage({
          id: `handoff_note_${id}`,
          runId: "",
          sessionKey: visible,
          seatId: record.target.seatId,
          source: "handoff",
          role: "assistant",
          actorName: record.source.name,
          unverified: true,
          handoffId: id,
          content: handoverText(consumed.packet),
          timestamp: stamp(),
        });
        return { ...result, status: "consumed" };
      }
      return result;
    },

    decline(id) {
      const record = live(get(id));
      if (record.status !== "proposed") throw fail(409, `That handoff is ${record.status}.`);
      write(record, { status: "declined", decidedAt: stamp() });
      return { status: "declined" };
    },

    /**
     * Voice: the new call claims an accepted handoff. Returns the trusted selection for the target
     * (derived from the stored record, never from the client) and the packet. accepted -> consumed.
     */
    claimForCall(id) {
      const record = get(id);
      if (!record) throw fail(404, "Handoff not found.");
      if (record.status !== "accepted") throw fail(409, `That handoff is ${record.status}.`);
      if (Date.parse(record.expiresAt) + HANDOFF_TTL_MS <= now())
        throw fail(410, "That handoff expired.");
      checkSource({ ...record, source: { ...record.source, callId: undefined } });
      checkTarget(record);
      const consumed = write(record, { status: "consumed", consumedAt: stamp() });
      return {
        selection: {
          seatId: record.target.seatId,
          sessionKey: record.target.sessionKey,
          bindingRevision: record.target.bindingRevision,
        },
        packet: consumed.packet,
        bridge: bridgePrompt(consumed.packet),
      };
    },
  };
}

/** The visible handover message, written by the server from the packet (never from browser text). */
export function handoverText(packet) {
  const lines = [`Handed over from ${packet.from} to ${packet.to}.`];
  if (packet.owner_request) lines.push(`Owner's request: ${packet.owner_request}`);
  if (packet.workflows.length)
    lines.push(
      `Earlier results: ${packet.workflows.map((w) => `${w.intent ?? "workflow"} (${w.id})`).join(", ")}.`,
    );
  lines.push(
    "Earlier assistant statements are unverified context; figures come from workflow results.",
  );
  return lines.join("\n");
}

/** The first thing the new voice agent is told, fixed by the server. */
export function bridgePrompt(packet) {
  return (
    `You are taking over this call from ${packet.from}. ` +
    (packet.owner_request ? `The owner wants: ${JSON.stringify(packet.owner_request)}. ` : "") +
    "Introduce yourself in one short sentence, then continue with that request. Do not ask the owner to repeat anything. " +
    "What was said earlier by the previous teammate is unverified context: get numbers from your own tools."
  );
}
