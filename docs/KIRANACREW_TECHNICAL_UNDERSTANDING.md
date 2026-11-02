# Agent Town — Complete Technical Understanding

> **Note (2026-11-02):** The public product brand for the kirana store workforce is now **KiranaCrew**. This document covers the full Agent Town technical architecture. For KiranaCrew hackathon documentation, see [../README.md](../README.md) and the docs in this directory.

> Reverse-engineered from source code at commit `083f7e7`. All claims cite actual file paths and function names. No fabricated features.

---

## 1. Executive Summary

Agent Town is a **pixel-art AI agent collaboration visualizer and orchestration runtime** built on Next.js 16 + Phaser 3 + Three.js. It is simultaneously:

1. A **visual frontend**: a pixel-art office rendered in Phaser (2D) with an optional cinematic Three.js 3D overlay, where animated sprite characters represent AI agents sitting at desks, walking around, and showing speech bubbles when working.
2. A **durable task runtime**: a Node.js server (SQLite-backed) that submits tasks to external AI agent backends, tracks their status, persists results, and reconciles state across server restarts.
3. A **multi-agent orchestration engine**: a Team Lead → Planner → Workers → Synthesizer → Critic pipeline that decomposes goals into parallel subtasks, dispatches them to reviewed specialist agents, and gatekeeps results before they are accepted.
4. A **voice conversation interface**: Gemini Live API integration that allows real-time voice calls with the active AI agent.

The system is designed as a **local control surface** — it binds to `127.0.0.1` by default and is intended to sit in front of external AI agent backends (OpenClaw, Auggie CLI, Meterless Nightshift).

---

## 2. Complete Project Architecture

```
Browser (React / Phaser / Three.js)
        │
        │  HTTP + SSE (EventSource /api/runtime/events)
        │  HTTP POST /api/runtime/tasks, /api/runtime/seats, etc.
        │  HTTP POST /api/voice/session (Next.js route)
        ▼
Node.js server (server.ts / server.prod.mjs)
    ├── Next.js request handler (all /app routes, assets)
    ├── /api/runtime/* → createRuntimeHandler (lib/server/runtime-api.mjs)
    ├── /api/agents/discover → runtime-api.mjs
    └── /api/voice/session → app/api/voice/session/route.ts (Next.js route handler)

TaskRuntime (lib/server/task-runtime.mjs)
    ├── TaskDatabase  (SQLite via node:sqlite)
    ├── ServerGateway | NightshiftGateway | (Auggie bridge WS)
    ├── OfficeOperations
    │     ├── SpecialistRegistry
    │     ├── OrchestrationService
    │     ├── DataEvidenceService (optional)
    │     └── TrustedVerificationService
    ├── TeamLead (tick-based loop, 1500 ms)
    ├── TaskComposer (verified work pipeline)
    ├── OfficeGroupChat
    ├── ReviewService
    ├── ManagementService
    ├── VoiceService
    └── HmemMemory (local SQLite H-MEM)

External backends
    ├── OpenClaw gateway (WebSocket, protocol v3–v4)
    ├── Meterless Nightshift (OpenAI-compatible HTTP)
    └── Auggie CLI (spawned child process via auggie-bridge)
```

**Key architectural principle**: the server owns the gateway connection; the browser never connects to the AI backend directly. All task state is durable in SQLite. Server-Sent Events push incremental deltas to the browser.

---

## 3. Frontend Architecture

### 3.1 React Component Hierarchy

```
app/app/page.tsx
└── WorkspaceView (components/hud/WorkspaceView.tsx)
    ├── PhaserGame (components/game/PhaserGame.tsx)  [dynamic, no SSR]
    │     ├── Phaser.Game (OfficeScene)
    │     └── OfficeRenderer (Three.js 3D overlay)
    ├── GameHud (components/hud/GameHud.tsx)
    │     ├── TopBar
    │     ├── ChatPanel / ChatCenter
    │     ├── TaskPanel / TaskComposer
    │     ├── OperationsPanel
    │     ├── TeamBoard
    │     ├── WorkReport
    │     ├── PendingReviews
    │     ├── InventoryInvestigationPanel
    │     └── VoiceDiagnostics
    ├── TerminalModal (agent chat terminal)
    └── WorkerSessionHistoryModal
```

### 3.2 State Management

There is no Redux or Zustand. State lives in two places:

- **`StudioProvider` / `StudioContext`** (`lib/store.ts`): a single React context holding the full `StudioSnapshot`. The provider uses `useState` + `useRef` + custom event subscriptions. It exposes `assignTask`, `updateSeatConfig`, `switchSession`, `newSessionForSeat`, `reconcile`, etc.
- **`VoiceProvider`** (`lib/voice/VoiceProvider.tsx`): a separate context for voice call state.

State updates arrive via:
1. Server-Sent Events (`EventSource /api/runtime/events`) — the main real-time channel.
2. REST responses from `/api/runtime/*` — for mutations.
3. `gameEvents` bus — for Phaser↔React communication.

### 3.3 Event Bus (`lib/events.ts`)

`GameEventBus` is a typed in-process pub/sub singleton (`gameEvents`). All events are listed in `GameEventMap`:

| Event | Payload | Direction |
|---|---|---|
| `seats-discovered` | `SeatDef[]` | Phaser → Store |
| `seat-configs-updated` | `SeatState[]` | Store → Phaser |
| `task-assigned` | taskId, message, seatId? | Store → Phaser |
| `task-routed` | taskId, seatId, actorName | Store → Phaser |
| `task-completed` / `task-failed` / `task-aborted` | runId | Store → Phaser |
| `task-bubble` | runId, text, ttl | Phaser internal |
| `subagent-assigned` | runId, parentRunId, label, seatId? | Store → Phaser |
| `open-terminal` | seatId? | HUD → Panel |
| `open-voice` | seatId | HUD → Voice |
| `open-review` | id? | HUD → Reviews |
| `stop-task` | runId, seatId | HUD → Store |
| `gateway-disconnected` | taskIds | Store → Phaser |
| `office-runtime` | connection, voiceSeatId, voiceStatus | Store → Phaser |
| `office-inspect` | seatId | Phaser → HUD |
| `office-focus` | seatId | HUD → Phaser/Three.js |

### 3.4 Phaser Game Engine (`components/game/`)

- **Entry**: `PhaserGame.tsx` — lazy-loads Phaser and Three.js, creates `Phaser.Game` with `OfficeScene`, then attaches `OfficeRenderer` (Three.js) once the first Phaser frame renders.
- **Scene**: `components/game/scenes/OfficeScene` — loads Tiled map data, spawns `WorkerEntity` sprites for each seat, handles pathfinding, and emits `seats-discovered` when the map is parsed.
- **Systems**: `AmbientRoutine` (idle animations, `intensity: "off"|"calm"|"lively"`), worker wandering (constants in `lib/constants.ts`).
- **Three.js overlay**: `components/game/three/OfficeRenderer` — renders a 3D cinematic view; reads frame data from the Phaser scene each tick via `scene.readOfficeFrame()`. Activated via `cinematic` toggle.
- **Config**: `components/game/config/animations.ts` contains `WORKER_SPRITES` — the list of default sprite assignments per seat index.

### 3.5 SSE Event Kinds (browser-received)

The `EventSource` at `/api/runtime/events` receives JSON events with `.kind` and `.data` fields:

