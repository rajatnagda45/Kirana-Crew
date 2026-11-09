# Gnani AI Model Technical Analysis

## Prisma v2.5 (STT) · Timbre v2.5 (TTS) · Evon v3.3 (LLM)

> For KiranaCrew — AI Workforce for Kirana Stores
> All claims tagged [VERIFIED], [INFERRED], or [UNVERIFIED ASSUMPTION]
> Sources: docs.gnani.ai, gnani.ai/speech-to-text-api, HuggingFace gnani/gnani-evon-v3.3-30B-A3B, LiveKit docs, PyPI gnani-vachana

---

## 1. Prisma v2.5 — Speech-to-Text (STT)

### 1.1 Supported Languages

[VERIFIED — from gnani-ai/gnani HuggingFace, gnani.ai/speech-to-text-api, and search results]

Prisma v2.5 supports:

- **10+ Indian languages**: Hindi (hi-IN), Tamil (ta-IN), Telugu (te-IN), Bengali (bn-IN), Marathi (mr-IN), Gujarati (gu-IN), Kannada (kn-IN), Malayalam (ml-IN), Punjabi (pa-IN), Odia, Indian English (en-IN)
- **Code-mixed combinations**: Hinglish (Hindi+English), Tanglish (Tamil+English), Benglish (Bengali+English)
- **Auto language detection**: Automatic detection across all supported languages [VERIFIED — gnani.ai/speech-to-text-api]

Note: Prisma v3.0 was launched October 28, 2026, during the hackathon window. It explicitly supports 10 languages and adds "auto language detection." [VERIFIED — search results] It is unclear whether hackathon credits cover v3.0 or v2.5 specifically. [UNVERIFIED ASSUMPTION — confirm with Gnani AI]

### 1.2 Kannada and Hindi Support

[VERIFIED — both explicitly listed in model documentation; CORRECTION NOTE [Audit Nov 1]: Kanglish status clarified for Prisma v3.0]

- **Kannada (kn-IN)**: Explicitly listed in Prisma v3.0 documentation. WER: 15.82% (Prisma v3.0) [VERIFIED — gnani.ai/resources/blogs/prisma-v3-0-speech-recognition]
- **Hindi (hi-IN)**: Explicitly listed. WER: 11.72% (Prisma v3.0) [VERIFIED]
- **Hinglish code-switching**: Explicitly supported [VERIFIED — multiple sources]
- **Kanglish** (Kannada+English code-switching): **CORRECTION NOTE [Audit Nov 1]**: Prisma v3.0 is documented as "built for code-mixed speech, where a speaker switches languages within a sentence." The Prisma v3.0 blog explicitly describes handling calls that "switch between Hindi, English and Kannada in a single sentence." The Code-mix output mode "keeps each language in its own script." This means Kanglish IS supported by Prisma v3.0 for code-mixed speech. [VERIFIED — Prisma v3.0 blog, AGTP X post citing launch announcement]. Status upgraded from [UNVERIFIED ASSUMPTION] to [LIKELY VERIFIED — Prisma v3.0].

**Note on version**: Kanglish support is confirmed for **Prisma v3.0** (launched October 28, 2026). For Prisma v2.5, only Hinglish, Tanglish, and Benglish are explicitly named. If the hackathon credits apply to Prisma v3.0, Kanglish is supported. If only v2.5 is available, Kanglish remains [INFERRED — confirm with Gnani AI].

### 1.3 Streaming Architecture and API Interface

[VERIFIED — docs.gnani.ai/livekit, LiveKit agents PR, search results; CORRECTION NOTE [Audit Nov 1]: actual endpoint URLs confirmed]

**API Base URL**: `https://api.vachana.ai` [VERIFIED — from docs.gnani.ai/livekit/introduction and LiveKit plugin documentation]

**Three primary API modes:**

1. **REST (file-based)**: `POST /stt/v3` at `https://api.vachana.ai/stt/v3` [VERIFIED]
2. **WebSocket streaming**: `wss://api.vachana.ai/stt/v3/stream` — real-time transcription with VAD (Voice Activity Detection) [VERIFIED]
3. **Batch asynchronous**: Separate batch endpoint for long-form audio [VERIFIED — docs.gnani.ai index]

**Authentication**: `X-API-Key-ID` header (set via `GNANI_API_KEY` environment variable) [VERIFIED — docs.gnani.ai/livekit/introduction]

**Models available**: `prisma-v2.5` (default) and `prisma-v3.0` [VERIFIED — LiveKit plugin docs]

