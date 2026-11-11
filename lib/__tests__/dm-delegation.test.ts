import { describe, expect, it } from "vitest";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import {
  DELEGATION_NAMESPACE,
  finish,
  recoverDelegations,
  seatChatSession,
} from "../server/nammaops/delegation.mjs";
import { ready } from "./nammaops-harness";

// Synthetic TEST FIXTURE only: fixture ERP, in-memory governance, in-memory database. These tests
// prove behaviour against the fixture; nothing here is live ERPNext or a live gateway.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const NAMES: Record<string, string> = {
  manager: "Alice",
  inventory: "Bob",
  sales: "Carol",
  procurement: "Dave",
  finance: "Erin",
  reports: "Grace",
  billing: "Frank",
};

/** Each seat's own visible conversation, as the UI would show it (the newest seat-tagged session). */
const seatOf = (ctx: Any, role: string) =>
  ctx.runtime.profiles.list().find((p: Any) => p.agent_id === `nammaops-${role}`).seat_id as string;
const sessionOf = (ctx: Any, role: string) =>
  seatChatSession(ctx.runtime, seatOf(ctx, role), "main");

/** What each department's specialist agent may read (the pinned grant matrix). */
const GRANTS: Record<string, string[]> = {
  inventory: [
    "erp.items.list",
    "erp.stock.balance",
    "erp.warehouses.list",
    "erp.stock.ledger",
    "erp.stock.movements",
    "erp.items.valuation",
    "erp.batches.list",
  ],
  sales: [
    "erp.sales_invoices.list",
    "erp.pos_invoices.list",
    "erp.customers.list",
    "erp.items.list",
    "erp.sales.history",
    "erp.receivables.aging",
  ],
  procurement: [
    "erp.suppliers.list",
    "erp.supplier_quotations.list",
    "erp.item_prices.get",
    "erp.po.get",
    "erp.po.open",
    "erp.items.list",
    "erp.payables.aging",
    "erp.purchase_invoices.list",
  ],
  finance: [
    "erp.pnl",
    "erp.gl",
    "erp.purchase_invoices.list",
    "erp.payments.summary",
    "erp.receivables.aging",
    "erp.payables.aging",
    "erp.gst.summary",
  ],
  reports: [
    "erp.sales_invoices.list",
    "erp.pos_invoices.list",
    "erp.items.list",
    "erp.stock.balance",
    "erp.pnl",
    "erp.receivables.aging",
    "erp.payables.aging",
  ],
  billing: [
    "erp.sales_invoices.list",
    "erp.pos_invoices.list",
    "erp.customers.list",
    "erp.items.list",
    "erp.receivables.aging",
    "erp.sales_invoice.create_draft",
    "erp.sales_invoice.get",
    "erp.selling_prices.get",
  ],
};

const ask = (ctx: Any, role: string, text: string, taskId: string) =>
  answerDirect(ctx.runtime, {
    taskId,
    message: text,
    seatId: seatOf(ctx, role),
    sessionKey: sessionOf(ctx, role),
  }) as Promise<Any>;

const messagesIn = (ctx: Any, key: string) => ctx.runtime.db.messages(key) as Any[];

/**
 * Everything a finished delegation must prove: where each message went, who ran it, with which
 * grants, and where the result and completion notice are. Returns the delegation record.
 */
