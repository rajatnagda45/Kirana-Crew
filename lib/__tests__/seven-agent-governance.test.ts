import { describe, expect, it } from "vitest";
import { answerDirect } from "../server/nammaops/direct-chat.mjs";
import { OfficeGroupChat, OFFICE_GROUP_SESSION } from "../server/office-group-chat.mjs";
import { evidenceLines, routingLine } from "../server/nammaops/group-business.mjs";
import { ready } from "./nammaops-harness";

// Synthetic TEST FIXTURE only (fixture ERP, in-memory governance). Nothing here is live ERPNext.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SESSION = "agent:main:seven-agent-governance";

/** The seven specialists: seat voice name, department, agent id. */
const AGENTS = [
  { name: "Alice", department: "manager", agent: "nammaops-manager" },
  { name: "Bob", department: "inventory", agent: "nammaops-inventory" },
  { name: "Carol", department: "sales", agent: "nammaops-sales" },
  { name: "Dave", department: "procurement", agent: "nammaops-procurement" },
  { name: "Erin", department: "finance", agent: "nammaops-finance" },
  { name: "Grace", department: "reports", agent: "nammaops-reports" },
  { name: "Frank", department: "billing", agent: "nammaops-billing" },
] as const;
type Role = (typeof AGENTS)[number]["department"];

/**
 * The reads each specialist may use (business capabilities). This is the matrix the audit found:
 * it pins the CURRENT grants; a change to any row is a deliberate governance decision. The
 * finance-domain reads held by Carol, Dave and Frank are listed in the open items of the audit.
 */
