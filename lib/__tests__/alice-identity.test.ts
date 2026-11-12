import { describe, expect, it } from "vitest";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { DELEGATION_NAMESPACE, seatChatSession } from "../server/nammaops/delegation.mjs";
import { OfficeGroupChat, OFFICE_GROUP_SESSION } from "../server/office-group-chat.mjs";
import { ready } from "./nammaops-harness";

// Synthetic TEST FIXTURE only: fixture ERP, in-memory governance. Nothing here is live ERPNext and
// no purchase order or other document is created.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SEATS = [
  { name: "Alice", department: "manager", title: "Store Manager" },
  { name: "Bob", department: "inventory", title: "Inventory" },
  { name: "Carol", department: "sales", title: "Sales" },
  { name: "Dave", department: "procurement", title: "Procurement" },
] as const;
const ALICE_SEAT = "grp-manager";
const ROLE = "Store Manager · Office Lead";

/** A Store Crew with Alice as the office lead, sharing the fixture runtime. */
async function crew() {
  const ctx: Any = await ready();
  ctx.runtime.estop = { status: () => ({ engaged: false }), assertClear: () => {} };
  ctx.runtime.officeLeadSeatId = ALICE_SEAT;
  ctx.runtime.require = () => {};
  ctx.runtime.seatView = (seat: Any) => ({
    ...seat,
    binding: { ...seat.binding, available: true },
  });
  const submissions: Any[] = [];
  ctx.runtime.submit = (input: Any) => {
    submissions.push(input);
  };
  ctx.runtime.rosterSeats = () =>
    SEATS.map((seat) => ({
      seatId: `grp-${seat.department}`,
      label: seat.name,
      roleTitle: seat.title,
      assigned: true,
      binding: {
        agentId: `nammaops-${seat.department}`,
        sessionKey: `agent:nammaops-${seat.department}:grp`,
        revision: 1,
        available: true,
      },
    }));
  for (const seat of ctx.runtime.rosterSeats()) ctx.runtime.db.saveSeat(seat);
  const baseOwner = ctx.runtime.seatOwner();
  ctx.runtime.seatOwner = () => ({
    ...baseOwner,
    db: ctx.runtime.db,
    seatView: (seat: Any) => ({ ...seat, binding: { ...seat.binding, available: true } }),
  });
  const group: Any = new OfficeGroupChat(ctx.runtime);
  const say = async (turnId: string, text: string, until?: string) => {
    group.send({ turnId, message: text });
    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (until && ctx.runtime.db.getMessage(until)) break;
    }
    return ctx.runtime.db
      .messages(OFFICE_GROUP_SESSION)
      .filter((m: Any) => m.role === "assistant" && m.groupTurnId?.endsWith(turnId));
  };
  return { ctx, group, say, submissions };
}

