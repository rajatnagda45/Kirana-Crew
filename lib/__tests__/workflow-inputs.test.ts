import { describe, expect, it } from "vitest";
import {
  buildIntent,
  definitionFor,
  parseProducts,
  REORDER_SUGGESTION_ACTION,
  WORKFLOW_DEFS,
} from "../../components/workflows/definitions";
import {
  canAnswerHere,
  mergeAnswers,
  questionsFor,
  readAnsweredLinks,
  replaceProduct,
  saveAnsweredLink,
} from "../../components/workflows/clarify";

// The keys the server's intent schema accepts (lib/server/nammaops/workflows.mjs, additionalProperties: false).
const ALLOWED = new Set([
  "action",
  "products",
  "date",
  "to",
  "with_profit",
  "focus",
  "qty",
  "po_name",
  "customer",
  "lines",
]);
const def = (action: string) => definitionFor(action)!;

describe("workflow cards", () => {
  it("offers the 15 supported workflows and never the one that writes to the ERP", () => {
    const actions = WORKFLOW_DEFS.map((d) => d.action);
    expect(actions).toHaveLength(15);
    expect(new Set(actions).size).toBe(15);
    expect(actions).not.toContain("prepare_bill");
    expect(def(REORDER_SUGGESTION_ACTION)).toBeDefined();
  });

  it("only ever builds intents with keys the server accepts, whatever is typed", () => {
    for (const d of WORKFLOW_DEFS) {
      const values = Object.fromEntries(
        d.fields.map((f) => [
          f.key,
          f.type === "date"
            ? "2026-11-01"
            : f.type === "number"
              ? "5"
              : f.type === "checkbox"
                ? false
                : f.type === "select"
                  ? "new"
                  : f.key === "po_name"
                    ? "PUR-ORD-1"
                    : "Milk",
        ]),
      );
      const { intent, errors } = buildIntent(d, {
        ...values,
        injected: "x",
        action: "delete_everything",
      });
      expect(errors).toEqual({});
      expect(Object.keys(intent!).every((k) => ALLOWED.has(k))).toBe(true);
      expect(intent!.action).toBe(d.action); // an "action" field in the values can never change it
    }
  });

  it("builds the minimal intent when nothing is typed", () => {
    expect(buildIntent(def("stock_check"), {}).intent).toEqual({ action: "stock_check" });
    expect(buildIntent(def("daily_report"), {}).intent).toEqual({ action: "daily_report" });
    expect(buildIntent(def("expiry_check"), {}).intent).toEqual({ action: "expiry_check" });
  });

  it("sends profit off only when the owner unticks it", () => {
    expect(buildIntent(def("daily_report"), { with_profit: true }).intent).toEqual({
      action: "daily_report",
    });
    expect(buildIntent(def("daily_report"), { with_profit: false }).intent).toEqual({
      action: "daily_report",
      with_profit: false,
    });
  });

  it("cleans product lists: trims, drops empties and repeats, keeps the owner's spelling", () => {
    expect(parseProducts(" Milk, rice ,, MILK ,Curd")).toEqual(["Milk", "rice", "Curd"]);
    expect(
      buildIntent(def("supplier_comparison"), { products: "Atta, Rice, Sugar" }).intent,
    ).toEqual({
      action: "supplier_comparison",
      products: ["Atta", "Rice", "Sugar"],
    });
    expect(buildIntent(def("stock_check"), { products: " , ," }).intent).toEqual({
      action: "stock_check",
    });
  });

  it("requires what the server requires, in plain words", () => {
    expect(buildIntent(def("supplier_comparison"), {}).errors.products).toBe(
      "Products to compare is needed.",
    );
    expect(
      buildIntent(def("supplier_comparison"), { products: " , " }).errors.products,
    ).toBeTruthy();
    expect(buildIntent(def("purchase_order_lookup"), {}).errors.po_name).toBe(
      "Purchase order number is needed.",
    );
    expect(
      buildIntent(def("purchase_order_lookup"), { po_name: "PUR-ORD-2026-00004" }).intent,
    ).toEqual({
      action: "purchase_order_lookup",
      po_name: "PUR-ORD-2026-00004",
    });
    expect(
      buildIntent(def("purchase_order_lookup"), { po_name: "bad/name;" }).errors.po_name,
    ).toMatch(/letters, numbers/);
  });

  it("checks quantities, product limits and date ranges before sending", () => {
    for (const bad of ["0", "-3", "2.5", "100001", "abc"])
      expect(
        buildIntent(def("supplier_comparison"), { products: "Atta", qty: bad }).errors.qty,
      ).toMatch(/whole number/);
    expect(
      buildIntent(def("supplier_comparison"), { products: "Atta", qty: "12" }).intent?.qty,
    ).toBe(12);
    expect(
      buildIntent(def("stock_check"), {
        products: Array.from({ length: 21 }, (_, i) => `P${i}`).join(","),
      }).errors.products,
    ).toMatch(/at most 20/);
    expect(buildIntent(def("stock_check"), { products: "x".repeat(61) }).errors.products).toMatch(
      /under 60/,
    );

    expect(buildIntent(def("business_report"), { to: "2026-11-05" }).errors.to).toMatch(
      /start date/,
    );
    expect(
      buildIntent(def("business_report"), { date: "2026-11-10", to: "2026-11-01" }).errors.to,
    ).toMatch(/before the start/);
    expect(
      buildIntent(def("business_report"), { date: "2026-10-01", to: "2026-11-01" }).errors.to,
    ).toMatch(/at most 31 days/);
    expect(
      buildIntent(def("business_report"), { date: "2026-10-01", to: "2026-10-31" }).intent,
    ).toEqual({
      action: "business_report",
      date: "2026-10-01",
      to: "2026-10-31",
    });
    expect(buildIntent(def("billing_summary"), { date: "garbage" }).errors.date).toBe(
      "Choose a date.",
    );
  });

  it("maps the udhaar choice to the focus the server accepts", () => {
    expect(buildIntent(def("receivables_report"), { focus: "" }).intent).toEqual({
      action: "receivables_report",
    });
    expect(buildIntent(def("receivables_report"), { focus: "due_soon" }).intent).toEqual({
      action: "receivables_report",
      focus: "due_soon",
    });
    expect(buildIntent(def("receivables_report"), { focus: "everything" }).intent).toEqual({
      action: "receivables_report",
    });
  });
});

