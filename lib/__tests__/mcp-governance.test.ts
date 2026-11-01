import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TaskDatabase } from "../server/task-db.mjs";
import {
  McpServers,
  defaultTransportFactory,
  validateServerConfig,
} from "../server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  DECISIONS,
  fingerprint,
  redact,
} from "../server/mcp-governance.mjs";
import { DEVELOPER_ACTOR } from "../server/developer-config.mjs";
import { handleMcpApi, mcpRoute } from "../server/mcp-api.mjs";
import { createFixtureStockServer, FIXTURE_TOOLS } from "../mcp/fixture-stock-server.mjs";
import { createGovernedProxy } from "../mcp/governed-tools-mcp.mjs";

// Everything here talks to local fixture MCP servers (in-memory, a stdio child process, or a
// loopback HTTP server). None of it is evidence about a real production MCP server or OpenClaw.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const STDIO = { command: "node", args: ["lib/mcp/fixture-stock-server.mjs"] };
const policy = { stdio: [STDIO], http: [], cwd: process.cwd() };

/** A transport factory that links each connection to a fresh in-memory MCP server. */
function inMemory(make: () => Server = createFixtureStockServer) {
  const servers: Server[] = [];
  // Accepts and ignores the (config, context) arguments McpServers passes to a factory.
  const factory = vi.fn<(...context: Any[]) => Any>(() => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = make();
    servers.push(server);
    void server.connect(serverSide);
    return clientSide;
  });
  return { factory, servers };
}

function setup({
  factory = inMemory().factory,
  agents = { analyst: { agentId: "analyst" } } as Any,
} = {}) {
  const db = new TaskDatabase(":memory:") as Any;
  const servers = new McpServers(db, { policy, transportFactory: factory });
  // Reverse order on cleanup: connections close before their storage does.
  cleanup.push(
    () => db.close(),
    () => servers.close(),
  );
  const registry = new CapabilityRegistry(db, servers);
  const governance = new Governance(db, registry, { identity: (id: string) => agents[id] ?? null });
  const gateway = new ToolGateway({ db, servers, registry, governance });
  return { db, servers, registry, governance, gateway } as Any;
}

const register = (servers: Any, id = "stock", extra: Any = {}) =>
  servers.register({
    server_id: id,
    name: "Stock fixture",
    transport: "stdio",
    connection: STDIO,
    ...extra,
  });

const cap = (tool: string, server = "stock") => `mcp.${server}.${tool}`;

/** Registers, discovers, reviews and optionally assigns and grants the fixture tools. */
async function ready(ctx: Any, { grant = [] as string[], assign = [] as string[] } = {}) {
  register(ctx.servers);
  await ctx.registry.discover("stock");
  ctx.registry.review(cap("get_stock_balance"), { risk: "READ" }, DEVELOPER_ACTOR);
  ctx.registry.review(cap("get_stock_ledger"), { risk: "READ" }, DEVELOPER_ACTOR);
  ctx.registry.review(cap("update_stock_quantity"), { risk: "WRITE" }, DEVELOPER_ACTOR);
  ctx.registry.review(cap("delete_stock_record"), { risk: "DESTRUCTIVE" }, DEVELOPER_ACTOR);
  if (assign.length)
    ctx.governance.assign(
      "agent:analyst",
      assign.map((tool) => cap(tool)),
      DEVELOPER_ACTOR,
    );
  const grants: Any = {};
  for (const tool of grant)
    grants[tool] = ctx.governance.grant(
      { subject: "agent:analyst", capability_id: cap(tool) },
      DEVELOPER_ACTOR,
    );
  return grants;
}

const call = (ctx: Any, tool: string, args: Any, extra: Any = {}) =>
  ctx.gateway.invoke({ agentId: "analyst", capabilityId: cap(tool), arguments: args, ...extra });

