# Latency phase1b (today=2026-11-08, rounds=3, warm=2)

| Question            | Cold p50 / p95 ms | Warm p50 / p95 ms | Governed calls | hvgerp calls cold / warm | Warm cache hit | >20 s | Failures | Partial | Fingerprint      |
| ------------------- | ----------------- | ----------------- | -------------- | ------------------------ | -------------- | ----- | -------- | ------- | ---------------- |
| Simple stock check  | 7868 / 7978       | 6 / 10            | 2              | 54 / 1                   | 1              | 0     | 0        | 0       | af2093df35fdad25 |
| Daily sales         | 7848 / 8162       | 8 / 12            | 3              | 55 / 2                   | 1              | 0     | 0        | 0       | 922d80606973bd4e |
| Receivables         | 662 / 669         | 6 / 8             | 1              | 2 / 2                    | -              | 0     | 0        | 0       | 9ab109737acef1ad |
| Demand forecast     | 8279 / 8541       | 146 / 150         | 31             | 600 / 47                 | 1              | 0     | 0        | 0       | cc53d86b04254f1c |
| Store health report | 5912 / 11281      | 125 / 231         | 9              | 84 / 13                  | 1              | 0     | 0        | 9       | fed341838491ef88 |

TTS: set BENCH_TTS=1
