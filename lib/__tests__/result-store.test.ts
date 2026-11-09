import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaskDatabase } from "../server/task-db.mjs";
import { McpServers } from "../server/mcp-servers.mjs";
import {
  CapabilityRegistry,
  Governance,
  ToolGateway,
  fingerprint,
} from "../server/mcp-governance.mjs";
import { DEVELOPER_ACTOR } from "../server/developer-config.mjs";
import { createFixtureStockServer } from "../mcp/fixture-stock-server.mjs";
import { createResultStore } from "../server/result-store.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-results-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe("result store", () => {
  it("stores gzip blobs that round-trip and match their audit hash", () => {
    const store = createResultStore(tempDir());
    const result = {
      content: [{ type: "text", text: "x".repeat(5000) }],
      structuredContent: { rows: [1, 2, 3] },
    };
    const put = store.put("inv_abc", result);
    expect(put.ref).toMatch(/^\d{4}-\d{2}\/inv_abc\.json\.gz$/);
    expect(put.sha256).toBe(fingerprint(result));
    expect(put.stored_bytes).toBeLessThan(JSON.stringify(result).length / 5);
    expect(store.get(put.ref, put.sha256)).toEqual(result);
  });

  it("rejects a blob whose content no longer matches the hash", () => {
    const store = createResultStore(tempDir());
    const put = store.put("inv_1", { content: [], structuredContent: { a: 1 } });
    expect(() =>
      store.get(put.ref, fingerprint({ content: [], structuredContent: { a: 2 } })),
    ).toThrow(/does not match its audit hash/);
  });

  it("refuses references that could escape the store directory", () => {
    const store = createResultStore(tempDir());
    for (const bad of [
      "../x.json.gz",
      "2026-11/../../x.json.gz",
      "/etc/passwd",
      "2026-11/a/b.json.gz",
      "2026-11/x.txt",
    ])
      expect(() => store.get(bad)).toThrow(/Invalid result reference/);
  });

  it("retention deletes only old blobs", () => {
    const dir = tempDir();
    const store = createResultStore(dir);
    const fresh = store.put("inv_new", { content: [], structuredContent: null });
    const old = store.put("inv_old", { content: [], structuredContent: null });
    const past = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(join(dir, old.ref), past, past);
    expect(store.prune({ maxAgeDays: 14 })).toBe(1);
    expect(store.has(fresh.ref)).toBe(true);
    expect(existsSync(join(dir, old.ref))).toBe(false);
  });

  it("leaves no partial file behind a reference", () => {
    const dir = tempDir();
    const store = createResultStore(dir);
    const put = store.put("inv_2", { content: [], structuredContent: null });
    const files = readdirSync(join(dir, put.ref.split("/")[0]));
    expect(files).toEqual(["inv_2.json.gz"]);
  });
});

describe("events retention", () => {
  it("keeps the newest events, keeps cursors valid and reports the earliest kept one", () => {
    const db = new TaskDatabase(":memory:") as Any;
    cleanup.push(() => db.close());
    for (let i = 0; i < 1500; i += 1) db.emit("x", { i });
    expect(db.earliest()).toBe(1);
    expect(db.pruneEvents({ keep: 1000 })).toBe(500);
    expect(db.cursor()).toBe(1500);
    expect(db.earliest()).toBe(501);
    // A client at cursor 100 would miss events 101-500: the route compares against earliest().
    expect(100 + 1 >= db.earliest()).toBe(false);
    expect(600 + 1 >= db.earliest()).toBe(true);
    expect(db.replay(600)).toHaveLength(900);
    db.emit("x", { i: 1500 });
    expect(db.cursor()).toBe(1501); // AUTOINCREMENT: sequence numbers are never reused
  });

  it("refuses an unsafe keep value", () => {
    const db = new TaskDatabase(":memory:") as Any;
    cleanup.push(() => db.close());
    expect(() => db.pruneEvents({ keep: 10 })).toThrow(/at least 1000/);
  });
});