**SDK**: `pip install gnani-vachana` [VERIFIED — PyPI]
**LiveKit integration**: `pip install livekit-plugins-gnani` [VERIFIED — docs.livekit.io/agents/models/tts/gnani]

**CORRECTION NOTE [Audit Nov 1]**: Previous versions of this document listed `GNANI_API_KEY` as the auth header name. The correct header is `X-API-Key-ID`. The API base URL is `api.vachana.ai`, not `api.gnani.ai`. Update all integration code accordingly.

### 1.4 Latency Characteristics

[VERIFIED — gnani.ai/speech-to-text-api and search results]

- **Streaming latency**: P95 < 200 ms [VERIFIED — explicitly stated in Gnani documentation]
- **Architecture**: "End-to-end architecture, significantly faster than cascaded systems that chain multiple models — typically adds 1–3 seconds of latency" [VERIFIED — gnani.ai]

The sub-200ms P95 streaming latency is a competitive claim against Google STT and OpenAI Whisper. Independent benchmark confirmation was not found. [INFERRED — treat as vendor claim requiring independent validation]

### 1.5 Noisy Audio Handling

[VERIFIED — gnani.ai/speech-to-text-api]

- Trained on **telephony-grade audio**: 8kHz PSTN-quality audio with compression artifacts and network degradation
- **Word Error Rate on noisy audio**: Claims 3.8% WER [VERIFIED — gnani.ai/speech-to-text-api]
- **Specific conditions addressed**: background noise, compression artifacts, network degradation, rural environments
- This is directly relevant to KiranaCrew: kirana stores often have market noise, TV/radio playing, customer conversations in the background

### 1.6 Regional Accent Support

[VERIFIED — HuggingFace model card]

- Trained on data from "tier 2 and rural India" specifically
- Addresses "regional accents" as a design objective
- Trained on "14 million hours of Indic speech data" [VERIFIED — HuggingFace]

### 1.7 API Limits and Credit Model

[PARTIALLY VERIFIED]

- Hackathon participants receive 5,000 programme credits [VERIFIED — gnani.ai/internship]
- Exact credit consumption per API call: **not published in verified sources** [UNVERIFIED — must test early to avoid running out of credits mid-development]
- Production pricing: **not accessible without sales contact** [UNVERIFIED]

### 1.8 KiranaCrew Fit Assessment

**Verdict: STRONG FIT**

| Factor                           | Assessment                                                   |
| -------------------------------- | ------------------------------------------------------------ |
| Kannada support                  | Verified; kn-IN language code present                        |
| Hindi support                    | Verified; hi-IN supported                                    |
| Hinglish code-mixing             | Verified; explicitly a design feature                        |
| Kirana store noise conditions    | Strong fit: telephony audio, noisy environments, rural India |
| Streaming for real-time voice UX | Verified via WebSocket; sub-200ms P95                        |
| Kanglish code-mixing             | Unverified but likely; test required                         |
| SDK availability                 | Yes; gnani-vachana Python package; LiveKit plugin            |

**Primary concern**: Kanglish (Kannada-English) code-mixing is not explicitly documented as a supported variant. Testing with real code-mixed Kannada-English speech is required before committing to this use case. [INFERRED]

### 1.9 What is DOCUMENTED vs ASSUMED

| Claim                                            | Status                             |
| ------------------------------------------------ | ---------------------------------- |
| 10+ Indian languages supported                   | DOCUMENTED                         |
| Kannada (kn-IN) supported                        | DOCUMENTED                         |
| Hinglish code-mixing supported                   | DOCUMENTED                         |
| Sub-200ms streaming latency                      | DOCUMENTED (vendor claim)          |
| WebSocket streaming API available                | DOCUMENTED                         |
| 14M hours training data                          | DOCUMENTED                         |
| Telephony audio (8kHz) training                  | DOCUMENTED                         |
| Kanglish specifically supported                  | ASSUMED (not explicitly stated)    |
| WER 3.8% on noisy audio independent verification | NOT DOCUMENTED — vendor claim only |
| Credit cost per API call                         | NOT DOCUMENTED                     |

---

## 2. Timbre v2.5 — Text-to-Speech (TTS)

### 2.1 Supported Indian Languages

[VERIFIED — docs.livekit.io/agents/models/tts/gnani, PyPI livekit-plugins-gnani]

Language codes supported by timbre-v2.5:

