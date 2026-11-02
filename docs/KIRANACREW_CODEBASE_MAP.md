# KiranaCrew — Codebase Map

> **Note (2026-11-02):** The public product brand for the kirana store workforce is now **KiranaCrew**. This file documents the underlying KiranaCrew codebase architecture. For KiranaCrew-specific documentation, see [AGENT_WORKFORCE.md](AGENT_WORKFORCE.md), [GNANI_INTEGRATION.md](GNANI_INTEGRATION.md), [VOICE_WORKFLOW.md](VOICE_WORKFLOW.md), and [DEMO_WALKTHROUGH.md](DEMO_WALKTHROUGH.md).

A navigation guide for engineers. Every subsystem is described with its responsibilities, key exports, dependencies, and communication with the rest of the system.

---

## Top-Level Layout

```
kiranacrew/
├── app/              Next.js App Router (pages, layouts, API route handlers)
├── components/       React components (game, HUD, chat, panels, UI)
├── lib/              All non-UI logic: server runtime, gateway, voice, persistence, types
│   ├── server/       Server-only modules (.mjs) — the full backend runtime
│   ├── voice/        Voice client + provider (browser + server)
│   ├── hooks/        React hooks (useGateway, useSession, useTaskRouter)
│   ├── mcp/          MCP server entry (kiranacrew-mcp.mjs)
│   ├── vendor/       Vendored library (hmem-reference)
│   └── __tests__/    All test files
├── types/            Shared TypeScript types (game.ts)
├── bin/              CLI entry point (kiranacrew.mjs)
├── scripts/          Build, check, and release scripts
├── docs/             Documentation
├── public/           Static assets (audio worklets, sprites, maps, sounds)
└── server.ts         Dev server entry
    server.prod.mjs   Production standalone server
```

---

## Subsystem 1: HTTP + SSE Server Entry

| Property                   | Detail                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `server.ts`, `server.prod.mjs`, `next.config.ts`                                                                                                               |
| **Responsibility**         | Boot Node HTTP server, attach Next.js handler, route `/api/runtime/*` and `/api/agents/discover` to `createRuntimeHandler`, optionally attach Auggie bridge WS |
| **Key functions**          | `createTaskService()` (imported from runtime-api.mjs), `resolveBindHost()`, `validateGatewayTarget()`, `attachAuggieBridge()`                                  |
| **Depends on**             | `lib/server/runtime-api.mjs`, `lib/server-security.mjs`, `lib/auggie-bridge.ts`, `lib/ws-proxy.ts`, `lib/internal-api.mjs`                                     |
| **Inputs**                 | Environment variables: `PORT`, `HOST`, `AGENT_PROVIDER`, `GATEWAY_URL`, `GATEWAY_TOKEN`                                                                        |
| **Outputs**                | HTTP server on `HOST:PORT`; SSE stream; all runtime API responses                                                                                              |
| **Reusable independently** | No — tightly coupled to Next.js and the runtime                                                                                                                |

---

## Subsystem 2: Runtime API Handler