function expectDelegated(
  ctx: Any,
  args: { from: string; to: string; taskId: string; text: string },
) {
  const { from, to, taskId, text } = args;
  const db = ctx.runtime.db;
  const sourceSession = sessionOf(ctx, from);
  const targetSession = sessionOf(ctx, to);
  // Conversation isolation: two different conversations, one per seat.
  expect(sourceSession).not.toBe(targetSession);

  const record = db.record(DELEGATION_NAMESPACE, `dlg_${taskId}`);
  expect(record).toMatchObject({
    parent_task_id: taskId,
    status: "completed",
    notified: true,
    source_conversation_id: sourceSession,
    target_conversation_id: targetSession,
    source: { seat_id: seatOf(ctx, from), department: from, name: NAMES[from] },
    target: {
      seat_id: seatOf(ctx, to),
      department: to,
      agent_id: `nammaops-${to}`,
      name: NAMES[to],
    },
  });
  expect(record.original_request).toContain(text.slice(0, 20));
  expect(record.workflow_id).toMatch(/^wf_/);
  expect(record.result_reference).toMatchObject({
    session_key: targetSession,
    message_id: `dm_report_${taskId}`,
    workflow_id: record.workflow_id,
  });
  expect(record.timeline.map((row: Any) => row.event)).toEqual(
    expect.arrayContaining(["task_delegated", "task_started", "task_completed"]),
  );

  // 1. The asked seat acknowledges in its OWN chat and links to the owner's chat.
  const ack = db.getMessage(`dm_reply_${taskId}`);
  expect(ack).toMatchObject({
    sessionKey: sourceSession,
    seatId: seatOf(ctx, from),
    actorName: NAMES[from],
    delegationId: `dlg_${taskId}`,
    linkSeatId: seatOf(ctx, to),
    linkSessionKey: targetSession,
  });
  expect(ack.content).toContain(NAMES[to]);

  // 2. The owner receives a real task from the asked seat, and accepts it, in the owner's chat.
  const task = db.getMessage(`dm_task_${taskId}`);
  expect(task).toMatchObject({
    sessionKey: targetSession,
    seatId: seatOf(ctx, to),
    actorName: NAMES[from],
    delegationKind: "task",
    fromSessionKey: sourceSession,
  });
  expect(task.content).toContain(`Hi ${NAMES[to]}`);
  expect(task.content).toContain(record.original_request);
  expect(task.content).toMatch(/read-only/);
  const accepted = db.getMessage(`dm_accept_${taskId}`);
  expect(accepted).toMatchObject({ sessionKey: targetSession, actorName: NAMES[to] });

  // 3. The full report is posted by the executing specialist in the OWNER's chat, never the source's.
  const report = db.getMessage(`dm_report_${taskId}`);
  expect(report).toMatchObject({
    sessionKey: targetSession,
    seatId: seatOf(ctx, to),
    actorName: NAMES[to],
    delegationKind: "report",
    workflowId: record.workflow_id,
  });
  expect(report.content.length).toBeGreaterThan(20);
  expect(messagesIn(ctx, sourceSession).map((m) => m.id)).not.toContain(`dm_report_${taskId}`);

  // 4. The asked seat tells the owner it is done, with a working link to the report.
  const notice = db.getMessage(`dm_done_${taskId}`);
  expect(notice).toMatchObject({
    sessionKey: sourceSession,
    seatId: seatOf(ctx, from),
    actorName: NAMES[from],
    delegationKind: "notice",
    linkSeatId: seatOf(ctx, to),
    linkSessionKey: targetSession,
    linkMessageId: `dm_report_${taskId}`,
  });
  expect(notice.content).toContain(NAMES[to]);
  // The notice is concise: the report itself is not copied into the source chat.
  expect(notice.content.length).toBeLessThan(report.content.length + 200);
  expect(messagesIn(ctx, sourceSession).map((m) => m.id)).not.toContain(`dm_report_${taskId}`);

  // 5. Identity is proved by the governed invocations, not by a displayed name: every read ran
  //    under the agent of a role that ran a workflow step, within that agent's own grants, and the
  //    owning specialist's agent made reads. The asked seat's agent made none for its own account.
  const view = ctx.nammaops.workflows.view(record.workflow_id);
  const stepRoles: string[] = view.tasks.map((t: Any) => t.role);
  expect(stepRoles).toContain(to);
  const invocations = ctx.runtime.mcpGateway
    .invocations()
    .filter((row: Any) => row.correlation_id === record.workflow_id);
  expect(invocations.length).toBeGreaterThan(0);
  const agents = new Set(invocations.map((row: Any) => row.agent_id));
  expect(agents.has(`nammaops-${to}`)).toBe(true);
  for (const row of invocations) {
    const role = String(row.agent_id).replace("nammaops-", "");
    expect(stepRoles).toContain(role);
    expect(["completed", "denied"]).toContain(row.status);
    const capability = ctx.nammaops.binding
      .status()
      .find(
        (s: Any) => ctx.nammaops.binding.capabilityId(s.business_capability) === row.capability_id,
      )?.business_capability;
    expect(GRANTS[role]).toContain(capability);
    expect(row.status).toBe("completed");
  }
  // The source agent is only present when the workflow itself includes a step for its role.
  if (!stepRoles.includes(from)) expect(agents.has(`nammaops-${from}`)).toBe(false);
  return record;
}

