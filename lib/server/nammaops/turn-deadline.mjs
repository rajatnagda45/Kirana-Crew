/**
 * A monotonic deadline for one chat turn. The whole turn (understand, run, reply) is meant to end
 * inside `totalMs`; each stage asks how much time is left instead of using its own fixed timeout.
 */
import { performance } from "node:perf_hooks";

export const TURN_MS = 15_000;
export const ANALYSIS_MS = 7_000;
/** Kept back for composing and posting the reply. */
export const REPLY_RESERVE_MS = 1_500;

/**
 * @param {number} [totalMs]
 * @param {{ now?: () => number }} [options] `now` is injectable for tests.
 */
export function createDeadline(totalMs = TURN_MS, { now = () => performance.now() } = {}) {
  const started = now();
  const remaining = () => Math.max(0, totalMs - (now() - started));
  return {
    totalMs,
    elapsed: () => now() - started,
    remaining,
    expired: () => remaining() <= 0,
    /** The most a stage may take: its own cap or what is left, whichever is smaller. */
    budget: (capMs) => Math.max(0, Math.min(capMs, remaining())),
    /** How long the workflow may be awaited before the chat shows a status instead. */
    waitMs: (reserveMs = REPLY_RESERVE_MS) => Math.max(0, remaining() - reserveMs),
  };
}