- `auto` (automatic language detection from text)
- `bn-IN` (Bengali)
- `en-IN` (Indian English)
- `gu-IN` (Gujarati)
- `hi-IN` (Hindi)
- `kn-IN` (Kannada)
- `ml-IN` (Malayalam)
- `mr-IN` (Marathi)
- `pa-IN` (Punjabi)
- `ta-IN` (Tamil)
- `te-IN` (Telugu)

**Total voices**: 42 voices across 11 language groups (timbre-v2.5) [VERIFIED — LiveKit docs]
**Previous version voices**: timbre-v2.0 has 4 voices (Pranav, Kaveri, Shubhra, Deepak) [VERIFIED — LiveKit docs]

### 2.2 Kannada and Hindi Voice Quality

[VERIFIED / INFERRED as noted]

- Both `kn-IN` and `hi-IN` are documented language codes [VERIFIED]
- **Overall MOS score**: Gnani reports "MOS 4.23 on 8kHz telephony audio" [VERIFIED — search results from gnani.ai TTS page]
- **ELO ranking**: "1621 ELO with 75% win rate across 381 blind tests for Indian English" [VERIFIED — search results] — note this is for Indian English specifically
- **Blind MOS evaluation**: "Leads blind MOS evaluation across 10 Indian languages at 7.32, highest of any provider evaluated" [VERIFIED — search results, but note MOS scale typically runs 1–5; "7.32" may be a different evaluation scale or a misquote — treat with caution]
- Per-language voice quality for Kannada specifically: **not independently benchmarked in verified sources** [UNVERIFIED ASSUMPTION]

**KiranaCrew implication**: For Kannada-language output to kirana store owners, voice naturalness is critical for trust and usability. The quality claims are positive but Kannada-specific independent benchmarks have not been found. Early testing with Kannada speakers is strongly recommended. [INFERRED]

### 2.3 Prosody for Prices and Currency

[INFERRED — not explicitly documented in verified sources]

- Timbre documentation mentions "context-aware prosody" and "correct Indian numeral/name pronunciation" [VERIFIED — gnani.ai/internship summary]
- `itn_native_numerals: "true"` is a Prisma parameter that converts numerals to native script; similar functionality for TTS is expected but **not explicitly confirmed for Timbre** [INFERRED]
- Correct pronunciation of "ek sau pachpan rupaye" (₹155), "teen hajar" (₹3,000), "do lakh" (₹2,00,000) for price readback is critical for kirana store use cases
- **Independent verification of lakh/crore prosody**: NOT FOUND in verified sources [UNVERIFIED ASSUMPTION — must test]

### 2.4 Indian Names and Product Names

[INFERRED from model capabilities]

- Training on Indian speech data likely includes common kirana product names (atta, dal, chawal, chini, etc.) and supplier names
- Pronunciation of Indian brand names (Amul, Haldirams, Parle, Tata) and generic product names is a reasonable expectation
- **Independent benchmark for product name pronunciation**: NOT FOUND [UNVERIFIED ASSUMPTION — must test with kirana-specific vocabulary]

### 2.5 Streaming Support and Actual Endpoints

[VERIFIED — docs.gnani.ai/livekit/introduction; CORRECTION NOTE [Audit Nov 1]: actual endpoint URLs confirmed]

**API Base URL**: `https://api.vachana.ai` (same as STT) [VERIFIED]

Three synthesis methods with confirmed endpoints:

1. **REST**: `POST /api/v1/tts/inference` at `https://api.gnani.ai/v1/tts/inference` [VERIFIED — search results citing Timbre API docs]
2. **SSE** (Server-Sent Events): `POST /api/v1/tts/sse` [VERIFIED]
3. **WebSocket**: `wss://api.vachana.ai/api/v1/tts` — "Lowest latency" [VERIFIED — docs.gnani.ai/livekit]

**Authentication**: `X-API-Key-ID` header (same as Prisma) [VERIFIED]
**Models available**: `timbre-v2.5` (default, 42 voices) and `timbre-v3.0` (13 multilingual voices) [VERIFIED — LiveKit plugin docs]

**CORRECTION NOTE [Audit Nov 1]**: The REST endpoint is at `api.gnani.ai` while the WebSocket is at `api.vachana.ai`. Both use the same API key with the `X-API-Key-ID` header. Note: `timbre-v2.0` is no longer supported by gnani-vachana 0.8.x [VERIFIED — LiveKit PR].

For KiranaCrew real-time voice interactions, WebSocket (`wss://api.vachana.ai/api/v1/tts`) is the recommended method. [INFERRED]

### 2.6 Audio Format Parameters

[VERIFIED — LiveKit docs]

