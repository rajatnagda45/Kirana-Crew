# Phase 0 audit: what Agent Town does and what is hackathon-only

Read-only audit of branch `feat/office-lead-openclaw-tavily` at `4db65b1` (31 Oct 2026). Nothing was
deleted or changed. Every row cites the file it came from. "Not run" means I read the code but did
not exercise it live.

## Headline findings

1. **The NammaOps integrations are not in this repo.** A case-insensitive search for `erpnext`,
   `gnani`, `namma` and `timbre` across all tracked files (excluding the lockfile) returns nothing.
   The blueprint's ERPNext MCP, Gnani Prisma STT and Gnani Timbre TTS have not been built here yet,
   so there is nothing of them to remove or isolate. They can be designed as optional adapters from
   the start.
2. **The hackathon-specific code is Zetaris, inventory and supplier.** About 20 modules under
   `lib/server/` plus their tests and `scripts/`. They are wired into the core pipeline
   (`task-composer.mjs`, `runtime-api.mjs`, `service-registry.mjs`), so they cannot be deleted
   without touching core files.
3. **Voice is Gemini Live, not Gnani.** `lib/voice/diagnostics.mjs` fixes `gemini-3.8-live`, and
   `app/api/voice/session/route.ts` mints a token with `@google/genai` from `GEMINI_API_KEY`. There
   is no pluggable STT/TTS interface; the provider is hard-coded.
4. **The only MCP code is an outbound dispatch tool.** `lib/mcp/agent-town-mcp.mjs` (145 lines)
   exposes one tool, `dispatch_to_worker`, for the `auggie` provider. There is no MCP client, no
   server discovery and no per-seat tool binding.

## 1. Area-by-area inventory

| Area            | What exists today                                                                                                                                                                                                                                                                          | Source                                                                                                        | Gap against the plan                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Team management | Seats are rows in `seats(id, data JSON)`. `SpecialistRegistry` (923 lines) binds manifests to seats through grants; `bindGrantSeats` only binds unassigned seats. `management.mjs` wraps `agents.create/update` and `sessions.patch` on the gateway.                                       | `task-db.mjs:22`, `specialist-registry.mjs`, `management.mjs`                                                 | Identity and role are split between seat JSON, manifests and the gateway. No single agent profile. |
| Agent runtime   | Three providers behind one gateway shape: OpenClaw (WebSocket), Nightshift (HTTP, text only), Auggie (CLI emulating the OpenClaw protocol). `ExecutionRouter` picks an option by requirements. `TaskRuntime` (964 lines) owns queue, dispatch and `chat.send`.                             | `gateway-connection.mjs`, `execution-router.mjs`, `task-runtime.mjs`, `lib/ws-proxy.mjs`, `auggie-bridge.mjs` | OpenClaw is only used via the router when `AGENT_TOWN_EXECUTION_OPTIONS` is non-empty.             |
| Task system     | `tasks`, `dispatches`, `messages`, `events` tables; `TaskComposer` (1,445 lines) runs classify, plan, collect, analyze, review, verify; `task-lifecycle.mjs` handles states; `task-search.mjs` indexes.                                                                                    | `task-db.mjs`, `task-composer.mjs`, `task-lifecycle.mjs`                                                      | Composer is tightly coupled to Zetaris and Tavily as the two data sources.                         |
| Agent bindings  | Grant JSON maps `manifestId` to `seatId` and `sessionKey` (`agent:<id>:main`). `authorize` compares the session's `tools.effective` to the manifest tools.                                                                                                                                 | `specialist-config.mjs`, `execution-options.mjs`, `nightshift-enforcement.mjs`                                | Binding is env-driven, not editable from the UI.                                                   |
| MCP             | One stdio server with one tool (`dispatch_to_worker`) that POSTs to `/api/internal/dispatch` with a shared secret.                                                                                                                                                                         | `lib/mcp/agent-town-mcp.mjs`                                                                                  | No discovery, no client, no tool catalogue. Needs a new module.                                    |
| REST APIs       | About 35 routes under `/api/runtime/*` (state, events SSE, tasks, composer, team, seats, reviews, management, estop, voice, import, connect, reconcile), plus `/api/agents/discover`, `/api/config`, `/api/contracts`, `/api/voice/session`, `/api/internal/*`.                            | `runtime-api.mjs:318-656`, `app/api/*`, `internal-api.mjs`                                                    | No agent-profile CRUD and no MCP routes. `runtime-api.mjs` is one 690-line router with no OpenAPI. |
| Voice           | Gemini Live in the browser (`client.ts` 699 lines, `VoiceProvider.tsx` 629 lines). Server side only validates actions and records transcripts and diagnostics.                                                                                                                             | `lib/voice/*`, `lib/server/voice.mjs`, `app/api/voice/session/route.ts`                                       | Single provider, key required, no STT/TTS split. Nothing for Gnani.                                |
| Permissions     | Loopback-only bind and origin checks; shared-secret compare for internal routes; `EmergencyStop` kill switch; per-manifest tool allowlists verified through `tools.effective`; approval states in the composer (`approval_required`, `needs_confirmation`).                                | `server-security.mjs`, `estop.mjs`, `execution-options.mjs`, `task-composer.mjs`                              | Allowlists apply to specialist roles only. No per-seat or per-MCP-tool policy.                     |
| Persistence     | One SQLite file via `node:sqlite` (`AGENT_TOWN_DB_PATH`), with a single-owner lock (`runtime_owner`). Tables: seats, tasks, dispatches, messages, sessions, events, inbound, imports, runtime_records, task_search_state, hmem_memories, hmem_ledger. Browser `localStorage` for UI state. | `task-db.mjs:21-36`, `hmem-memory.mjs:31`, `lib/persistence.ts`                                               | Agent profiles have no table of their own. Two processes cannot share a DB.                        |
| Tests           | 92 files in `lib/__tests__` (58 `.ts`, 20 `.tsx`, 14 `.mjs`). Last full run 852 tests passing. CI runs format, lint, typecheck, build, test; paid voice tests off.                                                                                                                         | `lib/__tests__`, `.github/workflows/ci.yml`                                                                   | Live Zetaris, Tavily, OpenClaw and Gemini paths are not covered. 45 browser scripts are not in CI. |

