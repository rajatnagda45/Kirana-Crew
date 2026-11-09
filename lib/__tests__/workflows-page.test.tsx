// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkflowsPage from "@/components/pages/WorkflowsPage";
import { POLL_BASE_MS, POLL_MAX_FAILURES, STALE_RUN_MS } from "@/lib/hooks/useNammaOps";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// A fake NammaOps API. Run records are the real saved ones (trimmed and anonymised, see
// scripts/make-workflow-fixtures.mjs), so the page is exercised against the real response shapes.
// (import.meta.url is not the real file path under jsdom, so the project root is used instead.)
const detail = (name: string): Any =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), "lib/__tests__/fixtures/workflow-runs", `${name}.json`),
      "utf8",
    ),
  ).workflow;
const listItem = (d: Any) => {
  const { id, intent, status, created_at, finished_at, summary, error } = d;
  return { id, intent, status, created_at, finished_at, summary, ...(error ? { error } : {}) };
};

interface World {
  details: Record<string, Any>;
  order: string[];
  binding: Any[];
  approvals: Any[];
  fail: boolean;
  startError?: { status: number; error: string };
  decisionError?: { status: number; error: string };
}
const BLOCKED_PO = [
  {
    business_capability: "erp.po.create_draft",
    mode: "live",
    tool: null,
    state: "unbound",
    availability: "unavailable",
    risk: "WRITE",
  },
];
const OPEN_PO = [
  {
    business_capability: "erp.po.create_draft",
    mode: "fixture",
    tool: "create_purchase_order",
    state: "registered",
    availability: "available",
    risk: "WRITE",
  },
];

let world: World;
let calls: Array<{ method: string; path: string; body?: Any }>;
const add = (d: Any) => {
  world.details[d.id] = d;
  world.order.unshift(d.id);
  return d;
};
const count = (path: RegExp, method = "GET") =>
  calls.filter((c) => c.method === method && path.test(c.path)).length;

function installFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = url.replace("/api/runtime/nammaops", "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const reply = (status: number, payload: unknown) =>
        ({ ok: status < 400, status, json: async () => payload }) as Response;
      if (world.fail) return reply(503, { error: "Server unavailable" });
      if (method === "GET" && path === "/workflows")
        return reply(200, { workflows: world.order.map((id) => listItem(world.details[id])) });
      const one = /^\/workflows\/([^/]+)$/.exec(path);
      if (method === "GET" && one)
        return world.details[one[1]]
          ? reply(200, { workflow: world.details[one[1]] })
          : reply(404, { error: "Workflow not found." });
      if (method === "POST" && path === "/workflows") {
        if (world.startError)
          return reply(world.startError.status, { error: world.startError.error });
        const run = add({
          id: `wf_new_${calls.length}`,
          intent: body.intent,
          status: "running",
          created_at: new Date().toISOString(),
          finished_at: null,
          result: null,
          summary: null,
          timeline: [],
          tasks: [],
        });
        return reply(202, { workflow: listItem(run) });
      }
      if (method === "GET" && path === "/binding") return reply(200, { binding: world.binding });
      if (method === "GET" && path === "/approvals")
        return reply(200, { approvals: world.approvals });
      if (method === "POST" && /^\/approvals\//.test(path))
        return world.decisionError
          ? reply(world.decisionError.status, { error: world.decisionError.error })
          : reply(200, { approval: {} });
      return reply(404, { error: "no route" });
    }),
  );
}