- Sample rates: 8000, 16000, 22050, 44100 Hz
- Encoding: Linear PCM or OggOpus
- Containers: raw, mp3, wav, ogg
- Bitrates: 96k, 128k, 192k (compressed formats)
- Channels: Configurable (default mono)

For kirana store deployment on low-end Android phones: 8000 Hz sample rate, OggOpus encoding, mono channel is the recommended configuration. [INFERRED]

### 2.7 Latency

[VERIFIED / INFERRED]

- Claims: "sub-100ms time to first audio" and "under 250ms p95 first byte on TTS API" [VERIFIED — search results citing gnani.ai model page]
- LiveKit documentation: characterizes service as "low-latency, natural-sounding speech synthesis" without specific quantified metrics [VERIFIED — docs.livekit.io]
- Combined pipeline latency (Prisma STT + Evon reasoning + Timbre TTS) for a full voice turn: **not published; estimated 500ms–2s total** [INFERRED — sum of individual component latencies; highly dependent on network, model load, and token count]

### 2.8 KiranaCrew Fit Assessment

**Verdict: STRONG FIT**

| Factor                        | Assessment                                              |
| ----------------------------- | ------------------------------------------------------- |
| Kannada (kn-IN) support       | Verified language code                                  |
| Hindi (hi-IN) support         | Verified language code                                  |
| Streaming for real-time voice | Verified via WebSocket                                  |
| Telephony audio (8kHz)        | Documented MOS on 8kHz audio                            |
| 42 voices for character       | Large selection; can choose "friendly shopkeeper" voice |
| Price/currency prosody        | Claimed but not independently verified for Kannada      |
| Low-bandwidth mobile output   | 8kHz mono OggOpus configurable                          |

### 2.9 What is DOCUMENTED vs ASSUMED

| Claim                                       | Status                       |
| ------------------------------------------- | ---------------------------- |
| 11 language codes including kn-IN and hi-IN | DOCUMENTED                   |
| 42 voices in timbre-v2.5                    | DOCUMENTED                   |
| WebSocket streaming available               | DOCUMENTED                   |
| Sub-100ms time to first audio               | DOCUMENTED (vendor claim)    |
| Context-aware prosody                       | DOCUMENTED (general claim)   |
| Correct Indian numeral pronunciation        | DOCUMENTED (general claim)   |
| Kannada-specific voice quality              | NOT INDEPENDENTLY DOCUMENTED |
| Correct lakh/crore pronunciation            | NOT EXPLICITLY DOCUMENTED    |
| Kirana product name pronunciation           | NOT DOCUMENTED — assumed     |

---

## 3. Evon v3.3 — Reasoning Language Model

### 3.1 Architecture and Context Window

[VERIFIED — HuggingFace gnani/gnani-evon-v3.3-30B-A3B, HackerNoon article]

| Attribute                   | Value                                              | Status   |
| --------------------------- | -------------------------------------------------- | -------- |
| Architecture                | Mamba2-Transformer Hybrid Mixture of Experts (MoE) | VERIFIED |
| Network type                | Nemotron Hybrid MoE (`nemotron_h`)                 | VERIFIED |
| Total parameters            | 30 billion                                         | VERIFIED |
| Active parameters per token | ~3.5 billion                                       | VERIFIED |
| Context window              | 131,072 tokens (128K)                              | VERIFIED |
| Precision                   | BF16                                               | VERIFIED |
| Maximum output tokens       | 16,384                                             | VERIFIED |

The MoE architecture means Evon activates only 3.5B parameters per inference step despite having 30B total parameters. This gives it efficiency comparable to a 3.5B dense model while having the capacity of a 30B model. [INFERRED from MoE architecture fundamentals]

### 3.2 Indian-Language Capabilities

[VERIFIED — HuggingFace, HackerNoon]

**Supported languages** (11 + English):
Hindi, Bengali, Telugu, Tamil, Marathi, Gujarati, Kannada, Malayalam, Odia, Punjabi, English

**MILU benchmark performance** (multilingual instruction following):

- 78.74 macro mean across 11 languages [VERIFIED]
- English: 84.06 [VERIFIED]
- Odia: 66.94 (lowest) [VERIFIED]
- Kannada: [UNVERIFIED ASSUMPTION — specific Kannada score not extracted from sources; likely between 70–80 based on language resource availability]

**Comparison with competitors** [VERIFIED]:

- "Leads Sarvam-30B on the MILU benchmark across all 11 languages" [VERIFIED]
- "Leads Sarvam-105B on 10 of the 11 languages" [VERIFIED]
- Competitive with gpt-5.4-nano on Indic comprehension (79.46 vs 79.69) [VERIFIED]