describe("answering a clarification", () => {
  const view = (clarifications: any[]) => ({ clarifications }); // eslint-disable-line @typescript-eslint/no-explicit-any

  it("replaces the matching product rather than adding to the list", () => {
    expect(replaceProduct(["oil", "rice"], "oil", "Coconut Oil 500ml")).toEqual([
      "Coconut Oil 500ml",
      "rice",
    ]);
    expect(replaceProduct(["OIL"], "oil", "Coconut Oil 500ml")).toEqual(["Coconut Oil 500ml"]);
    expect(replaceProduct(undefined, "", "Atta, Rice")).toEqual(["Atta", "Rice"]);
    expect(replaceProduct(["rice"], "oil", "oil 1L")).toEqual(["rice", "oil 1L"]); // nothing to replace: added once
    expect(replaceProduct(["rice", "oil"], "oil", "rice")).toEqual(["rice"]); // no repeats
    expect(replaceProduct(["Salt, iodised 1kg"], "x", "Rice")).toEqual([
      "Salt, iodised 1kg",
      "Rice",
    ]); // a comma inside a name survives
  });

  it("keeps everything else in the original request", () => {
    const questions = questionsFor(
      view([{ requested: "oil", reason: "ambiguous", options: ["A", "B"] }]),
    );
    const merged = mergeAnswers(
      { action: "demand_forecast", products: ["oil", "rice"], date: "2026-11-01", qty: 3 },
      questions,
      { 0: "B" },
    );
    expect(merged.intent).toEqual({
      action: "demand_forecast",
      products: ["B", "rice"],
      date: "2026-11-01",
      qty: 3,
    });
  });

  it("needs every question answered, and a request to repeat", () => {
    const questions = questionsFor(
      view([{ requested: "", reason: "missing_product", options: [] }]),
    );
    expect(mergeAnswers({ action: "supplier_comparison" }, questions, {}).error).toMatch(
      /Answer every question/,
    );
    expect(mergeAnswers({ action: "supplier_comparison" }, questions, { 0: "   " }).error).toMatch(
      /Answer every question/,
    );
    expect(mergeAnswers(undefined, questions, { 0: "Atta" }).error).toMatch(/original request/);
  });

  it("offers answers only for questions that are a product name, and offers groups for an unknown product", () => {
    // The server sends categories as { "<group name>": [product names] }; the group names are the choices.
    const q = questionsFor(
      view([
        {
          requested: "paneer",
          reason: "unknown",
          options: [],
          categories: { Dairy: ["Milk 500ml", "Curd 400g"], Snacks: ["Chips 50g"] },
        },
      ]),
    );
    expect(q[0]).toMatchObject({
      mode: "product",
      groups: ["Dairy", "Snacks"],
      groupSizes: { Dairy: 2, Snacks: 1 },
    });
    expect(q[0].groups).not.toContain("Milk 500ml"); // product names are not group choices
    expect(canAnswerHere(view([{ requested: "x", reason: "ambiguous", options: ["a"] }]))).toBe(
      true,
    );
    expect(
      canAnswerHere(
        view([{ requested: "milk", reason: "unit_mismatch", question: "How many packs?" }]),
      ),
    ).toBe(false);
    expect(
      canAnswerHere(
        view([
          { requested: "x", reason: "ambiguous" },
          { requested: "y", reason: "missing_quantity" },
        ]),
      ),
    ).toBe(false); // all or nothing
    expect(canAnswerHere(view([]))).toBe(false);
    expect(
      mergeAnswers(
        { action: "prepare_bill" },
        questionsFor(view([{ requested: "milk", reason: "unit_mismatch" }])),
        { 0: "2" },
      ).error,
    ).toMatch(/cannot be answered here/);
  });

  it("remembers which run answered which, and tolerates broken storage", () => {
    const store: Record<string, string> = {};
    const fake = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
    };
    (globalThis as any).window = { sessionStorage: fake }; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      saveAnsweredLink("wf_old", "wf_new");
      saveAnsweredLink("wf_old2", "wf_new2");
      expect(readAnsweredLinks()).toEqual({ wf_old: "wf_new", wf_old2: "wf_new2" });
      store["nammaops-answered-runs"] = "{not json";
      expect(readAnsweredLinks()).toEqual({});
      store["nammaops-answered-runs"] = "[1,2]";
      expect(readAnsweredLinks()).toEqual({});
      (globalThis as Record<string, unknown>).window = {
        sessionStorage: {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {
            throw new Error("blocked");
          },
        },
      };
      expect(readAnsweredLinks()).toEqual({});
      expect(() => saveAnsweredLink("a", "b")).not.toThrow();
    } finally {
      delete (globalThis as any).window; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  });
});
