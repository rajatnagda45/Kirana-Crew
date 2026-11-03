"use client";
import { DashboardView } from "@/components/dashboard/kit";

/**
 * CRM / customers dashboard. Reads customers through the governed ERP binding, so it works with
 * the fixture as well as live ERPNext (the old direct /api/erp/customers call did not).
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
