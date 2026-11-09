import { afterEach, describe, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TASK_NAMESPACE, WORKFLOW_NAMESPACE, Workflows } from "../server/nammaops/workflows.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// recover() and list() read only the database, so a Workflows over an in-memory database with
// seeded records is enough; no ERP, gateway or agents are involved.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const BOOT = Date.parse("2026-11-08T12:00:00.000Z");
const before = "2026-11-08T11:00:00.000Z"; // started by the previous process
const after = "2026-11-08T12:30:00.000Z"; // started by this one

function setup() {
  const db = new TaskDatabase(":memory:") as Any;
  cleanup.push(() => db.close());
  const workflows = new Workflows({ db } as Any, { binding: null, approvals: null }) as Any;
  const workflow = (
    id: string,
    status: string,
    action: string,
    created_at: string,
    extra: Any = {},
  ) =>
    db.saveRecord(WORKFLOW_NAMESPACE, id, {
      intent: { action },
      status,
      created_at,
      finished_at: status === "running" ? null : created_at,
      result: null,
      summary: null,
      timeline: [{ at: created_at, type: "WORKFLOW_STARTED", agent: "manager" }],
      ...extra,
    });
  const task = (id: string, workflowId: string, status: string) =>
    db.saveRecord(TASK_NAMESPACE, id, {
      workflow_id: workflowId,
      role: "sales",
      title: "Read sales",
      status,
      evidence: [],
    });
  return { db, workflows, workflow, task };
}

describe("closing runs left behind by a restart", () => {
  it("marks a stale running read-only run interrupted, with its running steps uncertain", () => {
    const { db, workflows, workflow, task } = setup();
    workflow("wf_a", "running", "daily_report", before);
    task("t_run", "wf_a", "running");
    task("t_done", "wf_a", "completed");

    expect(workflows.recover({ bootedAt: BOOT })).toBe(1);

    const run = db.record(WORKFLOW_NAMESPACE, "wf_a");
    expect(run.status).toBe("interrupted");
    expect(run.error).toMatch(/server restarted/);
    expect(run.error).toMatch(/Nothing was changed/);
    expect(run.finished_at).toBeTruthy();
    expect(run.timeline.at(-1)).toMatchObject({ type: "WORKFLOW_INTERRUPTED", agent: "manager" });
    expect(db.record(TASK_NAMESPACE, "t_run")).toMatchObject({
      status: "uncertain",
      error: run.error,
    });
    expect(db.record(TASK_NAMESPACE, "t_done").status).toBe("completed"); // finished steps stay as they were
  });

  it("never marks anything completed, and says the outcome is unknown when a draft bill may exist", () => {
    const { db, workflows, workflow } = setup();
    workflow("wf_bill", "running", "prepare_bill", before);
    workflows.recover({ bootedAt: BOOT });
    const run = db.record(WORKFLOW_NAMESPACE, "wf_bill");
    expect(run.status).toBe("outcome_unknown");
    expect(run.error).toMatch(/may or may not have been created/);
    expect(run.status).not.toBe("completed");
  });

  it("leaves finished runs, runs waiting for the owner and runs from this process alone", () => {
    const { db, workflows, workflow } = setup();
    workflow("wf_done", "completed", "stock_check", before);
    workflow("wf_wait", "awaiting_approval", "prepare_reorder", before, { finished_at: null });
    workflow("wf_blocked", "blocked", "prepare_reorder", before, { error: "x" });
    workflow("wf_live", "running", "stock_check", after); // started after boot: genuinely running
    expect(workflows.recover({ bootedAt: BOOT })).toBe(0);
    for (const [id, status] of [
      ["wf_done", "completed"],
      ["wf_wait", "awaiting_approval"],
      ["wf_blocked", "blocked"],
      ["wf_live", "running"],
    ])
      expect(db.record(WORKFLOW_NAMESPACE, id).status).toBe(status);
  });

  it("is idempotent: a second call changes nothing", () => {
    const { db, workflows, workflow } = setup();
    workflow("wf_a", "running", "stock_check", before);
    expect(workflows.recover({ bootedAt: BOOT })).toBe(1);
    const first = db.record(WORKFLOW_NAMESPACE, "wf_a");
    expect(workflows.recover({ bootedAt: BOOT })).toBe(0);
    expect(db.record(WORKFLOW_NAMESPACE, "wf_a").revision).toBe(first.revision);
  });

  it("uses the process start time by default, so a run started a moment ago is safe", () => {
    const { db, workflows, workflow } = setup();
    workflow("wf_now", "running", "stock_check", new Date().toISOString());
    expect(workflows.recover()).toBe(0);
    expect(db.record(WORKFLOW_NAMESPACE, "wf_now").status).toBe("running");
  });

  it("skips a record with no usable start time instead of guessing", () => {
    const { db, workflows, workflow } = setup();
    workflow("wf_odd", "running", "stock_check", "not a date");
    expect(workflows.recover({ bootedAt: BOOT })).toBe(0);
    expect(db.record(WORKFLOW_NAMESPACE, "wf_odd").status).toBe("running");
  });
});

describe("the run list", () => {
  it("includes the error of a blocked, failed or interrupted run, and omits it otherwise", () => {
    const { workflows, workflow } = setup();
    workflow("wf_ok", "completed", "stock_check", before, { summary: "Done." });
    workflow("wf_blocked", "blocked", "prepare_reorder", before, {
      error: "erp.po.create_draft is not enabled",
    });
    const list = workflows.list() as Any[];
    const ok = list.find((w) => w.id === "wf_ok");
    const blocked = list.find((w) => w.id === "wf_blocked");
    expect(blocked.error).toBe("erp.po.create_draft is not enabled");
    expect("error" in ok).toBe(false);
    // The fields the page reads are unchanged.
    expect(Object.keys(ok).sort()).toEqual([
      "created_at",
      "finished_at",
      "id",
      "intent",
      "status",
      "summary",
    ]);
  });
});
