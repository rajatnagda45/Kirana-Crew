"use client";
import { DashboardView } from "@/components/dashboard/kit";

/** GST & Tax: indicative GSTR-3B style summary, slab-wise tax and HSN summary. Not a filing. */
export default function GstPage() {
  return (
    <DashboardView
      name="gst"
      title="GST & Tax"
      subtitle="Output tax, input tax credit, slab-wise and HSN-wise summary (indicative)"
      charts={["tax_by_slab", "output_vs_itc", "b2b_vs_b2c"]}
      tables={[
        { id: "summary", title: "Summary (GSTR-3B style)" },
        { id: "by_slab", title: "Outward Supplies by GST Slab" },
        { id: "hsn_summary", title: "HSN Summary (GSTR-1 style)" },
      ]}
    />
  );
}
