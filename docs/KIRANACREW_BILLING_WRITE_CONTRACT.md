# Frank creates customer bills (live ERPNext): mapping and contracts

Status: **implemented and verified on 2026-11-08** (section 10 has the as-built notes and the live
result). Owner decisions (2026-11-08): live ERPNext, not the fixture; Frank prepares a **draft** Sales
Invoice; the owner's PIN (on screen or aloud) turns it into a real bill; stock is updated by setting
`update_stock` on the draft (option A); an unclear product is asked, and every bill states its product
and quantity back for checking. This reverses the earlier rule that live writes stay disabled pending a
security review (the purchase-order writes stay disabled), so this document is also the starting point
for that review.

## 1. Why it failed before

"create bill of customer … toor dal … milk" had nowhere to go. Frank is read-only (no create
capability, rules forbid creating invoices), "create" is not in the parser's refusal list, and Frank's
routing phrases are report words, so the request fell to the free-form OpenClaw `main` agent, which
was frozen at the time (about 100 s event-loop stall). This work gives the request a deterministic,
governed path that never depends on the open-ended agent.

## 2. Facts from the live ERP (read-only reconnaissance)

| Fact | Value |
|---|---|
| Company | `NammaOPS` (single company), currency INR |
| Selling price list | `Standard Selling` (INR) |
| Default customer | `Walk-in Customer` exists, group Individual |
| Warehouse used by real invoices | `Stores - N` (`set_warehouse`), `update_stock = 1` |
| Items asked for | `NK-DAL-1KG` Toor Dal 1kg (standard rate 140); the only milk is `NK-MILK-500` Toned Milk 500ml (32). There is no "packet of milk" or "1 L" item. |
| ERPNext tools | `erpnext_sales_invoice_create(customer, items[{item_code, qty, rate, warehouse?}], posting_date?, due_date?, company?, selling_price_list?, currency?, set_warehouse?)` makes a **draft**. `erpnext_sales_invoice_submit(name)` posts it (flagged destructive). |
| Gap | The create tool has **no `update_stock` field**. A bill created through it would post to accounts but **not reduce stock**, unlike every real invoice here. |

## 3. Capabilities (server-owned, in `approval-policy.mjs` and the live binding)

| Capability | Tool (adapter) | Risk | Granted to | Policy |
|---|---|---|---|---|
| `erp.sales_invoice.create_draft` | `create_sales_invoice_draft` | WRITE | Frank (`nammaops-billing`) only | creates a draft only; a draft is not a bill |
| `erp.sales_invoice.get` | `get_sales_invoice` | READ | Frank, `nammaops-bill-submit`, dashboard reader | none |
| `erp.sales_invoice.submit` | `submit_sales_invoice` | EXTERNAL_ACTION | new principal `nammaops-bill-submit` only | approval + owner PIN + exact-document re-read |
| `erp.selling_prices.get` | `get_selling_prices` | READ | Frank | none |

No grant to Manager or OpenClaw `main`. Purchase-order writes (`erp.po.create_draft`, `erp.po.submit`)
**stay disabled in live**: they were not part of this request.

## 4. How the write stays narrow (no loosening of the read-only guard)

The adapter's read path is untouched (`HVGERP_READS`, `readOnlyHint` check). Writes get a **separate,
frozen allowlist** (`HVGERP_WRITES`) that is checked in code, not by prompt:
- `erpnext_sales_invoice_create` is callable only from `create_sales_invoice_draft`, which takes
  `customer`, `items[{item_code, qty}]` and a date, and **fills in everything else itself**: company,
  `Standard Selling`, currency INR, warehouse `Stores - N`, and each `rate` from the live selling price.
  The model and the user cannot choose a rate, account, warehouse or price list.
- It refuses unknown customers (no auto-create), disabled or non-stock items, quantities that are not
  positive and below a cap (proposed 50 units a line, 20 lines), and a posting date not within the
  last 7 days or in the future.
- `erpnext_sales_invoice_submit` is callable only from `submit_sales_invoice`, only for a document
  that is a Sales Invoice with `docstatus = 0` **and** carries the draft's fingerprint, and only with a
  valid gateway approval (section 5).
- No other write tool, `doc_update`, `doc_delete`, cancel, return or payment is reachable.

## 5. Flow (reuses the Approval Manager; nothing parallel)

1. Owner (text, voice or group chat) asks for a bill. A deterministic intent `prepare_bill` is
   recognised (words: create / make / generate / raise a bill or invoice). It is routed to **Frank**.
2. Frank's step resolves the customer (named, else `Walk-in Customer`) and each product with the
   existing product resolver, reads live selling prices, and calls `create_sales_invoice_draft`
   through ErpBinding -> Governance -> ToolGateway under Frank's identity. An ambiguous or unknown
   product ("packet of milk") returns a clarification, not a guess.
3. An owner approval is created for exactly that draft (fingerprint of customer, items, rates, total).
   The reply shows the draft and says it is **not yet a bill**.
4. The owner approves with the PIN, on screen or aloud (`approve_by_voice`). The existing checks run:
   live-write guard, EmergencyStop, PIN proof, unexpired, exact re-read and fingerprint match, claim,
   then the gateway approval bound to principal, capability, arguments and session, then
   `submit_sales_invoice`, then a confirming re-read. Result: submitted, uncertain or failed, never
   claimed without the ERP confirming.
5. `OwnerApprovals` is generalised from "purchase order" to a document kind
   (`purchase_order | sales_invoice`) with the same state machine; PO behaviour and tests do not change.

