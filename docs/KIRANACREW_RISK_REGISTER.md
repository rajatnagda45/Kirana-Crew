# NammaOps — Risk and Compliance Register

## Great Indian AI Internship Challenge 2026

> **UPDATED Nov 2, 2026** — Risk register revised to reflect the actual codebase (82 new files, Nov 2 merge).
> Risk classification: Likelihood (H/M/L), Impact (H/M/L)
> Every risk description is sourced from the codebase, not assumed.

---

## 1. Technical Risks

### T1: Gnani Prisma STT Needs Route Wiring [NEW CRITICAL RISK]

| Field                  | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | `gnaniProvider()` in `lib/server/stt.mjs` is fully implemented — REST POST to `https://api.vachana.ai/stt/v3`, `X-API-Key-ID` auth, 60s timeout, multipart/form-data audio. However, the current NammaOps voice path runs through Gemini Live's built-in STT (audio goes directly to Google, not to Gnani). There is no server route that accepts audio bytes and calls `gnaniProvider()`. Without this routing, Gnani Prisma is not used in the NammaOps voice path. |
| **Likelihood**         | CONFIRMED — this routing does not exist yet                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Impact**             | H — Without it, the core Gnani demo claim ("voice in Kannada via Gnani Prisma") cannot be demonstrated                                                                                                                                                                                                                                                                                                                                                                |
| **Mitigation**         | (1) Day 2 priority: add `POST /api/nammaops/voice/transcribe` route to `api.mjs` or `runtime-api.mjs`; (2) Route receives audio bytes, calls `createSttProvider(env)` which returns `gnaniProvider()` when `AGENT_TOWN_STT_PROVIDER=gnani`; (3) Returns `{transcript, provider: "gnani-prisma"}` to browser; (4) **Already done**: `gnaniProvider()` is complete — only the HTTP route is missing. Estimated effort: 2 hours.                                         |
| **Owner**              | Lead developer — Day 2                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Codebase reference** | `lib/server/stt.mjs` — `gnaniProvider()`, `createSttProvider()`                                                                                                                                                                                                                                                                                                                                                                                                       |

---

### T2: Gnani Timbre TTS Has Zero Implementation [CRITICAL]

| Field                  | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | The codebase has zero Timbre TTS code. The existing voice output uses Gemini Live built-in voices (Kore, Puck, Aoede, Charon, set in `lib/voice/config.ts`). These are Google voices, not Gnani Timbre. A `tts.mjs` file with `timbreProvider()` must be built from scratch.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Likelihood**         | CONFIRMED — `tts.mjs` does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Impact**             | H — Without Timbre, the NammaOps voice output is not Gnani-powered. The demo cannot show a full Gnani Prisma → workflow → Timbre round-trip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Mitigation**         | (1) Day 2 priority: build `lib/server/tts.mjs` with `timbreProvider({apiKey})`; (2) REST POST to `https://api.gnani.ai/v1/tts/inference` (verify endpoint in Timbre docs on Day 2 morning); (3) Auth: `X-API-Key-ID: {GNANI_API_KEY}` header; (4) Body: `{text, language_code}` e.g. `{text: "…", language_code: "kn-IN"}`; (5) Returns `{audioBytes, provider: "gnani-timbre"}`; (6) Add `POST /api/nammaops/voice/speak` route to `api.mjs`; (7) **Fallback**: If Timbre API docs or endpoint differ from what docs indicate, use Gemini voices for TTS — the demo still uses Gnani Prisma STT, which satisfies the "at least one Gnani model" requirement. Estimated build effort: 6 hours. |
| **Owner**              | Lead developer — Day 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Codebase reference** | `lib/voice/config.ts` voiceConfig() for current Gemini voices; `lib/server/stt.mjs` for analogous Prisma pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

### T3: Gnani API Credit Consumption Rate Unknown