describe("connection management", () => {
  it("1. connects to the real stdio fixture process and lists its tools", async () => {
    const ctx = setup({ factory: defaultTransportFactory as Any });
    register(ctx.servers);
    const summary = await ctx.registry.discover("stock");
    expect(summary.added.sort()).toEqual(FIXTURE_TOOLS.map((tool) => cap(tool.name)).sort());
    expect(ctx.servers.get("stock").health.status).toBe("connected");
  }, 20000);

  it("2. connects over Streamable HTTP on loopback", async () => {
    const http: HttpServer = createServer(async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = createFixtureStockServer();
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    cleanup.push(() => new Promise((done) => http.close(done)));
    const port = (http.address() as Any).port;
    const ctx = setup({ factory: defaultTransportFactory as Any });
    ctx.servers.register({
      server_id: "stock",
      name: "HTTP fixture",
      transport: "streamable_http",
      connection: { url: `http://127.0.0.1:${port}/mcp` },
    });
    const summary = await ctx.registry.discover("stock");
    expect(summary.added).toHaveLength(4);
  }, 20000);

  it("3. rejects invalid, unapproved and secret-bearing configurations", () => {
    const base = { server_id: "x1", name: "X", transport: "stdio", connection: STDIO };
    expect(() => validateServerConfig({ ...base, server_id: "Bad ID" }, policy)).toThrow(
      /server_id/,
    );
    expect(() =>
      validateServerConfig(
        { ...base, connection: { command: "powershell", args: ["-c", "rm"] } },
        policy,
      ),
    ).toThrow(/allowlist/);
    expect(() =>
      validateServerConfig(
        { ...base, transport: "streamable_http", connection: { url: "https://evil.example/mcp" } },
        policy,
      ),
    ).toThrow(/allowlist/);
    expect(() =>
      validateServerConfig(
        {
          ...base,
          transport: "streamable_http",
          connection: { url: "http://user:pw@127.0.0.1/mcp" },
        },
        policy,
      ),
    ).toThrow(/Credentials/);
    expect(() =>
      validateServerConfig({ ...base, authentication_ref: "sk-live-abc" }, policy),
    ).toThrow(/environment variable/);
    expect(() => validateServerConfig({ ...base, api_key: "x" }, policy)).toThrow(/Unsupported/);
    expect(() => validateServerConfig({ ...base, transport: "sse" }, policy)).toThrow(/transport/);
  });

  it("4. times out a server that never answers, after bounded attempts", async () => {
    const silent = vi.fn(() => ({
      start: async () => {},
      send: async () => {},
      close: async () => {},
    }));
    const ctx = setup({ factory: silent as Any });
    register(ctx.servers, "stock", { connect_timeout_ms: 150 });
    await expect(ctx.servers.client("stock")).rejects.toMatchObject({ status: 503 });
    expect(silent).toHaveBeenCalledTimes(3);
    expect(ctx.servers.get("stock").health.status).toBe("unreachable");
  }, 10000);

  it("5. marks the server disconnected when the connection drops", async () => {
    const memory = inMemory();
    const ctx = setup({ factory: memory.factory });
    register(ctx.servers);
    await ctx.servers.client("stock");
    await memory.servers[0].close();
    await vi.waitFor(() => expect(ctx.servers.get("stock").health.status).toBe("disconnected"));
  });

  it("6. reconnects with a bounded number of attempts", async () => {
    const memory = inMemory();
    let failures = 2;
    const flaky = vi.fn((config: Any, extra: Any) => {
      if (failures-- > 0) throw new Error("spawn failed");
      return memory.factory(config, extra);
    });
    const ctx = setup({ factory: flaky as Any });
    register(ctx.servers);
    await ctx.servers.client("stock");
    expect(flaky).toHaveBeenCalledTimes(3);
    failures = 10;
    await ctx.servers.disconnect("stock");
    await expect(ctx.servers.client("stock")).rejects.toThrow(/after 3 attempt/);
    expect(flaky).toHaveBeenCalledTimes(6);
  }, 10000);

  it("7. shuts down cleanly and refuses disabled servers", async () => {
    const ctx = setup();
    register(ctx.servers);
    const client = await ctx.servers.client("stock");
    const close = vi.spyOn(client, "close");
    await ctx.servers.close();
    expect(close).toHaveBeenCalled();
    await ctx.servers.update("stock", { enabled: false });
    await expect(ctx.servers.client("stock")).rejects.toMatchObject({ status: 409 });
    expect(JSON.stringify(ctx.servers.get("stock"))).not.toMatch(/secret/i);
  });
});

/** A server whose tool list a test can change between discoveries. */
function mutable(tools: Any[]) {
  return () => {
    const server = new Server({ name: "mutable", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    return server;
  };
}

describe("discovery and the capability registry", () => {
  it("8. discovers tools as unreviewed capabilities with server hints only as suggestions", async () => {
    const ctx = setup();
    register(ctx.servers);
    await ctx.registry.discover("stock");
    const balance = ctx.registry.get(cap("get_stock_balance"));
    expect(balance).toMatchObject({
      server_id: "stock",
      tool_name: "get_stock_balance",
      state: "discovered",
      risk: null,
      suggested_risk: "READ",
      availability: "available",
      schema_version: 1,
    });
    expect(ctx.registry.get(cap("update_stock_quantity")).suggested_risk).toBe("WRITE");
    expect(ctx.registry.get(cap("delete_stock_record")).suggested_risk).toBe("DESTRUCTIVE");
  });

  it("9. keeps same-named tools on different servers apart", async () => {
    const ctx = setup();
    register(ctx.servers, "stock");
    register(ctx.servers, "stock-two");
    await ctx.registry.discover("stock");
    await ctx.registry.discover("stock-two");
    expect(ctx.registry.get(cap("get_stock_balance", "stock")).server_id).toBe("stock");
    expect(ctx.registry.get(cap("get_stock_balance", "stock-two")).server_id).toBe("stock-two");
  });

  it("10-11. records missing metadata and refuses invalid schemas and names", async () => {
    const tools = [
      { name: "no_description", inputSchema: { type: "object" } },
      {
        name: "bad_schema",
        description: "x",
        inputSchema: { type: "object", properties: { x: { type: "bogus" } } },
      },
      { name: "bad name!", description: "x", inputSchema: { type: "object" } },
    ];
    const ctx = setup({ factory: inMemory(mutable(tools)).factory });
    register(ctx.servers);
    const summary = await ctx.registry.discover("stock");
    expect(summary.rejected).toEqual(["bad name!"]);
    expect(ctx.registry.get(cap("no_description")).missing_metadata).toEqual(["description"]);
    expect(ctx.registry.get(cap("bad_schema")).availability).toBe("invalid_schema");
    expect(() => ctx.registry.review(cap("bad_schema"), { risk: "READ" }, DEVELOPER_ACTOR)).toThrow(
      /invalid input schema/,
    );

    const broken = setup({
      factory: inMemory(mutable([{ name: "not_object", inputSchema: { type: "string" } }])).factory,
    });
    register(broken.servers);
    await expect(broken.registry.discover("stock")).rejects.toMatchObject({ status: 502 });
    expect(broken.registry.list()).toEqual([]);
  });

  it("12-13. detects schema changes and removals, keeping history", async () => {
    const tools: Any[] = [
      {
        name: "read_a",
        description: "a",
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
      },
      { name: "read_b", description: "b", inputSchema: { type: "object" } },
    ];
    const ctx = setup({ factory: inMemory(mutable(tools)).factory });
    register(ctx.servers);
    await ctx.registry.discover("stock");
    ctx.registry.review(cap("read_a"), { risk: "READ" }, DEVELOPER_ACTOR);
    tools[0] = {
      ...tools[0],
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
    };
    tools.splice(1, 1);
    await ctx.servers.disconnect("stock");
    const summary = await ctx.registry.discover("stock");
    expect(summary).toMatchObject({ changed: [cap("read_a")], removed: [cap("read_b")] });
    const changed = ctx.registry.get(cap("read_a"));
    expect(changed).toMatchObject({
      state: "discovered",
      schema_version: 2,
      review: { status: "pending" },
    });
    expect(changed.history.map((row: Any) => row.event)).toEqual(["reviewed", "schema_changed"]);
    expect(ctx.registry.get(cap("read_b"))).toMatchObject({ availability: "removed" });
  });
});

describe("authorization", () => {
  it("14. allows an assigned, granted, reviewed read", async () => {
    const ctx = setup();
    await ready(ctx, { assign: ["get_stock_balance"], grant: ["get_stock_balance"] });
    const result = await call(ctx, "get_stock_balance", { sku: "SKU-17", warehouse: "BIN-A" });
    expect(result).toMatchObject({ status: "completed", decision: DECISIONS.ALLOW });
    expect(result.result.structuredContent).toEqual({
      sku: "SKU-17",
      warehouse: "BIN-A",
      quantity: 12,
    });
  });

  it("15-18. denies unassigned reads, ungranted writes, unknown capabilities and unknown agents", async () => {
    const ctx = setup();
    await ready(ctx, { assign: ["get_stock_ledger", "update_stock_quantity"] });
    expect(
      await call(ctx, "get_stock_balance", { sku: "SKU-17", warehouse: "BIN-A" }),
    ).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/not assigned/),
    });
    expect(await call(ctx, "get_stock_ledger", { sku: "SKU-17" })).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/No active grant/),
    });
    expect(
      await call(ctx, "update_stock_quantity", { sku: "SKU-17", warehouse: "BIN-A", quantity: 1 }),
    ).toMatchObject({ status: "denied" });
    expect(
      await ctx.gateway.invoke({
        agentId: "analyst",
        capabilityId: "mcp.stock.nope",
        arguments: {},
      }),
    ).toMatchObject({
      status: "denied",
      error: "Unknown capability.",
    });
    for (const agentId of ["ghost", DEVELOPER_ACTOR])
      expect(
        await ctx.gateway.invoke({
          agentId,
          capabilityId: cap("get_stock_ledger"),
          arguments: { sku: "SKU-17" },
        }),
      ).toMatchObject({ status: "denied", error: expect.stringMatching(/identity/) });
  });

  it("19. stops honouring a revoked grant immediately", async () => {
    const ctx = setup();
    const grants = await ready(ctx, { assign: ["get_stock_ledger"], grant: ["get_stock_ledger"] });
    expect((await call(ctx, "get_stock_ledger", { sku: "SKU-17" })).status).toBe("completed");
    ctx.governance.revoke(grants.get_stock_ledger.grant_id, DEVELOPER_ACTOR);
    expect(await call(ctx, "get_stock_ledger", { sku: "SKU-17" })).toMatchObject({
      status: "denied",
    });
  });

  it("20. reports a disabled server's tools as unavailable", async () => {
    const ctx = setup();
    await ready(ctx, { assign: ["get_stock_ledger"], grant: ["get_stock_ledger"] });
    await ctx.servers.update("stock", { enabled: false });
    expect(await call(ctx, "get_stock_ledger", { sku: "SKU-17" })).toMatchObject({
      status: "unavailable",
      decision: DECISIONS.UNAVAILABLE,
    });
  });

  it("21. requires per-request approval for destructive operations even when granted", async () => {
    const ctx = setup();
    await ready(ctx, { assign: ["delete_stock_record"], grant: ["delete_stock_record"] });
    const result = await call(ctx, "delete_stock_record", { sku: "SKU-17", warehouse: "BIN-B" });
    expect(result).toMatchObject({
      status: "approval_required",
      decision: DECISIONS.REQUIRES_APPROVAL,
    });
    expect(ctx.governance.approvals()[0]).toMatchObject({
      status: "pending",
      operation: "DESTRUCTIVE",
    });
  });

  it("22-25. refuses unauthorized, expired, mismatched and replayed approvals", async () => {
    let now = new Date("2026-11-01T10:00:00Z");
    const ctx = setup();
    ctx.governance.now = () => now;
    await ready(ctx, { assign: ["update_stock_quantity"], grant: ["update_stock_quantity"] });
    const args = { sku: "SKU-17", warehouse: "BIN-A", quantity: 9 };
    const first = await call(ctx, "update_stock_quantity", args);
    const requestId = first.approval_request_id;
    expect(() => ctx.governance.decideApproval(requestId, "approved", "analyst")).toThrow(
      /Only the developer/,
    );

    now = new Date("2026-11-01T10:20:00Z");
    expect(() => ctx.governance.decideApproval(requestId, "approved", DEVELOPER_ACTOR)).toThrow(
      /expired/,
    );
    now = new Date("2026-11-01T10:00:00Z");

    const second = (await call(ctx, "update_stock_quantity", args)).approval_request_id;
    ctx.governance.decideApproval(second, "approved", DEVELOPER_ACTOR);
    expect(
      await call(ctx, "update_stock_quantity", { ...args, quantity: 900 }, { approvalId: second }),
    ).toMatchObject({ status: "denied", error: expect.stringMatching(/Arguments differ/) });
    expect(await call(ctx, "update_stock_quantity", args)).toMatchObject({ status: "completed" });
    expect(await call(ctx, "update_stock_quantity", args, { approvalId: second })).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/already used/),
    });
    expect((await call(ctx, "update_stock_quantity", args)).status).toBe("approval_required");
  });
});

