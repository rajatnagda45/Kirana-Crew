# NammaOps — Hackathon Strategy

## Great Indian AI Internship Challenge 2026

> **NammaOps**: AI Workforce for Kirana Stores
> **UPDATED Nov 2, 2026** — Revised to reflect actual codebase (82 new files merged Nov 2).
> Status labels: [VERIFIED], [INFERRED], [UNVERIFIED ASSUMPTION]
> Every section updated for what is built vs. what remains.

---

## 1. Product Vision and Tagline

**Vision**: Give every kirana store owner an AI workforce that speaks their language, never sleeps, and handles the operational grind — so they can focus on customers.

**Tagline**: _"Namma AI, Namma Bhasha, Namma Dukan"_ — Our AI, Our Language, Our Shop.

**One-sentence pitch**: NammaOps is a voice-first AI platform that puts five AI specialists to work for any kirana store owner — just speak in Kannada, Hindi, or Hinglish, and your stock gets checked, orders get drafted with your approval, and your daily books get summarized.

**What makes this real, not a demo**:

- Voice input → Gnani Prisma STT → real transcript (`gnaniProvider()` in `stt.mjs` — [IMPLEMENTED])
- Real multi-agent orchestration: five specialist agents, each with only the ERP permissions they need
- Real business calculations: inventory reorder formulas, 90-day demand forecast with backtesting, ranked supplier comparison
- Human-in-the-loop approval: PIN-gated, cryptographically fingerprinted — AI cannot submit orders without owner sign-off
- Voice output → Gnani Timbre TTS (to be built Day 2) → audio back to owner in Kannada/Hindi
- Full audit trail: every AI ERP call logged under the agent's identity, governance-enforced

---

## 2. Unique Technical Differentiators

### 2.1 MCP Governance as a Novel Architecture

The single most technically distinctive thing about NammaOps that no other hackathon project will likely have: **Phase C MCP tool governance**.

Every ERP call in NammaOps is:

1. Registered as a named capability (e.g., `erp.stock.balance`)
2. Reviewed by a human developer with a risk score
3. Granted specifically to one agent identity (not all agents)
4. Invoked only under that agent's identity
5. Logged to an audit record with decision, outcome, and invocation status

This means: the inventory agent cannot accidentally call finance tools. The procurement agent cannot call the submission tool unless it has been explicitly granted. The owner approval principal (`nammaops-po-submit`) has access to exactly two tools: get PO and submit PO — nothing else.

This is production-grade AI governance, not a hackathon prototype. It directly demonstrates that NammaOps is safe to connect to a real store's ERP.

### 2.2 Deterministic Business Intelligence

All NammaOps business calculations are deterministic — no LLM required for:

- Stock analysis (reorder level, recommended quantity)
- Supplier ranking (by rate, lead time, on-time performance)
- Demand forecasting (4 statistical methods, WAPE backtesting)
- Daily business report (revenue totals, top products, P&L)

**Why this matters for the demo**: The agent cannot hallucinate a stock number. If Gnani Prisma transcribes "how much milk do we have?", the answer comes from a governed ERP tool call, not from the model's memory. Every number on screen is sourced from a real data call with a logged trace.

### 2.3 Live ERPNext Integration (Not Just a Mock)

As of Nov 2, 2026 (Phase G2 verified in `docs/phase-g1-hvgerp-discovery.md`):

- 36 real items verified live
- 35 real stock bins read live
- 479 real sales invoices processed
- P&L reconciles with raw GL
- 64 governed reads logged; 0 writes made

No other hackathon project is likely running against a real ERPNext Cloud instance with verified live data.

### 2.4 Developer Mode (McpGovernancePanel)

The McpGovernancePanel is a full governance UI that lets a developer:

- Register MCP servers
- Review capabilities with risk levels
- Assign capabilities to agent identities
- Approve EXTERNAL_ACTION risk tools one by one
- Watch the audit log in real time

This is novel for the hackathon context: the "AI configuration" itself is transparent and editable, not a black box. A judge watching the governance panel sees every tool call and every grant decision.

---

## 3. Competitive Landscape Analysis

### 3.1 Existing Kirana Software: What They Do, What They Don't

**Khatabook**

- What it does: Digital ledger (udhar/credit tracking), basic invoicing, payment reminders, low-stock alerts, basic inventory
- What it does NOT do: No voice input, no autonomous AI agents, no supplier management, no predictive ordering, no vernacular voice interface
- Price: Free basic; paid tiers available
- Gap NammaOps fills: Voice-first interaction; autonomous agent execution (not just recording)

