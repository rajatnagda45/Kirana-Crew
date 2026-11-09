"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Store,
  Mic,
  MicOff,
  Bell,
  Keyboard,
  Check,
  Loader2,
  Package,
  Bot,
  Zap,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { usePathname, useRouter } from "next/navigation";
import { APP_VIEWS, viewFromPath, viewPath } from "@/lib/app-views";
import {
  KiranaStoreCanvas,
  type KiranaStoreCanvasHandle,
} from "@/components/game/KiranaStoreCanvas";
import { useStudio } from "@/lib/store";
import { useVoice } from "@/lib/voice/VoiceProvider";
import { useOfficeActivity } from "@/lib/useOfficeActivity";
import { MAIN_SESSION_KEY } from "@/lib/reducer";
import { isVisibleChatMessage } from "@/lib/constants";
import type { CrewActor } from "@/components/game/three/crew";
import type { Lighting } from "@/components/game/three/StoreRenderer";

// Sidebar + page imports
import AppSidebar, { type AppView } from "@/components/hud/AppSidebar";
import OverviewPage from "@/components/pages/OverviewPage";
import WorkforcePage from "@/components/pages/WorkforcePage";
import WorkflowsPage from "@/components/pages/WorkflowsPage";
import InventoryPage from "@/components/pages/InventoryPage";
import ProcurementPage from "@/components/pages/ProcurementPage";
import FinancePage from "@/components/pages/FinancePage";
import ActivityPage from "@/components/pages/ActivityPage";
import IntegrationsPage from "@/components/pages/IntegrationsPage";
import SettingsPage from "@/components/pages/SettingsPage";
import AnalyticsPage from "@/components/pages/AnalyticsPage";
import SalesPage from "@/components/pages/SalesPage";
import CustomersPage from "@/components/pages/CustomersPage";
import SuppliersPage from "@/components/pages/SuppliersPage";
import CreditPage from "@/components/pages/CreditPage";
import StockLedgerPage from "@/components/pages/StockLedgerPage";
import ChatPage from "@/components/pages/ChatPage";

// Existing secondary panels
import ChatPanel from "@/components/hud/ChatPanel";

// Zone info for the 3D store
const ZONES: Record<string, { title: string; blurb: string }> = {
  groceries: { title: "Grocery Aisles", blurb: "Staples, snacks and packaged foods." },
  produce: { title: "Fresh Produce", blurb: "Fruits and vegetables, restocked daily." },
  dairy: { title: "Dairy & Beverages", blurb: "Chilled milk, curd, paneer and drinks." },
  billing: { title: "Billing Counter", blurb: "Checkout, POS and digital payments." },
  stockroom: { title: "Stockroom", blurb: "Bulk inventory and supplier deliveries." },
  management: { title: "Store Management", blurb: "Sales, finance and reports desk." },
};

// Agent workflow steps shown in the store view's voice panel
const STEPS = [
  { label: "Planning with Manager (Alice)", icon: Store },
  { label: "Checking inventory (Bob)", icon: Package },
  { label: "Analyzing sales demand (Carol)", icon: Activity },
  { label: "Finding suppliers (Dave)", icon: Bot },
  { label: "Preparing recommendation (Erin)", icon: Zap },
];

function VoiceBars({ count, active }: { count: number; active: boolean }) {
  if (!active) return null;
  return (
    <div className="flex items-center gap-[3px]" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="ks-voice-bar"
          style={{ height: 8 + ((i * 37) % 22), animationDelay: `${(i % 7) * 0.11}s` }}
        />
      ))}
    </div>
  );
}

