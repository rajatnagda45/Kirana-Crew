#!/usr/bin/env node
/**
 * NammaOps Phase D demonstration over a real MCP stdio connection to the ERPNext-shaped TEST
 * FIXTURE. It configures the five-agent workforce, then runs the three workflows, including an
 * ERP data change, owner rejection versus approval, and a duplicate approval attempt.
 *
 * What this shows: governed ERP tool calls per agent, deterministic results, owner approval and
 * audit, against a live MCP process. What it does not show: real ERPNext data (the fixture is
 * synthetic) or OpenClaw (agent identities come from local stub seats; reasoning is off).
 *
 *   node --import tsx scripts/nammaops-demo.mjs
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../lib/server/task-db.mjs";
import { AgentProfiles } from "../lib/server/agent-profiles.mjs";
import { AgentTasks } from "../lib/server/agent-tasks.mjs";
import { Specializations } from "../lib/server/developer-config.mjs";
import { McpServers } from "../lib/server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  WORKFLOW_PRINCIPALS,
} from "../lib/server/mcp-governance.mjs";
import { createNammaOps } from "../lib/server/nammaops/index.mjs";
import { loadBinding } from "../lib/server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../lib/server/nammaops/workforce.mjs";

const PIN = "4826";
const dir = mkdtempSync(join(tmpdir(), "nammaops-demo-"));
const dataPath = join(dir, "fixture-data.json");
const statePath = join(dir, "fixture-po-state.json");
copyFileSync("config/nammaops/fixture-data.json", dataPath);

const binding = loadBinding();
binding.server.connection.args = [
  "lib/mcp/fixture-erpnext-server.mjs",
  "--data",
  dataPath,
  "--state",
  statePath,
];
const db = new TaskDatabase(":memory:");
const servers = new McpServers(db, {
  policy: { stdio: [binding.server.connection], http: [], cwd: process.cwd() },
});
// Stand-in seats: OpenClaw is not used in this demo (reasoning off), only agent identities.
const owner = {
  gatewayId: "demo",
  gateway: { provider: "openclaw", status: "connected" },
  db,
  resolve: (seatId) => ({
    seat: { seatId, binding: { revision: 1 } },
    agentId: "demo",
    sessionKey: `agent:demo:${seatId}`,
  }),
  submit: () => {
    throw new Error("No OpenClaw in this demo.");
  },
};
const runtime = {
  db,
  gateway: owner.gateway,
  seatOwner: () => owner,
  taskOwner: () => owner,
  estop: { status: () => ({ engaged: false }) },
  rosterSeats: () =>
    ["desk-1", "desk-2", "desk-3", "desk-4", "desk-5"].map((seatId) => ({
      seatId,
      assigned: true,
      binding: { available: true },
    })),
};
runtime.profiles = new AgentProfiles(runtime);
runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
runtime.mcpServers = servers;
runtime.capabilities = new CapabilityRegistry(db, servers);
runtime.governance = new Governance(db, runtime.capabilities, {
  identity: (agentId) => {
    if (WORKFLOW_PRINCIPALS.has(agentId)) return { agentId, specializationId: null };
    const profile = runtime.profiles.get(agentId);
    return profile ? { agentId, specializationId: profile.specialization_id ?? null } : null;
  },
});
runtime.mcpGateway = new ToolGateway({
  db,
  servers,
  registry: runtime.capabilities,
  governance: runtime.governance,
});
const nammaops = createNammaOps(
  runtime,
  { NAMMAOPS_OWNER_PIN: PIN, NAMMAOPS_REASONING: "off" },
  { binding, workforce: loadWorkforce(), today: () => "2026-11-01" },
);

const show = (title, value) =>
  console.log(
    `\n== ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`,
  );
const run = async (text) => (await nammaops.workflows.start({ text })).done;
const agentsAt = (view) =>
  view.tasks.map(
    (task) =>
      `${task.agent_name}: ${task.title} -> ${task.status} (${task.evidence.length} ERP call(s))`,
  );

try {
  const setup = await nammaops.setup({});
  show("Milestone 1: five configured agents", {
    discovered_tools: setup.discovery.added.length,
    agents: setup.agents.map((agent) => ({
      agent: agent.name,
      seat: agent.seat_id,
      permitted_tools: agent.granted.length,
    })),
    principals: setup.principals,
    blockers: setup.blockers,
  });

  const w1 = await run(
    "Check the stock of milk, rice and cooking oil. Tell me what we need to buy tomorrow.",
  );
  show("Workflow 1: stock intelligence", w1.summary);
  console.table(
    w1.result.rows.map((row) => ({
      product: row.item_name,
      stock: row.available,
      reorder_level: row.reorder_level,
      result: row.status === "low" ? `buy ${row.recommended_qty}` : row.status,
    })),
  );
  show("Workflow 1: agents", agentsAt(w1));

  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  data.bins.find((bin) => bin.item_code === "MILK-500").actual_qty = 90;
  writeFileSync(dataPath, JSON.stringify(data));
  const w1b = await run("Check the stock of milk.");
  show("Workflow 1 after changing milk stock in the ERP data", w1b.summary);

  data.bins.find((bin) => bin.item_code === "MILK-500").actual_qty = 18;
  writeFileSync(dataPath, JSON.stringify(data));
  show("Clarification", (await run("Check the stock of oil.")).summary);

  const w2 = await run(
    "Prepare an order for the products that are running low. Choose the cheapest suitable supplier.",
  );
  show("Workflow 2: reorder", w2.summary);
  show(
    "Workflow 2: supplier choice",
    w2.result.rankings.map((row) => ({
      item: row.item_code,
      qty: row.qty,
      chosen: row.choice?.supplier,
      rate: row.choice?.rate,
      considered: row.considered.map(
        (q) =>
          `${q.supplier}@${q.rate}${q.suitable ? "" : ` (${q.not_suitable_because.join(", ")})`}`,
      ),
    })),
  );
  const [first, second] = w2.result.approvals;
  try {
    await nammaops.approvals.approve(first, "0000");
  } catch (error) {
    show("Wrong PIN", error.message);
  }
  show("Owner rejects the first order", nammaops.approvals.reject(first, PIN).status);
  if (second) {
    const approved = await nammaops.approvals.approve(second, PIN);
    show("Owner approves the second order", {
      status: approved.status,
      po: approved.erp_document_name,
      total: approved.total,
    });
    try {
      await nammaops.approvals.approve(second, PIN);
    } catch (error) {
      show("Duplicate approval", error.message);
    }
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  show(
    "Purchase orders in the ERP fixture",
    state.purchase_orders.map((po) => ({
      name: po.name,
      supplier: po.supplier,
      docstatus: po.docstatus,
      total: po.grand_total,
    })),
  );
  show("Workflow 2 final", nammaops.workflows.view(w2.id).status);

  const w3 = await run(
    "Tell me how much business I did today, what sold the most and how much profit I made.",
  );
  show("Workflow 3: daily report", w3.summary);
  show("Workflow 3: agents", agentsAt(w3));

  const audit = runtime.mcpGateway.invocations();
  show("Audit", {
    governed_calls: audit.length,
    denied: audit.filter((row) => row.status === "denied").length,
    by_agent: Object.fromEntries(
      [...new Set(audit.map((row) => row.agent_id))].map((agent) => [
        agent,
        audit.filter((row) => row.agent_id === agent).length,
      ]),
    ),
  });
} finally {
  await servers.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
