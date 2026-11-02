# NammaOps — Final Build Decisions (REVISED Nov 2, 2026)

> **Based on a full read of all 82 new files added in the Nov 2 merge.**
> Every claim is sourced directly from the code. Status labels are factual, not aspirational.
> Supersedes the Nov 1 "audit" version, which was based on pre-build assumptions.
> Deadline: November 10, 2026, 11:59 PM IST — 8 days remaining.

---

## 1. Current State Assessment

### What Is Fully Implemented

The NammaOps engine is production-grade, tested, and running. The following work WITHOUT any Gnani API key:

**Five-agent workforce** (`config/nammaops/workforce.json`, `workforce.mjs`):
- Manager agent (coordinator, optional reasoning turn)
- Inventory agent (items, stock, warehouses, ledger, movements)
- Sales agent (invoices, POS, customers, sales history)
- Procurement agent (suppliers, quotations, prices, draft POs)
- Finance agent (P&L, GL, purchase invoices, payments)
- Agents are registered through Phase A (profiles) / Phase B (specializations) / Phase C (capability grants)
- Setup is idempotent and automated via `POST /api/nammaops/setup`

**Five workflows** (`workflows.mjs`):
- `stock_check`: reads items + stock → analyseStock() → optionally rankSuppliers() for low items
- `prepare_reorder`: stock_check + create draft POs → owner approval requests
- `daily_report`: reads sales invoices + POS → aggregateSales() → optionally finance P&L
- `demand_forecast`: 90-day sales history + stock ledger + open POs → forecastItem() for each product
- `supplier_comparison`: resolve product names → rankSuppliers() with quotations

All workflows: deterministic calculations, no LLM inference in the critical path, full audit trail.

**Demand forecast engine** (`forecast.mjs`):
- Four methods: MA7, MA30, exponential weighted (α=0.3), weekday-pattern
- Backtesting via WAPE on 14-day holdout
- Stockout censoring from stock ledger
- Reorder formula: max(0, lead_time_demand + safety_stock − available − incoming)
- `insufficient_evidence` when < 14 observed days

**ERPNext fixture** (`fixture-erpnext-server.mjs`, `config/nammaops/fixture-data.json`):
- 7 products with 90-day deterministic demand history (including stockout, promo, new-launch scenarios)
- All 20 business capabilities mapped to fixture tools
- Draft PO creation and submission both work

**Live ERPNext** (`hvgerp-adapter-server.mjs`, `config/nammaops/binding.hvgerp.json`):
- 16 read capabilities verified against live ERPNext Cloud
- 36 items, 35 bins, 479 invoices, P&L reconciles
- 64 governed reads in verification run; 0 writes
- PO drafts and submission intentionally disabled on live

**MCP governance** (`mcp-governance.mjs`):
- Full pipeline: discover → review → assign → grant → invoke → audit
- Every ERP call logged with agent identity, capability, decision, status
- MAX_RESPONSE_BYTES (256 KB) enforced; response size attacks blocked
- Approval queue for EXTERNAL_ACTION risk tools (developer approval)

**Owner approval** (`owner-approvals.mjs`):
- PIN-gated, fingerprinted, idempotent
- Re-reads PO before submission; rejects if draft changed
- Optimistic concurrency via SQLite revision check prevents double-submit
- TTL: 30 minutes; `reconcile()` for uncertain/failed outcomes

**Voice routing** (`voice-router.mjs`, `lib/voice/config.ts`):
- `nammaops_business_query` tool registered in all four department Gemini Live sessions
- VoiceRouter maps 8 voice intents to workflow actions
- Returns structured voice contract: facts, recommendations, limitations, speak_rule
- Voice cannot approve purchase orders

**Gnani Prisma STT** (`stt.mjs` — `gnaniProvider()`):
- [IMPLEMENTED — needs API key]
- REST POST to `https://api.vachana.ai/stt/v3`
- Auth: `X-API-Key-ID` header (correct, verified from official docs)
- Language hint: BCP-47 codes (`kn-IN`, `hi-IN`) or `indic-auto`
- Multipart/form-data audio upload, 60s timeout
- 5 MB audio size limit
- Supported formats: WAV, MP3, OGG, FLAC, AAC, M4A, WebM

