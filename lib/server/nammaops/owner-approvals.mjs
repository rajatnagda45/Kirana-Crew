import { randomBytes } from "node:crypto";
import { fingerprint, OWNER_ACTOR } from "../mcp-governance.mjs";
import { invoiceSnapshot, orderSnapshot } from "./calculations.mjs";
import { PinVerifier, OWNER_PIN_NAMESPACE } from "./pin-verifier.mjs";
import { liveWriteBlocked } from "./approval-policy.mjs";

export { OWNER_PIN_NAMESPACE };
export const OWNER_APPROVAL_NAMESPACE = "nammaops.owner-approval";
export const PIN_CHALLENGE_NAMESPACE = "nammaops.pin-challenge";
export const PO_SUBMIT_PRINCIPAL = "nammaops-po-submit";
export const BILL_SUBMIT_PRINCIPAL = "nammaops-bill-submit";

/**
 * What an owner approval can be for. Each kind is one document type, read back through its own
 * capability, submitted by its own principal, and fingerprinted by its own snapshot. The approval
 * machinery (PIN, gateway approval, EmergencyStop, spoken PIN) is the same for every kind. Records
 * written before kinds existed have no `kind` and are purchase orders.
 */
const KINDS = Object.freeze({
  purchase_order: {
    action: "submit_purchase_order",
    documentType: "Purchase Order",
    get: "erp.po.get",
    submit: "erp.po.submit",
    principal: PO_SUBMIT_PRINCIPAL,
    snapshot: orderSnapshot,
    read: (result) => result.data.purchase_order,
  },
  sales_invoice: {
    action: "submit_sales_invoice",
    documentType: "Sales Invoice",
    get: "erp.sales_invoice.get",
    submit: "erp.sales_invoice.submit",
    principal: BILL_SUBMIT_PRINCIPAL,
    snapshot: invoiceSnapshot,
    read: (result) => result.data.invoice,
  },
});
const kindOf = (record) => KINDS[record?.kind ?? "purchase_order"] ?? KINDS.purchase_order;
const TTL_MS = 30 * 60 * 1000;
/** How long a spoken-PIN challenge stays open after the owner is asked for the PIN. */
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Spoken PINs ----------------------------------------------------------------------------
// The owner may say the PIN aloud. It reaches the speech service and the voice model (accepted),
// but this server never stores it: the transcript turn is checked in memory and saved redacted.
const WORD_DIGITS = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  shunya: "0",
  ek: "1",
  do: "2",
  teen: "3",
  char: "4",
  chaar: "4",
  paanch: "5",
  panch: "5",
  chhe: "6",
  chah: "6",
  saat: "7",
  aath: "8",
  nau: "9",
};
const DEVANAGARI = "०१२३४५६७८९";
const TOKEN = `(?:\\d+|[${DEVANAGARI}]+|\\b(?:${Object.keys(WORD_DIGITS).join("|")})\\b)`;
const RUN = new RegExp(`${TOKEN}(?:[\\s,.\\-]+${TOKEN})*`, "gi");
const digitsOf = (token) =>
  [...token.toLowerCase()]
    .map((char) => (DEVANAGARI.includes(char) ? String(DEVANAGARI.indexOf(char)) : char))
    .join("");
const runDigits = (run) =>
  run
    .split(/[\s,.\-]+/)
    .map((token) => WORD_DIGITS[token.toLowerCase()] ?? digitsOf(token))
    .join("");

/** The PIN a spoken or typed turn contains: a run of 4 to 8 digits (digits, words or Devanagari). */
export function extractSpokenPin(text) {
  for (const [run] of String(text ?? "").matchAll(RUN)) {
    const digits = runDigits(run);
    if (/^\d{4,8}$/.test(digits)) return digits;
  }
  return null;
}

/** Hide any run of 3 or more spoken or written digits, so a PIN is never stored in a transcript. */
export function redactSpokenDigits(text) {
  return String(text ?? "").replace(RUN, (run) =>
    runDigits(run).length >= 3 ? "[PIN hidden]" : run,
  );
}

