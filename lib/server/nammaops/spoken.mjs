/**
 * Spoken versions of workflow results. The on-screen summary is a dense, list-style text; read
 * aloud it sounds robotic and costs more text-to-speech. These are short, conversational
 * sentences built only from the already verified result figures (no new numbers are invented),
 * capped to a few sentences, and attributed to the specialist who did the work.
 */
const MAX_SPOKEN_CHARS = 320;

/** The specialist who "speaks" each workflow, so each agent has its own voice. */
export const SPEAKER_FOR_ACTION = Object.freeze({
  stock_check: "inventory",
  demand_forecast: "inventory",
  expiry_check: "inventory",
  daily_report: "sales",
  customer_insights: "sales",
  supplier_comparison: "procurement",
  prepare_reorder: "procurement",
  purchase_status: "procurement",
  supplier_performance: "procurement",
  receivables_report: "finance",
  store_health_report: "manager",
});
export const DEFAULT_SPEAKER = "manager";

/** 49509 -> "49,509 rupees"; 123456 -> "1.2 lakh rupees"; 12345678 -> "1.2 crore rupees". */
export function rupees(value) {
  const n = Math.round(Number(value) || 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? "minus " : "";
  if (abs >= 10_000_000)
    return `${sign}${(abs / 10_000_000).toFixed(1).replace(/\.0$/, "")} crore rupees`;
  if (abs >= 100_000) return `${sign}${(abs / 100_000).toFixed(1).replace(/\.0$/, "")} lakh rupees`;
  return `${sign}${abs.toLocaleString("en-IN")} rupees`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "A, B and C" with at most `max` names and a count of the rest. */
export function nameList(names, max = 3) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}
const clean = (text) =>
  String(text)
    .replace(/\([^)]*\)/g, "") // parenthesised detail reads badly aloud
    .replace(/item\(s\)/gi, "items")
    .replace(/\s+/g, " ")
    .replace(/\s([,.;:])/g, "$1")
    .trim();
