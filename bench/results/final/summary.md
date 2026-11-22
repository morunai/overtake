# Realistic-rounds results 2026-11-22T08-29-34

5 runs × 5 questions per mode · modes nopause, pause · Overtake headless=true · cli-browser · Google Chrome 158.0.8127.36 · node v26.13.0

Medians / p95 are nearest-rank over runs (totals) or over every round of that name (per round). All times ms.

## Mode: nopause

### Totals per run

| | wall med | wall p95 | browser med | transport med | rounds | tool calls / invocations | SDK calls inside invocations | bytes to agent (KB) | checkpoints | runs all-pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Overtake (MCP) | 1452 | 1527 | 1412 | 29.9 | 10.0 | 45.0 | – | 12.0 | 55/55 (100%) | 5/5 |
| CLI browser (CLI, batched) | 3157 | 3257 | 1833 | 1313 | 10.0 | 10.0 | 55.0 | 9.1 | 55/55 (100%) | 5/5 |

### Per round (median / p95 over all runs)

| round | OT wall | OT p95 | OT browser | OT transport | OT calls | CLI wall | CLI p95 | CLI browser | CLI transport (process+connect) | CLI SDK calls | ok OT | ok CLI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| open | 100.0 | 122 | 93.0 | 6.5 | 3.0 | 351 | 377 | 122 | 233 | 4.0 | 5/5 | 5/5 |
| course | 77.2 | 85.1 | 74.0 | 2.3 | 3.0 | 220 | 235 | 97.2 | 120 | 4.0 | 5/5 | 5/5 |
| start | 103 | 133 | 102 | 1.1 | 3.0 | 245 | 256 | 130 | 115 | 4.0 | 5/5 | 5/5 |
| q1 | 223 | 242 | 219 | 3.3 | 6.0 | 401 | 408 | 284 | 116 | 7.0 | 5/5 | 5/5 |
| q2 | 219 | 230 | 214 | 3.9 | 6.0 | 406 | 420 | 278 | 131 | 7.0 | 5/5 | 5/5 |
| q3 | 200 | 218 | 196 | 3.3 | 6.0 | 407 | 414 | 278 | 128 | 7.0 | 5/5 | 5/5 |
| q4 | 216 | 219 | 211 | 3.6 | 6.0 | 402 | 425 | 279 | 125 | 7.0 | 5/5 | 5/5 |
| q5 | 133 | 158 | 129 | 2.9 | 6.0 | 310 | 316 | 177 | 129 | 7.0 | 5/5 | 5/5 |
| submit | 147 | 157 | 143 | 3.0 | 5.0 | 307 | 322 | 181 | 122 | 6.0 | 5/5 | 5/5 |
| close | 18.3 | 26.0 | 17.0 | 0.9 | 1.0 | 120 | 128 | 2.3 | 117 | 2.0 | 5/5 | 5/5 |

### Per action (median / p95; Overtake = MCP call wall incl. stdio, server = handler time; CLI browser = in-process SDK call)

| step | OT wall | OT p95 | OT server | CLI | CLI p95 | n OT | n CLI |
|---|---:|---:|---:|---:|---:|---:|---:|
| spaces_create | 48.8 | 69.7 | 44.0 | – | – | 5 | 0 |
| wait_home | 31.3 | 58.3 | 31.0 | 2.9 | 10.3 | 5 | 5 |
| snapshot | 11.8 | 17.4 | 11.0 | 7.1 | 10.7 | 45 | 45 |
| click_course | 57.5 | 62.2 | 57.0 | 90.2 | 97.2 | 5 | 5 |
| wait_test | 3.4 | 9.0 | 3.0 | 1.6 | 3.6 | 5 | 5 |
| click_practice | 20.5 | 35.2 | 20.0 | 20.2 | 22.4 | 5 | 5 |
| wait_play | 72.9 | 73.3 | 72.0 | 103 | 104 | 5 | 5 |
| click_option | 20.0 | 32.1 | 19.0 | 21.3 | 25.1 | 25 | 25 |
| click_reveal | 16.8 | 26.9 | 16.0 | 24.5 | 25.3 | 25 | 25 |
| wait_reveal | 69.6 | 73.7 | 69.0 | 103 | 104 | 25 | 25 |
| click_next | 24.8 | 30.6 | 24.0 | 21.1 | 23.4 | 25 | 25 |
| wait_next | 69.1 | 70.2 | 69.0 | 103 | 105 | 25 | 25 |
| type_name | 21.2 | 24.7 | 21.0 | 8.2 | 17.5 | 5 | 5 |
| click_submit | 17.0 | 24.5 | 16.0 | 25.8 | 30.0 | 5 | 5 |
| wait_saved | 24.1 | 26.0 | 23.0 | 103 | 104 | 5 | 5 |
| screenshot | 75.0 | 80.0 | 75.0 | 35.5 | 41.2 | 5 | 5 |
| close | 18.0 | 25.8 | 17.0 | 2.3 | 3.3 | 5 | 5 |
| connect | – | – | – | 2.8 | 107 | 0 | 50 |
| goto_home | – | – | – | 99.8 | 110 | 0 | 5 |

