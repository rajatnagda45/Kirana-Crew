/**
 * Safe, resumable database maintenance for Agent Town.
 *
 * What it does (only with `apply`; the default is a dry run that changes nothing):
 *   1. refuses to run while another process owns the database;
 *   2. makes a verified backup (VACUUM INTO, integrity check, row counts compared);
 *   3. moves each large raw tool result out of its mcp.invocation record into the compressed
 *      result store, after checking the stored copy against fingerprint(result). The record keeps
 *      every audit field plus `result_sha256`, `result_ref` and the original `result_bytes`;
 *   4. prunes the events replay log to the newest `keepEvents` rows (state lives in the records);
 *   5. checkpoints the WAL and VACUUMs, then verifies every moved result again.
 *
 * It never deletes an audit record, a hash or a size. Result blobs are removed only by the
 * retention rule in the running server, never here.
 */
import { existsSync, mkdirSync, statSync, statfsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskDatabase } from "./task-db.mjs";
import { fingerprint, INVOCATION_NAMESPACE } from "./mcp-governance.mjs";
import { createResultStore } from "./result-store.mjs";

const MB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const fileBytes = (path) => (existsSync(path) ? statSync(path).size : 0);
const dbBytes = (path) => fileBytes(path) + fileBytes(`${path}-wal`);

/** Row counts that must be identical after the backup, and that show nothing was lost. */
function counts(db) {
  const one = (sql) => Number(db.prepare(sql).get().n);
  return {
    runtime_records: one("SELECT COUNT(*) AS n FROM runtime_records"),
    invocations: one(`SELECT COUNT(*) AS n FROM runtime_records WHERE namespace='${INVOCATION_NAMESPACE}'`),
    decisions: one("SELECT COUNT(*) AS n FROM runtime_records WHERE namespace='mcp.decision'"),
    events: one("SELECT COUNT(*) AS n FROM events"),
    tasks: one("SELECT COUNT(*) AS n FROM tasks"),
    messages: one("SELECT COUNT(*) AS n FROM messages"),
  };
}

/**
 * @param {{ dbPath: string, resultsDir?: string, apply?: boolean, keepEvents?: number,
 *   minBlobBytes?: number, now?: () => Date, log?: (line: string) => void }} options
 */