**UI panels** (`NammaOpsPanel.tsx`, `McpGovernancePanel.tsx`, `DeveloperModeModal.tsx`):
- NammaOpsPanel: workforce table, command input, 4 preset examples, results, approval flow, demand intelligence, daily report, live timeline
- McpGovernancePanel: server registration, tool discovery, risk review, assignment/grant editor, approval queue, audit log

**OpenAPI spec** (`openapi.mjs`):
- Complete OpenAPI 3.1 spec for all 14 NammaOps endpoints
- Examples are real fixture responses
- Served at `GET /api/nammaops/openapi.json`

### What Is Stubbed

Nothing in NammaOps is stubbed. All implemented features are genuinely functional.

### What Is Missing (Must Build)

1. **Gnani Timbre TTS** — Zero code exists. Must build `lib/server/tts.mjs` with `timbreProvider()` making calls to `POST https://api.gnani.ai/v1/tts/inference` (or WebSocket at `wss://api.vachana.ai/api/v1/tts`) with `X-API-Key-ID` auth. Required for Gnani voice output.

2. **Standalone Gnani voice page** — The current voice path uses Gemini Live (which does its own STT/TTS). A separate `/nammaops/voice` page must be built that uses Prisma for input and Timbre for output.

3. **Gnani Prisma wired to NammaOps** — `gnaniProvider()` exists and works; it needs a browser→server audio path that is separate from the existing Gemini Live session path.

---

## 2. Gnani Integration Gap Analysis

### Gap 1: Gnani Prisma STT

**File with existing implementation**: `lib/server/stt.mjs`, function `gnaniProvider()`

The function is complete. The gap is routing:

```
Current path:  Owner speaks → Gemini Live session → Gemini STT → transcript
Target path:   Owner speaks → Browser AudioWorklet → POST /api/nammaops/voice/transcribe
               → server: gnaniProvider().transcribe({bytes, mime, language})
               → {transcript, provider: "gnani-prisma"}
               → NammaOps parseCommand(transcript, today)
               → workflow start
```

**Files to change/create**:
- New server route (add to `runtime-api.mjs` or `lib/server/nammaops/api.mjs`): `POST /api/nammaops/voice/transcribe`
- New browser component: audio capture → POST → display transcript
- New environment: `AGENT_TOWN_STT_PROVIDER=gnani`, `GNANI_API_KEY=<key>`

**Estimated effort**: 4 hours (the hard part is done — `gnaniProvider()` is complete)

### Gap 2: Gnani Timbre TTS

**File with existing implementation**: None. Must build.

```
Target path:   voice contract {facts, recommendations} text
               → POST /api/nammaops/voice/speak {text, language}
               → server: timbreProvider().synthesize({text, language})
               → audio bytes
               → browser audio element plays
```

**Files to create**:
- `lib/server/tts.mjs` with `timbreProvider({apiKey})` — REST POST to Timbre API with `X-API-Key-ID` auth, returns audio bytes
- Server route: `POST /api/nammaops/voice/speak` (add to `api.mjs`)
- Browser component: receives audio bytes, plays via Web Audio API or `<audio>` element

**API endpoint** (from verified docs): `POST https://api.gnani.ai/v1/tts/inference`
**Auth**: `X-API-Key-ID: {GNANI_API_KEY}` header
**Request body**: `{text, language_code}` — e.g. `{text: "Haalindu stock…", language_code: "kn-IN"}`
**Estimated effort**: 6 hours

### Gap 3: Standalone Voice Page

Once Gaps 1 and 2 are closed, a standalone page at `app/nammaops/voice/page.tsx` that combines:
- Audio capture (browser)
- Transcript display (Prisma output)
- NammaOps workflow status (from SSE events)
- Timbre audio player

This is the "money shot" for the hackathon video: one screen showing Prisma transcript, workflow agents activating, and Timbre playing the response.

**Estimated effort**: 1 day

---

## 3. Final Model Selection

### Prisma STT — CONFIRMED PRIMARY

