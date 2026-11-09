/**
 * Finishing a chat turn after its 15 s window. When a workflow is still running at the deadline the
 * chat shows a status; this watches the SAME workflow (it never starts a second one) and calls
 * `post` once with the finished reply. `post` must be idempotent (a fixed message id), so a
 * duplicate watcher, or a restart that attaches again, cannot post twice.
 */

const POLL_MS = 2_000;
const MAX_WATCH_MS = 5 * 60_000;
/** workflow id -> watcher, so a second attach to the same workflow reuses the first. */
const watching = new Map();

/**
 * @param {{ voice: any, call: { id: string, name: string }, intent: string, workflowId: string,
 *   post: (response: any) => void | Promise<void>, pollMs?: number, maxMs?: number,
 *   log?: (msg: string) => void }} input
 * @returns {Promise<"posted"|"gave_up"|"already_watching">}
 */
export function watchForResult({
  voice,
  call,
  intent,
  workflowId,
  post,
  pollMs = POLL_MS,
  maxMs = MAX_WATCH_MS,
  log,
}) {
  if (!workflowId) return Promise.resolve("gave_up");
  if (watching.has(workflowId)) return Promise.resolve("already_watching");
  const run = (async () => {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let response;
      try {
        response = await voice.query({
          call,
          actionId: `late-${workflowId}`,
          args: { intent, workflow_id: workflowId },
        });
      } catch (error) {
        log?.(`late result for ${workflowId}: ${error.message}`);
        return "gave_up";
      }
      if (response.status === "running") continue;
      try {
        await post(response);
        return "posted";
      } catch (error) {
        log?.(`late result for ${workflowId} could not be posted: ${error.message}`);
        return "gave_up";
      }
    }
    return "gave_up";
  })().finally(() => watching.delete(workflowId));
  watching.set(workflowId, run);
  return run;
}

export const lateWatchers = () => watching.size;
