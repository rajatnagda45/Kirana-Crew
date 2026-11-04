import { afterEach, describe, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { createHandoffs, plainConsent } from "../server/nammaops/handoff.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SEATS = [
  ["seat-0", "Alice", "manager"],
  ["seat-5", "Erin", "finance"],
  ["seat-7", "Frank", "billing"],
] as const;

const dbs: Any[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** Real database and handoff module; roster, resolve and consent are small scripted stand-ins. */
function setup({ consent = async () => null as Any } = {}) {
  const db = new TaskDatabase(":memory:") as Any;
  dbs.push(db);
  const revisions: Record<string, number> = { "seat-0": 1, "seat-5": 1, "seat-7": 1 };
  const available: Record<string, boolean> = { "seat-0": true, "seat-5": true, "seat-7": true };
  const seatFor = (id: string, label: string) => ({
    seatId: id,
    label,
    assigned: true,
    binding: {
      agentId: "main",
      sessionKey: "agent:main:main",
      revision: revisions[id],
      available: available[id],
    },
  });
  const sync = () => {
    for (const [id, label] of SEATS) db.saveSeat(seatFor(id, label));
  };
  sync();
  let engaged = false;
  const runtime: Any = {
    db,
    gatewayId: "gw",
    estop: {
      assertClear: () => {
        if (engaged) throw Object.assign(new Error("Emergency stop is engaged."), { status: 423 });
      },
    },
    rosterSeats: () => SEATS.map(([id, label]) => seatFor(id, label)),
    resolve: (seatId: string) => {
      const seat = db.getSeat(seatId);
      if (!seat?.assigned || !available[seatId])
        throw Object.assign(new Error("This seat has no available backend agent binding."), {
          status: 409,
        });
      return { seat, agentId: "main", sessionKey: "agent:main:main" };
    },
    profiles: {
      list: () => SEATS.map(([id, , role]) => ({ seat_id: id, agent_id: `nammaops-${role}` })),
    },
    nammaops: {
      voice: {
        departments: {
          seats: SEATS.map(([, label, department]) => ({
            voice_name: label,
            department,
            title: department,
          })),
        },
      },
    },
  };
  const handoffs = createHandoffs(runtime, { consent, waitTries: 2 });
  const call = (extra: Any = {}) => {
    const record = {
      seatId: "seat-0",
      sessionKey: "agent:main:main",
      bindingRevision: 1,
      agentId: "main",
      name: "Alice",
      gatewayId: "gw",
      ...extra,
    };
    db.saveRecord("voiceCall", "call-1", record);
    return { id: "call-1", ...record };
  };
  const say = (id: string, content: string, role = "user") =>
    db.saveMessage({
      id,
      runId: "call-1",
      source: "voice",
      role,
      content,
      timestamp: new Date().toISOString(),
      streaming: false,
      seatId: "seat-0",
      sessionKey: "agent:main:main",
      agentId: "main",
      bindingRevision: 1,
      gatewayId: "gw",
      actorName: role === "user" ? undefined : "Alice",
    });
  return {
    db,
    runtime,
    handoffs,
    call,
    say,
    revisions,
    available,
    sync,
    engage: () => (engaged = true),
  };
}

/** Propose from a voice call the way the transfer_to_agent tool does. */
function voiceProposal(ctx: Any, trigger = "u1") {
  ctx.call();
  ctx.say(trigger, "let me talk to Erin about the udhaar");
  return ctx.handoffs.propose({
    channel: "voice",
    fromSeatId: "seat-0",
    sessionKey: "agent:main:main",
    callId: "call-1",
    target: "Erin",
    pending: "how much udhaar is pending",
    triggerMessageId: trigger,
  });
}

describe("consent wording", () => {
  it("accepts a plain yes and refuses everything that is not one", () => {
    for (const yes of [
      "yes",
      "Yes please",
      "haan ji",
      "ok go ahead",
      "connect me",
      "Yes, connect me to Bob",
      "हाँ, बॉब से करवाओ",
      "जी",
    ])
      expect(plainConsent(yes), yes).toBe("yes");
    for (const no of [
      "no",
      "No, I was asking whether Erin is available",
      "nahi",
      "don't",
      "नहीं, रहने दो",
    ])
      expect(plainConsent(no), no).toBe("no");
    expect(plainConsent("Is Erin available?")).toBe("other");
    expect(plainConsent("what is the stock of sugar")).toBe("unclear");
    expect(plainConsent("Yes, but first tell me the stock")).toBe("unclear");
    expect(plainConsent("से करवाओ")).toBe("unclear");
    expect(plainConsent("")).toBe("unclear");
  });
});

describe("voice handoff", () => {
  it("rejects a model claiming consent when the owner has not answered", async () => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    await expect(
      ctx.handoffs.confirmFromTranscript({
        call: ctx.call(),
        handoffId: proposal.handoff_id,
        sourceMessageId: "u1", // the request itself, not an answer
      }),
    ).rejects.toThrow(/not recorded the owner's answer/);
    expect(ctx.handoffs.get(proposal.handoff_id).status).toBe("proposed");
  });

  it("accepts an explicit yes that is the first owner turn after the proposal", async () => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    ctx.say("a1", "Shall I connect you to Erin?", "assistant");
    ctx.say("u2", "yes please");
    const out = await ctx.handoffs.confirmFromTranscript({
      call: ctx.call(),
      handoffId: proposal.handoff_id,
      sourceMessageId: "u2",
    });
    expect(out).toMatchObject({ status: "accepted", target: { name: "Erin" } });
    expect(ctx.handoffs.get(proposal.handoff_id).status).toBe("accepted");
  });

  it.each([
    ["No, I was asking whether Erin is available", "declined"],
    ["nahi", "declined"],
    ["Is Erin available?", "cancelled"],
  ])("does not switch on %j", async (reply, status) => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    ctx.say("u2", reply);
    const out = await ctx.handoffs.confirmFromTranscript({
      call: ctx.call(),
      handoffId: proposal.handoff_id,
      sourceMessageId: "u2",
    });
    expect(out.status).toBe(status);
    expect(ctx.handoffs.get(proposal.handoff_id).status).toBe(status);
    expect(() => ctx.handoffs.claimForCall(proposal.handoff_id)).toThrow();
  });

  it("uses the scripted model check only for an unclear reply, and never trusts an unsure one", async () => {
    const yes = setup({ consent: async () => "yes" });
    const a = voiceProposal(yes);
    yes.say("u2", "sure, that works for me, thanks");
    expect(
      (
        await yes.handoffs.confirmFromTranscript({
          call: yes.call(),
          handoffId: a.handoff_id,
          sourceMessageId: "u2",
        })
      ).status,
    ).toBe("accepted");

    const unsure = setup({ consent: async () => null });
    const b = voiceProposal(unsure);
    unsure.say("u2", "hmm maybe, let me think about the thing");
    const out = await unsure.handoffs.confirmFromTranscript({
      call: unsure.call(),
      handoffId: b.handoff_id,
      sourceMessageId: "u2",
    });
    expect(out.status).toBe("unclear");
    expect(unsure.handoffs.get(b.handoff_id).status).toBe("proposed");
  });

  it("rejects a confirmation from another call, seat or session, and a later owner turn", async () => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    ctx.say("u2", "yes");
    ctx.say("u3", "yes again");
    const call = ctx.call();
    await expect(
      ctx.handoffs.confirmFromTranscript({
        call: { ...call, id: "call-2" },
        handoffId: proposal.handoff_id,
        sourceMessageId: "u2",
      }),
    ).rejects.toThrow(/another conversation/);
    await expect(
      ctx.handoffs.confirmFromTranscript({
        call: { ...call, bindingRevision: 2 },
        handoffId: proposal.handoff_id,
        sourceMessageId: "u2",
      }),
    ).rejects.toThrow(/changed/);
    // Only the LATEST owner turn counts, so an older "yes" cannot be replayed after a newer message.
    await expect(
      ctx.handoffs.confirmFromTranscript({
        call,
        handoffId: proposal.handoff_id,
        sourceMessageId: "u2",
      }),
    ).rejects.toThrow(/not recorded/);
  });

  it("waits briefly for the owner's transcript to be saved instead of failing", async () => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    setTimeout(() => ctx.say("u2", "Yes, connect me to Erin"), 200);
    const out = await ctx.handoffs.confirmFromTranscript({
      call: ctx.call(),
      handoffId: proposal.handoff_id,
      sourceMessageId: "u2",
    });
    expect(out.status).toBe("accepted");
  });

  it("lets the owner answer more than once: an unclear reply, then a clear yes", async () => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    ctx.say("a1", "Shall I connect you to Erin?", "assistant");
    ctx.say("u2", "से करवाओ");
    const first = await ctx.handoffs.confirmFromTranscript({
      call: ctx.call(),
      handoffId: proposal.handoff_id,
      sourceMessageId: "u2",
    });
    expect(first.status).toBe("unclear");
    ctx.say("a2", "Please say yes or no.", "assistant");
    ctx.say("u3", "Yes, connect me to Erin");
    const second = await ctx.handoffs.confirmFromTranscript({
      call: ctx.call(),
      handoffId: proposal.handoff_id,
      sourceMessageId: "u3",
    });
    expect(second.status).toBe("accepted");
  });

  it("gives up after three unclear replies instead of asking forever", async () => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    let last = "";
    for (const id of ["u2", "u3", "u4"]) {
      ctx.say(id, "hmm what about the other thing");
      last = (
        await ctx.handoffs.confirmFromTranscript({
          call: ctx.call(),
          handoffId: proposal.handoff_id,
          sourceMessageId: id,
        })
      ).status;
    }
    expect(last).toBe("cancelled");
    expect(ctx.handoffs.get(proposal.handoff_id).status).toBe("cancelled");
  });

  it("expires, and an expired or replayed handoff can never be accepted", async () => {
    let clock = Date.parse("2026-11-04T10:00:00Z");
    const ctx = setup();
    const handoffs = createHandoffs(ctx.runtime, { now: () => clock });
    ctx.call();
    ctx.say("u1", "let me talk to Erin");
    const proposal = handoffs.propose({
      channel: "voice" as const,
      fromSeatId: "seat-0",
      sessionKey: "agent:main:main",
      callId: "call-1",
      target: "Erin",
      triggerMessageId: "u1",
    });
    clock += 3 * 60_000;
    expect(() => handoffs.accept(proposal.handoff_id)).toThrow(/expired/);
    expect(handoffs.get(proposal.handoff_id).status).toBe("expired");
  });

  it("claims an accepted handoff exactly once, deriving the target from the stored record", async () => {
    const ctx = setup();
    const proposal = voiceProposal(ctx);
    ctx.say("u2", "yes");
    await ctx.handoffs.confirmFromTranscript({
      call: ctx.call(),
      handoffId: proposal.handoff_id,
      sourceMessageId: "u2",
    });
    ctx.db.saveRecord("voiceCall", "call-1", { ...ctx.call(), endedAt: new Date().toISOString() });
    const claimed = ctx.handoffs.claimForCall(proposal.handoff_id);
    expect(claimed.selection).toEqual({
      seatId: "seat-5",
      sessionKey: "agent:main:main",
      bindingRevision: 1,
    });
    expect(claimed.bridge).toMatch(/taking over this call from Alice/);
    expect(claimed.bridge).toMatch(/how much udhaar is pending/);
    expect(claimed.packet.recent_turns.filter((t: Any) => t.role === "assistant")).toSatisfy(
      (turns: Any[]) => turns.every((t) => t.unverified === true),
    );
    expect(() => ctx.handoffs.claimForCall(proposal.handoff_id)).toThrow(/consumed/);
  });
});

