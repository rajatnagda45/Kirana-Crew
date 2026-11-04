# KiranaCrew 2.0 — Backend Capability Matrix

**Audit date:** 2026-11-03  
**Auditor:** Phase 1 Architectural Review

---

## Legend

| Code  | Meaning                                                                                 |
| ----- | --------------------------------------------------------------------------------------- |
| **A** | Fully implemented — API exists, persists, real data                                     |
| **B** | Partially implemented — endpoint exists, data incomplete or fixture-only                |
| **C** | Not implemented — no backend route exists                                               |
| **D** | Requires external integration — depends on ERPNext live, Gnani AI, or another 3rd party |

---

## 1. Runtime Infrastructure

| Feature                  | Endpoint / Service                     | Method   | Auth            | Real-time | Status | Notes                                                       |
| ------------------------ | -------------------------------------- | -------- | --------------- | --------- | ------ | ----------------------------------------------------------- |
| WebSocket gateway        | `ws://localhost:3000/api/gateway`      | WS       | Token           | ✓         | **A**  | Proxied to OpenClaw/Nightshift                              |
| Server-sent events (SSE) | `/api/runtime/events`                  | GET      | None (loopback) | ✓         | **A**  | Cursor-based replay                                         |
| Full state snapshot      | `/api/runtime/state`                   | GET      | None (loopback) | —         | **A**  | Seats, tasks, sessions, reviews, management                 |
| SQLite database          | In-process via `node:sqlite`           | —        | —               | —         | **A**  | WAL mode; tasks, seats, messages, sessions, events, records |
| Emergency stop           | `/api/runtime/estop`                   | GET/POST | None (loopback) | —         | **A**  | Stops all running tasks                                     |
| Bootstrap                | `/api/runtime/bootstrap`               | POST     | None (loopback) | —         | **A**  | Re-syncs agent assignments                                  |
| Reconcile                | `/api/runtime/reconcile`               | POST     | None (loopback) | —         | **A**  | Reconciles outcome-unknown tasks                            |
| Connect / Disconnect     | `/api/runtime/connect` · `/disconnect` | POST     | None (loopback) | —         | **A**  | Gateway connection control                                  |

---

## 2. Seat Management

| Feature                     | Endpoint                  | Method | Status | Notes                                          |
| --------------------------- | ------------------------- | ------ | ------ | ---------------------------------------------- |
| Save / update seat          | `/api/runtime/seats`      | POST   | **A**  | Persists to SQLite seats table                 |
| Seat discovery              | `/api/agents/discover`    | GET    | **A**  | Lists all registered OpenClaw agents           |
| Seat assignment (workforce) | `/api/nammaops/setup`     | POST   | **A**  | Idempotent; binds 5 agents to free seats       |
| Current workforce           | `/api/nammaops/workforce` | GET    | **A**  | Returns role→seat_id→agentId mapping           |
| Session for seat            | `/api/runtime/sessions`   | POST   | **A**  | Creates or retrieves a session bound to a seat |

---

## 3. Task Management

| Feature                  | Endpoint                         | Method   | Status | Notes                                           |
| ------------------------ | -------------------------------- | -------- | ------ | ----------------------------------------------- |
| Create task              | `/api/runtime/tasks`             | POST     | **A**  | Dispatched to gateway; returns taskId           |
| List tasks (paginated)   | `/api/runtime/tasks`             | GET      | **A**  | offset, limit params; sorted by created DESC    |
| Task detail + lifecycle  | `/api/runtime/tasks/{id}`        | GET      | **A**  | Full task record with lifecycle derivation      |
| Cancel task              | `/api/runtime/tasks/{id}/cancel` | POST     | **A**  | Sends cancel to gateway; marks cancel_requested |
| Task history (paginated) | `/api/runtime/history`           | GET      | **A**  | Returns completed/failed tasks with pagination  |
| Task search              | `/api/runtime/search`            | GET      | **A**  | Full-text search across task messages           |
| Task composer            | `/api/runtime/composer`          | GET/POST | **A**  | AI-assisted task composition using manifests    |

**Task status values (from backend):**
`submitted` → `queued` → `running` → `completed` | `failed` | `stopped` | `interrupted` | `cancel_requested` | `outcome_unknown` | `waiting_approval` | `waiting_question`

