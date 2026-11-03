"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import WorkReport from "@/components/work/WorkReport";
import "@/components/work/work-report.css";

export default function WorkReportPage() {
  const params = useParams<{ id: string }>();
  return (
    <main className="work-report-page">
      <Link href="/app">← Back to the office</Link>
      {params?.id ? <WorkReport id={params.id} /> : <p>Missing report ID.</p>}
    </main>
  );
}