describe("isolation and authorisation", () => {
  it("refuses unknown, same-seat, unavailable and emergency-stopped targets", () => {
    const ctx = setup();
    ctx.call();
    const base: Any = {
      channel: "voice" as const,
      fromSeatId: "seat-0",
      sessionKey: "agent:main:main",
      callId: "call-1",
    };
    expect(() => ctx.handoffs.propose({ ...base, target: "Nobody" })).toThrow(/no teammate/);
    expect(() => ctx.handoffs.propose({ ...base, target: "Alice" })).toThrow(/already talking/);
    ctx.available["seat-5"] = false;
    ctx.sync();
    expect(() => ctx.handoffs.propose({ ...base, target: "Erin" })).toThrow(/available/);
    ctx.available["seat-5"] = true;
    ctx.engage();
    expect(() => ctx.handoffs.propose({ ...base, target: "Erin" })).toThrow(/Emergency stop/);
  });

  it("re-checks the target on accept: a changed binding or an emergency stop blocks it", async () => {
    const ctx = setup();
    const a = voiceProposal(ctx);
    ctx.revisions["seat-5"] = 2;
    ctx.sync();
    expect(() => ctx.handoffs.accept(a.handoff_id)).toThrow(/connection changed/);

    const ctx2 = setup();
    const b = voiceProposal(ctx2);
    ctx2.engage();
    expect(() => ctx2.handoffs.accept(b.handoff_id)).toThrow(/Emergency stop/);
  });

  it("lets exactly one of two simultaneous accepts through", async () => {
    const ctx = setup();
    ctx.call();
    const proposal = ctx.handoffs.propose({
      channel: "chat",
      fromSeatId: "seat-0",
      sessionKey: "agent:main:main",
      target: "Frank",
      pending: "how many bills yesterday",
    });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => ctx.handoffs.accept(proposal.handoff_id)),
      Promise.resolve().then(() => ctx.handoffs.accept(proposal.handoff_id)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("server-built context", () => {
  it("writes the target-side handover message from the packet, flagged as unverified", () => {
    const ctx = setup();
    ctx.call();
    ctx.say("u1", "how many bills did we make yesterday");
    ctx.db.saveMessage({
      id: "dm_reply_x",
      runId: "",
      sessionKey: "agent:main:main",
      role: "assistant",
      actorName: "Alice",
      content: "Five bills, 5091 rupees.",
      timestamp: new Date().toISOString(),
      workflowId: "wf_abc",
      intent: "billing_summary",
    });
    const proposal = ctx.handoffs.propose({
      channel: "chat",
      fromSeatId: "seat-0",
      sessionKey: "agent:main:main",
      target: "Frank",
      pending: "how many bills did we make yesterday",
    });
    const out = ctx.handoffs.accept(proposal.handoff_id);
    expect(out.status).toBe("consumed");
    const note = ctx.db.getMessage(`handoff_note_${proposal.handoff_id}`);
    expect(note).toMatchObject({
      source: "handoff",
      seatId: "seat-7",
      unverified: true,
      actorName: "Alice",
    });
    expect(note.content).toMatch(/Handed over from Alice to Frank/);
    expect(note.content).toMatch(/billing_summary \(wf_abc\)/);
    expect(note.content).toMatch(/unverified/);
    // Nothing from the browser can supply the note: the id is derived from the handoff id.
    expect(() => ctx.handoffs.accept(proposal.handoff_id)).toThrow(/consumed/);
  });
});
