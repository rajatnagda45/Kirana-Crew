# KiranaCrew — MVP and Demo Plan (REVISED Nov 2, 2026)

> **Based on actual codebase, not proposals.**
> All features marked [IMPLEMENTED], [NEEDS GNANI INTEGRATION], or [NOT BUILT].
> Deadline: November 10, 2026, 11:59 PM IST — 8 days remaining.

---

## 1. What Is Already Functional (Can Demo Today)

All five workflows run end-to-end against the fixture and live ERPNext. The demo script `scripts/nammaops-demo.mjs` proves this without needing a browser.

| Workflow                         | Status        | Data source                               |
| -------------------------------- | ------------- | ----------------------------------------- |
| Stock check (text command)       | [IMPLEMENTED] | Fixture + Live ERPNext                    |
| Demand forecast (90-day history) | [IMPLEMENTED] | Fixture + Live ERPNext                    |
| Supplier comparison              | [IMPLEMENTED] | Fixture + Live ERPNext                    |
| Daily business report            | [IMPLEMENTED] | Fixture + Live ERPNext                    |
| Prepare reorder + owner approval | [IMPLEMENTED] | Fixture only (PO drafts disabled on live) |

Voice routing through Gemini Live sessions is also fully functional — Alice/Bob/Carol/Dave can answer business questions via voice using Gemini's built-in STT/TTS.

**The only missing Gnani integration is:**

1. Replacing Gemini's STT with Gnani Prisma (code is written — needs API key + routing)
2. Adding Gnani Timbre TTS (code does not exist — must be built)

---

## 2. What Needs Gnani Integration to Be Complete

| Component           | Current state                  | Gap to close                                                                                                                                                 |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| STT                 | Gemini Live built-in           | Add a standalone audio-capture → Gnani Prisma → transcript path. `gnaniProvider()` in `stt.mjs` is ready — needs API key and a browser→server audio pipeline |
| TTS                 | Gemini Live voices (Kore etc.) | Build `tts.mjs` with Timbre provider + server proxy route + browser audio player                                                                             |
| Combined voice page | Exists via Gemini Live session | Create `/nammaops/voice` standalone page that uses Prisma for input and Timbre for output                                                                    |

Estimated effort: 2 days for both gaps (Day 2-3 of schedule).

---

## 3. What Is Genuinely Incomplete

| Feature                               | Status         | Notes                                                                                                                                  |
| ------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Gnani Timbre TTS                      | [NOT BUILT]    | Zero code exists. Must build from scratch.                                                                                             |
| Standalone Gnani voice page           | [NOT BUILT]    | Needs Timbre TTS first.                                                                                                                |
| Live ERPNext PO drafting + submission | [FIXTURE ONLY] | The adapter code is ready; the live binding has drafts disabled by design. Enabling would take 1 day but is not needed for the demo.   |
| Gnani Evon LLM reasoning              | [NOT BUILT]    | Evon is not on the API platform (self-hosted only). The Manager reasoning turn uses OpenClaw; fallback is GPT-4o-mini or Gemini Flash. |

---

## 4. MUST DEMO Items (Already Functional)

These three workflows run today with zero additional code. They are the backbone of the hackathon demo.

### Demo Workflow 1: Voice Stock Check [IMPLEMENTED — add Gnani for full credit]

Owner speaks: "Check the stock of milk, rice and cooking oil. Tell me what we need to buy tomorrow."

**What happens** (in the fixture demo):

1. `parseCommand()` extracts intent `stock_check` with products `["milk", "rice", "cooking oil"]`
2. Inventory agent reads items + stock balances (2 ERP calls)
3. `analyseStock()` computes which items are below reorder level
4. Procurement agent ranks suppliers for low-stock items (2 ERP calls)
5. Manager agent summarizes: "2 item(s) to buy tomorrow: Toned Milk 500ml (18 left, reorder at 40, buy 62); Sunflower Oil 1L (8 left, reorder at 15, buy 22)."

**Why compelling for judges**: Shows governed multi-agent execution, evidence chain, deterministic facts.

### Demo Workflow 2: Prepare Reorder with Owner Approval [IMPLEMENTED]

Owner speaks: "Prepare an order for the products that are running low. Choose the cheapest suitable supplier."

**What happens**:

1. Inventory reads stock; finds low items
2. Procurement ranks suppliers (using `rankSuppliers()`) and creates draft POs in ERP
3. Owner sees draft in KiranaCrewPanel: "PUR-ORD-FX-0001 from Supplier X, total ₹2,450"
4. Owner enters PIN → clicks Approve
5. System re-reads PO from ERP, verifies fingerprint, submits
6. Timeline shows: PURCHASE_ORDER_SUBMITTED

**Why compelling for judges**: Human-in-the-loop approval with cryptographic integrity, real ERP write only after PIN.

### Demo Workflow 3: Demand Forecast [IMPLEMENTED]

Owner speaks: "What will sell next week and what should I order?"

**What happens**:

1. Sales agent reads 90-day history in 7-day slices
2. Inventory reads current stock + 90-day ledger (for stockout censoring)
3. Procurement reads open POs + supplier quotations
4. `forecastItem()` runs for each product: selects best forecasting method via backtesting (WAPE)
5. Result: "Historical-demand forecast for the next 7 days: Toned Milk 500ml ~48, Sona Masoori Rice ~14, Sunflower Oil ~12. Suggested purchases: Toned Milk 500ml 62 (high risk); ..."

**Why compelling for judges**: Shows real statistical forecasting with stockout censoring, backtesting, safety stock — all deterministic and explainable.

---

## 5. 60-Second Demo Script (Based on What Is Actually Built)

**Tool**: The KiranaCrewPanel HUD or the standalone demo script.

**[0:00–0:08]** Title card: "India has 13 million kirana stores. Ramesh manages Namma Kirana manually. KiranaCrew gives him a five-agent AI workforce."

**[0:08–0:18]** Screen shows KiranaCrewPanel. Five agents are listed (Manager, Inventory, Sales, Procurement, Finance) each with their seat, permitted tools, and status "idle". Data source shows "test fixture" or "live ERPNext".

**[0:18–0:30]** Owner types (or speaks via Alice/Bob/Carol/Dave voice session): "Check the stock of milk, rice and cooking oil. Tell me what we need to buy tomorrow." Timeline shows: WORKFLOW_STARTED → INVENTORY_TASK_STARTED → INVENTORY_TASK_COMPLETED → PROCUREMENT_TASK_STARTED → PROCUREMENT_TASK_COMPLETED → WORKFLOW_COMPLETED. Inventory table appears: Milk 18/40 LOW, Rice 6/10 LOW, Oil 8/15 LOW.

**[0:30–0:42]** Switch to "Prepare an order for the products running low." Procurement agent creates draft POs. KiranaCrewPanel shows Purchase Approval section: PO with line items, total, PIN entry. Owner enters PIN → Approve → "Owner approved; submitted to ERP."

**[0:42–0:52]** (Optional if Gnani API key is available) Open the voice tab. Speak: "What will sell next week?" Alice answers with demand forecast numbers — facts only from the workflow result.

**[0:52–0:58]** Show audit: governance panel with 12 invocations logged, all as inventory agent or procurement agent, none denied. "Zero unreviewed tool calls."

**[0:58–0:60]** End card: "KiranaCrew — Built on KiranaCrew. Powered by Gnani Prisma + Timbre + KiranaCrew MCP governance. #GreatIndianAIInternshipChallenge #GnaniAI"

---

## 6. 2–3 Minute Technical Demo Script

**[0:00–0:20] Problem**
"India has 13 million kirana stores. Ramesh manages stock, suppliers, and accounts manually with ledgers. KiranaCrew gives him five AI specialists that speak his language and never touch his ERP without his approval."

**[0:20–0:45] Architecture**
Show architecture diagram. "KiranaCrew uses Gnani Prisma for voice input in Kannada and Hindi. Workflows run five specialist agents — each with exactly the ERP permissions they need, verified through Phase C MCP governance. All calculations are deterministic — no hallucinated inventory numbers. Results are delivered back in the owner's language via Gnani Timbre TTS."

**[0:45–1:20] Demo: Stock Check → Reorder → Approval**
Live demo of the three core workflows in the KiranaCrewPanel. Show the timeline ticking through agent steps. Show the approval flow with PIN entry. "Notice: the AI created the draft PO; the owner's PIN is the gate. The AI cannot submit to ERPNext without explicit human approval of the unchanged draft."

**[1:20–1:50] Voice Demo (if Gnani key available)**
"Alice speaks for the Manager department. She answers using only the facts the workflow returned — not from her own knowledge." Demonstrate voice query: "Bob, how much milk do we have?" Bob answers with the exact number from the stock workflow.

