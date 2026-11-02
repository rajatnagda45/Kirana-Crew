# Phase D: KiranaCrew workforce and three workflows (fixture-first)

## Blueprint reconciliation

**Retained:** five agents and the blueprint permission matrix; intents `stock_check`,
`prepare_reorder`, `daily_report`; a business-level tool registry; deterministic stock analysis;
profit only from posted P&L; owner approval bound to the exact PO with expiry and idempotent
submit; an event per business action; ERPNext as the source of truth.

**Superseded:** local ERPNext Docker (memory) → test fixture, hosted ERPNext later; unpinned
`npx @hvgllc/hvgerp-mcp` → reviewed and pinned 3.7.0, not installed yet; new backend and Postgres
tables → existing KiranaCrew modules and `runtime_records`; in-memory approvals → persisted, PIN
approvals; Gnani → Phase E; town buildings → the world is one office, agents are mapped to seats.

**Blocked:** real ERPNext URL and credentials; hvgerp-mcp `listTools()` discovery and result
normalizers; OpenClaw MCP proxy registration; OpenClaw latency (5–15 min per turn here).

## How it fits together

| Piece                 | Module                                             | Reuses                                                    |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| ERP data (TEST)       | `lib/mcp/fixture-erpnext-server.mjs`               | MCP SDK server                                            |
| Business capabilities | `lib/server/nammaops/erp-binding.mjs`              | Phase C registry and gateway                              |
| Five agents           | `config/nammaops/workforce.json` + `workforce.mjs` | Phase B specializations, Phase A profiles, Phase C grants |
| Workflows             | `lib/server/nammaops/workflows.mjs`                | one runner, three definitions                             |
| Calculations          | `lib/server/nammaops/calculations.mjs`             | deterministic, no model                                   |
| Owner approval        | `lib/server/nammaops/owner-approvals.mjs`          | gateway, `safeSecretEqual`                                |
| REST                  | `lib/server/nammaops/api.mjs`                      | runtime handler                                           |
| UI                    | `components/hud/KiranaCrewPanel.tsx`               | HUD flyout, `/api/runtime/events`                         |

Every specialist step is a child task whose ERP reads are governed MCP calls under that agent's
own identity, so the five agents are separately permissioned, not five chats. PO submission is
granted only to the internal principal `nammaops-po-submit`, which the MCP proxy refuses, and runs
only after the owner's PIN approval of the unchanged draft.

`NAMMAOPS_REASONING=manager` adds one OpenClaw Manager turn per workflow; its figures must match
the computed ones or the reply is discarded. Default is `off`.

## Permission matrix (as granted)

| Business capability                  | Inventory | Sales | Procurement | Finance | Manager | PO principal         |
| ------------------------------------ | --------- | ----- | ----------- | ------- | ------- | -------------------- |
| items, stock, warehouses, ledger     | read      | items | –           | –       | –       | –                    |
| sales/POS invoices, customers        | –         | read  | –           | –       | –       | –                    |
| suppliers, quotations, item prices   | –         | –     | read        | –       | –       | –                    |
| create draft PO / read PO            | –         | –     | write/read  | –       | –       | read                 |
| submit PO                            | –         | –     | –           | –       | –       | after owner approval |
| P&L, GL, purchase invoices, payments | –         | –     | –           | read    | –       | –                    |

## REST (`/api/nammaops/...`, mirrored under `/api/runtime/nammaops/...`, loopback only)

`POST /setup`, `GET /workforce`, `GET /binding`, `GET /dashboard`, `GET|POST /workflows`,
`GET /workflows/{id}`, `GET /workflows/{id}/events`, `GET /approvals`,
`POST /approvals/{id}/approve` `{pin}`, `POST /approvals/{id}/reject` `{pin}`,
`POST /approvals/{id}/reconcile`.

## Running it

Env for the app: `AGENT_TOWN_MCP_STDIO_ALLOWLIST='[{"command":"node","args":["lib/mcp/fixture-erpnext-server.mjs"]}]'`,
`NAMMAOPS_OWNER_PIN=<pin>`. Then `POST /api/nammaops/setup` (needs five free bound OpenClaw seats)
and use the KiranaCrew toolbar panel. Standalone demo: `node --import tsx scripts/nammaops-demo.mjs`.

## hvgerp-mcp 3.7.0 review (not installed, not run)

MIT, Node ≥20, single bundled file, no install scripts, credentials from `ERPNEXT_API_KEY` /
`ERPNEXT_API_SECRET`. About 136 `erpnext_*` tool names appear in the source; they are recorded as
unverified candidates in `config/nammaops/binding.hvgerp.json (the live read-only binding that replaced the template)`. There is no dedicated PO
submit tool; submission would use generic `erpnext_doc_submit`, which must be granted with a
`doctype = Purchase Order` resource scope. Generic delete/update/cancel/method tools must never be
assigned. Going live also needs: `listTools()` against real ERPNext, result normalizers for its
response shapes, and passing three env values (the connection manager passes one secret ref today).
