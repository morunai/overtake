# TODO

## Fewer agent turns: return a snapshot with actions

**Status:** not started. Planned, low risk, about an hour of work.

### Why

Each agent turn is a full round trip through the model (read context, think, call one tool). That
takes about 1–1.5 s plus tokens, while the browser action itself takes about 20 ms.

In the benchmark (`bench/REPORT.md`):
- model time was about 90% of the agent's end-to-end time (tool time 3.2–3.7 s of 41–56 s);
- 14 of the agent's 36 tool calls were `browser_snapshot` calls made only to see the result of
  the previous click.

Estimated gain on that task: about 37 → 23 turns with this change, saving 15–30 s and the
matching tokens. This is an optimisation, not a bug fix: worth doing if agent tasks feel slow or
costly in daily use.

### How

1. In `mcp/server.ts`, add an optional `snapshot: boolean` (default `false`) to `browser_click`,
   `browser_type`, `browser_press`, `browser_navigate` and `browser_wait`.
   Optionally also `snapshotScope: 'viewport' | 'full_page'`.
2. In each handler, after the action and its receipt, when `snapshot` is true, call
   `engine.snapshot(tabId, { scope })` and return it as a second text content block after the JSON
   receipt. Reuse the existing snapshot code. Refs from this snapshot replace the old ones, exactly as
   a separate `browser_snapshot` call would.
3. Skip the snapshot (and say so in the result) when the action ended in a dialog, a hard stop
   (`USER_IN_CONTROL`, `STOPPED`) or a navigation still loading.
4. Mention it in the server `INSTRUCTIONS`: "Pass `snapshot: true` when you need to see the page
   after an action, instead of a separate `browser_snapshot` call."
5. Tests (`tests/e2e/acceptance.test.ts`):
   - click with `snapshot: true` returns a snapshot containing the new state, and its `@refs` work;
   - the default result is unchanged;
   - no snapshot is returned after a takeover.
6. Verify with one real-agent run (`node bench/agent.ts --runs 1 --only overtake`, about $0.40)
   and compare turns and tool calls against `results/agent`. No full benchmark needed.

### Not now: `browser_batch`

A tool running several actions plus a final wait and snapshot could cut turns further (estimate:
37 → ~12). It also brings harder problems:
- partial failure and error reporting mid-batch;
- applying the hard-stop rules when the human takes over inside a batch;
- the model planning several steps blind. In the benchmark, the batching agent on the other side
  fell back to fixed sleeps.

Reconsider after the snapshot option is in use.