describe("execution", () => {
  it("26. validates input against the discovered schema before calling the server", async () => {
    const ctx = setup();
    await ready(ctx, { assign: ["get_stock_balance"], grant: ["get_stock_balance"] });
    expect(await call(ctx, "get_stock_balance", { sku: "SKU-17" })).toMatchObject({
      status: "rejected",
    });
    expect(
      await call(ctx, "get_stock_balance", { sku: "SKU-17", warehouse: "BIN-A", extra: true }),
    ).toMatchObject({ status: "rejected", error: expect.stringMatching(/additional/) });
  });

  it("27-31. distinguishes success, protocol errors, tool errors, timeouts and malformed replies", async () => {
    const tools = [
      {
        name: "ok",
        description: "ok",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      { name: "boom", description: "x", inputSchema: { type: "object" } },
      { name: "tool_error", description: "x", inputSchema: { type: "object" } },
      { name: "slow", description: "x", inputSchema: { type: "object" } },
      { name: "malformed", description: "x", inputSchema: { type: "object" } },
      { name: "huge", description: "x", inputSchema: { type: "object" } },
    ];
    const make = () => {
      const server = new Server({ name: "edge", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async (request: Any) => {
        const name = request.params.name;
        if (name === "boom") throw new Error("server exploded");
        if (name === "tool_error")
          return { isError: true, content: [{ type: "text", text: "no" }] };
        if (name === "slow") return new Promise(() => {});
        if (name === "malformed") return { content: "not-a-list" } as Any;
        if (name === "huge") return { content: [{ type: "text", text: "x".repeat(300 * 1024) }] };
        return { content: [{ type: "text", text: "fine" }] };
      });
      return server;
    };
    const ctx = setup({ factory: inMemory(make).factory });
    register(ctx.servers, "stock", { request_timeout_ms: 200 });
    await ctx.registry.discover("stock");
    const names = tools.map((tool) => tool.name);
    for (const name of names) ctx.registry.review(cap(name), { risk: "READ" }, DEVELOPER_ACTOR);
    ctx.governance.assign(
      "agent:analyst",
      names.map((name) => cap(name)),
      DEVELOPER_ACTOR,
    );
    for (const name of names)
      ctx.governance.grant({ subject: "agent:analyst", capability_id: cap(name) }, DEVELOPER_ACTOR);
    expect((await call(ctx, "ok", {})).status).toBe("completed");
    expect(await call(ctx, "boom", {})).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/exploded/),
    });
    expect(await call(ctx, "tool_error", {})).toMatchObject({
      status: "failed",
      error: "The tool reported an error.",
    });
    expect(await call(ctx, "slow", {})).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Timed out/),
    });
    expect((await call(ctx, "malformed", {})).status).toBe("failed");
    expect(await call(ctx, "huge", {})).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/exceeded/),
    });
  });

  it("33. marks a side-effecting call uncertain when the outcome is unknown, and never retries", async () => {
    let calls = 0;
    const make = () => {
      const server = new Server({ name: "write", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "write_slow", description: "w", inputSchema: { type: "object" } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => {
        calls += 1;
        return new Promise(() => {});
      });
      return server;
    };
    const ctx = setup({ factory: inMemory(make).factory });
    register(ctx.servers, "stock", { request_timeout_ms: 200 });
    await ctx.registry.discover("stock");
    ctx.registry.review(
      cap("write_slow"),
      { risk: "WRITE", approval_required: false },
      DEVELOPER_ACTOR,
    );
    ctx.governance.assign("agent:analyst", [cap("write_slow")], DEVELOPER_ACTOR);
    ctx.governance.grant(
      { subject: "agent:analyst", capability_id: cap("write_slow") },
      DEVELOPER_ACTOR,
    );
    expect(await call(ctx, "write_slow", {})).toMatchObject({ status: "uncertain" });
    expect(calls).toBe(1);
  });

  it("34-35. persists redacted audit records and decisions correlated to the task", async () => {
    const ctx = setup();
    await ready(ctx, { assign: ["get_stock_ledger"], grant: ["get_stock_ledger"] });
    await call(
      ctx,
      "get_stock_ledger",
      { sku: "SKU-17" },
      { taskId: "task-1", correlationId: "corr-1" },
    );
    await call(
      ctx,
      "update_stock_quantity",
      { sku: "SKU-17", warehouse: "BIN-A", quantity: 1 },
      { taskId: "task-1" },
    );
    const audit = ctx.gateway.invocations({ taskId: "task-1" });
    expect(audit.map((row: Any) => row.status)).toEqual(["completed", "denied"]);
    expect(audit[0]).toMatchObject({
      correlation_id: "corr-1",
      agent_id: "analyst",
      server_id: "stock",
    });
    expect(ctx.db.records("mcp.decision")).toHaveLength(2);
    expect(redact({ sku: "A", api_token: "abc", nested: { password: "p" } })).toEqual({
      sku: "A",
      api_token: "[redacted]",
      nested: { password: "[redacted]" },
    });
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it("drops a grant when the tool's schema changes after it was granted", async () => {
    const tools: Any[] = [
      {
        name: "read_a",
        description: "a",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ];
    const ctx = setup({ factory: inMemory(mutable(tools)).factory });
    register(ctx.servers);
    await ctx.registry.discover("stock");
    ctx.registry.review(cap("read_a"), { risk: "READ" }, DEVELOPER_ACTOR);
    ctx.governance.assign("agent:analyst", [cap("read_a")], DEVELOPER_ACTOR);
    ctx.governance.grant(
      { subject: "agent:analyst", capability_id: cap("read_a") },
      DEVELOPER_ACTOR,
    );
    expect((await call(ctx, "read_a", {})).status).toBe("completed");
    tools[0] = {
      ...tools[0],
      inputSchema: { type: "object", properties: { scope: { type: "string" } } },
    };
    await ctx.servers.disconnect("stock");
    await ctx.registry.discover("stock");
    ctx.registry.review(cap("read_a"), { risk: "READ" }, DEVELOPER_ACTOR);
    expect(await call(ctx, "read_a", {})).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/changed since it was granted/),
    });
  });

  it("enforces a grant's resource scope", async () => {
    const ctx = setup();
    await ready(ctx, { assign: ["get_stock_balance"] });
    ctx.governance.grant(
      {
        subject: "agent:analyst",
        capability_id: cap("get_stock_balance"),
        resource: { argument: "warehouse", allowed: ["BIN-A"] },
      },
      DEVELOPER_ACTOR,
    );
    expect(
      (await call(ctx, "get_stock_balance", { sku: "SKU-17", warehouse: "BIN-A" })).status,
    ).toBe("completed");
    expect(
      await call(ctx, "get_stock_balance", { sku: "SKU-17", warehouse: "BIN-B" }),
    ).toMatchObject({
      status: "denied",
      error: expect.stringMatching(/scope/),
    });
    expect(() =>
      ctx.governance.grant(
        { subject: "agent:analyst", capability_id: "mcp.stock.*" },
        DEVELOPER_ACTOR,
      ),
    ).toThrow(/Wildcard/);
  });
});

