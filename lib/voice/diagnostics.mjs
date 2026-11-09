// Shared by the browser and server. Never retain provider text, URLs, or credentials.
export const VOICE_MODEL = "gemini-3.8-live";
export const VOICE_API_VERSION = "v1beta";
export const VOICE_BILLING_NOTICE =
  "Usage records are provider-reported metadata relayed by the browser, not Google's actual bill. Missing usage is unknown. Duration and any cost estimates are estimates, not charges. Check Google Cloud Billing for actual charges.";

const messages = {
  configuration:
    "Voice is not configured. Set GEMINI_API_KEY on the server and restart Agent Town.",
  selection:
    "This conversation or agent binding changed. Select the teammate again and start a new call.",
  origin: "Voice requires the same localhost or approved HTTPS origin as the workspace.",
  rate_limit: "Too many voice starts. Wait one minute before starting another call.",
  service_unavailable:
    "The voice service is temporarily unavailable. Check the server connection and try again.",
  model_api_version:
    "Gemini model or API version is unavailable. Check model access and API-version compatibility.",
  auth: "Google rejected Gemini access. Check key restrictions, project access, and billing.",
  quota: "Gemini quota exceeded. Check your Google project quota and billing.",
  connection: "Gemini voice connection failed. Check your network and Gemini access.",
  timeout: "Voice connection timed out. Check your network and Gemini access.",
  microphone_permission: "Allow microphone access in browser site settings.",
  microphone_missing: "Connect a microphone and try again.",
  microphone_busy:
    "The microphone could not be opened. Check your Mac or Windows microphone privacy settings, close other apps using it, and try again.",
  microphone_constraints:
    "The selected microphone does not support the requested audio settings. Choose another input device in browser settings.",
  browser_support:
    "Voice needs localhost or HTTPS and a browser with microphone and audio worklet support.",
  session_closed: "Gemini ended the voice session. Start a new call to continue.",
  call_limit: "10-minute call limit reached. Start a new call to continue.",
  media: "Voice audio connection failed. Check your microphone and start a new call.",
  abandoned: "This call never reported an end; it was closed by the server.",
};

export function diagnosticMessage(code) {
  return messages[code] ?? messages.connection;
}

/**
 * Why the provider closed the socket, reduced to a fixed vocabulary. The provider's own text is
 * matched here and then discarded; only one of these labels is ever stored.
 */
export const REASON_KINDS = Object.freeze([
  "not_supported", // "operation is not implemented, or supported, or enabled"
  "invalid_argument",
  "model_unavailable",
  "auth",
  "quota",
  "go_away", // Gemini's own end-of-session notice
  "other",
  "none", // the socket closed without any reason text
]);
export function classifyCloseReason(text) {
  if (typeof text !== "string" || !text.trim()) return "none";
  if (/not (implemented|supported|enabled)/i.test(text)) return "not_supported";
  if (/invalid.?argument|malformed|unexpected|unknown field/i.test(text)) return "invalid_argument";
  if (/not found|unsupported.*model|model.*(unavailable|not supported)|api.?version/i.test(text))
    return "model_unavailable";
  if (/permission|unauthenticated|api key|denied/i.test(text)) return "auth";
  if (/quota|resource_exhausted|rate limit/i.test(text)) return "quota";
  return "other";
}

/** What the browser last sent into the live session before it closed. */
export const SEND_KINDS = Object.freeze([
  "audio",
  "context", // mid-call context snapshot (sendClientContent)
  "announcement", // task-status text (sendClientContent)
  "tool_response",
  "greeting", // the opening turn
  "none",
]);

/** A call that ends because of the 10-minute limit or Gemini's own go-away notice ended normally. */
export const isExpectedEnding = (diagnostic) =>
  diagnostic?.code === "call_limit" || diagnostic?.reasonKind === "go_away";

const wholeBetween = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

/** Whitelist only: diagnostic text is always generated locally. */
export function sanitizeDiagnostic(value) {
  const code = Object.hasOwn(messages, value?.code) ? value.code : "connection";
  const phase = ["browser", "provisioning", "connection", "call"].includes(value?.phase)
    ? value.phase
    : "connection";
  return {
    code,
    phase,
    message: diagnosticMessage(code),
    ...(Number.isInteger(value?.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599
      ? { httpStatus: value.httpStatus }
      : {}),
    ...(Number.isInteger(value?.closeCode) && value.closeCode >= 1000 && value.closeCode <= 4999
      ? { closeCode: value.closeCode }
      : {}),
    // Evidence for diagnosing a close: labels and counters only, never provider or user text.
    ...(REASON_KINDS.includes(value?.reasonKind) ? { reasonKind: value.reasonKind } : {}),
    ...(SEND_KINDS.includes(value?.lastSent) ? { lastSent: value.lastSent } : {}),
    ...(wholeBetween(value?.msSinceLastSend, 0, 3_600_000)
      ? { msSinceLastSend: value.msSinceLastSend }
      : {}),
    ...(wholeBetween(value?.contextPushes, 0, 10_000)
      ? { contextPushes: value.contextPushes }
      : {}),
    ...(typeof value?.toolPending === "boolean" ? { toolPending: value.toolPending } : {}),
  };
}

/** Provider messages are examined for classification only, never returned or stored. */
export function classifyVoiceError(error, phase = "connection") {
  const status = Number(error?.status ?? error?.code);
  const text = typeof error?.message === "string" ? error.message : "";
  const code =
    error?.name === "NotAllowedError" || error?.name === "SecurityError"
      ? "microphone_permission"
      : error?.name === "NotFoundError"
        ? "microphone_missing"
        : error?.name === "NotReadableError" || error?.name === "TrackStartError"
          ? "microphone_busy"
          : error?.name === "OverconstrainedError"
            ? "microphone_constraints"
            : status === 429 || /RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(text)
              ? "quota"
              : status === 401 ||
                  status === 403 ||
                  /PERMISSION_DENIED|UNAUTHENTICATED|invalid api key|token.*expired/i.test(text)
                ? "auth"
                : status === 404 ||
                    /api.?version|unsupported.*model|model.*(not found|not supported|unavailable)/i.test(
                      text,
                    )
                  ? "model_api_version"
                  : error?.name === "TimeoutError"
                    ? "timeout"
                    : phase === "browser"
                      ? "media"
                      : "connection";
  return sanitizeDiagnostic({ code, phase, httpStatus: status });
}

const tokenFields = [
  "promptTokenCount",
  "responseTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
];
/** Preserve absent counts as unknown and discard all unrecognized fields. */
export function sanitizeUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const field of tokenFields)
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) result[field] = value[field];
  return Object.keys(result).length ? result : undefined;
}