## Mode: pause

### Totals per run

| | wall med | wall p95 | browser med | transport med | rounds | tool calls / invocations | SDK calls inside invocations | bytes to agent (KB) | checkpoints | runs all-pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Overtake (MCP) | 1362 | 1397 | 1331 | 26.6 | 10.0 | 45.0 | – | 11.9 | 55/55 (100%) | 5/5 |
| CLI browser (CLI, batched) | 3200 | 3238 | 1867 | 1322 | 10.0 | 10.0 | 70.0 | 10.1 | 55/55 (100%) | 5/5 |

### Per round (median / p95 over all runs)

| round | OT wall | OT p95 | OT browser | OT transport | OT calls | CLI wall | CLI p95 | CLI browser | CLI transport (process+connect) | CLI SDK calls | ok OT | ok CLI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| open | 98.7 | 104 | 93.0 | 5.2 | 3.0 | 347 | 356 | 120 | 215 | 5.0 | 5/5 | 5/5 |
| course | 59.8 | 67.2 | 58.0 | 1.7 | 3.0 | 220 | 229 | 104 | 116 | 5.0 | 5/5 | 5/5 |
| start | 99.2 | 114 | 97.0 | 1.8 | 3.0 | 251 | 262 | 138 | 115 | 5.0 | 5/5 | 5/5 |
| q1 | 200 | 217 | 196 | 2.6 | 6.0 | 402 | 411 | 285 | 116 | 9.0 | 5/5 | 5/5 |
| q2 | 211 | 218 | 207 | 3.0 | 6.0 | 411 | 416 | 285 | 126 | 9.0 | 5/5 | 5/5 |
| q3 | 199 | 224 | 197 | 4.4 | 6.0 | 407 | 428 | 281 | 127 | 9.0 | 5/5 | 5/5 |
| q4 | 202 | 215 | 198 | 2.7 | 6.0 | 416 | 428 | 281 | 134 | 9.0 | 5/5 | 5/5 |
| q5 | 133 | 135 | 129 | 2.9 | 6.0 | 310 | 337 | 189 | 121 | 9.0 | 5/5 | 5/5 |
| submit | 143 | 158 | 140 | 2.4 | 5.0 | 301 | 311 | 183 | 122 | 7.0 | 5/5 | 5/5 |
| close | 11.9 | 31.5 | 12.0 | -0.0 | 1.0 | 124 | 134 | 5.3 | 120 | 3.0 | 5/5 | 5/5 |

### Per action (median / p95; Overtake = MCP call wall incl. stdio, server = handler time; CLI browser = in-process SDK call)

