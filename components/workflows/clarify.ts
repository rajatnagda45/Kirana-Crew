/**
 * Answering a clarification. The server has no "resume" endpoint: voice and chat continue by
 * starting a NEW run with corrected arguments, and so does this page. This module decides which
 * questions can be answered here and builds the new intent from the ORIGINAL one (the answer
 * replaces the matching product, it is never just appended).
 */
import type { Clarification, WorkflowIntent, WorkflowView } from "@/lib/workflow-contract";
import { parseProducts } from "./definitions";

/** The reasons whose answer is simply a product name. Others (quantities, customers, units) are shown read-only. */
const PRODUCT_REASONS = new Set(["missing_product", "unknown", "ambiguous"]);

export interface Question {
  index: number;
  clarification: Clarification;
  /** "product": free text or a choice. "readonly": cannot be answered on this page. */
  mode: "product" | "readonly";
  /**
   * Whole-group choices offered for an unknown product. The server sends `categories` as
   * { "<group name>": [product names] }; the group names are the choices.
   */
  groups: string[];
  /** How many products each group holds, for the button label. */
  groupSizes: Record<string, number>;
  options: string[];
}

export function questionsFor(view: Pick<WorkflowView, "clarifications">): Question[] {
  return (view.clarifications ?? []).map((clarification, index) => ({
    index,
    clarification,
    mode: PRODUCT_REASONS.has(clarification.reason) ? "product" : "readonly",
    groups: Object.keys(clarification.categories ?? {}),
    groupSizes: Object.fromEntries(
      Object.entries(clarification.categories ?? {}).map(([name, products]) => [name, Array.isArray(products) ? products.length : 0]),
    ),
    options: (clarification.options ?? []).filter((o): o is string => typeof o === "string"),
  }));
}

/** True when every question can be answered here (so the "run again" form can be offered). */
export const canAnswerHere = (view: Pick<WorkflowView, "clarifications">): boolean => {
  const questions = questionsFor(view);
  return questions.length > 0 && questions.every((q) => q.mode === "product");
};

/**
 * Swaps `requested` for `answer` in the product list. If the original had no such entry (for
 * example it was missing altogether) the answer is added; an answer typed as "Milk, Curd" counts
 * as several products.
 */
export function replaceProduct(products: string[] | undefined, requested: string, answer: string): string[] {
  const wanted = parseProducts(answer);
  const list = products ?? [];
  const at = requested ? list.findIndex((p) => p.toLowerCase() === requested.toLowerCase()) : -1;
  const next = at >= 0 ? [...list.slice(0, at), ...wanted, ...list.slice(at + 1)] : [...list, ...wanted];
  // Drop repeats (case-blind) without re-splitting, so a product name containing a comma stays whole.
  const seen = new Set<string>();
  return next.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The new intent for a re-run. Everything else in the original intent (dates, quantity, ...) is kept.
 * Returns an error in plain words when an answer is missing.
 */
export function mergeAnswers(
  intent: WorkflowIntent | undefined,
  questions: Question[],
  answers: Record<number, string>,
): { intent?: WorkflowIntent; error?: string } {
  if (!intent?.action) return { error: "The original request is not available, so it cannot be repeated." };
  let products = intent.products;
  for (const q of questions) {
    if (q.mode !== "product") return { error: "Part of this question cannot be answered here." };
    const answer = (answers[q.index] ?? "").trim();
    if (!answer) return { error: "Answer every question first." };
    products = replaceProduct(products, q.clarification.requested, answer);
  }
  if (products && products.length > 20) return { error: "Use at most 20 products." };
  return { intent: { ...intent, ...(products ? { products } : {}) } };
}

// ── Remembering which run answered which (this browser tab only) ───────────

const KEY = "nammaops-answered-runs";

export function readAnsweredLinks(): Record<string, string> {
  try {
    if (typeof window === "undefined") return {};
    const parsed = JSON.parse(window.sessionStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // blocked storage or corrupt JSON: no links, and nothing breaks
  }
}

export function saveAnsweredLink(oldId: string, newId: string): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(KEY, JSON.stringify({ ...readAnsweredLinks(), [oldId]: newId }));
  } catch {
    /* the link is a convenience only */
  }
}
