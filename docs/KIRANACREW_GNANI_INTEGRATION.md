# Gnani AI Integration

**KiranaCrew · Great Indian AI Internship Challenge 2026**

This document explains how Gnani AI voice models are integrated into KiranaCrew, what is fully implemented, what is planned, and exactly how to configure each component. Source code is the sole source of truth. Every status claim cites a specific file and line.

---

## Why Gnani Models Were Chosen

India's kirana store owners speak Kannada, Hindi, Marathi, Telugu, and dozens of regional languages. General-purpose speech platforms optimized for English or Mandarin produce high error rates on Indian-language audio, especially in a noisy retail environment with background music, customer conversations, and traffic.

Gnani AI was built for this exact problem. The Prisma v2.5 model is trained on Indian-language data with awareness of code-switching (Hinglish, Kannada-English mixing) that is the natural speech pattern of urban shopkeepers. This makes it the right technical choice, not a branding decision.

---

## Prisma v2.5 STT [IMPLEMENTED — API KEY REQUIRED]

### Integration Path

The STT integration lives entirely in `lib/server/stt.mjs`. The function `gnaniProvider()` constructs a provider object that the rest of the system calls through a uniform `transcribe({ bytes, mime, language })` interface.

```javascript
// lib/server/stt.mjs — the gnaniProvider implementation

const GNANI_URL = "https://api.vachana.ai/stt/v3";
const GNANI_TIMEOUT_MS = 60_000;

export function gnaniProvider({ apiKey, fetchImpl = fetch, url = GNANI_URL } = {}) {
  if (!apiKey) throw fail(503, "GNANI_API_KEY is not configured.");
  return {
    name: "gnani-prisma",
    verifiesRecognition: true,
    async transcribe({ bytes, mime, language }) {
      const form = new FormData();
      form.set("audio_file", new Blob([bytes], { type: mime }), "audio");
      form.set("format", "transcribe");
      if (language) {
        form.set("language_code", language);
        form.set("preferred_language", language);
      }
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "X-API-Key-ID": apiKey },
        body: form,
        signal: AbortSignal.timeout(GNANI_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success === false)
        throw fail(502, `Gnani STT rejected the request (HTTP ${response.status}).`);
      return {
        transcript: transcriptOf(body?.transcript, "Gnani"),
        provider: "gnani-prisma",
        requestId: typeof body?.request_id === "string" ? body.request_id : undefined,
      };
    },
  };
}
```

The provider is selected at startup by `createSttProvider()`, which reads `AGENT_TOWN_STT_PROVIDER` from the environment:

```javascript
export function createSttProvider(env = process.env, overrides = {}) {
  const name = env.AGENT_TOWN_STT_PROVIDER?.trim();
  if (!name) return null; // No provider → POST /api/tasks/voice returns 503
  if (name === "gnani") return gnaniProvider({ apiKey: env.GNANI_API_KEY, ...overrides });
  if (name === "gemini") return geminiProvider({ apiKey: env.GEMINI_API_KEY, ...overrides });
  if (name === "fixture") return fixtureProvider(env.AGENT_TOWN_STT_FIXTURE_TRANSCRIPT);
  throw new Error(`Unknown AGENT_TOWN_STT_PROVIDER: ${name}`);
}
```

### Languages Supported

| Language code | Language                           |
| ------------- | ---------------------------------- |
| `kn-IN`       | Kannada                            |
| `hi-IN`       | Hindi                              |
| `en-IN`       | Indian English / Hinglish          |
| `indic-auto`  | Automatic Indic language detection |

The `LANGUAGE` regex in `stt.mjs` validates the `language` field:

```javascript
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^indic-auto$/;
```

### Supported Audio Formats

The following MIME types are accepted (validated by `validAudio()` in `stt.mjs`):

```
audio/wav, audio/x-wav, audio/wave
audio/mpeg, audio/mp3
audio/ogg
audio/flac
audio/aac
audio/mp4, audio/x-m4a
audio/webm
```

Maximum audio size: 5 MB.

### How to Configure GNANI_API_KEY

