"use client";
import { DashboardView } from "@/components/dashboard/kit";

/**
 * CRM / customers dashboard. Reads customers through the governed, read-only ERP binding, from
 * live ERPNext, under the same grants as every other dashboard.
 */
export default function CustomersPage() {
  return (
    <DashboardView
      name="crm"
      title="Customers"
      subtitle="Active, new and repeat customers, groups and top buyers (ERPNext CRM / Selling)"
      charts={["top_customers", "customer_group_mix"]}
      tables={[{ id: "customers", title: "Customers" }]}
    />
  );
}
