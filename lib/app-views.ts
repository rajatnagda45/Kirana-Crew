/**
 * Workspace views and their URLs. Shared by the `/app/[view]` route (server) and the shell and
 * sidebar (client), so a view cannot exist in one place and 404 in the other.
 */
export const APP_VIEWS = [
  "overview",
  "store",
  "chat",
  "tasks",
  "workforce",
  "workflows",
  "inventory",
  "procurement",
  "sales",
  "finance",
  "customers",
  "suppliers",
  "credit",
  "stock-ledger",
  "analytics",
  "reviews",
  "activity",
  "integrations",
  "settings",
] as const;

export type AppView = (typeof APP_VIEWS)[number];

/**
 * URL slug per view. `chat` (the in-shell inbox) is `/app/inbox` because `/app/chat` is the
 * separate full-page Chat Center route. `overview` is `/app` itself.
 */
const SLUG: Partial<Record<AppView, string>> = { chat: "inbox" };

export function viewPath(view: AppView): string {
  if (view === "overview") return "/app";
  return `/app/${SLUG[view] ?? view}`;
}

/** The view for a workspace URL, or null when the URL is not a workspace view. */
export function viewFromSlug(slug: string | undefined): AppView | null {
  if (!slug) return "overview";
  const bySlug = (Object.entries(SLUG) as Array<[AppView, string]>).find(([, s]) => s === slug);
  if (bySlug) return bySlug[0];
  if (slug === "chat") return null;
  return (APP_VIEWS as readonly string[]).includes(slug) ? (slug as AppView) : null;
}

export function viewFromPath(pathname: string | null): AppView {
  const match = /^\/app(?:\/([^/?#]+))?\/?$/.exec(pathname ?? "/app");
  return (match && viewFromSlug(match[1])) || "overview";
}
