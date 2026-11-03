"use client";
import {
  LayoutDashboard,
  Store,
  MessageSquareText,
  CheckSquare,
  Users,
  Zap,
  Package,
  ShoppingCart,
  BarChart3,
  DollarSign,
  UserCheck,
  TrendingUp,
  Star,
  Activity,
  Plug,
  Settings,
  ChevronLeft,
  ChevronRight,
  Truck,
  HandCoins,
  Receipt,
  ScrollText,
} from "lucide-react";
import Link from "next/link";
import { viewPath, type AppView } from "@/lib/app-views";

export type { AppView } from "@/lib/app-views";

interface NavItem {
  view: AppView;
  label: string;
  icon: typeof Store;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Command Center",
    items: [
      { view: "overview", label: "Overview", icon: LayoutDashboard },
      { view: "store", label: "Live Store", icon: Store },
    ],
  },
  {
    label: "AI Workforce",
    items: [
      { view: "chat", label: "Chat & Inbox", icon: MessageSquareText },
      { view: "tasks", label: "Tasks & Approvals", icon: CheckSquare },
      { view: "workforce", label: "AI Workforce", icon: Users },
      { view: "workflows", label: "Workflows", icon: Zap },
    ],
  },
  {
    label: "Retail Operations",
    items: [
      { view: "inventory", label: "Inventory", icon: Package },
      { view: "procurement", label: "Procurement", icon: ShoppingCart },
      { view: "sales", label: "Sales & Billing", icon: BarChart3 },
      { view: "finance", label: "Finance", icon: DollarSign },
      { view: "customers", label: "Customers", icon: UserCheck },
      { view: "suppliers", label: "Suppliers & Payables", icon: Truck },
      { view: "credit", label: "Credit / Udhaar", icon: HandCoins },
      { view: "stock-ledger", label: "Stock Ledger & Expiry", icon: ScrollText },
    ],
  },
  {
    label: "Business Intelligence",
    items: [
      { view: "analytics", label: "Analytics", icon: TrendingUp },
      { view: "gst", label: "GST & Tax", icon: Receipt },
      { view: "reviews", label: "Reviews", icon: Star },
      { view: "activity", label: "Activity Logs", icon: Activity },
    ],
  },
  {
    label: "Administration",
    items: [
      { view: "integrations", label: "Integrations", icon: Plug },
      { view: "settings", label: "Settings", icon: Settings },
    ],
  },
];

interface AppSidebarProps {
  view: AppView;
  onNavigate: (v: AppView) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  pendingCount?: number;
  alertCount?: number;
}

export default function AppSidebar({
  view,
  onNavigate,
  collapsed,
  onToggleCollapse,
  pendingCount = 0,
  alertCount = 0,
}: AppSidebarProps) {
  const w = collapsed ? 52 : 220;

  return (
    <aside
      style={{
        width: w,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--kirana-card)",
        borderRight: "1px solid var(--kirana-border)",
        transition: "width 0.2s ease",
        overflow: "hidden",
        position: "relative",
        userSelect: "none",
      }}
    >
      {/* Collapse toggle */}
      <button
        type="button"
        onClick={onToggleCollapse}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        style={{
          position: "absolute",
          top: 10,
          right: -12,
          zIndex: 10,
          width: 24,
          height: 24,
          borderRadius: "50%",
          border: "1px solid var(--kirana-border)",
          background: "var(--kirana-card)",
          color: "var(--kirana-muted-foreground)",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* Scrollable nav */}
      <nav
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: collapsed ? "10px 0" : "10px 0",
        }}
      >
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label} style={{ marginBottom: collapsed ? 8 : 4 }}>
            {!collapsed && (
              <p
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.8px",
                  color: "var(--kirana-muted-foreground)",
                  margin: "0 0 3px",
                  padding: "0 14px",
                }}
              >
                {group.label}
              </p>
            )}
            {collapsed && gi > 0 && (
              <div style={{ height: 1, background: "var(--kirana-border)", margin: "6px 8px" }} />
            )}
            {group.items.map((item) => {
              const active = view === item.view;
              const badge =
                item.view === "tasks" && pendingCount > 0
                  ? pendingCount
                  : item.view === "overview" && alertCount > 0
                    ? alertCount
                    : 0;

              return (
                <Link
                  key={item.view}
                  href={viewPath(item.view)}
                  aria-current={active ? "page" : undefined}
                  onClick={(e) => {
                    // Plain clicks go through the shell; modified clicks open a new tab as usual.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onNavigate(item.view);
                  }}
                  title={collapsed ? item.label : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    width: "100%",
                    padding: collapsed ? "8px 0" : "7px 14px",
                    justifyContent: collapsed ? "center" : "flex-start",
                    border: "none",
                    textDecoration: "none",
                    boxSizing: "border-box",
                    background: active
                      ? "color-mix(in oklab,var(--kirana-primary) 14%,transparent)"
                      : "transparent",
                    color: active ? "var(--kirana-primary)" : "var(--kirana-muted-foreground)",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: active ? 700 : 500,
                    transition: "background 0.1s, color 0.1s",
                    position: "relative",
                    whiteSpace: "nowrap",
                    borderLeft:
                      active && !collapsed
                        ? "2px solid var(--kirana-primary)"
                        : "2px solid transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!active)
                      (e.currentTarget as HTMLAnchorElement).style.background =
                        "color-mix(in oklab,var(--kirana-foreground) 6%,transparent)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active)
                      (e.currentTarget as HTMLAnchorElement).style.background = "transparent";
                  }}
                >
                  <item.icon size={15} style={{ flexShrink: 0 }} />
                  {!collapsed && <span style={{ flex: 1, textAlign: "left" }}>{item.label}</span>}
                  {!collapsed && badge > 0 && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        minWidth: 18,
                        height: 18,
                        borderRadius: 9,
                        background: "var(--kirana-primary)",
                        color: "var(--kirana-primary-foreground)",
                        display: "grid",
                        placeItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                  {collapsed && badge > 0 && (
                    <span
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--kirana-primary)",
                        flexShrink: 0,
                      }}
                    />
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