---

## 4. Agent Orchestration (Five Real Agents)

All five agents are fully implemented as NammaOps specializations registered via MCP governance.

| Agent              | Role ID                | Business Capabilities                                                                                                           | Backend                                                     | Status |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| Manager            | `nammaops-manager`     | None (coordination only)                                                                                                        | `team-lead.mjs` + `office-lead.mjs`                         | **A**  |
| Inventory (Bob)    | `nammaops-inventory`   | `erp.items.list`, `erp.stock.balance`, `erp.warehouses.list`, `erp.stock.ledger`, `erp.stock.movements`                         | `workflows.mjs` → `stock_check`                             | **A**  |
| Sales (Carol)      | `nammaops-sales`       | `erp.sales_invoices.list`, `erp.pos_invoices.list`, `erp.customers.list`, `erp.items.list`, `erp.sales.history`                 | `workflows.mjs` → `daily_report`                            | **A**  |
| Procurement (Dave) | `nammaops-procurement` | `erp.suppliers.list`, `erp.supplier_quotations.list`, `erp.item_prices.get`, `erp.po.create_draft`, `erp.po.get`, `erp.po.open` | `workflows.mjs` → `prepare_reorder` + `supplier_comparison` | **A**  |
| Finance (Erin)     | `nammaops-finance`     | `erp.pnl`, `erp.gl`, `erp.purchase_invoices.list`, `erp.payments.summary`                                                       | `workflows.mjs` → `daily_report`                            | **A**  |

| Reports (Grace) | `nammaops-reports` | `erp.sales_invoices.list`, `erp.pos_invoices.list`, `erp.items.list`, `erp.stock.balance`, `erp.pnl`, `erp.receivables.aging`, `erp.payables.aging` | `workflows-v2.mjs` → `business_report` | **A** |

| Billing (Frank) | `nammaops-billing` | `erp.sales_invoices.list`, `erp.pos_invoices.list`, `erp.customers.list`, `erp.items.list`, `erp.receivables.aging` | `workflows-v2.mjs` → `billing_summary` | **A** |

---

## 5. NammaOps Workflows

| Workflow            | Intent ID             | Agents Involved                                | Endpoint                                                                             | Status | Notes                                                          |
| ------------------- | --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------- |
| Stock check         | `stock_check`         | Inventory (Bob)                                | `POST /api/nammaops/workflows` `{"action":"stock_check"}`                            | **A**  | Returns items with stock vs reorder level                      |
| Reorder preparation | `prepare_reorder`     | Inventory (Bob) + Procurement (Dave) + Manager | `POST /api/nammaops/workflows` `{"action":"prepare_reorder"}`                        | **A**  | Creates draft POs; requires owner approval to submit           |
| Daily report        | `daily_report`        | Sales (Carol) + Finance (Erin)                 | `POST /api/nammaops/workflows` `{"action":"daily_report","date":"YYYY-MM-DD"}`       | **A**  | Sales totals + P&L for a date                                  |
| Demand forecast     | `demand_forecast`     | Inventory (Bob)                                | `POST /api/nammaops/workflows` `{"action":"demand_forecast"}`                        | **A**  | Statistical forecast based on stock movements                  |
| Supplier comparison | `supplier_comparison` | Procurement (Dave)                             | `POST /api/nammaops/workflows` `{"action":"supplier_comparison","products":["..."]}` | **A**  | Quotes from registered suppliers                               |
| Workflow list       | —                     | —                                              | `GET /api/nammaops/workflows`                                                        | **A**  | All runs; sorted by start desc                                 |
| Workflow detail     | —                     | —                                              | `GET /api/nammaops/workflows/{id}`                                                   | **A**  | Full view with tasks and timeline                              |
| Workflow timeline   | —                     | —                                              | `GET /api/nammaops/workflows/{id}/events`                                            | **A**  | Stage-by-stage execution events                                |
| NammaOps dashboard  | —                     | —                                              | `GET /api/nammaops/dashboard`                                                        | **A**  | Latest run per workflow kind + approvals + workforce + binding |

---

## 6. Owner Approvals

