# KiranaCrew ERP capability matrix and approval contracts

Status: **Phase 0 approved. Phases 1 and 1b (three live READ bindings, text and voice access) implemented and verified; the Approval Manager (Phase 3) is not started.** See section 9 for the measured results.
Sources: `config/nammaops/binding.hvgerp.json`, `binding.fixture.json`, `workforce.json`,
`lib/server/nammaops/erp-binding.mjs`, `owner-approvals.mjs`, Phase C MCP governance doc.

Counts: 25 business capabilities = 23 READ + 1 WRITE + 1 EXTERNAL_ACTION. Before this work 20 were
bound live (all READ; verified against the registry, not 21). Now 23 READ are live. The 2 write
capabilities exist in fixture mode only and are **disabled in live** (`tool:null` + `disabled`).

## 1. Capability matrix

Grant codes: INV inventory, SAL sales, PRO procurement, FIN finance, REP reports, BIL billing,
SUB `nammaops-po-submit` principal, DASH `nammaops-dashboard-reader` principal.
Manager and OpenClaw `main` hold **no** ERP grants and must not gain any.
"Test" is filled when Phase 4 runs; `-` means not run yet.

| Capability | Live tool (adapter) | Fixture tool | Risk | Live now | Live after | Fixture | Grants | Approval policy | Test |
|---|---|---|---|---|---|---|---|---|---|
| erp.items.list | list_items | list_items | READ | yes | yes | yes | INV SAL PRO REP BIL DASH | none | live read ok, governed: tested |
| erp.stock.balance | get_stock_balance | same | READ | yes | yes | yes | INV REP DASH | none | live read ok, governed: tested |
| erp.warehouses.list | list_warehouses | same | READ | yes | yes | yes | INV DASH | none | live read ok, governed: tested |
| erp.stock.ledger | get_stock_ledger | same | READ | yes | yes | yes | INV DASH | none | live read ok, governed: tested |
| erp.suppliers.list | list_suppliers | same | READ | yes | yes | yes | PRO DASH | none | live read ok, governed: tested |
| erp.supplier_quotations.list | list_supplier_quotations | same | READ | yes | yes | yes | PRO DASH | none | live read ok, governed: tested |
| erp.item_prices.get | get_item_prices | same | READ | yes | yes | yes | PRO DASH | none | live read ok, governed: tested |
| erp.po.create_draft | none (disabled) | create_purchase_order | WRITE | no | **no (disabled)** | yes | PRO | explicit approval, only if live writes are later enabled | blocked in live: tested |
| erp.po.get | none -> `get_purchase_order` | get_purchase_order | READ | no | **yes (new)** | yes | PRO SUB DASH | none | live read ok, governed: tested |
| erp.po.submit | none (disabled) | submit_purchase_order | EXTERNAL_ACTION | no | **no (disabled)** | yes | SUB | stronger policy: owner PIN + exact-order confirmation, only if live writes are later enabled | blocked in live: tested |
| erp.sales_invoices.list | list_sales_invoices | same | READ | yes | yes | yes | SAL REP BIL DASH | none | live read ok, governed: tested |
| erp.pos_invoices.list | list_pos_invoices | same | READ | yes | yes | yes | SAL REP BIL DASH | none | live read ok, governed: tested |
| erp.customers.list | list_customers | same | READ | yes | yes | yes | SAL BIL DASH | none | live read ok, governed: tested |
| erp.pnl | get_profit_and_loss | same | READ | yes | yes | yes | FIN REP DASH | none | live read ok, governed: tested |
| erp.gl | get_general_ledger | same | READ | yes | yes | yes | FIN DASH | none | live read ok, governed: tested |
| erp.purchase_invoices.list | list_purchase_invoices | same | READ | yes | yes | yes | PRO FIN DASH | none | live read ok, governed: tested |
| erp.payments.summary | none -> `get_payment_summary` | get_payment_summary | READ | no | **yes (new)** | yes | FIN DASH | none | live read ok, governed: tested |
| erp.sales.history | list_sales_lines | same | READ | yes | yes | yes | SAL DASH | none | live read ok, governed: tested |
| erp.stock.movements | list_stock_ledger | same | READ | yes | yes | yes | INV DASH | none | live read ok, governed: tested |
| erp.po.open | list_open_purchase_orders | same | READ | yes | yes | yes | PRO DASH | none | live read ok, governed: tested |
| erp.items.valuation | get_item_valuation | same | READ | yes | yes | yes | INV DASH | none | live read ok, governed: tested |
| erp.batches.list | list_batches | same | READ | yes | yes | yes | INV DASH | none | live read ok, governed: tested |
| erp.receivables.aging | list_receivables | same | READ | yes | yes | yes | SAL FIN REP BIL DASH | none | live read ok, governed: tested |
| erp.payables.aging | list_payables | same | READ | yes | yes | yes | PRO FIN REP DASH | none | live read ok, governed: tested |
| erp.gst.summary | none -> `list_gst_lines` | list_gst_lines | READ | no | **yes if live tax data is readable, else `unavailable` with a reason** | yes | FIN DASH | none | live read ok, governed: tested |