**[1:50–2:15] Demand Forecast Intelligence**
"The forecast is based on 90 days of real sales history. Stockout days are excluded — zero sales during a stockout is missing demand, not zero demand. The best forecasting method is selected by backtesting on the last 14 days. The reorder formula is: lead-time demand plus safety stock, minus what's in stock and incoming."

**[2:15–2:30] Audit + Governance**
Show McpGovernancePanel. "Every ERP call is logged with the agent identity, capability ID, decision (ALLOW/DENY), and invocation status. The inventory agent cannot call procurement tools. The procurement agent cannot call finance tools. This is enforced in code, not in prompts."

**[2:30–2:45] Data Source**
"Toggle to live ERPNext: same workflows, same code path, now reading from a real ERPNext Cloud instance. 36 items, 35 stock bins, 479 invoices verified." Show the data-source banner change in the panel.

**[2:45–3:00] Close**
"Three agent patterns that solve real kirana store problems: stock intelligence, demand forecasting, and supplier governance. Built on production-grade KiranaCrew orchestration. Built for the Great Indian AI Internship Challenge 2026."

---

## 7. Day-by-Day Implementation Schedule (Nov 2–10)

### Day 2 (Nov 2): Gnani API First Call

**Objective**: Make the first live Gnani Prisma STT call and the first Timbre TTS call. Confirm API key works, measure latency and credit consumption.

**Deliverables**:

- [ ] `GNANI_API_KEY` obtained from app.gnani.ai/voice
- [ ] `AGENT_TOWN_STT_PROVIDER=gnani` set; `stt.mjs` `gnaniProvider()` tested with a WAV file
- [ ] Credit consumption measured: 10 Prisma calls, note credit delta
- [ ] Build `lib/server/tts.mjs` with `timbreProvider()` (REST POST to `https://api.gnani.ai/v1/tts/inference`, `X-API-Key-ID` auth)
- [ ] Test Timbre: 5 Kannada text strings synthesized and played in browser
- [ ] Note: the KiranaCrew workflows and voice router are already complete — zero changes to business logic needed

**Go/No-go**: Both Prisma and Timbre make at least one successful call with `X-API-Key-ID` auth.

---

### Day 3 (Nov 3): Standalone Gnani Voice Page

**Objective**: A working `/nammaops/voice` page that uses Prisma for input and Timbre for output, separate from the existing Gemini Live voice path.

**Deliverables**:

- [ ] Browser audio capture → server `POST /api/nammaops/voice/transcribe` → Prisma STT → transcript displayed
- [ ] Transcript → KiranaCrew `parseCommand()` → workflow start → wait → voice contract
- [ ] Voice contract facts → server `POST /api/nammaops/voice/speak` → Timbre TTS → audio bytes
- [ ] Audio bytes → browser audio element → plays Kannada/Hindi response
- [ ] Test: "Check the stock of milk" spoken → Prisma transcribes → workflow runs → Timbre responds
- [ ] Language hint from browser: `kn-IN` for Kannada, `hi-IN` for Hindi

**Go/No-go**: Full round-trip: speak → Prisma transcript visible on screen → Timbre response audio plays. Under 6 seconds total.

---

### Day 4 (Nov 4): End-to-End Demo Workflow 1 with Gnani Voice

**Objective**: Complete stock check workflow via Gnani voice, demo quality.

**Deliverables**:

- [ ] Kannada audio: "Haalindu stock enu aagide?" transcribed correctly by Prisma
- [ ] Workflow runs against live ERPNext data
- [ ] Timbre responds in Kannada with stock facts from workflow result
- [ ] Hindi equivalent tested: "Doodh ka stock kitna hai?"
- [ ] Screen recording: transcript visible, agent activity visible in timeline, Timbre audio plays

**Go/No-go**: At least 4 of 6 Kannada stock queries transcribed and answered correctly.

---

### Day 5 (Nov 5): Demo Workflow 2 and 3 with Gnani Voice

**Objective**: Prepare reorder (with owner approval) and demand forecast both work via Gnani voice.

**Deliverables**:

- [ ] Reorder workflow: Prisma transcribes "Prepare an order for the running-low products" → draft PO created → owner approves via PIN in UI → ERP write confirmed
- [ ] Demand forecast: Prisma transcribes "What will sell next week?" → 90-day forecast runs → Timbre speaks top 3 items with forecast numbers
- [ ] Live ERPNext: all three read workflows work against live data with Gnani voice

**Go/No-go**: All three MUST DEMO workflows complete end-to-end with Gnani Prisma input and Timbre TTS output.

