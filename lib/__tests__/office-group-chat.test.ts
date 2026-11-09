import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { TaskDatabase } from "../server/task-db.mjs";
import { OfficeGroupChat, OFFICE_GROUP_SESSION } from "../server/office-group-chat.mjs";
import { createRuntimeHandler } from "../server/runtime-api.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const opened: Array<() => void> = [];
afterEach(() =>
  opened
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

function setup() {
  const db = new TaskDatabase(":memory:");
  const submissions: Array<Record<string, unknown>> = [];
  const runtime = {
    db,
    require: () => {},
    seatView: (seat: { binding: object }) => ({
      ...seat,
      binding: { ...seat.binding, available: true },
    }),
    submit(input: Record<string, unknown>) {
      submissions.push(input);
      db.insertTask({
        ...input,
        gatewayId: "gateway-1",
        agentId: String(input.seatId),
        runId: null,
        actorName: String(input.seatId),
        status: "queued",
        createdAt: new Date().toISOString(),
      });
    },
  };
  for (const seatId of ["alice", "bob"])
    db.saveSeat({
      seatId,
      label: seatId,
      // Bob serves analysis requests, so he joins the lead (the first seat) on them.
      roleTitle: seatId === "bob" ? "Analyst" : "",
      assigned: true,
      binding: { agentId: seatId, sessionKey: `agent:${seatId}:main`, revision: 1 },
    });
  opened.push(() => db.close());
  return { db, runtime, submissions };
}

it("shares a durable office turn across bound agents and recovers after restart", async () => {
  const { db, runtime, submissions } = setup();
  let group = new OfficeGroupChat(runtime);
  const sent = group.send({ turnId: "turn1", message: "Investigate pressure" });
  expect(sent.sessionKey).toBe(OFFICE_GROUP_SESSION);
  expect(group.send({ turnId: "turn1", message: "Investigate pressure" }).id).toBe(sent.id);
  expect(() => group.send({ turnId: "turn1", message: "Different" })).toThrow();
  await tick();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].seatId).toBe("alice");
  expect(() => group.send({ turnId: "turn2", message: "Another turn" })).toThrow();
  group.close();

  db.updateTask("grp_turn1_0", { status: "completed", result: "Pump log shows low pressure." });
  group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  group.schedule();
  await tick();
  expect(submissions).toHaveLength(2);
  expect(submissions[1].seatId).toBe("bob");
  expect(submissions[1].context).toContain("alice: Pump log shows low pressure.");
  db.updateTask("grp_turn1_1", { status: "completed", result: "Check the valve next." });
  await tick();
  expect(
    group.messages().filter((message: { role: string }) => message.role === "assistant"),
  ).toHaveLength(3); // the instant "Asked…" note for the turn, then two seat replies
  expect(group.send({ turnId: "turn2", message: "Follow up" }).id).toBe("group_user_turn2");
  await tick();
  expect(submissions[2].context).toContain("bob: Check the valve next.");
});

it("answers small talk at once: an instant note says who was asked, replies follow", async () => {
  const { runtime, submissions } = setup();
  const group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  group.send({ turnId: "hi1", message: "hi" });
  const notes = group
    .messages()
    .filter((message: { groupTurnId?: string; role: string }) => message.groupTurnId === "hi1" && message.role === "assistant");
  expect(notes).toHaveLength(1);
  expect(notes[0].content).toMatch(/^Asked alice/);
  expect(notes[0].content).toMatch(/replies will follow here/);
  // Later replies, when they come far too slowly, replace nothing: the note is not a reply.
  await tick();
  expect(submissions).toHaveLength(1); // the OpenClaw work is unchanged
});

it("does not reassign a changed binding and distinguishes failed execution", async () => {
  const { db, runtime, submissions } = setup();
  const group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  group.send({ turnId: "turn3", message: "Investigate" });
  await tick();
  db.updateTask("grp_turn3_0", { status: "failed", result: "Untrusted failure" });
  const bob = db.getSeat("bob");
  db.saveSeat({ ...bob, binding: { ...bob.binding, revision: 2 } });
  await tick();
  expect(submissions).toHaveLength(1);
  const replies = group
    .messages()
    .filter(
      (message: { groupTurnId?: string; role: string }) =>
        message.groupTurnId === "turn3" && message.role === "system",
    );
  expect(replies).toHaveLength(2);
  expect(JSON.stringify(replies)).not.toContain("Untrusted failure");
});

it("does not carry an unrelated prior topic into a new office request", async () => {
  const { db, runtime, submissions } = setup();
  const group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  group.send({ turnId: "topic1", message: "Assess an AI tutor" });
  await tick();
  db.updateTask("grp_topic1_0", { status: "completed", result: "Tutor needs age safeguards." });
  await tick();
  db.updateTask("grp_topic1_1", { status: "completed", result: "Check school policy." });
  await tick();
  group.send({ turnId: "topic2", message: "Plan an office demo" });
  await tick();
  expect(submissions[2].context).not.toContain("AI tutor");
  expect(submissions[2].context).not.toContain("school policy");
  expect(submissions[2].message).toContain("Plan an office demo");
  expect(submissions[2].message).toContain("skip greetings");
});

it("routes a greeting to one teammate without seven repeated introductions", async () => {
  const { runtime, submissions } = setup();
  const group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  const turn = group.send({ turnId: "hello1", message: "hi" });
  expect(turn.participants).toHaveLength(1);
  await tick();
  expect(submissions).toHaveLength(1);
});

