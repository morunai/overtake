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

### Not now: `browser_batch`

A tool running several actions plus a final wait and snapshot could cut turns further (estimate:
37 → ~12). It also brings harder problems:
- partial failure and error reporting mid-batch;
- applying the hard-stop rules when the human takes over inside a batch;
- the model planning several steps blind. In the benchmark, the batching agent on the other side
  fell back to fixed sleeps.

Reconsider after the snapshot option is in use.
