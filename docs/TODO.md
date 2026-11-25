# TODO

## Done: return a snapshot with actions

`browser_click`, `browser_type`, `browser_press`, `browser_navigate` and `browser_wait` take
`snapshot: true` (and `snapshotScope`). The result is the JSON receipt, then a snapshot of the page
after the action, with fresh `@refs`. The snapshot is skipped, with the reason, when a dialog is
open, the page is still loading, the agent was paused, or control changed. A failed action (such as
`USER_IN_CONTROL`) returns no snapshot.

Before the snapshot, input and navigation actions wait for the page to settle: requests started by
the action have finished and the DOM has been quiet for 120 ms (at most 1.5 s). Without this,
the first agent run got snapshots taken before the page's fetch-and-render finished. It said
"Snapshot seems to lag" and went back to separate `browser_snapshot` calls.

Found and fixed along the way:
- Chrome never reports `loadingFinished` for `fetch(..., { keepalive: true })` (event beacons), so
  those requests looked pending forever. A request now counts as done 150 ms after its response.
  This also fixes `browser_wait({ networkIdleMs })` on such pages.
- Agent clicks into a cross-site (out-of-process) iframe could land on the shield. Chrome routes
  input to those frames by the hit-test data of the last painted frame, and opening the shield for
  an agent burst did not wait for a paint. The overlay now waits for one before acking, when the
  page has iframes.

Result, one real-agent run (`node bench/agent.ts --runs 1 --only overtake`), against
`results/agent`:

| | before (2 runs) | after (1 run) |
|---|---|---|
| turns | 37, 37 | 24 |
| tool calls | 36, 36 | 23 (13 with `snapshot: true`, 1 `browser_snapshot`) |
| tool time | 3.7 s, 3.2 s | 5.2 s |
| model time | 50.8 s, 36.2 s | 51.0 s |
| wall time | 56.4 s, 41.0 s | 57.8 s |
| cost | $0.365, $0.365 | $0.346 |
| checkpoints | 10/10 | 10/10 |

Turns dropped as estimated (37 to 24); cost only slightly (about 5%). Wall time did not drop:
model time per turn went up (bigger results to read), and one run is too few to say more. A
multi-run benchmark would settle it.

## Done: `browser_run` (run a flow from one script)

Agents asked for a way to write a flow once and run it, instead of one tool call (and one model
turn) per step. `browser_run` runs a script file (or an inline script) in a worker. Each API call
goes through the same Engine methods as the tools, so real input, top-hit checks and settle all
apply. `browser_evaluate` also takes a `file`.

How the hard problems above were handled:
- Errors are thrown into the script, which may catch them. Uncaught ones fail the run with the
  step, the script line and a snapshot of the page, so the agent can fix and re-run the file.
- Hard stops (take-over, stop, Space closed, extension gone) terminate the worker at once, seen
  from errors and from control events, so a sleeping or busy script is stopped too. The script
  cannot catch them.
- Calls run one at a time in order. When a run ends, calls not started yet are dropped.
- The timeout and step limit hold even for a busy loop (the worker is terminated).

Results (`bench/agent.ts --only overtake`, 1 run each, main vs this change):

| questions | | main | browser_run |
|---|---|---|---|
| 5 | wall | 42.0 s | 43.9 s |
| 5 | turns / tool calls | 24 / 23 | 24 / 23 |
| 5 | cost | $0.365 | $0.373 |
| 20 | wall | 116.2 s | 44.1 s |
| 20 | turns / tool calls | 69 / 68 | 10 / 9 |
| 20 | cost | $0.934 | $0.257 |
| 20 | checkpoints | 25/25 | 25/25 |

On 5 questions the agent did not choose `browser_run` (stepping was simpler), so nothing changed.
On 20 it explored the first question step by step, then ran the rest from one script: 2.6x faster
and 3.6x cheaper, with every checkpoint. One run each; the direction is clear, the exact factor
is not.
