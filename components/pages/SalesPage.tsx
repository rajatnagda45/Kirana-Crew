"use client";
import { DashboardView } from "@/components/dashboard/kit";
import { WorkflowAction } from "@/components/dashboard/WorkflowAction";

/** ERPNext Selling dashboard: sales and POS invoices. */
export default function SalesPage() {
  return (
    <DashboardView
      name="selling"
      title="Sales & Billing"
      subtitle="Counter and credit sales, top items and item groups (ERPNext Selling dashboard)"
      charts={["sales_trend", "top_items", "sales_by_item_group", "weekday_pattern"]}
      wide={["sales_trend"]}
      tables={[{ id: "top_products", title: "Top Products" }]}
      actions={
        <WorkflowAction
          action="daily_report"
          label="Run Daily Report"
          hint="Sales and Finance Agents report today's sales, top products and posted profit."
        />
      }
    />
  );
}