| Property                   | Detail                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/runtime-api.mjs`                                                                                                                                                                                                                                     |
| **Responsibility**         | All `/api/runtime/*` route logic, SSE stream management, request body parsing, origin security checks, and gateway connect/disconnect                                                                                                                            |
| **Key functions**          | `createTaskService(options)`, `createRuntimeHandler(runtime)`, `bindGrantSeats(runtime, grants)`                                                                                                                                                                 |
| **Depends on**             | `TaskRuntime`, `TaskDatabase`, `ServerGateway` or `NightshiftGateway`, `OfficeOperations`, `TeamLead`, `TaskComposer`, `OfficeGroupChat`, `ServiceRegistry`, `EmergencyStop`, `TaskSearch`, `office-lead.mjs`, `inventory-office-api.mjs`, `server-security.mjs` |
| **Inputs**                 | HTTP requests from browser; environment variables                                                                                                                                                                                                                |
| **Outputs**                | JSON responses; SSE events                                                                                                                                                                                                                                       |
| **Communication**          | Calls methods on `TaskRuntime` and its sub-services; subscribes to `db.subscribe()` for SSE                                                                                                                                                                      |
| **Reusable independently** | Yes, with adaptation — the handler pattern is clean; the dependency injection via `createTaskService` is clear                                                                                                                                                   |

---

## Subsystem 3: TaskDatabase

| Property                   | Detail                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Files**                  | `lib/server/task-db.mjs`                                                                                                                                     |
| **Responsibility**         | All SQLite read/write; event emission + fan-out to SSE subscribers; single-process ownership lock; cursor-based event replay                                 |
| **Key class**              | `TaskDatabase`                                                                                                                                               |
| **Key methods**            | `insertTask()`, `updateTask()`, `claim()`, `saveSeat()`, `saveSession()`, `saveRecord()`, `emit()`, `publish()`, `subscribe()`, `replay()`, `acquireOwner()` |
| **Depends on**             | `node:sqlite` (Node 22+ built-in), `node:fs`, `node:path`                                                                                                    |
| **Inputs**                 | Task/seat/session/message data; orchestration records via `saveRecord()`                                                                                     |
| **Outputs**                | Persisted state; event stream to all `subscribe()` listeners                                                                                                 |
| **Communication**          | All DB writers call `publish()` which notifies SSE handlers and `OrchestrationService` subscriptions                                                         |
| **Reusable independently** | Yes — generic SQLite event-store pattern. Portable to any Node 22+ project with minimal adaptation                                                           |

---

## Subsystem 4: TaskRuntime

| Property                   | Detail                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/task-runtime.mjs`                                                                                                                                                                                                   |
| **Responsibility**         | Task submission, gateway event routing, seat ownership, session management, state reconciliation, legacy import                                                                                                                 |
| **Key class**              | `TaskRuntime`                                                                                                                                                                                                                   |
| **Key methods**            | `submit()`, `cancel()`, `refresh()`, `receive()`, `markUnknown()`, `snapshot()`, `saveSeat()`, `seatOwner()`, `sessionOwner()`, `taskOwner()`, `bootstrapSeats()`, `importLegacy()`, `history()`, `newSession()`, `applyRole()` |
| **Depends on**             | `TaskDatabase`, `ServerGateway`/`NightshiftGateway`, `ReviewService`, `ManagementService`, `VoiceService`, `HmemMemory`                                                                                                         |
| **Inputs**                 | HTTP requests via `createRuntimeHandler`; gateway events via `gateway.subscribe()`                                                                                                                                              |
| **Outputs**                | Task status changes; seat updates; session records; chat messages                                                                                                                                                               |
| **Communication**          | Writes to `TaskDatabase` (which triggers SSE); reads from gateway; delegates to sub-services                                                                                                                                    |
| **Reusable independently** | Yes with significant adaptation — core task lifecycle logic is solid and independent of UI                                                                                                                                      |

---

## Subsystem 5: ServerGateway (OpenClaw)

| Property                   | Detail                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/gateway-connection.mjs`                                                                                       |
| **Responsibility**         | Server-owned WebSocket connection to OpenClaw; connect.challenge handshake; request/response multiplexing; event dispatch |
| **Key class**              | `ServerGateway`                                                                                                           |
| **Key methods**            | `start()`, `stop()`, `send()`, `capabilities()`, `subscribe()`                                                            |
| **Depends on**             | `ws` package                                                                                                              |
| **Inputs**                 | `GATEWAY_URL`, `GATEWAY_TOKEN`, audit contracts                                                                           |
| **Outputs**                | Gateway events forwarded to `TaskRuntime.receive()`                                                                       |
| **Reusable independently** | Yes — clean adapter pattern; replace `ws` with native WebSocket for browser environments                                  |

---

## Subsystem 6: NightshiftGateway

| Property                   | Detail                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Files**                  | `lib/server/nightshift-gateway.mjs`                                                                                                  |
| **Responsibility**         | Adapts Meterless Nightshift's OpenAI-compatible HTTP completions API to KiranaCrew's durable task model; enforces `REASONING_LIMITS` |
| **Key class**              | `NightshiftGateway`                                                                                                                  |
| **Key methods**            | Same interface as `ServerGateway`: `start()`, `stop()`, `send()`, `capabilities()`                                                   |
| **Depends on**             | `fetch` (Node built-in), `nightshift-contracts.mjs`                                                                                  |
| **Inputs**                 | `NIGHTSHIFT_BASE_URL`, `NIGHTSHIFT_API_KEY`, `NIGHTSHIFT_MODEL`                                                                      |
| **Outputs**                | Synthesized gateway events to `TaskRuntime`                                                                                          |
| **Reusable independently** | Yes — any OpenAI-compatible endpoint can be adapted here                                                                             |

---

## Subsystem 7: Auggie Bridge

| Property                   | Detail                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/auggie-bridge.ts`, `lib/auggie-bridge.mjs`                                                                           |
| **Responsibility**         | Implements the OpenClaw gateway WS protocol server-side; delegates task execution to spawned `auggie` CLI child processes |
| **Key function**           | `attachAuggieBridge(server, WebSocket?, WebSocketServer?)`                                                                |
| **Key exports**            | `dispatchToWorker()`, `validateDispatchSecret()`, `setWorkerRoster()`                                                     |
| **Depends on**             | `ws`, `child_process`, `lib/server-security.mjs`, `lib/server/auggie-contracts.mjs`                                       |
| **Inputs**                 | WS upgrades on `/api/gateway`; POST `/api/internal/dispatch`                                                              |
| **Outputs**                | Gateway frames to `TaskRuntime`; spawns child processes                                                                   |
| **Reusable independently** | Yes — pattern for bridging external CLI-based agents to the protocol                                                      |

---

## Subsystem 8: OrchestrationService

| Property                   | Detail                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Files**                  | `lib/server/orchestration.mjs`                                                                                                                                                                   |
| **Responsibility**         | Deterministic DAG scheduler: validates, persists, and reconciles multi-agent task plans; handles evidence gating, planner output gating, handoff injection, retry/repair logic, and verification |
| **Key class**              | `OrchestrationService`                                                                                                                                                                           |
| **Key methods**            | `create()`, `reconcile()`, `steer()`, `stop()`, `revise()`, `attachEvidence()`, `confirmPlannerOutput()`, `confirmEvidenceSet()`, `confirmResultContext()`, `recordVerification()`, `team()`     |
| **Depends on**             | `TaskDatabase`, `TaskRuntime`, `SpecialistRegistry`/`ExecutionRouter`, evidence repository, `operations-contracts.mjs`, `deliverable-validation.mjs`, `untrusted-content.mjs`                    |
| **Inputs**                 | Validated orchestration plans from `TeamLead` or `TaskComposer`; task status changes via DB subscription                                                                                         |
| **Outputs**                | Dispatched tasks via `registry.dispatchOrchestration()`; persisted plan updates; status events                                                                                                   |
| **Reusable independently** | Yes — the DAG scheduler is the strongest reusable component. Requires SpecialistRegistry and TaskDatabase                                                                                        |

---

## Subsystem 9: TeamLead

| Property                   | Detail                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/team-lead.mjs`                                                                                                                                 |
| **Responsibility**         | Goal decomposition, work assignment, synthesis, review, revision, failure transfer; tick-based advancement loop                                            |
| **Key class**              | `TeamLead`                                                                                                                                                 |
| **Key functions**          | `validateDecomposition(proposal)` (exported), `TeamLead.start()`, `.advance()`, `.assign()`, `.revise()`, `.transfer()`, `.finish()`, `.tick()`, `.view()` |
| **Depends on**             | `OrchestrationService` (via `OfficeOperations`), `SpecialistRegistry`, `stage-requirements.mjs`, `office-lead.mjs`, `untrusted-content.mjs`                |
| **Inputs**                 | `POST /api/runtime/team` with goal; 1500 ms timer                                                                                                          |
| **Outputs**                | `team.run` records in DB; orchestration plans dispatched via `OfficeOperations.create()`                                                                   |
| **Communication**          | Subscribes to `OfficeGroupChat` via `onEvent` callback for group turn posting                                                                              |
| **Reusable independently** | Yes with adaptation — core algorithm is clean; remove `OfficeGroupChat` coupling and it becomes a pure orchestration coordinator                           |

---

## Subsystem 10: OfficeOperations

| Property                   | Detail                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/office-operations.mjs`                                                                                                                                                       |
| **Responsibility**         | Service composition: wires `SpecialistRegistry`, `OrchestrationService`, `DataEvidenceService`, `TrustedVerificationService`, `ExecutionRouter` into a single facade                     |
| **Key class**              | `OfficeOperations`                                                                                                                                                                       |
| **Key methods**            | `create()`, `reconcile()`, `revise()`, `readEvidence()`, `recordVerification()`, `recover()`, `requestSpecialist()`, `createWithSpecialists()`                                           |
| **Depends on**             | `OperationRecords`, `SpecialistJournal`, `SpecialistRegistry`, `OrchestrationService`, `DataEvidenceService`, `TrustedVerificationService`, `ExecutionRouter`, `InventoryReasoningState` |
| **Reusable independently** | Yes — clean DI facade                                                                                                                                                                    |

---

## Subsystem 11: SpecialistRegistry

| Property                   | Detail                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/specialist-registry.mjs`, `lib/server/specialist-catalogue.mjs`, `lib/server/specialist-journal.mjs`, `lib/server/specialist-skills.mjs`      |
| **Responsibility**         | Maps orchestration role requests to verified seat+agent bindings; dispatch idempotency; session refresh; auto-provisioning (limited)                      |
| **Key class**              | `SpecialistRegistry`                                                                                                                                      |
| **Key methods**            | `assign()`, `selectTask()`, `dispatchOrchestration()`, `recover()`, `refreshSessions()`, `provision()`                                                    |
| **Catalogue**              | Static array in `specialist-catalogue.mjs`: planner, data-steward-researcher, executor, critic, maintenance-specialist, nightshift-planner/analyst/critic |
| **Depends on**             | `TaskRuntime`, `SpecialistJournal` (DB-backed idempotency), `specialist-catalogue.mjs`                                                                    |
| **Reusable independently** | Yes — the catalogue + registry pattern is reusable for any domain                                                                                         |

---

## Subsystem 12: TaskComposer (Verified Work Pipeline)

| Property                   | Detail                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/task-composer.mjs`, `lib/server/task-intent.mjs`, `lib/server/task-lifecycle.mjs`                                                              |
| **Responsibility**         | Multi-stage verified pipeline for data queries: classify → plan → collect evidence → analyze → review → verify; writes to H-MEM on success                 |
| **Key class**              | `TaskComposer`                                                                                                                                             |
| **Key methods**            | `create()`, `action()`, `all()`, `get()`, `readiness()`                                                                                                    |
| **Key function**           | `dataIntent(message, {inventory})` — intent detection heuristic                                                                                            |
| **Depends on**             | `OfficeOperations`, `DecisionMemory`, `composer-data.mjs`, `deliverable-validation.mjs`, `task-intent.mjs`, `approved-data.mjs`                            |
| **Reusable independently** | Yes with adaptation — the multi-stage pipeline pattern is the key reusable idea; domain queries (`dataIntent`) are inventory-specific and must be replaced |

---

## Subsystem 13: HmemMemory

| Property                   | Detail                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/hmem-memory.mjs`, `lib/server/decision-memory.mjs`, `lib/server/embeddings.mjs`, `lib/vendor/hmem-reference/`                                     |
| **Responsibility**         | Verified memory write (requires passing Critic verification + evidence chain); scoped retrieval (lexical + optional semantic); ledger of all writes and reads |
| **Key class**              | `HmemMemory`                                                                                                                                                  |
| **Key methods**            | `writeVerified()`, `retrieve()`, `retrieveSemantic()`, `embedMemory()`, `ledger()`, `loadProof()`                                                             |
| **Depends on**             | `TaskDatabase`, `OperationRecords`, `embeddings.mjs`, `operations-contracts.mjs`                                                                              |
| **Inputs**                 | Completed task records + verificationResult + evidenceItems                                                                                                   |
| **Outputs**                | `hmem_memories` rows; retrieval results with score and provenance                                                                                             |
| **Reusable independently** | Yes — the verified memory pattern is directly portable. The `HmemMemory` class can be used independently with any SQLite-backed DB                            |

---

## Subsystem 14: EmergencyStop

| Property                   | Detail                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Files**                  | `lib/server/estop.mjs`                                                                                       |
| **Responsibility**         | File-based sentinel that pauses new task dispatch; in-flight tasks continue; any filesystem error fails safe |
| **Key class**              | `EmergencyStop`                                                                                              |
| **Key methods**            | `engaged()`, `engage(reason)`, `release()`, `assertClear()`, `status()`                                      |
| **Reusable independently** | Yes — portable filesystem-based circuit breaker                                                              |

---

## Subsystem 15: Security Layer

| Property                   | Detail                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Files**                  | `lib/server-security.mjs`, `lib/server/untrusted-content.mjs`                                                                                                                        |
| **Responsibility**         | Origin enforcement, loopback binding, gateway URL validation, WebSocket origin checks, prompt injection fencing                                                                      |
| **Key functions**          | `isAllowedAppOrigin()`, `resolveBindHost()`, `validateGatewayTarget()`, `isAllowedWebSocketOrigin()`, `safeSecretEqual()`, `fenceUntrusted(source, content)`, `isThirdParty(source)` |
| **Reusable independently** | Yes — `server-security.mjs` is generic; `untrusted-content.mjs`'s fencing pattern is directly applicable to any LLM orchestrator                                                     |

---

## Subsystem 16: VoiceService + GeminiVoiceClient

| Property                   | Detail                                                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/voice.mjs`, `lib/voice/client.ts`, `lib/voice/VoiceProvider.tsx`, `lib/voice/agent-context.ts`, `lib/voice/agent-actions.ts`, `lib/voice/audio.ts`, `lib/voice/config.ts`, `lib/voice/conversation.ts`, `lib/voice/diagnostics.mjs`, `app/api/voice/session/route.ts` |
| **Responsibility**         | End-to-end voice call: microphone capture → PCM16 encoding → Gemini Live session → audio playback → transcript persistence → tool execution; server-side session provisioning + diagnostic tracking                                                                               |
| **Key class**              | `GeminiVoiceClient`                                                                                                                                                                                                                                                               |
| **Key methods**            | `start(agent?)`, `close()`, `action()`, `saveTranscript()`, `updateContext()`, `queueTaskAnnouncement()`, `setMuted()`                                                                                                                                                            |
| **Server service**         | `VoiceService`: `retrieveContext()`, `action()`, `createCall()`, `finalize()`, `recordFailure()`, `snapshot()`                                                                                                                                                                    |
| **Depends on**             | `@google/genai`, Web Audio API, `AudioWorkletNode`, `public/audio/voice-capture.js`, `lib/server/context-retrieval.mjs`                                                                                                                                                           |
| **Reusable independently** | `GeminiVoiceClient` is reusable for Gemini Live integration. Replacing the LLM provider requires a new client implementation                                                                                                                                                      |

---

## Subsystem 17: StudioProvider (Browser State)

| Property                   | Detail                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/store.ts`, `lib/reducer.ts`, `lib/persistence.ts`, `lib/events.ts`, `lib/identity.ts`, `lib/constants.ts`                            |
| **Responsibility**         | Single React context for all app state; SSE subscription; localStorage persistence; gameEvent bridge; task/session/seat management        |
| **Key exports**            | `StudioProvider`, `useStudio()`, `runtimeRequest()` (generic fetch helper)                                                                |
| **Key reducer actions**    | `SET_CONNECTION`, `ADD_TASK`, `UPDATE_TASK`, `APPEND_CHAT`, `ASSIGN_SEAT`, `SET_SEAT_STATUS`, `NEW_SESSION`, `HYDRATE_SESSION_CHAT`, etc. |
| **Persistence**            | `loadTasks/Chat/Sessions/SeatConfigs()` + `save*()` in `lib/persistence.ts` (localStorage); max 200 tasks, last 400 messages, 20 sessions |
| **Event bridge**           | `gameEvents` (singleton `GameEventBus` from `lib/events.ts`); typed with `GameEventMap`                                                   |
| **Reusable independently** | Pattern is reusable; the SSE+REST combination for browser state is clean                                                                  |

---

## Subsystem 18: Phaser Game + Three.js Overlay

| Property                   | Detail                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Files**                  | `components/game/PhaserGame.tsx`, `components/game/scenes/OfficeScene.*`, `components/game/three/OfficeRenderer.*`, `components/game/systems/AmbientRoutine.*`, `components/game/entities/`, `components/game/config/`, `components/game/utils/` |
| **Responsibility**         | Visual representation of agents in a pixel-art office; agent walking animation; speech bubbles; Phaser↔Three.js dual rendering; seat discovery                                                                                                   |
| **Key classes**            | `PhaserGame` (React component), `OfficeScene` (Phaser.Scene), `OfficeRenderer` (Three.js renderer)                                                                                                                                               |
| **Emits**                  | `seats-discovered` on map load; `office-inspect` on player interaction                                                                                                                                                                           |
| **Listens**                | `seat-configs-updated`, `task-assigned`, `task-completed`, `task-failed`, `task-aborted`, `task-bubble`, `office-settings`, `office-runtime`, `office-focus`                                                                                     |
| **Reusable independently** | No — tightly coupled to KiranaCrew's domain concepts and event bus                                                                                                                                                                               |

---

## Subsystem 19: HUD Components

| Property                   | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `components/hud/GameHud.tsx`, `components/hud/ChatPanel.tsx`, `components/hud/TaskPanel.tsx`, `components/hud/OperationsPanel.tsx`, `components/hud/TeamBoard.tsx`, `components/hud/WorkReport.tsx`, `components/hud/PendingReviews.tsx`, `components/hud/TaskComposer.tsx`, `components/hud/WorkerPanel.tsx`, `components/hud/InventoryInvestigationPanel.tsx`, `components/hud/VoiceDiagnostics.tsx`, `components/hud/TopBar.tsx`, `components/hud/BottomBar.tsx`, `components/hud/SessionSwitcher.tsx` |
| **Responsibility**         | All floating UI overlays: chat, task management, team board, work reports, reviews, voice diagnostics, seat management, inventory investigations                                                                                                                                                                                                                                                                                                                                                          |
| **Depends on**             | `useStudio()`, `useVoice()`, `gameEvents`, `runtimeRequest()`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Reusable independently** | Some panels (WorkReport, TeamBoard, OperationsPanel) are reusable UI patterns; the specific domain content is KiranaCrew-specific                                                                                                                                                                                                                                                                                                                                                                         |

---

## Subsystem 20: Chat + Conversation

| Property                   | Detail                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `components/chat/ChatCenter.tsx`, `components/chat/MessageStream.tsx`, `components/chat/VoiceSection.tsx`, `components/chat/TaskInspector.tsx`, `lib/conversations.ts` |
| **Responsibility**         | Multi-session chat display with streaming messages, voice UI integration, task linking, and conversation navigation                                                    |
| **Reusable independently** | Pattern is reusable; the specific streaming delta display logic (`APPEND_DELTA`, `FINALIZE_ASSISTANT`) is a clean pattern for any LLM chat UI                          |

---

## Subsystem 21: Next.js App Router Pages

| Property           | Detail                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Files**          | `app/layout.tsx` (root), `app/app/page.tsx` (main office), `app/team/[id]/page.tsx` (team board deep link), `app/work/[id]/page.tsx` (work report deep link) |
| **Responsibility** | Next.js page routing; `StudioProvider` is mounted at the root layout                                                                                         |
| **API Routes**     | `app/api/voice/session/route.ts`, `app/api/config/`, `app/api/contracts/`, `app/api/agents/`                                                                 |

---

## Subsystem 22: MCP Server

| Property                   | Detail                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **File**                   | `lib/mcp/kiranacrew-mcp.mjs`                                                       |
| **Responsibility**         | Exposes KiranaCrew capabilities as an MCP server (for use by external agent tools) |
| **Reusable independently** | Yes — the MCP pattern is directly portable                                         |

---

## Subsystem 23: Test Infrastructure

| Property          | Detail                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**         | `lib/__tests__/` (90+ test files), `vitest.config.ts`                                                                                     |
| **Framework**     | Vitest + jsdom; `@testing-library/react` for component tests                                                                              |
| **Fixtures**      | `lib/__fixtures__/` — SQLite in-memory test databases and scenario data                                                                   |
| **Browser tests** | `scripts/check-phase2.mjs`, `scripts/check-ui.mjs` etc. use Puppeteer                                                                     |
| **Coverage**      | Good coverage of server runtime, orchestration, memory, voice, provider adapters; lighter coverage of Phaser scene internals and Three.js |

---

## Subsystem 24: Scripts

| File                                        | Purpose                                                      |
| ------------------------------------------- | ------------------------------------------------------------ |
| `scripts/prepare-package.mjs`               | Copies runtime files into `.next/standalone` for npm release |
| `scripts/audit-contracts.mjs`               | Validates operation contracts against installed OpenClaw     |
| `scripts/check-sponsor-config.mjs`          | Checks sponsor configuration readiness                       |
| `scripts/check-nightshift.mjs`              | Probes Nightshift connectivity                               |
| `scripts/check-nightshift-queue.mjs`        | Checks Nightshift task queue                                 |
| `scripts/check-voice.mjs`                   | Verifies voice configuration                                 |
| `scripts/check-phase2.mjs` / `check-ui.mjs` | Puppeteer browser automation tests                           |
| `scripts/hmem-conformance.mjs`              | Runs H-MEM conformance suite                                 |
| `scripts/build-hmem.mjs`                    | Builds vendored H-MEM reference engine                       |
| `scripts/supplier-demo.mjs`                 | Runs supplier reconciliation demo                            |
| `scripts/package-release.mjs`               | Validates release package                                    |

---

## Cross-Subsystem Communication Map

```
Browser
  StudioProvider ──SSE──────────────────────────► TaskDatabase.publish()
  StudioProvider ──REST─────────────────────────► createRuntimeHandler()
  PhaserGame ◄──────gameEvents──────────────────── StudioProvider
  VoiceProvider ◄───────────────────────────────── GeminiVoiceClient

Server
  createRuntimeHandler ──calls──► TaskRuntime
  TaskRuntime ──writes──► TaskDatabase ──publishes──► SSE listeners
  TaskRuntime ──sends──► ServerGateway ──WS──► OpenClaw
  TeamLead ──tick──► OfficeOperations.create()
  OrchestrationService ──subscribes──► TaskDatabase events
  OrchestrationService ──dispatches──► SpecialistRegistry.dispatchOrchestration()
  SpecialistRegistry ──submits──► TaskRuntime.seatOwner().submit()
  TaskComposer ──reads evidence──► DataEvidenceService
  TaskComposer ──writes memory──► HmemMemory.writeVerified()
  VoiceService ──reads context──► context-retrieval.mjs
  VoiceService ──creates call──► TaskDatabase.saveRecord("voiceCall")
```

---

## Subsystem 17: KiranaCrew Core Engine

| Property                   | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**                  | `lib/server/nammaops/index.mjs`, `lib/server/nammaops/workflows.mjs`, `lib/server/nammaops/workforce.mjs`, `lib/server/nammaops/erp-binding.mjs`, `lib/server/nammaops/calculations.mjs`, `lib/server/nammaops/forecast.mjs`, `lib/server/nammaops/voice-router.mjs`, `lib/server/nammaops/owner-approvals.mjs`, `lib/server/nammaops/group-business.mjs`, `lib/server/nammaops/api.mjs`, `lib/server/nammaops/openapi.mjs`, `lib/server/nammaops/openapi-examples.mjs` |
| **Responsibility**         | Five-agent kirana-store workforce; five deterministic workflows; ERPNext data access via governed MCP tools; PIN-gated owner approval for purchase orders; voice routing from Gemini Live tool calls; group-chat text routing                                                                                                                                                                                                                                           |
| **Key exports**            | `createKiranaCrew(runtime, env, overrides)` — factory; `Workflows` class; `VoiceRouter` class; `ErpBinding` class; `OwnerApprovals` class; `handleKiranaCrewApi()` — REST handler; `nammaopsRoute()` — path matcher                                                                                                                                                                                                                                                     |
| **Depends on**             | `lib/server/mcp-governance.mjs` (ToolGateway), `lib/server/mcp-servers.mjs`, `lib/server/developer-config.mjs`, `lib/server/agent-profiles.mjs`, `lib/server/task-db.mjs`                                                                                                                                                                                                                                                                                               |
| **Inputs**                 | `NAMMAOPS_BINDING` (path to binding.fixture.json or binding.hvgerp.json), `NAMMAOPS_OWNER_PIN`, `NAMMAOPS_REASONING` (off                                                                                                                                                                                                                                                                                                                                               | manager), `NAMMAOPS_VOICE_WAIT_MS` |
| **Outputs**                | REST API `/api/nammaops/*`; workflow records in `nammaops.workflow` namespace; task records in `nammaops.task`; approval records in `nammaops.owner-approval`                                                                                                                                                                                                                                                                                                           |
| **Reusable independently** | No — requires a full KiranaCrew runtime with MCP governance                                                                                                                                                                                                                                                                                                                                                                                                             |

### `index.mjs`

Entry point. `createKiranaCrew(runtime, env, overrides)` wires `ErpBinding`, `OwnerApprovals`, `Workflows`, and `VoiceRouter` together and returns them as a single object attached to `runtime.nammaops`.

### `workflows.mjs`

The workflow runner. Five actions: `stock_check`, `prepare_reorder`, `daily_report`, `demand_forecast`, `supplier_comparison`. Each action is a series of `step()` calls — each step is a child task record where every ERP read is an `ErpBinding.call()` through the governed gateway under that agent's identity. All calculations are deterministic functions from `calculations.mjs` and `forecast.mjs`. An optional Manager reasoning turn calls `agentTasks.submitText()` with key figures the model reply must reproduce exactly. `parseCommand(text, today)` converts natural language to a structured intent deterministically (no LLM).

### `workforce.mjs`

`setupWorkforce()` automates agent registration: registers the MCP server, runs discovery, reviews capabilities with correct risk levels, creates Phase B specializations, assigns agents to OpenClaw seats, grants business capabilities. Idempotent. `loadWorkforce()` reads `config/nammaops/workforce.json`. `currentWorkforce()` reads the persisted workforce record.

### `erp-binding.mjs`

`ErpBinding` translates business IDs (`erp.stock.balance`) to MCP capability IDs (`mcp.erp-fixture.get_stock_balance`) and calls the governed ToolGateway under the agent's identity. Translates gateway invocation outcomes to workflow-aware error types (blocked/uncertain/failed). Supports shapes: `fixture` and `hvgerp`.

### `calculations.mjs`

Pure functions: `resolveProducts()` (fuzzy name→item with category fallback and clarification), `stockByItem()`, `analyseStock()`, `rankSuppliers()` (by price/lead-time/reliability), `groupOrders()`, `aggregateSales()`, `orderSnapshot()` (fingerprint input). All deterministic; no model.

### `forecast.mjs`

Historical-demand forecasting engine. `forecastItem()` runs stockout censoring, daily demand series construction, four-method competition (MA7, MA30, weighted EMA, weekday-pattern), WAPE-based backtesting, and reorder quantity calculation with safety stock. `addDays()` uses UTC to avoid DST shifts. Min 14 observed days required; returns `insufficient_evidence` otherwise.

### `voice-router.mjs`

`VoiceRouter.query()` handles the `nammaops_business_query` tool call from a Gemini Live session. Validates caller is a configured voice department, deduplicates retries via SHA-256 hash of call_id+action_id, maps eight voice intents to workflow actions, starts and waits for the workflow, returns a voice contract with `facts`, `recommendations`, `limitations`, `speak_rule`. `SHAPERS` object formats each workflow result kind for speech. Voice cannot approve or submit purchase orders.

### `owner-approvals.mjs`

`OwnerApprovals` manages PIN-gated purchase-order submission. `request()` fingerprints the exact draft PO. `approve()` re-reads PO from ERP, verifies fingerprint, claims the record with optimistic concurrency, submits, confirms. TTL 30 minutes. `reconcile()` handles uncertain/failed submissions by re-reading ERP state.

### `group-business.mjs`

`businessIntent(message, {today, seats})` parses office group-chat text (e.g. "@Bob check the stock of milk") into a voice-router-compatible args object, handling addressed agents and intent disambiguation. `formatBusinessReply()` formats the voice contract for chat display.

### `api.mjs`

`handleKiranaCrewApi(runtime, req, {rest})` implements all 14 REST endpoints under `/api/nammaops/`. Loopback only. Reads JSON bodies, routes by method+path regex. Calls `nammaops.workflows`, `nammaops.approvals`, `nammaops.binding`.

---

## Subsystem 18: MCP Layer

| Property           | Detail                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `lib/mcp/fixture-erpnext-server.mjs`, `lib/mcp/fixture-stock-server.mjs`, `lib/mcp/governed-tools-mcp.mjs`, `lib/mcp/hvgerp-adapter-server.mjs` |
| **Responsibility** | ERPNext-shaped MCP servers for fixture and live data; governed proxy for OpenClaw agents                                                        |

### `fixture-erpnext-server.mjs`

A fully functional ERPNext-shaped MCP server with 19 tools. Business data read from `config/nammaops/fixture-data.json` on every call. Purchase orders persist to a temp state file. Demand history generated deterministically from `demand_history` spec (profiles with base demand, weekend uplift, promotions, stockout windows, launched dates). `generateHistory()` produces 90 days of POS invoices and stock ledger entries. Used for all development and CI testing.

### `governed-tools-mcp.mjs`

`createGovernedProxy({baseUrl, agentId, secret})` is the MCP server an OpenClaw seat registers. It lists tools from the KiranaCrew gateway (`/api/runtime/mcp-gateway/tools?agent_id=…`) and routes every call through the gateway (`/api/runtime/mcp-gateway/invoke`). The agent identity comes from the process environment (`AGENT_TOWN_AGENT_ID`), never from tool arguments. Each tool name is derived from `capability_id` (dots/colons → underscores, truncated to 64 chars).

### `hvgerp-adapter-server.mjs`

`createAdapter({client})` wraps `@hvgllc/hvgerp-mcp@3.7.0`. Exposes 16 business read tools with the same names and shapes as the fixture server. Safety enforced in code: only 17 named hvgerp tools are ever called (allowlist `HVGERP_READS`), `erpnext_doc_get` is limited to `Supplier Quotation` and `POS Invoice`, `erpnext_doc_list` to `Stock Ledger Entry`, `POS Invoice`, `Item Price`. Verifies `readOnlyHint:true` at startup for every allowed tool. Handles partial-list bisection, concurrent fetching, 60s caching of catalogue data, and immutable caching of submitted document details. `connectHvgerp(env)` starts the hvgerp child process with credentials in the child environment only. `createAdapterServer(adapter)` wraps it as an MCP server.

---

## Subsystem 19: KiranaCrew Configuration

| Property           | Detail                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `config/nammaops/workforce.json`, `config/nammaops/fixture-data.json`, `config/nammaops/binding.fixture.json`, `config/nammaops/binding.hvgerp.json`, `config/nammaops/hvgerp-tools.discovered.json` |
| **Responsibility** | Declarative configuration for agents, ERP data, and tool bindings                                                                                                                                    |

### `workforce.json`

Defines the five agents (agent_id, role, name, specialization, responsibilities, business_capabilities, allowed/forbidden actions), four voice department seats (Alice/Bob/Carol/Dave), one workflow principal (nammaops-po-submit). Every agent is separately configured here — no hardcoded agent details in any .mjs file.

### `fixture-data.json`

7 kirana items (Toned Milk, Rice, Sunflower Oil, Coconut Oil, Toor Dal, Sugar, Ghee) with reorder levels, aliases, warehouses, stock bins, suppliers (3), supplier quotations, item prices, sales invoices, P&L records, and a `demand_history` spec. The spec drives `generateHistory()` to produce 90 days of deterministic POS invoices and stock ledger entries, including a toor-dal stockout window and a ghee launch date.

### `binding.fixture.json`

Maps 21 business capability IDs to fixture MCP tool names, risk levels, and approval flags. Shape: `fixture`. Default binding.

### `binding.hvgerp.json`

Maps same 21 capability IDs to hvgerp-adapter tool names. Shape: `hvgerp`. Four capabilities explicitly disabled (`erp.po.create_draft`, `erp.po.get`, `erp.po.submit`, `erp.payments.summary`) with documented reasons. Select with `NAMMAOPS_BINDING=config/nammaops/binding.hvgerp.json`.

### `hvgerp-tools.discovered.json`

Discovery output from Phase G1: 47 tools in 4 categories (sales, inventory, purchasing, accounting), with readOnlyHint annotations. Not used at runtime — reference document.

---

## Subsystem 20: KiranaCrew UI Panels

| Property           | Detail                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `components/hud/KiranaCrewPanel.tsx`, `components/hud/McpGovernancePanel.tsx`, `components/hud/DeveloperModeModal.tsx` |
| **Responsibility** | Business operations panel, MCP governance panel, developer configuration modal                                         |

### `KiranaCrewPanel.tsx`

HUD flyout. Shows workforce table, owner command input (4 preset examples + free-text), workflow results (inventory table, purchase approval with PIN entry, demand intelligence table with evidence drill-down, daily business summary), and live timeline. Subscribes to SSE; re-polls `/api/nammaops/dashboard` on KiranaCrew or MCP invocation events with 250ms debounce. Shows data-source banner (fixture vs live ERPNext).

### `McpGovernancePanel.tsx`

Shows: MCP server registration form (stdio or HTTP), all discovered capabilities with schema viewer and risk review dropdown, assignments/grants editor by agent/specialization ID, per-operation approval queue with approve/deny buttons, last 20 invocation audit records. Uses `/api/developer/*` endpoints.

### `DeveloperModeModal.tsx`

Two-tab modal: "agent" tab for AI-proposed agent configuration (existing); "mcp" tab for McpGovernancePanel (new).

---

## Subsystem 21: New Scripts

| Script                                  | Purpose                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/nammaops-demo.mjs`             | Full Phase D demo: setup, stock check, reorder with owner reject/approve, daily report, audit. Runs without a live server — creates a runtime in-process. |
| `scripts/phase-a-demo.mjs`              | Phase A (agent REST API) demo                                                                                                                             |
| `scripts/phase-b-demo.mjs`              | Phase B (developer mode) demo                                                                                                                             |
| `scripts/phase-c-demo.mjs`              | Phase C (MCP governance) demo                                                                                                                             |
| `scripts/check-nammaops-live.mjs`       | Live ERPNext check: all five workflows against live data, verifies 0 writes                                                                               |
| `scripts/check-nammaops-voice-live.mjs` | Live ERPNext + voice router check                                                                                                                         |