1. Create a developer account at [gnani.ai](https://gnani.ai) and obtain an API key for Prisma v2.5.
2. In `.env.local`:
   ```env
   AGENT_TOWN_STT_PROVIDER=gnani
   GNANI_API_KEY=your_gnani_api_key_here
   GNANI_LANGUAGE=kn-IN
   ```
3. The `GNANI_API_KEY` is passed as the `X-API-Key-ID` HTTP header. It never leaves the server.
4. Restart the server with `pnpm dev`. Voice tasks will now route through Gnani Prisma.

**Why the `.env.example` marks this as "NOT WIRED YET":** The `.env.example` comment means the API key variable is not set by default — the code is complete, but activation requires a real key. The note reads: _"Names only; confirm exact variables and endpoints from your Gnani developer account before use."_

### Example Kannada Interaction

```
Input audio:   "Haalina aur chawal ka stock check karo." (Kannada/Hindi mix)
STT transcript: "Haalina aur chawal ka stock check karo."

Voice router:   intent = "check_stock"
                products = ["haalu", "chawal"]

Inventory step: erp.items.list → finds MILK-500 (Milk 500ml), RICE-1KG (Basmati Rice 1kg)
                erp.stock.balance → MILK-500: 18 units, RICE-1KG: 45 units

Calculation:    MILK-500: reorder_level=20, available=18 → LOW, recommend buying 22
                RICE-1KG: reorder_level=30, available=45 → OK

Voice contract: {
  facts: [
    "Milk 500ml: 18 units in stock, reorder level 20 (low).",
    "Basmati Rice 1kg: 45 units in stock, reorder level 30."
  ],
  recommendations: ["Buy 22 Milk 500ml."],
  speak_rule: "Say only these facts..."
}

TTS output:    [PLANNED — Gnani Timbre would speak this in Kannada]
```

---

## Timbre v2.5 TTS [PLANNED]

**Status: No `tts.mjs` file exists in the repository. The `.env.example` reserves `GNANI_TTS_URL` and `GNANI_TTS_VOICE` but marks the entire section as "NOT WIRED YET."**

### What Needs to Be Built

A `lib/server/tts.mjs` file following the same provider pattern as `stt.mjs`:

```javascript
// lib/server/tts.mjs — PLANNED
const GNANI_TTS_TIMEOUT_MS = 30_000;

export function timbreProvider({ apiKey, url, voice, fetchImpl = fetch } = {}) {
  if (!apiKey) throw fail(503, "GNANI_API_KEY is not configured for TTS.");
  return {
    name: "gnani-timbre",
    async synthesize({ text, language }) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "X-API-Key-ID": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, language_code: language, voice }),
        signal: AbortSignal.timeout(GNANI_TTS_TIMEOUT_MS),
      });
      if (!response.ok)
        throw fail(502, `Gnani TTS rejected the request (HTTP ${response.status}).`);
      const audio = Buffer.from(await response.arrayBuffer());
      return { audio, mimeType: "audio/wav", provider: "gnani-timbre" };
    },
  };
}

export function createTtsProvider(env = process.env) {
  const provider = env.AGENT_TOWN_TTS_PROVIDER?.trim();
  if (!provider) return null;
  if (provider === "gnani")
    return timbreProvider({
      apiKey: env.GNANI_API_KEY,
      url: env.GNANI_TTS_URL,
      voice: env.GNANI_TTS_VOICE,
    });
  throw new Error(`Unknown AGENT_TOWN_TTS_PROVIDER: ${provider}`);
}
```

### Planned Architecture

The voice router in `voice-router.mjs` already structures results as `facts`, `recommendations`, and `limitations` string arrays — these are designed to be passed directly to Timbre for synthesis. No reformatting is needed once the TTS provider is wired.

```
VoiceRouter.result() → { facts: string[], recommendations: string[] }
  → timbreProvider.synthesize({ text: facts.join(" "), language: "kn-IN" })
  → audio buffer
  → streamed back to browser voice client
```

### Environment Variables Required (Planned)

```env
AGENT_TOWN_TTS_PROVIDER=gnani
GNANI_TTS_URL=https://api.gnani.ai/tts/v1    # confirm from Gnani developer docs
GNANI_TTS_VOICE=your_voice_id
GNANI_API_KEY=your_gnani_api_key             # shared with STT
```

---

## Evon v3.3 [PLANNED — SELF-HOSTED ONLY]

Gnani Evon v3.3 is an open-weights speech foundation model that can be self-hosted for maximum accuracy and data sovereignty.

**Why it is marked planned:**

- Evon requires H100 or A100 GPU hardware for inference. This is not a cloud API.
- It is not referenced anywhere in the current codebase.
- Self-hosting would require a separate inference endpoint, model weight download via NGC, and a custom adapter in `stt.mjs`.

**Hardware requirements (approximate):**

- NVIDIA H100 (80 GB) or A100 (40 GB or 80 GB)
- 100+ GB NVMe storage for model weights
- Docker or Kubernetes for the NIM container

**Integration path when hardware is available:**

1. Download model via NGC: `docker pull nvcr.io/nvidia/gnani/evon:v3.3-nim`
2. Expose a REST/gRPC inference endpoint
3. Add `evonProvider()` to `lib/server/stt.mjs` pointing at the local endpoint
4. Set `AGENT_TOWN_STT_PROVIDER=evon` in `.env.local`

---

## Configuration Checklist

Use this checklist to verify the Gnani integration before a demo:

### For Gnani Prisma STT (available today)

- [ ] Gnani developer account created at gnani.ai
- [ ] API key for Prisma v2.5 obtained
- [ ] `AGENT_TOWN_STT_PROVIDER=gnani` set in `.env.local`
- [ ] `GNANI_API_KEY=your_key` set in `.env.local` (server-side only, never commit)
- [ ] Server restarted with `pnpm dev`
- [ ] Test with: `curl -X POST http://localhost:3000/api/tasks/voice -F "audio=@test.wav" -F "language=kn-IN"`
- [ ] Response includes `"provider": "gnani-prisma"` and a non-empty `transcript`

### For Gemini STT fallback (no Gnani key needed)

- [ ] `AGENT_TOWN_STT_PROVIDER=gemini` set
- [ ] `GEMINI_API_KEY=your_key` set

### For fixture STT (demo without any API key)

- [ ] `AGENT_TOWN_STT_PROVIDER=fixture` set
- [ ] Optional: `AGENT_TOWN_STT_FIXTURE_TRANSCRIPT="Check the stock of milk."` to fix the transcript

### For Gnani Timbre TTS [PLANNED — not yet available]

- [ ] Write `lib/server/tts.mjs` with `timbreProvider()` (see template above)
- [ ] Set `AGENT_TOWN_TTS_PROVIDER=gnani`, `GNANI_TTS_URL`, `GNANI_TTS_VOICE`
- [ ] Wire TTS provider into the voice response path