**Extractive QA** [VERIFIED]:

- XQuAD-in: 64.59 F1
- XorQA-in: 41.83 F1

**Known weaknesses** [VERIFIED — HackerNoon]:

- Translation (FLORES-in: 34.52 chrF++): below competitive alternatives
- Summarization (CrossSum-in: 4.67 chrF): significantly below alternatives
- Instruction-following benchmark (IndicIFEval-trans: 47.45): moderate

**Implication for KiranaCrew**: Evon is strong for comprehension and QA (reading inventory data, understanding supplier conversations) but weaker at translation and summarization. For kirana store use cases, comprehension and instruction-following matter more than translation. [INFERRED]

### 3.3 Deployment Requirements

[VERIFIED — HuggingFace; CORRECTION NOTE [Audit Nov 1]: Evon access model confirmed as self-hosted ONLY]

| Requirement      | Specification                                              |
| ---------------- | ---------------------------------------------------------- |
| Framework        | Transformers ≥5.3.0, vLLM ≥0.12.0, or SGLang               |
| Hardware         | NVIDIA H100 80GB, H200, or A100                            |
| Operating System | Linux                                                      |
| Precision        | BF16                                                       |
| Special flag     | `trust_remote_code=True` required for Transformers loading |

**CORRECTION NOTE [Audit Nov 1]**: The official Gnani AI hackathon blog (gnani.ai/resources/blogs/great-indian-ai-internship-challenge-2026) explicitly states: **"Evon v3.3 isn't on the API platform yet: request the open weights on Hugging Face and run it yourself."** The HuggingFace model card confirms: "This model isn't deployed by any Inference Provider." [VERIFIED]

This means:

- Evon v3.3 is **NOT accessible via the gnani.ai API platform** — this was an inaccurate assumption in the original document
- The 5,000 programme credits apply **only to Prisma and Timbre** on app.gnani.ai/voice — they do NOT cover Evon inference [VERIFIED]
- Self-hosting Evon requires NVIDIA H100 80GB, H200, or A100 — cost ~$20–40/hour on cloud GPU instances [INFERRED from typical pricing]
- For a hackathon, self-hosting Evon is impractical without access to H100/A100 hardware

**REVISED recommendation for KiranaCrew architecture**: Evon cannot be used via the API platform. A fallback reasoning model is REQUIRED. See Section 3.9 for fallback options. [UPDATED — VERIFIED]

### 3.4 Tool Calling Compatibility

[VERIFIED — HuggingFace, HackerNoon]

- Tool calling is documented: "vLLM example enables automatic tool choice and configures the qwen3_coder tool-call parser" [VERIFIED]
- Tool calling is listed as a capability: "Tool-using agents — integrating with agentic systems via vLLM configuration" [VERIFIED]
- **Caveat**: "Noted limitations on multi-step agentic use" [VERIFIED]
- **No benchmark scores for tool-use success rate reported** [VERIFIED — this is explicitly noted as a gap in the HackerNoon analysis]
- Tool calling format uses qwen3_coder parser [VERIFIED]

**Implication for KiranaCrew**: Evon supports tool calling, which is required for agent-based operations (query inventory DB, place orders, check supplier status). However, the "limitations on multi-step agentic use" warning means complex multi-step tool chains may require careful prompt engineering and fallback handling. [INFERRED]

### 3.5 Licensing Model

[VERIFIED — HuggingFace]

- License: **Apache 2.0** [VERIFIED]
- Weights: Available by request on HuggingFace [VERIFIED]
- Commercial use: Permitted under Apache 2.0 [VERIFIED — standard Apache 2.0 terms]
- For hackathon: API access via programme credits [VERIFIED — gnani.ai/internship]

### 3.6 Fit with KiranaCrew's Orchestration Architecture

**Verdict: COMPATIBLE WITH ADAPTATION**

KiranaCrew's orchestration engine (OrchestrationService, TeamLead) dispatches tasks to AI agents via a gateway protocol. Currently it uses OpenClaw/Nightshift/Auggie adapters. Evon would require a new gateway adapter, likely a NightshiftGateway-style HTTP adapter calling the Gnani Evon API.

Key compatibility factors:

- Evon supports tool calling (required for executor/specialist agents) [COMPATIBLE]
- 128K context window fits KiranaCrew's handoff injection pattern (task history, evidence) [COMPATIBLE]
- Multi-step agentic limitations mean complex orchestration chains need testing [RISK]
- API must be called via Gnani's inference endpoint, not self-hosted for hackathon [COMPATIBLE — same as OpenAI-compatible HTTP adapter pattern]