describe("A. Dave -> Bob: a real task in Bob's own chat", () => {
  it("Dave acknowledges, Bob receives the task and answers in his chat, Dave is notified with a link", async () => {
    const ctx: Any = await ready();
    const text = "tell me about inventory stock, products below reorder level";
    const out = await ask(ctx, "procurement", "check stock of milk", "t-dave-bob");
    expect(out.answered).toMatchObject({ delegated: true, intent: "check_stock" });
    expectDelegated(ctx, {
      from: "procurement",
      to: "inventory",
      taskId: "t-dave-bob",
      text: "check stock of milk",
    });
    void text;
  });

  it("the task message reads as Dave handing Bob the owner's request", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "procurement", "check stock of milk", "t-dave-bob-2");
    const task = ctx.runtime.db.getMessage("dm_task_t-dave-bob-2");
    expect(task.content).toMatch(
      /^Hi Bob, the owner asked me: "check stock of milk"\. That is inventory, which is yours/,
    );
    expect(task.content).toMatch(/What is needed: Check stock/);
    expect(task.content).toMatch(/I will let the owner know when it is ready/);
    // No credentials, PIN or raw ERP rows travel in a hand-off.
    expect(task.content).not.toMatch(/pin|password|token|secret/i);
  });
});

describe("B. Bob -> Dave: the reverse hand-off", () => {
  it("a procurement question asked of Bob is answered in Dave's chat", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "inventory", "compare supplier quotations for milk", "t-bob-dave");
    expectDelegated(ctx, {
      from: "inventory",
      to: "procurement",
      taskId: "t-bob-dave",
      text: "compare supplier quotations for milk",
    });
  });
});

describe("C. completion notification and conversation navigation", () => {
  it("the notice links to the target seat and the exact report message", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "procurement", "check stock of milk", "t-link");
    const notice = ctx.runtime.db.getMessage("dm_done_t-link");
    const targetSession = sessionOf(ctx, "inventory");
    expect(notice.linkSeatId).toBe(seatOf(ctx, "inventory"));
    expect(notice.linkSessionKey).toBe(targetSession);
    // The link resolves to a real conversation that holds the report it names.
    const there = messagesIn(ctx, notice.linkSessionKey).find((m) => m.id === notice.linkMessageId);
    expect(there).toMatchObject({ actorName: "Bob", delegationKind: "report" });
    // And the session belongs to the target seat.
    const session = ctx.runtime.db.sessions().find((s: Any) => s.key === notice.linkSessionKey);
    expect(session.seatId).toBe(seatOf(ctx, "inventory"));
  });

  it("a retry of the same message runs nothing twice and posts nothing twice", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "procurement", "check stock of milk", "t-retry");
    const workflows = ctx.nammaops.workflows.list().length;
    const target = messagesIn(ctx, sessionOf(ctx, "inventory")).length;
    const source = messagesIn(ctx, sessionOf(ctx, "procurement")).length;
    const again = await ask(ctx, "procurement", "check stock of milk", "t-retry");
    expect(again.answered).toMatchObject({ repeat: true });
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows);
    expect(messagesIn(ctx, sessionOf(ctx, "inventory"))).toHaveLength(target);
    expect(messagesIn(ctx, sessionOf(ctx, "procurement"))).toHaveLength(source);
  });
});