| Kind | Data | Effect |
|---|---|---|
| `snapshot` | Full `RuntimeSnapshot` | Full state replacement |
| `connection` | `{connection, capabilities, ...}` | Connection status update |
| `task` | `TaskItem` | Upsert task in list |
| `session` | `SessionRecord` | Upsert session |
| `message` | `ChatMessage` | Upsert chat message |
| `seat` | `SeatState` | Upsert seat config |
| `review` | `ReviewRequest` | Upsert review request |
| `reviewRecovery` | `Record<string,string>` | Update recovery map |
| `management` | `ManagementSnapshot` | Update agent management |
| `managementOperation` | `ManagementOperation` | Upsert management op |
| `voiceCall` | Voice call record | Upsert voice call |
| `metrics` | `{sessionKey, metrics}` | Update token/session metrics |

---

## 4. Backend Architecture

### 4.1 Server Entry Points

**Development**: `server.ts` (transpiled live by `tsx`).  
**Production**: `server.prod.mjs` (reads `.next/required-server-files.json` for standalone build).

Both create an HTTP server, register the runtime handler for `/api/runtime/*` and `/api/agents/discover` before Next.js handles anything, then pass everything else to Next.js.

**Provider selection** (`AGENT_PROVIDER` env var):
- `openclaw` (default): WebSocket connection to an OpenClaw gateway (`GATEWAY_URL`).
- `auggie`: Auggie bridge — WebSocket server on `/api/gateway` that spawns `auggie` CLI processes.
- `nightshift`: HTTP adapter to Meterless Nightshift's OpenAI-compatible endpoint.

### 4.2 Runtime API Handler (`lib/server/runtime-api.mjs`)

`createRuntimeHandler(runtime)` handles all `/api/runtime/*` routes:

**GET endpoints:**
- `/api/runtime/state` — full `RuntimeSnapshot`
- `/api/runtime/events` — SSE stream
- `/api/runtime/tasks` — paginated task list
- `/api/runtime/tasks/:id` — task detail + events + messages
- `/api/runtime/history?sessionKey=` — session chat history
- `/api/runtime/seats` — (implied by POST handler)
- `/api/runtime/team` — TeamLead runs list
- `/api/runtime/team/:id` — team run with live member status
- `/api/runtime/composer` — TaskComposer tasks + readiness
- `/api/runtime/composer/:id` — composed task + lifecycle
- `/api/runtime/office-lead` — office lead identity + agent directory
- `/api/runtime/office-overview` — aggregate office health
- `/api/runtime/office-group` — group chat messages
- `/api/runtime/investigations` — investigation list
- `/api/runtime/investigations/:id` — investigation detail
- `/api/runtime/investigations/:id/evidence/:eid` — evidence detail
- `/api/runtime/reviews` — pending review requests
- `/api/runtime/management` — agent management snapshot
- `/api/runtime/models?agentId=&sessionKey=` — available models
- `/api/runtime/session-config?key=&agentId=` — session configuration
- `/api/runtime/voice/diagnostics` — voice call diagnostics
- `/api/runtime/estop` — emergency stop status
- `/api/runtime/services` — ServiceRegistry snapshot
- `/api/runtime/data/schema?dataset=` — approved data schema
- `/api/runtime/search?q=` — task search

**POST endpoints:**
- `/api/runtime/tasks` — submit seat task (or redirect to composer if data intent detected)
- `/api/runtime/tasks/:id/cancel` — cancel task
- `/api/runtime/seats` — upsert seat config
- `/api/runtime/seats/:id/role` — apply role to seat
- `/api/runtime/sessions` — create new session for seat
- `/api/runtime/team` — start team run
- `/api/runtime/team/:id/steer` — steer task in orchestration
- `/api/runtime/team/:id/stop` — stop task in orchestration
- `/api/runtime/composer` — create composed task
- `/api/runtime/composer/:id/confirm|correct|approve` — composer action
- `/api/runtime/reviews/:id/decide` — human review decision
- `/api/runtime/reviews/reconcile` — recover review state
- `/api/runtime/management` — management mutation (model switch, etc.)
- `/api/runtime/voice/actions` — voice tool action
- `/api/runtime/voice/context` — voice agent context retrieval
- `/api/runtime/voice/diagnostics` — record voice diagnostic
- `/api/runtime/voice/transcripts` — save voice transcript
- `/api/runtime/investigations` — start investigation
- `/api/runtime/investigations/:id/accept-plan|collect-evidence|confirm-evidence|accept-analyst|finish|revise` — investigation actions
- `/api/runtime/estop` — engage/release emergency stop
- `/api/runtime/connect` / `/api/runtime/disconnect` — gateway control
- `/api/runtime/reconcile` — force state reconciliation
- `/api/runtime/import` — import legacy browser tasks
- `/api/runtime/bootstrap` — bootstrap seat bindings
- `/api/runtime/office-group` — send group chat message

### 4.3 Security

Origin checks are applied in `lib/server-security.mjs` and enforced in `createRuntimeHandler`:
- All non-GET requests reject if `origin` is present but not same-host.
- `sec-fetch-site: cross-site` is rejected for all methods.
- Server binds only to loopback by default; remote binding throws an error.
- WebSocket upgrades only accepted from same-origin in `auggie-bridge.ts`.
- Gateway tokens never flow to the browser; the server holds all credentials.

---

## 5. Agent Orchestration Architecture

### 5.1 The Specialist Catalogue (`lib/server/specialist-catalogue.mjs`)

Reviewed agent roles (static, code-defined, not user-configurable at runtime):

| Role | Capabilities | Tools | Write Permission |
|---|---|---|---|
| `planner` | decompose_task, plan_dependencies | agent.message, sessions.list | denied |
| `data-steward-researcher` | read_operational_records, research_external_sources | zetaris.read, tavily.search/extract, web_search/fetch, browser | denied |
| `executor` | execute_approved_action, report_execution | approval.gateway, agent.message | approval_required |
| `critic` | challenge_hypothesis, verify_evidence | evidence.read, sessions.history | denied |
| `maintenance-specialist` | review_maintenance_history | (none) | denied |
| `nightshift-planner` | decompose_task (Nightshift) | (none — HTTP only) | denied |
| `nightshift-analyst` | analyze_evidence | (none) | denied |
| `nightshift-critic` | challenge_hypothesis | (none) | denied |

### 5.2 OrchestrationService (`lib/server/orchestration.mjs`)

The core multi-agent scheduler. Key methods:

- **`create(input)`**: Validates a Planner-proposed task DAG (1–12 tasks, max 3 parallel, topological sort, cycle detection, deliverable schema validation). Assigns each task to a verified seat binding. Persists to `runtime_records(namespace="orchestration")`.
- **`reconcile(incidentId)`**: Called on every task status change via DB subscription. Advances the DAG: dispatches `ready` tasks (up to `maxParallelTasks`), marks `waiting`/`blocked`/`unresolved`/`completed` phases, handles schema repair redispatch (one bounded retry), repetition detection (cosine similarity check), and handoff injection. Saves new orchestration state if anything changed.
- **`steer()`**: Queues Team Lead guidance text that gets appended to the next dispatch message.
- **`stop()`**: Marks a node as `stopRequested`; current attempt continues, no new dispatch.
- **`recordVerification()`**: Records a Critic `pass`/`revise` verdict after server-side proof validation.
- **`revise()`**: Creates a bounded revision plan when Critic verdict is `revise`.
- **`confirmPlannerOutput()`**: Gates downstream tasks until Planner result hash is server-validated.
- **`confirmEvidenceSet()`**: Gates analyst dispatch until evidence freshness is verified.

**Task node phases** (internal to orchestration):
`waiting` → `waiting_evidence` → `waiting_planner_validation` → `waiting_result_validation` → `ready` → `queued` → `running` → `completed` | `failed` | `unresolved` | `blocked` | `stopped`

