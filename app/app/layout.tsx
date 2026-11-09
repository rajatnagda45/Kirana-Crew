"use client";
import { StudioProvider } from "@/lib/store";
import { VoiceProvider } from "@/lib/voice/VoiceProvider";
import BillApprovalHost from "@/components/hud/BillApprovalHost";
import "@/components/hud/hud.css";
import "@/components/hud/cinematic.css";
import "@/components/hud/workspace.css";
import "@/components/ui/product.css";
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <StudioProvider>
      <VoiceProvider>
        {children}
        <BillApprovalHost />
      </VoiceProvider>
    </StudioProvider>
  );
}
