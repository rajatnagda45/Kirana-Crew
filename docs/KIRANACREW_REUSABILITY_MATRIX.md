# KiranaCrew — Reusability Matrix for KiranaCrew / KiranaCrew

> **Note (2026-11-02):** The public product brand is now **KiranaCrew**. This matrix documents which KiranaCrew components were reused for the kirana store workforce.

**Target product**: KiranaCrew — AI Workforce for Kirana Stores  
A voice-first, vernacular-language, domain-specific B2B SaaS product serving small Indian grocery stores. Key characteristics:

- Voice-first interface (owner speaks, AI acts)
- Vernacular language (Hindi, Kannada, Tamil, etc.)
- Domain: inventory, supplier orders, payments, staff scheduling, daily accounts
- Mobile-first browser or PWA
- Multi-tenant (many kirana stores, each is a separate workspace)
- Real-time task execution (ordering, reconciliation, alerts)
- Low-bandwidth / intermittent connectivity considerations

---

## Classification Key

| Label                           | Meaning                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| **REUSE AS-IS**                 | Copy or install directly; no modification needed                              |
| **REUSE WITH ADAPTATION**       | Core logic is sound; needs targeted changes (interface, config, domain terms) |
| **REFACTOR**                    | Useful concepts but needs significant restructuring before use                |
| **REPLACE**                     | Current implementation is incompatible; start fresh with same concept         |
| **NEW IMPLEMENTATION REQUIRED** | No equivalent exists; must be built from scratch                              |

---

## Subsystem Classifications

### 1. Agent Orchestration Engine (OrchestrationService + TeamLead)

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- The DAG scheduler in `OrchestrationService.reconcile()` is production-quality: topological dispatch, parallel slots, evidence gating, handoff injection, schema repair, repetition detection.
- The `TeamLead` goal decomposition loop (plan → workers → synthesize → review → revise) is directly applicable to kirana workflows: e.g., "check stock discrepancy" → planner breaks it into data retrieval + analysis + recommendation + human approval.
- `EmergencyStop`, stall detection, and transfer-to-other-agent on failure are valuable for a commercial system.

**What to adapt:**

- `STALL_MS=15min` and `MAX_TRANSFERS=2` are tunable; kirana workflows may need shorter timeouts.
- Team board UI (deep-link pages) must be rebuilt for a mobile-first experience.
- Group chat (`OfficeGroupChat`) coupling in TeamLead should be removed or adapted to WhatsApp/SMS notification patterns.
- The 1500 ms tick loop should be replaced with event-driven advancement for scale (many concurrent stores).

**Effort**: 2–3 weeks to adapt and integrate.

---

### 2. Task Scheduling / Task Lifecycle

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- `TaskDatabase` task status machine (`queued` → `submitted` → `running` → `completed`/`failed`/`interrupted`) is solid and generic.
- `dispatches` idempotency ledger prevents duplicate submissions.
- Cursor-based event replay for reconnecting clients is critical for mobile (intermittent connectivity).
- `claim()` transaction semantics prevent double-dispatch.

**What to adapt:**

- Task submission currently assumes a single store / single tenant. Must add `tenantId` (store ID) as a first-class field.
- The `task_lane` index on `(gateway, session)` must be extended to include tenant scope.
- Session key format (`agent:main:...`) needs rethinking for multi-tenant (e.g., `agent:{tenantId}:{storeId}:...`).

**Effort**: 1–2 weeks for multi-tenant adaptation.

---

### 3. Worker Management (SpecialistRegistry + Catalogue)

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- The manifest → seat binding → permission scope pattern is excellent for controlling what each AI agent can do. This is the right security boundary for kirana store operations.
- `executor` role requiring `approval.gateway` maps directly to: AI proposes a purchase order → owner approves via voice/tap → system executes.
- Catalogue as static code with version-controlled permissions is the right pattern.

**What to adapt:**

- Replace the `specialist-catalogue.mjs` entries with kirana-specific roles: `stock-checker`, `order-placer` (executor), `payment-reconciler`, `demand-forecaster` (analyst), `supplier-negotiator`.
- Remove `maintenance-specialist` and Zetaris-specific data steward.
- Add vernacular instruction templates per role.
- `provision()` auto-hiring logic may not apply; kirana stores work with fixed agent sets.

**Effort**: 1 week to define new catalogue + 1 week integration.

---

### 4. Memory (HmemMemory + DecisionMemory)

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- The verified-memory write pattern (only writes after Critic passes + evidence chain validated) is exactly right for a business system: "what we know about supplier X is based on verified invoice data."
- Proof-chain re-validation at read time prevents stale data from poisoning decisions.
- `freshUntil` TTL semantics match perishable kirana data: prices change weekly, stock is daily.
- Lexical recall with optional semantic upgrade is practical for low-resource deployment.

**What to adapt:**