beforeEach(() => {
  world = { details: {}, order: [], binding: BLOCKED_PO, approvals: [], fail: false };
  window.sessionStorage.clear();
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

const ready = async () => {
  render(<WorkflowsPage />);
  await waitFor(() => expect(screen.queryByLabelText("Loading run history")).toBeNull());
};
const row = (id: string) => document.querySelector(`[data-run-id="${id}"]`) as HTMLElement;
const open = async (id: string) => {
  fireEvent.click(within(row(id)).getByRole("button", { name: /View (report|progress)/ }));
  await waitFor(() => expect(within(row(id)).queryByText(/Loading the report/)).toBeNull());
};

describe("development mode (React StrictMode runs every effect twice)", () => {
  it("still loads the run history", async () => {
    const d = add(detail("stock_check.completed"));
    render(
      <React.StrictMode>
        <WorkflowsPage />
      </React.StrictMode>,
    );
    await waitFor(() => expect(row(d.id)).not.toBeNull());
    expect(screen.queryByText(/Nothing has been run yet/)).toBeNull();
  });

  it("opens a report", async () => {
    const d = add(detail("stock_check.completed"));
    render(
      <React.StrictMode>
        <WorkflowsPage />
      </React.StrictMode>,
    );
    await waitFor(() => expect(row(d.id)).not.toBeNull());
    fireEvent.click(within(row(d.id)).getByRole("button", { name: /View report/ }));
    await waitFor(() =>
      expect(within(row(d.id)).getByRole("article", { name: /Stock Check report/ })).toBeTruthy(),
    );
  });
});

describe("run history uses the server's real field names", () => {
  it("shows start time, finish time, duration and the saved summary", async () => {
    const d = add(detail("stock_check.completed"));
    await ready();
    const text = row(d.id).textContent ?? "";
    expect(text).toMatch(/Stock Check/);
    expect(text).toMatch(/Completed/);
    expect(text).toMatch(/Started \d{1,2} \w{3} 20\d\d, \d{1,2}:\d{2} (am|pm)/);
    expect(text).toMatch(/Finished /);
    expect(text).toMatch(/Took (under 1 second|\d+ seconds?|\d+ min)/);
    expect(text).toContain(d.summary.slice(0, 30));
    expect(text).not.toMatch(/Time not recorded/);
  });

  it("explains a blocked run from the list itself, in plain words", async () => {
    const d = add(detail("prepare_reorder.blocked"));
    await ready();
    expect(row(d.id).textContent).toMatch(/Live purchase-order creation is switched off/);
  });
});

describe("readable report", () => {
  it("opens a plain-language report, with raw data only under Advanced", async () => {
    const d = add(detail("stock_check.completed"));
    await ready();
    await open(d.id);
    const r = row(d.id);
    expect(within(r).getByRole("article", { name: /Stock Check report/ })).toBeTruthy();
    expect(within(r).getByRole("heading", { name: "Products running low" })).toBeTruthy();
    expect(
      within(r)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toContain("Suggested purchase");
    expect(r.querySelector("pre")).toBeNull(); // no JSON by default
    fireEvent.click(within(r).getByText("Advanced: raw data"));
    await waitFor(() =>
      expect(r.querySelector("pre")?.textContent).toMatch(/"kind": "stock_check"/),
    );
  });

  it("shows the title, status and summary once when a run is open, not twice", async () => {
    const d = add(detail("stock_check.completed"));
    await ready();
    await open(d.id);
    const r = row(d.id);
    expect(within(r).getAllByRole("heading", { name: "Stock Check" })).toHaveLength(1);
    expect(r.querySelectorAll('[data-status="completed"]')).toHaveLength(1);
    expect((r.textContent ?? "").split(d.summary).length - 1).toBe(1); // the saved summary appears once
    fireEvent.click(within(r).getByRole("button", { name: /Hide report/ }));
    await waitFor(() => expect(r.textContent).toContain(d.summary)); // and is back in the row when closed
  });

  it("explains a partial report and says what could not be checked", async () => {
    const d = add(detail("daily_report.partial"));
    await ready();
    await open(d.id);
    const r = row(d.id);
    expect(r.textContent).toMatch(/Partially completed/);
    expect(r.textContent).toMatch(/No posted accounting entries were found for this period/);
    expect(r.textContent).toMatch(/Not available/);
    expect(r.textContent).toMatch(/No submitted sales were recorded for this period/);
  });

  it("never says there are no problems when expiry was not checked (Store Health)", async () => {
    const d = add(detail("store_health_report.partial"));
    await ready();
    await open(d.id);
    expect(row(d.id).textContent).toMatch(/Expiry was not checked/);
    expect(row(d.id).textContent).not.toMatch(/No problems were found in the areas checked/);
  });

  it("falls back to a plain layout for a workflow it has no layout for", async () => {
    const d = add({
      id: "wf_unknown",
      intent: { action: "brand_new_report" },
      status: "completed",
      created_at: "2026-11-08T10:00:00.000Z",
      finished_at: "2026-11-08T10:00:03.000Z",
      summary: "Done.",
      result: { kind: "brand_new_report", total_amount: 1200, rows: [{ name: "A", qty: 2 }] },
      tasks: [],
    });
    await ready();
    await open(d.id);
    const r = row(d.id);
    expect(r.textContent).toMatch(/Brand new report/);
    expect(r.textContent).toMatch(/₹1,200/);
    expect(r.querySelector("pre")).toBeNull();
  });

  it("says plainly when a run is no longer stored", async () => {
    const d = add(detail("stock_check.completed"));
    await ready();
    delete world.details[d.id]; // pruned after the list was loaded
    fireEvent.click(within(row(d.id)).getByRole("button", { name: /View report/ }));
    await waitFor(() => expect(row(d.id).textContent).toMatch(/no longer stored/));
  });
});

describe("Prepare Reorder", () => {
  it("is labelled unavailable when purchase orders are off, and offers the read-only suggestions instead", async () => {
    await ready();
    await waitFor(() =>
      expect(screen.getByText(/Purchase orders cannot be created right now/)).toBeTruthy(),
    );
    expect(screen.getByText("Purchase orders off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run Prepare Reorder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run Reorder suggestions (read-only)" }));
    await waitFor(() => expect(count(/^\/workflows$/, "POST")).toBe(1));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      intent: { action: "stock_check" },
    });
  });

  it("runs the real Prepare Reorder only when the binding says purchase orders can be drafted", async () => {
    world.binding = OPEN_PO;
    await ready();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run Prepare Reorder" })).toBeTruthy(),
    );
    expect(screen.queryByText(/Purchase orders cannot be created/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run Prepare Reorder" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        intent: { action: "prepare_reorder" },
      }),
    );
  });

  it("treats a binding that cannot be read as unavailable, never as enabled", async () => {
    world.fail = true;
    render(<WorkflowsPage />);
    await waitFor(() => expect(screen.getByText(/treated as unavailable/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Run Prepare Reorder" })).toBeNull();
  });

  it("explains a blocked run's report and points to the read-only alternative", async () => {
    const d = add(detail("prepare_reorder.blocked"));
    await ready();
    await open(d.id);
    const r = row(d.id);
    expect(r.textContent).toMatch(/Blocked/);
    expect(r.textContent).toMatch(/Reorder suggestions \(read-only\)/);
    expect(r.textContent).toMatch(/Nothing is ordered/);
  });
});

describe("starting a workflow", () => {
  it("sends only the inputs the card defines, and opens the new run", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-11-07" } });
    const card = screen.getByRole("form", { name: "Daily Report" });
    fireEvent.click(within(card).getByLabelText("Include profit"));
    fireEvent.click(within(card).getByRole("button", { name: /Run Daily Report/ }));
    await waitFor(() => expect(count(/^\/workflows$/, "POST")).toBe(1));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      intent: { action: "daily_report", date: "2026-11-07", with_profit: false },
    });
    await waitFor(() =>
      expect(document.querySelector('[data-run-status="running"]')).not.toBeNull(),
    );
    expect(document.querySelector('[aria-expanded="true"]')).not.toBeNull(); // opened so progress is visible
  });

  it("asks for the missing product before anything is sent (Supplier Comparison)", async () => {
    await ready();
    const card = screen.getByRole("form", { name: "Supplier Comparison" });
    fireEvent.click(within(card).getByRole("button", { name: /Run Supplier Comparison/ }));
    expect(await within(card).findByRole("alert")).toHaveProperty(
      "textContent",
      "Products to compare is needed.",
    );
    expect(count(/^\/workflows$/, "POST")).toBe(0);
    fireEvent.change(within(card).getByLabelText(/Products to compare/), {
      target: { value: " Atta, rice ,, ATTA " },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Run Supplier Comparison/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        intent: { action: "supplier_comparison", products: ["Atta", "rice"] },
      }),
    );
  });

  it("checks a date range before sending", async () => {
    await ready();
    const card = screen.getByRole("form", { name: "Business Report" });
    fireEvent.change(within(card).getByLabelText("From"), { target: { value: "2026-11-10" } });
    fireEvent.change(within(card).getByLabelText("To"), { target: { value: "2026-11-01" } });
    fireEvent.click(within(card).getByRole("button", { name: /Run Business Report/ }));
    expect((await within(card).findByRole("alert")).textContent).toMatch(
      /end date is before the start date/,
    );
    expect(count(/^\/workflows$/, "POST")).toBe(0);
  });

  it("shows the server's message when a run cannot be started", async () => {
    world.startError = { status: 409, error: "The NammaOps workforce is not set up yet." };
    await ready();
    fireEvent.click(
      within(screen.getByRole("form", { name: "Expiry Check" })).getByRole("button", {
        name: /Run Expiry Check/,
      }),
    );
    expect((await screen.findAllByRole("alert")).map((a) => a.textContent).join(" ")).toMatch(
      /workforce is not set up yet/,
    );
  });

  it("offers cards for the supported extra workflows, but not the one that writes to the ERP", async () => {
    await ready();
    for (const name of [
      "Business Report",
      "Billing Summary",
      "Payments Summary",
      "Purchase Order Lookup",
    ])
      expect(screen.getByRole("form", { name })).toBeTruthy();
    expect(screen.queryByRole("form", { name: /Prepare Bill/ })).toBeNull();
    expect(screen.queryByRole("form", { name: /GST/ })).toBeNull();
  });

  const cap = (business_capability: string, availability: string) => ({
    business_capability,
    tool: "t",
    state: "registered",
    availability,
    risk: "READ",
  });

  it("says a card is not available yet when its ERP connection is not set up, instead of offering a button that cannot work", async () => {
    world.binding = [
      ...BLOCKED_PO,
      cap("erp.payments.summary", "unavailable"),
      cap("erp.gst.summary", "unavailable"),
      cap("erp.po.get", "unavailable"),
    ];
    await ready();
    for (const name of ["Payments Summary", "Purchase Order Lookup"]) {
      const card = await screen.findByRole("form", { name });
      await waitFor(() => expect(within(card).getByText("Not available yet")).toBeTruthy());
      expect(card.textContent).toMatch(/not connected to your ERP data yet/);
      expect(within(card).queryByRole("button", { name: /^Run / })).toBeNull();
    }
    // Cards that do not depend on those connections are unaffected.
    expect(
      within(screen.getByRole("form", { name: "Business Report" })).getByRole("button", {
        name: /Run Business Report/,
      }),
    ).toBeTruthy();
  });

  it("offers the Run button as soon as the connection is available", async () => {
    world.binding = [
      ...BLOCKED_PO,
      cap("erp.payments.summary", "available"),
      cap("erp.gst.summary", "available"),
      cap("erp.po.get", "available"),
    ];
    await ready();
    const card = screen.getByRole("form", { name: "Payments Summary" });
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: /Run Payments Summary/ })).toBeTruthy(),
    );
    expect(within(card).queryByText("Not available yet")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /Run Payments Summary/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        intent: { action: "payments_summary" },
      }),
    );
  });

  it("explains an earlier blocked run of such a workflow in plain words", async () => {
    const d = add({
      id: "wf_pay",
      intent: { action: "payments_summary" },
      status: "blocked",
      created_at: "2026-11-09T10:00:00.000Z",
      finished_at: "2026-11-09T10:00:01.000Z",
      result: null,
      summary: null,
      error: "erp.payments.summary: denied (Unknown capability.)",
      tasks: [
        {
          id: "t1",
          title: "Read payments received and paid",
          status: "blocked",
          error: "erp.payments.summary: denied (Unknown capability.)",
        },
      ],
    });
    await ready();
    expect(row(d.id).textContent).toMatch(/This check is not connected to your ERP data yet/);
    expect(row(d.id).textContent).not.toMatch(/denied \(Unknown capability/);
    await open(d.id);
    expect(row(d.id).textContent).toMatch(
      /This check is not connected to your ERP data yet, so it could not run/,
    );
    fireEvent.click(within(row(d.id)).getAllByText("Technical detail")[0]); // the server's own words stay available
    expect(row(d.id).textContent).toMatch(/denied \(Unknown capability/);
  });
});