### 3.7 Recommendation: Primary / Specialized / Optional

**CORRECTION NOTE [Audit Nov 1]: Original recommendation assumed Evon was accessible via API — THIS IS FALSE. Evon is self-hosted open-weights only. Recommendation revised below.**

**Revised Recommendation: CONDITIONAL USE — Evon via HuggingFace Inference API (if hardware available) OR fallback to OpenAI-compatible model**

**Option A (preferred if GPU accessible)**: Self-host Evon v3.3 via vLLM on a rented H100/A100 instance. Expose an OpenAI-compatible endpoint (`http://<host>:8000/v1`). This satisfies the "uses Gnani models" requirement. Hardware cost: ~$20–40/hour — only needed during demo recording and testing, not 24/7.

**Option B (fallback — strongly recommended)**: Use an OpenAI-compatible model (GPT-4o-mini, Gemini Flash, or Claude Haiku) as the reasoning engine. The competition requires "at least one Gnani AI model or API." Using Prisma + Timbre via the gnani.ai platform already satisfies this requirement. Evon is not mandatory for compliance.

**Rationale for Option B being the practical default**:

1. Self-hosting Evon requires H100/A100 — most hackathon participants do not have this hardware available
2. The hackathon blog does not require that all three models be used — only that at least one Gnani model is used [VERIFIED]
3. Prisma (STT) + Timbre (TTS) are on the API platform and fully accessible via the 5,000 credits
4. A fast, reliable reasoning model (GPT-4o-mini, Gemini Flash) that fits within the context of the demo is more practical

**Impact on award strategy**: Using all three Gnani models is stronger for judging ("deep platform integration") but is not a requirement. If Evon self-hosting is not feasible, disclose the fallback model transparently in the submission.

**Where Evon shines (if self-hosted)**:

- Intent classification from Kannada/Hindi voice input (after Prisma transcription)
- Inventory query reasoning
- Supplier follow-up composition
- 128K context window fits full kirana session

**Where the fallback is acceptable**:

- Any OpenAI-compatible model handles tool calling reliably for the hackathon scope

### 3.8 What is DOCUMENTED vs ASSUMED

| Claim                                           | Status                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| 30B total / 3.5B active parameters              | DOCUMENTED                                                      |
| 128K context window                             | DOCUMENTED                                                      |
| 11 Indian languages + English                   | DOCUMENTED                                                      |
| MILU 78.74 benchmark                            | DOCUMENTED                                                      |
| Tool calling via vLLM                           | DOCUMENTED                                                      |
| Multi-step agentic limitations                  | DOCUMENTED                                                      |
| H100/A100 hardware requirement                  | DOCUMENTED                                                      |
| Apache 2.0 license                              | DOCUMENTED                                                      |
| Self-hosted open-weights ONLY (no gnani.ai API) | DOCUMENTED [Audit Nov 1 — VERIFIED]                             |
| 302ms first token, 257 tokens/sec on H100       | DOCUMENTED (from search results)                                |
| Specific Kannada benchmark score                | NOT DOCUMENTED                                                  |
| Gnani.ai hosted API endpoint                    | DOES NOT EXIST as of Nov 1, 2026 [VERIFIED]                     |
| Credit cost per token for Evon                  | NOT APPLICABLE — Evon is not on the credits platform [VERIFIED] |

### 3.9 Fallback Reasoning Models (Added by Audit Nov 1)

Since Evon v3.3 is not on the API platform, the following fallback options are ranked by suitability:

| Option                      | Integration            | Tool Calling             | Indian Language           | Cost           | Hackathon Feasibility      |
| --------------------------- | ---------------------- | ------------------------ | ------------------------- | -------------- | -------------------------- |
| **Evon self-hosted (vLLM)** | OpenAI-compatible REST | YES (qwen3_coder parser) | STRONG                    | ~$20-40/hr GPU | POSSIBLE if H100 available |
| **GPT-4o-mini**             | OpenAI SDK             | STRONG                   | GOOD (English-mediated)   | Low per-token  | HIGH — API key required    |
| **Gemini 2.0 Flash**        | Google AI SDK          | STRONG                   | GOOD                      | Low per-token  | HIGH — free tier available |
| **Claude 3.5 Haiku**        | Anthropic SDK          | STRONG                   | GOOD                      | Low per-token  | HIGH — API key required    |
| **Sarvam-M (Sarvam AI)**    | OpenAI-compatible      | MODERATE                 | STRONG (Indian languages) | Low            | MEDIUM                     |

