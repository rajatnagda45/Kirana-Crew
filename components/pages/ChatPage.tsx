"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  DollarSign,
  FileText,
  Hash,
  Loader2,
  Receipt,
  Mic,
  MicOff,
  Package,
  RefreshCw,
  Search,
  Send,
  ShoppingCart,
  Sparkles,
  Store,
  TrendingUp,
  UserCheck,
  Users,
  WifiOff,
  X,
  XCircle,
  Zap,
  ChevronRight,
} from "lucide-react";
import { runtimeRequest, useStudio } from "@/lib/store";
import { useVoice } from "@/lib/voice/VoiceProvider";
import { useVoiceDictation } from "@/lib/hooks/useVoiceDictation";
import { isVisibleChatMessage } from "@/lib/constants";
import { mergeConversationMessages, OFFICE_GROUP, seatSessions } from "@/lib/conversations";
import type { ChatMessage, SeatState, SessionRecord, TaskItem } from "@/types/game";

// ─── CREW DEFINITIONS ──────────────────────────────────────────────────────────

interface ConvDef {
  convId: string;
  label: string;
  sublabel: string;
  colorHex: string;
  sessionKey?: string;
  Icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>;
}

const CREW: ConvDef[] = [
  {
    convId: "group",
    label: "Store Crew",
    sublabel: "All Agents · Shared team",
    colorHex: "#f2b441",
    sessionKey: OFFICE_GROUP,
    Icon: Users,
  },
  {
    convId: "alice",
    label: "Alice",
    sublabel: "Store Manager",
    colorHex: "#f2b441",
    Icon: UserCheck,
  },
  {
    convId: "bob",
    label: "Bob",
    sublabel: "Inventory",
    colorHex: "#4ade80",
    Icon: Package,
  },
  {
    convId: "carol",
    label: "Carol",
    sublabel: "Sales",
    colorHex: "#60a5fa",
    Icon: TrendingUp,
  },
  {
    convId: "dave",
    label: "Dave",
    sublabel: "Procurement",
    colorHex: "#c084fc",
    Icon: ShoppingCart,
  },
  {
    convId: "erin",
    label: "Erin",
    sublabel: "Finance",
    colorHex: "#fb923c",
    Icon: DollarSign,
  },
  {
    convId: "grace",
    label: "Grace",
    sublabel: "Reports",
    colorHex: "#2dd4bf",
    Icon: FileText,
  },
  {
    convId: "frank",
    label: "Frank",
    sublabel: "Billing",
    colorHex: "#f472b6",
    Icon: Receipt,
  },
];

const SUGGESTIONS = [
  "Check today's low-stock products",
  "How much did we sell today?",
  "Prepare today's store report",
  "Find suppliers for items running low",
  "Which products need urgent restocking?",
  "What's our best-selling category this week?",
];

// ─── UTILITIES ─────────────────────────────────────────────────────────────────

/**
 * Find the actual SeatState for a given CREW convId by matching display label.
 * We cannot match by convId alone because actual seatIds in state.seats may differ
 * from the hardcoded convId strings (e.g. real seatId could be "nammaops-manager",
 * while convId is "alice").
 */
function findSeat(convId: string, seats: SeatState[]): SeatState | undefined {
  const def = CREW.find((c) => c.convId === convId);
  if (!def || convId === "group") return undefined;
  return seats.find((s) => s.label?.toLowerCase() === def.label.toLowerCase() && s.assigned);
}

/**
 * Resolve the active session key for a conversation.
 * For individual agents uses seatSessions() which correctly filters by agentId
 * extracted from the session key, preventing cross-agent session leakage.
 */
function resolveSessionKey(
  convId: string,
  seats: SeatState[],
  sessions: SessionRecord[],
): string | undefined {
  if (convId === "group") return OFFICE_GROUP;
  const seat = findSeat(convId, seats);
  if (!seat) return undefined;
  return seatSessions(sessions, seat.seatId, seat.binding?.agentId)[0]?.key;
}

