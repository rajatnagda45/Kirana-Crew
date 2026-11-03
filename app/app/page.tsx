"use client";

import { WorkspaceView } from "@/components/hud/WorkspaceView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import KiranaShell from "@/components/hud/KiranaShell";
import { Toaster } from "sonner";
import TerminalModal from "@/components/panel/TerminalModal";
import WorkerSessionHistoryModal from "@/components/panel/WorkerSessionHistoryModal";

export default function Page() {
  return (
    <ErrorBoundary>
      <WorkspaceView>
        <KiranaShell />
        <Toaster />
        <TerminalModal />
        <WorkerSessionHistoryModal />
      </WorkspaceView>
    </ErrorBoundary>
  );
}