- Memory scope is currently `(gatewayId, agentId, sessionKey, seatId, bindingRevision)`. For KiranaCrew, scope should be `(tenantId, storeId, sessionKey)`.
- The `applicability` field (200 char topic) is a good fit for kirana queries like "tomato supplier reliability" or "evening milk demand patterns."
- `DecisionMemory` (supplier decisions) is directly usable for kirana supplier management with cosmetic renaming.
- The vendored H-MEM reference engine (`lib/vendor/hmem-reference`) can be reused as-is.

**Effort**: 1 week scope adaptation + 1 week testing.

---

### 5. Event Infrastructure (TaskDatabase + SSE)

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- `events` table as append-only log with `seq` cursor is a clean, simple event store.
- `subscribe()` fan-out pattern for SSE is solid.
- Cursor-based replay for reconnecting clients is critical for mobile.

**What to adapt:**

- Add tenant-scoped event filtering: a kirana store owner should only see their store's events.
- SSE works well but consider adding a fallback for very low-bandwidth conditions (polling fallback).
- For multi-tenant scale, the single SQLite file approach must be replaced (see Persistence section).

**Effort**: 1 week for tenant scoping.

---

### 6. Persistence (SQLite via node:sqlite)

**Classification: REFACTOR**

**What to keep:**

- The schema design (task table, dispatches idempotency, runtime_records KV, events log) is well-thought-out.
- The WAL mode + `busy_timeout=5000` + single-process ownership pattern works for single-tenant.

**What must change:**

- SQLite with a per-process lock cannot support multi-tenant SaaS. Must move to PostgreSQL or PlanetScale (MySQL-compatible) for proper multi-tenancy, connection pooling, and cloud deployment.
- The `acquireOwner()` single-process lock must be replaced with row-level tenant isolation.
- `runtime_records` as a blob KV in SQLite is fine for prototyping; for production, structured tables per namespace improve query capability and indexing.
- Node >= 22.19.0 requirement for `node:sqlite` is a deployment constraint; Postgres removes it.

**Effort**: 3–4 weeks to migrate schema + rewrite TaskDatabase with a Postgres driver.

---

### 7. Voice Architecture (GeminiVoiceClient + VoiceService)

**Classification: REPLACE**

**Why replace:**

- `GeminiVoiceClient` requires `GEMINI_API_KEY` (USD billing, not INR-friendly for small merchants).
- Gemini Live is English-first; vernacular support (Hindi, Kannada, Tamil) requires explicit model selection and may have quality gaps.
- The AudioWorklet pattern requires a desktop-class browser; kirana owners typically use low-end Android phones with Chrome.
- The 10-minute call limit and ephemeral token model are mismatched with "keep listening while I close the shop" use cases.
- No interruption recovery that reconnects the conversation context.

**What concept to carry forward:**

- The `VoiceEvents` interface (`status`, `transcript`, `error`, `tool`, `announcement`) is an excellent abstraction. Reimplement it with a different backend.
- The background context injection pattern (`flushBackground`, `sendClientContent`) for pushing task state updates during silence is worth replicating.
- Tool-call-via-POST pattern (`/api/runtime/voice/actions`) is reusable.

**Recommended replacement**: Google Cloud Speech-to-Text (Chirp model, multilingual) + Gemini Flash text (cheaper) + Google Cloud TTS or a local TTS, orchestrated server-side. Or explore Sarvam AI (Indian voice AI startup) which has stronger vernacular support.

**Effort**: 4–6 weeks to build a multilingual voice adapter.

---

### 8. Frontend Game Engine (Phaser + Three.js)

**Classification: REPLACE**

**Why replace:**

- A pixel-art office visualization of AI agents is compelling for a hackathon demo and developer tooling but is inappropriate for kirana store owners as a primary UI.
- Phaser + Three.js adds ~2MB of JS bundle (Phaser ≈800KB, Three.js ≈600KB) that a kirana owner's low-end phone will struggle with.
- The office metaphor (agents at desks) does not resonate with grocery store operations.
- The Tiled map is a static asset that does not scale to multi-tenant customization.

**What concept to carry forward:**

- The `seats-discovered` → `seat-configs-updated` event pattern for mapping AI agents to named roles is reusable in a simpler UI (e.g., a WhatsApp-style agent list or a store dashboard with agent status cards).
- The `GameEventBus` typed event bus is reusable — just replace Phaser event endpoints with React ones.

**Recommended replacement**: A mobile-first PWA with a clean, simple dashboard. "Store AI workforce" shown as a card list with status indicators, not a game. Progressive disclosure: voice-first, with the dashboard as secondary.

**Effort**: New implementation, 4–8 weeks for MVP UI.

---

### 9. Real-Time Communication (SSE + REST)

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- The SSE + REST pattern is simple, reliable, and does not require WebSocket infrastructure.
- Cursor-based replay via `Last-Event-ID` handles mobile network drops gracefully.
- `runtimeRequest()` fetch wrapper with error handling is clean.

**What to adapt:**