describe("clarification", () => {
  const needsAnswer = () => add(detail("supplier_comparison.needs_clarification"));

  it("shows the question and a labelled input, and re-runs the original request with the answer", async () => {
    const d = needsAnswer();
    await ready();
    expect(row(d.id).textContent).toMatch(/Waiting for your answer/);
    await open(d.id);
    expect(
      within(row(d.id)).getByRole("heading", { name: /more information is needed/i }),
    ).toBeTruthy();
    expect(within(row(d.id)).getAllByText("Which product should I use?").length).toBeGreaterThan(0);
    fireEvent.change(within(row(d.id)).getByLabelText("Product name"), {
      target: { value: "Atta, Rice" },
    });
    fireEvent.click(within(row(d.id)).getByRole("button", { name: "Run again with this answer" }));
    await waitFor(() => expect(count(/^\/workflows$/, "POST")).toBe(1));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      intent: { action: "supplier_comparison", products: ["Atta", "Rice"] },
    });
    await waitFor(() => expect(row(d.id).textContent).toMatch(/Answered\./)); // linked to the new run
    expect(document.querySelectorAll("[data-run-id]")).toHaveLength(2);
  });

  it("does not start two runs on a double click", async () => {
    const d = needsAnswer();
    await ready();
    await open(d.id);
    fireEvent.change(within(row(d.id)).getByLabelText("Product name"), {
      target: { value: "Atta" },
    });
    const button = within(row(d.id)).getByRole("button", { name: "Run again with this answer" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(count(/^\/workflows$/, "POST")).toBe(1));
  });

  it("needs an answer first, and shows the server's message if it is refused", async () => {
    const d = needsAnswer();
    await ready();
    await open(d.id);
    fireEvent.click(within(row(d.id)).getByRole("button", { name: "Run again with this answer" }));
    expect((await within(row(d.id)).findByRole("alert")).textContent).toMatch(
      /Answer every question first/,
    );
    expect(count(/^\/workflows$/, "POST")).toBe(0);
    world.startError = { status: 400, error: "Invalid intent." };
    fireEvent.change(within(row(d.id)).getByLabelText("Product name"), {
      target: { value: "Atta" },
    });
    fireEvent.click(within(row(d.id)).getByRole("button", { name: "Run again with this answer" }));
    await waitFor(() =>
      expect(within(row(d.id)).getByRole("alert").textContent).toBe("Invalid intent."),
    );
    // The form is usable again after a refusal.
    expect(
      (
        within(row(d.id)).getByRole("button", {
          name: "Run again with this answer",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("offers the options when a product is ambiguous, and replaces that product (not appends)", async () => {
    const d = add({
      id: "wf_amb",
      intent: { action: "stock_check", products: ["oil", "rice"] },
      status: "needs_clarification",
      created_at: "2026-11-08T10:00:00.000Z",
      finished_at: "2026-11-08T10:00:01.000Z",
      result: null,
      summary: "Please clarify: ...",
      clarifications: [
        {
          requested: "oil",
          reason: "ambiguous",
          options: ["Sunflower Oil 1L", "Coconut Oil 500ml"],
        },
      ],
      tasks: [],
    });
    await ready();
    await open(d.id);
    fireEvent.click(within(row(d.id)).getByRole("button", { name: "Coconut Oil 500ml" }));
    fireEvent.click(within(row(d.id)).getByRole("button", { name: "Run again with this answer" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        intent: { action: "stock_check", products: ["Coconut Oil 500ml", "rice"] },
      }),
    );
  });

  it("offers the product groups the server lists for an unknown product (real record), and re-runs with the chosen group", async () => {
    const d = add(detail("supplier_comparison.unknown_product"));
    await ready();
    await open(d.id);
    expect(row(d.id).textContent).toMatch(/I could not find “Zzyzx tea”/);
    // The question is asked once, by the answer form, and there is nothing to copy or print yet.
    expect((row(d.id).textContent ?? "").split("I could not find “Zzyzx tea”").length - 1).toBe(1);
    expect(within(row(d.id)).queryByRole("button", { name: "Copy summary" })).toBeNull();
    expect(within(row(d.id)).queryByRole("button", { name: "Print" })).toBeNull();
    const groups = within(row(d.id))
      .getAllByRole("button", { name: /^All / })
      .map((b) => b.textContent);
    expect(groups).toContain("All Personal Care (4 products)");
    expect(groups.join(" ")).not.toMatch(/All (Face Wash|Hand Wash)/); // never a product name dressed up as a group
    fireEvent.click(
      within(row(d.id)).getByRole("button", { name: "All Personal Care (4 products)" }),
    );
    fireEvent.click(within(row(d.id)).getByRole("button", { name: "Run again with this answer" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        intent: { action: "supplier_comparison", products: ["Personal Care"] },
      }),
    );
  });

  it("shows a question it cannot answer here as read-only", async () => {
    const d = add(detail("prepare_bill.needs_clarification"));
    await ready();
    await open(d.id);
    expect(
      within(row(d.id)).queryByRole("button", { name: "Run again with this answer" }),
    ).toBeNull();
    expect(row(d.id).textContent).toMatch(/How many packs of Toned Milk 500ml/);
  });
});

describe("approvals", () => {
  const approval = (extra: Any = {}) => ({
    id: "own_1",
    workflow_id: "wf_x",
    kind: "purchase_order",
    erp_document_name: "PUR-ORD-2026-00009",
    supplier: "Supplier 3",
    items: [{ item_code: "RICE", qty: 10, rate: 55 }],
    total: 550,
    status: "pending",
    requested_at: "2026-11-08T10:00:00.000Z",
    expires_at: "2026-11-08T10:30:00.000Z",
    ...extra,
  });

  it("shows the real approval fields and asks for the PIN for both approve and reject", async () => {
    world.approvals = [
      approval(),
      approval({ id: "own_2", status: "rejected" }),
      approval({ id: "own_3", status: "uncertain", erp_document_name: "PUR-ORD-9" }),
    ];
    await ready();
    const section = await screen.findByRole("region", { name: /approval/i });
    expect(section.textContent).toMatch(/Purchase order PUR-ORD-2026-00009 from Supplier 3/);
    expect(section.textContent).toMatch(/Total ₹550/);
    expect(section.textContent).toMatch(/not certain whether this was submitted/);
    expect(section.textContent).not.toMatch(/Rejected/); // settled approvals are not listed
    fireEvent.click(within(section).getAllByRole("button", { name: "Reject" })[0]);
    const pin = within(section).getByLabelText("Owner PIN to reject");
    expect((pin as HTMLInputElement).type).toBe("password");
    fireEvent.change(pin, { target: { value: "4826" } });
    fireEvent.click(within(section).getByRole("button", { name: "Confirm reject" }));
    await waitFor(() => expect(count(/^\/approvals\/own_1\/reject$/, "POST")).toBe(1));
    expect(calls.find((c) => /reject$/.test(c.path))?.body).toMatchObject({ pin: "4826" });
    await waitFor(() =>
      expect(screen.queryByLabelText(/Owner PIN/) as HTMLInputElement | null).toBeNull(),
    );
  });

  it("shows the server's refusal and does not keep the PIN", async () => {
    world.approvals = [approval()];
    world.decisionError = { status: 403, error: "Wrong PIN." };
    await ready();
    const section = await screen.findByRole("region", { name: /approval/i });
    fireEvent.click(within(section).getByRole("button", { name: "Approve" }));
    fireEvent.change(within(section).getByLabelText("Owner PIN to approve"), {
      target: { value: "0000" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Confirm approve" }));
    expect((await within(section).findByRole("alert")).textContent).toBe("Wrong PIN.");
    expect((within(section).getByLabelText("Owner PIN to approve") as HTMLInputElement).value).toBe(
      "",
    ); // cleared
  });
});

describe("polling", () => {
  const fakeTimers = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const flush = async (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const lists = () => count(/^\/workflows$/);

  const runningRun = (id = "wf_run", createdAgo = 5_000) =>
    add({
      id,
      intent: { action: "demand_forecast" },
      status: "running",
      created_at: new Date(Date.now() - createdAgo).toISOString(),
      finished_at: null,
      result: null,
      summary: null,
      tasks: [],
    });

  it("keeps polling while a run is genuinely running, then stops once it has finished", async () => {
    fakeTimers();
    runningRun();
    render(<WorkflowsPage />);
    await flush();
    expect(lists()).toBe(1);
    await flush(POLL_BASE_MS);
    await flush(POLL_BASE_MS);
    expect(lists()).toBe(3); // still running: polled each time
    Object.assign(world.details.wf_run, {
      status: "completed",
      finished_at: new Date().toISOString(),
      summary: "Done.",
    });
    await flush(POLL_BASE_MS);
    expect(lists()).toBe(4); // the poll that sees it finish
    await flush(60_000);
    expect(lists()).toBe(4); // and then no more
    expect(row("wf_run").textContent).toMatch(/Completed/);
  });

  it.each([
    "completed",
    "partial",
    "blocked",
    "failed",
    "needs_clarification",
    "awaiting_approval",
    "uncertain",
    "interrupted",
    "outcome_unknown",
  ])("does not poll a %s run", async (status) => {
    fakeTimers();
    add({
      id: "wf_s",
      intent: { action: "stock_check" },
      status,
      created_at: new Date().toISOString(),
      finished_at: status === "awaiting_approval" ? null : new Date().toISOString(),
      result: null,
      summary: null,
      tasks: [],
    });
    render(<WorkflowsPage />);
    await flush();
    expect(lists()).toBe(1);
    await flush(120_000);
    expect(lists()).toBe(1);
  });

  it("does not poll a run that has been 'running' for far too long, and says it may have been interrupted", async () => {
    fakeTimers();
    runningRun("wf_old", STALE_RUN_MS + 60_000);
    render(<WorkflowsPage />);
    await flush();
    await flush(60_000);
    expect(lists()).toBe(1);
    expect(row("wf_old").textContent).toMatch(/Still marked as running after 20 minutes/);
    expect(row("wf_old").textContent).toMatch(/probably did not finish/);
    expect(row("wf_old").textContent).not.toMatch(/Completed/); // never relabelled as done
  });

  it("backs off after failures, stops after five, and resumes when asked", async () => {
    fakeTimers();
    runningRun();
    render(<WorkflowsPage />);
    await flush();
    world.fail = true;
    const gaps: number[] = [];
    let last = lists();
    for (let waited = 0; waited < 200_000 && lists() < 1 + POLL_MAX_FAILURES; waited += 500) {
      await flush(500);
      if (lists() !== last) {
        gaps.push(waited);
        last = lists();
      }
    }
    expect(lists()).toBe(1 + POLL_MAX_FAILURES);
    await flush(120_000);
    expect(lists()).toBe(1 + POLL_MAX_FAILURES); // stopped
    expect(screen.getByRole("alert").textContent).toMatch(/Lost connection to the server/);
    world.fail = false;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await flush();
    expect(lists()).toBe(2 + POLL_MAX_FAILURES);
    expect(screen.queryByText(/Lost connection/)).toBeNull();
  });

  it("waits while the tab is hidden and resumes when it is shown", async () => {
    fakeTimers();
    runningRun();
    render(<WorkflowsPage />);
    await flush();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await flush(POLL_BASE_MS * 4);
    expect(lists()).toBe(1);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(lists()).toBe(2);
  });

  it("stops polling when the page is closed", async () => {
    fakeTimers();
    runningRun();
    const view = render(<WorkflowsPage />);
    await flush();
    view.unmount();
    const before = lists();
    await flush(120_000);
    expect(lists()).toBe(before);
  });

  it("never has two list requests in flight at once", async () => {
    fakeTimers();
    runningRun();
    let active = 0;
    let peak = 0;
    const inner = fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, i?: RequestInit) => {
        if (u.endsWith("/workflows") && (i?.method ?? "GET") === "GET") {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5000)); // slower than the poll interval
          active -= 1;
        }
        return inner(u, i);
      }),
    );
    render(<WorkflowsPage />);
    await flush(30_000);
    expect(peak).toBe(1);
  });
});