| step | OT wall | OT p95 | OT server | CLI | CLI p95 | n OT | n CLI |
|---|---:|---:|---:|---:|---:|---:|---:|
| spaces_create | 51.3 | 58.0 | 48.0 | – | – | 5 | 0 |
| wait_home | 33.5 | 37.2 | 33.0 | 2.9 | 6.0 | 5 | 5 |
| snapshot | 11.5 | 16.5 | 11.0 | 6.6 | 10.4 | 45 | 45 |
| click_course | 45.1 | 48.9 | 44.0 | 94.4 | 97.1 | 5 | 5 |
| wait_test | 2.2 | 3.7 | 2.0 | 1.6 | 1.7 | 5 | 5 |
| click_practice | 21.9 | 30.5 | 21.0 | 24.1 | 25.5 | 5 | 5 |
| wait_play | 66.7 | 72.3 | 66.0 | 103 | 104 | 5 | 5 |
| click_option | 19.9 | 28.7 | 19.0 | 19.1 | 24.1 | 25 | 25 |
| click_reveal | 15.9 | 19.4 | 16.0 | 24.5 | 25.6 | 25 | 25 |
| wait_reveal | 69.1 | 71.6 | 68.0 | 104 | 104 | 25 | 25 |
| click_next | 15.0 | 29.0 | 15.0 | 21.6 | 23.1 | 25 | 25 |
| wait_next | 69.0 | 70.7 | 68.0 | 103 | 104 | 25 | 25 |
| type_name | 22.6 | 24.3 | 22.0 | 6.2 | 6.9 | 5 | 5 |
| click_submit | 14.4 | 15.3 | 14.0 | 29.9 | 31.1 | 5 | 5 |
| wait_saved | 24.5 | 25.6 | 24.0 | 103 | 103 | 5 | 5 |
| screenshot | 67.7 | 82.5 | 67.0 | 33.3 | 39.3 | 5 | 5 |
| close | 11.7 | 31.4 | 12.0 | 1.5 | 1.9 | 5 | 5 |
| connect | – | – | – | 2.8 | 96.3 | 0 | 50 |
| focus_emulation | – | – | – | 3.7 | 26.5 | 0 | 50 |
| goto_home | – | – | – | 85.8 | 92.5 | 0 | 5 |
| check_paused | – | – | – | 0.8 | 1.1 | 0 | 25 |

Page pause events per run: Overtake (MCP) 0/0/0/0/0 · CLI browser (CLI, batched) 0/0/0/0/0

## Transport baselines

| probe | median | p95 | n |
|---|---:|---:|---:|
| overtake:mcp_ping | 0.2 | 0.6 | 15 |
| overtake:spaces_list | 0.7 | 3.0 | 15 |
| overtake:evaluate_1 | 0.9 | 17.5 | 15 |
| cli:cli_noop | 108 | 126 | 15 |
| cli:cli_taskspace_url | 108 | 197 | 15 |
| cli:sdk_evaluate_1 | 1.9 | 3.0 | 15 |
| overtake:cold_start (MCP server spawn + initialize, once per session) | 143 | 161 | 10 |

## Sentinel (6 clicks on a trivial page before each run, not part of the timed rounds)

| tool | mode | run | attempt | median click | max click |
|---|---|---:|---:|---:|---:|
| overtake | nopause | 1 | 0 | 17.4 | 49.4 |
| cli | nopause | 1 | 0 | 25.1 | 33.4 |
| cli | nopause | 2 | 0 | 24.5 | 29.5 |
| overtake | nopause | 2 | 0 | 16.9 | 31.4 |
| overtake | nopause | 3 | 0 | 17.6 | 35.6 |
| cli | nopause | 3 | 0 | 24.7 | 25.3 |
| cli | nopause | 4 | 0 | 24.9 | 29.7 |
| overtake | nopause | 4 | 0 | 18.4 | 33.7 |
| overtake | nopause | 5 | 0 | 16.5 | 29.9 |
| cli | nopause | 5 | 0 | 24.3 | 26.4 |
| overtake | pause | 1 | 0 | 16.8 | 30.6 |
| cli | pause | 1 | 0 | 23.9 | 26.2 |
| cli | pause | 2 | 0 | 25.2 | 28.9 |
| overtake | pause | 2 | 0 | 16.3 | 34.0 |
| overtake | pause | 3 | 0 | 16.5 | 31.0 |
| cli | pause | 3 | 0 | 24.2 | 25.9 |
| cli | pause | 4 | 0 | 24.5 | 25.7 |
| overtake | pause | 4 | 0 | 18.3 | 33.4 |
| overtake | pause | 5 | 0 | 16.6 | 28.9 |
| cli | pause | 5 | 0 | 24.4 | 25.6 |

## Environment checks

- baselines #0: load1 5.46 → clean
- series nopause #0: load1 5.58 → clean
- series pause #0: load1 5.15 → clean
- end: load1 4.26 → clean