**Plan statuses**: `planned` → `running` → `awaiting_verification` | `failed` | `unresolved`

### 5.3 TeamLead (`lib/server/team-lead.mjs`)

Runs a 1500 ms tick loop (`setInterval`). Each tick calls `advance(id)` for every non-terminal run.

**Run lifecycle** (status field on `team.run` record):
1. **`planning`**: Dispatches a single `planner`-role task via orchestration. Waits for result.
2. Validates the Planner's JSON decomposition (`validateDecomposition`): checks task count (1–5), IDs, titles, assignments, capability values, dependency DAG, similarity between assignments.
3. **`working`**: Calls `assign(run, tasks)` — creates a work orchestration plan: worker tasks + `synthesis` (planner role, aggregates handoffs) + `review` (critic role). Max 3 parallel. Handoffs flow from dependencies.
4. On `plan.children.every(completed)`:
   - Review verdict `ACCEPT` → `finish(run, "completed", ...)`.
   - Review verdict `REVISE` → `revise(run, answer, reasons)` (up to `MAX_REVISIONS=2`).
5. On `broken` (failed/blocked/stopped) child → `transfer(run, plan, broken)` (up to `MAX_TRANSFERS=2`): carries completed handoffs, re-routes unfinished tasks to different agents (preferring a different runtime for the failed task).
6. Stall detection: if no progress in `STALL_MS=15min`, mark `stalled`.

**Terminal statuses**: `completed`, `unresolved`, `stalled`

### 5.4 TaskComposer (`lib/server/task-composer.mjs`)

The "verified work pipeline" for data-bearing tasks. Activated when `dataIntent(message)` returns a non-null intent for inventory/supplier queries. Runs a full Planner → Evidence Collection → Analyst → Critic → Verification cycle. Uses `DecisionMemory` (H-MEM reference engine) to recall prior verified supplier findings.

### 5.5 SpecialistRegistry (`lib/server/specialist-registry.mjs`)

Maps role names to actual seat+agent bindings. `assign()` and `selectTask()` are synchronous (pre-validated before orchestration dispatch). `dispatchOrchestration()` actually submits the task to `TaskRuntime`. Maintains a `SpecialistJournal` (durable idempotency ledger) to prevent duplicate dispatches.

---

## 6. Provider Integration Architecture

| Provider | Status | Implementation |
|---|---|---|
| **OpenClaw** | **Fully implemented** | `lib/server/gateway-connection.mjs` (`ServerGateway`); WebSocket protocol v3–v4; connect.challenge handshake; token auth server-side; `lib/gateway.ts` is the *browser* client (used for direct connections, now superseded by server-owned model) |
| **Meterless Nightshift** | **Fully implemented** | `lib/server/nightshift-gateway.mjs` (`NightshiftGateway`); OpenAI-compatible HTTP; adapts completions to the durable task model; `nightshift-reasoning.mjs` reads correlated results for the Team Lead |
| **Auggie** | **Fully implemented** | `lib/auggie-bridge.ts` (`attachAuggieBridge`); spawns `auggie` CLI child processes; implements the full OpenClaw WS protocol server-side so `TaskRuntime` sees it as a normal gateway |
| **Gemini Live (voice)** | **Fully implemented** | `lib/voice/client.ts` (`GeminiVoiceClient`); `@google/genai` SDK; ephemeral token from `app/api/voice/session/route.ts`; 10-minute call limit; PCM16 audio worklet |
| **NVIDIA / Nemotron** | **Adapter-ready / planned only** | Environment variables exist (`NVIDIA_API_KEY`, `NVIDIA_MODEL`); no adapter code found |
| **SpaceXAI / Grok** | **Planned only** | Environment variables exist (`XAI_API_KEY`, `XAI_MODEL`); no adapter code found |
| **Zetaris (data source)** | **Fully implemented** | `lib/server/data-zetaris.mjs`; SQL cursor pagination; configurable timeouts; approval required via env |
| **Tavily (web search)** | **Fully implemented** | Listed in specialist catalogue tools; `TAVILY_API_KEY` or keyless mode |
| **OpenAI-compatible embeddings** | **Fully implemented** | `lib/server/embeddings.mjs`; optional; falls back to lexical if absent |

---

## 7. Memory Architecture

### 7.1 H-MEM (Hierarchical Memory) — `lib/server/hmem-memory.mjs`

A local SQLite-backed implementation of a verified memory subsystem. **Not a hosted API.**

**SQLite tables created by HmemMemory:**
- `hmem_memories(id, gateway, agent, session, seat, binding, created, data)`
- `hmem_ledger(seq, memory_id, action, at, data)`

**Write path** (`writeVerified`): Only writes memories from completed tasks with a passing verification result (`verdict: "pass"`). Validates the full chain: task → verificationResult → evidenceItems → seat binding. Computes `freshUntil` from the minimum evidence expiry.

**Read path** (`retrieve` / `retrieveSemantic`):
1. Scoped to exact `(gatewayId, agentId, sessionKey, seatId, bindingRevision)`.
2. Scores each memory: lexical overlap on applicability + content, recency decay, confidence weight.
3. If an embedder is configured and verified: cosine similarity on pre-computed vectors (same model only).
4. Minimum score threshold 0.35; semantic threshold 0.75.
5. At retrieval time, re-validates the proof chain (task still completed, verification not superseded, evidence still fresh).

**Decision Memory** (`lib/server/decision-memory.mjs`): Wraps the `HMEM` reference engine (`lib/vendor/hmem-reference`) for supplier decisions. Persists engine state as a single compressed record in `runtime_records`.

### 7.2 Embeddings (`lib/server/embeddings.mjs`)

Optional OpenAI-compatible embeddings endpoint. Configured via `AGENT_TOWN_EMBEDDINGS_URL`, `AGENT_TOWN_EMBEDDINGS_MODEL`, `AGENT_TOWN_EMBEDDINGS_KEY_ENV`. A `verify()` probe runs on startup; until it succeeds, recall stays lexical.

---

## 8. Database Schema

All tables are created in `lib/server/task-db.mjs` plus `lib/server/hmem-memory.mjs`. Uses Node.js built-in `node:sqlite` (SQLite synchronous API, Node 22+).

```sql
-- Core task tracking
tasks(id TEXT PK, gateway TEXT, session TEXT, status TEXT, created TEXT, data TEXT)
  INDEX task_lane ON (gateway, session, status, created)

-- Dispatch idempotency ledger
dispatches(task_id TEXT PK REFERENCES tasks, idempotency_key TEXT UNIQUE,
  state TEXT, run_id TEXT, request_id TEXT)

-- Chat messages (per session)
messages(id TEXT PK, session TEXT, data TEXT)

-- Session records
sessions(id TEXT PK, agent TEXT, data TEXT)

-- Seat configurations
seats(id TEXT PK, data TEXT)

-- Event log (for SSE replay and cursor)
events(seq INTEGER PK AUTOINCREMENT, kind TEXT, data TEXT)

-- Import deduplication
imports(id TEXT PK)

-- Single-process ownership lock
runtime_owner(id INTEGER PK CHECK(id=1), pid INTEGER)

-- General-purpose key-value store (orchestration plans, team runs, voice calls, etc.)
runtime_records(namespace TEXT, id TEXT, data TEXT, PRIMARY KEY(namespace,id))

-- Inbound message deduplication
inbound(id TEXT PK, data TEXT)

-- Schema migration tracking
migrations(version INTEGER PK)

-- H-MEM memory store (created by HmemMemory constructor)
hmem_memories(id TEXT PK, gateway TEXT, agent TEXT, session TEXT, seat TEXT,
  binding INTEGER, created INTEGER, data TEXT)
  INDEX hmem_scope ON (gateway, agent, session, seat, binding, created)

hmem_ledger(seq INTEGER PK AUTOINCREMENT, memory_id TEXT, action TEXT,
  at INTEGER, data TEXT)
```