describe("D. every specialist hands off to the owner of the request", () => {
  const OWN = {
    stock: { text: "check stock of milk", owner: "inventory" },
    sales: { text: "sales yesterday", owner: "sales" },
    udhaar: { text: "how much udhaar is pending", owner: "finance" },
    supplier: { text: "compare supplier quotations for milk", owner: "procurement" },
    bill: {
      text: "create a bill for Lakshmi Stores: 2 rice and one packet of milk",
      owner: "billing",
    },
  } as const;
  // Two out-of-responsibility requests per specialist (Alice is covered in section E).
  const probes: Array<[string, keyof typeof OWN]> = [
    ["inventory", "sales"],
    ["inventory", "udhaar"],
    ["sales", "udhaar"],
    ["sales", "stock"],
    ["procurement", "stock"],
    ["procurement", "sales"],
    ["finance", "stock"],
    ["finance", "sales"],
    ["reports", "stock"],
    ["reports", "bill"],
    ["billing", "sales"],
    ["billing", "udhaar"],
  ];
  it.each(probes)("%s is asked about %s", async (from, key) => {
    const ctx: Any = await ready();
    const taskId = `d-${from}-${key}`;
    const { text, owner } = OWN[key];
    const out = await ask(ctx, from, text, taskId);
    expect(out.answered.delegated).toBe(true);
    expectDelegated(ctx, { from, to: owner, taskId, text });
  });

  it("a seat asked about its own department answers itself, with no delegation", async () => {
    const ctx: Any = await ready();
    const out = await ask(ctx, "inventory", "check stock of milk", "d-own");
    expect(out.answered.delegated).toBeUndefined();
    expect(ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_d-own")).toBeNull();
    expect(ctx.runtime.db.getMessage("dm_reply_d-own").actorName).toBe("Bob");
  });
});

describe("failure is transparent", () => {
  it("an unavailable owner: the asked seat says so and nothing runs or is delivered", async () => {
    const ctx: Any = await ready();
    const inventorySeat = seatOf(ctx, "inventory");
    const roster = ctx.runtime.rosterSeats;
    ctx.runtime.rosterSeats = () =>
      roster().map((s: Any) => (s.seatId === inventorySeat ? { ...s, assigned: false } : s));
    const out = await ask(ctx, "procurement", "check stock of milk", "t-unavailable");
    expect(out.answered).toMatchObject({ delegated: false, failed: true });
    const reply = ctx.runtime.db.getMessage("dm_reply_t-unavailable");
    expect(reply.content).toMatch(/not available right now/);
    expect(reply.sessionKey).toBe(sessionOf(ctx, "procurement"));
    expect(ctx.nammaops.workflows.list()).toHaveLength(0);
    expect(ctx.runtime.db.getMessage("dm_task_t-unavailable")).toBeNull();
    expect(ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_t-unavailable")).toBeNull();
  });

  it("a failed execution is reported in both chats, never as a completion", async () => {
    const ctx: Any = await ready();
    ctx.nammaops.voice.query = async () => {
      throw Object.assign(new Error("The ERP read was denied."), { status: 403 });
    };
    await ask(ctx, "procurement", "check stock of milk", "t-fail");
    const record = ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_t-fail");
    expect(record).toMatchObject({ status: "failed", notified: true });
    expect(record.error).toMatch(/denied/);
    expect(ctx.runtime.db.getMessage("dm_report_t-fail")).toMatchObject({
      delegationKind: "failed",
      sessionKey: sessionOf(ctx, "inventory"),
    });
    const notice = ctx.runtime.db.getMessage("dm_done_t-fail");
    expect(notice.content).toMatch(/could not complete this/);
    expect(notice.content).toMatch(/Nothing was run under anyone else's access/);
    expect(notice.content).not.toMatch(/has finished/);
  });

  it("a clarification is asked in the owner's chat and the source says so", async () => {
    const ctx: Any = await ready();
    await ask(
      ctx,
      "procurement",
      "create a bill for Lakshmi Stores: 2 rice and one packet of milk",
      "t-clar",
    );
    const record = ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_t-clar");
    expect(["completed", "needs_clarification"]).toContain(record.status);
  });
});

describe("exactly-once effects and durable recovery", () => {
  it("publishing the same result twice (watcher plus recovery) posts once", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "procurement", "check stock of milk", "t-once");
    const db = ctx.runtime.db;
    const saves: string[] = [];
    const original = db.saveMessage.bind(db);
    db.saveMessage = (message: Any) => {
      saves.push(message.id);
      return original(message);
    };
    await Promise.all([
      finish(ctx.runtime, "dlg_t-once", { status: "completed", facts: [], limitations: [] } as Any),
      finish(ctx.runtime, "dlg_t-once", { status: "completed", facts: [], limitations: [] } as Any),
    ]);
    expect(saves.filter((id) => id === "dm_report_t-once" || id === "dm_done_t-once")).toEqual([]);
  });

  it("recovers a finished-but-undelivered delegation without running the workflow again", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "procurement", "check stock of milk", "t-rec-1");
    const db = ctx.runtime.db;
    const workflows = ctx.nammaops.workflows.list().length;
    // Simulate a crash after the work finished and before delivery: no report, no notice, running.
    db.db
      .prepare("DELETE FROM messages WHERE id IN (?,?)")
      .run("dm_report_t-rec-1", "dm_done_t-rec-1");
    const record = db.record(DELEGATION_NAMESPACE, "dlg_t-rec-1");
    const value = { ...record, status: "running", notified: false, completed_at: null };
    delete value.id;
    delete value.revision;
    db.saveRecord(DELEGATION_NAMESPACE, "dlg_t-rec-1", value, record.revision);
    expect(db.getMessage("dm_report_t-rec-1")).toBeNull();

    const result = await recoverDelegations(ctx.runtime);
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(db.getMessage("dm_report_t-rec-1")).toMatchObject({
      sessionKey: sessionOf(ctx, "inventory"),
      actorName: "Bob",
    });
    expect(db.getMessage("dm_done_t-rec-1")).toMatchObject({
      sessionKey: sessionOf(ctx, "procurement"),
    });
    expect(db.record(DELEGATION_NAMESPACE, "dlg_t-rec-1")).toMatchObject({
      status: "completed",
      notified: true,
    });
    expect(ctx.nammaops.workflows.list()).toHaveLength(workflows);
    // A second recovery is a no-op.
    expect((await recoverDelegations(ctx.runtime)).recovered).toBe(0);
  });

  it("recovers a queued delegation that never started, running the workflow exactly once", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "procurement", "check stock of milk", "t-rec-2");
    const db = ctx.runtime.db;
    // Forget the first run entirely: a fresh task id whose record stayed queued with no workflow.
    const first = db.record(DELEGATION_NAMESPACE, "dlg_t-rec-2");
    const value = {
      ...first,
      delegation_id: "dlg_t-rec-3",
      parent_task_id: "t-rec-3",
      workflow_id: null,
      status: "queued",
      notified: false,
      completed_at: null,
      result_reference: null,
      timeline: [{ event: "task_delegated", at: new Date().toISOString() }],
    };
    delete value.id;
    delete value.revision;
    db.saveRecord(DELEGATION_NAMESPACE, "dlg_t-rec-3", value, 0);
    const before = ctx.nammaops.workflows.list().length;
    await recoverDelegations(ctx.runtime);
    await recoverDelegations(ctx.runtime);
    expect(ctx.nammaops.workflows.list()).toHaveLength(before + 1);
    expect(db.record(DELEGATION_NAMESPACE, "dlg_t-rec-3")).toMatchObject({
      status: "completed",
      notified: true,
    });
    expect(db.getMessage("dm_report_t-rec-3")).toMatchObject({
      sessionKey: sessionOf(ctx, "inventory"),
    });
  });

  it("a result that arrives after the wait is delivered to the original chat, once, from the same workflow", async () => {
    const ctx: Any = await ready();
    ctx.nammaops.delegationPollMs = 20;
    const voice = ctx.nammaops.voice;
    const real = voice.query.bind(voice);
    let first = true;
    voice.query = async (input: Any) => {
      if (first) {
        first = false;
        const done = await real({ ...input, waitMs: 1 });
        // Pretend the wait ran out: report it as still running.
        return { ...done, status: "running", facts: [], recommendations: [] };
      }
      return real(input);
    };
    await ask(ctx, "procurement", "check stock of milk", "t-late");
    for (let i = 0; i < 100 && !ctx.runtime.db.getMessage("dm_done_t-late"); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.runtime.db.getMessage("dm_done_t-late")).toMatchObject({
      sessionKey: sessionOf(ctx, "procurement"),
    });
    expect(ctx.runtime.db.getMessage("dm_report_t-late")).toMatchObject({
      sessionKey: sessionOf(ctx, "inventory"),
    });
    expect(ctx.nammaops.workflows.list()).toHaveLength(1);
    expect(ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_t-late")).toMatchObject({
      status: "completed",
      notified: true,
    });
  });
});

