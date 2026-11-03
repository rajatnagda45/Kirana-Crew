"use client";
import { DashboardView } from "@/components/dashboard/kit";
import { WorkflowAction } from "@/components/dashboard/WorkflowAction";

/** Business intelligence: margin, turnover, ABC classification and demand forecasts. */
export default function AnalyticsPage() {
  return (
    <DashboardView
      name="analytics"
      title="Analytics"
      subtitle="Gross margin, inventory turnover, ABC classes and 7/30-day demand forecasts"
      charts={["margin_by_group", "abc_classification", "forecast_next_7_days"]}
      wide={["margin_by_group"]}
      tables={[
        { id: "forecasts", title: "Demand Forecast (top items)" },
        { id: "abc", title: "ABC Classification" },
      ]}
      actions={
        <WorkflowAction
          action="demand_forecast"
          label="Run Demand Forecast"
          hint="Sales, Inventory and Procurement Agents forecast demand and suggest reorder quantities with evidence."
        />
      }
    />
  );
}