| Field                  | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | The 5,000 programme credits apply only to Prisma (STT) and Timbre (TTS). Credit consumption per API call (per second of audio for Prisma; per character for Timbre) is not published. If credits run out before the demo recording, the Gnani voice round-trip fails.                                                                                                                                                                                                                                     |
| **Likelihood**         | M — manageable with disciplined testing strategy                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Impact**             | H — If credits run out, the primary Gnani demo cannot be recorded                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Mitigation**         | (1) Day 2 morning: make 10 Prisma calls and 10 Timbre calls; check credit balance before and after; calculate credits-per-call; (2) During development Days 3-6: use `AGENT_TOWN_STT_PROVIDER=fixture` for all testing; only call Gnani live for final integration tests and the demo recording; (3) Budget: reserve 100+ Prisma calls and 100+ Timbre calls for demo recording (multiple takes); (4) If credits run low before Day 7: contact Gnani AI support; hackathon organizers may provide top-ups |
| **Owner**              | Lead developer — Day 2 morning                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Codebase reference** | `lib/server/stt.mjs` `fixtureProvider()` — use this for development testing                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

### T4: Kanglish (Kannada-English) Code-Switching Accuracy

| Field           | Detail                                                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Prisma v2.5 explicitly documents Hinglish, Tanglish, and Benglish code-mixing. Kannada-English mixing ("Kanglish") is NOT explicitly documented. Kirana owners in Bengaluru routinely mix Kannada and English. If accuracy is poor, the primary demo language must pivot to Hindi.                                   |
| **Likelihood**  | M — Prisma is trained on real Indian conversations; Kanglish is common in Bengaluru                                                                                                                                                                                                                                  |
| **Impact**      | H — If Kanglish accuracy is poor, the "Kannada-first" demo narrative breaks                                                                                                                                                                                                                                          |
| **Mitigation**  | (1) Test Kanglish on Day 3 with 6+ queries; (2) If accuracy < 70%: pivot demo primary language to Hindi + Hinglish (explicitly supported); (3) Optionally use `language_code: "indic-auto"` for auto-detection; (4) Prisma v3.0 may have better Kanglish support — request v3.0 if available under hackathon credits |
| **Owner**       | Developer + Kannada-speaking tester                                                                                                                                                                                                                                                                                  |

---

### T5: Live ERPNext Latency in Demo Recording

| Field                  | Detail                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | The `hvgerp-adapter-server.mjs` makes concurrent API calls with CONCURRENCY=8 workers. For demand_forecast, which reads 90 days of sales in 7-day slices, latency may be significant on a live ERPNext Cloud instance. Phase G2 verification showed individual calls at 37–342ms, but a full forecast workflow may stack several dozen calls.                     |
| **Likelihood**         | M — Sequential calls for date-windowed fetches                                                                                                                                                                                                                                                                                                                    |
| **Impact**             | M — Workflow > 10 seconds looks slow in a demo video                                                                                                                                                                                                                                                                                                              |
| **Mitigation**         | (1) Use fixture data for the demo video recording — all workflows complete in < 1 second on fixture; (2) Show live ERPNext as a proof-of-concept clip separate from the timed workflow demo; (3) Catalogue data has 60s cache — second run is much faster; (4) If live is used: demo stock_check or supplier_comparison (fewer calls) rather than demand_forecast |
| **Owner**              | Developer                                                                                                                                                                                                                                                                                                                                                         |
| **Codebase reference** | `lib/mcp/hvgerp-adapter-server.mjs` — `CONCURRENCY`, `CATALOGUE_TTL_MS`                                                                                                                                                                                                                                                                                           |

---

### T6: Evon LLM — Not on API Platform (SCOPE DECISION, NOT A RISK)

| Field           | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Evon v3.3 is self-hosted only (open weights on HuggingFace, requires H100/A100). It is NOT on the gnani.ai API platform. The 5,000 programme credits do NOT cover Evon. This was a risk in the pre-codebase planning documents. It is now a resolved scope decision: NammaOps uses deterministic business logic, not LLM reasoning, for all workflow calculations. The optional Manager reasoning turn in `workflows.mjs` (`NAMMAOPS_REASONING=manager`) submits to the existing OpenClaw agent using Gemini Flash or GPT-4o-mini — not Evon. |
| **Likelihood**  | RESOLVED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Impact**      | LOW — Competition requires only one Gnani model (Prisma satisfies this); Timbre satisfies it further. Evon is not required.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Mitigation**  | No H100 needed. Do not mention Evon as a planned integration in the demo. For reasoning: use `NAMMAOPS_REASONING=off` (default) in the demo — all calculations are deterministic and do not need LLM reasoning for correct results.                                                                                                                                                                                                                                                                                                           |
| **Owner**       | — (resolved)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