**`runtime_records` namespaces** in use:
- `orchestration` — OrchestrationService plans
- `team.run` — TeamLead runs
- `voiceCall` — voice call records
- `evidenceItem` — DataEvidenceService items
- `incident` — incident records (synced from orchestration)
- `task` (operation records) — specialist task records
- `verificationResult` — Critic verification results
- `hmem.state` — H-MEM reference engine snapshot
- `decisionMemory` — supplier decision memory records
- `decisionMemoryLedger` — decision memory audit entries
- `office.specialistRequest` — specialist request records

---

## 9. API Inventory (Complete)

See section 4.2 for the full list of `/api/runtime/*` endpoints. Additional Next.js route handlers:

| Route | File | Method | Purpose |
|---|---|---|---|
| `/api/voice/session` | `app/api/voice/session/route.ts` | GET | Check voice config |
| `/api/voice/session` | `app/api/voice/session/route.ts` | POST | Provision Gemini ephemeral token |
| `/api/agents/discover` | served by `runtime-api.mjs` | GET | List available agents |
| `/api/internal/dispatch` | `lib/internal-api.mjs` | POST | Auggie: dispatch task to worker |
| `/api/internal/seat-sync` | `lib/internal-api.mjs` | POST | Auggie: sync seat roster |
| `/api/gateway` | Auggie bridge WebSocket | WS UPGRADE | Auggie: gateway protocol |
| `/api/config` | `app/api/config/` | GET/POST | (Exists, not fully inspected) |
| `/api/contracts` | `app/api/contracts/` | GET | (Exists, not fully inspected) |

---

## 10. WebSocket and SSE Event Architecture

### 10.1 SSE Stream (`/api/runtime/events`)

Published by `TaskDatabase.publish()`. Every `db.emit()` call creates a row in `events` table and fires all active SSE listeners. Cursor-based replay: reconnecting clients send `Last-Event-ID` header; if gap < 1000 events, deltas are replayed; otherwise a full snapshot is sent. Keepalive comments every 15 seconds.

### 10.2 Gateway WebSocket (OpenClaw protocol)

Protocol frames (JSON):
```json
{ "type": "req", "id": "aw_1_...", "method": "connect", "params": {...} }
{ "type": "res", "id": "aw_1_...", "ok": true, "payload": {"type":"hello-ok","scopes":[...]} }
{ "type": "event", "event": "connect.challenge", "payload": {} }
{ "type": "event", "event": "run.update", "payload": {...} }
```

Handshake sequence: server receives `connect.challenge` → sends `req{method:"connect"}` with client identity, protocol range (3–4), scopes `["operator.read","operator.write","operator.admin"]` → receives `res{ok:true,payload:{type:"hello-ok"}}`.

Reconnection: exponential backoff (1s base, 2x factor, 30s max, 3 max attempts, ±25% jitter).

### 10.3 Auggie Bridge WebSocket (`lib/auggie-bridge.ts`)

Implements the same protocol server-side to bridge Auggie CLI. Connected clients go through the same connect.challenge handshake. Task dispatches spawn `auggie` child processes with task info written to a temp JSON file.

---

## 11. Complete Task Execution Lifecycle

### 11A. Direct Seat Task (user → seat agent)

1. User types message in `ChatPanel`. `assignTask()` called in `lib/store.ts`.
2. `runtimeRequest("tasks", {...})` POSTs to `/api/runtime/tasks`.
3. `createRuntimeHandler` in `lib/server/runtime-api.mjs` checks `dataIntent(input.message)`. If data intent detected, redirects to `TaskComposer` (step 11B).
4. Otherwise: `runtime.seatOwner(input.seatId).submit(input)` → `TaskRuntime.submit()`.
5. `TaskDatabase.insertTask()` creates `tasks` row (status=`queued`), `dispatches` row (state=`pending`), user `messages` row. Publishes `task` and `message` events.
6. SSE pushes `task` event to browser; `task-assigned` gameEvent fires; Phaser walks character to desk.
7. `TaskRuntime.pump()` picks up queued tasks, calls `db.claim(taskId)` (transitions to `submitted`), sends `gateway.send("chat.send", {...})`.
8. Gateway backend processes the task; sends back `run.update` events with streaming deltas.
9. `TaskRuntime.receive(event)` handles gateway events: updates task status, saves messages to DB, publishes SSE events.
10. On `chat.response` with `status:"completed"`: `db.updateTask(id, {status:"completed", result:...})`.
11. SSE `task` event updates browser; `task-completed` gameEvent fires; Phaser plays completion animation.

### 11B. Team Lead Flow (complex goal)

1. `POST /api/runtime/team` with `{requestId, goal, context}`.
2. `TeamLead.start()` creates `team.run` record (status=`planning`), calls `stagePlan()`.
3. `stagePlan()` creates an orchestration plan with one `planner`-role task.
4. `OrchestrationService.reconcile()` dispatches the planner task to the assigned seat agent.
5. Planner completes → `TeamLead.advance()` reads result, calls `validateDecomposition()`.
6. If valid: `assign(run, tasks)` creates work orchestration: N worker tasks + synthesis + review.
7. `OrchestrationService.reconcile()` dispatches ready workers (up to `maxParallelTasks=3`).
8. Workers complete → handoffs (structured JSON summaries) are extracted and injected into the synthesis task message.
9. Synthesis completes → review task is dispatched with the synthesis handoff.
10. Critic review: verdict `ACCEPT` → `finish(run, "completed", ..., {answer})`. Verdict `REVISE` → `revise()` creates a new orchestration with synthesis+review (up to 2 revision rounds).
11. On failure/block: `transfer()` re-routes remaining tasks to different agents (up to 2 transfers).

### 11C. Verified Work Pipeline (TaskComposer)

1. `dataIntent(message)` in `lib/server/task-intent.mjs` detects inventory/supplier queries.
2. `TaskComposer.create()` creates a composer task record.
3. Stages: `classifying` → `needs_confirmation` → `planning` → `collecting` (evidence) → `analyzing` → `reviewing` → `completed`.
4. At each stage gate, server validates the previous stage's output hash before proceeding.
5. On completion: `HmemMemory.writeVerified()` stores the finding with full proof chain.

---

## 12. Voice Architecture

### 12.1 Session Provisioning

1. `GeminiVoiceClient.start()` in `lib/voice/client.ts` requests microphone, creates `AudioContext` at 16kHz.
2. `POST /api/voice/session` (Next.js route `app/api/voice/session/route.ts`):
   - Checks origin and `GEMINI_API_KEY`.
   - Rate-limits to 6 attempts/minute.
   - Calls `runtime.voice.retrieveContext(selection)` to get agent context.
   - Provisions a Gemini ephemeral token via `ai.authTokens.create()` (1 use, expires in `VOICE_SESSION_SECONDS`).
   - Calls `runtime.voice.createCall(selection)` — creates a `voiceCall` record in DB.
3. Browser receives `{token, model, config, maxSeconds, callId}`.

### 12.2 Live Call

