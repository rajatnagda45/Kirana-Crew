"use client";

import { useStudio } from "@/lib/store";
import { VOICE_BILLING_NOTICE } from "@/lib/voice/diagnostics.mjs";

export default function VoiceDiagnostics() {
  const { state } = useStudio();
  const calls = state.voice?.calls ?? [];
  // Outcomes over every retained call: real faults are kept apart from calls that simply never
  // reported an end (closed tabs, test scripts), which the server finalises as "abandoned".
  const summary = calls.reduce(
    (total, call) => {
      if (call.diagnostic?.code === "abandoned") total.abandoned += 1;
      else if (call.status === "error") total.errors += 1;
      else if (call.status === "ended") total.ended += 1;
      else total.open += 1;
      return total;
    },
    { ended: 0, errors: 0, abandoned: 0, open: 0 },
  );
  return (
    <details className="chat-voice-hint">
      <summary>Call diagnostics and usage · all devices</summary>
      <p>{VOICE_BILLING_NOTICE}</p>
      <p>
        Shared by devices connected to this server. Duration is browser-measured connected time. An
        open record may be incomplete if its device disconnected. The 10 most recent calls are
        shown.
      </p>
      {!calls.length && <p>No call records yet.</p>}
      {calls.length > 0 && (
        <p aria-label="Call outcomes">
          Outcomes over the last {calls.length} calls: {summary.ended} ended normally,{" "}
          {summary.errors} failed, {summary.abandoned} abandoned (never reported an end),{" "}
          {summary.open} still open.
        </p>
      )}
      <ul aria-label="Recent voice calls">
        {calls.slice(0, 10).map((call) => {
          const reports = call.usageReports ?? [];
          const usage = reports.at(-1)?.usage;
          return (
            <li key={call.id}>
              <strong>{call.name}</strong> · {new Date(call.createdAt).toLocaleString()} ·{" "}
              {call.status ?? "unknown"}
              <div>
                {call.model ?? "Model unknown"} / {call.apiVersion ?? "API version unknown"}
              </div>
              <div>
                Recorded connected duration:{" "}
                {call.durationMs === undefined
                  ? "unknown"
                  : `${(call.durationMs / 1000).toFixed(1)}s`}
              </div>
              {call.diagnostic && (
                <div>
                  {call.diagnostic.message} ({call.diagnostic.code}, {call.diagnostic.phase}
                  {call.diagnostic.httpStatus ? `, HTTP ${call.diagnostic.httpStatus}` : ""}
                  {call.diagnostic.closeCode ? `, close ${call.diagnostic.closeCode}` : ""})
                  {call.diagnostic.reasonKind && call.diagnostic.reasonKind !== "none"
                    ? ` · reason: ${call.diagnostic.reasonKind.replace(/_/g, " ")}`
                    : ""}
                  {call.diagnostic.lastSent
                    ? ` · last sent: ${call.diagnostic.lastSent.replace(/_/g, " ")}${
                        call.diagnostic.msSinceLastSend !== undefined
                          ? ` ${(call.diagnostic.msSinceLastSend / 1000).toFixed(1)}s earlier`
                          : ""
                      }`
                    : ""}
                </div>
              )}
              {usage ? (
                <div>
                  Latest provider token report: input {usage.promptTokenCount ?? "unknown"}, output{" "}
                  {usage.responseTokenCount ?? "unknown"}, total{" "}
                  {usage.totalTokenCount ?? "unknown"}. {reports.length} recent reports retained;
                  these are not a summed call total.
                </div>
              ) : (
                <div>Provider token usage: unknown (no metadata received).</div>
              )}
              <small>Call ID: {call.id}</small>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
