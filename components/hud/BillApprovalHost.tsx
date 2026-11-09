"use client";
import { useRouter } from "next/navigation";
import BillApprovalPrompt from "./BillApprovalPrompt";

/** Mounted once for every /app page (group chat, chat, workflows). "Later" opens the approvals list. */
export default function BillApprovalHost() {
  const router = useRouter();
  return <BillApprovalPrompt onLater={() => router.push("/app/workflows")} />;
}