| Feature               | Endpoint                                 | Method | Status | Notes                                         |
| --------------------- | ---------------------------------------- | ------ | ------ | --------------------------------------------- |
| List approvals        | `/api/nammaops/approvals`                | GET    | **A**  | Pending, approved, rejected                   |
| Approve               | `/api/nammaops/approvals/{id}/approve`   | POST   | **A**  | Requires `owner_pin` in body                  |
| Reject                | `/api/nammaops/approvals/{id}/reject`    | POST   | **A**  | Reason in body                                |
| Reconcile             | `/api/nammaops/approvals/{id}/reconcile` | POST   | **A**  | Resolve stuck approvals                       |
| Frontend review queue | `/api/runtime/reviews`                   | GET    | **A**  | Backend review requests (approval + question) |
| Decide on review      | `/api/runtime/reviews/{id}/decide`       | POST   | **A**  | Submit approval/question answer               |

---

## 7. Chat & Messaging

| Feature                   | Endpoint                         | Status | Notes                                                                                     |
| ------------------------- | -------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| Group chat (send message) | `POST /api/runtime/office-group` | **A**  | Routes to office lead (Alice), returns AI response                                        |
| Group chat (get messages) | `GET /api/runtime/office-group`  | **A**  | Returns last N messages                                                                   |
| Session chat history      | `GET /api/runtime/history`       | **A**  | Per session key with offset                                                               |
| WebSocket message stream  | `ws://.../api/gateway`           | **A**  | Streaming assistant deltas in real time                                                   |
| Message persistence       | SQLite `messages` table          | **A**  | Persisted across restarts                                                                 |
| Direct agent chat         | Not a distinct route             | **B**  | All chat routes through office-lead (Alice); agent-specific routing via workforce mapping |
| Conversation sessions     | `/api/runtime/sessions`          | **A**  | Create/get session for a seat                                                             |

---

## 8. Voice Integration

| Feature                | Service                                   | Status | Notes                                                                      |
| ---------------------- | ----------------------------------------- | ------ | -------------------------------------------------------------------------- |
| Voice session          | `VoiceProvider.tsx` (client)              | **A**  | WebSocket-based voice session                                              |
| Voice actions          | `POST /api/runtime/voice/actions`         | **A**  | Execute voice intent (nammaops_business_query maps to NammaOps workflows)  |
| Voice context          | `GET /api/runtime/voice/context`          | **A**  | Agent context for STT/TTS                                                  |
| Voice transcripts      | `POST /api/runtime/voice/transcripts`     | **A**  | Store voice turn transcripts                                               |
| Voice diagnostics      | `GET/POST /api/runtime/voice/diagnostics` | **A**  | Full diagnostic snapshot                                                   |
| STT provider           | `lib/server/stt.mjs`                      | **B**  | Configured via `GNANI_API_KEY`; commented out in .env; uses local fallback |
| TTS provider           | `lib/voice/`                              | **B**  | Gnani Timbre configured but key not active                                 |
| Business voice routing | `VoiceRouter.mjs`                         | **A**  | Maps voice intents → NammaOps workflows (8 intents defined)                |
| Kannada / Hindi        | Gnani AI                                  | **D**  | Requires `GNANI_API_KEY` to be active                                      |

**Voice intents mapped:**
`list_products` → stock_check, `check_stock` → stock_check, `sales_summary` → daily_report, `top_selling_products` → daily_report, `business_profit` → daily_report, `demand_forecast` → demand_forecast, `supplier_comparison` → supplier_comparison, `prepare_purchase_order` → prepare_reorder

---

## 9. Inventory