"same" = fixture tool name equals the live tool name. Verify the fixture column against
`binding.fixture.json` when Phase 1 starts; only the five new rows were confirmed by exploration.

EmergencyStop behaviour (all rows): a stopped agent's call is refused by governance before the tool
runs; for the two write capabilities a stop additionally invalidates every pending approval.

## 2. Server-owned classification

Risk, availability and the live-write switch are owned by the server, never by an agent:
- Risk and tool binding live in the binding JSON files (read at boot; agents have no write path).
- The live-write switch is the existing mechanism: `tool:null` plus a `disabled` reason makes
  `ErpBinding.call()` throw `blocked` before any gateway call (`erp-binding.mjs:94-102`). This is
  kept for `erp.po.create_draft` and `erp.po.submit` in the live binding with an updated reason
  ("Live writes are disabled pending a separate security review"). No new flag is introduced.
- An approval, a valid PIN or a grant can never supply a missing tool, so they cannot lift it.

## 3. Mode labelling

`ErpBinding.status()` gains `mode: "live" | "fixture"` (from `binding.shape`), and every workflow
result carries `source`. The UI and agent replies label fixture data as fixture and never present a
fixture write as a live ERP write.

## 4. New live READ contracts (adapter, read-allowlist only)

Result shapes match the fixture. No field is invented: every field below must be confirmed against
the live ERPNext instance before binding; anything that cannot be read is reported `unavailable`
with a specific reason and is never replaced by fixture data.

- `get_purchase_order({name})` -> `{purchase_order}` from DocType Purchase Order (header, items).
- `get_payment_summary({from_date,to_date})` -> `{received, paid, count}` from DocType Payment Entry
  (`payment_type` Receive / Pay, `paid_amount`, `posting_date`, `docstatus = 1`).
- `list_gst_lines({from_date,to_date})` -> tax rows from the `taxes` child tables of submitted Sales
  and Purchase Invoices (`account_head`, `rate`, `tax_amount`, parent, posting date).

The global read-only guard in the adapter is not changed.

## 5. Text and voice access contract (same path for both)

One deterministic workflow per capability, run as the owning specialist through
`ErpBinding -> Governance -> ToolGateway`:

| Workflow | Specialist | Capability | Voice intent | Args |
|---|---|---|---|---|
| purchase_order_lookup | Procurement | erp.po.get | purchase_order_status | `po_name` |
| payments_summary | Finance | erp.payments.summary | payments_summary | `day`, `to` |
| gst_summary | Finance | erp.gst.summary | gst_summary | `day`, `to` |

Voice reaches them through `nammaops_business_query` (strict schema, `additionalProperties:false`);
text reaches them through the chat intent path. Same grants, same denial for any other specialist,
same audit invocation and correlation IDs. Neither channel ever asks for a PIN.

## 6. Approval contracts (writes only; READ never needs a PIN)

Scope: extend `owner-approvals.mjs`; split into four modules under `lib/server/nammaops/`.

```
ApprovalPolicy.classify(capabilityId) -> { requires: "none"|"approval"|"approval+pin+confirm",
                                           liveWrite: "disabled"|"enabled" }
ApprovalStore  : create(op) / get(id) / transition(id, from, to) with compare-and-set on revision
PinVerifier    : verify(sessionId, pin) -> { ok } | throws 401 | throws 429 (locked)
ApprovalManager: request(op) / approve(id, {pin, sessionId}) / reject(id) / cancel(id)
                 -> issues token | verify(token, op) at ToolGateway
```

Pending approval record:
`{ id, capability, specialist, session_id, user_id, args_hash, review_summary, status, created_at,
expires_at (30 min), revision }`. `status`: pending, approved, executing, executed, rejected,
cancelled, expired, uncertain.

Approval token (issued after PIN success): single use, short lived (target 2 minutes), bound to
`{ user_id, specialist, capability, args_hash, session_id }`. ToolGateway re-verifies the token
immediately before execution, independently of ApprovalManager.

Invalidation: any argument change (hash mismatch), expiry, cancel, session change, EmergencyStop.