function parseSource(content: string): { body: string; source?: string } {
  const match = /^([\s\S]*?)\n+Source:\s*(.+)$/m.exec(content);
  if (match) return { body: match[1].trim(), source: match[2].trim() };
  return { body: content };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (isToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getCrewDef(convId: string): ConvDef {
  return CREW.find((c) => c.convId === convId) ?? CREW[0];
}

function getAgentCrewDef(actorName?: string): ConvDef | undefined {
  if (!actorName) return undefined;
  const lower = actorName.toLowerCase();
  return CREW.find((c) => c.convId === lower || c.label.toLowerCase() === lower);
}

function getSeatStatus(seat?: SeatState): "running" | "idle" | "offline" {
  if (!seat) return "offline";
  if (seat.status === "running") return "running";
  if (seat.binding?.available) return "idle";
  return "offline";
}

function renderBulletList(text: string) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let inList = false;
  let listItems: string[] = [];
  let key = 0;

  const flushList = () => {
    if (!listItems.length) return;
    elements.push(
      <ul key={`ul-${key++}`} style={{ margin: "6px 0 6px 4px", padding: 0, listStyle: "none" }}>
        {listItems.map((item, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "flex-start",
              marginBottom: "3px",
              lineHeight: 1.5,
            }}
          >
            <span
              style={{ color: "var(--kirana-primary, #f2b441)", flexShrink: 0, marginTop: "2px" }}
            >
              •
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>,
    );
    listItems = [];
    inList = false;
  };

  for (const line of lines) {
    const isBullet = /^[•\-*]\s/.test(line.trim());
    if (isBullet) {
      inList = true;
      listItems.push(line.trim().replace(/^[•\-*]\s/, ""));
    } else {
      if (inList) flushList();
      if (line.trim()) {
        elements.push(
          <p key={`p-${key++}`} style={{ margin: "4px 0", lineHeight: 1.6 }}>
            {line}
          </p>,
        );
      }
    }
  }
  if (inList) flushList();
  return elements;
}

// ─── MESSAGE CONTENT ────────────────────────────────────────────────────────────

function MessageContent({ content }: { content: string }) {
  const { body, source } = parseSource(content);
  const parts = renderBulletList(body);

  return (
    <div>
      <div style={{ fontSize: "14px", color: "var(--kirana-foreground, #f0ebe0)" }}>{parts}</div>
      {source && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <Hash
            size={11}
            style={{ color: "var(--kirana-muted-foreground, #9ca3af)", flexShrink: 0 }}
          />
          <span
            style={{
              fontSize: "11px",
              color: "var(--kirana-muted-foreground, #9ca3af)",
              lineHeight: 1.4,
            }}
          >
            {source}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── MESSAGE BUBBLES ────────────────────────────────────────────────────────────

function UserBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        marginBottom: "16px",
        gap: "8px",
        padding: "0 16px",
      }}
    >
      <div
        style={{
          maxWidth: "72%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: "4px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "11px", color: "var(--kirana-muted-foreground, #9ca3af)" }}>
            {formatTimestamp(msg.timestamp)}
          </span>
          {msg.source === "voice" && (
            <span
              style={{
                fontSize: "10px",
                background: "rgba(242,180,65,0.15)",
                color: "#f2b441",
                padding: "1px 6px",
                borderRadius: "10px",
              }}
            >
              voice
            </span>
          )}
        </div>
        <div
          style={{
            background: "linear-gradient(135deg, rgba(242,180,65,0.22), rgba(242,180,65,0.12))",
            border: "1px solid rgba(242,180,65,0.28)",
            borderRadius: "16px 16px 4px 16px",
            padding: "10px 14px",
            fontSize: "14px",
            color: "var(--kirana-foreground, #f0ebe0)",
            lineHeight: 1.6,
            wordBreak: "break-word",
          }}
        >
          {msg.content}
        </div>
      </div>
    </div>
  );
}

/** The owner's click that agrees to a server-proposed handoff; the server decides everything else. */
function HandoffButton({ handoffId, target }: { handoffId: string; target: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const connId = CREW.find((c) => c.label.toLowerCase() === target.toLowerCase())?.convId;
  if (state === "done") return null;
  return (
    <button
      type="button"
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        try {
          const res = await fetch(
            `/api/runtime/nammaops/handoffs/${encodeURIComponent(handoffId)}/accept`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            },
          );
          if (!res.ok) throw new Error("handoff refused");
          setState("done");
          if (connId)
            window.dispatchEvent(new CustomEvent("kirana:handoff", { detail: { convId: connId } }));
        } catch {
          setState("failed");
        }
      }}
      style={{
        marginTop: 8,
        padding: "6px 12px",
        borderRadius: 8,
        border: "1px solid var(--kirana-primary)",
        background: "color-mix(in oklab, var(--kirana-primary) 14%, transparent)",
        color: "var(--kirana-primary)",
        fontWeight: 700,
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {state === "failed" ? `Could not switch to ${target}. Try again?` : `Switch to ${target}`}
    </button>
  );
}

function AgentBubble({ msg }: { msg: ChatMessage }) {
  const def = getAgentCrewDef(msg.actorName);
  const isStreaming = "streaming" in msg && msg.streaming;

  return (
    <div
      style={{
        display: "flex",
        gap: "10px",
        marginBottom: "16px",
        padding: "0 16px",
        alignItems: "flex-start",
      }}
    >
      <div
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "50%",
          background: def
            ? `linear-gradient(135deg, ${def.colorHex}30, ${def.colorHex}15)`
            : "rgba(255,255,255,0.06)",
          border: `1.5px solid ${def?.colorHex ?? "#444"}40`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {def ? (
          <def.Icon size={14} style={{ color: def.colorHex }} />
        ) : (
          <Bot size={14} style={{ color: "#9ca3af" }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, maxWidth: "82%" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "5px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: def?.colorHex ?? "#9ca3af" }}>
            {msg.actorName ?? "Agent"}
          </span>
          {def && (
            <span style={{ fontSize: "11px", color: "var(--kirana-muted-foreground, #6b7280)" }}>
              {def.sublabel}
            </span>
          )}
          <span
            style={{
              fontSize: "11px",
              color: "var(--kirana-muted-foreground, #6b7280)",
              marginLeft: "auto",
            }}
          >
            {formatTimestamp(msg.timestamp)}
          </span>
        </div>
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "4px 16px 16px 16px",
            padding: "10px 14px",
            lineHeight: 1.6,
            wordBreak: "break-word",
          }}
        >
          {isStreaming && !msg.content ? (
            <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "var(--kirana-primary, #f2b441)",
                  animation: "pulse 1s infinite",
                }}
              />
              <span style={{ fontSize: "13px", color: "var(--kirana-muted-foreground, #9ca3af)" }}>
                typing…
              </span>
            </span>
          ) : (
            <MessageContent content={msg.content} />
          )}
          {msg.handoffId && msg.handoffTarget && (
            <HandoffButton handoffId={msg.handoffId} target={msg.handoffTarget} />
          )}
        </div>
      </div>
    </div>
  );
}