1. Browser connects to Gemini Live via `ai.live.connect({model, config, callbacks})`.
2. Audio captured by `voice-capture` AudioWorklet (public/audio/voice-capture.js), encoded as PCM16, sent via `session.sendRealtimeInput()`.
3. Gemini handles VAD; sends back `voiceActivity`, `inputTranscription`, `outputTranscription`, audio `modelTurn.parts`.
4. Tool calls from Gemini arrive as `toolCall.functionCalls`. Supported tools: `assign_task`, `get_agent_context`, `get_task_progress`, `cancel_task`, `open_pending_review`.
5. Tool execution: `GeminiVoiceClient.action()` POSTs to `/api/runtime/voice/actions`.
6. Task announcements: completed tasks are announced via `sendClientContent` injections during quiet periods (`flushBackground`).
7. Session closed at 10 minutes (`VOICE_SESSION_SECONDS`).

### 12.3 Voice Service (`lib/server/voice.mjs`)

Server-side tracking of voice calls in `runtime_records(namespace="voiceCall")`. Manages context retrieval (`lib/server/context-retrieval.mjs`), transcript persistence, call lifecycle, and diagnostics.

---

## 13. Security Architecture

| Control | Implementation | File |
|---|---|---|
| Loopback-only binding | `resolveBindHost()` throws on non-loopback `HOST` | `lib/server-security.mjs` |
| Origin enforcement | `isAllowedAppOrigin()` on all non-GET runtime routes | `lib/server/runtime-api.mjs` |
| Cross-site fetch blocking | `sec-fetch-site: cross-site` check | `lib/server/runtime-api.mjs` |
| Gateway token isolation | Token never sent to browser; held server-side only | `server.ts`, `lib/server/gateway-connection.mjs` |
| Remote gateway TLS requirement | `validateGatewayTarget()` enforces `wss://` for non-loopback | `lib/server-security.mjs` |
| Emergency stop | Sentinel file (`ESTOP`); pauses new dispatch, never kills in-flight | `lib/server/estop.mjs` |
| Human approval gate | `executor` role requires `approval.gateway` tool; `ReviewService` | `lib/server/specialist-catalogue.mjs`, `lib/server/reviews.mjs` |
| Prompt injection fencing | `fenceUntrusted()` wraps all third-party and agent output before inclusion in new messages | `lib/server/untrusted-content.mjs` |
| Scope enforcement | `GatewayClient.hasScope()` checks granted scopes from hello-ok | `lib/gateway.ts` |
| DB ownership lock | `acquireOwner()` uses OS process-kill probe to ensure single writer | `lib/server/task-db.mjs` |
| Memory write guard | H-MEM writes require a validated proof chain; no model-facing write route | `lib/server/hmem-memory.mjs` |
| Specialist permission bounds | Catalogue defines `dataAccess` and `sensitiveWrites` per role | `lib/server/specialist-catalogue.mjs` |
| Tool scope validation | `OrchestrationService.verifyBinding()` re-checks seat binding before every dispatch | `lib/server/orchestration.mjs` |
| Timing-safe secret comparison | `safeSecretEqual()` for dispatch secret | `lib/server-security.mjs` |
| Voice CSRF protection | Origin + `sec-fetch-site` checked before token provisioning | `app/api/voice/session/route.ts` |

---

## 14. Testing Architecture

**Framework**: Vitest (`vitest.config.ts`). Test environment: Node + jsdom (for React component tests). Total test files: 90+.

**Test categories** (from `lib/__tests__/`):

- **Unit tests**: `reducer.test.ts`, `persistence.test.ts`, `gateway-client.test.ts`, `contracts.test.ts`, `utils.test.ts`
- **Server runtime**: `task-runtime.test.ts`, `task-db.mjs` (indirectly), `task-composer.test.ts`, `task-lifecycle.mjs`
- **Orchestration**: `orchestration.test.ts`, `team-lead.test.ts`, `coordination.test.mjs`
- **Specialist registry**: `specialist-registry.test.ts`, `routing-integration.test.ts`
- **Memory**: `hmem-memory.test.ts`, `data-memory-integration.test.ts`, `context-retrieval.test.ts`, `decision-memory` (implicit)
- **Voice**: `voice-client.test.ts`, `voice-agent.test.ts`, `voice-service.test.ts`, `voice-session.test.ts`, `voice-conversation.test.ts`, `voice-diagnostics.test.ts`, `voice-audio.test.ts`
- **Providers**: `nightshift.test.ts`, `nightshift-reasoning.test.ts`, `nightshift-registry.test.ts`
- **Inventory pipeline**: `inventory-investigation.test.ts`, `inventory-count-investigation.test.ts`, `inventory-reasoning-loop.test.ts`, `inventory-reasoning-v3.test.ts`, `inventory-zetaris-mapping.test.ts`
- **UI components**: `chat-center-ui.test.tsx`, `office-controls.test.tsx`, `team-board.test.tsx`, `task-composer-ui.test.tsx`, `work-report.test.tsx`, `voice-provider.test.tsx`, `terminal-workflow.test.tsx`
- **Security**: `server-security.test.ts`, `untrusted-content.test.mjs`
- **Integration**: `office-lifecycle.test.ts`, `office-group-integration.test.ts`, `production-runtime.test.ts`, `peer-runtime-routes.test.mjs`
- **Browser automation**: Puppeteer tests referenced in scripts (`check-phase2.mjs`, `check-ui.mjs`)

**What is NOT tested**: Three.js OfficeRenderer (no test), Phaser scene internals (office-engine tests exist but limited), actual network calls to external providers (mocked).

---

## 15. Deployment Architecture

**Development**: `pnpm dev` → `tsx watch server.ts`; Next.js dev server + hot reload; server-side gateway connection.

**Production (npm package)**: `npx agent-town` → `bin/agent-town.mjs` → `server.prod.mjs`; requires `next build` + `node scripts/prepare-package.mjs` to create standalone bundle.

**Build outputs**: `.next/standalone/` (Next.js standalone), `bin/` (CLI entry).

**Database**: SQLite file at `AGENT_TOWN_DB_PATH` (default: `~/.agent-town/tasks.sqlite`). Single-process lock enforced.

**Process requirements**: Node.js >= 22.19.0 (for `node:sqlite` built-in).

---

## 16. Environment Variables

From `.env.example` (no actual values):