| Feature                     | Capability                     | Source                | Status | Notes                                                                                                                  |
| --------------------------- | ------------------------------ | --------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| List items                  | `erp.items.list`               | Fixture MCP / ERPNext | **B**  | Fixture: synthetic 40-item catalog. Live: real ERPNext items if `NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json` |
| Stock balance               | `erp.stock.balance`            | Fixture MCP / ERPNext | **B**  | Returns qty + reorder level per item/warehouse                                                                         |
| Stock ledger                | `erp.stock.ledger`             | Fixture MCP / ERPNext | **B**  | Date-range movements                                                                                                   |
| Stock movements             | `erp.stock.movements`          | Fixture MCP / ERPNext | **B**  | Per-item movement history                                                                                              |
| Warehouses                  | `erp.warehouses.list`          | Fixture MCP / ERPNext | **B**  | Lists warehouses                                                                                                       |
| Stock count / investigation | `/api/runtime/investigations`  | In-process reasoning  | **A**  | Full multi-step inventory count investigation with evidence                                                            |
| Inventory startup           | `createInventoryStartupReader` | Zetaris or fixture    | **A**  | Loads startup inventory data (Zetaris connector or fixture JSON)                                                       |
| Add/edit product            | —                              | —                     | **C**  | No create/update item endpoint; read-only by design                                                                    |
| Stock adjustment            | —                              | —                     | **C**  | Forbidden by agent policy; no UI endpoint                                                                              |

---

## 10. Suppliers & Procurement

| Feature                      | Capability                     | Source                | Status | Notes                                                                     |
| ---------------------------- | ------------------------------ | --------------------- | ------ | ------------------------------------------------------------------------- |
| List suppliers               | `erp.suppliers.list`           | Fixture MCP / ERPNext | **B**  | Fixture: synthetic supplier catalog                                       |
| Supplier quotations          | `erp.supplier_quotations.list` | Fixture MCP / ERPNext | **B**  | Date-ranged quotations                                                    |
| Item prices                  | `erp.item_prices.get`          | Fixture MCP / ERPNext | **B**  | Per-item price lists                                                      |
| Create draft PO              | `erp.po.create_draft`          | Fixture MCP / ERPNext | **B**  | Draft PO creation (no submission without approval)                        |
| Get PO                       | `erp.po.get`                   | Fixture MCP / ERPNext | **B**  | Retrieve draft PO                                                         |
| Submit PO                    | `erp.po.submit`                | Fixture MCP / ERPNext | **B**  | Only after owner approves; granted to `nammaops-po-submit` principal only |
| Supplier comparison workflow | `supplier_comparison`          | NammaOps              | **A**  | Ranks suppliers by price and lead time                                    |
| Reorder workflow             | `prepare_reorder`              | NammaOps              | **A**  | Full reorder recommendation → draft PO → approval gate                    |
| Supplier directory UI        | —                              | —                     | **C**  | No dedicated frontend page                                                |
| Purchase order list UI       | —                              | —                     | **C**  | No dedicated frontend page                                                |

---

## 11. Sales & Billing

| Feature               | Capability                | Source                | Status | Notes                                                      |
| --------------------- | ------------------------- | --------------------- | ------ | ---------------------------------------------------------- |
| Sales invoices        | `erp.sales_invoices.list` | Fixture MCP / ERPNext | **B**  | Date-ranged invoice list                                   |
| POS invoices          | `erp.pos_invoices.list`   | Fixture MCP / ERPNext | **B**  | Point-of-sale records                                      |
| Customer list         | `erp.customers.list`      | Fixture MCP / ERPNext | **B**  | Basic customer records                                     |
| Sales history         | `erp.sales.history`       | Fixture MCP / ERPNext | **B**  | Aggregate history                                          |
| Daily report workflow | `daily_report`            | NammaOps              | **A**  | Sales totals, top products, P&L for a date                 |
| POS UI                | —                         | —                     | **C**  | No real-time billing interface built                       |
| Transaction creation  | —                         | —                     | **C**  | Forbidden by agent policy; ERPNext is the system of record |

---

## 12. Finance

| Feature              | Capability                   | Source                | Status | Notes                      |
| -------------------- | ---------------------------- | --------------------- | ------ | -------------------------- |
| Profit & Loss        | `erp.pnl`                    | Fixture MCP / ERPNext | **B**  | Date-range P&L report      |
| General Ledger       | `erp.gl`                     | Fixture MCP / ERPNext | **B**  | Account-level entries      |
| Purchase invoices    | `erp.purchase_invoices.list` | Fixture MCP / ERPNext | **B**  | Supplier bills             |
| Payment summary      | `erp.payments.summary`       | Fixture MCP / ERPNext | **B**  | Aggregated payment records |
| Finance dashboard UI | —                            | —                     | **C**  | No dedicated frontend page |
| Journal entries      | —                            | —                     | **C**  | Forbidden by agent policy  |