### T7: Mobile Browser AudioWorklet Compatibility

| Field           | Detail                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | The voice audio capture uses the browser AudioWorklet API. AudioWorklet is not universally supported on budget Android devices. For the standalone Gnani voice page being built in Days 3-4, this is relevant.                                      |
| **Likelihood**  | M — Budget phones may run older Chrome                                                                                                                                                                                                              |
| **Impact**      | M — If AudioWorklet fails, voice capture fails                                                                                                                                                                                                      |
| **Mitigation**  | (1) Implement a fallback: MediaRecorder API (no AudioWorklet) for browsers that don't support AudioWorklet; (2) For the demo device: use a modern browser (Chrome 90+); (3) The demo recording does not need to be on a kirana owner's actual phone |
| **Owner**       | Developer                                                                                                                                                                                                                                           |

---

### T8: Pipeline Latency > 6 Seconds End-to-End

| Field           | Detail                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Full Gnani voice round-trip: browser capture → POST to server → Prisma STT (≤ 1s) → `parseCommand()` (< 1ms) → workflow start → ERP calls (fixture: < 100ms; live: 200-500ms) → voice contract → Timbre TTS (unknown latency) → audio bytes → browser plays. If Prisma + Timbre combined latency is > 3s, the total experience feels slow.                                                                                    |
| **Likelihood**  | M — Gnani API round-trip latency to India server not measured yet                                                                                                                                                                                                                                                                                                                                                             |
| **Impact**      | M — Latency > 6s breaks demo flow                                                                                                                                                                                                                                                                                                                                                                                             |
| **Mitigation**  | (1) Measure Prisma and Timbre latency on Day 2; report actual numbers; (2) Show a visual "listening → thinking → answering" state progression during processing; (3) Use fixture data (< 100ms for ERP calls) in the demo to minimize workflow latency; (4) Stream Timbre audio if WebSocket TTS is available (reduces time-to-first-sound); (5) If total latency is acceptable (< 6s), highlight it as a feature in the demo |
| **Owner**       | Developer                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

### T9: Fixture-Only PO Drafting (Documented Scope Decision)

| Field           | Detail                                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Purchase order draft creation (`erp.po.create_draft`) and submission (`erp.po.submit`) are explicitly disabled on the live ERPNext binding (`config/nammaops/binding.hvgerp.json`): reason given is "Live purchase-order drafts are not enabled yet". The prepare_reorder workflow with owner approval only runs on fixture data. |
| **Likelihood**  | CONFIRMED — `binding.hvgerp.json` intentionally disables these capabilities                                                                                                                                                                                                                                                       |
| **Impact**      | LOW — Demo plan already accounts for this. Stock check, demand forecast, daily report, and supplier comparison all work on live data. Prepare reorder + approval demo uses fixture.                                                                                                                                               |
| **Mitigation**  | (1) Demo fixture PO workflow — it's fully functional and more impressive than live (shows the owner approval PIN gate, cryptographic fingerprint, ERP write); (2) Note in submission: "PO drafting uses fixture data for the demo; live ERPNext read capabilities are verified". This is an honest, correct statement.            |
| **Owner**       | — (scope decision, no action needed)                                                                                                                                                                                                                                                                                              |

---

## 2. Product Risks

### P1: Kirana Vocabulary Accuracy in Prisma

