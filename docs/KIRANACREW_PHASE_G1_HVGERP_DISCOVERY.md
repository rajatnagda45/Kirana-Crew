# Phase G1: hvgerp-mcp 3.7.0 discovery and read-only verification

Scope: install the pinned package, discover its real tools with `listTools()`, verify authenticated
read-only access to the seeded ERPNext Cloud site. Nothing is wired into the agents, the voice
router or the binding yet; fixture mode is unchanged. No ERPNext write was made.

## Install

- `@hvgllc/hvgerp-mcp@3.7.0`, exact pin (`package.json`, `pnpm-lock.yaml`), installed with
  `--ignore-scripts`. The package has no dependencies and no install scripts. `latest` on npm is
  3.8.0; it was deliberately not adopted.
- Run: `node node_modules/@hvgllc/hvgerp-mcp/hvgerp-mcp.mjs --categories=sales,inventory,purchasing,accounting`
  over stdio, with `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` in the child environment only.
- Scripts: `scripts/erpnext-mcp-discover.mjs` (listTools) and `scripts/erpnext-mcp-verify-read.mjs`
  (read calls; refuses any tool the server does not mark `readOnlyHint: true`).
- Discovery output: `config/nammaops/hvgerp-tools.discovered.json` (47 tools, no credentials).

## What the server reports (4 categories: 47 tools; all categories: 135)

Annotated read-only by the server: 32 of 47. Writes in the 4 categories: `*_create`, `*_update`,
`sales_invoice_submit`, `sales_order_submit/cancel`. There is **no** `purchase_order_submit` tool;
submitting a purchase order exists only as the generic `erpnext_doc_submit` (another category).

## Live read-only results (identity: the key's user, not Administrator)

| Check                                 | Through MCP                           | Direct REST cross-check                       |
| ------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Items (`NK-*`)                        | 36                                    | 36                                            |
| Stock balance, Stores - N             | 35 bins                               | 35                                            |
| Sales invoices 2026-10-31             | 6                                     | 6                                             |
| Sales invoices, all                   | 479 (limit 1000)                      | 479                                           |
| Supplier quotations / purchase orders | 16 / 4                                | 16 / 4                                        |
| P&L 2026-10-31                        | income 15745, expense 13131, net 2614 | invoices 15745; GL Sales 15745; GL COGS 13131 |

Latency 37-342 ms per call. List results carry `count`, `returned`, `has_more`.

## Gaps against KiranaCrew business capabilities (for G2)

| Capability                                 | Finding                                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `erp.items.list`                           | `item_list` omits reorder levels; `item_get` returns `reorder_levels` per warehouse (one call per item).                                                                                        |
| `erp.stock.balance`                        | `stock_balance` OK (reserved and projected qty included).                                                                                                                                       |
| `erp.sales_invoices.list` / lines          | `sales_invoice_list` is headers only; lines need `sales_invoice_get` per invoice.                                                                                                               |
| `erp.pos_invoices.list`                    | No POS tool; seeded data is plain Sales Invoices.                                                                                                                                               |
| `erp.sales.history`, `erp.stock.movements` | No bulk tool. `stock_ledger_list` needs item + warehouse and returns at most 20 rows, so 90-day ledger / stockout detection is not available from it.                                           |
| `erp.supplier_quotations.list`             | `supplier_quotation_list` has headers only (no item, rate, lead time); no `supplier_quotation_get` in the 4 categories. Generic `erpnext_doc_get` could read it but is unrestricted by DocType. |
| `erp.item_prices.get`                      | Not exposed by these categories.                                                                                                                                                                |
| `erp.po.create_draft` / `po.get`           | `purchase_order_create` and `purchase_order_get` exist.                                                                                                                                         |
| `erp.po.submit`                            | Only generic `erpnext_doc_submit`; needs gateway argument constraints before it can be used.                                                                                                    |
| `erp.pnl`                                  | `erpnext_financial_report` with `report: "Profit and Loss Statement"` works and reconciles.                                                                                                     |
| `erp.gl`, purchase invoices, payments      | `gl_entry_list`, `purchase_invoice_list`, `payment_entry_list` exist.                                                                                                                           |

## Data and identity notes

- `erpnext_whoami` reports `identity_mode: shared-service-account`: every call runs as the key's user.
  The current key belongs to a personal System Manager user (40+ roles). The limited `nammaops.api`
  user has not been created.
- The 4 seeded purchase orders have `docstatus = 1` but status `Draft`, because the seed inserted
  them with `docstatus: 1` instead of submitting them. Status-based reads would mistake them for
  drafts. Fixing it is an ERPNext write and was not done.

# Phase G2: live read-only binding for the voice agents

Alice, Bob, Carol and Dave reach live ERPNext through the same path as fixture data: voice tool
`nammaops_business_query` -> voice router -> KiranaCrew workflow -> specialist agents -> Phase C
governance gateway -> **`lib/mcp/hvgerp-adapter-server.mjs`** -> pinned `@hvgllc/hvgerp-mcp@3.7.0` -> ERPNext.

