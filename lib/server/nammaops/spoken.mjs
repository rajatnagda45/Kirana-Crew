/**
 * Spoken versions of workflow results. The on-screen summary is a dense, list-style text; read
 * aloud it sounds robotic and costs more text-to-speech. These are short, conversational
 * sentences built only from the already verified result figures (no new numbers are invented),
 * capped to a few sentences, and attributed to the specialist who did the work.
 *
 * When `language` is 'hi', responses are in Hinglish (Hindi-English mix) so kirana shopkeepers
 * who speak Hindi feel more at home. We never translate numbers or ERP terms.
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
  procurement_overview: "procurement",
  supplier_performance: "procurement",
  receivables_report: "finance",
  store_health_report: "manager",
  business_report: "reports",
  billing_summary: "billing",
  payments_summary: "finance",
  gst_summary: "finance",
  purchase_order_lookup: "procurement",
  prepare_bill: "billing",
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
 * @param {{ today?: string, fallback?: string, language?: string }} [context]
 */
export function spokenAnswer(result, { today, fallback = "", language = "en" } = {}) {
  if (!result?.kind) return cap(fallback);
  const lang = String(language ?? "en")
    .slice(0, 2)
    .toLowerCase();
  // Both 'hl' (Hinglish Roman) and 'hi' (Devanagari Hindi) route to the Hinglish template for now.
  if (lang === "hl" || lang === "hi") return spokenAnswerHindi(result, { today, fallback });
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
          : result.profit?.status === "not_requested"
            ? ""
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
    case "procurement_overview":
      return cap(
        `You work with ${plural(result.suppliers.length, "supplier")} and have ${plural(result.open_orders.length, "open purchase order")}` +
          (result.late_orders ? `, ${result.late_orders} of them late` : "") +
          `. ${plural(result.quotations.count, "quotation")} are on file.`,
      );
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
    case "billing_summary": {
      if (!result.bills) return "There were no bills in that period.";
      return cap(
        `${result.bills} bills, ${rupees(result.total)} in all, ${rupees(result.average_bill)} a bill. ` +
          (result.unpaid.status === "available"
            ? result.unpaid.bills
              ? `${result.unpaid.bills} are still unpaid, ${rupees(result.unpaid.amount)}.`
              : "All of them are paid."
            : ""),
      );
    }
    case "prepare_bill":
      return cap(
        `I prepared a draft bill for ${result.customer}: ${result.lines.map((row) => `${row.qty} ${row.item_name}`).join(" and ")}, ${rupees(result.total)} in all. It is only a draft: please check it, and approve it with your PIN to make it a bill.`,
      );
    case "payments_summary":
      return cap(
        `${rupees(result.received)} received and ${rupees(result.paid)} paid out across ${plural(result.payments, "payment")}.`,
      );
    case "gst_summary": {
      const o = result.outward;
      if (!o.lines && !result.inward.lines) return "I found no GST lines in that period.";
      return cap(
        (o.tax
          ? `Output GST is ${rupees(o.tax)} on ${rupees(o.taxable_value)} of taxable sales. `
          : `No GST was charged on ${plural(o.lines, "sales line")}. `) +
          `Net GST is ${rupees(result.net_tax)}. This is indicative, not a filing.`,
      );
    }
    case "purchase_order_lookup": {
      if (!result.found) return `I could not find purchase order ${result.name}.`;
      return cap(
        `Purchase order ${result.name} for ${result.supplier} is ${result.state}, ${plural(result.lines, "line")}, ${rupees(result.total)}.`,
      );
    }
    case "business_report": {
      const r = result;
      const move =
        r.previous?.change_pct == null
          ? ""
          : ` That is ${Math.abs(r.previous.change_pct)} percent ${r.previous.change_pct >= 0 ? "up" : "down"} on the period before.`;
      return cap(
        `Sales were ${rupees(r.sales.total_sales)} from ${r.sales.transaction_count} bills.${move} ` +
          (r.profit.status === "verified"
            ? `Posted profit is ${rupees(r.profit.net_profit)}. `
            : "Profit is not verified in the accounts. ") +
          (r.udhaar.status === "available" ? `Udhaar pending is ${rupees(r.udhaar.total)}.` : ""),
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

/**
 * Hinglish spoken responses — same verified data, natural Hindi-English shopkeeper language.
 * Never invents numbers or products; uses the same `result` object as the English version.
 */
function spokenAnswerHindi(result, { today, fallback = "" } = {}) {
  switch (result.kind) {
    case "stock_check": {
      const low = result.low ?? [];
      if (!low.length)
        return `Achha khabar hai. Saare ${result.rows.length} products reorder level se upar hain.`;
      const out = low.filter((r) => r.available <= 0);
      return cap(
        `${low.length} ${low.length === 1 ? "product" : "products"} kam ho rahe hain: ${nameList(low.map((r) => r.item_name))}.` +
          (out.length
            ? ` ${nameList(out.map((r) => r.item_name))} bilkul khatam ho gaye hain.`
            : ""),
      );
    }
    case "daily_report": {
      const top = result.top_products?.[0]?.item_name;
      const profit =
        result.profit?.status === "verified"
          ? ` Net profit ${rupees(result.profit.net_profit)} raha.`
          : result.profit?.status === "not_requested"
            ? ""
            : " Profit books se confirm nahi ho paya.";
      if (result.by_day) {
        const days = result.by_day;
        const best = [...days].sort((x, y) => y.total - x.total)[0];
        return cap(
          `${days.length} dinon mein, ${result.period.from_date} se ${result.period.to_date} tak, ${rupees(result.total_sales)} ki bikri hui, ${result.transaction_count} ${result.transaction_count === 1 ? "bill" : "bills"} mein.` +
            (best?.total
              ? ` Sabse achha din ${best.date} raha, ${rupees(best.total)} ke saath.`
              : "") +
            (top ? ` ${top} sabse zyada bika.` : "") +
            profit,
        );
      }
      const when = result.period?.from_date === today ? "Aaj" : `${result.period?.from_date} ko`;
      return cap(
        `${when} ${rupees(result.total_sales)} ki bikri hui, ${result.transaction_count} ${result.transaction_count === 1 ? "bill" : "bills"} mein.` +
          (top ? ` ${top} sabse zyada bika.` : "") +
          profit,
      );
    }
    case "demand_forecast": {
      const buy = (result.items ?? []).filter((r) => r.recommendation?.suggested_qty > 0);
      return buy.length
        ? cap(
            `Pichle sales ke hisaab se, aapko yeh order karna chahiye: ${nameList(buy.map((r) => r.item_name))}.`,
          )
        : "Pichle sales ke hisaab se, is hafte kuch order karne ki zaroorat nahi hai.";
    }
    case "supplier_comparison": {
      const best = (result.items ?? []).filter((r) => r.choice);
      if (!best.length) return "Koi suitable supplier quotation nahi mila.";
      return cap(
        best
          .slice(0, 2)
          .map(
            (r) =>
              `${r.item_name} ke liye, ${r.choice.supplier} sabse sasta hai, ${r.choice.rate} rupees mein.`,
          )
          .join(" "),
      );
    }
    case "prepare_reorder": {
      const n = result.orders?.length ?? 0;
      return n
        ? `Maine ${n} ${n === 1 ? "purchase order" : "purchase orders"} tayyar kar diye hain aapke approve karne ke liye. Screen dekho aur apna PIN se approve karo.`
        : cap(result.note ?? "Abhi kuch bhi reorder karne ki zaroorat nahi hai.");
    }
    case "receivables_report": {
      const over = result.overdue_over_30_days;
      const first = (result.collection_priority ?? []).slice(0, 3).map((c) => c.customer);
      return cap(
        `Udhaar pending hai ${rupees(result.total_outstanding)}.` +
          (over?.customers
            ? ` ${over.customers} ${over.customers === 1 ? "customer ne" : "customers ne"} tees din se zyada se payment nahi ki, kul ${rupees(over.amount)}.`
            : " Tees din se zyada koi overdue nahi hai.") +
          (first.length ? ` Pehle ${nameList(first)} se collect karo.` : ""),
      );
    }
    case "expiry_check": {
      if (!result.batches_tracked)
        return "Expiry check nahi ho sakta kyunki abhi tak koi batch dates record nahi hain.";
      const w = result.windows;
      const soon = w["7_days"].batches + w.expired.batches;
      return cap(
        `${w.expired.batches} ${w.expired.batches === 1 ? "batch" : "batches"} pehle se expire ho gaye hain, aur ${w["7_days"].batches} ${w["7_days"].batches === 1 ? "batch" : "batches"} ek hafte mein expire honge. ` +
          `Kul ${rupees(result.value_at_risk)} ka stock risk mein hai.` +
          (soon
            ? ` Pehle ${nameList(result.items.slice(0, 2).map((r) => r.item_name))} se shuru karo.`
            : ""),
      );
    }
    case "procurement_overview":
      return cap(
        `Aap ${result.suppliers.length} suppliers ke saath kaam karte hain aur ${result.open_orders.length} open purchase orders hain` +
          (result.late_orders ? `, ${result.late_orders} late` : "") +
          `. ${result.quotations.count} quotations on file hain.`,
      );
    case "purchase_status": {
      const late = result.delayed?.length ?? 0;
      return cap(
        `Aapke paas ${result.open_orders} open purchase ${result.open_orders === 1 ? "order" : "orders"} hain. ` +
          (late
            ? `${late} ${late === 1 ? "line" : "lines"} late hai, mainly ${nameList([...new Set(result.delayed.map((l) => l.supplier))], 2)} se. `
            : "Koi late nahi hai. ") +
          `Supplier bills unpaid hain ${rupees(result.payables.total)}.`,
      );
    }
    case "supplier_performance":
      return result.delaying?.length
        ? cap(
            result.delaying
              .slice(0, 2)
              .map(
                (s) =>
                  `${s.supplier} ${s.late_lines} ${s.late_lines === 1 ? "line" : "lines"} mein late hai, up to ${s.max_days_late} ${s.max_days_late === 1 ? "din" : "din"} tak.`,
              )
              .join(" "),
          )
        : "Abhi koi supplier delivery mein late nahi hai.";
    case "customer_insights": {
      const weekly = result.weekly_buyers ?? [];
      return cap(
        `Pichle barah hapton mein ${result.buying_customers} named customers ne kharida. ` +
          (weekly.length
            ? `${nameList(weekly.map((c) => c.customer))} har hafte aate hain. `
            : "Abhi tak koi har hafte nahi aata. ") +
          (result.high_value?.[0]
            ? `Aapka best customer ${result.high_value[0].customer} hai.`
            : ""),
      );
    }
    case "billing_summary": {
      if (!result.bills) return "Us period mein koi bill nahi tha.";
      return cap(
        `${result.bills} bills, kul ${rupees(result.total)}, ${rupees(result.average_bill)} per bill. ` +
          (result.unpaid.status === "available"
            ? result.unpaid.bills
              ? `${result.unpaid.bills} abhi unpaid hain, ${rupees(result.unpaid.amount)}.`
              : "Saare pay ho gaye hain."
            : ""),
      );
    }
    case "prepare_bill":
      return cap(
        `Maine ${result.customer} ke liye ek draft bill tayyar kiya hai: ${result.lines.map((row) => `${row.qty} ${row.item_name}`).join(" aur ")}, kul ${rupees(result.total)}. Yeh sirf draft hai: dekho aur apna PIN se approve karo taaki bill ban sake.`,
      );
    case "payments_summary":
      return cap(
        `${rupees(result.received)} mila aur ${rupees(result.paid)} gaya, ${result.payments} ${result.payments === 1 ? "payment" : "payments"} mein.`,
      );
    case "gst_summary": {
      const o = result.outward;
      if (!o.lines && !result.inward.lines) return "Us period mein koi GST lines nahi mili.";
      return cap(
        (o.tax
          ? `Output GST ${rupees(o.tax)} hai, ${rupees(o.taxable_value)} ki taxable sales par. `
          : `${o.lines} sales ${o.lines === 1 ? "line" : "lines"} par koi GST nahi laga. `) +
          `Net GST ${rupees(result.net_tax)} hai. Yeh indicative hai, filing nahi.`,
      );
    }
    case "purchase_order_lookup": {
      if (!result.found) return `Purchase order ${result.name} nahi mila.`;
      return cap(
        `Purchase order ${result.name} ${result.supplier} ke liye ${result.state} hai, ${result.lines} ${result.lines === 1 ? "line" : "lines"}, ${rupees(result.total)}.`,
      );
    }
    case "business_report": {
      const r = result;
      const move =
        r.previous?.change_pct == null
          ? ""
          : ` Yeh pichle period se ${Math.abs(r.previous.change_pct)} percent ${r.previous.change_pct >= 0 ? "upar" : "neeche"} hai.`;
      return cap(
        `Bikri ${rupees(r.sales.total_sales)} rahi, ${r.sales.transaction_count} bills se.${move} ` +
          (r.profit.status === "verified"
            ? `Posted profit ${rupees(r.profit.net_profit)} hai. `
            : "Profit accounts se verify nahi hua. ") +
          (r.udhaar.status === "available" ? `Udhaar pending hai ${rupees(r.udhaar.total)}.` : ""),
      );
    }
    case "store_health_report": {
      const p = result.problems ?? [];
      if (!p.length) return "Sales, stock, udhaar ya deliveries mein koi problem nahi mila.";
      return cap(
        `Yeh hain sabse bade problems. ${p
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

/** Hinglish versions of the two static messages. */
export const UNDERSTOOD_NOTHING_HI =
  "Maafi karo, samajh nahi aaya. Stock, bikri, udhaar, expiry, suppliers ya customers ke baare mein poochh sakte hain.";
export const NOTHING_HEARD_HI = "Kuch suna nahi. Dobara try karo.";