| Field                  | Detail                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | Kirana product names in Kannada may not be well-represented in Prisma's training data. Specialty items like ತೊಗರಿ ಬೇಳೆ (toor dal), ಹಾಲು (milk), ಅಕ್ಕಿ (rice) must transcribe correctly. Wrong product name → wrong inventory query → wrong result.                                                                                                                                                            |
| **Likelihood**         | M — Niche vocabulary is always a challenge for STT                                                                                                                                                                                                                                                                                                                                                            |
| **Impact**             | M — Demo breaks if the key product names are mistranscribed                                                                                                                                                                                                                                                                                                                                                   |
| **Mitigation**         | (1) Test all 7 fixture product names (`fixture-data.json`: MILK-500, RICE-5KG, OIL-SUN-1L, OIL-COCO-500, DAL-TOOR-1KG, SUGAR-1KG, GHEE-200) in Kannada and Hindi pronunciation against Prisma; (2) `resolveProducts()` in `calculations.mjs` uses fuzzy matching — slight mistranscription (e.g., "atta" vs "ata") may still resolve correctly; (3) Demo the 4 products that Prisma transcribes most reliably |
| **Owner**              | Developer + Kannada speaker                                                                                                                                                                                                                                                                                                                                                                                   |
| **Codebase reference** | `lib/server/nammaops/calculations.mjs` `resolveProducts()`, `config/nammaops/fixture-data.json`                                                                                                                                                                                                                                                                                                               |

---

### P2: Voice UX Polish for Demo Quality

| Field           | Detail                                                                                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | The NammaOpsPanel exists and is demo-ready for text command input. The standalone Gnani voice page being built in Days 3-4 must look polished — not like a dev prototype. If the voice page looks unfinished, it undermines the demo quality for the video.                                                                |
| **Likelihood**  | M — New page needs deliberate UI polish                                                                                                                                                                                                                                                                                    |
| **Impact**      | M — Poor UX in demo reduces Real Deal and Demo Day Drop Award scores                                                                                                                                                                                                                                                       |
| **Mitigation**  | (1) Implement clear state indicators: "Listening" (mic active) → "Thinking" (workflow running) → "Answering" (Timbre playing); (2) Show Prisma transcript text prominently; (3) Show agent timeline (can reuse SSE events from existing NammaOpsPanel logic); (4) Mobile-friendly layout; (5) Day 6 is dedicated to polish |
| **Owner**       | Developer                                                                                                                                                                                                                                                                                                                  |

---

## 3. Competition Risks

### C1: Submission Deadline Miss

| Field           | Detail                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | November 10, 2026, 11:59 PM IST. No extensions granted [VERIFIED].                                                                                                                                                                                     |
| **Likelihood**  | L — Preventable with planning                                                                                                                                                                                                                          |
| **Impact**      | H — Total disqualification                                                                                                                                                                                                                             |
| **Mitigation**  | (1) Target "soft deadline" Nov 8 for all deliverables; (2) Submit a partial submission on Nov 7 (updates are allowed until deadline); (3) Set calendar reminders for Nov 9 and 10; (4) Submission form must be saved at least 24 hours before deadline |
| **Owner**       | Both team members                                                                                                                                                                                                                                      |

---

### C2: Social Media Post Missing Required Elements

