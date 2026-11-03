"use client";
import { DashboardView } from "@/components/dashboard/kit";

/** Suppliers & Payables: what the store owes, how old it is, and how suppliers perform. */
export default function SuppliersPage() {
  return (
    <DashboardView
      name="payables"
      ranged={false}
      title="Suppliers & Payables"
      subtitle="Accounts payable ageing, dues by supplier and a supplier scorecard"
      charts={["payables_ageing", "payable_by_supplier"]}
      tables={[
        { id: "supplier_scorecard", title: "Supplier Scorecard" },
        { id: "payables", title: "Outstanding Bills" },
      ]}
    />
  );
}
