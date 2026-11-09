import { randomBytes, scryptSync } from "node:crypto";
import { safeSecretEqual } from "../../server-security.mjs";

export const OWNER_PIN_NAMESPACE = "nammaops.owner-pin";
/** Failed-attempt counter and lock. Persisted, so a restart does not reset a lockout. */
export const PIN_LOCK_NAMESPACE = "nammaops.owner-pin-lock";
/** Single-use proofs that a correct PIN was just presented. They hold no PIN. */
export const PIN_PROOF_NAMESPACE = "nammaops.owner-pin-proof";

export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 5 * 60 * 1000;
export const PIN_PROOF_TTL_MS = 60 * 1000;

const fail = (status, message) => Object.assign(new Error(message), { status });
const hashPin = (pin, salt) => scryptSync(pin, salt, 32).toString("hex");
const credentialFor = (pin) => {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: hashPin(pin, salt) };
};

/**
 * The owner PIN: salted scrypt only, a lockout that survives a restart, and no built-in default.
 *
 * Where the PIN comes from: one the owner set in Settings (stored only as a salted scrypt hash),
 * else NAMMAOPS_OWNER_PIN (hashed in memory at start-up, never compared as plain text), else none:
 * with no PIN, approvals are refused until the owner sets one.
 *
 * A correct PIN never grants anything by itself. `verify` returns a short, single-use proof bound
 * to one session; the approval flow consumes it. The PIN is never stored, logged or returned.
 */
export class PinVerifier {
  /** @param {any} runtime @param {{envPin?: string, now?: () => Date}} options */
  constructor(runtime, { envPin, now } = {}) {
    this.runtime = runtime;
    this.now = now ?? (() => new Date());
    this.env = typeof envPin === "string" && envPin ? credentialFor(envPin) : null;
  }

  get db() {
    return this.runtime.db;
  }

  /** Which credential is active. The PIN itself is never returned. */
  status() {
    const stored = this.db.record(OWNER_PIN_NAMESPACE, "current");
    const lock = this.lock();
    return {
      source: stored ? "settings" : this.env ? "environment" : "none",
      updated_at: stored?.updated_at ?? null,
      ...(lock.locked_until && Date.parse(lock.locked_until) > this.now().getTime()
        ? { locked_until: lock.locked_until }
        : {}),
    };
  }

  credential() {
    return this.db.record(OWNER_PIN_NAMESPACE, "current") ?? this.env;
  }

  lock() {
    return this.db.record(PIN_LOCK_NAMESPACE, "state") ?? { failures: 0, locked_until: null };
  }

  saveLock(patch) {
    const { id, revision, ...rest } = this.db.record(PIN_LOCK_NAMESPACE, "state") ?? {
      revision: 0,
    };
    void id;
    return this.db.saveRecord(
      PIN_LOCK_NAMESPACE,
      "state",
      { failures: 0, locked_until: null, ...rest, ...patch },
      revision ?? 0,
    );
  }

  assertUnlocked() {
    const until = this.lock().locked_until;
    if (until && this.now().getTime() < Date.parse(until))
      throw fail(429, "Too many wrong PIN attempts. Try again in a few minutes.");
  }

  /** Throws unless `pin` is the owner PIN. Counts failures and locks after five, persistently. */
  check(pin) {
    this.assertUnlocked();
    const credential = this.credential();
    if (!credential)
      throw fail(409, "No owner PIN is set. Set one in Settings before approving anything.");
    const ok =
      typeof pin === "string" &&
      pin.length > 0 &&
      pin.length <= 64 &&
      safeSecretEqual(hashPin(pin, credential.salt), credential.hash);
    if (ok) {
      if (this.lock().failures) this.saveLock({ failures: 0 });
      return;
    }
    const failures = (this.lock().failures ?? 0) + 1;
    if (failures >= MAX_PIN_FAILURES)
      this.saveLock({
        failures: 0,
        locked_until: new Date(this.now().getTime() + PIN_LOCK_MS).toISOString(),
      });
    else this.saveLock({ failures });
    throw fail(403, "Owner PIN is incorrect.");
  }

  /**
   * Check the PIN and return a single-use proof bound to `session`. The proof lasts a minute and
   * is consumed by the approval it is presented to, so a PIN is checked once per decision.
   */
  verify(pin, { session }) {
    if (typeof session !== "string" || !session || session.length > 200)
      throw fail(400, "An approval session is required.");
    this.check(pin);
    const proof = `pnp_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
    this.db.saveRecord(
      PIN_PROOF_NAMESPACE,
      proof,
      {
        session,
        used: false,
        issued_at: this.now().toISOString(),
        expires_at: new Date(this.now().getTime() + PIN_PROOF_TTL_MS).toISOString(),
      },
      0,
    );
    return proof;
  }

  /** Atomically spends a proof. It must be unused, unexpired and from the same session. */
  consume(proof, { session }) {
    const record = typeof proof === "string" ? this.db.record(PIN_PROOF_NAMESPACE, proof) : null;
    if (!record) throw fail(403, "PIN verification is required.");
    if (record.used) throw fail(409, "That PIN verification was already used.");
    if (Date.parse(record.expires_at) <= this.now().getTime())
      throw fail(409, "PIN verification expired; enter the PIN again.");
    if (record.session !== session)
      throw fail(403, "PIN verification belongs to a different session.");
    const { id, revision, ...rest } = record;
    void id;
    // The revision check makes a second concurrent use fail instead of succeeding twice.
    this.db.saveRecord(
      PIN_PROOF_NAMESPACE,
      proof,
      { ...rest, used: true, used_at: this.now().toISOString() },
      revision,
    );
  }

  /** Owner changes the PIN. The current PIN is required, except when none has been set. */
  change(current, next) {
    if (this.credential()) this.check(current);
    if (typeof next !== "string" || !/^\d{4,8}$/.test(next))
      throw fail(400, "The new PIN must be 4 to 8 digits.");
    const stored = this.db.record(OWNER_PIN_NAMESPACE, "current");
    this.db.saveRecord(
      OWNER_PIN_NAMESPACE,
      "current",
      { ...credentialFor(next), updated_at: this.now().toISOString() },
      stored?.revision ?? 0,
    );
    return this.status();
  }
}