| Variable | Purpose |
|---|---|
| `PORT` | HTTP listen port (default 3000) |
| `HOST` | Bind host (default 127.0.0.1, must be loopback) |
| `AGENT_TOWN_DB_PATH` | SQLite database path |
| `AGENT_PROVIDER` | `openclaw` \| `nightshift` \| `auggie` |
| `AGENT_TOWN_SHARED_AGENT` | Shared agent ID for seat-less sessions |
| `AGENT_TOWN_OFFICE_LEAD_SEAT` | Seat ID for Alice/office lead (default seat-0) |
| `AGENT_TOWN_ESTOP_FILE` | Emergency stop sentinel file path |
| `AGENT_TOWN_PUBLIC_ORIGINS` | Comma-separated HTTPS origins (requires TLS proxy) |
| `GATEWAY_URL` | OpenClaw gateway WebSocket URL |
| `GATEWAY_TOKEN` | OpenClaw auth token (server-side only) |
| `ALLOW_REMOTE_GATEWAY` | Must be `true` to use non-loopback `GATEWAY_URL` |
| `NIGHTSHIFT_BASE_URL` | Meterless Nightshift HTTP base URL |
| `NIGHTSHIFT_API_KEY` | Nightshift auth key |
| `NIGHTSHIFT_MODEL` | Model identifier (default `meterless/auto`) |
| `NVIDIA_API_KEY` | NVIDIA/Nemotron hosted inference key (no adapter yet) |
| `NVIDIA_BASE_URL` | NVIDIA API base URL |
| `NVIDIA_MODEL` | NVIDIA model identifier |
| `XAI_API_KEY` | SpaceXAI/Grok key (no adapter yet) |
| `XAI_BASE_URL` | SpaceXAI API base URL |
| `XAI_MODEL` | Grok model identifier |
| `AGENT_TOWN_SPECIALIST_GRANTS` | JSON array of specialist binding grants |
| `AGENT_TOWN_SPECIALIST_PROFILES` | JSON object of specialist seat profiles |
| `AGENT_TOWN_EXECUTION_OPTIONS` | JSON array of secondary gateway configs |
| `AGENT_TOWN_EXECUTION_PREFERENCE` | JSON array for execution routing preference |
| `AGENT_TOWN_INVENTORY_MODE` | `synthetic` \| `zetaris` |
| `AGENT_TOWN_INVENTORY_SYNTHETIC_CASE` | Synthetic fixture case name |
| `ZETARIS_OPEN_URL` / `ZETARIS_PAGE_URL` / `ZETARIS_CLOSE_URL` | Zetaris SQL API endpoints |
| `ZETARIS_BEARER_TOKEN` / `ZETARIS_ORG_ID` | Zetaris auth |
| `TAVILY_API_KEY` | Tavily web search key |
| `GEMINI_API_KEY` | Google Gemini Live API key |
| `AGENT_TOWN_EMBEDDINGS_URL` / `AGENT_TOWN_EMBEDDINGS_MODEL` / `AGENT_TOWN_EMBEDDINGS_KEY_ENV` | Optional embeddings endpoint |

---

## 17. Important Dependencies

| Package | Version | Purpose |
|---|---|---|
| `next` | 16.4.3 | React framework, SSR, routing |
| `react` / `react-dom` | 19.2.3 | UI framework |
| `phaser` | ^3.90.0 | 2D game engine for office visualization |
| `three` | ^0.186.1 | 3D cinematic rendering overlay |
| `@google/genai` | ^2.31.0 | Gemini Live voice API |
| `ws` | ^8.22.0 | WebSocket server (Auggie bridge, production server) |
| `ajv` | 8.20.0 | JSON schema validation (operation contracts) |
| `tailwindcss` | ^4.3.3 | CSS utility framework |
| `tsx` | ^4.23.15 | TypeScript execution for dev server |
| `vitest` | ^5.0.5 | Test runner |
| `puppeteer` | ^25.16.0 | Browser automation tests |
| `lucide-react` | ^0.576.0 | Icon library |
| `@tanstack/react-virtual` | ^3.14.23 | Virtualized list rendering |

Node.js `node:sqlite` (built-in, requires Node >= 22.19.0) is used for all database operations.

---

## 18. Critical Implementation Files

| File | Role |
|---|---|
| `lib/server/runtime-api.mjs` | All HTTP API routing + SSE stream |
| `lib/server/task-runtime.mjs` | Central execution authority |
| `lib/server/task-db.mjs` | All SQLite operations + event bus |
| `lib/server/orchestration.mjs` | Multi-agent DAG scheduler |
| `lib/server/team-lead.mjs` | Goal decomposition + synthesis + review cycle |
| `lib/server/office-operations.mjs` | Service composition layer |
| `lib/server/specialist-catalogue.mjs` | Reviewed agent role definitions |
| `lib/server/specialist-registry.mjs` | Role-to-seat binding |
| `lib/server/hmem-memory.mjs` | Verified memory write/retrieval |
| `lib/server/estop.mjs` | Emergency stop mechanism |
| `lib/server/untrusted-content.mjs` | Prompt injection fencing |
| `lib/server/gateway-connection.mjs` | OpenClaw WebSocket client |
| `lib/server/nightshift-gateway.mjs` | Nightshift HTTP adapter |
| `lib/auggie-bridge.ts` | Auggie CLI bridge |
| `lib/voice/client.ts` | Gemini Live voice client |
| `lib/store.ts` | Browser state provider + SSE subscriber |
| `lib/events.ts` | Typed in-process event bus |
| `lib/server-security.mjs` | Origin + binding security checks |
| `types/game.ts` | All shared TypeScript types |
| `server.ts` | Dev server entry |

---

## 19. Existing Limitations

