// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillApprovalPrompt from "@/components/hud/BillApprovalPrompt";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const BILL = {
  id: "own_1",
  kind: "sales_invoice",
  status: "pending",
  erp_document_name: "SINV-26-00498",
  customer: "Rohan",
  total: 245,
  items: [{ item_code: "NK-KABULI-1KG", qty: 1, rate: 155 }],
};

let approvals: Any[];
let posts: Array<{ path: string; body: Any }>;
let postStatus = 200;

beforeEach(() => {
  approvals = [{ ...BILL }];
  posts = [];
  postStatus = 200;
  sessionStorage.clear();
  class FakeEventSource {
    onmessage: unknown = null;
    close() {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: Any) => {
      if (init?.method === "POST") {
        posts.push({ path: url, body: JSON.parse(init.body) });
        if (postStatus !== 200)
          return new Response(JSON.stringify({ error: "Wrong PIN." }), { status: postStatus });
        approvals = [];
        return new Response(JSON.stringify({ approval: { status: "submitted" } }));
      }
      return new Response(JSON.stringify({ approvals }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("bill approval popup", () => {
  it("shows the pending bill with a masked PIN box and approves with the PIN", async () => {
    render(<BillApprovalPrompt onLater={() => {}} />);
    await screen.findByText(/SINV-26-00498 for Rohan/);
    const input = screen.getByLabelText("Owner PIN") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByRole("button", { name: "Approve and bill" })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => {
      fireEvent.change(input, { target: { value: "4821" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve and bill" }));
    });
    expect(posts).toEqual([
      { path: "/api/nammaops/approvals/own_1/approve", body: { pin: "4821" } },
    ]);
    await waitFor(() => expect(screen.queryByLabelText("Owner PIN")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("SINV-26-00498: submitted");
  });

  it("shows a wrong-PIN error, clears the box and keeps the popup open", async () => {
    postStatus = 403;
    render(<BillApprovalPrompt onLater={() => {}} />);
    await screen.findByText(/SINV-26-00498 for Rohan/);
    fireEvent.change(screen.getByLabelText("Owner PIN"), { target: { value: "0000" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve and bill" }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Wrong PIN.");
    expect((screen.getByLabelText("Owner PIN") as HTMLInputElement).value).toBe("");
  });

  it("'Later' hides the popup for that bill and opens the KiranaCrew tab", async () => {
    const onLater = vi.fn();
    render(<BillApprovalPrompt onLater={onLater} />);
    await screen.findByText(/SINV-26-00498 for Rohan/);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Owner PIN")).toBeNull();
    expect(posts).toEqual([]); // nothing approved or rejected
    expect(sessionStorage.getItem("kiranacrew:bill-approval-later")).toContain("own_1");
  });

  it("the X button closes it like Later, and the popup is a centred dialog", async () => {
    const onLater = vi.fn();
    render(<BillApprovalPrompt onLater={onLater} />);
    await screen.findByText(/SINV-26-00498 for Rohan/);
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement?.style.position).toBe("fixed");
    expect(dialog.parentElement?.style.alignItems).toBe("center");
    expect(dialog.parentElement?.style.justifyContent).toBe("center");
    fireEvent.click(screen.getByRole("button", { name: "Close and decide later" }));
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toEqual([]);
  });

  it("shows nothing when no bill is pending", async () => {
    approvals = [
      { ...BILL, status: "submitted" },
      { ...BILL, id: "po", kind: "purchase_order" },
    ];
    render(<BillApprovalPrompt onLater={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