PIN rules:
- Entered only in a masked application input; sent only to `POST /approvals/{id}/approve` as `pin`.
- Never in prompts, transcripts, logs, tool arguments, OpenClaw, agents or ERPNext.
- Stored as a salted scrypt hash. The `NAMMAOPS_OWNER_PIN` value is hashed in memory at load and
  never compared in plaintext. The built-in default `1234` is removed: with no PIN configured,
  approvals are refused.
- Constant-time verify; 5 wrong attempts lock for 5 minutes; the counter is persisted.
- A successful PIN grants nothing by itself: it only advances an approval for a capability the
  specialist is already granted, and never lifts a `disabled` capability.
- Defence in depth: a PIN-like digit string in a user turn while an approval is pending is redacted
  before the turn is stored or sent to a model.
- Decision recorded: a spoken PIN is not supported, although one dialog answer asked for it. The
  written security spec and the existing voice rules (voice cannot approve, `pin` argument rejected)
  take precedence.

Audit events (separate records): `approval.requested`, `approval.pin_failed`, `approval.locked`,
`approval.granted`, `approval.rejected`, `approval.expired`, `approval.invalidated`,
`execution.started`, `execution.completed|failed|uncertain`. Each carries invocation ID and
correlation ID; none carries a PIN.

Agent behaviour: prepare and present the operation, wait for server-issued state, point the user to
the secure approval screen, never ask for or accept a PIN in chat or voice, never claim success
before ToolGateway confirms.

## 7. Known defects this work fixes

- `lib/hooks/useNammaOps.ts:223` sends `owner_pin`; the API reads `pin`.
- Env PIN compared in plaintext; default PIN `1234`; lockout counter lost on restart.

## 8. Test plan (Phase 4)

Table-driven over all 25 capabilities (binding, grants, availability, denial for an ungranted
specialist), plus: READ never requests a PIN; wrong PIN and lockout; expiry; replay; modified
arguments; another agent reusing an approval; EmergencyStop after a correct PIN; live write blocked
even with a valid approval; approval and execution audited separately; fixture labelled; the three
new reads through text and voice give the same result; no PIN in transcripts or logs.
Full suite, typecheck and build must pass. Live-data checks need a running gateway and ERPNext
credentials and are reported honestly if unavailable.

## 9. Phase 1 / 1b results (measured 2026-11-08)

Live ERPNext (read-only, pinned hvgerp 3.7.0) through the real ErpBinding -> Governance -> ToolGateway
stack, each read under its owning specialist, in an isolated in-memory process:

- Setup: no blockers; disabled in live: erp.po.create_draft, erp.po.submit only.
- All 23 READ capabilities: registered / available, each returned live data (source=erpnext_live).
- erp.po.get: PUR-ORD-2026-00004 (Kaveri Household Goods, 1 line, total 1,680). ERPNext labels it
  status "Draft" while its docstatus is 1; both are reported. A missing order is reported as not found.
- erp.payments.summary: 480 submitted Payment Entries, all type Receive, total 1,182,424.62 in the year;
  month to date 22,620 across 16 entries; last 31 days 328,986.45 across 140.
- erp.gst.summary: live invoice lines carry ERPNext's own HSN, taxable value and CGST/SGST/IGST fields.
  Every sampled line is Nil-Rated, so tax is honestly 0 (month to date 72 outward lines; 31 days 3,025).
  Customer GSTIN and place of supply are not on these invoices, so B2B/B2C and inter-state are reported
  as not classified and the tool lists them in data_gaps. company_state is null (no reviewed live source).
- Defect found and fixed by this check: a week of GST lines exceeded the gateway's 262,144-byte
  response cap and was discarded. GST is now read one day per governed call (workflow and dashboard)
  and the tool omits null and zero extras.
- Denials: Sales -> gst, Manager -> payments, Finance -> po.get all denied ("Capability is not assigned").
  Manager and OpenClaw main hold no ERP grants.
- Live writes: create_draft and submit refused ("not enabled in this deployment") for the owning
  specialists; no create or submit call reached ERPNext; no adapter write tool exists.
- Text chat (answerDirect): Erin answers GST and payments; Dave answers a named purchase order; a GST
  question put to Bob is answered by Erin's department and says so.
- Live Voice server action (VoiceService.action via the real client allowlist, Gemini's tool call
  simulated): the same figures and the same specialists; a missing PO number returns a request for it;
  a `pin` argument is rejected.

Not verified here: a real Gemini Live voice session (needs a person speaking), `next build` (it shares
.next with a running dev server; run it when that server is stopped), and any real GSTIN-bearing
invoice (the store has none, so the taxed and B2B paths are covered by unit tests only).

## 10. Approval Manager (as built)