- Add tenant authentication (JWT or session cookie) to all runtime API calls.
- Add per-tenant event scoping in the SSE stream.
- Consider a Service Worker for offline queuing of task submissions on mobile.

**Effort**: 1–2 weeks for auth + tenant scoping.

---

### 10. Security (server-security.mjs + untrusted-content.mjs)

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- `fenceUntrusted()` prompt injection fencing is essential and directly portable.
- The Critic + approval gate pattern for high-stakes actions (purchase orders, payments) is exactly right for kirana operations.
- Operation contract schemas (AJV-validated) provide machine-verifiable boundaries.

**What to adapt:**

- `resolveBindHost()` loopback-only binding must be replaced with proper SaaS authentication (the app will be cloud-hosted, not local).
- `isAllowedAppOrigin()` needs tenant-aware origin allowlisting.
- Add proper IAM: store owner vs. staff vs. admin roles with different tool grants.
- The `executor` role's `approval_required` permission must map to mobile push notifications for human approval (not a desktop review dialog).

**Effort**: 2–3 weeks for SaaS security hardening.

---

### 11. Provider Adapters (ServerGateway + NightshiftGateway)

**Classification: REUSE WITH ADAPTATION**

**What to keep:**

- `ServerGateway` is a clean WebSocket adapter with protocol versioning, reconnection, and event dispatch.
- `NightshiftGateway` demonstrates the pattern for OpenAI-compatible HTTP adaptation.
- The `capabilities()` method for declarative capability discovery is a good pattern.

**What to adapt:**

- For KiranaCrew, the primary "gateway" may be a custom agent runtime or a managed service. The adapter pattern is directly reusable.
- Consider replacing OpenClaw dependency with a vendor-neutral abstraction.
- Nightshift's `maxToolCalls: 0` limit makes it unsuitable for kirana operations that require tool use (reading stock DB, placing orders).

**Effort**: 1–2 weeks to write a new provider adapter.

---

## Priority Order for KiranaCrew

| Priority  | Subsystem               | Action                                                  | Weeks            |
| --------- | ----------------------- | ------------------------------------------------------- | ---------------- |
| 1         | Persistence             | REFACTOR to PostgreSQL + multi-tenant schema            | 3–4              |
| 2         | Security                | ADAPT for SaaS: auth, tenant isolation, mobile approval | 2–3              |
| 3         | Agent Orchestration     | ADAPT: kirana roles, mobile timeouts, event-driven tick | 2–3              |
| 4         | Worker Management       | ADAPT: new catalogue, kirana roles                      | 1–2              |
| 5         | Voice Architecture      | REPLACE with multilingual voice adapter                 | 4–6              |
| 6         | Frontend Game Engine    | REPLACE with mobile-first PWA dashboard                 | 4–8              |
| 7         | Real-Time Communication | ADAPT: add auth + tenant scoping                        | 1–2              |
| 8         | Task Scheduling         | ADAPT: multi-tenant task lanes                          | 1–2              |
| 9         | Memory                  | ADAPT: kirana scope fields, supplier memory             | 1–2              |
| 10        | Event Infrastructure    | ADAPT: tenant filtering                                 | 1                |
| 11        | Provider Adapters       | ADAPT: write kirana-specific adapter                    | 1–2              |
| **Total** |                         |                                                         | **~24–38 weeks** |

---

## What NOT to Carry Over

1. **Phaser + Three.js rendering stack** — zero value for kirana store owners; significant bundle weight.
2. **`data-zetaris.mjs` (Zetaris integration)** — enterprise data warehouse connector; irrelevant for kirana.
3. **`auggie-bridge.ts` (Auggie CLI bridge)** — developer-tooling-specific; replace with a direct managed agent API.
4. **The pixel-art office map + sprites** — entirely visual; not applicable.
5. **`OfficeGroupChat`** — the "team chat feed" metaphor doesn't map to kirana operations.
6. **`NVIDIA_API_KEY` placeholder** — not implemented and not needed.
7. **`specialist-catalogue.mjs` entries for maintenance-specialist** — irrelevant domain.
8. **`DecisionMemory` supplier policy as-is** — the code is reusable but the policy text is for a demo scenario; replace with actual kirana supplier terms.

---

## Key Architectural Strengths to Preserve

1. **Verified work pipeline** (`TaskComposer`): The concept of requiring Critic verification before writing to memory or confirming a result is the right foundation for a business-critical system. A kirana store owner should not receive unverified stock counts.

2. **Human-in-the-loop approval** (`ReviewService` + executor role): Mapping AI recommendations to human approval before execution is essential for financial operations (purchase orders, payments).

3. **Idempotency ledger** (`dispatches` table + `SpecialistJournal`): Prevents double-ordering of goods on reconnect — directly critical for kirana.

4. **Prompt injection fencing** (`untrusted-content.mjs`): Essential when supplier names, product descriptions, or customer messages could contain adversarial content.

5. **Evidence freshness TTL** (`freshUntil` in HmemMemory): Stock data goes stale within hours; the TTL mechanism is exactly right.
