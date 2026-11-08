/**
 * Compressed storage for raw tool results.
 *
 * The audit record of an MCP invocation keeps who, what, when, the decision, sizes and a hash of
 * the result. The raw result body (often 200 KB of ERPNext rows) lives here as one gzip file per
 * invocation, so the SQLite file stays small. The hash on the record is `fingerprint(result)`, so a
 * blob can always be checked against the audit record that points to it.
 *
 * Retention removes blobs only. The record, its hash and its size are never deleted.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fingerprint } from "./mcp-governance.mjs";

/** `<yyyy-mm>/<invocation id>.json.gz`: the only shape a reference may have. */
const REF = /^\d{4}-\d{2}\/[A-Za-z0-9_.-]{1,160}\.json\.gz$/;

/** @param {string} dir directory that holds the monthly folders */
export function createResultStore(dir, { now = () => new Date() } = {}) {
  const root = resolve(dir);
  const pathOf = (ref) => {
    if (!REF.test(ref)) throw new Error("Invalid result reference.");
    const full = resolve(root, ref);
    if (!full.startsWith(root + sep)) throw new Error("Invalid result reference.");
    return full;
  };
  return {
    dir: root,
    /**
     * Stores `result` for one invocation. Written to a temporary file and renamed, so a crash never
     * leaves a half-written blob behind a valid reference.
     * @returns {{ ref: string, sha256: string, stored_bytes: number }}
     */
    put(invocationId, result) {
      const month = now().toISOString().slice(0, 7);
      const ref = `${month}/${invocationId}.json.gz`;
      const target = pathOf(ref);
      const packed = gzipSync(JSON.stringify(result), { level: 6 });
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, packed);
      renameSync(temporary, target);
      return { ref, sha256: fingerprint(result), stored_bytes: packed.length };
    },
    /** Reads a result back. With `expectedSha256` a blob that does not match is rejected. */
    get(ref, expectedSha256) {
      const result = JSON.parse(gunzipSync(readFileSync(pathOf(ref))).toString("utf8"));
      if (expectedSha256 && fingerprint(result) !== expectedSha256)
        throw new Error("Stored result does not match its audit hash.");
      return result;
    },
    has(ref) {
      return existsSync(pathOf(ref));
    },
    /** Deletes blobs older than `maxAgeDays` (by modification time). Returns how many were removed. */
    prune({ maxAgeDays }) {
      if (!(maxAgeDays > 0)) throw new Error("maxAgeDays must be positive.");
      const cutoff = now().getTime() - maxAgeDays * 86_400_000;
      let removed = 0;
      if (!existsSync(root)) return 0;
      for (const month of readdirSync(root)) {
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        const folder = join(root, month);
        for (const file of readdirSync(folder)) {
          if (!file.endsWith(".json.gz")) continue;
          const full = join(folder, file);
          if (statSync(full).mtimeMs < cutoff) {
            rmSync(full);
            removed += 1;
          }
        }
        if (!readdirSync(folder).length) rmSync(folder, { recursive: true });
      }
      return removed;
    },
  };
}