describe("OpenClaw proxy and REST integration", () => {
  /** Routes the proxy's fetch calls into the real REST handler, as a loopback caller. */
  function loopbackFetch(runtime: Any, env: Any) {
    return async (url: string, init: Any = {}) => {
      const parsed = new URL(url);
      const req: Any = Readable.from(init.body ? [Buffer.from(init.body)] : []);
      req.method = init.method ?? "GET";
      req.url = parsed.pathname + parsed.search;
      req.headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      req.socket = { remoteAddress: "127.0.0.1" };
      try {
        const result: Any = await handleMcpApi(runtime, req, mcpRoute(parsed.pathname) as Any, env);
        return new Response(JSON.stringify(result.body), { status: result.status });
      } catch (error: Any) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: error.status ?? 500,
        });
      }
    };
  }

  async function proxied(ctx: Any) {
    const env = { AGENT_TOWN_MCP_PROXY_SECRET: "proxy-secret-for-tests" };
    const runtime = {
      mcpServers: ctx.servers,
      capabilities: ctx.registry,
      governance: ctx.governance,
      mcpGateway: ctx.gateway,
    };
    const proxy = createGovernedProxy({
      baseUrl: "http://127.0.0.1:3108",
      agentId: "analyst",
      secret: env.AGENT_TOWN_MCP_PROXY_SECRET,
      fetchImpl: loopbackFetch(runtime, env) as Any,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverSide);
    const client = new Client({ name: "openclaw-stand-in", version: "1" });
    await client.connect(clientSide);
    cleanup.push(() => client.close());
    return { client, runtime, env };
  }

  it("36-37. exposes only assigned, permitted tools and routes calls through the gateway", async () => {
    const ctx = setup();
    await ready(ctx, {
      assign: ["get_stock_balance", "update_stock_quantity"],
      grant: ["get_stock_balance", "update_stock_quantity"],
    });
    const { client } = await proxied(ctx);
    const listed = (await client.listTools()).tools.map((tool: Any) => tool.name).sort();
    expect(listed).toEqual(["mcp_stock_get_stock_balance", "mcp_stock_update_stock_quantity"]);
    const read: Any = await client.callTool({
      name: "mcp_stock_get_stock_balance",
      arguments: { sku: "SKU-17", warehouse: "BIN-A" },
    });
    expect(read.structuredContent).toMatchObject({ quantity: 12 });
    const write: Any = await client.callTool({
      name: "mcp_stock_update_stock_quantity",
      arguments: { sku: "SKU-17", warehouse: "BIN-A", quantity: 5 },
    });
    expect(write.isError).toBe(true);
    expect(write.content[0].text).toMatch(/developer approval required/);
    const hidden: Any = await client.callTool({
      name: "mcp_stock_delete_stock_record",
      arguments: {},
    });
    expect(hidden.content[0].text).toMatch(/not available/);
    expect(ctx.gateway.invocations().map((row: Any) => row.status)).toEqual([
      "completed",
      "approval_required",
    ]);
  });

  it("38-39. the proxy cannot widen policy, and revocation removes the tool", async () => {
    const ctx = setup();
    const grants = await ready(ctx, { assign: ["get_stock_ledger"], grant: ["get_stock_ledger"] });
    const { client, runtime, env } = await proxied(ctx);
    expect((await client.listTools()).tools).toHaveLength(1);
    ctx.governance.revoke(grants.get_stock_ledger.grant_id, DEVELOPER_ACTOR);
    expect((await client.listTools()).tools).toHaveLength(0);
    const req: Any = Readable.from([]);
    Object.assign(req, {
      method: "GET",
      url: "/api/runtime/mcp-gateway/tools?agent_id=analyst",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    });
    await expect(
      handleMcpApi(runtime, req, mcpRoute("/api/runtime/mcp-gateway/tools") as Any, env),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it("serves the developer routes to loopback callers only", async () => {
    const ctx = setup();
    const runtime = {
      mcpServers: ctx.servers,
      capabilities: ctx.registry,
      governance: ctx.governance,
      mcpGateway: ctx.gateway,
    };
    const request = (method: string, path: string, body?: unknown, address = "127.0.0.1") => {
      const req: Any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method, url: path, headers: {}, socket: { remoteAddress: address } });
      return handleMcpApi(runtime, req, mcpRoute(path) as Any, {});
    };
    const created: Any = await request("POST", "/api/developer/mcp/servers", {
      server_id: "stock",
      name: "Stock fixture",
      transport: "stdio",
      connection: STDIO,
      authentication_ref: "STOCK_TOKEN",
    });
    expect(created.body.server.authentication).toEqual({ ref: "STOCK_TOKEN" });
    await expect(
      request("GET", "/api/developer/mcp/servers", undefined, "10.1.1.1"),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(mcpRoute("/api/developer/agent-config/save")).toBeNull();
    expect(mcpRoute("/api/runtime/developer/capabilities/x/review")).toMatchObject({
      area: "capabilities",
    });
  });
});