**Vyapar**

- What it does: Comprehensive billing, real-time stock tracking, barcode scanning, multi-warehouse, batch/expiry tracking, GST compliance, WhatsApp invoicing
- What it does NOT do: No voice interface, no autonomous ordering, no AI forecasting, no Kannada/Hindi voice commands
- Price: Free Android basic; ₹1,249–₹6,999/year for premium
- Gap NammaOps fills: Voice-first; autonomous execution; AI agents that act, not just report

**GoFrugal**

- What it does: Full POS, grocery-specific features, barcode/weighing scale integration, stock management, expiry tracking, multi-store, cloud-hosted, GST compliance
- What it does NOT do: No voice AI, no autonomous agents, no Indian vernacular interface beyond English/basic Hindi UI
- Gap NammaOps fills: Voice-first; affordable; AI agents for small stores

### 3.2 Voice AI in Indian Market

**Sarvam AI (Saaras STT + Bulbul TTS)**:

- Strong Indian language voice models (22+ languages)
- Platform-level: not packaged as a kirana store solution
- No kirana-specific application layer

**KiranaPro**:

- Consumer ordering app via ONDC, not store management
- Does not manage inventory or supplier relations internally

**None of the identified competitors combine**:

1. Voice-first in Kannada/Hindi/Hinglish via Gnani Prisma
2. Autonomous multi-agent execution (not just recording or alerting)
3. Store management focus (inventory + orders + supplier + accounts)
4. Audited governance: every ERP call logged with agent identity and decision

---

## 4. Award-by-Award Analysis

### Award 1: Real Deal Award — Most Useful Real-World Solution

**What it rewards**: [VERIFIED] Most useful solution for farmers, kirana stores, or rural healthcare. Kirana stores are named explicitly.

**How NammaOps qualifies** (all [IMPLEMENTED]):

- Five deterministic workflows: stock check, demand forecast, supplier comparison, daily report, prepare reorder
- All five workflows run against real ERPNext data (live read-only)
- Owner approval with PIN — AI cannot place orders without human authorization
- Gnani Prisma STT in Kannada/Hindi (`gnaniProvider()` coded, needs API key)
- Timbre TTS to be added Day 2 — Kannada voice output

**Quantifiable impact to mention**:

- Saves 1–2 hours/day of manual stock checking and supplier calling
- 90-day demand forecast with stockout censoring reduces overstocking and stockout risk
- Every ERP access logged — owner can audit AI actions

**Competitiveness**: VERY HIGH
**Status**: PRIMARY TARGET

---

### Award 2: Main Character Award — Best Regional Language Project

**What it rewards**: [VERIFIED] Best project in a regional/low-resource Indian language

**How NammaOps qualifies**:

- Kannada is the primary regional language target (low-resource relative to Hindi)
- Gnani Prisma STT with `language_code: "kn-IN"` — implemented in `stt.mjs`
- Timbre TTS with `language_code: "kn-IN"` — to be built Day 2
- All five workflow results shaped into Kannada-suitable `speak_rule` voice contracts
- Product name resolution includes Kannada aliases (`resolveProducts()` in `calculations.mjs`)
- Fixture data includes Indian grocery products (Toor Dal, Toned Milk, Sunflower Oil)

**What still needs to happen**:

- Build Timbre TTS (Day 2)
- Demo 6+ Kannada audio queries with successful transcription
- Test Kannada product name vocabulary (ಹಾಲು, ಅಕ್ಕಿ, ಎಣ್ಣೆ)

**Competitiveness**: HIGH
**Status**: PRIMARY TARGET (alongside Real Deal)

---

### Award 3: Mixed Vibes Award — Best Code-Mixed Voice Application

**What it rewards**: [VERIFIED] Best code-mixed speech application (Hinglish, Tanglish, Benglish)

**How NammaOps qualifies**:

- Prisma STT explicitly supports Hinglish; `indic-auto` language hint for auto-detection
- `parseCommand()` in `workflows.mjs` is language-agnostic (works on any transcript)
- Voice contracts have `speak_rule` that prevents hallucination even on mixed-language input
- Kirana speech is naturally code-mixed: "Stock check karo milk ka", "ek kilo atta hai kya"

**What needs to be done** (Day 5-6):

- Test 5+ Hinglish queries through Prisma → parseCommand → workflow
- Test Kanglish queries (Kannada-English mix)
- Document accuracy in submission

**Competitiveness**: HIGH (secondary to Real Deal + Main Character)
**Status**: SECONDARY TARGET