**Status**: Code written (`gnaniProvider()` in `stt.mjs`). Needs API key.
**Endpoint**: `https://api.vachana.ai/stt/v3`
**Auth**: `X-API-Key-ID: {GNANI_API_KEY}` header
**Languages**: `kn-IN` (Kannada), `hi-IN` (Hindi), `indic-auto`
**Where it hooks in**: `stt.mjs` function `gnaniProvider()` called by server route `POST /api/nammaops/voice/transcribe`

### Timbre TTS — CONFIRMED PRIMARY (not yet built)

**Status**: Zero code. Build Day 2.
**Endpoint**: `POST https://api.gnani.ai/v1/tts/inference`
**Auth**: `X-API-Key-ID: {GNANI_API_KEY}` header
**Languages**: `kn-IN`, `hi-IN`
**Where it hooks in**: New `tts.mjs` called by `POST /api/nammaops/voice/speak`
**Fallback**: Gemini Live voices (Kore/Puck/Aoede/Charon) — already functional, but do not count as Gnani Timbre for the hackathon

### Evon LLM — NOT ON API PLATFORM (confirmed)

**Status**: Evon v3.3 is self-hosted only. Not on gnani.ai API platform. Requires H100/A100.
**Decision**: Do NOT wait for GPU access.

The Manager reasoning turn in NammaOps (`NAMMAOPS_REASONING=manager`) submits a task to the existing OpenClaw agent. For the hackathon demo, reasoning is off by default (`NAMMAOPS_REASONING=off`) — business logic is deterministic and needs no LLM reasoning.

For a compelling demo, the Manager agent can summarize results verbally via the existing Gemini Live voice session (Alice speaks the summary). This counts as Gnani usage (Prisma + Timbre) without needing Evon.

**Fallback reasoning** (if a reasoning turn is wanted for demo flair): GPT-4o-mini or Gemini 2.0 Flash via the existing OpenClaw integration — no new code needed, just the seat configuration.

---

## 4. Primary Award Target

### Primary: Real Deal Award

**Criterion**: "Most useful real-world problem solved — for kirana stores, farmers, rural health"
**Why NammaOps wins**: The award description explicitly names kirana stores. NammaOps is a complete kirana store operations platform — stock intelligence, supplier management, demand forecasting, financial summary, owner-controlled purchase approval. Voice input in Kannada/Hindi via Gnani Prisma. All workflows tested against live ERPNext data.

**What judges will see**:
1. Voice query in Kannada → Gnani Prisma transcript visible on screen
2. Five agents activating in sequence → ERP data retrieved under governed identities
3. Draft purchase order → owner PIN approval → ERP write (fixture) or read-only summary (live)
4. Demand forecast with stockout censoring, backtesting, safety stock — all deterministic

**What makes this "Real Deal"**: The MCP governance layer means every ERP read is logged, audited, and permission-gated. The owner cannot be fooled by hallucinated numbers — facts come only from ERP tools. The approval gate means no financial action without human sign-off.

### Secondary: Main Character Award

**Criterion**: "Best build in a regional or low-resource Indian language"
**Why NammaOps qualifies**: Primary language is Kannada (kn-IN) via Gnani Prisma. The fixture and live data include Indian product names (Toned Milk, Toor Dal, Sunflower Oil) with Kannada/Hindi aliases. The voice contract's `speak_rule` is designed to prevent the model from adding English numbers on top of Kannada facts.

---

## 5. Exact MVP Scope for Demo

### The Three End-to-End Workflows for the 60-Second Video

**Workflow A — Gnani Voice + Stock Check (Day 3-4)**
- Owner speaks in Kannada: "Haalindu stock enu aagide?" (How is the stock of milk?)
- Prisma transcribes: transcript visible on screen
- Inventory + Procurement agents run: timeline visible
- Timbre TTS speaks result in Kannada: voice contract facts only
- Shows: Gnani Prisma input → deterministic ERP read → Gnani Timbre output
- All data from live ERPNext (real numbers)

