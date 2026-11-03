"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import TeamBoard from "@/components/work/TeamBoard";
import "@/components/work/work-report.css";

export default function TeamBoardPage() {
  const params = useParams<{ id: string }>();
  return (
    <main className="work-report-page">
      <Link href="/app">← Back to the office</Link>
      {params?.id ? <TeamBoard id={params.id} /> : <p>Missing team run ID.</p>}
    </main>
  );
}
