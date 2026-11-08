# Latency after (today=2026-11-08, rounds=3, warm=2)

| Question | Cold p50 / p95 ms | Warm p50 / p95 ms | Governed calls | hvgerp calls cold / warm | Warm cache hit | >20 s | Failures | Partial | Fingerprint |
|---|---|---|---|---|---|---|---|---|---|
| Simple stock check | 6273 / 8534 | 11 / 22 | 2 | 54 / 1 | 1 | 0 | 0 | 0 | af2093df35fdad25 |
| Daily sales | 8472 / 8977 | 13 / 21 | 3 | 55 / 2 | 1 | 0 | 0 | 0 | 922d80606973bd4e |
| Receivables | 2172 / 2269 | 9 / 16 | 1 | 2 / 2 | - | 0 | 0 | 0 | 9ab109737acef1ad |
| Demand forecast | 15807 / 19940 | 300 / 2527 | 31 | 600 / 47 | 1 | 0 | 0 | 0 | cc53d86b04254f1c |
| Store health report | 6421 / 8442 | 161 / 317 | 9 | 84 / 13 | 1 | 0 | 0 | 9 | fed341838491ef88 |

TTS first chunk p50/p95 ms — SSE 608/807, WS 472/570