# Realistic-rounds results 2026-11-22T07-04-53

3 runs × 5 questions per mode · modes pause · Overtake headless=true · cli-browser (chromium 156.0.8078.96, node v24.22.1) [patched in after run] · Google Chrome 158.0.8127.36 · node v26.13.0

Medians / p95 are nearest-rank over runs (totals) or over every round of that name (per round). All times ms.

## Mode: pause

### Totals per run

| | wall med | wall p95 | browser med | transport med | rounds | tool calls / invocations | SDK calls inside invocations | bytes to agent (KB) | checkpoints | runs all-pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CLI browser (CLI, batched, focus=0) | 3984 | 4299 | 3346 | 620 | 4.0 | 4.0 | 15.0 | 3.7 | 9/33 (27%) | 0/3 |

### Per round (median / p95 over all runs)

| round | OT wall | OT p95 | OT browser | OT transport | OT calls | CLI wall | CLI p95 | CLI browser | CLI transport (process+connect) | CLI SDK calls | ok OT | ok CLI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| open | – | – | – | – | – | 300 | 601 | 102 | 199 | 4.0 | 0/0 | 3/3 |
| course | – | – | – | – | – | 247 | 281 | 102 | 145 | 4.0 | 0/0 | 3/3 |
| start | – | – | – | – | – | 275 | 290 | 137 | 137 | 4.0 | 0/0 | 3/3 |
| q1 | – | – | – | – | – | – | – | – | – | – | 0/0 | 0/3 |

### Per action (median / p95; Overtake = MCP call wall incl. stdio, server = handler time; CLI browser = in-process SDK call)

| step | OT wall | OT p95 | OT server | CLI | CLI p95 | n OT | n CLI |
|---|---:|---:|---:|---:|---:|---:|---:|
| connect | – | – | – | 3.1 | 72.8 | 0 | 12 |
| goto_home | – | – | – | 85.8 | 127 | 0 | 3 |
| wait_home | – | – | – | 3.7 | 82.2 | 0 | 3 |
| snapshot | – | – | – | 6.5 | 193 | 0 | 9 |
| click_course | – | – | – | 93.6 | 125 | 0 | 3 |
| wait_test | – | – | – | 1.9 | 2.3 | 0 | 3 |
| click_practice | – | – | – | 27.2 | 27.5 | 0 | 3 |
| wait_play | – | – | – | 104 | 104 | 0 | 3 |
| check_paused | – | – | – | 2.2 | 2.9 | 0 | 3 |
| click_option | – | – | – | – | – | 0 | 0 |

### Failures

- CLI browser run 1 round q1: page.click timed out after 3003ms: Selector #optList .opt[data-key=B] matched 1 elements, but none can receive input; <div id="pause"> intercepts pointer events
- CLI browser run 2 round q1: page.click timed out after 3004ms: Selector #optList .opt[data-key=B] matched 1 elements, but none can receive input; <div id="pause"> intercepts pointer events
- CLI browser run 3 round q1: page.click timed out after 3002ms: Selector #optList .opt[data-key=A] matched 1 elements, but none can receive input; <div id="pause"> intercepts pointer events
- checkpoints cli run 1: failed q1_correct, q2_correct, q3_correct, q4_correct, q5_correct, results_full_score, score_submitted, screenshot_file (page pauses: 1)
- checkpoints cli run 2: failed q1_correct, q2_correct, q3_correct, q4_correct, q5_correct, results_full_score, score_submitted, screenshot_file (page pauses: 1)
- checkpoints cli run 3: failed q1_correct, q2_correct, q3_correct, q4_correct, q5_correct, results_full_score, score_submitted, screenshot_file (page pauses: 1)

Page pause events per run: Overtake (MCP)  · CLI browser (CLI, batched, focus=0) 1/1/1

## Sentinel (6 clicks on a trivial page before each run, not part of the timed rounds)

| tool | mode | run | attempt | median click | max click |
|---|---|---:|---:|---:|---:|
| cli | pause | 1 | 0 | 1017 | 1026 |
| cli | pause | 2 | 0 | 1014 | 1027 |
| cli | pause | 3 | 0 | 30.7 | 1030 |

## Environment checks

- series pause #0: load1 6.1 → busy
- series pause #1: load1 5.83 → clean
- end: load1 5.91, other test Chrome 21 → busy

