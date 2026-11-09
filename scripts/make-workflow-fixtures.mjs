#!/usr/bin/env node
/**
 * Dev tool: turns real NammaOps run records into small, anonymised test fixtures shaped exactly like
 * the detail API response (`{ workflow: { ...record, tasks } }`).
 *
 *   node scripts/make-workflow-fixtures.mjs [db path] [out dir]
 *
 * For each (action, status) the newest record is taken. Long arrays are cut to a few rows, and the
 * names of customers and suppliers are replaced by stable placeholders, so the fixtures keep the
 * real structure but not the store's people. The database is opened read-only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? process.env.AGENT_TOWN_DB_PATH ?? "data/agent-town.sqlite";
const outDir = process.argv[3] ?? "lib/__tests__/fixtures/workflow-runs";
const MAX_ROWS = 5;
const PERSON_KEYS = new Set(["customer", "supplier", "party", "customer_name", "supplier_name"]);

const db = new DatabaseSync(dbPath, { readOnly: true });
const records = (namespace) =>
  db
    .prepare("SELECT data FROM runtime_records WHERE namespace=? ORDER BY rowid")
    .all(namespace)
    .map((row) => JSON.parse(row.data));
const workflows = records("nammaops.workflow");
const tasks = records("nammaops.task");

const names = new Map();
const alias = (kind, value) => {
  const key = `${kind}:${value}`;
  if (!names.has(key)) names.set(key, `${kind} ${names.size + 1}`);
  return names.get(key);
};
/** Cuts arrays and replaces people's names, everywhere in the record. */
function scrub(value, key = "") {
  if (Array.isArray(value)) return value.slice(0, MAX_ROWS).map((item) => scrub(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  if (typeof value === "string" && PERSON_KEYS.has(key) && value !== "Walk-in Customer")
    return alias(key.startsWith("supplier") ? "Supplier" : "Customer", value);
  return value;
}

mkdirSync(outDir, { recursive: true });
const newest = new Map();
for (const record of workflows) newest.set(`${record.intent?.action}.${record.status}`, record);
for (const [name, record] of newest) {
  const detail = {
    workflow: {
      ...scrub(record),
      tasks: tasks.filter((task) => task.workflow_id === record.id).map((task) => scrub(task)),
    },
  };
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(detail, null, 2)}\n`);
  console.log(`wrote ${name}.json`);
}
db.close();