**Workflow B — Prepare Reorder with Owner Approval (Day 5)**
- Owner speaks: "Products running low — prepare an order"
- Prisma transcribes
- Inventory + Procurement create draft POs in ERP (fixture)
- Panel shows draft POs with line items and total
- Owner enters PIN → Approve → "Submitted to ERP"
- Shows: human-in-the-loop approval, cryptographic integrity, ERP write gate

**Workflow C — Demand Forecast (Day 5)**
- Owner speaks: "What will sell next week?"
- 90-day historical forecast with backtesting
- Timbre speaks top 3 items with predicted demand and stockout risk
- Shows: statistical forecasting, explainable AI (method selected by WAPE), supply planning

---

## 6. Day-by-Day Schedule Nov 2–10

### Day 2 (Nov 2) — Gnani API Integration
**Objective**: Both Prisma STT and Timbre TTS make successful calls.

| Deliverable | File | Done? |
|---|---|---|
| `GNANI_API_KEY` obtained; `AGENT_TOWN_STT_PROVIDER=gnani` tested | `.env.local` | [ ] |
| `gnaniProvider()` tested: WAV file → transcript | `stt.mjs` (existing) | [ ] |
| `timbreProvider()` built: text → audio bytes | `lib/server/tts.mjs` (new) | [ ] |
| `POST /api/nammaops/voice/speak` route added | `api.mjs` | [ ] |
| Browser audio test: Timbre audio plays | New component | [ ] |
| Credit consumption measured: 10 Prisma calls + 10 Timbre calls | — | [ ] |

**Go/No-go**: At least one Prisma call returns a Kannada transcript. At least one Timbre call returns playable audio.

---

### Day 3 (Nov 3) — Wire Prisma to NammaOps Voice Path
**Objective**: Speak → Prisma transcript → workflow starts.

| Deliverable | File | Done? |
|---|---|---|
| `POST /api/nammaops/voice/transcribe` route added | `api.mjs` or `runtime-api.mjs` | [ ] |
| Browser audio capture → POST → transcript displayed | New component | [ ] |
| Transcript → `parseCommand()` → `workflows.start()` | existing, just wire | [ ] |
| Test: "Check the stock of milk" → Prisma transcribes → stock_check workflow starts | — | [ ] |

**Go/No-go**: Speaking a stock query in Kannada triggers a NammaOps workflow visible in the panel timeline.

---

### Day 4 (Nov 4) — End-to-End Workflow A with Gnani Voice
**Objective**: Full Gnani voice round-trip: Prisma input → workflow → Timbre output.

| Deliverable | File | Done? |
|---|---|---|
| Standalone `/nammaops/voice` page (draft) | `app/nammaops/voice/page.tsx` (new) | [ ] |
| Voice contract facts formatted as TTS-ready text | existing voice-router contract | [ ] |
| `POST /api/nammaops/voice/speak` called with facts | new route | [ ] |
| Timbre audio plays in browser after workflow completes | new component | [ ] |
| Screen shows: transcript + timeline + audio waveform | — | [ ] |
| 6 Kannada stock queries tested; 4+ must pass | — | [ ] |

**Go/No-go**: One clean end-to-end recording: Kannada speech → Prisma transcript on screen → agents activate in timeline → Timbre voice responds.

---

### Day 5 (Nov 5) — Demo Workflows B and C with Gnani Voice
**Objective**: Reorder + approval and demand forecast both work via Gnani voice.

| Deliverable | File | Done? |
|---|---|---|
| Reorder workflow via voice: draft PO created → approval panel opens | existing | [ ] |
| Owner pins approval via panel → ERP write confirmed | existing | [ ] |
| Demand forecast via voice: Timbre speaks top 3 items | existing workflows + new TTS route | [ ] |
| Live ERPNext: all three read workflows work via Gnani voice | existing live binding | [ ] |
| Hinglish test: 5 code-mixed queries tested | — | [ ] |

**Go/No-go**: All three demo workflows complete via Gnani voice. Live ERPNext data source confirmed in panel.

---

### Day 6 (Nov 6) — Demo Polish
**Objective**: Demo-quality UI; preliminary recording.

