/**
 * Server-owned approval policy. This table is code, not configuration an agent can reach: an agent
 * can neither add a capability to it nor change a capability's class.
 *
 *   requires    "none"                  reads: no PIN, no approval
 *               "approval"              an explicit, exact-argument approval
 *               "approval+pin+confirm"  approval, the owner PIN and a re-read of the exact document
 *   live_write  "disabled" | "enabled"  whether the live ERP may be written at all. This is the
 *               final word: no PIN, approval token or grant can switch a disabled write on. A live
 *               write also needs a bound tool, which `ErpBinding` refuses while the binding says
 *               `tool: null`.
 *
 * Fixture mode is separate: its writes run against synthetic data and are labelled as fixtures.
 */
export const APPROVAL_POLICY = Object.freeze({
  // Purchase orders: owner-enabled 2026-11-11, the same way as bills. A draft touches neither
  // accounts nor stock. Submitting needs the owner's PIN, an exact re-read and a gateway approval.
  "erp.po.create_draft": Object.freeze({
    risk: "WRITE",
    requires: "draft",
    live_write: "enabled",
  }),
  "erp.po.submit": Object.freeze({
    risk: "EXTERNAL_ACTION",
    requires: "approval+pin+confirm",
    live_write: "enabled",
  }),
  // Customer bills: the one live write the owner enabled (2026-11-08). A draft touches neither
  // accounts nor stock; submitting needs the owner's PIN, an exact re-read and a gateway approval.
  "erp.sales_invoice.create_draft": Object.freeze({
    risk: "WRITE",
    requires: "draft",
    live_write: "enabled",
  }),
  "erp.sales_invoice.submit": Object.freeze({
    risk: "EXTERNAL_ACTION",
    requires: "approval+pin+confirm",
    live_write: "enabled",
  }),
});

/** The policy for a capability. Anything not listed is a read and needs nothing. */
export function classify(capabilityId) {
  return APPROVAL_POLICY[capabilityId] ?? { risk: "READ", requires: "none", live_write: null };
}

/** True when a PIN must be presented before this capability may run. */
export const requiresPin = (capabilityId) => classify(capabilityId).requires.includes("pin");

/**
 * Whether the binding is the live ERP (anything other than the synthetic fixture). A capability
 * whose live write is disabled is refused here even if everything else is in order.
 */
export function liveWriteBlocked(capabilityId, binding) {
  const policy = classify(capabilityId);
  return policy.live_write === "disabled" && binding?.shape !== "fixture";
}
