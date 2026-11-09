#!/usr/bin/env node
/**
 * Database maintenance: move raw tool results to compressed storage, prune the event replay log,
 * and compact the file. Dry run unless --apply. Stop the server first (it owns the database).
 *
 *   node --env-file-if-exists=.env.local scripts/db-maintain.mjs                # dry run
 *   node --env-file-if-exists=.env.local scripts/db-maintain.mjs --apply        # real run
 *   options: --db <path>  --keep-events <n>  --min-blob-bytes <n>
 *
 * A verified backup (data/<name>.before-maintain-<time>.sqlite) is made before anything changes.
 * No audit record, hash or size is ever deleted; see lib/server/db-maintenance.mjs.
 */
import { maintainDatabase } from "../lib/server/db-maintenance.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const number = (flag, fallback) => {
  const raw = value(flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} needs a whole number.`);
  return parsed;
};

try {
  const report = maintainDatabase({
    dbPath: value("--db") ?? process.env.AGENT_TOWN_DB_PATH ?? "data/agent-town.sqlite",
    resultsDir: process.env.AGENT_TOWN_RESULTS_DIR || undefined,
    apply: args.includes("--apply"),
    keepEvents: number("--keep-events", 20000),
    minBlobBytes: number("--min-blob-bytes", 4096),
    log: (line) => console.log(line),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.applied) console.log("\nDry run only. Re-run with --apply to change the database.");
} catch (error) {
  console.error(`db-maintain failed: ${error.message}`);
  process.exitCode = 1;
}