## How to run live

```
NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json
AGENT_TOWN_MCP_STDIO_ALLOWLIST=[{"command":"node","args":["lib/mcp/hvgerp-adapter-server.mjs"]}]
ERPNEXT_URL / ERPNEXT_API_KEY / ERPNEXT_API_SECRET   (server environment only)
```

then `POST /api/nammaops/setup`. Fixture mode is unchanged (`binding.fixture.json`, the default).
Answers carry `source: "erpnext_live"` and the data label in their limitations.

## What is and is not enabled

- Enabled (read-only): items with reorder levels, stock, warehouses, suppliers, supplier quotations
  (rates, lead times, validity), buying prices, sales invoices and lines, POS invoices, customers,
  posted P&L, GL, purchase invoices, open purchase orders, 90-day sales lines and stock ledger.
- Disabled on purpose (`disabled` in the binding, not an error): `erp.po.create_draft`,
  `erp.po.get`, `erp.po.submit`, `erp.payments.summary`. On live data a purchase-order request
  creates no draft and no approval. Enabling drafts and PIN-gated submission is a separate step.
- The agents never see hvgerp tools. The adapter calls only 17 named read tools, verified read-only
  at startup, and the generic `erpnext_doc_get` / `erpnext_doc_list` only for Supplier Quotation,
  POS Invoice, Stock Ledger Entry and Item Price. hvgerp runs with the `operations` category loaded
  (for those two generic reads); `doc_submit` and the other operations tools are never called.
- Large ranges are read in 7-day slices, because the gateway discards tool responses over 256 KB.

## Verification

| Level                                                                      | Result                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit / fixture (`nammaops-live-adapter.test.ts`)                           | 12 tests: read-only guard, document-type allowlist, partial-list splitting, draft/cancelled filtering, docstatus over status label, workflows over the live binding, no write capability granted |
| Live ERPNext, adapter vs direct ERPNext reads                              | items 36, bins 35, suppliers 5, customers 21, quotation lines 16, buying prices 33, invoices 10-31: 6 (15,745), ledger 11,574, open purchase orders 4, P&L 10-31: 15,745 / 13,131 / 2,614        |
| Live ERPNext, workflows + voice router (`scripts/check-nammaops-live.mjs`) | all checks pass; 64 governed reads, none a write                                                                                                                                                 |
| Browser / paid Gemini on live data                                         | not run                                                                                                                                                                                          |

## Data caveats found while verifying

- The seed never zeroed toor dal's stock during its six sales-free days, so the ledger proves no
  stockout; the forecast correctly excludes none.
- The seeded millet item has no sales or stock movements, which exposed a forecast bug (zero-filled
  history); fixed, an item with no evidence is now `insufficient_evidence`.
- Supplier quotations carry no availability, and suppliers carry no on-time rate, so rankings state
  those as missing.

# Running inside the app (port 3000)

- `.env.local`: `NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json`; the existing
  `AGENT_TOWN_MCP_STDIO_ALLOWLIST` line now also allows `lib/mcp/hvgerp-adapter-server.mjs`.
  Remove `NAMMAOPS_BINDING` to return to fixture data. Backup of the previous file kept outside the repo.
- Finance bound to seat-5 (label "Finance"); setup: 5 specialists, no blockers, 4 disabled writes.
  seat-4 still holds three `outcome_unknown` office-chat tasks from 27 Oct and was left alone.
- The KiranaCrew panel now states "Data source: live ERPNext (read-only ...)" on live data.

| Level                   | Result                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App REST (live ERPNext) | stock, daily report 31 Oct (15,745 / 6 / net 2,614), empty day = profit unverified, sugar quotation, unknown product clarification, forecast (millet: insufficient evidence), reorder = no draft                                                             |
| Browser                 | panel shows live source + Finance; "Cooking oil" asks which of 4 oils; group chat "Bob, check the stock of milk" answered 828 / reorder 114 from live ERPNext                                                                                                |
| Live Gemini (7 calls)   | Alice stock, Carol sales, Alice profit (via Finance), Dave sugar quotations, Alice unknown product: correct. Bob: right numbers but said "test fixture" (prompt priming, fixed). "What to order tomorrow": harness hung up early (fixed); both need a re-run |

## Seeded purchase orders

All four are submitted (docstatus 1, ordered qty counted in Bins, 0% received/billed); only the
status label says `Draft`. ERPNext's `purchase_order.update_status` refuses
"To Receive and Bill" (it only accepts manual statuses such as Closed / On Hold), and nothing was
changed. Correcting the label would need a close-then-reopen cycle (which recomputes the status but
briefly changes ordered quantities) or a fresh, properly submitted copy; not done without approval.
The adapter is unaffected because it reads docstatus, not the label.

## Not mine, not changed

`office-group-chat.mjs`, its test and `nammaops/group-business.mjs` (another session's work) cause the
`record-preview` test failure, 2 lint errors and 2 format warnings. Its router also does not yet
recognise "Carol, how much did we sell yesterday?" (that message would go to an OpenClaw turn).
