export const demoStages = ["Speak", "Plan", "Execute", "Deliver"] as const;

export const samplePrompt =
  "Check milk and oil stock, and prepare an order for anything running low.";

export const demoEvents = [
  {
    stage: 0,
    agent: "Shopkeeper (voice)",
    action: "Voice command captured",
    detail:
      'Gnani Prisma STT transcript: "Haalina mattu yenney stock check maadi, kam iddre order haaki." · Detected intent: prepare_reorder · Products: [milk, oil]',
  },
  {
    stage: 1,
    agent: "Manager Agent",
    action: "Delegation plan created",
    detail:
      "Inventory Agent: check current stock levels for milk and oil · Sales Agent: review 7-day demand · Procurement Agent: compare supplier prices and draft PO",
  },
  {
    stage: 2,
    agent: "Inventory Agent",
    action: "INVENTORY_CHECK_COMPLETED",
    detail:
      "LOW_STOCK_DETECTED — Milk: 18 packets remaining (reorder threshold: 30) · Oil: 4 litres remaining (reorder threshold: 10)",
  },
  {
    stage: 2,
    agent: "Sales Agent",
    action: "DEMAND_ANALYSIS_COMPLETED",
    detail:
      "7-day avg daily sales — Milk: 6 packets/day · Oil: 1.2 litres/day · Recommended order covers 4-day buffer above threshold",
  },
  {
    stage: 2,
    agent: "Procurement Agent",
    action: "PURCHASE_ORDER_DRAFTED",
    detail:
      "SUPPLIER_COMPARISON_DONE — Best price: Shree Distributors · Milk 24 packets @ ₹40 = ₹960 · Oil 12 litres @ ₹120 = ₹1,440 · Total: ₹2,400",
  },
  {
    stage: 3,
    agent: "Manager Agent",
    action: "Draft PO ready — owner approval required",
    detail:
      'Gnani Timbre TTS: "Draft order ready. Milk: 24 packets for ₹960. Oil: 12 litres for ₹1,440. Total ₹2,400. Approve?" · Owner PIN required to execute',
  },
] as const;

export const sampleReport = `KIRANACREW / SAMPLE PURCHASE ORDER

Request (voice)
"Check milk and oil stock and prepare an order for anything running low."

Low-stock findings
Product   Current  Threshold  Recommended Order
Milk      18 pkts  30 pkts    24 packets  @ ₹40   = ₹960
Oil        4 ltrs  10 ltrs    12 litres   @ ₹120  = ₹1,440
                               ─────────────────────────
                               Total order           ₹2,400

Supplier selected
Shree Distributors (best price on both items this week)

Voice response (Gnani Timbre TTS)
"Draft order ready. Milk: 24 packets for ₹960. Oil: 12 litres for
₹1,440. Total ₹2,400 from Shree Distributors. Approve?"

Approval gate
[ ] Owner PIN required before ERP write
[ ] Confirmation sent as voice reply after approval

Scope: illustrative workflow · no live ERP or AI connected.`;

export function nextDemoStage(stage: number) {
  return Math.min(stage + 1, demoStages.length - 1);
}

export function eventsAtStage(stage: number) {
  return demoEvents.filter((e) => e.stage <= stage);
}
