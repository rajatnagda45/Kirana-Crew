// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportView } from "@/components/workflows/ReportView";
import { copyText, downloadFile, printHtmlDocument } from "@/components/workflows/export";
import { buildReport } from "@/components/workflows/reports";
import { printHtml, escapeHtml } from "@/components/workflows/reports/printHtml";
import { summaryText, toPlainText } from "@/components/workflows/reports/text";
import { normalizeWorkflow, type WorkflowView } from "@/lib/workflow-contract";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const fixture = (name: string): WorkflowView =>
  normalizeWorkflow<WorkflowView>(
    JSON.parse(
      readFileSync(
        join(process.cwd(), "lib/__tests__/fixtures/workflow-runs", `${name}.json`),
        "utf8",
      ),
    ).workflow,
  );

/** Reads the raw bytes and decodes them keeping any byte-order mark (readAsText would strip it). */
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(new TextDecoder("utf-8", { ignoreBOM: true }).decode(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });

let written: string[];
beforeEach(() => {
  written = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => void written.push(t)) },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.querySelectorAll("iframe").forEach((f) => f.remove());
});

describe("copy", () => {
  it("copies the summary", async () => {
    const view = fixture("stock_check.completed");
    render(<ReportView view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Summary copied."));
    expect(written[0]).toBe(summaryText(buildReport(view)));
    expect(written[0]).toContain(view.summary as string);
  });

  it("copies the complete readable report", async () => {
    const view = fixture("stock_check.completed");
    render(<ReportView view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy full report" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Full report copied."));
    expect(written[0]).toBe(toPlainText(buildReport(view)));
    expect(written[0]).toMatch(/Key figures:/);
    expect(written[0]).toMatch(/Products running low/);
    expect(written[0]).not.toMatch(/[{}]/); // readable, not JSON
  });

  it("falls back to the old copy command when the clipboard is not available, and says when nothing worked", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    expect(await copyText("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    exec.mockReturnValue(false as never);
    expect(await copyText("hello")).toBe(false);

    render(<ReportView view={fixture("stock_check.completed")} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Could not copy/));
  });
});

describe("CSV download", () => {
  let created: Blob[];
  let names: string[];
  beforeEach(() => {
    created = [];
    names = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => (created.push(b), "blob:report")),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
  });

  it("downloads a table as CSV with raw numbers, a BOM and a sensible file name", async () => {
    const view = fixture("stock_check.completed");
    render(<ReportView view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(created).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:report");
    expect(names[0]).toMatch(/^stock-check-products-running-low-.*\.csv$/);
    const csv = await readBlob(created[0]);
    const low = (view.result as Any).low[0];
    expect(csv.startsWith("﻿")).toBe(true); // BOM
    expect(csv.split("\r\n")[0]).toBe(
      "﻿Product,In stock,Reorder level,Short by,Suggested purchase,Best supplier,Quoted price",
    );
    expect(csv).toContain(`${low.item_name},${low.available},${low.reorder_level},`);
    expect(csv).not.toContain("₹"); // raw values, not display text
  });

  it("lets the owner pick which table to download when there are several", async () => {
    const view = fixture("stock_check.completed");
    render(<ReportView view={view} />);
    fireEvent.change(screen.getByLabelText("Table to download"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(names[0]).toMatch(/all-products-checked/);
    expect((await readBlob(created[0])).split("\r\n")[0]).toBe(
      "﻿Product,Group,In stock,Reorder level,Status",
    );
  });

  it("exports every row, not only the rows shown on screen", async () => {
    const big: WorkflowView = {
      id: "x",
      status: "completed",
      intent: { action: "brand_new_report" },
      created_at: "2026-11-08T10:00:00.000Z",
      result: { rows: Array.from({ length: 60 }, (_, i) => ({ name: `Item ${i}`, qty: i })) },
    };
    render(<ReportView view={big} />);
    expect(screen.getAllByRole("row").length).toBeLessThan(40); // header + 25 shown
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const csv = await readBlob(created[0]);
    expect(csv.trim().split("\r\n")).toHaveLength(61); // header + 60 rows
    fireEvent.click(screen.getByRole("button", { name: "Show all 60 rows" }));
    expect(screen.getAllByRole("row")).toHaveLength(61);
  });

  it("offers no CSV when no table has rows", () => {
    render(<ReportView view={fixture("expiry_check.completed")} />);
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("reports a failed download instead of throwing", () => {
    (URL.createObjectURL as Any).mockImplementation(() => {
      throw new Error("no blob");
    });
    expect(downloadFile("a.csv", "x")).toBe(false);
  });
});

describe("print", () => {
  it("builds a clean printable page: name, date, summary, figures, warnings, every row, next steps", () => {
    const view = fixture("daily_report.partial");
    const model = buildReport(view);
    const html = printHtml(model, { printedAt: "9 Nov 2026" });
    expect(html).toContain("<h1>Daily Report</h1>");
    expect(html).toContain(model.headline as string);
    expect(html).toContain("Partially completed");
    expect(html).toContain("No posted accounting entries were found for this period");
    expect(html).toContain("Total recorded sales");
    expect(html).toContain("Not available");
    expect(html).toContain("@page");
    expect(html).not.toContain("var(--"); // self-contained: no dependence on the app's CSS variables
    expect(html).not.toMatch(/<script/i);
  });

  it("prints every table row and escapes anything that looks like markup", () => {
    const model = buildReport({
      id: "x",
      status: "completed",
      intent: { action: "brand_new_report" },
      summary: "<b>bold</b> & more",
      result: {
        rows: Array.from({ length: 40 }, (_, i) => ({
          name: i === 3 ? '<script>alert("x")</script>' : `Item ${i}`,
          qty: i,
        })),
      },
    });
    const html = printHtml(model);
    expect(html).toContain("Item 39");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; more");
    expect(escapeHtml(`a<b>"c"&'d'`)).toBe("a&lt;b&gt;&quot;c&quot;&amp;&#39;d&#39;");
  });

  it("prints from a hidden iframe once it has loaded, and removes it afterwards", () => {
    const view = fixture("stock_check.completed");
    render(<ReportView view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.style.width).toBe("210mm"); // full-page size, not zero (a zero-size frame can print blank)
    expect(frame.srcdoc).toContain("<h1>Stock Check</h1>");
    expect(frame.srcdoc).not.toContain("var(--");

    const print = vi.fn();
    let afterPrint: (() => void) | undefined;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: {
        print,
        focus: vi.fn(),
        addEventListener: (_: string, cb: () => void) => (afterPrint = cb),
      },
    });
    expect(print).not.toHaveBeenCalled(); // not before it has loaded
    act(() => frame.onload?.(new Event("load")));
    expect(print).toHaveBeenCalledOnce();
    act(() => afterPrint?.());
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("removes the print frame even if the browser never reports that printing finished", () => {
    vi.useFakeTimers();
    try {
      expect(printHtmlDocument("<p>x</p>", { cleanupMs: 1000 })).toBe(true);
      const frame = document.querySelector("iframe") as HTMLIFrameElement;
      Object.defineProperty(frame, "contentWindow", {
        configurable: true,
        value: { print: vi.fn(), focus: vi.fn(), addEventListener: vi.fn() },
      });
      frame.onload?.(new Event("load"));
      vi.advanceTimersByTime(1001);
      expect(document.querySelector("iframe")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
