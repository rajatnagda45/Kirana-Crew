"use client";

import { Mic, Bell, Store, Star, MessageSquare, Settings, Users } from "lucide-react";
import type { SeatState, ConnectionStatus } from "@/types/game";
import type { HudPanelId, HudDockItem } from "./HudDock";

interface TopBarProps {
  seats: SeatState[];
  connection: ConnectionStatus;
  toolItems: HudDockItem[];
  openPanel: HudPanelId | null;
  onToggle: (id: HudPanelId) => void;
  iconOverrides?: Partial<Record<HudPanelId, string>>;
  onSeatClick?: (seatId: string) => void;
  selectedSeatId?: string | null;
  voiceActive?: boolean;
  voiceSeatId?: string;
  voiceStatus?: import("@/lib/voice/client").VoiceStatus;
}

const NAV_TABS = [
  { id: "store", label: "Store", panel: null as HudPanelId | null },
  { id: "chat", label: "Chat & Tasks", panel: "chat" as HudPanelId },
  { id: "operations", label: "Operations", panel: "operations" as HudPanelId },
  { id: "workers", label: "AI Workforce", panel: "workers" as HudPanelId },
  { id: "reviews", label: "Reviews", panel: "nammaops" as HudPanelId },
] as const;

export default function TopBar({ seats, openPanel, onToggle, voiceActive }: TopBarProps) {
  const assignedSeats = seats.filter((s) => s.assigned);
  const workingCount = assignedSeats.filter(
    (s) => s.status === "running" || s.status === "returning",
  ).length;

  return (
    <div className="layout-top layout-top--kirana">
      {/* Left: brand */}
      <div className="layout-topbar__title">
        <span className="layout-topbar__logo">
          <Store size={19} aria-hidden="true" />
          KiranaCrew
        </span>
        <span className="layout-topbar__tagline">
          Your Kirana Store · AI Workforce · Voice First
        </span>
      </div>

      {/* Center: navigation tabs */}
      <nav className="layout-topbar__nav" aria-label="Store sections">
        {NAV_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`topbar-nav-tab ${
              (openPanel === tab.panel && tab.panel !== null) || (tab.id === "store" && !openPanel)
                ? "topbar-nav-tab--active"
                : ""
            }`}
            onClick={() => tab.panel && onToggle(tab.panel)}
            aria-current={
              (openPanel === tab.panel && tab.panel !== null) || (tab.id === "store" && !openPanel)
                ? "page"
                : undefined
            }
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Right: agent status + action icons */}
      <div className="layout-topbar__tools">
        <span className="topbar-agent-count">
          <span className="topbar-agent-count__dot" aria-hidden="true" />
          {assignedSeats.length} agents{workingCount > 0 ? ` · ${workingCount} working` : ""}
        </span>
        <button
          type="button"
          className={`topbar-tool-btn ${voiceActive ? "topbar-tool-btn--active" : ""}`}
          onClick={() => onToggle("chat")}
          title="Voice assistant"
          aria-label="Toggle voice assistant"
        >
          <Mic
            size={16}
            aria-hidden="true"
            className={voiceActive ? "voice-toolbar--active" : ""}
          />
        </button>
        <button
          type="button"
          className="topbar-tool-btn"
          title="Notifications"
          aria-label="Notifications"
        >
          <Bell size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
