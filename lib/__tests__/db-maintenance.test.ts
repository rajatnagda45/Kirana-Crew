import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskDatabase } from "../server/task-db.mjs";
import { fingerprint } from "../server/mcp-governance.mjs";
import { maintainDatabase } from "../server/db-maintenance.mjs";
import { createResultStore } from "../server/result-store.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** A real file database with big inline invocation results and a long event log. */
function seed({ invocations = 30, events = 1500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kc-maint-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "agent-town.sqlite");
  const db = new TaskDatabase(dbPath) as Any;
  const results: Record<string, Any> = {};
  // Filler first, so the invocation events are the newest and survive event pruning.
  for (let i = 0; i < events; i += 1) db.emit("filler", { i });
  for (let i = 0; i < invocations; i += 1) {
    const body = {
      rows: Array.from({ length: 200 }, (_, n) => ({ item: `ITEM-${i}-${n}`, qty: n })),
    };
    const result = {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    };
    const id = `inv_${String(i).padStart(4, "0")}`;
    results[id] = result;
    db.saveRecord("mcp.invocation", id, {
      correlation_id: `wf_${i}`,
      agent_id: "inventory",
      capability_id: "mcp.erpnext-live.list_items",
      operation: "READ",
      decision: "ALLOW",
      status: "completed",
      args_fingerprint: "a".repeat(64),
      started_at: "2026-11-03T10:00:00.000Z",
      finished_at: "2026-11-03T10:00:01.000Z",
      result,
      result_bytes: JSON.stringify(result).length,
    });
    db.saveRecord("mcp.decision", id, {
      decision: "ALLOW",
      capability_id: "mcp.erpnext-live.list_items",
    });
  }
  // A small failed record that must stay inline.
  db.saveRecord("mcp.invocation", "inv_small", {
    status: "failed",
    error: "boom",
    result: { content: [{ type: "text", text: "no" }] },
  });
  db.close();
  return { dir, dbPath, results };
}

describe("db:maintain", () => {
  it("dry run changes nothing and reports what it would do", () => {
    const { dbPath, dir } = seed();
    const before = statSync(dbPath).size;
    const report = maintainDatabase({ dbPath, keepEvents: 1000 });
    expect(report.applied).toBe(false);
    expect(report.would_migrate).toBe(30);
    expect(report.would_prune_events).toBeGreaterThan(0);
    expect(statSync(dbPath).size).toBe(before);
    expect(readdirSync(dir).filter((f) => f.includes("before-maintain"))).toEqual([]);
    expect(existsSync(join(dir, "mcp-results"))).toBe(false);
  });

  it("backs up, moves results with matching hashes, keeps every audit record, and shrinks the file", () => {
    const { dbPath, dir, results } = seed();
    const before = statSync(dbPath).size;
    const report = maintainDatabase({ dbPath, keepEvents: 1000, apply: true });
    expect(report.migrated).toBe(30);
    expect(report.integrity).toBe("ok");
    expect(report.backup).toMatch(/before-maintain-.*\.sqlite$/);
    expect(existsSync(report.backup!)).toBe(true);
    expect(statSync(dbPath).size).toBeLessThan(before / 3);
    // Audit counts are unchanged.
    expect(report.counts_after.invocations).toBe(report.counts.invocations);
    expect(report.counts_after.decisions).toBe(report.counts.decisions);

    const db = new TaskDatabase(dbPath) as Any;
    cleanup.push(() => db.close());
    const store = createResultStore(join(dir, "mcp-results"));
    for (const [id, original] of Object.entries(results)) {
      const row = db.record("mcp.invocation", id);
      expect(row.result).toBeUndefined();
      expect(row).toMatchObject({
        status: "completed",
        decision: "ALLOW",
        operation: "READ",
        correlation_id: expect.stringMatching(/^wf_/),
        args_fingerprint: "a".repeat(64),
      });
      expect(row.result_sha256).toBe(fingerprint(original));
      expect(row.result_bytes).toBe(JSON.stringify(original).length);
      expect(store.get(row.result_ref, row.result_sha256)).toEqual(original);
    }
    // The small record stays inline.
    expect(db.record("mcp.invocation", "inv_small").result).toBeDefined();
    // Old event copies lost their raw result, but still say which invocation and what status.
    expect(report.event_copies_slimmed).toBeGreaterThanOrEqual(30);
    const eventRows = db.db
      .prepare("SELECT data FROM events WHERE kind='mcp.invocation'")
      .all()
      .map((r: Any) => JSON.parse(r.data));
    expect(eventRows.every((e: Any) => e.result === undefined)).toBe(true);
    // (the oldest events were pruned by keepEvents; the newest invocation's events remain)
    expect(eventRows.find((e: Any) => e.id === "inv_0029")).toMatchObject({ status: "completed" });
    // The backup still has the original inline results.
    const backup = new DatabaseSync(report.backup!, { readOnly: true });
    const old = JSON.parse(
      (
        backup
          .prepare(
            "SELECT data FROM runtime_records WHERE namespace='mcp.invocation' AND id='inv_0000'",
          )
          .get() as Any
      ).data,
    );
    backup.close();
    expect(old.result).toEqual(results.inv_0000);
  });

  it("is idempotent: a second run moves nothing", () => {
    const { dbPath } = seed({ invocations: 5 });
    maintainDatabase({ dbPath, keepEvents: 1000, apply: true });
    const again = maintainDatabase({ dbPath, keepEvents: 1000, apply: true });
    expect(again.migrated).toBe(0);
    expect(again.counts_after.invocations).toBe(6);
  });

  it("keeps the newest events and stays replayable", () => {
    const { dbPath } = seed({ invocations: 2, events: 2500 });
    maintainDatabase({ dbPath, keepEvents: 1000, apply: true });
    const db = new TaskDatabase(dbPath) as Any;
    cleanup.push(() => db.close());
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM events").get().n).toBe(1000);
    expect(db.cursor()).toBeGreaterThan(2500);
    expect(db.earliest()).toBe(db.cursor() - 999);
  });

  it("refuses to run while another live process owns the database", () => {
    const { dbPath } = seed({ invocations: 1 });
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT OR REPLACE INTO runtime_owner VALUES (1,?)").run(process.ppid);
    db.close();
    expect(() => maintainDatabase({ dbPath, apply: true })).toThrow(/owns this database/);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const left = (
      check
        .prepare("SELECT COUNT(*) AS n FROM runtime_records WHERE data LIKE '%\"result\":%'")
        .get() as Any
    ).n;
    check.close();
    expect(left).toBeGreaterThan(0); // nothing was moved
  });

  it("rejects an unsafe keepEvents and a missing database", () => {
    const { dbPath } = seed({ invocations: 1 });
    expect(() => maintainDatabase({ dbPath, keepEvents: 5 })).toThrow(/at least 1000/);
    expect(() => maintainDatabase({ dbPath: join(tmpdir(), "does-not-exist.sqlite") })).toThrow(
      /not found/,
    );
  });
});
