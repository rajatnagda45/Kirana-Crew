"use client";
import { DashboardView } from "@/components/dashboard/kit";
import { WorkflowAction } from "@/components/dashboard/WorkflowAction";

/** ERPNext Stock dashboard, read through the governed ERP binding. */
export default function InventoryPage() {
  return (
    <DashboardView
      name="stock"
      title="Inventory"
      subtitle="Stock value, shortages and fast movers (ERPNext Stock dashboard)"
      charts={[
        "stock_value_by_item_group",
        "warehouse_wise_stock_value",
        "item_shortage_summary",
        "fast_movers",
      ]}
      tables={[{ id: "stock", title: "Stock Balance" }]}
      actions={
        <WorkflowAction
          action="stock_check"
          label="Run Stock Check"
          hint="Inventory Agent checks every item against its reorder level and records evidence."
        />
      }
    />
  );
}