1. **No real-time WebSocket to browser**: All browser↔server communication is REST + SSE. No bidirectional push (which is fine for the read-heavy pattern but limits interactive sub-second latency).
2. **Single SQLite database**: Single-process lock (`acquireOwner`). Cannot run multiple Agent Town instances against the same DB.
3. **Phaser scene not code-split**: PhaserGame is dynamically imported (no SSR) but still loads the full Phaser bundle.
4. **NVIDIA and SpaceXAI adapters not implemented**: Environment variables are defined but no gateway adapter code exists.
5. **Voice limited to Gemini Live**: No abstraction layer; VoiceProvider and GeminiVoiceClient are Gemini-specific. Supporting another TTS/ASR provider requires new client code.
6. **10-minute call limit**: Hard-coded in `VOICE_SESSION_SECONDS`; reconnection requires a new call (context is re-fetched but conversation history is lost from the model's perspective).
7. **Nightshift limitations**: `REASONING_LIMITS` caps responses at 32KB, 1024 output tokens, 0 tool calls. Nightshift agents cannot use tools.
8. **Emergency stop is file-based**: Requires filesystem access. Not suitable for containerized deployments without a persistent volume.
9. **No authentication layer**: The app assumes a trusted local operator. Adding multi-user auth would require significant new work.
10. **Map/tiled assets are static**: The office map is a fixed Tiled tilemap. Changing the number of seats requires map editing.
11. **Handoff budget**: `HANDOFF_BUDGET = 3000` chars total across all teammate handoffs in one dispatch. Large results are truncated with head/tail preservation.
12. **Max orchestration tasks**: 12 tasks per plan, max 3 parallel; max 5 Team Lead workers (before synthesis/review).

---

## 20. Technical Debt and Architectural Risks

1. **Dual `.ts` / `.mjs` files**: Many lib files exist in both TypeScript (`auggie-bridge.ts`) and compiled/authored `.mjs` form (`auggie-bridge.mjs`). This creates maintenance risk and confusion about which is canonical.
2. **`runtime_records` as a generic key-value store**: Namespaced KV in SQLite works but makes schema discovery difficult and does not benefit from SQLite's relational capabilities.
3. **Hardcoded specialist catalogue**: Adding new specialist roles requires code changes, a new build, and a restart. There is no admin UI for role management.
4. **`dataIntent()` is a heuristic**: `lib/server/task-intent.mjs` uses pattern matching to decide whether to route to the verified pipeline. This can misroute general queries that happen to mention inventory terms.
5. **TeamLead tick loop vs event-driven**: The 1500 ms poll for team run advancement is simpler but adds latency and unnecessary CPU for idle offices. OrchestrationService is event-driven (DB subscription) but TeamLead is not.
6. **Phaser + Three.js dual rendering**: Two rendering stacks running concurrently is unusual. The Phaser scene continues to exist even in cinematic mode (just hidden). This wastes resources.
7. **H-MEM vendor copy**: `lib/vendor/hmem-reference` is a vendored copy of an external library built by a separate script (`scripts/build-hmem.mjs`). Updates require manual rebuild.
8. **Provider coupling in server.ts**: Provider selection logic is spread across `server.ts`, `runtime-api.mjs`, and `office-operations.mjs`. Adding a new provider requires changes in multiple places.
9. **No API versioning**: All `/api/runtime/*` routes are unversioned. Breaking changes require coordinated frontend+backend updates.
10. **Delivery contracts are complex**: The operation contract system (AJV schemas in `operations-contracts.mjs`, `reasoning-contracts.mjs`) is powerful but brittle; a schema change can silently break orchestration dispatch.

---

## 21. NammaOps Integration (Added Nov 2026)

### 21.1 What NammaOps Is

NammaOps is a kirana-store AI operations subsystem layered on top of the existing Agent Town runtime. It adds five named business agents, five multi-step workflows, an MCP governance layer for ERPNext tool access, owner-approval gating for purchase orders, live ERPNext read integration, and a voice query path via the existing Gemini Live session. It does NOT replace any existing Agent Town subsystem — it is purely additive.

All NammaOps code lives under `lib/server/nammaops/`, `lib/mcp/`, and `config/nammaops/`. The HUD gains three new panels: `NammaOpsPanel.tsx`, `McpGovernancePanel.tsx`, and `DeveloperModeModal.tsx` (expanded).

### 21.2 NammaOps Subsystem Architecture

```
Owner Voice (Gemini Live session)
    │  nammaops_business_query tool call (lib/voice/config.ts)
    ▼
VoiceRouter  (lib/server/nammaops/voice-router.mjs)
    │  maps voice intent → workflow intent
    │  starts workflow; waits up to 20s for result
    ▼
Workflows  (lib/server/nammaops/workflows.mjs)
    │  five actions: stock_check, prepare_reorder, daily_report,
    │  demand_forecast, supplier_comparison
    │
    ├── step("inventory", …)  → ErpBinding.call("erp.items.list", …)
    ├── step("sales", …)      → ErpBinding.call("erp.sales.history", …)
    ├── step("procurement", …)→ ErpBinding.call("erp.po.create_draft", …)
    ├── step("finance", …)    → ErpBinding.call("erp.pnl", …)
    └── step("manager", …)    → deterministic summarize() + optional
                                OpenClaw reasoning turn
                                │
ErpBinding  (lib/server/nammaops/erp-binding.mjs)
    │  translates business IDs (erp.stock.balance) to capability IDs
    │  (mcp.erp-fixture.get_stock_balance)
    ▼
Phase C ToolGateway  (lib/server/mcp-governance.mjs)
    │  checks grants, decision policy, runs the call under agent identity
    ▼
MCP stdio server:
  - Fixture:  lib/mcp/fixture-erpnext-server.mjs  [DEFAULT, TEST DATA]
  - Live:     lib/mcp/hvgerp-adapter-server.mjs   [REAL ERPNext, read-only]
              └── @hvgllc/hvgerp-mcp@3.7.0 child process
                  └── ERPNext Cloud
```

Owner text commands also arrive via the NammaOps REST API:
```
Owner types in panel → POST /api/nammaops/workflows {text: "Check the stock of milk"}
                     → Workflows.start() → same path as voice
```

### 21.3 The Five Agents

Defined in `config/nammaops/workforce.json` and registered by `lib/server/nammaops/workforce.mjs` through Phases A/B/C:

| Role | agent_id | Permitted capabilities | Notes |
|---|---|---|---|
| manager | nammaops-manager | none (coordinator only) | Optional OpenClaw reasoning turn; never reads ERP directly |
| inventory | nammaops-inventory | erp.items.list, erp.stock.balance, erp.warehouses.list, erp.stock.ledger, erp.stock.movements | All READ |
| sales | nammaops-sales | erp.sales_invoices.list, erp.pos_invoices.list, erp.customers.list, erp.items.list, erp.sales.history | All READ |
| procurement | nammaops-procurement | erp.suppliers.list, erp.supplier_quotations.list, erp.item_prices.get, erp.po.create_draft, erp.po.get, erp.po.open | READ + WRITE (draft only) |
| finance | nammaops-finance | erp.pnl, erp.gl, erp.purchase_invoices.list, erp.payments.summary | All READ |

A sixth "principal" `nammaops-po-submit` holds only `erp.po.get` and `erp.po.submit`; it runs only inside the owner-approval flow and is never reachable via the governed proxy.

Voice seat labels: Alice=manager, Bob=inventory, Carol=sales, Dave=procurement. Finance is a background agent with no voice seat.

### 21.4 The Five Workflows

All implemented and tested against the fixture. All take the same code path through `Workflows.execute()`:

| Workflow | Intent action | Steps | Approval required |
|---|---|---|---|
| Stock check | stock_check | inventory → (optional) procurement for low-stock ranking | No |
| Prepare reorder | prepare_reorder | inventory → procurement (rank+draft POs) → owner-approval requests | Yes — owner PIN via OwnerApprovals |
| Daily report | daily_report | sales (invoices+totals) → (optional) finance (P&L) | No |
| Demand forecast | demand_forecast | sales (90-day history) → inventory (stock+ledger) → procurement (POs+quotations) | No |
| Supplier comparison | supplier_comparison | inventory (resolve products) → procurement (quotations+prices) | No |

Parsing of natural-language text into intents is fully deterministic (`parseCommand()` in workflows.mjs — no LLM required for routing).

Calculations (stock analysis, supplier ranking, sales aggregation, demand forecast) are all deterministic pure functions in `calculations.mjs` and `forecast.mjs`. No model inference in business logic.

### 21.5 Demand Forecast Engine

`lib/server/nammaops/forecast.mjs` is a complete time-series forecasting implementation:

- 90-day history window from submitted sales lines and stock ledger
- Stockout censoring (zero-sales days during stockout are excluded, not treated as zero demand)
- Four methods: 7-day MA, 30-day MA, exponential weighted (α=0.3), weekday-pattern 30-day
- Backtesting: hold out most recent 14 days; select method with lowest WAPE
- Reorder recommendation: `max(0, lead_time_demand + safety_stock − available − incoming)` with safety stock = 1.65 × σ × √lead_time
- Returns `status: "insufficient_evidence"` when fewer than 14 observed days exist

### 21.6 Owner Approval Flow

`lib/server/nammaops/owner-approvals.mjs` implements a PIN-gated, fingerprinted, idempotent purchase-order submission:

1. `prepare_reorder` workflow drafts POs in ERP via the procurement agent
2. `OwnerApprovals.request()` snapshots the exact PO (order fingerprint via SHA-256 of canonical JSON)
3. Owner sees the draft in NammaOpsPanel; enters PIN; clicks Approve or Reject
4. `approve()`: re-reads the PO from ERP, verifies fingerprint matches, then submits — if the PO changed, the request is invalidated; nothing is submitted
5. Submissions are idempotent: claiming the "submitting" state uses SQLite optimistic concurrency (revision check) to prevent double-submits
6. Approval TTL: 30 minutes
7. `reconcile()`: after an "uncertain" or "failed" submission, re-reads ERP to determine true document state before allowing retry

Voice agents explicitly CANNOT approve. The `speak_rule` in every voice response prohibits agents from reporting numbers that are not in the contract.

### 21.7 MCP Governance Layer

`lib/server/mcp-governance.mjs` (pre-existing but now heavily used by NammaOps) provides:

- **CapabilityRegistry**: discovers tools from MCP servers, tracks schema fingerprints, holds review state (discovered → registered after developer risk review)
- **Governance**: assigns capabilities to agents/specializations, grants operations, enforces per-call approval for EXTERNAL_ACTION risk level
- **ToolGateway**: the single execution path for every ERP call — checks grants, logs invocations, enforces MAX_RESPONSE_BYTES (256 KB) cap
- **governed-tools-mcp.mjs**: the proxy an OpenClaw seat registers instead of a real MCP server — routes all tool calls through the Agent Town gateway with agent identity from environment, never from tool arguments

The setup flow (`workforce.mjs setupWorkforce()`) automates: register server → discover tools → review capabilities with correct risk levels → create specializations → assign agents to seats → grant capabilities. This is idempotent and re-runnable.

`McpGovernancePanel.tsx` exposes the full governance state in the HUD: servers, capabilities with risk, assignments, grants, approval queue, and the last 20 invocations.

### 21.8 ERPNext Integration Status

Two binding modes exist, selected by `NAMMAOPS_BINDING` environment variable:

**Fixture mode** (`config/nammaops/binding.fixture.json`) — DEFAULT:
- MCP server: `lib/mcp/fixture-erpnext-server.mjs` (in-process stdio)
- Data: `config/nammaops/fixture-data.json` — 7 products (Toned Milk, Rice, Sunflower Oil, Coconut Oil, Toor Dal, Sugar, Ghee), 2 warehouses, suppliers, quotations, 90-day synthetic demand history
- Purchase orders: persisted to a temp file; create_draft and submit both work
- All workflows fully functional with fixture data
- `source: "fixture"` on every tool response

**Live ERPNext mode** (`config/nammaops/binding.hvgerp.json`):
- MCP server: `lib/mcp/hvgerp-adapter-server.mjs` wrapping `@hvgllc/hvgerp-mcp@3.7.0`
- Credentials: `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` in server environment only
- Read-only: 17 named hvgerp tools, verified `readOnlyHint:true` at startup
- All five read workflows (stock_check, daily_report, demand_forecast, supplier_comparison, and read-only prepare_reorder) work against live ERPNext
- **Disabled on live**: `erp.po.create_draft`, `erp.po.get`, `erp.po.submit`, `erp.payments.summary` — purchase-order drafting and submission against live ERPNext is intentionally not enabled
- Verified live: 36 items, 35 stock bins, 479 invoices, P&L reconciles, 64 governed reads — zero writes in all test runs
- The adapter handles partial-list splitting (recursive date-window bisection), immutable caching of submitted document detail, and concurrent fetching (8 workers) to handle hvgerp's per-item fetch model for reorder levels and invoice lines

The demo store has a seeded ERPNext Cloud instance with records marked `NAMMAOPS-SEED`.

### 21.9 Voice Routing

`lib/voice/config.ts` registers the `nammaops_business_query` tool in the Gemini Live session for any agent whose `VoiceAgentContext` has a `department` field (Alice, Bob, Carol, Dave). The tool declaration includes all eight voice intents.

`lib/voice/agent-actions.ts` includes `nammaops_business_query` in `VOICE_ACTIONS` — the allowlist of tools the voice handler will forward to the server.

`lib/server/nammaops/voice-router.mjs` (`VoiceRouter.query()`):
- Validates the calling agent is a configured voice department (presentation only — no permissions flow from the voice seat)
- Deduplicates retries using a SHA-256 hash of `[call_id, action_id]`
- Maps voice intents to workflow actions via `VOICE_INTENTS` table
- Starts the workflow, waits up to 20s, returns a structured contract with `facts`, `recommendations`, `limitations`, `speak_rule`, and evidence
- The `speak_rule` instructs the voice model to say only the listed facts

`lib/server/nammaops/group-business.mjs` handles the office group-chat path: `"Bob, check the stock of milk"` routes through `businessIntent()` → same VoiceRouter.

### 21.10 STT Implementation

`lib/server/stt.mjs` implements three providers, selected by `AGENT_TOWN_STT_PROVIDER`:

| Provider | Env var value | Implementation | Note |
|---|---|---|---|
| Gnani Prisma | `gnani` | REST POST to `https://api.vachana.ai/stt/v3`, auth `X-API-Key-ID` header, multipart/form-data | [IMPLEMENTED] |
| Gemini | `gemini` | `generateContent` with inline audio, model `gemini-2.5-flash` | [IMPLEMENTED — fallback] |
| Fixture | `fixture` | Returns a configured fixed transcript | [TEST ONLY] |

Unset `AGENT_TOWN_STT_PROVIDER` → STT tasks return 503 (never silently fall through).

Supported audio formats: WAV, MP3, OGG, FLAC, AAC, M4A, WebM. Max 5 MB.

Language hint: accepts BCP-47 codes (`kn-IN`, `hi-IN`, `en-IN`) or `indic-auto` for auto-detection.

**The Gnani Prisma provider is fully implemented and ready to use** — it only needs `GNANI_API_KEY` in the environment. This is the primary Gnani integration gap for the hackathon.

### 21.11 New REST API Endpoints

All under `/api/nammaops/` (also mirrored at `/api/runtime/nammaops/`). Loopback only.

| Method | Path | Purpose |
|---|---|---|
| POST | /setup | Register MCP server, discover tools, configure five agents (idempotent) |
| GET | /workforce | Current workforce state |
| GET | /binding | Business capability → tool binding status |
| GET | /dashboard | Latest workflow per kind + approvals + data source |
| GET | /workflows | Recent 50 workflows (newest first) |
| POST | /workflows | Start workflow from text or structured intent |
| GET | /workflows/{id} | Full workflow view with tasks and timeline |
| GET | /workflows/{id}/events | Timeline + tasks only |
| GET | /approvals | All owner approval requests |
| POST | /approvals/{id}/approve | Owner PIN approve → re-verify + submit to ERP |
| POST | /approvals/{id}/reject | Owner PIN reject |
| POST | /approvals/{id}/reconcile | Re-read ERP after uncertain/failed submission |
| GET | /openapi.json | OpenAPI 3.1 spec |

### 21.12 New UI Panels

**NammaOpsPanel.tsx** (`components/hud/NammaOpsPanel.tsx`):
- HUD flyout titled "NammaOps"
- Shows: workforce table (5 agents with seat, granted tools, live status), owner command textbox with 4 example buttons, workflow result sections (inventory table, reorder approval with PIN entry, demand intelligence with evidence drill-down, daily business summary), live workflow timeline
- Subscribes to `/api/runtime/events` SSE, re-polls dashboard on `nammaops.*` or `mcp.invocation` events
- Shows "test fixture" or "live ERPNext" banner based on data source

**McpGovernancePanel.tsx** (`components/hud/McpGovernancePanel.tsx`):
- Embedded as a tab inside DeveloperModeModal
- Shows: MCP server registration form, discovered tools with schema viewer and risk review, assignments/grants editor, per-operation approval queue, last 20 invocation audit records

**DeveloperModeModal.tsx** — expanded with a `mcp` tab that shows McpGovernancePanel.

### 21.13 Integration with Existing Agent Town Orchestration

NammaOps does NOT use Agent Town's `OrchestrationService`, `TeamLead`, or task pipeline for its workflow steps. Instead:
- Each specialist step is a child task in `runtime_records` under `nammaops.task` namespace
- The workflow record lives in `nammaops.workflow` namespace
- ERP calls go through the Phase C `ToolGateway` (same as any other MCP tool call)
- Owner approvals persist in `nammaops.owner-approval` namespace

The optional Manager reasoning turn (`NAMMAOPS_REASONING=manager`) submits a text task to `agentTasks.submitText()`, which does use the normal Agent Town task path through an OpenClaw seat.

The `createNammaOps()` factory in `index.mjs` is called from `server.ts` / `server.prod.mjs` at startup, attaching the NammaOps instance to `runtime.nammaops`. The runtime API handler in `runtime-api.mjs` routes `/api/nammaops/` requests to `handleNammaOpsApi()`.