export function maintainDatabase({
  dbPath,
  resultsDir = join(dirname(dbPath), "mcp-results"),
  apply = false,
  keepEvents = 20000,
  minBlobBytes = 4096,
  now = () => new Date(),
  log = () => {},
}) {
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  if (!Number.isSafeInteger(keepEvents) || keepEvents < 1000)
    throw new Error("keepEvents must be at least 1000.");
  /** @type {Record<string, any>} */
  const report = { applied: apply, dbPath, resultsDir, backup: null, migrated: 0, skipped: 0 };
  const sizeBefore = dbBytes(dbPath);
  report.size_before_mb = MB(sizeBefore);

  // ---- dry run: read-only, nothing is created or changed ----
  if (!apply) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      report.counts = counts(db);
      let movable = 0;
      let bytes = 0;
      for (const row of db
        .prepare("SELECT data FROM runtime_records WHERE namespace=?")
        .all(INVOCATION_NAMESPACE)) {
        const record = JSON.parse(row.data);
        if (record.result && !record.result_ref && row.data.length >= minBlobBytes) {
          movable += 1;
          bytes += JSON.stringify(record.result).length;
        }
      }
      report.would_migrate = movable;
      report.result_bytes_in_records_mb = MB(bytes);
      const copies = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(length(json_extract(data,'$.result'))),0) AS b
           FROM events WHERE kind='${INVOCATION_NAMESPACE}' AND json_type(data,'$.result') IS NOT NULL`,
        )
        .get();
      report.would_slim_event_copies = Number(copies.n);
      report.result_bytes_in_events_mb = MB(Number(copies.b));
      const maxSeq = Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM events").get().n);
      report.would_prune_events = Math.max(0, maxSeq - keepEvents);
      log(`dry run: ${movable} result(s) (${MB(bytes)} MB) would move to compressed storage`);
    } finally {
      db.close();
    }
    return report;
  }

  // ---- apply ----
  const free = (() => {
    try {
      const s = statfsSync(dirname(dbPath));
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return Infinity; // cannot tell: do not block
    }
  })();
  if (free < sizeBefore * 2.2)
    throw new Error(
      `Not enough free disk space for a backup (${MB(free)} MB free, ${MB(sizeBefore * 2.2)} MB needed).`,
    );
  const db = new TaskDatabase(dbPath);
  try {
    db.acquireOwner(); // throws if a running server owns this database
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    const before = counts(db.db);
    report.counts = before;

    // 1. verified backup
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const backup = join(dirname(dbPath), `${basename(dbPath, ".sqlite")}.before-maintain-${stamp}.sqlite`);
    if (existsSync(backup)) throw new Error(`Backup already exists: ${backup}`);
    db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.db.prepare("VACUUM INTO ?").run(backup);
    const copy = new DatabaseSync(backup, { readOnly: true });
    try {
      const integrity = copy.prepare("PRAGMA integrity_check").get().integrity_check;
      if (integrity !== "ok") throw new Error(`Backup failed its integrity check: ${integrity}`);
      const copied = counts(copy);
      for (const key of Object.keys(before))
        if (copied[key] !== before[key])
          throw new Error(`Backup row count differs for ${key}: ${copied[key]} vs ${before[key]}`);
    } finally {
      copy.close();
    }
    report.backup = backup;
    log(`backup verified: ${backup}`);

    // 2. move large raw results to compressed storage, verified one by one
    mkdirSync(resultsDir, { recursive: true });
    const store = createResultStore(resultsDir, { now });
    const rows = db.db
      .prepare("SELECT id, data FROM runtime_records WHERE namespace=? ORDER BY rowid")
      .all(INVOCATION_NAMESPACE);
    const update = db.db.prepare("UPDATE runtime_records SET data=? WHERE namespace=? AND id=?");
    const moved = [];
    for (let start = 0; start < rows.length; start += 100) {
      db.transaction(() => {
        for (const row of rows.slice(start, start + 100)) {
          const record = JSON.parse(row.data);
          if (!record.result || record.result_ref || row.data.length < minBlobBytes) {
            report.skipped += 1;
            continue;
          }
          const sha256 = fingerprint(record.result);
          const put = store.put(row.id, record.result);
          // Blank the record only after the stored copy reads back identical to the original.
          const check = store.get(put.ref, sha256);
          if (fingerprint(check) !== sha256) throw new Error(`Verification failed for ${row.id}`);
          const { result, ...rest } = record;
          void result;
          update.run(
            JSON.stringify({
              ...rest,
              result_sha256: sha256,
              result_ref: put.ref,
              result_stored_bytes: put.stored_bytes,
              result_bytes: record.result_bytes ?? Buffer.byteLength(JSON.stringify(record.result)),
            }),
            INVOCATION_NAMESPACE,
            row.id,
          );
          moved.push({ id: row.id, ref: put.ref, sha256 });
          report.migrated += 1;
        }
      });
    }
    log(`moved ${report.migrated} result(s) to compressed storage`);

    // 3. older copies of those results in the events replay log. An event is only a past version of
    // a record that still exists, so dropping its raw result loses nothing: the record keeps the
    // hash, and the result itself is in the verified blob (or still inline for small ones).
    report.event_copies_slimmed = Number(
      db.db
        .prepare(
          `UPDATE events SET data=json_remove(data,'$.result')
           WHERE kind=? AND json_type(data,'$.result') IS NOT NULL`,
        )
        .run(INVOCATION_NAMESPACE).changes,
    );
    // ...and the log itself keeps only the newest rows (state lives in the record tables).
    report.events_pruned = db.pruneEvents({ keep: keepEvents });

    // 4. compact
    db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.db.exec("VACUUM");
    db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // 5. verify everything that was moved, and that no audit record disappeared
    for (const item of moved) {
      const stored = store.get(item.ref, item.sha256);
      if (!stored) throw new Error(`Missing stored result for ${item.id}`);
    }
    const after = counts(db.db);
    if (after.invocations !== before.invocations || after.decisions !== before.decisions)
      throw new Error("Audit record count changed during maintenance.");
    const integrity = db.db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") throw new Error(`Integrity check failed after maintenance: ${integrity}`);
    report.counts_after = after;
    report.integrity = integrity;
    report.size_after_mb = MB(dbBytes(dbPath));
    report.results_dir_mb = MB(
      moved.reduce((sum, item) => sum + fileBytes(join(resultsDir, item.ref)), 0),
    );
    log(`size ${report.size_before_mb} MB -> ${report.size_after_mb} MB`);
    return report;
  } finally {
    db.close();
  }
}
