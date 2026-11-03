"use client";
import { DashboardView } from "@/components/dashboard/kit";

/** Credit / Udhaar: customer dues, ageing, credit limits and who to collect from first. */
export default function CreditPage() {
  return (
    <DashboardView
      name="receivables"
      ranged={false}
      title="Credit / Udhaar"
      subtitle="Accounts receivable ageing, credit-limit use and a collection list"
      charts={["receivables_ageing", "receivable_by_customer"]}
      tables={[
        { id: "collection_list", title: "Collection List (oldest and largest first)" },
        { id: "customers", title: "Customer Dues" },
        { id: "invoices", title: "Outstanding Invoices" },
      ]}
    />
  );
}