/**
 * Store-owner approval of one exact purchase order. This is a business decision, separate from
 * Developer Mode permission approvals: it never grants or changes tool permissions.
 *
 * Submission runs once, as a dedicated workflow principal, only after: the owner PIN (checked by
 * `PinVerifier`, on screen or aloud), an unexpired request, an unchanged ERP draft, an open
 * emergency stop being clear, and a gateway approval issued here that is bound to the principal,
 * the capability, the exact arguments and the approving session. The ToolGateway re-validates and
 * consumes that approval immediately before the call. A PIN alone authorizes nothing.
 */
export class OwnerApprovals {
  /** @param {any} runtime @param {{binding: any, pin?: string, ttlMs?: number, now?: () => Date,
   *  onSettled?: (approval: any) => void, voiceWaitTries?: number}} options */
  constructor(runtime, { binding, pin, ttlMs = TTL_MS, now, onSettled, voiceWaitTries = 8 }) {
    this.runtime = runtime;
    this.binding = binding;
    this.ttlMs = ttlMs;
    this.now = now ?? (() => new Date());
    this.onSettled = onSettled ?? (() => {});
    this.voiceWaitTries = voiceWaitTries;
    this.pins = new PinVerifier(runtime, { envPin: pin, now: this.now });
  }

  get db() {
    return this.runtime.db;
  }

  /** The emergency stop pauses new work; an approval that has not run yet is then void. */
  stopped() {
    const stop = this.runtime.estop;
    if (!stop) return false;
    return typeof stop.engaged === "function" ? stop.engaged() : Boolean(stop.status?.().engaged);
  }

  view(record) {
    if (!record) return null;
    const open = record.status === "pending";
    const expired = open && Date.parse(record.expires_at) <= this.now().getTime();
    return {
      ...record,
      status: expired ? "expired" : open && this.stopped() ? "invalidated" : record.status,
    };
  }

  get(id) {
    return this.view(this.db.record(OWNER_APPROVAL_NAMESPACE, id));
  }

  list({ workflowId } = {}) {
    return this.db
      .records(OWNER_APPROVAL_NAMESPACE)
      .filter((row) => !workflowId || row.workflow_id === workflowId)
      .map((row) => this.view(row));
  }

  save(record, patch) {
    const { id, revision, ...rest } = record;
    return this.db.saveRecord(OWNER_APPROVAL_NAMESPACE, id, { ...rest, ...patch }, revision);
  }

  /** Bind a request to the exact draft as ERP returned it. */
  request({ workflowId, purchaseOrder }) {
    const snapshot = orderSnapshot(purchaseOrder);
    if (snapshot.docstatus !== 0) throw fail(409, "Only a draft purchase order can be approved.");
    return this.record("purchase_order", workflowId, snapshot, { supplier: snapshot.supplier });
  }

  /** A draft customer bill, bound to exactly what ERP returned: customer, lines, rates and total. */
  requestBill({ workflowId, invoice }) {
    const snapshot = invoiceSnapshot(invoice);
    if (snapshot.docstatus !== 0) throw fail(409, "Only a draft bill can be approved.");
    return this.record("sales_invoice", workflowId, snapshot, { customer: snapshot.customer });
  }

