# Latency baseline (today=2026-11-08, rounds=3, warm=2)

| Question            | Cold p50 / p95 ms | Warm p50 / p95 ms | Governed calls | hvgerp calls cold / warm | Warm cache hit | >20 s | Failures | Fingerprint      |
| ------------------- | ----------------- | ----------------- | -------------- | ------------------------ | -------------- | ----- | -------- | ---------------- |
| Simple stock check  | 7631 / 8368       | 11 / 33           | 2              | 54 / 1                   | 1              | 0     | 0        | af2093df35fdad25 |
| Daily sales         | 5158 / 6490       | 12 / 44           | 3              | 55 / 2                   | 1              | 0     | 0        | 922d80606973bd4e |
| Receivables         | 1057 / 1063       | 10 / 17           | 1              | 2 / 2                    | -              | 0     | 0        | 9ab109737acef1ad |
| Demand forecast     | 29541 / 33433     | 627 / 1522        | 31             | 600 / 47                 | 1              | 3     | 0        | cc53d86b04254f1c |
| Store health report | 12577 / 13336     | 121 / 223         | 9              | 137 / 13                 | 1              | 0     | 9        | fed341838491ef88 |

TTS first chunk p50/p95 ms — SSE 506/695, WS 493/514
