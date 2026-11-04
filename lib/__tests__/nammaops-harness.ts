import { afterEach, expect, vi } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaskDatabase } from "../server/task-db.mjs";
import { AgentProfiles } from "../server/agent-profiles.mjs";
import { AgentTasks } from "../server/agent-tasks.mjs";
import { Specializations } from "../server/developer-config.mjs";
import { McpServers } from "../server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  WORKFLOW_PRINCIPALS,
} from "../server/mcp-governance.mjs";
import { createNammaOps } from "../server/nammaops/index.mjs";
import { loadBinding } from "../server/nammaops/erp-binding.mjs";
import { loadWorkforce } from "../server/nammaops/workforce.mjs";
import { handleNammaOpsApi, nammaopsRoute } from "../server/nammaops/api.mjs";
import { ServiceRegistry } from "../server/service-registry.mjs";
import { createFixtureErpServer } from "../mcp/fixture-erpnext-server.mjs";

/** Shared NammaOps test harness: the synthetic TEST FIXTURE ERP over an in-memory MCP transport,
 * real governance, a stub OpenClaw seat owner. Nothing here is live ERPNext or OpenClaw. */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const TODAY = "2026-11-01";
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

export function setup({
  binding = loadBinding(),
  env = {},
  backend,
}: { binding?: Any; env?: Record<string, string>; backend?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nammaops-dash-"));
  const dataPath = join(dir, "data.json");
  copyFileSync("config/nammaops/fixture-data.json", dataPath);
  const db = new TaskDatabase(":memory:") as Any;
  const servers = new McpServers(db, {
    policy: { stdio: [binding.server.connection], http: [], cwd: process.cwd() },
    transportFactory: (() => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      void createFixtureErpServer({ dataPath, statePath: join(dir, "state.json") }).connect(server);
      return client;
    }) as Any,
  });
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => db.close(),
    () => servers.close(),
  );
  // OpenClaw is a stub seat owner, as in nammaops.test.ts; dashboards never submit tasks.
  const owner: Any = {
    gatewayId: "gw",
    gateway: { provider: "openclaw", status: "connected" },
    db,
    resolve: (seatId: string) => ({
      seat: { seatId, binding: { revision: 1 } },
      agentId: "backend",
      sessionKey: `agent:backend:${seatId}`,
    }),
    submit: vi.fn(),
  };
  const runtime: Any = {
    db,
    gateway: owner.gateway,
    seatOwner: () => owner,
    taskOwner: () => owner,
    estop: { status: () => ({ engaged: false }) },
    rosterSeats: () =>
      ["a", "b", "c", "d", "e", "f", "g"].map((seatId) => ({
        seatId,
        assigned: true,
        binding: { available: true, ...(backend ? { agentId: backend } : {}) },
      })),
  };
  runtime.profiles = new AgentProfiles(runtime);
  runtime.agentTasks = new AgentTasks(runtime, { profiles: runtime.profiles });
  runtime.specializations = new Specializations(runtime, { profiles: runtime.profiles });
  runtime.mcpServers = servers;
  runtime.capabilities = new CapabilityRegistry(db, servers);
  runtime.governance = new Governance(db, runtime.capabilities, {
    identity: (agentId: string) => {
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
  runtime.services = new ServiceRegistry({
    erp: () => ({ shape: binding.shape, serverId: binding.server.server_id, stdioAllowed: true }),
  });
  runtime.nammaops = createNammaOps(
    runtime,
    { NAMMAOPS_OWNER_PIN: "4826", ...env },
    {
      binding,
      workforce: loadWorkforce(),
      today: () => TODAY,
      now: () => new Date("2026-11-01T10:00:00Z"),
    },
  );
  return {
    runtime,
    nammaops: runtime.nammaops,
    data: JSON.parse(readFileSync(dataPath, "utf8")),
    dataPath,
    /** Change the fixture's data between steps to simulate ERP changes. */
    editData: (edit: (data: Any) => void) => {
      const data = JSON.parse(readFileSync(dataPath, "utf8"));
      edit(data);
      writeFileSync(dataPath, JSON.stringify(data));
    },
  };
}

export async function ready(options: Any = {}) {
  const ctx = setup(options);
  const report = await ctx.nammaops.setup({});
  expect(report.blockers).toEqual([]);
  return ctx;
}

export async function get(ctx: Any, path: string) {
  const req: Any = Readable.from([]);
  Object.assign(req, {
    method: "GET",
    url: path,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  });
  try {
    const result: Any = await handleNammaOpsApi(
      ctx.runtime,
      req,
      nammaopsRoute(path.split("?")[0]) as Any,
    );
    return { status: result.status, body: result.body };
  } catch (error: Any) {
    return { status: error.status, body: { error: error.message } };
  }
}