It extends the existing `OwnerApprovals` and the Phase C per-call approvals; there is no parallel
system. Live PO draft creation and submission remain disabled: no PIN, token or grant can enable them.

| Piece | Where | What it does |
|---|---|---|
| ApprovalPolicy | `lib/server/nammaops/approval-policy.mjs` | Frozen, server-owned table: reads need nothing; `erp.po.create_draft` needs an approval; `erp.po.submit` needs approval + PIN + exact-document re-read. `live_write: "disabled"` for both. |
| PinVerifier | `lib/server/nammaops/pin-verifier.mjs` | Salted scrypt only. `NAMMAOPS_OWNER_PIN` is hashed in memory at start-up and never compared as plain text. **No built-in default PIN** (the old `1234` is gone): with none set, approvals are refused and the owner sets one in Settings. Failed attempts and the 5-minute lock are persisted, so a restart does not reset them. `verify()` returns a single-use, session-bound proof that expires in a minute. |
| ApprovalStore | existing `nammaops.owner-approval` records (compare-and-set on revision) plus `mcp.approval` records | The owner request (30 minutes, bound to the exact document fingerprint) and, separately, the gateway approval below. |
| ApprovalManager | `OwnerApprovals` in `owner-approvals.mjs` | `approve()` order: live-write guard, EmergencyStop, PIN proof spent, request still pending and unexpired, exact PO re-read and fingerprint match, claim (one winner), then gateway approval, then submit. |
| Gateway approval | `Governance.issueOwnerApproval`, `consumeApproval`, `ToolGateway.invoke` | A Phase C approval issued by the owner after the PIN: bound to user, the `nammaops-po-submit` principal, the capability, the argument fingerprint and the approving session; expires in 2 minutes at most; consumed once. **The ToolGateway re-validates and consumes it immediately before the call.** `decide()` still requires the specialist's own assignment and grant, so a PIN grants nothing. |
| EmergencyStop | `Governance.assertEstopClear`, `ToolGateway`, `OwnerApprovals` | While engaged: an open approval is voided for good (releasing the stop does not revive it), a call holding an approval is refused, and side-effecting calls are paused. The PIN is not even tried. Reads are not paused (see below). |

Approval record fields: `reviewer: "owner"`, `agent_id` (the specialist), `capability_id`,
`args_fingerprint`, `session_id`, `approved_via` (`screen` or `voice`), `decided_at`, `expires_at`,
then `consumed_at`. Execution is a separate `mcp.invocation` record that carries the `approval_id`.

Two ways to give the PIN, both ending in the same checks:
- **Masked on-screen entry** (`NammaOpsPanel`, the approve and reject pages): POST to
  `/approvals/{id}/approve` with `pin` and a per-tab `session`. The PIN is never logged or echoed. This
  also fixes the old `owner_pin` / `pin` mismatch in `useNammaOps.ts`, which made the Procurement and
  Workflows pages unable to approve or reject.
- **Spoken** (`approve_by_voice`, owner's choice): the model passes only an `approval_id` (a `pin` or any
  extra field is refused). The first call opens a 2-minute challenge and returns `pin_required`. The owner
  says the PIN; `VoiceService.finalize` checks that turn **in memory as it is saved** and stores it with the
  digits replaced by `[PIN hidden]`; the next call collects the verdict and approves only if it was right.
  Wrong spoken PINs count against the same persistent lockout. The proof is bound to the call id.

Spoken PIN, the accepted risk (owner's decision on 2026-11-08): the microphone audio still goes to
Gemini Live and to the speech-to-text service, so the PIN is heard by the model and the provider even
though this server never stores it. The on-screen transcript hides the digits while a challenge is open
(display only; the raw words still go to the server so it can check them), and the voice prompt forbids
repeating, spelling or summarising digits, but the prompt is a request, not a guarantee. Gemini's own
session logging is outside this server's control. Prefer on-screen entry when that matters.

Known limits and findings:
- EmergencyStop did not previously reach the ToolGateway, workflows or the voice business-query path; it
  now stops side-effecting calls and voids approvals. **Reads still run during an emergency stop** (they
  were never paused); decide whether reads should be paused.
- The per-session binding is only as strong as the session id the client sends (the API is loopback-only
  and has no user login). It stops one session reusing another's PIN proof or approval; it is not
  user authentication.
- Fixture mode: `erp.po.create_draft` stays ungated (it only drafts, in synthetic data). A live draft
  would need an approval under the policy table once live writes are ever enabled.
- Live writes need a separate security review before activation: see
  `KIRANACREW_ERP_WRITE_SECURITY_REVIEW.md` (not yet written; this work does not enable them).