**Recommended fallback**: GPT-4o-mini or Gemini 2.0 Flash. Either provides reliable tool calling with no GPU requirements, and both handle Kannada/Hindi prompts acceptably. Disclose in submission that Evon was used for language reasoning (if self-hosted) or that a fallback model was used with justification.

---

## 4. Technical Comparison Table

| Feature                  | Prisma v2.5           | OpenAI Whisper Large | Sarvam AI Saaras            | Google Chirp       | Deepgram Nova-2    |
| ------------------------ | --------------------- | -------------------- | --------------------------- | ------------------ | ------------------ |
| Kannada support          | YES [VERIFIED]        | YES                  | YES [VERIFIED]              | YES                | Limited [INFERRED] |
| Hindi support            | YES [VERIFIED]        | YES                  | YES [VERIFIED]              | YES                | Limited [INFERRED] |
| Hinglish code-mixing     | YES [VERIFIED]        | Partial [INFERRED]   | YES [VERIFIED]              | Partial [INFERRED] | No [INFERRED]      |
| Kanglish code-mixing     | LIKELY [INFERRED]     | Unknown              | LIKELY [INFERRED]           | Unknown            | No [INFERRED]      |
| Streaming latency        | <200ms P95 [VERIFIED] | ~500ms+ [INFERRED]   | Published but not extracted | ~300ms [INFERRED]  | <300ms [INFERRED]  |
| Telephony 8kHz training  | YES [VERIFIED]        | Partial              | YES [VERIFIED]              | YES                | YES                |
| Indian regional accents  | YES [VERIFIED]        | Partial              | YES [VERIFIED]              | Partial            | Minimal            |
| API pricing for students | Hackathon credits     | Per-minute billing   | Free tier available         | Per-minute billing | Per-minute billing |
| LiveKit plugin           | YES [VERIFIED]        | No                   | YES [VERIFIED]              | Via adapter        | YES                |

| Feature             | Timbre v2.5            | Google Cloud TTS | Azure Neural TTS | ElevenLabs | Sarvam Bulbul  |
| ------------------- | ---------------------- | ---------------- | ---------------- | ---------- | -------------- |
| Kannada voices      | YES (kn-IN) [VERIFIED] | YES              | Limited          | No         | YES [INFERRED] |
| Hindi voices        | YES (hi-IN) [VERIFIED] | YES              | YES              | Limited    | YES [VERIFIED] |
| Indian prosody      | YES [VERIFIED]         | Partial          | Partial          | No         | YES [INFERRED] |
| WebSocket streaming | YES [VERIFIED]         | No (HTTP only)   | SSE              | HTTP       | Unknown        |
| Voice count         | 42 [VERIFIED]          | 30+ Indian       | 10 Indian        | N/A        | Multiple       |
| MOS on 8kHz         | 4.23 [VERIFIED]        | Unknown          | Unknown          | N/A        | Unknown        |
| Hackathon credits   | YES [VERIFIED]         | No               | No               | No         | No             |

| Feature                   | Evon v3.3                      | GPT-4o | Gemini Flash | Sarvam-30B       | Llama-3.3-70B |
| ------------------------- | ------------------------------ | ------ | ------------ | ---------------- | ------------- |
| Kannada reasoning         | YES [VERIFIED]                 | YES    | YES          | YES              | Partial       |
| MILU benchmark            | 78.74 [VERIFIED]               | N/A    | N/A          | Lower [VERIFIED] | N/A           |
| Context window            | 128K [VERIFIED]                | 128K   | 1M           | Unknown          | 128K          |
| Tool calling              | YES [VERIFIED]                 | YES    | YES          | Unknown          | YES           |
| Open weights              | YES (Apache 2.0) [VERIFIED]    | No     | No           | YES [INFERRED]   | YES           |
| Self-hostable             | YES (H100 required) [VERIFIED] | No     | No           | YES              | YES (A100)    |
| Hackathon credits         | YES [VERIFIED]                 | No     | No           | No               | No            |
| Multi-step agent (tested) | Limited [VERIFIED]             | Strong | Strong       | Unknown          | Moderate      |

---

## 5. Recommended Integration Architecture for KiranaCrew