## 2. Classification of integrations

"Core" means the platform needs it. "Demo" means it exists to show the Kirana / inventory story and
should become optional. "Candidate" means it is useful but needs a decision.

| Integration                                     | Where                                                                                                                             | Class                                                 | Why                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OpenClaw gateway                                | `gateway-connection.mjs`, `ws-proxy*.mjs`, `execution-options.mjs`, `gateway.ts`                                                  | **Core**                                              | The runtime the plan builds on.                                                                                                |
| SQLite task store                               | `task-db.mjs`, `runtime-storage.mjs`                                                                                              | **Core**                                              | All state lives here.                                                                                                          |
| Task runtime, router, estop, security           | `task-runtime.mjs`, `execution-router.mjs`, `estop.mjs`, `server-security.mjs`                                                    | **Core**                                              | Generic and provider-agnostic.                                                                                                 |
| Specialist registry and grants                  | `specialist-*.mjs`                                                                                                                | **Core**                                              | Seat to agent binding.                                                                                                         |
| Pixel office UI                                 | `components/game`, `components/hud`, `components/chat`                                                                            | **Core**                                              | The product surface.                                                                                                           |
| Office group chat, Team Lead                    | `office-group-chat.mjs`, `team-lead.mjs`, `office-lead.mjs`, `office-intent.mjs`                                                  | **Core**                                              | Routing of user input, see `prompt-flow.md`.                                                                                   |
| Task Composer                                   | `task-composer.mjs`, `stage-requirements.mjs`, `deliverable-validation.mjs`, `trusted-verification.mjs`                           | **Core**, with Zetaris and Tavily coupling to extract | The pipeline is generic; its data collection is not.                                                                           |
| Service registry                                | `service-registry.mjs`                                                                                                            | **Core**                                              | Already models `zetaris`, `web-search`, `nightshift` and `openclaw` as entries. It is the natural place for optional adapters. |
| H-MEM memory                                    | `hmem-memory.mjs`, `lib/vendor/hmem-reference`, `embeddings.mjs`, `decision-memory.mjs`                                           | **Candidate**                                         | Local only; useful, but the vendored reference copy and conformance scripts are heavy.                                         |
| Nightshift provider                             | `nightshift-*.mjs`                                                                                                                | **Candidate**                                         | Hackathon sponsor reasoning backend. Text only. Keep as an optional provider, not the default.                                 |
| Auggie provider and MCP dispatch                | `auggie-bridge.*`, `auggie-contracts.mjs`, `lib/mcp/`                                                                             | **Candidate**                                         | Pre-hackathon feature. Works as a bridge; unclear whether the plan still wants it.                                             |
| Gemini Live voice                               | `lib/voice/*`, `app/api/voice/session`                                                                                            | **Candidate**                                         | Works, but hard-wired. Needs a provider interface before Gnani can slot in.                                                    |
| Tavily web evidence                             | `web-evidence.mjs`                                                                                                                | **Candidate**                                         | Generic research source; keep behind the service registry.                                                                     |
| Zetaris data                                    | `data-zetaris.mjs`, `zetaris-deadlines.mjs`, `inventory-zetaris-mapping.mjs`, `composer-data.mjs`, `scripts/check-zetaris.mjs`    | **Demo**                                              | Sponsor integration. `composer-data.mjs` mixes it with generic collection (48 matches).                                        |
| Inventory investigation                         | `inventory-*.mjs` (12 files), `inventory-office-api.mjs`, `components/work` inventory views, 3 `check-*inventory*` scripts        | **Demo**                                              | The inventory reconciliation story.                                                                                            |
| Supplier decision                               | `supplier-*.mjs`, `scripts/supplier-demo.mjs`                                                                                     | **Demo**                                              | Supplier demo.                                                                                                                 |
| Synthetic data and sponsor readiness            | `data-synthetic.mjs`, `data-fixtures.mjs`, `inventory-synthetic.mjs`, `sponsor-readiness.mjs`, `scripts/check-sponsor-config.mjs` | **Demo**                                              | Exists to make the demo reproducible and to report sponsor config.                                                             |
| ERPNext MCP, Gnani Prisma STT, Gnani Timbre TTS | Not in the repo                                                                                                                   | **To build**                                          | Treat as optional adapters from day one, as the plan requires.                                                                 |

