import { describe, expect, it } from "vitest";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import {
  COORDINATION_NAMESPACE,
  MIN_ETA_SAMPLES,
  decomposeRequest,
  durationEstimate,
  recoverCoordinations,
  splitClauses,
} from "../server/nammaops/coordination.mjs";
import { DELEGATION_NAMESPACE, seatChatSession } from "../server/nammaops/delegation.mjs";
import {
  MEMORY_NAMESPACE,
  isHistoricalQuestion,
  recall,
  remember,
} from "../server/nammaops/workflow-memory.mjs";
import { ready, TODAY } from "./nammaops-harness";

// Synthetic TEST FIXTURE only: fixture ERP, in-memory governance and database. Nothing here is live.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SEATS = ["Alice", "Bob", "Carol", "Dave", "Erin", "Grace", "Frank"];
const EXACT =
  "Check whether milk and atta are in stock, get today's sales summary, and check all overdue udhaar balances.";

const seatOf = (ctx: Any, role: string) =>
  ctx.runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`).seat_id as string;
const sessionOf = (ctx: Any, role: string) =>
  seatChatSession(ctx.runtime, seatOf(ctx, role), "main");
const ask = (ctx: Any, role: string, text: string, taskId: string) =>
  answerDirect(ctx.runtime, {
    taskId,
    message: text,
    seatId: seatOf(ctx, role),
    sessionKey: sessionOf(ctx, role),
  }) as Promise<Any>;
const message = (ctx: Any, id: string) => ctx.runtime.db.getMessage(id) as Any;
const messagesIn = (ctx: Any, key: string) => ctx.runtime.db.messages(key) as Any[];

describe("understanding a multi-part request (direct chat only)", () => {
  it("splits on commas and 'and <verb>' but keeps 'milk and atta' together", () => {
    expect(splitClauses(EXACT)).toEqual([
      "Check whether milk and atta are in stock",
      "get today's sales summary",
      "check all overdue udhaar balances",
    ]);
  });

  it("the exact three-part request becomes three tasks, none lost", () => {
    const { tasks, unresolved } = decomposeRequest(EXACT, { today: TODAY, seats: SEATS });
    expect(unresolved).toEqual([]);
    expect(tasks.map((t) => [t.intent, t.department])).toEqual([
      ["check_stock", "inventory"],
      ["sales_summary", "sales"],
      ["receivables_report", "finance"],
    ]);
    expect(tasks[0].args.products).toEqual(["milk", "atta"]);
    expect(tasks[1].args.day).toBe("today");
  });

  it("a subject named without its own verb is still covered ('today's stock and sales summary')", () => {
    const { tasks } = decomposeRequest("Give me today's stock and sales summary", {
      today: TODAY,
      seats: SEATS,
    });
    expect(tasks.map((t) => t.intent).sort()).toEqual(["check_stock", "sales_summary"]);
  });

  it("anything it cannot read is returned, never dropped", () => {
    const { tasks, unresolved } = decomposeRequest(
      "check stock of milk, and frobnicate the widgets",
      { today: TODAY, seats: SEATS },
    );
    expect(tasks.map((t) => t.intent)).toEqual(["check_stock"]);
    expect(unresolved).toEqual(["frobnicate the widgets"]);
  });
});

describe("E. Alice coordinates the exact three-part request", () => {
  it("acknowledges at once, delivers one task to each specialist's own chat, and combines all three", async () => {
    const ctx: Any = await ready();
    const out = await ask(ctx, "manager", EXACT, "a1");
    expect(out.answered).toMatchObject({ delegated: true, coordinationId: "coord_a1" });
    expect(out.answered.delegations).toEqual(["dlg_a1_0", "dlg_a1_1", "dlg_a1_2"]);
    const db = ctx.runtime.db;
    const alice = sessionOf(ctx, "manager");

    // Immediate acknowledgment in Alice's own chat, naming all three, before/without any report.
    const ack = message(ctx, "dm_reply_a1");
    expect(ack).toMatchObject({ sessionKey: alice, actorName: "Alice", delegationKind: "ack" });
    expect(ack.content).toMatch(
      /coordinating with Bob \(Inventory\), Carol \(Sales\) and Erin \(Finance\)/,
    );
    expect(ack.content).toMatch(/in parallel/);
    // No measured history in a fresh database, so no estimate is invented.
    expect(ack.content).toMatch(/I don't have a reliable completion estimate yet/);
    expect(ack.links.map((l: Any) => l.name)).toEqual(["Bob", "Carol", "Erin"]);

    const expected = [
      { id: "dlg_a1_0", role: "inventory", name: "Bob", intent: "check_stock" },
      { id: "dlg_a1_1", role: "sales", name: "Carol", intent: "sales_summary" },
      { id: "dlg_a1_2", role: "finance", name: "Erin", intent: "receivables_report" },
    ];
    const sessions = new Set([alice]);
    for (const [i, want] of expected.entries()) {
      const target = sessionOf(ctx, want.role);
      sessions.add(target);
      const record = db.record(DELEGATION_NAMESPACE, want.id);
      expect(record).toMatchObject({
        status: "completed",
        notified: true,
        coordination_id: "coord_a1",
        intent: want.intent,
        source: { department: "manager", name: "Alice" },
        target: { department: want.role, agent_id: `nammaops-${want.role}`, name: want.name },
        source_conversation_id: alice,
        target_conversation_id: target,
      });
      // The task arrives in THAT specialist's chat from Alice; the report is theirs, in their chat.
      expect(message(ctx, `dm_task_a1_${i}`)).toMatchObject({
        sessionKey: target,
        actorName: "Alice",
        delegationKind: "task",
      });
      expect(message(ctx, `dm_report_a1_${i}`)).toMatchObject({
        sessionKey: target,
        actorName: want.name,
        delegationKind: "report",
      });
      // Identity: governed reads under the owner's agent, inside its own grants, never Alice's.
      const agents = ctx.runtime.mcpGateway
        .invocations()
        .filter((row: Any) => row.correlation_id === record.workflow_id)
        .map((row: Any) => row.agent_id);
      expect(agents).toContain(`nammaops-${want.role}`);
      expect(agents).not.toContain("nammaops-manager");
      // No per-task notice in Alice's chat: she reports once, combined.
      expect(message(ctx, `dm_done_a1_${i}`)).toBeNull();
    }
    expect(sessions.size).toBe(4); // Alice and three different specialists

    // One combined report in Alice's chat covering every task.
    const final = message(ctx, "dm_synthesis_a1");
    expect(final).toMatchObject({
      sessionKey: alice,
      actorName: "Alice",
      delegationKind: "synthesis",
    });
    expect(final.content).toMatch(/combined report/);
    for (const section of ["Bob — Inventory", "Carol — Sales", "Erin — Finance"])
      expect(final.content).toContain(`**${section}**`);
    expect(final.content).toMatch(/Read by Bob \(Inventory\)/);
    expect(final.content).not.toMatch(/Missing or incomplete/);
    expect(final.links.map((l: Any) => l.name)).toEqual(["Bob", "Carol", "Erin"]);
    expect(db.record(COORDINATION_NAMESPACE, "coord_a1")).toMatchObject({
      status: "completed",
      final_posted: true,
    });
    // The full reports stay in the specialists' chats, not copied into Alice's.
    expect(messagesIn(ctx, alice).map((m) => m.id)).not.toContain("dm_report_a1_0");
  });

  it("runs the three tasks in parallel, not one after another", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", EXACT, "par");
    const records = ["dlg_par_0", "dlg_par_1", "dlg_par_2"].map((id) =>
      ctx.runtime.db.record(DELEGATION_NAMESPACE, id),
    );
    const lastStart = Math.max(...records.map((r: Any) => Date.parse(r.started_at)));
    const firstDone = Math.min(...records.map((r: Any) => Date.parse(r.completed_at)));
    expect(lastStart).toBeLessThanOrEqual(firstDone);
  });

  it("a failed specialist is disclosed, never silently dropped", async () => {
    const ctx: Any = await ready();
    const voice = ctx.nammaops.voice;
    const real = voice.query.bind(voice);
    voice.query = async (input: Any) => {
      if (input.call?.name === "Erin")
        throw Object.assign(new Error("The ERP read was denied."), { status: 403 });
      return real(input);
    };
    await ask(ctx, "manager", EXACT, "fail1");
    const final = message(ctx, "dm_synthesis_fail1").content as string;
    expect(final).toMatch(/Some parts are missing/);
    expect(final).toContain("**Bob — Inventory**");
    expect(final).toContain("**Carol — Sales**");
    expect(final).toContain("**Erin — Finance**");
    expect(final).toMatch(/Erin could not complete this: The ERP read was denied/);
    expect(ctx.runtime.db.record(COORDINATION_NAMESPACE, "coord_fail1").status).toBe("partial");
    // No memory is written for an incomplete report.
    expect(ctx.runtime.db.records(MEMORY_NAMESPACE)).toEqual([]);
  });

  it("an unavailable specialist is disclosed and the others still run", async () => {
    const ctx: Any = await ready();
    const sales = seatOf(ctx, "sales");
    const roster = ctx.runtime.rosterSeats;
    ctx.runtime.rosterSeats = () =>
      roster().map((s: Any) => (s.seatId === sales ? { ...s, assigned: false } : s));
    await ask(ctx, "manager", EXACT, "unavail1");
    const final = message(ctx, "dm_synthesis_unavail1").content as string;
    expect(final).toMatch(/Carol could not complete this: Carol is not available right now/);
    expect(final).toContain("**Bob — Inventory**");
    expect(final).toContain("**Erin — Finance**");
    expect(ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_unavail1_1")).toBeNull();
  });

  it("a part Alice cannot read is listed as missing", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", "check stock of milk, and frobnicate the widgets", "unres1");
    const final = message(ctx, "dm_synthesis_unres1").content as string;
    expect(final).toMatch(/I could not tell what to check for: "frobnicate the widgets"/);
    expect(final).toContain("**Bob — Inventory**");
  });

  it("a single specialist is coordinated the same way; a manager-owned question is not", async () => {
    const ctx: Any = await ready();
    const one = await ask(ctx, "manager", "check stock of milk", "single1");
    expect(one.answered.delegations).toEqual(["dlg_single1_0"]);
    expect(message(ctx, "dm_reply_single1").content).toMatch(/coordinating with Bob \(Inventory\)/);
    expect(message(ctx, "dm_synthesis_single1").content).toContain("**Bob — Inventory**");
    const profit = await ask(ctx, "manager", "what is the profit today", "profit1");
    expect(profit.answered.coordinationId).toBeUndefined();
    expect(message(ctx, "dm_synthesis_profit1")).toBeNull();
  });

  it("a retry runs and posts nothing twice", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", EXACT, "retry1");
    const workflows = ctx.nammaops.workflows.list().length;
    const alice = messagesIn(ctx, sessionOf(ctx, "manager")).length;
    const again = await ask(ctx, "manager", EXACT, "retry1");
    expect(again.answered).toMatchObject({ repeat: true });
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows);
    expect(messagesIn(ctx, sessionOf(ctx, "manager"))).toHaveLength(alice);
  });

  it("reports progress only when some tasks finished and others are still running", async () => {
    const ctx: Any = await ready();
    ctx.nammaops.delegationPollMs = 20;
    const voice = ctx.nammaops.voice;
    const real = voice.query.bind(voice);
    let slowFirst = true;
    voice.query = async (input: Any) => {
      if (input.call?.name === "Erin" && slowFirst) {
        slowFirst = false;
        const done = await real({ ...input, waitMs: 1 });
        return { ...done, status: "running", facts: [], recommendations: [] };
      }
      return real(input);
    };
    await ask(ctx, "manager", EXACT, "prog1");
    for (let i = 0; i < 100 && !message(ctx, "dm_synthesis_prog1"); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const progress = messagesIn(ctx, sessionOf(ctx, "manager")).filter(
      (m) => m.delegationKind === "progress",
    );
    expect(progress.length).toBeGreaterThan(0);
    for (const row of progress) expect(row.content).toMatch(/Still waiting for .*Erin/);
    // Each task is announced at most once, and the final report still arrives once.
    expect(new Set(progress.map((m) => m.id)).size).toBe(progress.length);
    expect(message(ctx, "dm_synthesis_prog1").content).toContain("**Erin — Finance**");
    expect(ctx.nammaops.workflows.list()).toHaveLength(3);
  });

  it("recovers a coordination whose tasks were never delivered, running each exactly once", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", EXACT, "rc0");
    const db = ctx.runtime.db;
    const first = db.record(COORDINATION_NAMESPACE, "coord_rc0");
    const value = {
      ...first,
      coordination_id: "coord_rc1",
      task_id: "rc1",
      status: "running",
      announced: [],
      final_posted: false,
      completed_at: null,
      subtasks: first.subtasks.map((sub: Any) => ({
        ...sub,
        delegation_id: `dlg_rc1_${sub.index}`,
        status: "queued",
      })),
    };
    delete value.id;
    delete value.revision;
    db.saveRecord(COORDINATION_NAMESPACE, "coord_rc1", value, 0);
    const before = ctx.nammaops.workflows.list().length;
    await recoverCoordinations(ctx.runtime);
    expect(ctx.nammaops.workflows.list()).toHaveLength(before + 3);
    expect(message(ctx, "dm_synthesis_rc1")).toMatchObject({ delegationKind: "synthesis" });
    await recoverCoordinations(ctx.runtime);
    expect(ctx.nammaops.workflows.list()).toHaveLength(before + 3);
  });
});

describe("F. ETA from measured history only", () => {
  const seed = (ctx: Any, action: string, count: number, ms: number, from = 0) => {
    for (let i = from; i < from + count; i += 1) {
      const created = new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString();
      ctx.runtime.db.saveRecord(
        "nammaops.workflow",
        `wf_seed_${action}_${i}`,
        {
          intent: { action },
          status: "completed",
          created_at: created,
          finished_at: new Date(Date.parse(created) + ms + i * 10).toISOString(),
        },
        0,
      );
    }
  };

  it("gives an estimate only when every workflow has enough comparable runs", async () => {
    const ctx: Any = await ready();
    expect(MIN_ETA_SAMPLES).toBe(5);
    seed(ctx, "stock_check", 5, 4000);
    seed(ctx, "daily_report", 5, 600);
    seed(ctx, "receivables_report", 4, 200); // one short
    expect(
      durationEstimate(ctx.runtime.db, ["check_stock", "sales_summary", "receivables_report"]),
    ).toBeNull();
    seed(ctx, "receivables_report", 1, 200, 4);
    const estimate = durationEstimate(ctx.runtime.db, [
      "check_stock",
      "sales_summary",
      "receivables_report",
    ])!;
    expect(estimate.samples).toBe(5);
    // The slowest of the parallel workflows decides.
    expect(estimate.p50_ms).toBeGreaterThanOrEqual(4000);
    expect(estimate.p90_ms).toBeGreaterThanOrEqual(estimate.p50_ms);
  });

  it("says 'estimate', not a promise, and names the sample size", async () => {
    const ctx: Any = await ready();
    seed(ctx, "stock_check", 5, 4000);
    seed(ctx, "daily_report", 5, 600);
    seed(ctx, "receivables_report", 5, 200);
    await ask(ctx, "manager", EXACT, "eta1");
    expect(message(ctx, "dm_reply_eta1").content).toMatch(
      /Estimated time: about \d+ seconds?, and usually under \d+ seconds? \(an estimate from 5 comparable past runs, not a promise\)/,
    );
  });

  it("does not use runs that include an owner's approval wait (prepare_bill)", async () => {
    const ctx: Any = await ready();
    seed(ctx, "prepare_bill", 9, 1000);
    expect(durationEstimate(ctx.runtime.db, ["prepare_bill"])).toBeNull();
  });
});

describe("F. persistent workflow memory", () => {
  it("stores only a completed report, with timestamp, evidence ids and no embedding when none exists", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", EXACT, "mem1");
    const memory = ctx.runtime.db.record(MEMORY_NAMESPACE, "mem_coord_mem1");
    expect(memory).toMatchObject({
      version: 1,
      type: "check_stock+receivables_report+sales_summary",
      index_mode: "keyword",
      embedding: null,
      report_ref: { message_id: "dm_synthesis_mem1" },
    });
    expect(memory.participants.map((p: Any) => p.name)).toEqual(["Bob", "Carol", "Erin"]);
    expect(memory.tasks.every((t: Any) => t.status === "completed" && t.workflow_id)).toBe(true);
    expect(Date.parse(memory.completed_at)).not.toBeNaN();
    expect(memory.evidence_invocation_ids.length).toBeGreaterThan(0);
    expect(memory.summary).toMatch(/Bob \(Inventory\)/);
    expect(memory.summary).not.toMatch(/pin/i);
  });

  it("answers a historical question from memory, with its timestamp, running nothing", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", EXACT, "mem2");
    const workflows = ctx.nammaops.workflows.list().length;
    const out = await ask(ctx, "manager", "what did the last stock report say", "mem3");
    expect(out.answered).toMatchObject({ memory: true, mode: "keyword" });
    const content = message(ctx, "dm_reply_mem3").content as string;
    expect(content).toMatch(/From the report completed at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(content).toMatch(/not re-verified/);
    expect(content).not.toMatch(/matched by meaning/); // no embedder, so no semantic claim
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows);
  });

  it("a live question recalls the earlier report AND checks live; memory never replaces ERP", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "manager", "check stock of milk", "mem4");
    const workflows = ctx.nammaops.workflows.list().length;
    await ask(ctx, "manager", "check stock of milk", "mem5");
    const ack = message(ctx, "dm_reply_mem5").content as string;
    expect(ack).toMatch(/From the report completed at/);
    expect(ack).toMatch(/not re-verified/);
    expect(ack).toMatch(/I am checking now to confirm what has changed/);
    // A fresh governed check ran for the live question.
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows + 1);
    expect(message(ctx, "dm_report_mem5_0").delegationKind).toBe("report");
  });

  it("says no stored report matches rather than inventing one", async () => {
    const ctx: Any = await ready();
    const out = await ask(ctx, "manager", "what did the last stock report say", "mem6");
    expect(out.answered).toMatchObject({ memory: true, memoryId: null });
    expect(message(ctx, "dm_reply_mem6").content).toMatch(/I do not have a stored report/);
  });

  it("claims semantic matching only when a verified embedder produced the vectors", async () => {
    const ctx: Any = await ready();
    const vector = (text: string) => (/stock|milk|inventory/i.test(text) ? [1, 0] : [0, 1]);
    ctx.runtime.memory = {
      embedder: { verified: true, model: "fake-embed", embed: async (t: string) => vector(t) },
    };
    await ask(ctx, "manager", "check stock of milk", "sem1");
    const stored = ctx.runtime.db.record(MEMORY_NAMESPACE, "mem_coord_sem1");
    expect(stored).toMatchObject({ index_mode: "semantic", embedding_model: "fake-embed" });
    const found = await recall(ctx.runtime, "how is our inventory", { intents: ["check_stock"] });
    expect(found.mode).toBe("semantic");
    const text = await ask(ctx, "manager", "what did the last inventory report say", "sem2");
    expect(text.answered.mode).toBe("semantic");
    expect(message(ctx, "dm_reply_sem2").content).toMatch(/matched by meaning/);
    // If the embedder goes away, recall falls back to keywords and says nothing about meaning.
    ctx.runtime.memory = {};
    const fallback = await recall(ctx.runtime, "what did the last stock report say", {
      intents: ["check_stock"],
    });
    expect(fallback.mode).toBe("keyword");
  });

  it("never stores a PIN or secret, and only fully completed reports", async () => {
    const ctx: Any = await ready();
    const states = [
      {
        sub: {
          name: "Frank",
          title: "Billing",
          department: "billing",
          intent: "prepare_bill",
          index: 0,
        },
        status: "completed",
        record: {
          workflow_id: "wf_x",
          result_reference: {
            summary: ["Draft bill ready. The owner PIN 4826 approves it. 4826 is my PIN too."],
            invocation_ids: ["inv_1"],
            limitations: [],
          },
        },
      },
    ];
    const co = {
      coordination_id: "coord_scrub",
      task_id: "scrub",
      original_request: "bill it; my password is hunter2",
      source_conversation_id: "agent:main:x",
      completed_at: new Date().toISOString(),
    };
    const stored = await remember(ctx.runtime, co, states as Any);
    expect(JSON.stringify(stored)).not.toMatch(/4826|hunter2/);
    expect(
      await remember(ctx.runtime, { ...co, coordination_id: "coord_bad" }, [
        { ...states[0], status: "failed" },
      ] as Any),
    ).toBeNull();
    expect(ctx.runtime.db.record(MEMORY_NAMESPACE, "mem_coord_bad")).toBeNull();
  });

  it("tells a historical question from a live one", () => {
    expect(isHistoricalQuestion("what did the last stock report say")).toBe(true);
    expect(isHistoricalQuestion("show me the previous sales summary")).toBe(true);
    expect(isHistoricalQuestion("how is our inventory right now")).toBe(false);
    expect(isHistoricalQuestion("check stock today")).toBe(false);
  });
});