```
Kirana Owner
    │
    │ (speaks in Kannada/Hindi/Hinglish on mobile browser)
    ▼
[Browser AudioWorklet — PCM16 capture — existing KiranaCrew pattern]
    │
    ▼
Prisma v2.5 STT API (WebSocket streaming)
    │ transcript + detected language
    ▼
[KiranaCrew Intent Router]  ──────────────────────────────────────────────────────┐
    │                                                                           │
    │ structured intent                                                         │
    ▼                                                                           │
Evon v3.3 via Gnani API  ←────────── [Kirana Context: store ID, session, stock] │
    │ (tool calls: inventory_read, order_create, supplier_query, finance_read)  │
    ▼                                                                           │
[Agent Orchestration Engine — reused from KiranaCrew]                           │
    ├── StockAgent (read inventory DB)                                          │
    ├── OrderAgent (create/confirm purchase orders)                             │
    ├── SupplierAgent (WhatsApp/SMS follow-up)                                  │
    └── FinanceAgent (daily accounts, GST summary)                              │
    │                                                                           │
    │ structured result (Kannada text)                                          │
    ▼                                                                           │
Timbre v2.5 TTS API (WebSocket streaming)                                       │
    │ audio (8kHz, OggOpus, mono)                                               │
    ▼                                                                           │
Browser Audio Playback ◄────────────────────────────────────────────────────────┘
```

**Gnani model touchpoints per voice turn:**

1. Prisma STT: Owner speaks → text transcript
2. Evon LLM: Text → intent → tool calls → structured response text
3. Timbre TTS: Response text → spoken audio output

All three models are used in every meaningful voice interaction. [INFERRED — by design for maximum award eligibility]

---

## 6. Critical Unknowns That Must Be Tested Before Committing

| Unknown                                                  | Why It Matters                                                       | Test Approach                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Kanglish (Kannada-English) accuracy                      | Core KiranaCrew use case may break if code-mixing accuracy is poor   | Record 20 Kannada-English mixed sentences; transcribe via Prisma; measure WER manually |
| Credit consumption rate                                  | 5,000 credits may run out before demo if consumption is high         | Make 10 test calls at start; calculate burn rate                                       |
| Evon tool calling reliability                            | Multi-step agent failures will break KiranaCrew workflows            | Build 5 tool-calling test scenarios; measure success rate                              |
| Timbre Kannada naturalness                               | Kirana owner must trust and understand the voice output              | Play 10 Kannada TTS samples to Kannada speakers; collect MOS rating                    |
| Evon inference latency via API                           | If P95 response time > 3s, real-time voice UX breaks                 | Measure 50 Evon API calls under representative load                                    |
| Combined pipeline round-trip time                        | Total STT + LLM + TTS latency must be < 4s for acceptable UX         | Full end-to-end timing test                                                            |
| Prisma behavior on phone audio with market noise         | Kirana stores are noisy; STT must work in-context                    | Test with recorded kirana store ambient noise                                          |
| Whether v3.0 Prisma is available under hackathon credits | v3.0 launched Oct 28, during the hackathon; unclear if credits apply | Contact Gnani AI support early                                                         |

## TTS WebSocket contract (added 2026-11-08)

Source: Gnani docs, `wss://api.vachana.ai/api/v1/tts` (Realtime TTS). Server-side only: the browser cannot set
`X-API-Key-ID` on a WebSocket upgrade, so the browser keeps using `POST /api/runtime/voice/speak-stream`.

| Step     | Wire message                                                                            | Our handling                                                      |
| -------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Connect  | upgrade header `X-API-Key-ID` (use the `ws` package, already a dependency)              | 5 s connect timeout                                               |
| Request  | `{text, voice, model, language, speed, audio_config}` as JSON; one in flight per socket | `language` in `auto`, `hi-en` or `xx-IN`; speed clamped 0.85-1.15 |
| Start    | `{type:"start", request_id}`                                                            | ignored (informational)                                           |
| Audio    | `{type:"audio", data:{chunk_index, audio(base64), is_final:false}}`                     | yield `Buffer.from(audio,"base64")`                               |
| Complete | `{type:"complete", data:{is_final:true, audio:""}}`                                     | end the stream; error if no audio was seen                        |
| Error    | `{type:"error", message}` (socket stays open)                                           | throw 502, close the socket                                       |
| Abort    | caller `AbortSignal`                                                                    | close the socket (stops upstream)                                 |

Provider contract is unchanged: `stream({text, language, voice, speed, signal}) -> AsyncGenerator<Buffer PCM16 mono @ sampleRate>`.
Selected by `GNANI_TTS_TRANSPORT=ws|sse` (default `sse` until a live latency check passes). SSE stays as the fallback.
