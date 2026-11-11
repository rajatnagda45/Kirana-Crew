// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBubble } from "@/components/pages/ChatPage";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

afterEach(cleanup);

const base = {
  runId: "",
  timestamp: "2026-11-11T09:00:00.000Z",
  role: "assistant",
  sessionKey: "agent:main:session-dave",
};

describe("delegation messages in a one-to-one chat", () => {
  it("shows an incoming task as a message from the delegating agent", () => {
    render(
      <AgentBubble
        msg={
          {
            ...base,
            id: "dm_task_1",
            actorName: "Dave",
            delegationKind: "task",
            fromName: "Dave",
            fromTitle: "Procurement",
            content:
              'Hi Bob, the owner asked me: "check stock". That is inventory, which is yours.',
          } as Any
        }
      />,
    );
    expect(screen.getByTestId("delegation-badge").textContent).toBe("Task from Dave · Procurement");
    expect(screen.getByText(/Hi Bob, the owner asked me/)).toBeTruthy();
    // The task message itself has no link: it is already in the owner's chat.
    expect(screen.queryByTestId("open-teammate-chat")).toBeNull();
  });

  it("the completion notice opens the executing specialist's own chat", () => {
    const opened: string[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail.convId);
    window.addEventListener("kirana:handoff", listener);
    render(
      <AgentBubble
        msg={
          {
            ...base,
            id: "dm_done_1",
            actorName: "Dave",
            delegationKind: "notice",
            linkSeatId: "seat-bob",
            linkSessionKey: "agent:main:session-bob",
            linkName: "Bob",
            linkMessageId: "dm_report_1",
            content: "Bob has finished: Check stock. The full answer is in Bob's chat.",
          } as Any
        }
      />,
    );
    fireEvent.click(screen.getByTestId("open-teammate-chat"));
    window.removeEventListener("kirana:handoff", listener);
    // "bob" is the conversation id of Bob's chat, not Dave's.
    expect(opened).toEqual(["bob"]);
    expect(screen.getByTestId("open-teammate-chat").textContent).toBe("Open Bob's chat");
  });

  it("an ordinary reply has no delegation badge or link", () => {
    vi.fn();
    render(
      <AgentBubble
        msg={
          { ...base, id: "dm_reply_x", actorName: "Bob", content: "52 products checked." } as Any
        }
      />,
    );
    expect(screen.queryByTestId("delegation-badge")).toBeNull();
    expect(screen.queryByTestId("open-teammate-chat")).toBeNull();
  });
});
