"use client";

import { WorkspaceView } from "@/components/hud/WorkspaceView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import KiranaShell from "@/components/hud/KiranaShell";
import { Toaster } from "sonner";
import TerminalModal from "@/components/panel/TerminalModal";
import WorkerSessionHistoryModal from "@/components/panel/WorkerSessionHistoryModal";

/**
 * The workspace shell (3D store, voice, sidebar) lives in this layout so it stays mounted while
 * the URL changes between /app and /app/<view>. The pages only validate the URL.
 */
export default function WorkspaceShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <WorkspaceView>
        <KiranaShell />
        {children}
        <Toaster />
        <TerminalModal />
        <WorkerSessionHistoryModal />
      </WorkspaceView>
    </ErrorBoundary>
  );
}