---

## 13. Analytics & Reporting

| Feature                                              | Status | Notes                                                            |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| NammaOps dashboard (latest workflow results)         | **A**  | `GET /api/nammaops/dashboard`                                    |
| Office observability (evidence, verification, tasks) | **A**  | `GET /api/runtime/office-overview`                               |
| Task analytics (completed/failed counts)             | **B**  | Derivable from task list; no aggregation endpoint                |
| Sales analytics (trends, top products)               | **B**  | Via `daily_report` workflow; no chart-ready aggregation endpoint |
| Stock analytics                                      | **B**  | Via `stock_check` workflow                                       |
| AI workforce analytics (task rates, execution times) | **C**  | No dedicated analytics endpoint                                  |
| Report export                                        | **C**  | No export endpoint                                               |
| Frontend analytics dashboards                        | **C**  | No chart components built                                        |

---

## 14. Reviews

| Feature                                    | Status | Notes                                                |
| ------------------------------------------ | ------ | ---------------------------------------------------- |
| Review service (backend)                   | **A**  | `ReviewService` in `reviews.mjs`; persists to SQLite |
| Review list                                | **A**  | `GET /api/runtime/reviews`                           |
| Review decision                            | **A**  | `POST /api/runtime/reviews/{id}/decide`              |
| Customer-facing reviews (ratings/feedback) | **C**  | No external review integration; empty state correct  |

---

## 15. Activity & Audit Logs

| Feature                   | Status | Notes                                                                                         |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| Operation records         | **A**  | `OperationRecords` in `operation-records.mjs`; evidenceItem, verificationResult, task records |
| Event log                 | **A**  | `events` table in SQLite; accessible via SSE cursor                                           |
| Office observability view | **A**  | `GET /api/runtime/office-overview` returns evidence + verifications + orchestration tasks     |
| Frontend activity log UI  | **C**  | No dedicated page; existing OperationsPanel shows live metrics only                           |
| Filterable audit log      | **C**  | No search/filter API for audit events                                                         |

---

## 16. Integrations & Connections

| Integration                   | Status | Config Key                                                                                                     | Notes                                                                        |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| OpenClaw gateway              | **A**  | `GATEWAY_URL`, `GATEWAY_TOKEN`                                                                                 | Primary agent execution environment                                          |
| ERPNext (fixture)             | **A**  | Default                                                                                                        | Synthetic 40-item kirana store data; MCP server `fixture-erpnext-server.mjs` |
| ERPNext (live via hvgerp)     | **D**  | `NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json`, `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` | Real ERPNext; adapter `hvgerp-adapter-server.mjs`                            |
| Gnani AI (STT)                | **D**  | `GNANI_API_KEY`                                                                                                | Commented out; Prisma STT planned                                            |
| Gnani AI (TTS)                | **D**  | `GNANI_API_KEY`                                                                                                | Timbre TTS planned                                                           |
| Nightshift (local LLM)        | **B**  | `AGENT_PROVIDER=nightshift`, `NIGHTSHIFT_API_KEY`                                                              | Works for local/self-hosted models                                           |
| Zetaris data connector        | **B**  | `NAMMAOPS_DATA_SOURCE=zetaris`                                                                                 | Inventory data source; adapter present                                       |
| MCP servers                   | **A**  | Runtime-registered                                                                                             | Governed via Phase C capability registry                                     |
| Evon v3.3                     | **C**  | —                                                                                                              | Self-hosted only; not yet wired                                              |
| Integrations status page (UI) | **C**  | —                                                                                                              | No frontend page                                                             |

---

## 17. Settings, Users & Permissions

| Feature             | Status | Notes                                                                           |
| ------------------- | ------ | ------------------------------------------------------------------------------- |
| Store settings      | **C**  | No settings model; store name is hardcoded                                      |
| Voice settings      | **B**  | Voice config in `lib/voice/config.ts`; no settings UI                           |
| Agent configuration | **B**  | `developer-config.mjs` + `specialist-config.mjs`; no settings UI                |
| User management     | **C**  | Single-user local application; no multi-user auth                               |
| Authentication      | **C**  | No auth layer; loopback-only for sensitive routes                               |
| Owner PIN           | **B**  | `NAMMAOPS_OWNER_PIN` env var; used only for purchase order approval             |
| System health       | **B**  | `GET /api/runtime/services` returns service registry; no consolidated health UI |

