# Benchmark: Overtake vs a CLI-driven AI browser

The same task run with Overtake and with a popular CLI-driven AI browser, each used the way its
documentation recommends. Per-round transport cost is measured, not hidden. Raw JSONL, `summary.md`,
`config.json`, a snapshot manifest and screenshots are in each `results/` folder.

Both sides ran current code in the same session on 2026-11-22, with a clean environment gate.

## Method

- **Task.** `site.mjs` serves a local, login-free practice-test app on port 8766: 5 questions, each a
  sum the agent must read before answering, with a 60 ms server delay on every question. The page
  reports each step to the server, and those checkpoints decide pass or fail for both tools
  (11 per scripted run, 10 per agent run).
- **Rounds (10).** open, course, start, q1 to q5, submit, close. Each round needs something only the
  previous observation shows. The scripted policy reads only the snapshot printed in the previous round.
  - CLI browser: one batched `<cli> nodejs` invocation per round, ending with the wait and the next
    snapshot, as its guide recommends. Only the space id and printed output carry between rounds.
  - Overtake: one MCP tool call per action over stdio, grouped into the same rounds for reporting.
    Server-side time per call comes from the MCP server's call log.
- **Real agent.** Headless Claude Code (`claude -p --output-format stream-json`), the same prompt on
  both sides except one line naming the tool, `--strict-mcp-config`, a neutral working directory and
  a $2 cap per run.
  - Overtake side: only `mcp__overtake`, pointed at the snapshot server and a throwaway Chrome.
  - CLI side: only `Bash(<cli>:*)`, `Skill` and `Read`.
  - Model and tool time are split by the arrival time of each stream line.
- **Isolation and pinning.** Overtake runs from a copied snapshot of the code (sha256 manifest per
  results folder) in a headless throwaway Chrome with its own `OVERTAKE_HOME`. It never touches the
  user's Chrome or `~/.overtake`. On the CLI side, only `rr-bench` spaces are created and closed.
- **Environment gate.** Before each series the load average is logged (gate: load1 at most 6, no
  process above 60% CPU, no other test Chrome). A sentinel (6 clicks on a trivial page) runs before each
  timed run, and CLI runs are gated on a fast sentinel.

## Results

| | Overtake (MCP) | CLI browser (batched) |
|---|---:|---:|
| **Scripted run, 5 runs (median / p95)** | **1.45 / 1.53 s** | 3.16 / 3.26 s |
| browser / transport | 1.41 s / **0.030 s** | 1.83 s / 1.31 s |
| per question round, q1 to q4 (browser + transport) | **216 ms** = 211 + 3 | 403 ms = 280 + 124 |
| pause mode (median / p95) | **1.36 / 1.40 s** | 3.20 / 3.24 s (with a focus workaround) |
| calls per run | 45 MCP calls | 10 invocations (55 SDK calls inside) |
| checkpoints (both modes) | 110/110 | 110/110 |
| **Real agent, 2 runs each** | **41.0 / 56.4 s**, $0.365 per run | 75.0 / 81.5 s, $0.47 per run |
| model time / tool time | 36 to 51 s / **3.2 to 3.7 s** | 59 to 69 s / 10.5 to 14.0 s |
| of which fixed sleeps written by the agent | 0 | 8.7 / 11.4 s |
| turns / tool calls / tool errors | 37 / 36 / 0 | 23 to 24 / 21 to 22 / 4 to 5 |
| output tokens per run | 3.2 k | 4.4 to 4.9 k |
| real-agent checkpoints | 20/20 | 20/20 |

Folders: `results/final` (scripted, both sides), `results/agent` (real agent),
`results/cli-per-action` (ablation), `results/cli-pause-as-shipped` (pause mode without workaround).

### Per action, no pause (median ms)

| action | Overtake | CLI browser |
|---|---:|---:|
| click (option / reveal / next / submit) | **17 to 25** | 21 to 26 |
| click that navigates | **57** | 90 |
| wait for selector (condition true at about 65 ms) | **69 to 73** | 103 |
| snapshot (viewport) | 11.8 | **7.1** |
| type into field | 21 | **8** |
| screenshot to file | 75 | **35** |

### Transport

| probe | Overtake | CLI browser |
|---|---:|---:|
| per call / per invocation (median, in rounds) | **0.54 ms** (p95 1.35) | 118 ms process + 2.8 ms connect |
| trivial round trip | MCP ping 0.2 ms, `evaluate "1"` 0.9 ms | `nodejs console.log(1)` 108 ms |
| session cold start | 143 ms (MCP server spawn, once) | per invocation (above) |

### Other results

- **CLI browser, one invocation per action** (ablation, 5 runs): **5.43 s median** (p95 5.67), 55/55.
  Transport is 4.72 s (45 x about 105 ms). Batching (3.16 s) is the better strategy for it, as its
  guide says.
- **Pause mode** (the page pauses when it loses focus):
  - Overtake passes with no workaround: it enables focus emulation on every agent tab.
  - The CLI browser as shipped failed all 3 runs (9/33 checkpoints): the page sees
    `visibilitychange: hidden` about 200 ms after each invocation ends. With
    `Emulation.setFocusEmulationEnabled` applied at the start of every invocation it gets 55/55.
    That workaround is the benchmark's addition, not part of its guide.
- **Real agents.** Model time dominates both sides (88 to 90% for Overtake).
  - The Overtake agent made one tool call per turn. 14 of its 36 calls were snapshots taken only to
    see a click's result. Returning a snapshot with actions would remove most of them
    ([docs/TODO.md](../docs/TODO.md)).
  - The CLI agent used about 2 invocations per question and fixed sleeps instead of condition waits.
    Its tool errors all came from the Claude Code harness (Bash safety checks on heredoc scripts),
    not from the browser.
  - Run-to-run spread is large (Overtake 41 vs 56 s, almost all model time). With n = 2, treat the
    agent rows as indicative.

## Limitations

- **Local app, not a live site:** a fixed 60 ms delay and simple pages, so absolute times are higher
  on real sites.
- **Different browsers:** Overtake ran headless Chrome 158 (1280x860, DPR 1), which avoids macOS window
  throttling. The CLI browser ran visibly in its own Chromium-based app at its own window size.
- **Shared machine:** the series ran at load1 4.3 to 5.6 on 12 cores.
- **Timing layers differ:** Overtake "browser" time includes the broker, native messaging and the
  extension. The CLI browser's is SDK call time. Overtake handler time has 1 ms resolution.
- **Small samples:** 5 scripted runs per series, so p95 of totals equals the max. Real agent: 2 runs
  per side, one model, one prompt, not interleaved.
- **Idealised batching:** scripted batching is ideal. Real agents batch less.

## Reproduce

```bash
export RR_SNAPSHOT=/path/to/snapshot   # a copy of mcp/ shared/ bridge/ dist/extension package.json keys/ node_modules
export CLI_BROWSER_BIN=<cli>           # the CLI browser under comparison (accepts `<cli> nodejs`)
node bench/run.ts --runs 5 --questions 5 --baseline 15 --out bench/results/final
node bench/agent.ts --runs 2 --budget 2 --out bench/results/agent        # about $0.85 per pair
node bench/run.ts --only cli --mode nopause --cli-strategy per-action --baseline 0 --out bench/results/cli-per-action
node bench/run.ts --only cli --mode pause --cli-focus 0 --runs 3 --baseline 0 --out bench/results/cli-pause-as-shipped
node bench/report.ts <results dir>
```

Use `--only overtake` to run the Overtake side alone.
