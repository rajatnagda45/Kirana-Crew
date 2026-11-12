import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { handleNammaOpsApi, nammaopsRoute } from "../server/nammaops/api.mjs";
import { ready } from "./nammaops-harness";

// Synthetic TEST FIXTURE only (fixture ERP, in-memory governance). These tests drive the real REST
// handlers (`/api/nammaops/*`); nothing here reaches a live ERPNext.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const PIN = "4826";

const call = async (ctx: Any, method: string, path: string, body?: unknown) => {
  const req: Any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: path, headers: {}, socket: { remoteAddress: "127.0.0.1" } });
  try {
    const result: Any = await handleNammaOpsApi(
      ctx.runtime,
      req,
      nammaopsRoute(path.split("?")[0]) as Any,
    );
    return { status: result.status, body: result.body };
  } catch (error: Any) {
    return { status: error.status as number, body: { error: error.message as string } };
  }
};

async function finish(ctx: Any, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const { body } = await call(ctx, "GET", `/api/nammaops/workflows/${id}`);
    const status = (body as Any).workflow?.status;
    if (status && !["queued", "running"].includes(status)) return (body as Any).workflow;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("workflow did not finish");
}

describe("create draft procurement, through the REST API", () => {
  it("reports the purchase-order capabilities as bound and available", async () => {
    const ctx: Any = await ready();
    const { status, body } = await call(ctx, "GET", "/api/nammaops/binding");
    expect(status).toBe(200);
    for (const id of ["erp.po.create_draft", "erp.po.get", "erp.po.submit"])
      expect(
        (body as Any).binding.find((row: Any) => row.business_capability === id),
      ).toMatchObject({ state: "registered", availability: "available" });
  });

  it("POST /workflows prepares draft POs, and nothing is submitted until the owner approves", async () => {
    const ctx: Any = await ready();
    const started = await call(ctx, "POST", "/api/nammaops/workflows", {
      intent: { action: "prepare_reorder" },
    });
    expect(started.status).toBe(202);
    const workflow = await finish(ctx, (started.body as Any).workflow.id);
    expect(workflow.status).toBe("awaiting_approval");
    expect(workflow.result.orders.length).toBeGreaterThan(0);
    // Every order is a DRAFT, made by Dave, from stock Bob read and quotations Dave compared.
    for (const order of workflow.result.orders) expect(order.docstatus).toBe(0);
    const roles = [...new Set(workflow.tasks.map((task: Any) => task.role))];
    expect(roles).toEqual(expect.arrayContaining(["inventory", "procurement"]));
    const pending = (await call(ctx, "GET", "/api/nammaops/approvals")).body as Any;
    expect(pending.approvals.length).toBe(workflow.result.orders.length);
    expect(pending.approvals.every((row: Any) => row.status === "pending")).toBe(true);
  });

  it("approving needs the owner PIN: a wrong PIN submits nothing, the right PIN submits once", async () => {
    const ctx: Any = await ready();
    const started = await call(ctx, "POST", "/api/nammaops/workflows", {
      intent: { action: "prepare_reorder" },
    });
    await finish(ctx, (started.body as Any).workflow.id);
    const [first] = ((await call(ctx, "GET", "/api/nammaops/approvals")).body as Any).approvals;
    const wrong = await call(ctx, "POST", `/api/nammaops/approvals/${first.id}/approve`, {
      pin: "0000",
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    let current = ((await call(ctx, "GET", "/api/nammaops/approvals")).body as Any).approvals.find(
      (row: Any) => row.id === first.id,
    );
    expect(current.status).toBe("pending");
    const approved = await call(ctx, "POST", `/api/nammaops/approvals/${first.id}/approve`, {
      pin: PIN,
    });
    expect(approved.status).toBe(200);
    current = ((await call(ctx, "GET", "/api/nammaops/approvals")).body as Any).approvals.find(
      (row: Any) => row.id === first.id,
    );
    expect(current.status).toBe("submitted");
    // A second approval of the same order is refused: it is single use.
    const again = await call(ctx, "POST", `/api/nammaops/approvals/${first.id}/approve`, {
      pin: PIN,
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("rejecting leaves the order a draft and keeps a rejection record", async () => {
    const ctx: Any = await ready();
    const started = await call(ctx, "POST", "/api/nammaops/workflows", {
      intent: { action: "prepare_reorder" },
    });
    await finish(ctx, (started.body as Any).workflow.id);
    const [first] = ((await call(ctx, "GET", "/api/nammaops/approvals")).body as Any).approvals;
    const rejected = await call(ctx, "POST", `/api/nammaops/approvals/${first.id}/reject`, {
      pin: PIN,
    });
    expect(rejected.status).toBe(200);
    const row = ((await call(ctx, "GET", "/api/nammaops/approvals")).body as Any).approvals.find(
      (item: Any) => item.id === first.id,
    );
    expect(row.status).toBe("rejected");
  });
});
