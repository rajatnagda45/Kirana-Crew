import { randomUUID } from "node:crypto";
import { DASHBOARD_PRINCIPAL } from "./dashboards.mjs";

/**
 * Real product and customer names for the language-understanding step. Gemini enums cannot
 * be built from a dynamic list at module load, so the names are read from the governed ERP
 * binding (`erp.items.list`, `erp.customers.list`, under the read-only dashboard principal)
 * into a short-lived snapshot and injected into each request's schema: the model can then
 * only return a real name or "(none)", never invent one.
 *
 * Cost control: 60 s TTL, single-flight refresh, stale-while-revalidate, and an analysis
 * never waits for a fetch longer than `FETCH_WAIT_MS` (~1 s); past that it runs without
 * names, which is exactly today's behaviour (corrections stay off). Pre-warmed at start-up
 * so the first turn already has names.
 */

const TTL_MS = 60_000;
const FETCH_WAIT_MS = 1_000;
/** Gemini prompt space is finite; a roster larger than this runs without customer enums. */
const MAX_CUSTOMER_NAMES = 80;
const MAX_ITEM_NAMES = 200;

/**
 * @param {{ binding: any, log?: (msg: string) => void, now?: () => number }} deps
 */
export function createEntitySnapshot({ binding, log, now = () => Date.now() }) {
  /** @type {{ products: string[], customers: string[], at: number } | null} */
  let snapshot = null;
  /** The refresh in flight, if any (single-flight: several callers share one fetch). */
  let fetching = null;

  async function fetchEntities() {
    const correlationId = `entities:${randomUUID()}`;
    const [items, customers] = await Promise.all([
      binding.call(DASHBOARD_PRINCIPAL, "erp.items.list", {}, { correlationId }),
      binding.call(DASHBOARD_PRINCIPAL, "erp.customers.list", {}, { correlationId }),
    ]);
    const products = (items?.data?.items ?? [])
      .map((row) => String(row?.item_name ?? "").trim())
      .filter(Boolean)
      .slice(0, MAX_ITEM_NAMES);
    const customerNames = (customers?.data?.customers ?? [])
      .map((row) => String(row?.name ?? "").trim())
      .filter(Boolean)
      .slice(0, MAX_CUSTOMER_NAMES);
    if (!products.length) {
      // Empty is indistinguishable from unavailable; keep it off so the model is not
      // constrained to a broken read.
      log?.("[nammaops] entity snapshot is empty; analysis runs without catalogue names");
      return null;
    }
    return { products, customers: customerNames, at: now() };
  }

  function startRefresh() {
    if (fetching) return fetching;
    fetching = fetchEntities()
      .then((value) => {
        if (value) snapshot = value;
      })
      .catch((error) => {
        // Names are a prompt nicety only; the next turn tries again (stale names keep serving).
        log?.(`[nammaops] entity snapshot unavailable: ${String(error?.message ?? error).slice(0, 200)}`);
      })
      .finally(() => {
        fetching = null;
      });
    return fetching;
  }

  return {
    /** Warm the cache at server start, without blocking it. */
    prewarm() {
      startRefresh();
    },

    /**
     * The names for the next analysis. Fresh ones instantly; a stale-but-present snapshot
     * serves while a refresh runs; a first-ever fetch is awaited for at most 1 s.
     * @returns {Promise<{ products: string[], customers: string[] } | null>}
     */
    async get() {
      if (!binding) return null;
      if (!snapshot || (snapshot && now() - snapshot.at > TTL_MS)) startRefresh();
      if (snapshot && now() - snapshot.at <= TTL_MS)
        return { products: snapshot.products, customers: snapshot.customers };
      if (!fetching) return null;
      // A cold cache: one bounded wait, then analysis continues without names.
      const timeout = Symbol("timeout");
      const raced = await Promise.race([
        fetching.then(() => Symbol("done")),
        new Promise((r) => setTimeout(() => r(timeout), FETCH_WAIT_MS)),
      ]).catch(() => null);
      if (raced === Symbol("timeout")) return null;
      return snapshot
        ? { products: snapshot.products, customers: snapshot.customers }
        : null;
    },

    status() {
      if (!snapshot) return { available: false, products: 0, customers: 0 };
      return {
        available: true,
        age_ms: now() - snapshot.at,
        products: snapshot.products.length,
        customers: snapshot.customers.length,
      };
    },
  };
}