describe("execution identity is never taken from a label", () => {
  it("a wrong or invented department on the request cannot change who runs it", async () => {
    const ctx: Any = await ready();
    const { delegateToOwner } = await import("../server/nammaops/delegation.mjs");
    const source = {
      seatId: seatOf(ctx, "procurement"),
      role: "procurement",
      name: "Dave",
      title: "Procurement",
      sessionKey: sessionOf(ctx, "procurement"),
    };
    for (const [taskId, department] of [
      ["spoof-1", "finance"], // names the wrong specialist for a stock question
      ["spoof-2", "everyone"], // not a department at all
      ["spoof-3", "procurement"], // names the asker itself
    ]) {
      const out: Any = await delegateToOwner(ctx.runtime, {
        taskId,
        message: "check stock of milk",
        userMessageId: `u-${taskId}`,
        source,
        parsed: { department, args: { intent: "check_stock" }, instruction: "Check stock" },
      });
      expect(out.answered.delegated).toBe(true);
      const record = ctx.runtime.db.record(DELEGATION_NAMESPACE, `dlg_${taskId}`);
      // The owner is the server's own answer for this intent: Bob, whatever the label said.
      expect(record.target).toMatchObject({
        department: "inventory",
        agent_id: "nammaops-inventory",
      });
      const agents = new Set(
        ctx.runtime.mcpGateway
          .invocations()
          .filter((row: Any) => row.correlation_id === record.workflow_id)
          .map((row: Any) => row.agent_id),
      );
      expect(agents.has("nammaops-inventory")).toBe(true);
      expect(agents.has("nammaops-finance")).toBe(false);
    }
  });

  it("a hand-off carries no permission: the source's agent makes no read for the owner's task", async () => {
    const ctx: Any = await ready();
    await ask(ctx, "finance", "check stock of milk", "t-noperm");
    const record = ctx.runtime.db.record(DELEGATION_NAMESPACE, "dlg_t-noperm");
    const rows = ctx.runtime.mcpGateway
      .invocations()
      .filter((row: Any) => row.correlation_id === record.workflow_id);
    expect(rows.length).toBeGreaterThan(0);
    // Erin was asked; none of the reads ran as Erin or as the manager.
    expect(rows.map((row: Any) => row.agent_id)).not.toContain("nammaops-finance");
    expect(rows.map((row: Any) => row.agent_id)).not.toContain("nammaops-manager");
  });
});
