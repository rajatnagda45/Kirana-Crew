#!/usr/bin/env node
/**
 * Phase C demonstration, scenarios A-F, through the real governance code and a real MCP
 * connection over stdio to the local fixture server (lib/mcp/fixture-stock-server.mjs).
 *
 * What this shows: discovery, review, assignment, grants, approvals, revocation and audit against
 * a live MCP process. What it does not show: OpenClaw calling the tools. The agent identity here is
 * a local stand-in for a Phase A profile, and the fixture's stock data is synthetic.
 *
 *   node --import tsx scripts/phase-c-demo.mjs
 */
import { TaskDatabase } from "../lib/server/task-db.mjs";
import { McpServers } from "../lib/server/mcp-servers.mjs";
import { CapabilityRegistry, Governance, ToolGateway } from "../lib/server/mcp-governance.mjs";
import { DEVELOPER_ACTOR } from "../lib/server/developer-config.mjs";

const STDIO = { command: "node", args: ["lib/mcp/fixture-stock-server.mjs"] };
const db = new TaskDatabase(":memory:");
const servers = new McpServers(db, { policy: { stdio: [STDIO], http: [], cwd: process.cwd() } });
const registry = new CapabilityRegistry(db, servers);
const agents = {
  "inventory-analyst-01": { agentId: "inventory-analyst-01", specializationId: null },
};
const governance = new Governance(db, registry, { identity: (id) => agents[id] ?? null });
const gateway = new ToolGateway({ db, servers, registry, governance });
const agentId = "inventory-analyst-01";
const cap = (tool) => `mcp.stock-fixture.${tool}`;
const show = (title, value) => console.log(`\n== ${title}\n${JSON.stringify(value, null, 2)}`);
const brief = (row) => ({
  status: row.status,
  decision: row.decision,
  error: row.error,
  approval_request_id: row.approval_request_id,
  result: row.result?.structuredContent,
});

try {
  // A. Discovery
  servers.register({
    server_id: "stock-fixture",
    name: "Stock fixture (test)",
    transport: "stdio",
    connection: STDIO,
  });
  await servers.client("stock-fixture");
  show("A. discovery", await registry.discover("stock-fixture"));
  show(
    "A. discovered tools (server hints only)",
    registry.list().map(({ capability_id, state, suggested_risk, input_schema }) => ({
      capability_id,
      state,
      suggested_risk,
      required: input_schema.required,
    })),
  );
  for (const [tool, risk] of [
    ["get_stock_balance", "READ"],
    ["get_stock_ledger", "READ"],
    ["update_stock_quantity", "WRITE"],
    ["delete_stock_record", "DESTRUCTIVE"],
  ])
    registry.review(cap(tool), { risk }, DEVELOPER_ACTOR);
  show(
    "A. registered capabilities (developer-reviewed risk)",
    registry.list().map(({ capability_id, state, risk, approval_required }) => ({
      capability_id,
      state,
      risk,
      approval_required,
    })),
  );

  // B. Read-only execution
  governance.assign(
    `agent:${agentId}`,
    [cap("get_stock_balance"), cap("get_stock_ledger"), cap("update_stock_quantity")],
    DEVELOPER_ACTOR,
  );
  governance.grant(
    { subject: `agent:${agentId}`, capability_id: cap("get_stock_balance") },
    DEVELOPER_ACTOR,
  );
  governance.grant(
    { subject: `agent:${agentId}`, capability_id: cap("get_stock_ledger") },
    DEVELOPER_ACTOR,
  );
  const read = await gateway.invoke({
    agentId,
    capabilityId: cap("get_stock_balance"),
    arguments: { sku: "SKU-17", warehouse: "BIN-A" },
    taskId: "demo-task-b",
  });
  show("B. read through the gateway", brief(read));

  // C. Unauthorized write: discovered, registered and assigned, but not granted.
  show(
    "C. write without a grant",
    brief(
      await gateway.invoke({
        agentId,
        capabilityId: cap("update_stock_quantity"),
        arguments: { sku: "SKU-17", warehouse: "BIN-A", quantity: 10 },
        taskId: "demo-task-c",
      }),
    ),
  );

  // D. Approval-required write
  const writeGrant = governance.grant(
    { subject: `agent:${agentId}`, capability_id: cap("update_stock_quantity") },
    DEVELOPER_ACTOR,
  );
  const args = { sku: "SKU-17", warehouse: "BIN-A", quantity: 10 };
  const pending = await gateway.invoke({
    agentId,
    capabilityId: cap("update_stock_quantity"),
    arguments: args,
    taskId: "demo-task-d",
  });
  show("D. write with a grant: approval requested", brief(pending));
  show(
    "D. approval request",
    governance.approvals().find((row) => row.request_id === pending.approval_request_id),
  );
  governance.decideApproval(pending.approval_request_id, "approved", DEVELOPER_ACTOR);
  show(
    "D. a different quantity is not covered by the approval",
    brief(
      await gateway.invoke({
        agentId,
        capabilityId: cap("update_stock_quantity"),
        arguments: { ...args, quantity: 999 },
        approvalId: pending.approval_request_id,
      }),
    ),
  );
  show(
    "D. the identical call runs once",
    brief(
      await gateway.invoke({
        agentId,
        capabilityId: cap("update_stock_quantity"),
        arguments: args,
        taskId: "demo-task-d",
      }),
    ),
  );
  show(
    "D. replaying the used approval",
    brief(
      await gateway.invoke({
        agentId,
        capabilityId: cap("update_stock_quantity"),
        arguments: args,
        approvalId: pending.approval_request_id,
      }),
    ),
  );

  // E. Revocation
  governance.revoke(writeGrant.grant_id, DEVELOPER_ACTOR);
  show(
    "E. same write after revocation",
    brief(
      await gateway.invoke({
        agentId,
        capabilityId: cap("update_stock_quantity"),
        arguments: args,
      }),
    ),
  );

  // F. Unavailable
  await servers.update("stock-fixture", { enabled: false });
  show(
    "F. read with the server disabled",
    brief(
      await gateway.invoke({
        agentId,
        capabilityId: cap("get_stock_balance"),
        arguments: { sku: "SKU-17", warehouse: "BIN-A" },
      }),
    ),
  );

  show(
    "Audit trail",
    gateway.invocations().map(({ task_id, capability_id, decision, status, error }) => ({
      task_id,
      capability_id,
      decision,
      status,
      error,
    })),
  );
} finally {
  await servers.close();
  db.close();
}