const cap = (text) => {
  const t = clean(text);
  if (t.length <= MAX_SPOKEN_CHARS) return t;
  const cut = t.slice(0, MAX_SPOKEN_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (stop > 120 ? cut.slice(0, stop + 1) : cut).trim();
};

/**
 * @param {any} result the workflow result (`kind` set)
 * @param {{ today?: string, fallback?: string }} [context]
 */
export function spokenAnswer(result, { today, fallback = "" } = {}) {
  if (!result?.kind) return cap(fallback);
  switch (result.kind) {
    case "stock_check": {
      const low = result.low ?? [];
      if (!low.length)
        return `Good news. All ${result.rows.length} products are above their reorder level.`;
      const out = low.filter((r) => r.available <= 0);
      return cap(
        `${plural(low.length, "product is", "products are")} running low: ${nameList(low.map((r) => r.item_name))}.` +
          (out.length
            ? ` ${nameList(out.map((r) => r.item_name))} ${out.length === 1 ? "is" : "are"} out of stock.`
            : ""),
      );
    }
    case "daily_report": {
      const top = result.top_products?.[0]?.item_name;
      const profit =
        result.profit?.status === "verified"
          ? ` Net profit is ${rupees(result.profit.net_profit)}.`
          : " Profit could not be confirmed from the books.";
      if (result.by_day) {
        const days = result.by_day;
        const best = [...days].sort((x, y) => y.total - x.total)[0];
        return cap(
          `Over ${days.length} days, from ${result.period.from_date} to ${result.period.to_date}, you sold ${rupees(result.total_sales)} across ${plural(result.transaction_count, "bill")}.` +
            (best?.total ? ` Your best day was ${best.date} with ${rupees(best.total)}.` : "") +
            (top ? ` ${top} was the top seller.` : "") +
            profit,
        );
      }
      const when = result.period?.from_date === today ? "Today" : `On ${result.period?.from_date}`;
      return cap(
        `${when} you sold ${rupees(result.total_sales)} across ${plural(result.transaction_count, "bill")}.` +
          (top ? ` ${top} was the top seller.` : "") +
          profit,
      );
    }
    case "demand_forecast": {
      const buy = (result.items ?? []).filter((r) => r.recommendation?.suggested_qty > 0);
      return buy.length
        ? cap(`Based on recent sales, you should order ${nameList(buy.map((r) => r.item_name))}.`)
        : "Based on recent sales, you do not need to order anything for the next week.";
    }
    case "supplier_comparison": {
      const best = (result.items ?? []).filter((r) => r.choice);
      if (!best.length) return "I could not find a suitable supplier quotation.";
      return cap(
        best
          .slice(0, 2)
          .map(
            (r) =>
              `For ${r.item_name}, ${r.choice.supplier} is cheapest at ${r.choice.rate} rupees.`,
          )
          .join(" "),
      );
    }
    case "prepare_reorder": {
      const n = result.orders?.length ?? 0;
      return n
        ? `I prepared ${plural(n, "purchase order")} for your approval. Please check the screen and approve with your PIN.`
        : cap(result.note ?? "There is nothing to reorder right now.");
    }
    case "receivables_report": {
      const over = result.overdue_over_30_days;
      const first = (result.collection_priority ?? []).slice(0, 3).map((c) => c.customer);
      return cap(
        `Udhaar pending is ${rupees(result.total_outstanding)}.` +
          (over?.customers
            ? ` ${plural(over.customers, "customer has", "customers have")} not paid for over thirty days, ${rupees(over.amount)} in all.`
            : " Nothing is overdue by more than thirty days.") +
          (first.length ? ` Collect first from ${nameList(first)}.` : ""),
      );
    }
    case "expiry_check": {
      if (!result.batches_tracked)
        return "I cannot check expiry because no batch dates are recorded yet.";
      const w = result.windows;
      const soon = w["7_days"].batches + w.expired.batches;
      return cap(
        `${plural(w.expired.batches, "batch has", "batches have")} already expired, and ${plural(w["7_days"].batches, "batch expires", "batches expire")} within a week. ` +
          `In total ${rupees(result.value_at_risk)} of stock is at risk.` +
          (soon
            ? ` Start with ${nameList(result.items.slice(0, 2).map((r) => r.item_name))}.`
            : ""),
      );
    }
    case "purchase_status": {
      const late = result.delayed?.length ?? 0;
      return cap(
        `You have ${plural(result.open_orders, "open purchase order")}. ` +
          (late
            ? `${plural(late, "line is", "lines are")} late, mainly from ${nameList([...new Set(result.delayed.map((l) => l.supplier))], 2)}. `
            : "Nothing is late. ") +
          `Unpaid supplier bills come to ${rupees(result.payables.total)}.`,
      );
    }
    case "supplier_performance":
      return result.delaying?.length
        ? cap(
            result.delaying
              .slice(0, 2)
              .map(
                (s) =>
                  `${s.supplier} is late on ${plural(s.late_lines, "line")}, by up to ${plural(s.max_days_late, "day")}.`,
              )
              .join(" "),
          )
        : "No supplier is late on deliveries right now.";
    case "customer_insights": {
      const weekly = result.weekly_buyers ?? [];
      return cap(
        `${plural(result.buying_customers, "named customer")} bought in the last twelve weeks. ` +
          (weekly.length
            ? `${nameList(weekly.map((c) => c.customer))} buy every week. `
            : "No one buys every week yet. ") +
          (result.high_value?.[0] ? `Your best customer is ${result.high_value[0].customer}.` : ""),
      );
    }
    case "store_health_report": {
      const p = result.problems ?? [];
      if (!p.length) return "I found no problems in sales, stock, udhaar or deliveries.";
      return cap(
        `Here are the biggest problems. ${p
          .slice(0, 3)
          .map((x, i) => `${i + 1}. ${x.title}.`)
          .join(" ")}`,
      );
    }
    default:
      return cap(fallback);
  }
}

export const UNDERSTOOD_NOTHING =
  "Sorry, I did not catch that. You can ask about stock, sales, udhaar, expiry, suppliers or customers.";
export const NOTHING_HEARD = "I did not hear anything. Please try again.";