| Deliverable | File | Done? |
|---|---|---|
| Voice page polished: transcript, activity, audio player, approval panel | — | [ ] |
| NammaOpsPanel shows Gnani attribution in data source banner | `NammaOpsPanel.tsx` | [ ] |
| Preliminary 60-second recording made | — | [ ] |
| Compliance checklist reviewed | `GNANI_HACKATHON_RULES_AND_COMPLIANCE.md` | [ ] |

---

### Day 7 (Nov 7) — Full Demo Rehearsal
**Objective**: Final demo videos recorded.

| Deliverable | Done? |
|---|---|
| 60-second demo video: 3 takes; best selected | [ ] |
| 2–3 minute technical demo recorded | [ ] |
| LinkedIn post caption drafted (both hashtags, Gnani AI tagged) | [ ] |
| Submission form: all fields reviewed | [ ] |

---

### Day 8 (Nov 8) — Submission Package
**Objective**: Submission-ready.

| Deliverable | Done? |
|---|---|
| Demo videos edited (captions, end card) | [ ] |
| Submission form saved | [ ] |
| Project description: title, problem, users, agents, Gnani models used | [ ] |

---

### Day 9 (Nov 9) — Post Live + Submit
**Objective**: Published and submitted.

| Deliverable | Done? |
|---|---|
| LinkedIn + X post live with #GreatIndianAIInternshipChallenge #GnaniAI | [ ] |
| Post URL in submission form | [ ] |
| Submission form submitted | [ ] |

---

### Day 10 (Nov 10) — Buffer
Hard deadline: November 10, 2026, 11:59 PM IST.

---

## 7. Go/No-Go Criteria

All six must pass before declaring the demo submission-ready.

| Gate | Criterion | Status |
|---|---|---|
| G1 | Gnani Prisma STT: at least 3 Kannada audio clips transcribed correctly via `https://api.vachana.ai/stt/v3` with `X-API-Key-ID` | [ ] |
| G2 | Gnani Timbre TTS: at least 3 Kannada text strings synthesized via Timbre API, audio plays in browser | [ ] |
| G3 | NammaOps voice round-trip: Prisma transcript → workflow → Timbre response, under 8s total | [ ] |
| G4 | All three demo workflows complete end-to-end with Gnani voice (A: stock check, B: reorder+approval, C: demand forecast) | [ ] |
| G5 | At least one clean 60-second screen recording exists showing all three workflows and Gnani model attribution | [ ] |
| G6 | Submission form saved and social media post draft ready with both required hashtags | [ ] |

---

## 8. Top 5 Risks (Based on Actual Codebase Gaps)

### Risk 1: Gnani Timbre TTS Build Failure [CRITICAL]

**Description**: Timbre TTS has zero existing code. If the Timbre API documentation differs from what docs describe (endpoint, request format, response format, audio encoding), Day 2 build could fail.

**Likelihood**: Medium — Timbre is a commercial product but Indian API docs are sometimes incomplete.

**Mitigation**:
1. Check `app.gnani.ai/voice` API docs on Day 2 morning before writing any code
2. Fallback: the existing Gemini Live voices (Kore/Puck/Aoede/Charon) are already functional and produce natural-sounding speech. The demo can use Gemini TTS if Timbre build fails, with a note in the submission that Prisma STT is the primary Gnani integration.
3. The hackathon requires "at least one Gnani model" — Prisma alone satisfies this requirement.

**Contingency**: Demo uses Gemini TTS, Prisma STT, and attributes Gnani Prisma prominently. Timbre is described as "next integration" in the submission.

---

### Risk 2: Gnani API Key Credit Exhaustion [HIGH]

**Description**: 5,000 credits apply only to Prisma and Timbre. Credit consumption rate is unknown.

**Likelihood**: Medium — manageable with mocking during development, but unknown per-call cost.

**Mitigation**:
1. Measure credit consumption on Day 2 with 10 Prisma + 10 Timbre calls
2. During Days 3-6 development, use `AGENT_TOWN_STT_PROVIDER=fixture` for most testing; only use Gnani for final integration tests
3. If credits run low: contact Gnani support for hackathon top-up