  record(kindName, workflowId, snapshot, party) {
    const kind = KINDS[kindName];
    const id = `own_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
    return this.db.saveRecord(
      OWNER_APPROVAL_NAMESPACE,
      id,
      {
        workflow_id: workflowId,
        kind: kindName,
        action: kind.action,
        erp_document_type: kind.documentType,
        erp_document_name: snapshot.name,
        ...party,
        items: snapshot.items,
        total: snapshot.grand_total,
        document_state: "draft",
        fingerprint: fingerprint(snapshot),
        idempotency_key: id,
        status: "pending",
        requested_at: this.now().toISOString(),
        expires_at: new Date(this.now().getTime() + this.ttlMs).toISOString(),
        history: [],
      },
      0,
    );
  }

  // ---- The owner PIN (see PinVerifier) -------------------------------------------------------
  pinStatus() {
    return this.pins.status();
  }

  checkPin(pin) {
    this.pins.check(pin);
  }

  /** Owner changes the approval PIN; the current PIN is required unless none has been set. */
  changePin(current, next) {
    return this.pins.change(current, next);
  }

  pending(id) {
    const record = this.db.record(OWNER_APPROVAL_NAMESPACE, id);
    if (!record) throw fail(404, "Approval request not found.");
    if (record.status !== "pending") throw fail(409, `This request is already ${record.status}.`);
    if (Date.parse(record.expires_at) <= this.now().getTime()) {
      this.save(record, { status: "expired" });
      throw fail(409, "This approval request has expired; prepare the order again.");
    }
    return record;
  }

  /** Refuse, and void the request, while the emergency stop is engaged. */
  assertNotStopped(record) {
    if (!this.stopped()) return;
    if (record?.status === "pending")
      this.save(record, {
        status: "invalidated",
        ...this.note(record, "invalidated", { reason: "Emergency stop engaged." }),
      });
    throw fail(
      423,
      "Emergency stop is engaged. The approval was voided and nothing was submitted.",
    );
  }

  /**
   * A write the policy table keeps disabled on the live ERP (purchase orders) is refused whatever
   * the PIN or approval; customer bills are the one live write the owner has enabled.
   */
  assertWritable(record) {
    if (liveWriteBlocked(kindOf(record).submit, this.binding.binding))
      throw fail(
        409,
        "Live ERP writes of this kind are disabled pending a security review. Nothing was submitted, whatever the PIN.",
      );
  }

  note(record, event, extra = {}) {
    return {
      history: [...(record.history ?? []), { event, at: this.now().toISOString(), ...extra }],
    };
  }

  /**
   * Present the PIN for one decision, on screen (`pin`) or already verified aloud (`proof`). Either
   * way it ends as a single-use proof bound to `session`, spent here.
   */
  spendPin({ pin, proof, session }) {
    this.pins.consume(proof ?? this.pins.verify(pin, { session }), { session });
  }

  /** Accepts the old `(id, pin)` call as well as `(id, {pin|proof, session, channel})`. */
  decision(input) {
    const given = typeof input === "string" || input === undefined ? { pin: input } : input;
    return { session: "panel", channel: "screen", ...given };
  }

  reject(id, input) {
    const { pin, proof, session } = this.decision(input);
    this.spendPin({ pin, proof, session });
    const record = this.pending(id);
    const saved = this.save(record, {
      status: "rejected",
      decided_at: this.now().toISOString(),
      ...this.note(record, "rejected"),
    });
    this.onSettled(this.view(saved));
    return this.view(saved);
  }

  /** Approve and submit exactly once. */
  async approve(id, input) {
    const { pin, proof, session, channel } = this.decision(input);
    const existing = this.db.record(OWNER_APPROVAL_NAMESPACE, id);
    if (!existing) throw fail(404, "Approval request not found.");
    const kind = kindOf(existing);
    this.assertWritable(existing);
    this.assertNotStopped(existing);
    this.spendPin({ pin, proof, session });
    let record = this.pending(id);
    const current = await this.binding.call(
      kind.principal,
      kind.get,
      { name: record.erp_document_name },
      {
        correlationId: record.idempotency_key,
      },
    );
    const snapshot = kind.snapshot(kind.read(current));
    if (fingerprint(snapshot) !== record.fingerprint) {
      const saved = this.save(record, {
        status: "invalidated",
        ...this.note(record, "invalidated", {
          reason: "The ERP draft changed after the request was made.",
        }),
      });
      this.onSettled(this.view(saved));
      throw fail(
        409,
        `The ${kind.documentType.toLowerCase()} changed since it was presented; nothing was submitted.`,
      );
    }
    // Claim the request before the external call; a concurrent approval fails on the revision.
    record = this.save(record, {
      status: "submitting",
      decided_at: this.now().toISOString(),
      approved_by: "owner",
      approved_via: channel,
      approval_session: session,
      ...this.note(record, "approved", { channel }),
    });
    let outcome;
    try {
      // The gateway approval: bound to this principal, the submit capability, the exact arguments
      // and this session. The ToolGateway re-validates and consumes it right before the call.
      const args = { name: record.erp_document_name };
      const capabilityId = this.binding.capabilityId(kind.submit);
      const capability = capabilityId ? this.runtime.capabilities.get(capabilityId) : null;
      let approvalId;
      if (capability?.approval_required) {
        approvalId = this.runtime.governance.requestApproval({
          agentId: kind.principal,
          capability,
          args,
          correlationId: record.idempotency_key,
        });
        this.runtime.governance.issueOwnerApproval(approvalId, {
          actor: OWNER_ACTOR,
          session,
          via: channel,
        });
      }
      const submitted = await this.binding.call(kind.principal, kind.submit, args, {
        correlationId: record.idempotency_key,
        ...(approvalId ? { approvalId, session } : {}),
      });
      const confirm = await this.binding.call(
        kind.principal,
        kind.get,
        { name: record.erp_document_name },
        {
          correlationId: record.idempotency_key,
        },
      );
      const docstatus = kind.read(confirm)?.docstatus;
      outcome = {
        status: docstatus === 1 ? "submitted" : "uncertain",
        document_state: docstatus === 1 ? "submitted" : "unknown",
        erp_response: {
          submit: submitted.invocation_id,
          confirm: confirm.invocation_id,
          docstatus,
          ...(approvalId ? { gateway_approval: approvalId } : {}),
        },
      };
    } catch (error) {
      outcome = {
        status:
          error.status === 423
            ? "invalidated"
            : error.workflowStatus === "uncertain"
              ? "uncertain"
              : "failed",
        error: error.message,
        erp_response: { invocation: error.invocation_id ?? null },
      };
    }
    const saved = this.save(this.db.record(OWNER_APPROVAL_NAMESPACE, id), {
      ...outcome,
      ...this.note(record, outcome.status),
    });
    this.onSettled(this.view(saved));
    return this.view(saved);
  }

  // ---- Approving by voice: the owner says the PIN ----------------------------------------------
  // The model never carries the PIN: it only names the approval. The owner's spoken turn is
  // checked as it is saved (see `ingestVoiceTurn`), and the stored turn has the digits removed.

  /** True while this call is waiting for the owner to say the PIN. */
  hasPinChallenge(callId) {
    const challenge = this.db.record(PIN_CHALLENGE_NAMESPACE, callId);
    return Boolean(
      challenge &&
      !challenge.closed &&
      !challenge.verdict &&
      Date.parse(challenge.expires_at) > this.now().getTime(),
    );
  }

  saveChallenge(callId, patch, previous = this.db.record(PIN_CHALLENGE_NAMESPACE, callId)) {
    const { id, revision, ...rest } = previous ?? { revision: 0 };
    void id;
    return this.db.saveRecord(
      PIN_CHALLENGE_NAMESPACE,
      callId,
      { call_id: callId, ...rest, ...patch },
      revision ?? 0,
    );
  }

  /**
   * Called as a voice turn is saved. While a challenge is open, a turn that contains the PIN is
   * verified in memory (the PIN counts against the same persistent lockout as on screen) and is
   * returned with its digits hidden. Nothing here keeps the digits.
   * @returns {{content: string, redacted: boolean}}
   */
  ingestVoiceTurn({ call, messageId, content }) {
    if (!this.hasPinChallenge(call.id)) return { content, redacted: false };
    const hidden = redactSpokenDigits(content);
    const pin = extractSpokenPin(content);
    if (!pin) return { content: hidden, redacted: hidden !== content };
    let verdict;
    try {
      verdict = { ok: true, proof: this.pins.verify(pin, { session: call.id }) };
    } catch (error) {
      verdict = {
        ok: false,
        reason: error.status === 429 ? "locked" : error.status === 409 ? "no_pin_set" : "incorrect",
      };
    }
    this.saveChallenge(call.id, {
      verdict: { ...verdict, message_id: messageId, at: this.now().toISOString() },
    });
    return { content: hidden, redacted: true };
  }

  /**
   * The voice tool. First call: opens a PIN challenge. After the owner has spoken, the next call
   * collects the verdict and, only if the PIN was right, approves and submits.
   */
  async approveByVoice({ call, approvalId }) {
    // Refuse a disabled live write before changing anything (a lapsed request is marked expired).
    const existing = this.db.record(OWNER_APPROVAL_NAMESPACE, approvalId);
    if (!existing) throw fail(404, "Approval request not found.");
    this.assertWritable(existing);
    const record = this.pending(approvalId);
    this.assertNotStopped(record);
    const challenge = this.db.record(PIN_CHALLENGE_NAMESPACE, call.id);
    const open =
      challenge &&
      !challenge.closed &&
      challenge.approval_id === approvalId &&
      Date.parse(challenge.expires_at) > this.now().getTime();
    if (!open) {
      this.pins.assertUnlocked();
      if (!this.pins.credential())
        throw fail(409, "No owner PIN is set. Set one in Settings before approving anything.");
      this.saveChallenge(
        call.id,
        {
          approval_id: approvalId,
          closed: false,
          verdict: null,
          expires_at: new Date(this.now().getTime() + CHALLENGE_TTL_MS).toISOString(),
        },
        challenge,
      );
      return {
        status: "pin_required",
        approval_id: approvalId,
        document: record.erp_document_name,
        ...(kindOf(record) === KINDS.purchase_order
          ? { purchase_order: record.erp_document_name }
          : {}),
        note: "Ask the owner to say their approval PIN now, then call this tool again. Never repeat, spell out or write down the digits.",
      };
    }
    let current = challenge;
    for (let tries = 0; !current.verdict && tries < this.voiceWaitTries; tries += 1) {
      await wait(300);
      current = this.db.record(PIN_CHALLENGE_NAMESPACE, call.id);
    }
    if (!current.verdict)
      return {
        status: "waiting_for_pin",
        note: "The owner's PIN has not been heard yet. Ask them to say it, then call this tool again.",
      };
    this.saveChallenge(
      call.id,
      { closed: true, verdict: { ...current.verdict, proof: undefined } },
      current,
    );
    if (!current.verdict.ok)
      return {
        status: "pin_rejected",
        reason: current.verdict.reason,
        note:
          current.verdict.reason === "locked"
            ? "Too many wrong PINs. Tell the owner to try again in a few minutes or use the NammaOps panel."
            : "That PIN was not accepted. Nothing was approved. Do not repeat the digits.",
      };
    const approval = await this.approve(approvalId, {
      proof: current.verdict.proof,
      session: call.id,
      channel: "voice",
    });
    return { status: approval.status, approval };
  }

  /** After an uncertain or failed submit, read ERP before anything else is tried. */
  async reconcile(id) {
    const record = this.db.record(OWNER_APPROVAL_NAMESPACE, id);
    if (!record) throw fail(404, "Approval request not found.");
    if (!["uncertain", "failed"].includes(record.status))
      throw fail(
        409,
        `Only an uncertain or failed submission can be reconciled (status ${record.status}).`,
      );
    const kind = kindOf(record);
    const current = await this.binding.call(kind.principal, kind.get, {
      name: record.erp_document_name,
    });
    const docstatus = kind.read(current)?.docstatus;
    const patch =
      docstatus === 1
        ? { status: "submitted", document_state: "submitted" }
        : {
            status: "pending",
            document_state: "draft",
            expires_at: new Date(this.now().getTime() + this.ttlMs).toISOString(),
          };
    const saved = this.save(record, {
      ...patch,
      ...this.note(record, "reconciled", { docstatus }),
    });
    this.onSettled(this.view(saved));
    return this.view(saved);
  }
}