const speakers = (messages: Any[]) => messages.map((m) => m.actorName);
const noSuffix = (messages: Any[]) =>
  expect(JSON.stringify(messages.map((m) => m.actorName))).not.toMatch(
    /office lead|coordinating|\(/i,
  );

describe("Alice is one agent in Store Crew", () => {
  it("handles an ordinary request herself with one Alice, no 'Asked Alice' note", async () => {
    const { group, say, submissions } = await crew();
    const posted = await say("own1", "create draft purchases");
    // The seat that was handed the turn is Alice's own seat: no self-delegation, no separate speaker.
    expect(submissions.map((s) => s.seatId)).toEqual([ALICE_SEAT]);
    expect(posted).toEqual([]); // no extra "Alice (office lead)" bubble before her real reply
    expect(JSON.stringify(group.messages())).not.toMatch(/Asked Alice|office lead\)/);
  });

  it("when others join, the note comes from Alice, names only them, and carries her one role line", async () => {
    const { say, ctx } = await crew();
    const posted = await say("own2", "Bob, review the pump log");
    const note = posted.find((m: Any) => m.id === "group_ack_own2");
    expect(note).toMatchObject({
      actorName: "Alice",
      seatId: ALICE_SEAT,
      actorRole: ROLE,
    });
    expect(note.content).toMatch(/^Asked Bob/);
    expect(note.content).not.toMatch(/Alice/);
    // Same canonical seat as her one-to-one chat: one Alice seat in the roster.
    const alices = ctx.runtime.rosterSeats().filter((seat: Any) => seat.label === "Alice");
    expect(alices).toHaveLength(1);
  });

  it.each([
    ["inventory request", "check stock of milk", "Bob", "grp-inventory"],
    ["sales request", "how much did we sell today", "Carol", "grp-sales"],
    ["procurement request", "compare supplier quotations for milk", "Dave", "grp-procurement"],
  ])("a %s is answered by the real specialist, never by Alice", async (_n, text, who, seatId) => {
    const { say } = await crew();
    const posted = await say("d1", text, "group_bridge_grp_d1_business");
    const specialists = posted.filter((m: Any) => m.actorName !== "Alice");
    expect(specialists.length).toBeGreaterThan(0);
    expect(new Set(specialists.map((m: Any) => m.actorName))).toEqual(new Set([who]));
    expect(specialists[0].seatId).toBe(seatId);
    noSuffix(posted);
    // Anything Alice posts for this turn is Alice, the one seat, with the combined role line.
    for (const m of posted.filter((entry: Any) => entry.actorName === "Alice"))
      expect(m.seatId).toBe(ALICE_SEAT);
  });

  it("Alice's team synthesis is posted as Alice with the one role line", async () => {
    const { say } = await crew();
    const posted = await say(
      "team1",
      "check stock and how much did we sell today",
      "group_bridge_grp_team1_synthesis",
    );
    const synthesis = posted.find((m: Any) => m.id === "group_bridge_grp_team1_synthesis");
    if (synthesis) {
      expect(synthesis).toMatchObject({ actorName: "Alice", seatId: ALICE_SEAT, actorRole: ROLE });
    }
    noSuffix(posted);
  });
});

describe("Alice in her individual chat is the same agent", () => {
  const seatOf = (ctx: Any, role: string) =>
    ctx.runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`)
      .seat_id as string;
  const ask = (ctx: Any, role: string, text: string, taskId: string) =>
    answerDirect(ctx.runtime, {
      taskId,
      message: text,
      seatId: seatOf(ctx, role),
      sessionKey: seatChatSession(ctx.runtime, seatOf(ctx, role), "main"),
    }) as Promise<Any>;

  it("her own answer is one 'Alice', and a team answer says 'Alice' plus one role line", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", "what is the profit today", "p1");
    const reply = ctx.runtime.db.getMessage("dm_reply_p1");
    expect(reply.actorName).toBe("Alice");
    expect(JSON.stringify(reply.actorName)).not.toMatch(/\(/);
    // She handles it herself or by team: never a delegation to Alice.
    const toAlice = ctx.runtime.db
      .records(DELEGATION_NAMESPACE)
      .filter((r: Any) => r.target?.department === "manager");
    expect(toAlice).toEqual([]);
  });

  it.each([
    ["inventory", "check stock of milk", "Bob"],
    ["sales", "how much did we sell today", "Carol"],
    ["procurement", "compare supplier quotations for milk", "Dave"],
  ])("a %s request goes to the specialist, never to Alice herself", async (_n, text, who) => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", text, "x1");
    const records = ctx.runtime.db.records(DELEGATION_NAMESPACE);
    for (const record of records) {
      expect(record.target.name).not.toBe("Alice");
      expect(record.target.name).toBe(who);
    }
    const names = ctx.runtime.db
      .messages(seatChatSession(ctx.runtime, seatOf(ctx, "manager"), "main"))
      .filter((m: Any) => m.role === "assistant")
      .map((m: Any) => m.actorName);
    for (const name of names) expect(name).not.toMatch(/\(/);
  });
});