it("routes an explicit hire request once through office operations and recovers its durable reply", async () => {
  const { runtime, submissions } = setup();
  const requestSpecialist = vi.fn(async () => ({
    incidentId: "specialist_one",
    status: "active",
    role: "data-steward-researcher",
  }));
  Object.assign(runtime, { operations: { requestSpecialist } });
  let group = new OfficeGroupChat(runtime);
  const turn = group.send({
    turnId: "hire1",
    message: "Assign a specialist to research pump manuals",
  });
  expect(turn.officeIntent).toBe("specialist_request");
  await tick();
  expect(requestSpecialist).toHaveBeenCalledWith({
    requestId: "group_hire1",
    kind: "research",
    goal: "pump manuals",
  });
  expect(submissions).toHaveLength(0);
  group.close();
  group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  group.schedule();
  await tick();
  expect(requestSpecialist).toHaveBeenCalledTimes(1);
  expect(
    group
      .messages()
      .filter((message: { id: string }) => message.id === "group_bridge_hire1_specialist"),
  ).toHaveLength(1);
});

it("serves the durable group channel through the same-origin runtime API", async () => {
  const { runtime } = setup();
  const group = new OfficeGroupChat(runtime);
  Object.assign(runtime, { groupChat: group });
  opened.push(() => group.close());
  const handler = createRuntimeHandler(runtime);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  opened.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const base = `http://127.0.0.1:${address.port}`;
  const denied = await fetch(`${base}/api/runtime/office-group`, {
    headers: { Origin: "https://another.example" },
  });
  expect(denied.status).toBe(403);
  const posted = await fetch(`${base}/api/runtime/office-group`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ turnId: "http1", message: "Share findings" }),
  });
  expect(posted.status).toBe(201);
  const history = await (await fetch(`${base}/api/runtime/office-group`)).json();
  expect(history.messages[0].content).toBe("Share findings");
});

it("never lets one stuck or unavailable teammate hold the office conversation", async () => {
  const { db, runtime, submissions } = setup();
  const group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  // An unknown outcome settles the turn honestly; it is not retried.
  group.send({ turnId: "stuck1", message: "Investigate pressure" });
  await tick();
  db.updateTask("grp_stuck1_0", { status: "outcome_unknown" });
  await tick();
  db.updateTask("grp_stuck1_1", { status: "completed", result: "Pressure is stable." });
  await tick();
  const notes = group
    .messages()
    .filter((message: { groupTurnId?: string; role: string }) => message.groupTurnId === "stuck1");
  expect(JSON.stringify(notes)).toContain("could not complete this turn (outcome unknown)");
  expect(group.send({ turnId: "next1", message: "hi" }).id).toBe("group_user_next1");

  // An unavailable teammate is waited for, then skipped with a note after the grace period.
  await tick();
  db.updateTask("grp_next1_0", { status: "completed", result: "Hello." });
  await tick();
  // The agents drop out after the turn starts, before it is dispatched.
  group.send({ turnId: "away1", message: "Investigate pressure" });
  runtime.seatView = (seat: { binding: object }) => ({
    ...seat,
    binding: { ...seat.binding, available: false },
  });
  await tick();
  const before = submissions.length;
  expect(
    group.messages().filter((m: { groupTurnId?: string }) => m.groupTurnId === "away1"),
  ).toHaveLength(2); // the owner's words plus the instant "Asked…" note
  const later = Date.now() + 3 * 60 * 1000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(later);
  group.schedule();
  await tick();
  await tick();
  clock.mockRestore();
  const skipped = group
    .messages()
    .filter(
      (m: { groupTurnId?: string; role: string }) =>
        m.groupTurnId === "away1" && m.role === "system",
    );
  expect(skipped).toHaveLength(2);
  expect(skipped[0].content).toContain("agent unavailable for 2 minutes; skipped this turn");
  expect(submissions).toHaveLength(before);
});

it("answers a store question as the owning NammaOps department agent, like voice", async () => {
  const { db, runtime, submissions } = setup();
  for (const [seatId, label] of [
    ["carol", "Carol"],
    ["dave", "Dave"],
  ])
    db.saveSeat({
      seatId,
      label,
      roleTitle: "",
      assigned: true,
      binding: { agentId: seatId, sessionKey: `agent:${seatId}:main`, revision: 1 },
    });
  type Query = { call: { id: string; name: string }; actionId: string; args: unknown };
  const queries: Query[] = [];
  const departments: Record<string, { department: string }> = {
    Carol: { department: "sales" },
    Dave: { department: "procurement" },
  };
  const voice = {
    department: (label: string) => departments[label] ?? null,
    query: async (input: Query) => {
      queries.push(input);
      return {
        status: "completed",
        source: "fixture",
        workflow_id: "wf_1",
        consulted: ["inventory"],
        facts: ["Rice: about 40 expected to sell in the next 7 days."],
        recommendations: ["Order 50 Rice."],
        limitations: [],
        approvals: [],
        clarification_questions: [],
      };
    },
  };
  Object.assign(runtime, {
    nammaops: { voice, workflows: { today: () => "2026-11-01" } },
  });
  const group = new OfficeGroupChat(runtime);
  opened.push(() => group.close());
  group.send({ turnId: "biz1", message: "tell what order i have to make for today" });
  await tick();
  await tick();
  expect(submissions).toHaveLength(0);
  expect(queries[0].call.name).toBe("Dave");
  expect(queries[0].args).toEqual({ intent: "demand_forecast" });
  const reply = group.messages().find((m: { id: string }) => m.id.endsWith("_business"));
  expect(reply?.actorName).toBe("Dave");
  expect(reply?.content).toContain("Order 50 Rice.");
});
