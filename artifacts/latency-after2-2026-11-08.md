# Latency after2 (today=2026-11-08, rounds=3, warm=2)

| Question | Cold p50 / p95 ms | Warm p50 / p95 ms | Governed calls | hvgerp calls cold / warm | Warm cache hit | >20 s | Failures | Partial | Fingerprint |
|---|---|---|---|---|---|---|---|---|---|
| Simple stock check | 6540 / 8346 | 10 / 21 | 2 | 54 / 1 | 1 | 0 | 0 | 0 | af2093df35fdad25 |
| Daily sales | 6753 / 8636 | 10 / 20 | 3 | 55 / 2 | 1 | 0 | 0 | 0 | 922d80606973bd4e |
| Receivables | 1100 / 1247 | 9 / 19 | 1 | 2 / 2 | - | 0 | 0 | 0 | 9ab109737acef1ad |
| Demand forecast | 11309 / 13764 | 218 / 252 | 31 | 600 / 47 | 1 | 0 | 0 | 0 | cc53d86b04254f1c |
| Store health report | 8200 / 12858 | 119 / 159 | 9 | 84 / 13 | 1 | 0 | 0 | 9 | fed341838491ef88 |

TTS first chunk p50/p95 ms — SSE 396/653, WS 438/444