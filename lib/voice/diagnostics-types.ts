export interface VoiceUsage {
  promptTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

export interface VoiceCallRecord {
  id: string;
  name: string;
  seatId: string;
  sessionKey: string;
  model?: string;
  apiVersion?: string;
  createdAt: string;
  updatedAt?: string;
  endedAt?: string;
  status?: "provisioned" | "connected" | "ended" | "error";
  durationMs?: number;
  diagnostic?: {
    code: string;
    phase: string;
    message: string;
    httpStatus?: number;
    closeCode?: number;
    /** Why the provider closed the socket, as a fixed label (never the provider's text). */
    reasonKind?: string;
    /** What the browser last sent into the live session before the close. */
    lastSent?: string;
    msSinceLastSend?: number;
    contextPushes?: number;
    toolPending?: boolean;
  };
  usageReports?: Array<{ sequence: number; reportedAt: string; usage: VoiceUsage }>;
}

export interface VoiceDiagnosticsSnapshot {
  billingNotice: string;
  calls: VoiceCallRecord[];
}