function ToolEvent({ msg }: { msg: ChatMessage & { role: "tool" } }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        margin: "6px 16px",
        padding: "6px 10px",
        background: "rgba(96,165,250,0.05)",
        border: "1px solid rgba(96,165,250,0.12)",
        borderRadius: "8px",
      }}
    >
      <Zap size={12} style={{ color: "#60a5fa", flexShrink: 0 }} />
      <span style={{ fontSize: "12px", color: "var(--kirana-muted-foreground, #9ca3af)" }}>
        {msg.actorName && (
          <strong style={{ color: "#60a5fa", marginRight: "4px" }}>{msg.actorName}</strong>
        )}
        ran{" "}
        <code style={{ fontSize: "11px", fontFamily: "monospace", color: "#93c5fd" }}>
          {msg.toolName}
        </code>
      </span>
      <span style={{ marginLeft: "auto", fontSize: "11px", color: "rgba(156,163,175,0.6)" }}>
        {formatTimestamp(msg.timestamp)}
      </span>
    </div>
  );
}

function SystemEvent({ msg }: { msg: ChatMessage }) {
  if (!isVisibleChatMessage(msg)) return null;
  return (
    <div
      style={{
        textAlign: "center",
        padding: "6px 16px",
        fontSize: "11px",
        color: "var(--kirana-muted-foreground, #6b7280)",
        fontStyle: "italic",
      }}
    >
      {msg.content}
    </div>
  );
}

function DateDivider({ date }: { date: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "12px 16px",
        fontSize: "11px",
        color: "var(--kirana-muted-foreground, #6b7280)",
      }}
    >
      <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.07)" }} />
      <span>{date}</span>
      <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.07)" }} />
    </div>
  );
}

function renderMessage(msg: ChatMessage, index: number, all: ChatMessage[]) {
  // Date separator
  const showDate =
    index === 0 ||
    new Date(msg.timestamp).toDateString() !== new Date(all[index - 1].timestamp).toDateString();

  const dateEl = showDate ? (
    <DateDivider
      key={`date-${msg.id}`}
      date={new Date(msg.timestamp).toLocaleDateString([], {
        weekday: "long",
        month: "short",
        day: "numeric",
      })}
    />
  ) : null;

  let bubble: React.ReactNode = null;
  if (msg.role === "user") {
    bubble = <UserBubble key={msg.id} msg={msg} />;
  } else if (msg.role === "assistant") {
    bubble = <AgentBubble key={msg.id} msg={msg} />;
  } else if (msg.role === "tool") {
    bubble = <ToolEvent key={msg.id} msg={msg as ChatMessage & { role: "tool" }} />;
  } else if (msg.role === "system") {
    bubble = <SystemEvent key={msg.id} msg={msg} />;
  }

  if (!bubble) return null;
  return (
    <>
      {dateEl}
      {bubble}
    </>
  );
}

// ─── CONVERSATION SIDEBAR ───────────────────────────────────────────────────────

interface SidebarItemProps {
  def: ConvDef;
  seat?: SeatState;
  lastMsg?: ChatMessage;
  sessionKey?: string;
  isSelected: boolean;
  onClick: () => void;
  isConnected: boolean;
}

