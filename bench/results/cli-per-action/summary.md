# Realistic-rounds results 2026-11-22T08-33-46

5 runs × 5 questions per mode · modes nopause · Overtake headless=true · cli-browser · Google Chrome 158.0.8127.36 · node v26.13.0

Medians / p95 are nearest-rank over runs (totals) or over every round of that name (per round). All times ms.

## Mode: nopause

### Totals per run

| | wall med | wall p95 | browser med | transport med | rounds | tool calls / invocations | SDK calls inside invocations | bytes to agent (KB) | checkpoints | runs all-pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CLI browser (CLI, per-action) | 5425 | 5665 | 706 | 4718 | 10.0 | 45.0 | 90.0 | 13.6 | 55/55 (100%) | 5/5 |

### Per round (median / p95 over all runs)

| round | OT wall | OT p95 | OT browser | OT transport | OT calls | CLI wall | CLI p95 | CLI browser | CLI transport (process+connect) | CLI SDK calls | ok OT | ok CLI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| open | – | – | – | – | – | 555 | 618 | 112 | 449 | 6.0 | 0/0 | 5/5 |
| course | – | – | – | – | – | 432 | 466 | 99.8 | 331 | 6.0 | 0/0 | 5/5 |
| start | – | – | – | – | – | 341 | 366 | 32.5 | 310 | 6.0 | 0/0 | 5/5 |
| q1 | – | – | – | – | – | 686 | 703 | 76.6 | 610 | 12.0 | 0/0 | 5/5 |
| q2 | – | – | – | – | – | 662 | 740 | 80.9 | 584 | 12.0 | 0/0 | 5/5 |
| q3 | – | – | – | – | – | 688 | 715 | 77.0 | 609 | 12.0 | 0/0 | 5/5 |
| q4 | – | – | – | – | – | 678 | 697 | 77.5 | 596 | 12.0 | 0/0 | 5/5 |
| q5 | – | – | – | – | – | 691 | 697 | 79.4 | 608 | 12.0 | 0/0 | 5/5 |
| submit | – | – | – | – | – | 582 | 601 | 75.8 | 497 | 10.0 | 0/0 | 5/5 |
| close | – | – | – | – | – | 116 | 126 | 2.4 | 114 | 2.0 | 0/0 | 5/5 |

### Per action (median / p95; Overtake = MCP call wall incl. stdio, server = handler time; CLI browser = in-process SDK call)

| step | OT wall | OT p95 | OT server | CLI | CLI p95 | n OT | n CLI |
|---|---:|---:|---:|---:|---:|---:|---:|
| connect | – | – | – | 2.6 | 3.3 | 0 | 225 |
| goto_home | – | – | – | 101 | 108 | 0 | 5 |
| wait_home | – | – | – | 3.1 | 4.2 | 0 | 5 |
| snapshot | – | – | – | 6.8 | 9.3 | 0 | 45 |
| click_course | – | – | – | 90.6 | 91.8 | 0 | 5 |
| wait_test | – | – | – | 3.0 | 3.5 | 0 | 5 |
| click_practice | – | – | – | 23.8 | 25.1 | 0 | 5 |
| wait_play | – | – | – | 2.7 | 3.3 | 0 | 5 |
| click_option | – | – | – | 22.5 | 24.7 | 0 | 25 |
| click_reveal | – | – | – | 21.9 | 23.9 | 0 | 25 |
| wait_reveal | – | – | – | 3.0 | 3.6 | 0 | 25 |
| click_next | – | – | – | 22.0 | 24.7 | 0 | 25 |
| wait_next | – | – | – | 3.0 | 3.5 | 0 | 25 |
| type_name | – | – | – | 7.2 | 7.6 | 0 | 5 |
| click_submit | – | – | – | 23.2 | 25.7 | 0 | 5 |
| wait_saved | – | – | – | 3.2 | 3.4 | 0 | 5 |
| screenshot | – | – | – | 33.9 | 43.9 | 0 | 5 |
| close | – | – | – | 2.4 | 2.9 | 0 | 5 |

## Sentinel (6 clicks on a trivial page before each run, not part of the timed rounds)

| tool | mode | run | attempt | median click | max click |
|---|---|---:|---:|---:|---:|
| cli | nopause | 1 | 0 | 24.5 | 25.6 |
| cli | nopause | 2 | 0 | 24.5 | 25.6 |
| cli | nopause | 3 | 0 | 24.4 | 28.6 |
| cli | nopause | 4 | 0 | 24.2 | 27.1 |
| cli | nopause | 5 | 0 | 24.9 | 26.0 |

## Environment checks

- series nopause #0: load1 4.34 → clean
- end: load1 4.87 → clean