describe("gateway with a result store", () => {
  function setup(resultStore: Any) {
    const db = new TaskDatabase(":memory:") as Any;
    const policy = {
      stdio: [{ command: "node", args: ["lib/mcp/fixture-stock-server.mjs"] }],
      http: [],
      cwd: process.cwd(),
    };
    const factory = vi.fn<(...a: Any[]) => Any>(() => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void createFixtureStockServer().connect(serverSide);
      return clientSide;
    });
    const servers = new McpServers(db, { policy, transportFactory: factory as Any });
    cleanup.push(
      () => db.close(),
      () => servers.close(),
    );
    const registry = new CapabilityRegistry(db, servers);
    const governance = new Governance(db, registry, {
      identity: (id: string) => (id === "analyst" ? { agentId: "analyst" } : null),
    });
    const gateway = new ToolGateway({ db, servers, registry, governance, resultStore }) as Any;
    return { db, servers, registry, governance, gateway };
  }
  async function ready(ctx: Any) {
    ctx.servers.register({
      server_id: "stock",
      name: "Stock fixture",
      transport: "stdio",
      connection: { command: "node", args: ["lib/mcp/fixture-stock-server.mjs"] },
    });
    await ctx.registry.discover("stock");
    const id = "mcp.stock.get_stock_balance";
    ctx.registry.review(id, { risk: "READ" }, DEVELOPER_ACTOR);
    ctx.governance.assign("agent:analyst", [id], DEVELOPER_ACTOR);
    ctx.governance.grant({ subject: "agent:analyst", capability_id: id }, DEVELOPER_ACTOR);
    return id;
  }
  const run = (ctx: Any, id: string) =>
    ctx.gateway.invoke({
      agentId: "analyst",
      capabilityId: id,
      arguments: { sku: "SKU-17", warehouse: "BIN-A" },
    });

  it("moves the raw result out of the record and its events, keeps audit fields, and returns it unchanged", async () => {
    const store = createResultStore(tempDir());
    const ctx = setup(store);
    const id = await ready(ctx);
    const out = await run(ctx, id);
    expect(out.status).toBe("completed");
    // The caller still gets the full result in memory.
    expect(out.result.content.length).toBeGreaterThan(0);
    const row = ctx.db.record("mcp.invocation", out.invocation_id);
    expect(row.result).toBeUndefined();
    expect(row).toMatchObject({
      status: "completed",
      decision: "ALLOW",
      operation: "READ",
      capability_id: id,
      correlation_id: out.correlation_id,
    });
    expect(row.args_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.result_sha256).toBe(fingerprint(out.result));
    expect(row.result_bytes).toBeGreaterThan(0);
    expect(row.result_ref).toMatch(/\.json\.gz$/);
    // The raw result is recoverable and verified against the audit hash.
    expect(ctx.gateway.invocationResult(out.invocation_id)).toEqual(out.result);
    // No event carries the raw result.
    const events = ctx.db.replay(0).filter((e: Any) => e.kind === "mcp.invocation");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: Any) => e.data.result === undefined)).toBe(true);
    expect(events.at(-1).data.result_sha256).toBe(row.result_sha256);
  });

  it("keeps the audit hash after retention removes the blob", async () => {
    const dir = tempDir();
    const store = createResultStore(dir);
    const ctx = setup(store);
    const id = await ready(ctx);
    const out = await run(ctx, id);
    const row = ctx.db.record("mcp.invocation", out.invocation_id);
    const past = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(dir, row.result_ref), past, past);
    expect(store.prune({ maxAgeDays: 14 })).toBe(1);
    expect(ctx.gateway.invocationResult(out.invocation_id)).toBeNull();
    const after = ctx.db.record("mcp.invocation", out.invocation_id);
    expect(after.result_sha256).toBe(row.result_sha256);
    expect(after.status).toBe("completed");
  });

  it("falls back to inline storage if the blob cannot be written, so no evidence is lost", async () => {
    const broken = {
      put: () => {
        throw new Error("disk full");
      },
      get: () => null,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanup.push(() => warn.mockRestore());
    const ctx = setup(broken);
    const id = await ready(ctx);
    const out = await run(ctx, id);
    expect(out.status).toBe("completed");
    const row = ctx.db.record("mcp.invocation", out.invocation_id);
    expect(row.result).toEqual(out.result);
    expect(row.result_ref).toBeUndefined();
    expect(row.result_sha256).toBe(fingerprint(out.result));
    expect(warn).toHaveBeenCalled();
  });

  it("without a store the record keeps the result inline (unchanged default)", async () => {
    const ctx = setup(null);
    const id = await ready(ctx);
    const out = await run(ctx, id);
    const row = ctx.db.record("mcp.invocation", out.invocation_id);
    expect(row.result).toEqual(out.result);
    expect(row.result_sha256).toBe(fingerprint(out.result));
  });
});
