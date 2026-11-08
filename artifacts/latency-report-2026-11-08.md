# KiranaCrew voice latency: Phase 1 + Phase 2 report (2026-11-08)

All numbers are measured with `scripts/bench-nammaops-latency.mjs` against live ERPNext (read-only).
Each run used `today=2026-11-08`, 3 rounds, and 1 cold + 2 warm runs per question per round (9 runs per question).
Every question goes through `runtime.nammaops.voice.query`, the entry point the Gemini Live tool uses.

- **Cold:** a fresh adapter and hvgerp child, so the caches are empty.
- **Warm:** the same process, within the 60 s reference-data cache.

Raw data:
- `latency-baseline-2026-11-08.json`: before Phase 2.
- `latency-after-2026-11-08.json`: first attempt, which had a regression.
- `latency-after2-2026-11-08.json`: final.

## Results (baseline → final)

| Question | Cold p50 ms | Cold p95 ms | Warm p50 ms | hvgerp calls (cold) | Runs > 20 s voice wait | Fingerprint equal |
|---|---|---|---|---|---|---|
| Demand forecast | 29 541 → **11 309** | 33 433 → **13 764** | 627 → 218 | 600 → 600 | **3 → 0** | yes |
| Store health report | 12 577 → **8 200** | 13 336 → 12 858 | 121 → 119 | **137 → 84** | 0 → 0 | yes |
| Simple stock check | 7 631 → 6 540 | 8 368 → 8 346 | 11 → 10 | 54 → 54 | 0 → 0 | yes |
| Receivables | 1 057 → 1 100 | 1 063 → 1 247 | 10 → 9 | 2 → 2 | 0 → 0 | yes |
| Daily sales | 5 158 → 6 753 | 6 490 → 8 636 | 12 → 10 | 55 → 55 | 0 → 0 | yes |

**Completeness:** each question produced one fingerprint across all 9 runs, and it is identical in the baseline and final runs. The fingerprint is a sha256 of the normalised workflow result and spoken facts, with ids and timestamps removed.

**Failures:** there were 0 failed governed calls and 0 failed workflows in any run. Store health is `partial` in every run, both before and after. Its specialist tasks all complete, so `partial` comes from the workflow's own data checks, not from a failed step. That was not investigated further.

**Text-to-speech, first chunk** (5 sentences each, measured separately in each run):

| Run | SSE p50 / p95 ms | WS p50 / p95 ms |
|---|---|---|
| Baseline | 506 / 695 | 493 / 514 |
| After | 608 / 807 | 472 / 570 |
| Final | 396 / 653 | 438 / 444 |

WS has the tighter p95. The p50 values are within noise of each other.

## What changed

1. **Instrumentation (Phase 1).**
   - Every `mcp.invocation` now has a `timing` field: `duration_ms`, `tool_ms`, and adapter `hv_calls`, `cache_hits`, `cache_misses` and `splits`. Audit fields are unchanged, and the business payload is byte-identical because timing travels in MCP `_meta`.
   - The `nammaops.voice_consult` record now has `timing`: `trace_id` (= workflow id = invocation `correlation_id`), `setup_ms`, `workflow_wait_ms`, `total_ms` and `timed_out`.
   - The Live client reports per-turn speech→tool, tool, speech→text and speech→first-audio times. They are sanitised server-side and stored on the `voiceCall` record as `turnTimings`.
   - Speak-stream time to first chunk and the transport used are shown on `GET /api/runtime/voice/diagnostics` (`tts`).
2. **Workflow parallelism.**
   - `readSlices` reads 3 slices at a time. Order is kept, and no new slices start after a failure.
   - In demand_forecast, the sales and inventory steps run together, and procurement joins them when no products are named. Task order and failure order are unchanged.
   - store_health runs its 4 optional specialist steps together.
   - business_report reads P&L, receivables and stock together with sales.
3. **Adapter.**
   - The reference-data cache shares in-flight loads and drops failed ones.
   - The submitted-document cache is bounded at 5000 entries.
   - A process-wide limit of 8 concurrent hvgerp requests applies.
   - Window halves, sales + POS, and receivables + customers are read in parallel.
4. **Governance.** Compiled input validators are cached by schema text. Records are re-read per call, so Ajv's identity cache never hit, and it also grew without bound.

Every ERP read still passes `ToolGateway` (decision, allowlist, audited invocation id). Nothing write-capable was added.

## Regression found and fixed

The first attempt (`latency-after`) made receivables about 2× slower on cold runs (1 057 → 2 172 ms).

An alternating A/B of the old and new adapter isolated the cause:
- A fresh hvgerp child is slow when its first requests arrive together: about 1.3 s, versus about 0.45 s when they are serial.
- After one request, concurrent reads are fast (100–200 ms).

The adapter now sends the first hvgerp request on a connection alone. That fixed receivables and also improved demand forecast further (15.8 s → 11.3 s p50).

## Not improved / open

- **Daily sales** cold p50 is 6.8 s, against 5.2 s at baseline, with wide spread (baseline 4.6–6.5 s, final 6.5–8.6 s).
  - Its call path is unchanged apart from the first-request rule.
  - An A/B of `list_sales_invoices` alone showed no difference.
  - Not confirmed as a regression; needs more rounds.
- **Cold stock checks and daily sales are still dominated by `list_items`:** 1 list + 1 `erpnext_item_get` per item (52 items), which is about 5–8 s cold. The cache only helps within 60 s of the last read. This is the next target. Options: a longer TTL for item master data, or reading reorder levels in one list call instead of N gets.
- Warm runs are fast partly because hvgerp-mcp caches responses itself. Production benefits only while the adapter process stays up.
- **Not measured here:**
  - real end-to-end Live call latency, meaning speech → tool → first audio (needs two real calls on the Voice First screen; `turnTimings` now records it);
  - Phases 3–6.
- **Tuning settings:** `cacheMs` and `concurrency` are code defaults. The adapter child receives only the ERPNext credentials, and its command line is pinned by the stdio allowlist, so they are not exposed as environment variables.