---

### Award 4: Demo Day Drop Award — Best 60-Second Video

**What it rewards**: [VERIFIED] Best 60-second demo video

**Why NammaOps has a compelling 60-second story**:

- The NammaOpsPanel visually shows five agents activating in sequence (timeline)
- The MCPGovernancePanel shows tool governance in real time
- Gnani Prisma: visible transcript on screen
- Timbre TTS: visible waveform + audio plays
- Real business outcome: "Draft PO created. PIN approved. Submitted."

**Script** (60 seconds): See Section 9 below.

**Competitiveness**: HIGH
**Status**: SECONDARY TARGET

---

### Award 5: Noise Canceller Award — Best Noisy Audio Performance

**What it rewards**: [VERIFIED] Best performance on messy telephonic audio

**How NammaOps qualifies**: Prisma v3.0 is trained on 8kHz telephony audio; kirana stores have natural background noise.

**What needs to be done** (Day 6 if time):

- Record a query with background market noise (fan, customer voices, radio)
- Show Prisma transcript is still correct

**Competitiveness**: MEDIUM — requires deliberate effort
**Status**: TERTIARY (if time permits on Day 6)

---

### Award 6: Jugaad Genius Award — Most Creative/Unexpected Usage

**How NammaOps qualifies**:

- Five AI specialists acting as a "workforce" for a kirana owner is a creative metaphor
- The governance-by-identity pattern (each agent has its own ERP credentials) is technically unusual
- The demand forecast applies stockout censoring — a statistical insight adapted for a kirana context
- The owner approval uses SHA-256 fingerprinting to prevent AI from submitting a different PO than the one shown

**Competitiveness**: MEDIUM
**Status**: TERTIARY

---

## 5. Primary Award Target and Reasoning

### PRIMARY: Real Deal Award + Main Character Award (dual-target strategy)

**Real Deal Award** is the clearest match: NammaOps is literally a kirana store solution (the award names kirana stores [VERIFIED]). The application is functionally complete for all five workflows on live ERPNext data. This is not a prototype — it is a production-grade system.

**Main Character Award** is the second strongest: primary language is Kannada (kn-IN). The Gnani Prisma STT provider is implemented. Timbre TTS is being built Day 2. The voice round-trip in Kannada will be complete by Day 4.

**Why target both simultaneously**: Real Deal rewards practical kirana utility; Main Character rewards regional language depth. Both are served by the same core codebase with the same Gnani integration work.

---

## 6. Secondary Award Opportunities

In priority order:

1. **Demo Day Drop Award**: A polished 60-second video is necessary for submission anyway; invest in production quality. Script is in Section 9.
2. **Mixed Vibes Award**: Extend the voice demo to include Hinglish/Kanglish scenarios on Day 5-6 — limited additional work.
3. **Crowd Favourite Award**: If organic social engagement is strong (kirana AI story resonates broadly with Indian startup community), this is achievable.
4. **Noise Canceller Award**: Test with background noise on Day 6 if time. Prisma's telephony training makes this likely to succeed.

---

## 7. What Genuinely Strengthens This Submission

In order of impact, based on the actual codebase:

1. **Live ERPNext data** (Phase G2 verified): "This is not fixture data — this is a real ERPNext Cloud instance with 36 items, 35 bins, and 479 invoices." No competing hackathon project will likely have a live ERP integration.

2. **MCP governance**: Every ERP call is audited, under a named agent identity, with risk review before granting. Show the McpGovernancePanel in the video. This is production thinking, not a hackathon prototype.

3. **Deterministic forecasting**: The demand forecast engine uses stockout censoring and WAPE backtesting — real statistical techniques adapted for kirana inventory. Mention the formula explicitly: `reorder = max(0, lead_time_demand + safety_stock − available − incoming)`.

4. **Human-in-the-loop approval**: The AI cannot submit a purchase order. The owner reviews, pins, and approves. The system re-verifies the draft before submission. SHA-256 fingerprint prevents AI from submitting a different PO.

5. **Gnani Prisma + Timbre round-trip**: Show both on screen simultaneously — transcript appearing while Timbre waveform plays. This is the "money shot" for judges.

6. **Audit trail**: The governance panel shows every invocation. Zero denials. Every read attributable to a named agent. "The kirana owner can audit every AI action."

---

## 8. Internship Shortlisting Strategy

The shortlisting process is: engagement verification → eligibility check → interview. [VERIFIED]

**Technical depth for the interview**:

- Know exactly how `gnaniProvider()` works (`stt.mjs` — REST POST to `https://api.vachana.ai/stt/v3`, `X-API-Key-ID` auth, multipart/form-data audio)
- Know what `timbreProvider()` does (to be built on Day 2)
- Know the MCP governance state machine: discover → register → assign → grant → invoke → audit
- Know the demand forecast formula and why stockout censoring matters
- Know the owner approval flow: fingerprint → PIN → re-verify → submit

**What to say about Evon**:
"Evon v3.3 is self-hosted only (open weights on HuggingFace, requires H100). We opted for deterministic business logic instead of LLM reasoning for the business calculations — this gives us reproducible, auditable results. The Manager reasoning turn is an optional LLM summary of deterministic outputs; for the hackathon we use Gemini Flash as the reasoning model, which is within the competition's rules (only one Gnani model is required)."

**Individual interview prep** (for each team member):

- Be able to explain every technical decision in the codebase
- Understand Indian kirana market context (13 million stores, typical owner profile, pain points)
- Have a clear vision for how NammaOps extends post-hackathon (multi-store, GST integration, WhatsApp interface)
- Understand voice AI architectures, Indian language challenges, and deployment constraints

---

## 9. Demo Day (60-Second) Strategy

**The narrative arc in 60 seconds**:

**[0:00–0:08]** Title card: "India has 13 million kirana stores. Ramesh manages stock and supplier orders manually. NammaOps gives him a five-agent AI workforce."

**[0:08–0:18]** NammaOpsPanel: five agents visible (Manager, Inventory, Sales, Procurement, Finance). Data source banner: "Live ERPNext (demo store)." Owner speaks Kannada into microphone — Gnani Prisma transcript appears: "Haalindu stock enu aagide?"

**[0:18–0:32]** Timeline activates: INVENTORY_TASK_STARTED → INVENTORY_TASK_COMPLETED → PROCUREMENT_TASK_STARTED → PROCUREMENT_TASK_COMPLETED. Results appear: "Toned Milk 500ml: 18 left — LOW (reorder at 40). Sunflower Oil 1L: 8 left — LOW."

**[0:32–0:44]** Owner speaks: "Prepare an order for the running-low products." Procurement agent creates draft POs. NammaOpsPanel shows Purchase Approval section: draft PO with line items, total ₹2,450. Owner enters PIN → Approve. "Owner approved. Submitted to ERP."

**[0:44–0:54]** Gnani Timbre responds in Kannada (waveform visible): "Eradu vaste kademedhe ide. Purchase order submit aagide." (Two items are running low. Purchase order submitted.)

**[0:54–0:60]** McpGovernancePanel: 14 invocations logged, all as named agents, none denied. End card: "#GreatIndianAIInternshipChallenge #GnaniAI — Powered by Gnani Prisma + Timbre"

**Key visual moments**:

- Prisma transcript visible on screen (not just audio)
- Agent timeline ticking through steps
- Purchase approval with PIN entry
- Timbre waveform playing
- Governance audit log showing zero denials

---

## 10. Public Engagement Strategy (Legitimate, Verifiable, Authentic)

[All tactics are compliant with competition rules as verified at gnani.ai/internship]

**Nov 2–3 (Day 2-3): Teaser**

- Post a "building in public" LinkedIn post: problem statement only ("India's 13 million kirana stores run on paper ledgers and phone calls — I'm building something about this"). No demo yet.
- Use #GnaniAI hashtag from the start to establish timeline
- Do NOT ask for engagement; let it come organically

**Nov 4–5 (Day 4-5): First demo snippet**

- 15-second clip: Kannada voice input → Prisma transcript → workflow starts
- Caption in Hindi/English: "Bolo, AI samjhega. Kirana store ka AI workforce."
- Technical thread (separate post): explain one interesting technical choice (MCP governance, stockout censoring in forecast)

**Nov 7-8 (Day 7-8): Full demo post**

- LinkedIn + X: post the 60-second demo video
- Include both required hashtags: #GreatIndianAIInternshipChallenge and #GnaniAI
- Tag Gnani AI
- Include a caption that explains the kirana story emotionally: "Ramesh bhai ka stock kab khatam hoga — AI ne kal raat hi bata diya"
- Respond to every comment within the first 24 hours (engagement signal)

**Post-submission**:

- Respond to all comments
- Share any reposts or tags

**Content tonality**: Authentic, specific, technically credible. Mention actual WER numbers, actual latency measurements, actual kirana store use cases tested. Generic "proud to present" language reduces credibility with technical judges.