export default function KiranaShell() {
  const canvas = useRef<KiranaStoreCanvasHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  const { state } = useStudio();
  const voice = useVoice();
  const activityMap = useOfficeActivity();

  // The URL is the source of truth for the current view (/app, /app/inventory, ...).
  const router = useRouter();
  const view = viewFromPath(usePathname());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  const [actors, setActors] = useState<CrewActor[]>([]);
  const lastActors = useRef(0);
  const [topDown, setTopDown] = useState(false);
  const [lighting, setLighting] = useState<Lighting>("daylight");
  const [full, setFull] = useState(false);
  const [paused, setPaused] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [step, setStep] = useState(1);

  const onActors = useCallback((a: CrewActor[]) => {
    const now = performance.now();
    if (now - lastActors.current < 400) return;
    lastActors.current = now;
    setActors(a.map((x) => ({ ...x })));
  }, []);

  const activities = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [seatId, info] of Object.entries(activityMap)) {
      const seat = state.seats.find((s) => s.seatId === seatId);
      const crewId = seat?.label?.toLowerCase() ?? seatId.toLowerCase();
      if (info.activity) map[crewId] = info.activity;
    }
    for (const task of state.tasks) {
      if (task.status === "running" && task.seatId) {
        const seat = state.seats.find((s) => s.seatId === task.seatId);
        const crewId = seat?.label?.toLowerCase() ?? task.seatId.toLowerCase();
        if (!map[crewId] && task.message) map[crewId] = task.message.slice(0, 50);
      }
    }
    return map;
  }, [activityMap, state.seats, state.tasks]);

  const assignedSeats = state.seats.filter((s) => s.assigned);
  const workingSeats = assignedSeats.filter(
    (s) => s.status === "running" || s.status === "returning",
  );
  const activeTasks = state.tasks.filter(
    (t) => t.status === "running" || t.status === "submitted" || t.status === "queued",
  );
  const doneTasks = state.tasks.filter((t) => t.status === "completed").length;
  const liveTask = activeTasks[0];
  const failedTasks = state.tasks.filter((t) => t.status === "failed").length;

  const activeSessionKey = state.activeSessionKey ?? MAIN_SESSION_KEY;
  const visibleTasks = useMemo(
    () => state.tasks.filter((task) => task.sessionKey === activeSessionKey),
    [activeSessionKey, state.tasks],
  );
  const visibleMessages = useMemo(
    () =>
      state.chatMessages.filter(
        (m) => m.sessionKey === activeSessionKey && isVisibleChatMessage(m),
      ),
    [activeSessionKey, state.chatMessages],
  );
  const recentMessages = useMemo(() => visibleMessages.slice(-4), [visibleMessages]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (activeTasks.length === 0) {
      setStep(0);
      return;
    }
    const idx = Math.min(activeTasks.length - 1, STEPS.length - 1);
    setStep(idx + 1);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeTasks.length]);

  const sel = actors.find((a) => a.id === selected);

  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shell.current) await shell.current.requestFullscreen();
    } catch {
      toast("Full View isn't available in this browser.");
    }
  };

  function handleMic() {
    if (!voice.active) {
      voice.setMode("voice");
      voice.start();
    } else voice.toggleMute();
  }

  const isVoiceOn = voice.active && !voice.muted;
  const voiceLabel =
    voice.status === "listening"
      ? "Listening..."
      : voice.status === "speaking"
        ? "Speaking..."
        : voice.status === "thinking"
          ? "Processing..."
          : voice.status === "connecting"
            ? "Connecting..."
            : voice.active
              ? "Ready"
              : "Tap to speak";

  const navigate = (requested: AppView | string) => {
    // Pages may pass legacy names ("workers"); anything unknown falls back to the overview.
    const v: AppView =
      requested === "workers"
        ? "workforce"
        : (APP_VIEWS as readonly string[]).includes(requested)
          ? (requested as AppView)
          : "overview";
    if (v !== view) router.push(viewPath(v));
  };

  // useCallback keeps canvas ref access out of useMemo factory (React Compiler requirement)
  const cbRecenter = useCallback(() => {
    canvas.current?.recenter();
  }, []);
  const cbTopDown = useCallback(() => {
    canvas.current?.setTopDown(!topDown);
    setTopDown((v) => !v);
  }, [topDown]);
  const cbPaused = useCallback(() => {
    canvas.current?.setPaused(!paused);
    setPaused((v) => !v);
  }, [paused]);
  const cbLighting = useCallback(() => {
    const n = lighting === "daylight" ? ("evening" as const) : ("daylight" as const);
    canvas.current?.setLighting(n);
    setLighting(n);
  }, [lighting]);

  const toolbarActions = useMemo(
    () => [
      { label: "Recenter", onClick: cbRecenter },
      { label: topDown ? "3D view" : "2D view", onClick: cbTopDown },
      { label: paused ? "Resume" : "Lively", onClick: cbPaused },
      { label: lighting === "daylight" ? "Daylight" : "Evening", onClick: cbLighting },
      { label: full ? "Exit Full" : "Full View", onClick: () => void toggleFull() },
    ],
    [topDown, paused, lighting, full, cbRecenter, cbTopDown, cbPaused, cbLighting, toggleFull],
  );

  function renderContent() {
    switch (view) {
      case "store":
        return null; // handled below in store section
      case "overview":
        return <OverviewPage onNavigate={navigate} />;
      case "chat":
        return (
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", height: "100%" }}>
            <ChatPage />
          </div>
        );
      case "tasks":
        return <ActivityPage />;
      case "workforce":
        return <WorkforcePage />;
      case "workflows":
        return <WorkflowsPage />;
      case "inventory":
        return <InventoryPage />;
      case "procurement":
        return <ProcurementPage />;
      case "sales":
        return <SalesPage />;
      case "finance":
        return <FinancePage />;
      case "customers":
        return <CustomersPage />;
      case "suppliers":
        return <SuppliersPage />;
      case "credit":
        return <CreditPage />;
      case "stock-ledger":
        return <StockLedgerPage />;
      case "analytics":
        return <AnalyticsPage />;
      case "reviews":
        return <ReviewsPlaceholder />;
      case "activity":
        return <ActivityPage />;
      case "integrations":
        return <IntegrationsPage />;
      case "settings":
        return <SettingsPage />;
      default:
        return <OverviewPage onNavigate={navigate} />;
    }
  }

  return (
    <div
      ref={shell}
      className="ks-shell flex h-dvh w-full flex-col overflow-hidden"
      style={{ fontFamily: "var(--font-body, system-ui, sans-serif)" }}
    >
      {/* Compact top bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 20px",
          height: 56,
          minHeight: 56,
          background: "var(--kirana-background)",
          borderBottom: "1px solid var(--kirana-border)",
          flexShrink: 0,
        }}
      >
        {/* Brand */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "grid",
              placeItems: "center",
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "color-mix(in oklab, var(--kirana-primary) 15%, transparent)",
              color: "var(--kirana-primary)",
              flexShrink: 0,
            }}
          >
            <Store size={19} />
          </div>
          <div style={{ lineHeight: 1.2 }}>
            <h1
              style={{
                fontFamily: "var(--font-display, system-ui)",
                fontSize: 20,
                fontWeight: 800,
                color: "var(--kirana-primary)",
                margin: 0,
              }}
            >
              KiranaCrew
            </h1>
            <p style={{ fontSize: 10, color: "var(--kirana-muted-foreground)", margin: 0 }}>
              Retail Operating System
            </p>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {/* Right controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 10,
              border: "1px solid var(--kirana-border)",
              background: "var(--kirana-card)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--kirana-foreground)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background:
                  state.connection === "connected"
                    ? "var(--kirana-success)"
                    : state.connection === "connecting"
                      ? "orange"
                      : "var(--kirana-destructive)",
                flexShrink: 0,
              }}
            />
            {state.connection === "connected"
              ? `${workingSeats.length} active`
              : state.connection === "connecting"
                ? "Connecting…"
                : "Offline"}
          </span>
          <button
            type="button"
            onClick={handleMic}
            title={voiceLabel}
            aria-label="Toggle microphone"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 36,
              height: 36,
              borderRadius: 9,
              border: "1px solid var(--kirana-border)",
              background: voice.active
                ? "color-mix(in oklab, var(--kirana-primary) 18%, transparent)"
                : "var(--kirana-card)",
              color: "var(--kirana-primary)",
              cursor: "pointer",
            }}
          >
            {voice.muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            type="button"
            onClick={() => setNotifications((v) => !v)}
            title="Notifications"
            aria-label="Notifications"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              width: 36,
              height: 36,
              borderRadius: 9,
              border: "1px solid var(--kirana-border)",
              background: "var(--kirana-card)",
              color: "var(--kirana-primary)",
              cursor: "pointer",
            }}
          >
            <Bell size={16} />
            {activeTasks.length > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--kirana-destructive)",
                }}
              />
            )}
          </button>
        </div>
      </header>

      {/* Notifications dropdown */}
      {notifications && (
        <div
          style={{
            position: "absolute",
            right: 20,
            top: 62,
            zIndex: 40,
            width: 280,
            maxHeight: 320,
            overflowY: "auto",
            borderRadius: 12,
            border: "1px solid var(--kirana-border)",
            background: "var(--kirana-popover)",
            padding: 16,
            boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h2
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--kirana-foreground)",
                margin: 0,
              }}
            >
              Active tasks
            </h2>
            <button
              type="button"
              onClick={() => setNotifications(false)}
              style={{
                background: "none",
                border: "none",
                color: "var(--kirana-muted-foreground)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Close
            </button>
          </div>
          {activeTasks.length ? (
            activeTasks.slice(0, 6).map((t) => (
              <div
                key={t.taskId}
                style={{
                  padding: "8px 0",
                  borderBottom: "1px solid var(--kirana-border)",
                  fontSize: 12,
                }}
              >
                <p style={{ color: "var(--kirana-foreground)", fontWeight: 500, margin: 0 }}>
                  {t.message ?? t.taskId}
                </p>
                <p
                  style={{
                    color: "var(--kirana-primary)",
                    margin: "2px 0 0",
                    textTransform: "capitalize",
                  }}
                >
                  {t.status}
                </p>
              </div>
            ))
          ) : (
            <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)" }}>
              No active tasks.
            </p>
          )}
        </div>
      )}

      {/* Body: sidebar + content */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <AppSidebar
          view={view}
          onNavigate={navigate}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
          pendingCount={activeTasks.length}
          alertCount={failedTasks}
        />

        {/* Main content */}
        <main style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
          {view === "store" ? (
            /* Live Store: 3D canvas + voice assistant panel */
            <>
              <section style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
                <KiranaStoreCanvas
                  ref={canvas}
                  onSelect={setSelected}
                  onActors={onActors}
                  onZone={setZone}
                  activities={activities}
                />

                {/* Selected agent card */}
                {sel && (
                  <div
                    style={{
                      position: "absolute",
                      left: 12,
                      top: 12,
                      width: 240,
                      borderRadius: 14,
                      border: "1px solid var(--kirana-border)",
                      background: "color-mix(in oklab, var(--kirana-card) 95%, transparent)",
                      padding: 16,
                      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <div>
                        <h3
                          style={{
                            fontFamily: "var(--font-display, system-ui)",
                            fontSize: 16,
                            fontWeight: 700,
                            color: "var(--kirana-foreground)",
                            margin: 0,
                          }}
                        >
                          {sel.name}
                        </h3>
                        <p
                          style={{
                            fontSize: 12,
                            color: "var(--kirana-primary)",
                            margin: "2px 0 0",
                          }}
                        >
                          {sel.role}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(null);
                          canvas.current?.select(null);
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--kirana-muted-foreground)",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                      >
                        Close
                      </button>
                    </div>
                    <p
                      style={{
                        marginTop: 8,
                        fontSize: 12,
                        color: "var(--kirana-muted-foreground)",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: "var(--kirana-success)",
                          flexShrink: 0,
                        }}
                      />
                      {sel.moving ? "Walking" : sel.activity || "Available"}
                    </p>
                  </div>
                )}

                {/* Zone tooltip */}
                {zone && ZONES[zone] && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: 72,
                      right: 12,
                      width: 272,
                      borderRadius: 14,
                      border: "1px solid var(--kirana-border)",
                      background: "color-mix(in oklab, var(--kirana-card) 95%, transparent)",
                      padding: 16,
                      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <h3
                        style={{
                          fontFamily: "var(--font-display, system-ui)",
                          fontSize: 16,
                          fontWeight: 700,
                          color: "var(--kirana-foreground)",
                          margin: 0,
                        }}
                      >
                        {ZONES[zone]?.title}
                      </h3>
                      <button
                        type="button"
                        onClick={() => setZone(null)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--kirana-muted-foreground)",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                      >
                        Close
                      </button>
                    </div>
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--kirana-muted-foreground)",
                        marginTop: 4,
                      }}
                    >
                      {ZONES[zone]?.blurb}
                    </p>
                  </div>
                )}

                {/* Bottom toolbar */}
                <div
                  style={{
                    position: "absolute",
                    bottom: 12,
                    left: 0,
                    right: 0,
                    display: "flex",
                    justifyContent: "center",
                    padding: "0 12px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: 6,
                      borderRadius: 16,
                      border: "1px solid var(--kirana-border)",
                      background: "color-mix(in oklab, var(--kirana-card) 95%, transparent)",
                      backdropFilter: "blur(12px)",
                      fontSize: 12,
                    }}
                  >
                    {
                      // eslint-disable-next-line react-hooks/refs
                      toolbarActions.map(({ label, onClick }) => (
                        <button
                          key={label}
                          type="button"
                          onClick={onClick}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 10,
                            border: "none",
                            background: "transparent",
                            color: "oklch(0.96 0.015 85 / 0.8)",
                            cursor: "pointer",
                            fontSize: 12,
                            whiteSpace: "nowrap",
                            fontFamily: "var(--font-body, system-ui)",
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.background = "var(--kirana-accent)")
                          }
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          {label}
                        </button>
                      ))
                    }
                    <button
                      type="button"
                      title="Drag to pan · Right-drag to rotate · Scroll to zoom"
                      onClick={() =>
                        toast(
                          "Drag to pan · Right-drag to rotate · Scroll to zoom · Click a crew member",
                        )
                      }
                      style={{
                        padding: "4px 8px",
                        borderRadius: 10,
                        border: "none",
                        background: "transparent",
                        color: "var(--kirana-muted-foreground)",
                        cursor: "pointer",
                      }}
                    >
                      <Keyboard size={14} />
                    </button>
                  </div>
                </div>
              </section>

              {/* Voice assistant panel — only on store view */}
              {!full && (
                <aside
                  style={{
                    width: 300,
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    overflowY: "auto",
                    borderLeft: "1px solid var(--kirana-border)",
                    background: "var(--kirana-card)",
                    padding: 16,
                    gap: 0,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Mic size={18} style={{ color: "var(--kirana-primary)", flexShrink: 0 }} />
                    <h2
                      style={{
                        fontFamily: "var(--font-display, system-ui)",
                        fontSize: 17,
                        fontWeight: 700,
                        color: "var(--kirana-foreground)",
                        margin: 0,
                        flex: 1,
                      }}
                    >
                      KiranaCrew Assistant
                    </h2>
                    <span
                      style={{
                        background: "var(--kirana-primary)",
                        color: "var(--kirana-primary-foreground)",
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "2px 7px",
                        borderRadius: 6,
                      }}
                    >
                      Voice First
                    </span>
                  </div>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--kirana-muted-foreground)",
                      margin: "4px 0 0",
                    }}
                  >
                    Talk to your AI store team in Kannada, Hindi or English.
                  </p>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 16,
                      margin: "20px 0",
                    }}
                  >
                    <VoiceBars count={9} active={isVoiceOn} />
                    <button
                      type="button"
                      aria-label={
                        voice.active ? (voice.muted ? "Unmute" : "Mute") : "Start voice assistant"
                      }
                      onClick={handleMic}
                      className="ks-mic-orb"
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 96,
                        height: 96,
                        borderRadius: "50%",
                        border: "none",
                        cursor: "pointer",
                        color: "oklch(0.18 0.02 60)",
                        flexShrink: 0,
                        boxShadow: voice.active
                          ? "0 0 0 10px color-mix(in oklab, var(--kirana-primary) 14%, transparent), 0 0 60px color-mix(in oklab, var(--kirana-primary) 55%, transparent)"
                          : "0 0 0 8px color-mix(in oklab, var(--kirana-primary) 8%, transparent)",
                      }}
                    >
                      {voice.muted ? <MicOff size={38} /> : <Mic size={38} />}
                    </button>
                    <VoiceBars count={9} active={isVoiceOn} />
                  </div>

                  <p
                    style={{
                      textAlign: "center",
                      fontFamily: "var(--font-display, system-ui)",
                      fontWeight: 700,
                      color: "var(--kirana-primary)",
                      fontSize: 14,
                      margin: "0 0 12px",
                    }}
                  >
                    {voiceLabel}
                  </p>

                  {recentMessages.length > 0 && (
                    <div
                      style={{
                        borderRadius: 12,
                        border: "1px solid var(--kirana-border)",
                        padding: 12,
                        marginBottom: 12,
                        fontSize: 12,
                      }}
                    >
                      <p
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: "var(--kirana-primary)",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          margin: "0 0 6px",
                        }}
                      >
                        Live Transcript
                      </p>
                      {recentMessages.slice(-3).map((msg) => (
                        <div
                          key={msg.id}
                          style={{
                            padding: "3px 0",
                            borderBottom:
                              "1px solid color-mix(in oklab, var(--kirana-border) 50%, transparent)",
                          }}
                        >
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              color:
                                msg.role === "user"
                                  ? "oklch(0.6 0.15 220)"
                                  : "var(--kirana-primary)",
                              textTransform: "uppercase",
                              marginRight: 4,
                            }}
                          >
                            {msg.role === "user" ? "You" : (msg.actorName ?? "AI")}
                          </span>
                          <span style={{ color: "var(--kirana-foreground)", opacity: 0.8 }}>
                            {msg.content?.slice(0, 80)}
                            {(msg.content?.length ?? 0) > 80 ? "…" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <ul
                    style={{
                      listStyle: "none",
                      margin: "0 0 12px",
                      padding: 0,
                      borderRadius: 12,
                      border: "1px solid var(--kirana-border)",
                      overflow: "hidden",
                    }}
                  >
                    {STEPS.map(({ label, icon: Icon }, i) => {
                      const stepState = i < step ? "done" : i === step ? "active" : "todo";
                      return (
                        <li
                          key={label}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "8px 12px",
                            borderBottom:
                              i < STEPS.length - 1
                                ? "1px solid color-mix(in oklab, var(--kirana-border) 50%, transparent)"
                                : "none",
                            fontSize: 12,
                          }}
                        >
                          <span
                            style={{
                              display: "grid",
                              placeItems: "center",
                              width: 28,
                              height: 28,
                              borderRadius: 8,
                              flexShrink: 0,
                              background: "var(--kirana-accent)",
                              color: "var(--kirana-primary)",
                            }}
                          >
                            <Icon size={14} />
                          </span>
                          <span
                            style={{
                              flex: 1,
                              color:
                                stepState === "todo"
                                  ? "var(--kirana-muted-foreground)"
                                  : "var(--kirana-foreground)",
                            }}
                          >
                            {label}
                          </span>
                          <span style={{ flexShrink: 0 }}>
                            {stepState === "done" ? (
                              <Check size={14} style={{ color: "var(--kirana-success)" }} />
                            ) : stepState === "active" ? (
                              <Loader2
                                size={14}
                                style={{
                                  color: "var(--kirana-primary)",
                                  animation: "spin 1s linear infinite",
                                }}
                              />
                            ) : (
                              <span
                                style={{
                                  display: "block",
                                  width: 6,
                                  height: 6,
                                  borderRadius: "50%",
                                  background: "var(--kirana-muted-foreground)",
                                  opacity: 0.4,
                                }}
                              />
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>

                  <div
                    style={{
                      borderRadius: 12,
                      border: "1px solid var(--kirana-border)",
                      padding: 12,
                      marginBottom: "auto",
                    }}
                  >
                    <p
                      style={{
                        fontSize: 10,
                        color: "var(--kirana-primary)",
                        fontWeight: 600,
                        margin: "0 0 4px",
                      }}
                    >
                      Current task
                    </p>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <Package
                        size={14}
                        style={{ color: "var(--kirana-primary)", flexShrink: 0 }}
                      />
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "var(--kirana-foreground)",
                        }}
                      >
                        {liveTask ? (liveTask.message ?? liveTask.taskId) : "Waiting for task…"}
                      </span>
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 6,
                          background: "var(--kirana-accent)",
                          color: liveTask
                            ? "var(--kirana-success)"
                            : "var(--kirana-muted-foreground)",
                        }}
                      >
                        {liveTask ? "Live data" : "Idle"}
                      </span>
                    </div>
                  </div>

                  <div style={{ paddingTop: 16, textAlign: "center" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "center",
                        gap: 3,
                        marginBottom: 10,
                      }}
                    >
                      {Array.from({ length: 26 }, (_, i) => (
                        <span
                          key={i}
                          className="ks-voice-bar"
                          style={{
                            height: 8 + ((i * 37) % 22),
                            animationDelay: `${(i % 7) * 0.11}s`,
                            opacity: isVoiceOn ? 1 : 0.3,
                          }}
                        />
                      ))}
                    </div>
                    <p style={{ fontSize: 12, color: "var(--kirana-muted-foreground)", margin: 0 }}>
                      Powered by{" "}
                      <b
                        style={{
                          fontFamily: "var(--font-display, system-ui)",
                          fontSize: 14,
                          color: "var(--kirana-primary)",
                        }}
                      >
                        Gnani AI
                      </b>
                    </p>
                    <p style={{ fontSize: 10, color: "var(--kirana-muted-foreground)", margin: 0 }}>
                      Prisma STT · Timbre TTS · Evon (self-hosted)
                    </p>
                  </div>
                </aside>
              )}
            </>
          ) : (
            /* All other views: full-width page component */
            <section
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {renderContent()}
            </section>
          )}
        </main>
      </div>

      {/* Status footer */}
      <footer
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: "6px 20px",
          fontSize: 11,
          color: "var(--kirana-muted-foreground)",
          borderTop: "1px solid var(--kirana-border)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            padding: "4px 12px",
            borderRadius: 8,
            border: "1px solid var(--kirana-border)",
            background: "var(--kirana-card)",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background:
                  state.connection === "connected"
                    ? "var(--kirana-success)"
                    : state.connection === "connecting"
                      ? "orange"
                      : "var(--kirana-destructive)",
              }}
            />
            {state.connection === "connected"
              ? "Online"
              : state.connection === "connecting"
                ? "Connecting"
                : "Offline"}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Bot size={12} /> {assignedSeats.length} crew
          </span>
          <span>{doneTasks} tasks done</span>
          {failedTasks > 0 && (
            <span style={{ color: "var(--kirana-destructive)" }}>{failedTasks} failed</span>
          )}
          <span>
            CONTEXT <b style={{ color: "var(--kirana-foreground)" }}>KiranaCrew</b>
          </span>
        </span>
      </footer>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ReviewsPlaceholder() {
  return (
    <div
      style={{
        padding: "24px 28px",
        overflowY: "auto",
        height: "100%",
        color: "var(--kirana-foreground)",
      }}
    >
      <h1
        style={{
          fontFamily: "var(--font-display,system-ui)",
          fontSize: 26,
          fontWeight: 800,
          color: "var(--kirana-foreground)",
          margin: "0 0 4px",
        }}
      >
        Reviews
      </h1>
      <p style={{ fontSize: 13, color: "var(--kirana-muted-foreground)", margin: "0 0 24px" }}>
        Customer ratings and feedback
      </p>
      <div
        style={{
          background: "var(--kirana-card)",
          border: "1px solid var(--kirana-border)",
          borderRadius: 14,
          padding: 60,
          textAlign: "center",
        }}
      >
        <p
          style={{
            color: "var(--kirana-foreground)",
            fontSize: 15,
            fontWeight: 600,
            margin: "0 0 8px",
          }}
        >
          No reviews connected
        </p>
        <p style={{ color: "var(--kirana-muted-foreground)", fontSize: 13 }}>
          Customer ratings and feedback require a POS integration. Connect your ERPNext POS to see
          customer reviews.
        </p>
      </div>
    </div>
  );
}