function SidebarItem({ def, seat, lastMsg, isSelected, onClick, isConnected }: SidebarItemProps) {
  const status = def.convId === "group" ? (isConnected ? "idle" : "offline") : getSeatStatus(seat);
  const statusColor = status === "running" ? "#4ade80" : status === "idle" ? "#4ade80" : "#6b7280";

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 12px",
        borderRadius: "10px",
        background: isSelected ? "rgba(242,180,65,0.1)" : "transparent",
        border: isSelected ? "1px solid rgba(242,180,65,0.22)" : "1px solid transparent",
        cursor: "pointer",
        width: "100%",
        textAlign: "left",
        transition: "all 0.15s",
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "50%",
          background: `linear-gradient(135deg, ${def.colorHex}25, ${def.colorHex}10)`,
          border: `2px solid ${isSelected ? def.colorHex + "60" : def.colorHex + "30"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <def.Icon size={16} style={{ color: def.colorHex }} />
        {def.convId !== "group" && (
          <span
            style={{
              position: "absolute",
              bottom: "-1px",
              right: "-1px",
              width: "9px",
              height: "9px",
              borderRadius: "50%",
              background: statusColor,
              border: "1.5px solid var(--kirana-background, #0f1117)",
            }}
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "4px",
          }}
        >
          <span
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: isSelected ? "#f0ebe0" : "var(--kirana-foreground, #d1cdc4)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {def.label}
          </span>
          {lastMsg && (
            <span
              style={{
                fontSize: "10px",
                color: "var(--kirana-muted-foreground, #6b7280)",
                flexShrink: 0,
              }}
            >
              {formatTimestamp(lastMsg.timestamp)}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: "11px",
            color: "var(--kirana-muted-foreground, #6b7280)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {lastMsg
            ? lastMsg.content.slice(0, 40) + (lastMsg.content.length > 40 ? "…" : "")
            : def.sublabel}
        </div>
      </div>
      {def.convId !== "group" && seat?.status === "running" && (
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: "#4ade80",
            flexShrink: 0,
            boxShadow: "0 0 6px #4ade8080",
          }}
        />
      )}
    </button>
  );
}

// ─── CONTEXT PANEL ──────────────────────────────────────────────────────────────

function ContextPanel({
  selectedConv,
  seats,
  tasks,
}: {
  selectedConv: string;
  seats: SeatState[];
  tasks: TaskItem[];
}) {
  const def = getCrewDef(selectedConv);
  const seat = selectedConv !== "group" ? seats.find((s) => s.seatId === selectedConv) : undefined;
  const status = seat ? getSeatStatus(seat) : undefined;

  const activeTasks = tasks.filter(
    (t) =>
      !["completed", "failed", "stopped", "interrupted"].includes(t.status) &&
      (selectedConv === "group" || t.seatId === selectedConv),
  );

  const recentTasks = tasks
    .filter(
      (t) =>
        ["completed", "failed"].includes(t.status) &&
        (selectedConv === "group" || t.seatId === selectedConv),
    )
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    .slice(0, 4);

  const activeSeats =
    selectedConv === "group" ? seats.filter((s) => s.assigned && s.status === "running") : [];

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "20px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "20px",
      }}
    >
      {/* Agent / Group card */}
      <div
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "12px",
          padding: "14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${def.colorHex}25, ${def.colorHex}10)`,
              border: `2px solid ${def.colorHex}40`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <def.Icon size={18} style={{ color: def.colorHex }} />
          </div>
          <div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 700,
                color: "var(--kirana-foreground, #f0ebe0)",
              }}
            >
              {def.label}
            </div>
            <div style={{ fontSize: "12px", color: "var(--kirana-muted-foreground, #9ca3af)" }}>
              {def.sublabel}
            </div>
          </div>
        </div>
        {seat && status && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background:
                  status === "running" ? "#4ade80" : status === "idle" ? "#60a5fa" : "#6b7280",
              }}
            />
            <span style={{ fontSize: "12px", color: "var(--kirana-muted-foreground, #9ca3af)" }}>
              {status === "running" ? "Working" : status === "idle" ? "Ready" : "Offline"}
            </span>
            {seat.taskSnippet && status === "running" && (
              <span
                style={{
                  fontSize: "11px",
                  color: "var(--kirana-muted-foreground, #6b7280)",
                  marginLeft: "4px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "120px",
                }}
              >
                · {seat.taskSnippet}
              </span>
            )}
          </div>
        )}
        {selectedConv === "group" && activeSeats.length > 0 && (
          <div style={{ marginTop: "8px" }}>
            <div
              style={{
                fontSize: "11px",
                color: "var(--kirana-muted-foreground, #6b7280)",
                marginBottom: "6px",
              }}
            >
              Currently active
            </div>
            {activeSeats.map((s) => {
              const sd = CREW.find((c) => c.convId === s.seatId);
              return (
                <div
                  key={s.seatId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    marginBottom: "4px",
                    fontSize: "12px",
                    color: "var(--kirana-foreground, #d1cdc4)",
                  }}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background: "#4ade80",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: sd?.colorHex ?? "#9ca3af" }}>{s.label}</span>
                  {s.taskSnippet && (
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--kirana-muted-foreground, #6b7280)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                    >
                      · {s.taskSnippet}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <div>
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--kirana-muted-foreground, #6b7280)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: "8px",
            }}
          >
            Active Tasks
          </div>
          {activeTasks.slice(0, 3).map((t) => (
            <div
              key={t.taskId}
              style={{
                background: "rgba(96,165,250,0.06)",
                border: "1px solid rgba(96,165,250,0.14)",
                borderRadius: "8px",
                padding: "8px 10px",
                marginBottom: "6px",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "3px" }}
              >
                <Loader2
                  size={11}
                  style={{ color: "#60a5fa", animation: "spin 1s linear infinite" }}
                />
                <span style={{ fontSize: "11px", color: "#93c5fd", textTransform: "capitalize" }}>
                  {t.status.replace(/_/g, " ")}
                </span>
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--kirana-foreground, #d1cdc4)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.message.slice(0, 60)}
                {t.message.length > 60 ? "…" : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent completed */}
      {recentTasks.length > 0 && (
        <div>
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--kirana-muted-foreground, #6b7280)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: "8px",
            }}
          >
            Recent Work
          </div>
          {recentTasks.map((t) => (
            <div
              key={t.taskId}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "7px",
                padding: "6px 0",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              {t.status === "completed" ? (
                <CheckCircle2
                  size={12}
                  style={{ color: "#4ade80", flexShrink: 0, marginTop: "2px" }}
                />
              ) : (
                <XCircle size={12} style={{ color: "#f87171", flexShrink: 0, marginTop: "2px" }} />
              )}
              <span
                style={{
                  fontSize: "12px",
                  color: "var(--kirana-muted-foreground, #9ca3af)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {t.message.slice(0, 50)}
                {t.message.length > 50 ? "…" : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {activeTasks.length === 0 && recentTasks.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "20px 8px",
            fontSize: "12px",
            color: "var(--kirana-muted-foreground, #6b7280)",
          }}
        >
          No task history yet
        </div>
      )}
    </div>
  );
}

// ─── MESSAGE COMPOSER ───────────────────────────────────────────────────────────

interface DictationHandle {
  supported: boolean;
  status: string;
  isListening: boolean;
  interimTranscript: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

interface ComposerProps {
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled: boolean;
  disabledReason?: string;
  sendError: string | null;
  onRetry: () => void;
  dictation: DictationHandle;
  voiceCallActive: boolean;
  convId: string;
  onSuggestion: (s: string) => void;
  showSuggestions: boolean;
}

function MessageComposer({
  draft,
  onDraftChange,
  onSend,
  sending,
  disabled,
  disabledReason,
  sendError,
  onRetry,
  dictation,
  voiceCallActive,
  convId,
  onSuggestion,
  showSuggestions,
}: ComposerProps) {
  const def = getCrewDef(convId);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !sending && (draft.trim() || dictation.interimTranscript.trim())) onSend();
    }
  };

  // Mic button toggles STT dictation (not the Gemini voice call).
  // Gemini voice call remains in KiranaVoicePanel; this is STT-only.
  const handleMic = () => {
    if (dictation.isListening) {
      dictation.stop();
    } else {
      dictation.start();
    }
  };

  // The displayed value is the typed draft plus any live interim transcript.
  const displayValue = dictation.interimTranscript
    ? draft + (draft ? " " : "") + dictation.interimTranscript
    : draft;

  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.08)",
        padding: "12px 16px 16px",
        background: "var(--kirana-background, #0f1117)",
      }}
    >
      {/* Suggestions (when empty) */}
      {showSuggestions && (
        <div style={{ marginBottom: "10px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggestion(s)}
              style={{
                background: "rgba(242,180,65,0.08)",
                border: "1px solid rgba(242,180,65,0.2)",
                borderRadius: "20px",
                padding: "5px 10px",
                fontSize: "12px",
                color: "rgba(242,180,65,0.9)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <Sparkles
                size={10}
                style={{ display: "inline", marginRight: "4px", verticalAlign: "middle" }}
              />
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Error banner */}
      {sendError && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "10px",
            padding: "8px 10px",
            background: "rgba(248,113,113,0.1)",
            border: "1px solid rgba(248,113,113,0.2)",
            borderRadius: "8px",
          }}
        >
          <AlertCircle size={13} style={{ color: "#f87171", flexShrink: 0 }} />
          <span style={{ fontSize: "12px", color: "#fca5a5", flex: 1 }}>{sendError}</span>
          <button
            type="button"
            onClick={onRetry}
            style={{
              fontSize: "11px",
              color: "#f87171",
              background: "none",
              border: "1px solid rgba(248,113,113,0.3)",
              borderRadius: "4px",
              padding: "2px 7px",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => onDraftChange("")}
            style={{
              background: "none",
              border: "none",
              color: "#9ca3af",
              cursor: "pointer",
              padding: "2px",
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Capability block */}
      {disabledReason && (
        <div
          style={{
            fontSize: "11px",
            color: "var(--kirana-muted-foreground, #9ca3af)",
            marginBottom: "8px",
            textAlign: "center",
          }}
        >
          {disabledReason}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "8px",
          alignItems: "flex-end",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "14px",
          padding: "8px 10px",
        }}
      >
        <textarea
          ref={textRef}
          aria-label={convId === "group" ? "Message Store Crew" : `Message ${def.label}`}
          placeholder={
            dictation.isListening
              ? "Listening… tap the mic again when you finish"
              : dictation.status === "processing"
                ? "Transcribing with Gnani…"
                : disabled && disabledReason
                  ? disabledReason
                  : convId === "group"
                    ? "Ask the whole store crew…"
                    : `Ask ${def.label}…`
          }
          value={displayValue}
          disabled={disabled}
          onChange={(e) => {
            // When the user edits the textarea, keep only the manually-typed part.
            // If dictation is active, the user override stops dictation gracefully.
            if (dictation.isListening) dictation.stop();
            onDraftChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: dictation.interimTranscript
              ? "var(--kirana-muted-foreground, #9ca3af)"
              : "var(--kirana-foreground, #f0ebe0)",
            fontSize: "14px",
            resize: "none",
            lineHeight: 1.5,
            maxHeight: "120px",
            overflow: "auto",
            fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", gap: "6px", flexShrink: 0, alignItems: "center" }}>
          {/* Dictation error badge */}
          {dictation.error && !dictation.isListening && (
            <span
              style={{
                fontSize: "10px",
                color: "#f87171",
                maxWidth: "80px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={dictation.error}
            >
              {dictation.error.split(".")[0]}
            </span>
          )}
          <button
            type="button"
            onClick={handleMic}
            disabled={voiceCallActive || !dictation.supported}
            title={
              voiceCallActive
                ? "Voice call active — use voice panel"
                : dictation.isListening
                  ? "Stop dictation"
                  : dictation.supported
                    ? "Dictate message"
                    : "Voice input not supported in this browser"
            }
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              background: dictation.isListening ? "rgba(239,68,68,0.15)" : "transparent",
              border: dictation.isListening
                ? "1px solid rgba(239,68,68,0.4)"
                : "1px solid rgba(255,255,255,0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: voiceCallActive || !dictation.supported ? "not-allowed" : "pointer",
              color: dictation.isListening
                ? "#ef4444"
                : voiceCallActive || !dictation.supported
                  ? "#4b5563"
                  : "var(--kirana-muted-foreground, #9ca3af)",
              opacity: voiceCallActive || !dictation.supported ? 0.5 : 1,
            }}
          >
            {dictation.isListening ? <MicOff size={14} /> : <Mic size={14} />}
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || sending || (!draft.trim() && !dictation.interimTranscript.trim())}
            title="Send"
            aria-label="Send message"
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              background:
                disabled || sending || (!draft.trim() && !dictation.interimTranscript.trim())
                  ? "rgba(255,255,255,0.06)"
                  : "linear-gradient(135deg, #f2b441, #e09a28)",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor:
                disabled || sending || (!draft.trim() && !dictation.interimTranscript.trim())
                  ? "not-allowed"
                  : "pointer",
              color:
                disabled || sending || (!draft.trim() && !dictation.interimTranscript.trim())
                  ? "#6b7280"
                  : "#0f1117",
              transition: "all 0.15s",
            }}
          >
            {sending ? (
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Send size={14} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { state, assignTask, loadSessionChat, reconcile } = useStudio();
  const voice = useVoice();

  const [selectedConv, setSelectedConv] = useState<string>("group");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [failedTurnId, setFailedTurnId] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(true);
  const [sidebarSearch, setSidebarSearch] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  // Track the last session key we loaded history for to avoid duplicate loads.
  const loadedKeyRef = useRef<string | null>(null);

  // Resolve session key using proper seat-based session matching.
  // Depends on state.seats AND state.sessions so it updates when sessions are created.
  const currentSessionKey = useMemo(
    () => resolveSessionKey(selectedConv, state.seats ?? [], state.sessions ?? []),
    [selectedConv, state.seats, state.sessions],
  );

  // Wire voice dictation (STT-only) for the chat composer.
  // This is separate from the Gemini voice call (VoiceProvider).
  const dictation = useVoiceDictation({
    onFinalTranscript: useCallback((text: string) => {
      setDraft((prev) => (prev.trim() ? `${prev} ${text}` : text));
    }, []),
  });

  // Live messages filtered to current session
  const liveMessages = useMemo(
    () => (state.chatMessages ?? []).filter((m) => m.sessionKey === currentSessionKey),
    [state.chatMessages, currentSessionKey],
  );

  // Merged history + live
  const messages = useMemo(() => {
    if (!currentSessionKey) return liveMessages;
    return mergeConversationMessages(currentSessionKey, history, liveMessages);
  }, [currentSessionKey, history, liveMessages]);

  // Last message per conversation for sidebar preview (uses correct seat-based session resolution)
  const lastMessages = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const def of CREW) {
      const sessKey = resolveSessionKey(def.convId, state.seats ?? [], state.sessions ?? []);
      if (!sessKey) continue;
      const msgs = (state.chatMessages ?? []).filter(
        (m) =>
          m.sessionKey === sessKey &&
          m.role !== "tool" &&
          (m.role !== "system" || isVisibleChatMessage(m)),
      );
      if (msgs.length) {
        map.set(def.convId, msgs[msgs.length - 1]);
      }
    }
    return map;
  }, [state.chatMessages, state.sessions, state.seats]);

  // Load history when the resolved session key changes (covers both conv switch
  // and the moment a new session is created after the first message to an agent).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!currentSessionKey) {
      setHistory([]);
      setHistoryLoading(false);
      setHistoryError(null);
      loadedKeyRef.current = null;
      return;
    }
    // Avoid redundant reloads when only unrelated state fields update.
    if (currentSessionKey === loadedKeyRef.current) return;
    loadedKeyRef.current = currentSessionKey;

    setHistoryLoading(true);
    setHistoryError(null);

    const key = currentSessionKey;
    const doLoad = async () => {
      try {
        const h = await loadSessionChat(key);
        setHistory(h);
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : "History unavailable");
      } finally {
        setHistoryLoading(false);
      }
    };
    void doLoad();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [currentSessionKey, loadSessionChat]);

  // Follow new messages when the reader is at the bottom; always jump to the latest when a
  // conversation is opened or its history finishes loading, or when the owner just sent one.
  const lastMessage = messages[messages.length - 1];
  const lastIsOwner = lastMessage?.role === "user";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (isNearBottom || lastIsOwner) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastMessage?.content, lastIsOwner]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedConv, currentSessionKey, historyLoading]);

  const handleSend = useCallback(async () => {
    // Commit any in-flight interim dictation transcript into draft before sending.
    const effectiveDraft = dictation.interimTranscript
      ? draft.trim()
        ? `${draft} ${dictation.interimTranscript}`
        : dictation.interimTranscript
      : draft;
    const msg = effectiveDraft.trim();
    if (!msg || sending) return;

    // Stop dictation when user explicitly sends.
    if (dictation.isListening) dictation.stop();

    setSending(true);
    setSendError(null);

    try {
      if (selectedConv === "group") {
        const turnId = failedTurnId ?? crypto.randomUUID().replaceAll("-", "").slice(0, 20);
        await runtimeRequest("office-group", { turnId, message: msg });
        setDraft("");
        setFailedTurnId(null);
      } else {
        // Find the actual seat by matching display label — seatId in state.seats
        // may not match the hardcoded convId string (e.g. production seatId could
        // be "nammaops-manager" while convId is "alice").
        const seat = findSeat(selectedConv, state.seats ?? []);
        if (!seat) {
          setSendError(
            `${getCrewDef(selectedConv).label} is not currently assigned. Configure your team in AI Workforce.`,
          );
          return;
        }

        // Resolve existing session using seatSessions (checks agentId from key).
        let sessKey = seatSessions(state.sessions ?? [], seat.seatId, seat.binding?.agentId)[0]
          ?.key;

        // No session yet — create one via the runtime sessions endpoint.
        if (!sessKey) {
          const r = await runtimeRequest<{ session: SessionRecord }>("sessions", {
            seatId: seat.seatId,
          });
          sessKey = r.session.key;
          // Refresh state so the new session appears in the sidebar and history loads.
          await reconcile();
          // Reset loadedKeyRef so the history effect picks up the new key.
          loadedKeyRef.current = null;
        }

        let redirected = false;
        const taskId = await assignTask(msg, seat.seatId, {
          sessionKey: sessKey,
          onRedirect: () => {
            redirected = true;
          },
        });

        if (taskId !== undefined || redirected) {
          setDraft("");
          setFailedTurnId(null);
        } else {
          setSendError(
            "Task was not confirmed. Your draft is preserved — check diagnostics and retry.",
          );
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to send";
      setSendError(errMsg);
      if (selectedConv === "group" && !failedTurnId) {
        setFailedTurnId(crypto.randomUUID().replaceAll("-", "").slice(0, 20));
      }
    } finally {
      setSending(false);
    }
  }, [
    draft,
    dictation,
    sending,
    selectedConv,
    failedTurnId,
    state.seats,
    state.sessions,
    assignTask,
    reconcile,
  ]);

  const handleSelectConv = useCallback((convId: string) => {
    setSelectedConv(convId);
    setSendError(null);
    setFailedTurnId(null);
  }, []);
  // The owner agreed to a handoff: open the teammate's conversation (the server wrote the handover note).
  useEffect(() => {
    const open = (event: Event) => {
      const convId = (event as CustomEvent<{ convId: string }>).detail?.convId;
      if (convId) handleSelectConv(convId);
    };
    window.addEventListener("kirana:handoff", open);
    return () => window.removeEventListener("kirana:handoff", open);
  }, [handleSelectConv]);

  const handleSuggestion = useCallback((s: string) => {
    setDraft(s);
  }, []);

  const handleRetry = useCallback(() => {
    void handleSend();
  }, [handleSend]);

  const handleRetryHistory = useCallback(() => {
    // Force history reload by clearing the cached key, then the effect will re-fire.
    loadedKeyRef.current = null;
    setHistoryError(null);
    setHistoryLoading(true);
    const key = currentSessionKey;
    if (!key) {
      setHistoryLoading(false);
      return;
    }
    loadSessionChat(key)
      .then((h) => setHistory(h))
      .catch((err) => setHistoryError(err instanceof Error ? err.message : "History unavailable"))
      .finally(() => setHistoryLoading(false));
  }, [currentSessionKey, loadSessionChat]);

  const isConnected = state.connection === "connected";
  const isOffline = !isConnected;
  const capabilitySend = state.capabilities?.["chat.send"];
  const sendBlocked = capabilitySend?.available === false;
  const sendDisabled = isOffline || sendBlocked;

  const currentDef = getCrewDef(selectedConv);
  // Look up current seat by label (not by convId) to get real seatId and status.
  const currentSeat =
    selectedConv !== "group" ? findSeat(selectedConv, state.seats ?? []) : undefined;

  const filteredCrew = useMemo(() => {
    if (!sidebarSearch.trim()) return CREW;
    const q = sidebarSearch.toLowerCase();
    return CREW.filter(
      (c) => c.label.toLowerCase().includes(q) || c.sublabel.toLowerCase().includes(q),
    );
  }, [sidebarSearch]);

  const showSuggestions =
    selectedConv === "group" && messages.length === 0 && !historyLoading && !draft;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `260px 1fr${rightOpen ? " 280px" : ""}`,
        height: "100%",
        overflow: "hidden",
        background: "var(--kirana-background, #0f1117)",
        fontFamily: "var(--font-body, system-ui, sans-serif)",
      }}
    >
      {/* ── LEFT: Conversation Sidebar ─────────────────────────── */}
      <div
        style={{
          borderRight: "1px solid rgba(255,255,255,0.07)",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {/* Sidebar header */}
        <div
          style={{
            padding: "16px 14px 10px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
            <Store size={15} style={{ color: "#f2b441" }} />
            <span
              style={{
                fontSize: "14px",
                fontWeight: 700,
                color: "var(--kirana-foreground, #f0ebe0)",
              }}
            >
              Chat & Inbox
            </span>
            <span
              style={{
                marginLeft: "auto",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: isConnected ? "#4ade80" : "#6b7280",
                boxShadow: isConnected ? "0 0 6px #4ade8050" : "none",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: "8px",
              padding: "6px 10px",
            }}
          >
            <Search
              size={12}
              style={{ color: "var(--kirana-muted-foreground, #9ca3af)", flexShrink: 0 }}
            />
            <input
              type="text"
              placeholder="Search conversations…"
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                fontSize: "12px",
                color: "var(--kirana-foreground, #f0ebe0)",
                fontFamily: "inherit",
              }}
            />
          </div>
        </div>

        {/* Conversation list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px" }}>
          {filteredCrew.map((def) => {
            // Match by label, not by convId — real seatIds may differ from convId strings.
            const seat = findSeat(def.convId, state.seats ?? []);
            return (
              <SidebarItem
                key={def.convId}
                def={def}
                seat={seat}
                lastMsg={lastMessages.get(def.convId)}
                sessionKey={resolveSessionKey(def.convId, state.seats ?? [], state.sessions ?? [])}
                isSelected={selectedConv === def.convId}
                onClick={() => handleSelectConv(def.convId)}
                isConnected={isConnected}
              />
            );
          })}
        </div>
      </div>

      {/* ── CENTER: Message Area ───────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        {/* Conversation header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "12px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: "34px",
              height: "34px",
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${currentDef.colorHex}25, ${currentDef.colorHex}10)`,
              border: `2px solid ${currentDef.colorHex}40`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <currentDef.Icon size={15} style={{ color: currentDef.colorHex }} />
          </div>
          <div>
            <h1
              style={{
                fontSize: "15px",
                fontWeight: 700,
                color: "var(--kirana-foreground, #f0ebe0)",
                margin: 0,
                lineHeight: 1.2,
              }}
            >
              {currentDef.label}
            </h1>
            <div style={{ fontSize: "11px", color: "var(--kirana-muted-foreground, #6b7280)" }}>
              {currentSeat?.status === "running"
                ? currentSeat.taskSnippet
                  ? `Working · ${currentSeat.taskSnippet.slice(0, 40)}`
                  : "Working…"
                : currentDef.sublabel}
            </div>
          </div>
          {isOffline && (
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: "5px",
                padding: "4px 8px",
                background: "rgba(107,114,128,0.15)",
                border: "1px solid rgba(107,114,128,0.25)",
                borderRadius: "20px",
                fontSize: "11px",
                color: "#9ca3af",
              }}
            >
              <WifiOff size={11} />
              <span>Offline</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setRightOpen((v) => !v)}
            title={rightOpen ? "Hide details" : "Show details"}
            style={{
              marginLeft: isOffline ? "8px" : "auto",
              width: "30px",
              height: "30px",
              borderRadius: "6px",
              background: rightOpen ? "rgba(242,180,65,0.1)" : "transparent",
              border: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: rightOpen ? "#f2b441" : "var(--kirana-muted-foreground, #9ca3af)",
            }}
          >
            {rightOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* Messages area */}
        <div
          ref={scrollRef}
          aria-label="Conversation messages"
          style={{
            flex: 1,
            overflowY: "auto",
            paddingTop: "12px",
            paddingBottom: "4px",
          }}
        >
          {historyLoading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                padding: "32px",
                color: "var(--kirana-muted-foreground, #6b7280)",
              }}
            >
              <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
              <span style={{ fontSize: "13px" }}>Loading conversation…</span>
            </div>
          )}

          {historyError && !historyLoading && (
            <div
              style={{
                margin: "20px auto",
                maxWidth: "360px",
                padding: "16px",
                background: "rgba(248,113,113,0.06)",
                border: "1px solid rgba(248,113,113,0.18)",
                borderRadius: "12px",
                textAlign: "center",
              }}
            >
              <AlertCircle size={20} style={{ color: "#f87171", margin: "0 auto 8px" }} />
              <div style={{ fontSize: "13px", color: "#fca5a5", marginBottom: "10px" }}>
                History is temporarily unavailable
              </div>
              <div style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "12px" }}>
                {historyError}
              </div>
              <button
                type="button"
                onClick={handleRetryHistory}
                aria-label="Retry history"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "5px",
                  margin: "0 auto",
                  padding: "6px 14px",
                  background: "rgba(248,113,113,0.12)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  borderRadius: "6px",
                  fontSize: "12px",
                  color: "#fca5a5",
                  cursor: "pointer",
                }}
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          )}

          {!historyLoading && !historyError && messages.length === 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "48px 24px",
                gap: "12px",
                textAlign: "center",
                minHeight: "200px",
              }}
            >
              <div
                style={{
                  width: "52px",
                  height: "52px",
                  borderRadius: "50%",
                  background: `linear-gradient(135deg, ${currentDef.colorHex}20, ${currentDef.colorHex}08)`,
                  border: `2px solid ${currentDef.colorHex}30`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <currentDef.Icon size={22} style={{ color: currentDef.colorHex }} />
              </div>
              <div>
                <div
                  style={{
                    fontSize: "15px",
                    fontWeight: 600,
                    color: "var(--kirana-foreground, #f0ebe0)",
                    marginBottom: "4px",
                  }}
                >
                  {selectedConv === "group"
                    ? "Start a conversation with the Store Crew"
                    : `Start a conversation with ${currentDef.label}`}
                </div>
                <div style={{ fontSize: "13px", color: "var(--kirana-muted-foreground, #6b7280)" }}>
                  {selectedConv === "group"
                    ? "Ask anything about your store — inventory, sales, orders."
                    : `${currentDef.label} handles ${currentDef.sublabel.toLowerCase()} for your store.`}
                </div>
              </div>
            </div>
          )}

          {!historyLoading &&
            messages.map((msg, i, all) => <div key={msg.id}>{renderMessage(msg, i, all)}</div>)}
        </div>

        {/* Composer */}
        <MessageComposer
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSend}
          sending={sending}
          disabled={sendDisabled}
          disabledReason={isOffline ? "Offline — reconnect to send" : capabilitySend?.reason}
          sendError={sendError}
          onRetry={handleRetry}
          dictation={dictation}
          voiceCallActive={voice.active}
          convId={selectedConv}
          onSuggestion={handleSuggestion}
          showSuggestions={showSuggestions}
        />
      </div>

      {/* ── RIGHT: Context Panel ───────────────────────────────── */}
      {rightOpen && (
        <div
          style={{
            borderLeft: "1px solid rgba(255,255,255,0.07)",
            height: "100%",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <Bot size={13} style={{ color: "var(--kirana-muted-foreground, #9ca3af)" }} />
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--kirana-muted-foreground, #9ca3af)",
                textTransform: "uppercase",
                letterSpacing: "0.07em",
              }}
            >
              {selectedConv === "group" ? "Crew Status" : "Agent Details"}
            </span>
          </div>
          <ContextPanel
            selectedConv={selectedConv}
            seats={state.seats ?? []}
            tasks={state.tasks ?? []}
          />
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>
    </div>
  );
}
