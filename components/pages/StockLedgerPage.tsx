"use client";
import { DashboardView } from "@/components/dashboard/kit";

/** Stock Ledger & Expiry: movements, stock ageing and batch expiry. */
export default function StockLedgerPage() {
  return (
    <DashboardView
      name="stock-ledger"
      title="Stock Ledger & Expiry"
      subtitle="Stock movements, stock ageing and batches nearing expiry"
      charts={["stock_movement", "movement_by_type", "expiry", "stock_ageing"]}
      wide={["stock_movement"]}
      tables={[
        { id: "batches", title: "Batches by Expiry" },
        { id: "movements", title: "Stock Ledger" },
      ]}
    />
  );
}
