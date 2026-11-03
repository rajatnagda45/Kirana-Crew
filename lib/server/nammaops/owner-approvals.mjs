import { randomBytes, scryptSync } from "node:crypto";
import { safeSecretEqual } from "../../server-security.mjs";
import { fingerprint } from "../mcp-governance.mjs";
import { orderSnapshot } from "./calculations.mjs";

export const OWNER_APPROVAL_NAMESPACE = "nammaops.owner-approval";
export const PO_SUBMIT_PRINCIPAL = "nammaops-po-submit";
const TTL_MS = 30 * 60 * 1000;
export const OWNER_PIN_NAMESPACE = "nammaops.owner-pin";
/** Starter PIN until the owner sets one in Settings (or NAMMAOPS_OWNER_PIN is configured). */
export const DEFAULT_OWNER_PIN = "1234";
const hashPin = (pin, salt) => scryptSync(pin, salt, 32).toString("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Store-owner approval of one exact purchase order. This is a business decision, separate from
 * Developer Mode permission approvals: it never grants or changes tool permissions. Submission
 * runs once, as a dedicated workflow principal, only after the owner's PIN, an unexpired
 * request and an unchanged ERP draft are all confirmed.
 */
export class OwnerApprovals {
  /** @param {any} runtime @param {{binding: any, pin?: string, ttlMs?: number, now?: () => Date,
   *  onSettled?: (approval: any) => void}} options */
  constructor(runtime, { binding, pin, ttlMs = TTL_MS, now, onSettled }) {
    this.runtime = runtime;
    this.binding = binding;
    this.pin = pin;
    this.ttlMs = ttlMs;
    this.now = now ?? (() => new Date());
    this.onSettled = onSettled ?? (() => {});
  }

  get db() {
    return this.runtime.db;
  }

  view(record) {
    if (!record) return null;
    const expired =
      record.status === "pending" && Date.parse(record.expires_at) <= this.now().getTime();
    return { ...record, status: expired ? "expired" : record.status };
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
    const id = `own_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
    return this.db.saveRecord(
      OWNER_APPROVAL_NAMESPACE,
      id,
      {
        workflow_id: workflowId,
        action: "submit_purchase_order",
        erp_document_type: "Purchase Order",
        erp_document_name: snapshot.name,
        supplier: snapshot.supplier,
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

  /**
   * Where the active PIN comes from: one set by the owner in Settings (stored only as a salted
   * scrypt hash), else NAMMAOPS_OWNER_PIN, else the starter PIN 1234 (flagged so the Settings
   * page can ask the owner to change it). The PIN itself is never returned.
   */
  pinStatus() {
    const stored = this.db.record(OWNER_PIN_NAMESPACE, "current");
    return stored
      ? { source: "settings", updated_at: stored.updated_at }
      : { source: this.pin ? "environment" : "default", updated_at: null };
  }

  checkPin(pin) {
    // A short numeric PIN must not be guessable by repetition: 5 wrong tries lock for 5 minutes.
    const now = this.now().getTime();
    if (this.lockedUntil && now < this.lockedUntil)
      throw fail(429, "Too many wrong PIN attempts. Try again in a few minutes.");
    const stored = this.db.record(OWNER_PIN_NAMESPACE, "current");
    const ok =
      typeof pin === "string" &&
      pin.length > 0 &&
      (stored
        ? safeSecretEqual(hashPin(pin, stored.salt), stored.hash)
        : safeSecretEqual(pin, this.pin ?? DEFAULT_OWNER_PIN));
    if (!ok) {
      this.failures = (this.failures ?? 0) + 1;
      if (this.failures >= 5) {
        this.lockedUntil = now + 5 * 60 * 1000;
        this.failures = 0;
      }
      throw fail(403, "Owner PIN is incorrect.");
    }
    this.failures = 0;
  }

  /** Owner changes the approval PIN; the current PIN is required. */
  changePin(current, next) {
    this.checkPin(current);
    if (typeof next !== "string" || !/^\d{4,8}$/.test(next))
      throw fail(400, "The new PIN must be 4 to 8 digits.");
    const salt = randomBytes(16).toString("hex");
    const stored = this.db.record(OWNER_PIN_NAMESPACE, "current");
    this.db.saveRecord(
      OWNER_PIN_NAMESPACE,
      "current",
      { hash: hashPin(next, salt), salt, updated_at: this.now().toISOString() },
      stored?.revision ?? 0,
    );
    return this.pinStatus();
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

  note(record, event, extra = {}) {
    return {
      history: [...(record.history ?? []), { event, at: this.now().toISOString(), ...extra }],
    };
  }

  reject(id, pin) {
    this.checkPin(pin);
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
  async approve(id, pin) {
    this.checkPin(pin);
    let record = this.pending(id);
    const current = await this.binding.call(
      PO_SUBMIT_PRINCIPAL,
      "erp.po.get",
      { name: record.erp_document_name },
      {
        correlationId: record.idempotency_key,
      },
    );
    const snapshot = orderSnapshot(current.data.purchase_order);
    if (fingerprint(snapshot) !== record.fingerprint) {
      const saved = this.save(record, {
        status: "invalidated",
        ...this.note(record, "invalidated", {
          reason: "The ERP draft changed after the request was made.",
        }),
      });
      this.onSettled(this.view(saved));
      throw fail(409, "The purchase order changed since it was presented; nothing was submitted.");
    }
    // Claim the request before the external call; a concurrent approval fails on the revision.
    record = this.save(record, {
      status: "submitting",
      decided_at: this.now().toISOString(),
      approved_by: "owner",
      ...this.note(record, "approved"),
    });
    let outcome;
    try {
      const submitted = await this.binding.call(
        PO_SUBMIT_PRINCIPAL,
        "erp.po.submit",
        { name: record.erp_document_name },
        { correlationId: record.idempotency_key },
      );
      const confirm = await this.binding.call(
        PO_SUBMIT_PRINCIPAL,
        "erp.po.get",
        { name: record.erp_document_name },
        {
          correlationId: record.idempotency_key,
        },
      );
      const docstatus = confirm.data.purchase_order?.docstatus;
      outcome = {
        status: docstatus === 1 ? "submitted" : "uncertain",
        document_state: docstatus === 1 ? "submitted" : "unknown",
        erp_response: {
          submit: submitted.invocation_id,
          confirm: confirm.invocation_id,
          docstatus,
        },
      };
    } catch (error) {
      outcome = {
        status: error.workflowStatus === "uncertain" ? "uncertain" : "failed",
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

  /** After an uncertain or failed submit, read ERP before anything else is tried. */
  async reconcile(id) {
    const record = this.db.record(OWNER_APPROVAL_NAMESPACE, id);
    if (!record) throw fail(404, "Approval request not found.");
    if (!["uncertain", "failed"].includes(record.status))
      throw fail(
        409,
        `Only an uncertain or failed submission can be reconciled (status ${record.status}).`,
      );
    const current = await this.binding.call(PO_SUBMIT_PRINCIPAL, "erp.po.get", {
      name: record.erp_document_name,
    });
    const docstatus = current.data.purchase_order?.docstatus;
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