## 6. Stock (needs your decision)

Without `update_stock` a submitted bill leaves stock unchanged. Options:
- **A (recommended):** the adapter performs one further, hard-coded write: set `update_stock = 1` and
  `set_warehouse` on the **draft it just created** via `erpnext_doc_update`, limited in code to
  `doctype = Sales Invoice`, `docstatus = 0`, those two fields. Matches how every existing invoice
  here was made, so stock stays right.
- **B:** bills post to accounts only; stock must be adjusted separately. Simpler, but stock drifts.

## 7. Risks and controls

| Risk | Control |
|---|---|
| Wrong price or product on a real bill | rates only from live selling prices; ambiguity asks first; the owner sees the exact draft before the PIN |
| Double bill from a retry or a repeated voice turn | idempotency key per request; one draft per key; an uncertain create is reconciled by a read, never resent |
| A draft left behind if the owner never approves | expires in the approval's 30 minutes; drafts do not touch accounts or stock; they stay listed as drafts in ERPNext (there is no delete tool, deliberately) |
| Submitted bill can only be undone by a credit note | PIN, exact re-read, EmergencyStop, per-call approval, audit; credit notes are out of scope |
| Frank reaching further than billing | frozen allowlist, per-capability grants, Manager and `main` ungranted, tests for every denial |
| Spoken PIN heard by the model and speech service | accepted by the owner; the server never stores it |

## 8. Verification plan

Unit and governed tests with the fake ERP (every denial, idempotency, ambiguity, fingerprint change,
EmergencyStop, wrong PIN, replay); the full suite, typecheck, lint and production build; then **one**
real draft created in your live ERPNext for a named test customer line, shown to you before and after.
That draft stays in ERPNext (no delete tool), and nothing is submitted live unless you approve it.

## 9. Open decisions

1. Stock: A or B (section 6).
2. Milk: only `Toned Milk 500ml` exists. Should "a packet of milk" resolve to it, or ask each time?
3. Limits: the 50-unit and 20-line caps and the 7-day date window are proposals.
4. "Hard commit": interpreted as (a) the app stays live-only with no fixture fallback, and (b) a local
   git commit when this is finished and verified. No push.

## 10. As built, and the live result

Built as contracted, with these specifics:
- **Adapter** (`hvgerp-adapter-server.mjs`): `HVGERP_WRITES` is the frozen list `erpnext_sales_invoice_create`,
  `erpnext_doc_update`, `erpnext_sales_invoice_submit`, kept apart from the unchanged read path. The update is
  hard-coded to `Sales Invoice` and only `update_stock` and `set_warehouse`. `create_sales_invoice_draft` takes only
  customer, lines (`item_code`, `qty`) and an optional date; company, price list, currency, warehouse and every rate
  come from ERPNext (price-list rate, else the item's standard rate). Limits: 20 lines, 50 units a line, date from 7
  days back to tomorrow, existing enabled customer only, active stock items only. `submit_sales_invoice` accepts only
  a draft that updates stock and is not a return, and reads it back after.
- **Capabilities** `erp.sales_invoice.get`, `erp.selling_prices.get`, `erp.sales_invoice.create_draft` (Frank, via his
  specialization), `erp.sales_invoice.submit` (principal `nammaops-bill-submit` only, gateway approval required).
- **Approvals**: `OwnerApprovals` now takes a document kind (`purchase_order`, `sales_invoice`); PIN, gateway approval,
  session binding, EmergencyStop and spoken PIN are shared. A pending identical bill is reused, not drafted twice.
- **Routing**: "create / make / generate / raise a bill or invoice" is a bill request in the keyword parser, the Gemini
  intent catalogue, the voice tool and the routers, so Alice hands it to Frank. Asking about bills stays a report.
- **Asking**: missing quantity, unknown or vague product (options listed), a weight that is not a whole number of packs,
  an unknown customer, or no items at all each ask a question and write nothing. With no customer named, Walk-in
  Customer is used and the reply says so. Spoken weights and volumes are converted to whole packs and shown
  ("2 x Toned Milk 500ml (you said 1 l)").

Live test (real ERPNext, real governance, isolated in-memory app database), the sentence that failed:
"create bill of customer which has taken 1 kg toor dal and one packet of milk", asked of Alice.
- Alice answered "Frank (Billing) covers this"; Frank created draft **SINV-26-00497**: Walk-in Customer, 1 x Toor Dal
  1kg at 140 and 1 x Toned Milk 500ml at 32, total **172**, `docstatus 0`, `update_stock 1`, warehouse `Stores - N`.
- Asking again reused the same draft (one new invoice in ERPNext, not two). Unknown customer, no quantity and
  300 g of a 1 kg pack each asked a question and created nothing.
- Stock unchanged (toor dal 133, milk 826) and nothing submitted; audit shows only Frank's create (WRITE, ALLOW) and reads.
- **Not tested live:** the owner's PIN approving and submitting a real bill, because that posts a real invoice and
  moves real stock. It is covered by the fixture tests (same code path, fake ERP) and by the adapter unit tests.
- **Leftover:** draft SINV-26-00497 remains in ERPNext as a draft. The test ran against a throw-away app database, so
  the running app has no approval for it and cannot submit it; there is no delete tool by design, so remove it in
  ERPNext if it is not wanted. A draft touches neither accounts nor stock.

Open points: the first real submit and its stock movement are unverified until the owner approves a bill; the
50-unit, 20-line and 7-day limits are proposals the owner can change in `BILL_LIMITS`; credit notes, returns and
payments are out of scope.