const GRANTS: Record<Role, string[]> = {
  manager: [],
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
    "erp.po.create_draft",
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

const WRITES = new Set([
  "erp.po.create_draft",
  "erp.po.submit",
  "erp.sales_invoice.create_draft",
  "erp.sales_invoice.submit",
]);

/** A request each department owns, in words the keyword reader understands. */
const OWN: Record<string, { text: string; owner: Role }> = {
  stock: { text: "check stock of milk", owner: "inventory" },
  sales: { text: "sales yesterday", owner: "sales" },
  udhaar: { text: "how much udhaar is pending", owner: "finance" },
  supplier: { text: "compare supplier quotations for milk", owner: "procurement" },
  bill: {
    text: "create a bill for Lakshmi Stores: 2 rice and one packet of milk",
    owner: "billing",
  },
};

const seatOf = (ctx: Any, agent: string) =>
  ctx.runtime.profiles.list().find((p: Any) => p.agent_id === agent).seat_id;

const ask = async (ctx: Any, agent: string, text: string, taskId: string) => {
  const out: Any = await answerDirect(ctx.runtime, {
    taskId,
    message: text,
    seatId: seatOf(ctx, agent),
    sessionKey: SESSION,
  });
  return { out, reply: ctx.runtime.db.getMessage(`dm_reply_${taskId}`) };
};

describe("MCP identity and grants: exactly the matrix, enforced by the gateway", () => {
  it.each(AGENTS)("$name ($department) holds exactly its own capabilities", async (agent) => {
    const ctx: Any = await ready();
    const bound = ctx.nammaops.binding
      .status()
      .filter((row: Any) => row.tool !== null)
      .map((row: Any) => row.business_capability as string);
    const allowed: string[] = [];
    for (const capability of bound) {
      const out: Any = await ctx.runtime.mcpGateway.invoke({
        agentId: agent.agent,
        capabilityId: ctx.nammaops.binding.capabilityId(capability),
        arguments: {},
      });
      if (out.status !== "denied") allowed.push(capability);
    }
    const expected = GRANTS[agent.department].filter((capability) => bound.includes(capability));
    expect(allowed.sort()).toEqual(expected.sort());
  });

  it("only the two server principals can submit; no specialist can", async () => {
    const ctx: Any = await ready();
    for (const agent of AGENTS)
      for (const capability of ["erp.po.submit", "erp.sales_invoice.submit"]) {
        const id = ctx.nammaops.binding.capabilityId(capability);
        if (!id) continue;
        const out: Any = await ctx.runtime.mcpGateway.invoke({
          agentId: agent.agent,
          capabilityId: id,
          arguments: {},
        });
        expect(out.status).toBe("denied");
      }
  });

  it("Alice holds no ERP capability, Grace no write, Frank no purchase-order capability", () => {
    expect(GRANTS.manager).toEqual([]);
    expect(GRANTS.reports.filter((capability) => WRITES.has(capability))).toEqual([]);
    expect(GRANTS.billing.filter((capability) => capability.startsWith("erp.po."))).toEqual([]);
  });

  it("an unknown agent identity is denied", async () => {
    const ctx: Any = await ready();
    const out: Any = await ctx.runtime.mcpGateway.invoke({
      agentId: "nammaops-everything",
      capabilityId: ctx.nammaops.binding.capabilityId("erp.items.list"),
      arguments: {},
    });
    expect(out.status).toBe("denied");
  });
});

describe("responsibility: each agent answers what it owns, as itself", () => {
  const own: Array<[string, string, keyof typeof OWN]> = [
    ["nammaops-inventory", "Bob", "stock"],
    ["nammaops-sales", "Carol", "sales"],
    ["nammaops-finance", "Erin", "udhaar"],
    ["nammaops-procurement", "Dave", "supplier"],
    ["nammaops-billing", "Frank", "bill"],
  ];
  it.each(own)("%s answers its own request as %s with no hand-off", async (agent, name, key) => {
    const ctx: Any = await ready();
    const { reply } = await ask(ctx, agent, OWN[key].text, `own-${key}`);
    expect(reply.actorName).toBe(name);
    expect(reply.content).not.toMatch(/passed this to/);
  });
});

describe("out of responsibility: routed to the owner, never answered with borrowed grants", () => {
  // Two requests per agent that belong to another department.
  const cases: Array<[string, string, keyof typeof OWN, keyof typeof OWN]> = [
    ["nammaops-manager", "Alice", "stock", "sales"],
    ["nammaops-inventory", "Bob", "sales", "udhaar"],
    ["nammaops-sales", "Carol", "udhaar", "stock"],
    ["nammaops-procurement", "Dave", "stock", "sales"],
    ["nammaops-finance", "Erin", "stock", "sales"],
    ["nammaops-reports", "Grace", "stock", "bill"],
    ["nammaops-billing", "Frank", "sales", "udhaar"],
  ];
  const probes = cases.flatMap(([agent, name, a, b]) => [
    [agent, name, a] as const,
    [agent, name, b] as const,
  ]);
  it.each(probes)("asking %s (%s) about %s", async (agent, askerName, key) => {
    const ctx: Any = await ready();
    const taskId = `oor-${agent}-${key}`;
    const { out } = await ask(ctx, agent, OWN[key].text, taskId);
    const owner = AGENTS.find((a) => a.department === OWN[key].owner)!;
    const askedRole = AGENTS.find((a) => a.name === askerName)!.department;
    if (askedRole === "manager") {
      // Alice coordinates: the task goes to the owner's own chat, run under the owner's agent.
      expect(out.answered.coordinationId).toBeTruthy();
      const db = ctx.runtime.db;
      const record = db.record("nammaops.dm_delegation", `dlg_${taskId}_0`);
      expect(record.target.agent_id).toBe(owner.agent);
      expect(record.source_conversation_id).not.toBe(record.target_conversation_id);
      expect(db.getMessage(`dm_report_${taskId}_0`).actorName).toBe(owner.name);
      expect(db.getMessage(`dm_synthesis_${taskId}`).content).toContain(owner.name);
      const agents = ctx.runtime.mcpGateway
        .invocations()
        .filter((row: Any) => row.correlation_id === record.workflow_id)
        .map((row: Any) => row.agent_id);
      expect(agents).toContain(owner.agent);
      expect(agents).not.toContain("nammaops-manager");
      return;
    }
    // The request is delegated: acknowledged by the asked seat, executed and reported by the owner.
    expect(out.answered.delegated).toBe(true);
    const db = ctx.runtime.db;
    const record = db.record("nammaops.dm_delegation", `dlg_${taskId}`);
    expect(record.target.agent_id).toBe(owner.agent);
    expect(record.source_conversation_id).not.toBe(record.target_conversation_id);
    expect(db.getMessage(`dm_report_${taskId}`)).toMatchObject({
      actorName: owner.name,
      sessionKey: record.target_conversation_id,
    });
    expect(db.getMessage(`dm_reply_${taskId}`).content).toContain(owner.name);
    // Executed under the owner's identity: each governed read is by the agent of a role that ran a
    // step and is inside THAT role's own grants; the asked seat's agent only appears for its own step.
    const view = ctx.nammaops.workflows.view(record.workflow_id);
    const roles = view.tasks.map((t: Any) => t.role);
    expect(roles).toContain(owner.department);
    for (const task of view.tasks)
      for (const row of task.evidence)
        expect(GRANTS[task.role as Role]).toContain(row.business_capability);
    const agents = new Set(
      ctx.runtime.mcpGateway
        .invocations()
        .filter((row: Any) => row.correlation_id === record.workflow_id)
        .map((row: Any) => row.agent_id),
    );
    expect(agents.has(owner.agent)).toBe(true);
    if (!roles.includes(askedRole)) expect(agents.has(`nammaops-${askedRole}`)).toBe(false);
  });
});

describe("manager orchestration and cross-department delegation", () => {
  it("a profit question spans Sales and Finance and is posted by the coordinating manager", async () => {
    const ctx: Any = await ready();
    const { out, reply } = await ask(ctx, "nammaops-sales", "what is the profit today", "xdept-1");
    const view = ctx.nammaops.workflows.view(out.answered.workflowId);
    const roles: string[] = view.tasks.map((t: Any) => t.role);
    expect(roles).toEqual(expect.arrayContaining(["sales", "finance"]));
    expect(reply.actorName).toBe("Alice (coordinating)");
    expect(reply.content).toMatch(/^Carol brought in/);
    // The manager holds no ERP grant and read nothing.
    for (const task of view.tasks.filter((t: Any) => t.role === "manager"))
      expect(task.evidence).toEqual([]);
  });

  it("Alice asked directly coordinates; the ERP reads are the specialists' own", async () => {
    const ctx: Any = await ready();
    const { out, reply } = await ask(
      ctx,
      "nammaops-manager",
      "what is the profit today",
      "xdept-2",
    );
    const view = ctx.nammaops.workflows.view(out.answered.workflowId);
    expect(reply.content).toMatch(/^Alice coordinated this with/);
    const readers = new Set(
      view.tasks.filter((t: Any) => t.evidence.length).map((t: Any) => t.role),
    );
    expect(readers.has("manager")).toBe(false);
    expect([...readers].length).toBeGreaterThan(1);
  });
});

describe("attribution and evidence provenance", () => {
  it("routing names exactly the roles that ran, and evidence lines name the same specialists", async () => {
    const ctx: Any = await ready();
    const res: Any = await ctx.nammaops.voice.query({
      call: { id: "prov-1", name: "Dave" },
      actionId: "p1",
      args: { intent: "check_stock" },
    });
    // The manager's step reads nothing and is never an executor.
    const ranRoles = res.evidence
      .map((row: Any) => row.department)
      .filter((department: string) => department !== "manager");
    expect(res.routing.executed_by.map((row: Any) => row.department).sort()).toEqual(
      [...new Set(ranRoles)].sort(),
    );
    expect(res.routing).toMatchObject({
      asked_of: { name: "Dave", department: "procurement" },
      speaker: { name: "Bob", department: "inventory", coordinating: false },
      handed_off: true,
    });
    const lines = evidenceLines(res);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^(Bob|Dave) \(/);
    expect(routingLine(res.routing)).toMatch(/^Dave passed this to Bob \(Inventory\)\./);
  });

  it("no hand-off line when the asked seat ran it itself", async () => {
    const ctx: Any = await ready();
    const res: Any = await ctx.nammaops.voice.query({
      call: { id: "prov-2", name: "Carol" },
      actionId: "p2",
      args: { intent: "sales_summary", day: "yesterday" },
    });
    expect(res.routing.handed_off).toBe(false);
    expect(routingLine(res.routing)).toBe("");
  });
});

describe("alternate interfaces cannot bypass the restrictions", () => {
  it("the workflows API runs any action under that workflow's fixed roles, never a chosen one", async () => {
    const ctx: Any = await ready();
    const started = ctx.nammaops.workflows.start({
      intent: { action: "stock_check", products: ["milk"] },
    });
    const view = await started.done;
    for (const task of view.tasks)
      for (const row of task.evidence)
        expect(GRANTS[task.role as Role]).toContain(row.business_capability);
  });

  it("a voice tool call carrying a PIN or an unknown field is refused", async () => {
    const ctx: Any = await ready();
    for (const args of [
      { intent: "sales_summary", pin: "1234" },
      { intent: "sales_summary", agent_id: "nammaops-finance" },
      { intent: "sales_summary", capability: "erp.po.submit" },
    ])
      await expect(
        ctx.nammaops.voice.query({ call: { id: "bypass-1", name: "Bob" }, actionId: "b1", args }),
      ).rejects.toMatchObject({ status: 400 });
  });

  it("an unknown seat name is not a department and gets nothing", async () => {
    const ctx: Any = await ready();
    await expect(
      ctx.nammaops.voice.query({
        call: { id: "bypass-2", name: "Rahul" },
        actionId: "b2",
        args: { intent: "sales_summary" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a Live-style call from Bob for a sales question runs Carol's role, not Bob's grants", async () => {
    const ctx: Any = await ready();
    const res: Any = await ctx.nammaops.voice.query({
      call: { id: "bypass-3", name: "Bob" },
      actionId: "b3",
      args: { intent: "sales_summary", day: "yesterday" },
    });
    expect(res.routing.speaker).toMatchObject({ name: "Carol" });
    for (const row of res.evidence) expect(row.department).not.toBe("inventory");
  });
});

describe("office group chat posts as the specialist who ran it", () => {
  it("Dave asked about stock: Bob's name, with the hand-off line", async () => {
    const ctx: Any = await ready();
    ctx.runtime.estop = { status: () => ({ engaged: false }), assertClear: () => {} };
    // The seven bound seats, labelled with their NammaOps voice names.
    ctx.runtime.rosterSeats = () =>
      AGENTS.map((agent) => ({
        seatId: `grp-${agent.department}`,
        label: agent.name,
        assigned: true,
        binding: { agentId: agent.agent, available: true },
      }));
    const baseOwner = ctx.runtime.seatOwner();
    ctx.runtime.seatOwner = () => ({
      ...baseOwner,
      db: ctx.runtime.db,
      seatView: (seat: Any) => ({ ...seat, binding: { ...seat.binding, available: true } }),
    });
    const group = new OfficeGroupChat(ctx.runtime);
    group.send({ turnId: "g1", message: "Dave check stock of milk" });
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (ctx.runtime.db.getMessage("group_bridge_grp_g1_business")) break;
    }
    const posted = ctx.runtime.db
      .messages?.(OFFICE_GROUP_SESSION)
      ?.filter((m: Any) => m.role === "assistant" && /Dave passed this to Bob/.test(m.content));
    expect(posted?.length ?? 0).toBeGreaterThan(0);
    expect(posted[0].actorName).toBe("Bob");
  });
});

describe("multi-agent coordination hands the specialists what the owner said", () => {
  it('"do not order" never becomes a draft purchase order, and a named day reaches them', async () => {
    const ctx: Any = await ready();
    const group: Any = new OfficeGroupChat(ctx.runtime);
    const noOrder = group.buildVoiceArgs(
      "procurement",
      "prepare_purchase_order",
      { noBuyConstraint: true, timeContext: "yesterday", dependencies: [] },
      [],
    );
    expect(noOrder).toEqual({ intent: "demand_forecast", day: "yesterday" });
    const order = group.buildVoiceArgs(
      "procurement",
      "prepare_purchase_order",
      { noBuyConstraint: false, timeContext: "today", dependencies: [] },
      [],
    );
    expect(order).toEqual({ intent: "prepare_purchase_order" });
  });
});
