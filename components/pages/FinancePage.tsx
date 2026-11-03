"use client";
import { DashboardView } from "@/components/dashboard/kit";
import { WorkflowAction } from "@/components/dashboard/WorkflowAction";

/** ERPNext Accounting dashboard: posted P&L, cash flow, receivables and payables. */
export default function FinancePage() {
  return (
    <DashboardView
      name="accounts"
      title="Finance"
      subtitle="Posted profit and loss, cash in and out, dues (ERPNext Accounting dashboard)"
      charts={["profit_and_loss", "cash_flow"]}
      wide={["profit_and_loss"]}
      tables={[{ id: "periods", title: "Weekly Summary" }]}
      actions={
        <WorkflowAction
          action="daily_report"
          label="Run Daily Report"
          hint="Finance Agent states today's posted profit, or says when it cannot be verified."
        />
      }
    />
  );
}
