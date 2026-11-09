import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import VoiceDiagnostics from "@/components/hud/VoiceDiagnostics";

vi.mock("../store", () => ({
  useStudio: () => ({
    state: {
      voice: {
        calls: [
          {
            id: "call-1",
            name: "Alice",
            createdAt: "2026-10-25T00:00:00Z",
            status: "ended",
            model: "gemini-3.8-live",
            apiVersion: "v1beta",
            durationMs: 2500,
            usageReports: [{ usage: { promptTokenCount: 0, totalTokenCount: 9 } }],
          },
          {
            id: "call-2",
            name: "Bob",
            createdAt: "2026-10-25T00:00:01Z",
            status: "error",
            diagnostic: {
              code: "session_closed",
              phase: "call",
              message: "Gemini ended the voice session. Start a new call to continue.",
              closeCode: 1008,
              reasonKind: "not_supported",
              lastSent: "context",
              msSinceLastSend: 1500,
            },
          },
          {
            id: "call-3",
            name: "Carol",
            createdAt: "2026-10-25T00:00:02Z",
            status: "ended",
            diagnostic: { code: "abandoned", phase: "connection", message: "closed by the server" },
          },
          { id: "call-4", name: "Dave", createdAt: "2026-10-25T00:00:03Z", status: "provisioned" },
        ],
      },
    },
  }),
}));

describe("voice usage labels", () => {
  it("distinguishes reports and estimates from bills and does not turn absent counts into zero", () => {
    const html = renderToStaticMarkup(<VoiceDiagnostics />);
    expect(html).toContain("all devices");
    expect(html).toContain("not Google&#x27;s actual bill");
    expect(html).toContain("estimates, not charges");
    expect(html).toContain("2.5s");
    expect(html).toContain("input 0, output unknown, total 9");
    expect(html).toContain("not a summed call total");
    expect(html).toContain("unknown (no metadata received)");
  });

  it("keeps real failures apart from abandoned calls and shows the close evidence", () => {
    const html = renderToStaticMarkup(<VoiceDiagnostics />);
    // Squash React's text-node separators before matching.
    const text = html.replace(/<!-- -->/g, "");
    expect(text).toContain(
      "Outcomes over the last 4 calls: 1 ended normally, 1 failed, 1 abandoned (never reported an end), 1 still open.",
    );
    expect(text).toContain("reason: not supported");
    expect(text).toContain("last sent: context 1.5s earlier");
  });
});