---

## 18. Real-time Synchronization

| Feature                  | Status | Notes                                                                                    |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| Task status updates      | **A**  | Via WebSocket gateway events; reducer handles `task_update`                              |
| Seat status updates      | **A**  | Via WebSocket events; seat patch in reducer                                              |
| Chat message streaming   | **A**  | WebSocket streaming deltas; `assistant_delta` events                                     |
| Agent activity (3D sync) | **B**  | `office-activities` via `gameEvents` bus; wired to CrewSim but not full backend activity |
| Workflow stage events    | **A**  | Via SSE or `GET /api/nammaops/workflows/{id}/events`                                     |
| Approval notifications   | **A**  | Via WebSocket; `waiting_approval` task status triggers review UI                         |
| Reconnection handling    | **A**  | Gateway auto-reconnects; stale tasks marked `outcome_unknown` on disconnect              |

---

## Summary

### What is fully working (A):

- WebSocket gateway with task creation, status updates, and streaming
- All five NammaOps agents (Manager, Inventory, Sales, Procurement, Finance)
- All five NammaOps workflows (stock_check, prepare_reorder, daily_report, demand_forecast, supplier_comparison)
- Owner approval flow with PIN gate
- Task management (create, list, detail, cancel, history, search)
- Chat via office-group (routes to Alice → delegates to agents)
- Inventory investigation (multi-step evidence-based count)
- Review/approval queue
- Voice routing (maps intents → workflows)
- SQLite persistence
- Real-time events (SSE + WebSocket)
- 3D store (StoreRenderer + CrewSim + A* pathfinding)

### What is partially working (B):

- ERP data access (fixture synthetic data; live ERPNext requires env vars)
- Voice STT/TTS (Gnani API key required)
- Agent activity sync to 3D scene (works but via event bus, not direct backend stream)

### What is not yet built (C):

- Overview / Command Center page
- Workflow management UI
- Inventory management UI
- Supplier/Procurement management UI
- Finance dashboard UI
- Analytics & reporting dashboards
- Activity & audit log UI
- Integrations status page
- Settings page
- Customer CRM UI
- Full chat workspace (3-pane layout)
- Agent detail pages

### What requires external integration (D):

- Gnani AI (Kannada/Hindi voice) — `GNANI_API_KEY`
- Live ERPNext — `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`
- Evon v3.3 — self-hosted only

---

## Implementation Priority Map for KiranaCrew 2.0

| Phase | Feature                                  | Backend dependency                                            | Effort |
| ----- | ---------------------------------------- | ------------------------------------------------------------- | ------ |
| 2     | Navigation sidebar + shell refactor      | None (UI only)                                                | Low    |
| 3     | Overview / Command Center                | `GET /api/nammaops/dashboard` + `GET /api/runtime/state`      | Low    |
| 4     | Workforce agent directory + detail pages | `GET /api/runtime/state` + `GET /api/runtime/office-overview` | Medium |
| 5     | Full chat workspace (3-pane)             | `GET/POST /api/runtime/office-group` + WebSocket              | Medium |
| 5     | Task board with all states               | `GET /api/runtime/tasks` + `GET /api/runtime/history`         | Medium |
| 6     | Workflow management UI                   | `GET/POST /api/nammaops/workflows`                            | Low    |
| 7     | Inventory UI                             | `GET /api/nammaops/dashboard` + `stock_check` workflow        | Low    |
| 7     | Supplier/Procurement UI                  | `supplier_comparison` + `prepare_reorder` + approvals         | Medium |
| 7     | Finance UI                               | `daily_report` workflow + P&L display                         | Low    |
| 8     | Analytics dashboards                     | Workflow results + task aggregation                           | Medium |
| 8     | Activity logs                            | `GET /api/runtime/office-overview` + operations records       | Medium |
| 9     | Integrations status                      | `GET /api/nammaops/binding` + `GET /api/runtime/services`     | Low    |
| 9     | Settings                                 | Env var exposure + voice config                               | Low    |