---

### Day 6 (Nov 6): Demo Polish + Hinglish Testing

**Objective**: Demo-quality UI and code-mixed language validation.

**Deliverables**:

- [ ] KiranaCrew voice page polished: transcript display, agent activity animation, Timbre waveform, approval panel
- [ ] Hinglish test: "Kya kya order karna hai check karo" — Prisma transcribes; workflow identifies prepare_reorder intent
- [ ] Test 5 Hinglish code-mixed queries; note Prisma accuracy
- [ ] Record preliminary demo video (can use for submission if Days 7-8 don't produce better)
- [ ] Compliance checklist checked: hashtags, Gnani model attribution, required fields

**Go/No-go**: At least one clean screen recording of all three workflows exists.

---

### Day 7 (Nov 7): Full Demo Rehearsal

**Objective**: Final demo video recorded.

**Deliverables**:

- [ ] 60-second demo video: 3 clean takes; best take selected
- [ ] 2–3 minute technical demo video recorded
- [ ] All 5 test scenarios from each workflow passing on live data
- [ ] LinkedIn post draft written (caption, hashtags, tagging Gnani AI)
- [ ] Submission form fields reviewed; all required items confirmed

**Go/No-go**: At least one clean 60-second recording exists. Submission form is 80% filled.

---

### Day 8 (Nov 8): Submission Preparation

**Objective**: Submission-ready package.

**Deliverables**:

- [ ] Demo videos edited: captions, end card with hashtags, background music
- [ ] Submission form completed and saved (can be updated until Nov 10)
- [ ] Project description written: title, problem, users, agents, Gnani model usage
- [ ] Compliance review: GNANI_HACKATHON_RULES_AND_COMPLIANCE.md reviewed line by line

**Go/No-go**: Submission form is saved. Post caption is ready to publish.

---

### Day 9 (Nov 9): Post Live + Submit

**Objective**: Post published; submission submitted.

**Deliverables**:

- [ ] LinkedIn + X post published with #GreatIndianAIInternshipChallenge and #GnaniAI, Gnani AI tagged
- [ ] Post URL captured and entered in submission form
- [ ] Submission form finalized and submitted
- [ ] Full pipeline tested one final time on live data

**Go/No-go**: Submission form submitted. Post URL is in the form. Buffer of 24+ hours maintained.

---

### Day 10 (Nov 10): Buffer

**Objective**: Monitor; fix any last-minute issues.

**Deliverables**:

- [ ] Submission confirmation email received and retained
- [ ] Monitor social engagement; respond to comments
- [ ] Hard deadline: November 10, 2026, 11:59 PM IST

---

## 8. Prioritized Feature List

| Feature                                    | Priority       | Status                    | Notes                                                       |
| ------------------------------------------ | -------------- | ------------------------- | ----------------------------------------------------------- |
| Gnani Prisma STT wired to KiranaCrew voice | MUST           | [NEEDS GNANI INTEGRATION] | `gnaniProvider()` coded; needs routing                      |
| Gnani Timbre TTS                           | MUST           | [NOT BUILT]               | Build `tts.mjs` on Day 2                                    |
| Standalone Gnani voice page                | MUST           | [NOT BUILT]               | Needed for Gnani demo                                       |
| All five workflows (fixture)               | DONE           | [IMPLEMENTED]             | Demo-ready today                                            |
| All five read workflows (live ERPNext)     | DONE           | [IMPLEMENTED]             | Demo-ready today                                            |
| Owner approval (fixture)                   | DONE           | [IMPLEMENTED]             | Demo-ready today                                            |
| KiranaCrewPanel HUD                        | DONE           | [IMPLEMENTED]             | Demo-ready today                                            |
| McpGovernancePanel HUD                     | DONE           | [IMPLEMENTED]             | Demo-ready today                                            |
| Kannada voice input via Gnani              | MUST           | [NEEDS GNANI INTEGRATION] | Day 3-4                                                     |
| Hindi/Hinglish voice input                 | SHOULD         | [NEEDS GNANI INTEGRATION] | Day 5-6                                                     |
| Evon LLM reasoning                         | CONDITIONAL    | [NOT BUILT]               | Use GPT-4o-mini / Gemini Flash fallback if H100 unavailable |
| Live ERPNext PO drafts                     | NICE           | [FIXTURE ONLY]            | Not needed for demo                                         |
| Multi-store / multi-tenant                 | POST-HACKATHON | —                         | Out of scope                                                |