## 3. Coupling that blocks a clean split

Checked by search, not by running anything.

- `task-composer.mjs` references Zetaris or Tavily in 2 places and imports `composer-data.mjs`, which
  carries 48 Zetaris references. Removing Zetaris means splitting `composer-data.mjs` first.
- `runtime-api.mjs` imports inventory and supplier modules for routes such as
  `/api/runtime/investigations` and `/api/runtime/inventory-eligibility`.
- `service-registry.mjs` has 29 Zetaris references; its structure is already one object per service,
  so it can take new adapters without a rewrite.
- `task-intent.mjs` contains Zetaris-specific data intent keywords (6 matches), which is why data
  prompts are redirected to the Composer.
- `package.json` carries seven demo or sponsor scripts (`supplier:demo`, `sponsors:config`,
  `nightshift:check`, `nightshift:queue:check`, `contracts:check`, `hmem:*`, plus
  `check-live-inventory-browser`).

## 4. Risks seen while auditing

- `.env.local` defaults to `AGENT_PROVIDER=nightshift` and `AGENT_TOWN_TEXT_NEMOTRON_ONLY=1`, which
  blocks OpenClaw unless overridden per process (see `scripts/run-openclaw.sh`).
- `lib/ws-proxy.ts` and `.mjs`, and `auggie-bridge.ts` and `.mjs`, are duplicated mirrors. Any change
  has to be made twice.
- The OpenClaw Work pipeline is blocked in this environment by gateway `tools.effective` failures on
  two sessions. That is an environment fault, not a code finding.
- `artifacts/` holds 1.4 MB of generated run data and is untracked.
- The Phase 0 spec says the repo has a previous hackathon history. `git log` shows 214 commits; the
  latest 27 Oct work lived only in the working tree until `5e5cdad`.

## 5. Proposed cleanup order (not started)

Each step is small and independently testable. None should start without your go-ahead.

1. **Mark, don't move.** Add a `DEMO` marker (a header comment plus a list in this doc) to the demo
   modules. No behaviour change.
2. **Split `composer-data.mjs`** into a generic collector and a Zetaris adapter registered through
   `service-registry.mjs`. Existing tests (`task-composer.test.ts`, `data-source.test.ts`,
   `zetaris-installed-contract.test.ts`) give coverage.
3. **Gate demo routes** (`investigations`, `inventory-eligibility`, supplier) behind an opt-in flag so
   a default start exposes only the core API.
4. **Move demo scripts** out of the default `package.json` scripts into a `demo:*` group.
5. **Introduce a voice provider interface**, with Gemini as the first implementation, before
   starting any Gnani work.
6. Only then delete anything, and only what steps 1 to 4 show to be unreferenced.

## 6. Questions that need your decision

- Keep Nightshift and Auggie as optional providers, or drop them?
- Is the Kirana demo staying in this repo (as an example pack) or moving to its own?
- The uploaded NammaOps blueprint was not available to me. If the plan expects ERPNext, Gnani Prisma
  or Gnani Timbre behaviour that I should compare against, please share the file.