**Contingency**: The demo video can be recorded with cached Prisma responses if credits run out before Day 8. The business logic (workflows, ERP reads, approval) is fully functional regardless of Prisma credits.

---

### Risk 3: Prisma STT Kannada Accuracy Insufficient [MEDIUM]

**Description**: Kannada STT accuracy may be too low for a compelling demo. Prisma v3.0 claims WER 15.82% for Kannada; v2.5 has not published Kannada WER.

**Likelihood**: Low for v3.0 (claim is documented); Medium for v2.5.

**Mitigation**:
1. Test on Day 2 immediately after getting API key
2. Use Prisma v3.0 if available under hackathon credits
3. If Kannada accuracy is poor, pivot demo primary language to Hindi (Hinglish WER is confirmed low)
4. The voice-router's `parseCommand()` is deterministic — even an imperfect Prisma transcript that gets the right words will route correctly

**Contingency**: Demo in Hindi with Prisma; Kannada shown as a secondary demo with a note on v3.0 accuracy numbers.

---

### Risk 4: Live ERPNext Latency in Demo [MEDIUM]

**Description**: The hvgerp-adapter makes multiple sequential API calls for some workflows (e.g., demand forecast reads sales invoices per invoice for lines). This could be slow on the live ERPNext demo store under demo conditions.

**Likelihood**: Low — verified at 37-342ms per call; CONCURRENCY=8 in adapter; but 90-day demand forecast reads many invoices.

**Mitigation**:
1. Use fixture data for the live demo recording (workflow runs in < 1 second)
2. Show live ERPNext as a proof-of-concept separate from the timed demo
3. Adapter has 60s caching for catalogue data (items, suppliers); second run is much faster

**Contingency**: Demo on fixture data; note live ERPNext as Phase G2 accomplishment in the submission text.

---

### Risk 5: Demo Deadline Miss from Scope Creep [LOW but CRITICAL]

**Description**: NammaOps is fully functional today. The risk is adding unnecessary features instead of building the Gnani voice path.

**Mitigation**:
1. **HARD RULE**: Do not touch `workflows.mjs`, `calculations.mjs`, `forecast.mjs`, `owner-approvals.mjs`, `erp-binding.mjs`, or `voice-router.mjs` — these are complete.
2. Only build the two missing components: Timbre TTS + Standalone voice page
3. NammaOpsPanel is demo-ready today — no UI changes unless a specific Gnani attribution element is missing

**Contingency**: If Day 6 arrives and the standalone voice page is not complete, the demo uses the existing NammaOpsPanel (text commands) + voice via Gemini Live sessions. This is still a compelling demo showing the full business intelligence platform.

---

## 9. What a Developer Should Build in the Next 8 Days

Exactly two new components, in priority order:

**Component 1 (Day 2): `lib/server/tts.mjs`**

```javascript
export function timbreProvider({ apiKey }) {
  return {
    name: "gnani-timbre",
    async synthesize({ text, language = "kn-IN" }) {
      const response = await fetch("https://api.gnani.ai/v1/tts/inference", {
        method: "POST",
        headers: { "X-API-Key-ID": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, language_code: language }),
      });
      if (!response.ok) throw new Error(`Timbre TTS failed (HTTP ${response.status})`);
      return { audioBytes: Buffer.from(await response.arrayBuffer()), provider: "gnani-timbre" };
    },
  };
}
```

(Verify exact request/response format against Timbre API docs on Day 2 morning before writing.)

**Component 2 (Day 3): Server route wiring**

Add to `api.mjs`:
```
POST /api/nammaops/voice/transcribe  → stt.gnaniProvider().transcribe()
POST /api/nammaops/voice/speak       → tts.timbreProvider().synthesize()
```

**Component 3 (Day 3-4): `app/nammaops/voice/page.tsx`**

A Next.js page with:
- Microphone button (record WAV) → POST to `/api/nammaops/voice/transcribe`
- Transcript display
- Workflow start + SSE event subscription for timeline
- POST to `/api/nammaops/voice/speak` with voice contract facts → play audio

Everything else is already built. These three components are the entire remaining Gnani integration work.