| Field           | Detail                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Required: post on LinkedIn and/or X with BOTH hashtags (#GreatIndianAIInternshipChallenge AND #GnaniAI), Gnani AI tagged, and public post URL entered in submission form. |
| **Likelihood**  | L — Preventable with a checklist                                                                                                                                          |
| **Impact**      | M — Incomplete submission reduces shortlisting probability                                                                                                                |
| **Mitigation**  | Use the compliance checklist in `docs/GNANI_HACKATHON_RULES_AND_COMPLIANCE.md` before posting; have a second person verify the post before submitting the URL             |
| **Owner**       | Both team members                                                                                                                                                         |

---

### C3: Technical Authenticity Challenge

| Field           | Detail                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Judges verify "authentic use of Gnani technology." If the integration looks shallow (one API call in a minor role), it may not qualify.                                                                                                                                                                                       |
| **Likelihood**  | L — NammaOps has deep Gnani integration (Prisma in STT + Timbre in TTS, both in the critical voice path)                                                                                                                                                                                                                      |
| **Impact**      | H — Affects shortlisting probability                                                                                                                                                                                                                                                                                          |
| **Mitigation**  | (1) Show both Prisma and Timbre calls in the demo video — visible transcript and visible waveform; (2) In the submission text, describe HOW each model is used with technical detail (API endpoint, auth method, language code used, latency measured); (3) Show the `gnaniProvider()` code in the submission if space allows |
| **Owner**       | Lead developer                                                                                                                                                                                                                                                                                                                |

---

### C4: Real Personal Data in Demo

| Field           | Detail                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Competition explicitly prohibits real phone numbers, Aadhaar, PAN, or recorded calls. All demo data must be synthetic.                                                                                                                                                  |
| **Likelihood**  | L — NammaOps uses `fixture-data.json` with company name "Namma Kirana (fixture)"                                                                                                                                                                                        |
| **Impact**      | H — Disqualification                                                                                                                                                                                                                                                    |
| **Mitigation**  | (1) All demo data is from `config/nammaops/fixture-data.json` — no real personal data; (2) Live ERPNext data labeled "NAMMAOPS-SEED" is synthetic demo data (confirmed in `binding.hvgerp.json` `data_label`); (3) Never use a real store's live data in the demo video |
| **Owner**       | Developer                                                                                                                                                                                                                                                               |

---

### C5: Engagement Authenticity Flag

| Field           | Detail                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | If LinkedIn engagement looks coordinated (sudden spike from non-organic sources), it may trigger an authenticity review.                                                                                                                         |
| **Likelihood**  | L — Only if rules are violated                                                                                                                                                                                                                   |
| **Impact**      | H — Disqualification                                                                                                                                                                                                                             |
| **Mitigation**  | (1) Never use any tool or service to automate engagement; (2) Never ask for engagement in exchange for anything; (3) Only share with genuine personal and professional networks; (4) Less engagement is better than any risk of disqualification |
| **Owner**       | Both team members                                                                                                                                                                                                                                |

---

## 4. Security Risks

### S1: Gnani API Key Exposure

| Field                  | Detail                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | The `GNANI_API_KEY` is used server-side in `stt.mjs` `gnaniProvider()` (`X-API-Key-ID` header). It must never reach the browser or appear in any public repository.                                                                                                                                                                                                              |
| **Likelihood**         | M — A common hackathon mistake                                                                                                                                                                                                                                                                                                                                                   |
| **Impact**             | H — Credits depleted by others; key revoked                                                                                                                                                                                                                                                                                                                                      |
| **Mitigation**         | (1) `GNANI_API_KEY` already handled correctly in `stt.mjs` — "the key never leaves the header"; (2) Verify `.env.local` is in `.gitignore` before first commit with the key; (3) The `POST /api/nammaops/voice/transcribe` route must use the server-side `GNANI_API_KEY`, never pass it to the browser; (4) If accidentally committed: revoke immediately and request a new key |
| **Owner**              | Developer                                                                                                                                                                                                                                                                                                                                                                        |
| **Codebase reference** | `lib/server/stt.mjs` — key handling note: server-side only                                                                                                                                                                                                                                                                                                                       |

---

### S2: ERPNext Credentials Not Leaked

| Field                  | Detail                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET must only exist in the child process environment for the hvgerp-adapter. They must not appear in API responses, logs, or the browser. |
| **Likelihood**         | L — `hvgerp-adapter-server.mjs` `connectHvgerp()` already handles this correctly                                                                                                       |
| **Impact**             | H — Live ERP data exposed                                                                                                                                                              |
| **Mitigation**         | Verify `connectHvgerp()` credential isolation before live demo. Do not add any debug logging that might print env vars.                                                                |
| **Owner**              | Developer                                                                                                                                                                              |
| **Codebase reference** | `lib/mcp/hvgerp-adapter-server.mjs` — `connectHvgerp()` credentials-in-child-env pattern                                                                                               |

---

### S3: Prompt Injection in Product Names

| Field           | Detail                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | If a product name from ERP contains adversarial content (e.g., "Ignore previous instructions"), it could inject into the optional Manager LLM reasoning turn.                   |
| **Likelihood**  | L — Demo data is controlled; fixture data has clean names                                                                                                                       |
| **Impact**      | M — Could cause unexpected LLM behavior                                                                                                                                         |
| **Mitigation**  | Agent Town's `untrusted-content.mjs` `fenceUntrusted()` function is available. Apply it to all database-sourced content before it enters the optional Manager reasoning prompt. |
| **Owner**       | Developer                                                                                                                                                                       |

---

## 5. Demonstration Risks

### D1: Live Demo Fails (Network/API Downtime)

| Field           | Detail                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Gnani API downtime, network issues, or a bug could cause the demo to fail during recording.                                                                                                                                                                                                                                                   |
| **Likelihood**  | M — APIs have downtime; networks have issues                                                                                                                                                                                                                                                                                                  |
| **Impact**      | H — Demo video cannot be recorded on deadline                                                                                                                                                                                                                                                                                                 |
| **Mitigation**  | (1) **PRIMARY**: Pre-record the 60-second video; judges watch the recording, not a live session; (2) Record 3 takes on Day 7; keep the best; (3) Prepare a cached/mock fallback: fixture STT (`fixtureProvider()`) + Gemini TTS — the business logic and governance still work correctly; (4) Test the full pipeline 48 hours before deadline |
| **Owner**       | Both team members                                                                                                                                                                                                                                                                                                                             |

---

### D2: Prisma Mistranscribes During Demo Recording

| Field           | Detail                                                                                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Prisma may mistranscribe a key phrase during recording, breaking the demo narrative.                                                                                                                                                                                                                                                                |
| **Likelihood**  | M — Speech recognition is imperfect under pressure                                                                                                                                                                                                                                                                                                  |
| **Impact**      | M — Need to re-record                                                                                                                                                                                                                                                                                                                               |
| **Mitigation**  | (1) Record in a quiet environment; (2) Show transcript on screen — viewers see what the AI heard; (3) Record multiple takes; use the cleanest one; (4) Speak the Kannada demo phrases clearly at moderate pace; (5) If a take has a wrong transcript but the workflow still routed correctly: keep it — it shows graceful handling of imperfect STT |
| **Owner**       | Demo presenter                                                                                                                                                                                                                                                                                                                                      |

---

### D3: Timbre Audio Quality Poor in Kannada

| Field           | Detail                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Timbre v2.5 has multiple Kannada voices. Per-voice quality varies and has not been independently benchmarked.                                                                                                                                                                                                                                  |
| **Likelihood**  | M — Indian TTS quality varies by voice                                                                                                                                                                                                                                                                                                         |
| **Impact**      | M — Robotic voice breaks demo narrative                                                                                                                                                                                                                                                                                                        |
| **Mitigation**  | (1) Day 2: test all available Kannada voices in Timbre; (2) Have a Kannada speaker rate each voice for naturalness; (3) Test the pronunciation of kirana product names specifically; (4) Select the best voice before recording; (5) If no Kannada voice sounds natural: pivot demo TTS to Hindi (still regional language, still Gnani Timbre) |
| **Owner**       | Developer + Kannada evaluator                                                                                                                                                                                                                                                                                                                  |

---

### D4: Demo Video Lacks Polish

| Field           | Detail                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | If the video looks like a raw screen recording with no structure, it won't stand out.                                                                                                                                                                                                                              |
| **Likelihood**  | M — Video production is not a core developer skill                                                                                                                                                                                                                                                                 |
| **Impact**      | M — Reduces Demo Day Drop Award chances                                                                                                                                                                                                                                                                            |
| **Mitigation**  | (1) Write the 60-second script before recording (script is in `NAMMAOPS_HACKATHON_STRATEGY.md` Section 9); (2) Use OBS or Loom for screen recording with webcam overlay; (3) Add Kannada/Hindi captions for key phrases; (4) Add an end card with both hashtags and project name; (5) Invest 1 day in Day 6 polish |
| **Owner**       | Both team members                                                                                                                                                                                                                                                                                                  |

---

## 6. Updated Risk Summary Table

| ID  | Risk                             | Likelihood | Impact | Priority | Status                    |
| --- | -------------------------------- | ---------- | ------ | -------- | ------------------------- |
| T1  | Prisma STT needs route wiring    | CONFIRMED  | H      | CRITICAL | Day 2                     |
| T2  | Timbre TTS zero implementation   | CONFIRMED  | H      | CRITICAL | Day 2                     |
| T3  | API credit exhaustion            | M          | H      | HIGH     | Measure Day 2             |
| T4  | Kanglish accuracy poor           | M          | H      | HIGH     | Test Day 3                |
| T5  | Live ERPNext latency in demo     | M          | M      | MEDIUM   | Use fixture for demo      |
| T6  | Evon not on API platform         | RESOLVED   | —      | RESOLVED | Scope decision            |
| T7  | Mobile AudioWorklet compat       | M          | M      | MEDIUM   | Test on Android           |
| T8  | Pipeline latency > 6s            | M          | M      | MEDIUM   | Measure Day 2             |
| T9  | PO drafting fixture-only         | CONFIRMED  | LOW    | RESOLVED | Scope decision            |
| P1  | Kirana vocabulary accuracy       | M          | M      | MEDIUM   | Test Day 3                |
| P2  | Voice page UI polish             | M          | M      | MEDIUM   | Day 6                     |
| C1  | Submission deadline miss         | L          | H      | HIGH     | Submit by Nov 8           |
| C2  | Post missing required elements   | L          | M      | MEDIUM   | Checklist before posting  |
| C3  | Technical authenticity challenge | L          | H      | HIGH     | Deep integration required |
| C4  | Real personal data in demo       | L          | H      | HIGH     | Use fixture data only     |
| C5  | Engagement authenticity flag     | L          | H      | HIGH     | No coordinated engagement |
| S1  | API key exposure                 | M          | H      | HIGH     | Server-side only          |
| S2  | ERPNext credentials leaked       | L          | H      | HIGH     | Verified in code          |
| S3  | Prompt injection                 | L          | M      | LOW      | Use fenceUntrusted()      |
| D1  | Live demo fails                  | M          | H      | HIGH     | Pre-record video          |
| D2  | Prisma mistranscription          | M          | M      | MEDIUM   | Multiple takes            |
| D3  | Timbre Kannada quality poor      | M          | M      | MEDIUM   | Test all voices           |
| D4  | Demo video lacks polish          | M          | M      | MEDIUM   | Day 6 polish              |

---

## 7. Go / No-Go Criteria Before Submission

### MUST criteria (submission blocked if any fail)

- [ ] At least one Gnani model (Prisma STT) is making real API calls to `https://api.vachana.ai/stt/v3`
- [ ] Demo video recorded, shows Gnani Prisma transcript visible on screen
- [ ] LinkedIn and/or X post is live with BOTH hashtags: #GreatIndianAIInternshipChallenge and #GnaniAI
- [ ] Post URL(s) entered in submission form
- [ ] Submission deadline NOT passed (November 10, 2026, 11:59 PM IST)
- [ ] No real personal data in demo (no real phone numbers, Aadhaar, PAN, recorded calls from real people)
- [ ] `GNANI_API_KEY` is NOT committed to any public repository
- [ ] No purchased engagement, bots, or paid promotion used

### SHOULD criteria (strongly recommended)

- [ ] Both Gnani Prisma (STT) and Timbre (TTS) are integrated in the voice path
- [ ] Full Gnani voice round-trip demonstrated in video: Kannada speech → Prisma transcript → workflow → Timbre response
- [ ] Stock check workflow completes end-to-end via Gnani voice
- [ ] Prepare reorder + owner approval demonstrated (can be fixture data)
- [ ] Demand forecast demonstrated with 90-day history
- [ ] At least one Kannada-language scenario works correctly
- [ ] Demo video is 60 seconds or less with clear problem-solution narrative
- [ ] McpGovernancePanel audit log shown in video (zero denied invocations)
- [ ] Live ERPNext data source shown as proof of integration depth

### NICE TO HAVE criteria (non-blocking)

- [ ] Hinglish code-mixed scenario tested and demonstrated
- [ ] Noisy audio test scenario demonstrates Prisma robustness
- [ ] Mobile browser demo works on Android Chrome
- [ ] Pipeline end-to-end latency < 6 seconds measured and mentioned in submission
- [ ] Video captions in Kannada/Hindi
