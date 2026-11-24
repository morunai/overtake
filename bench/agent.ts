// Real-agent benchmark: headless Claude Code completes the same quiz task once with the
// Overtake MCP server (isolated: pinned snapshot + throwaway Chrome/OVERTAKE_HOME) and once with
// the CLI browser via Bash.
//
//   node bench/agent.ts [--runs 1] [--only overtake|cli] [--budget 2] [--model M]
//
// Measures end-to-end wall time, model vs tool time (from arrival times of stream-json lines),
// turns, tool calls, tokens and cost; checkpoints come from the quiz server as in run.ts.
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { startQuizServer, checkpoints } from './site.mjs';
import { OvertakeEnv } from './overtake-env.ts';

const CLI_BIN = process.env.CLI_BROWSER_BIN || 'cli-browser'; // the batching CLI browser under comparison

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt('runs', '1'));
const FIRST = Number(opt('first', '1'));
const ONLY = opt('only', '');
const BUDGET = opt('budget', '2');
const MODEL = opt('model', '');
const PORT = Number(opt('port', '8769'));
const SITE = `http://127.0.0.1:${PORT}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve(opt('out', join(import.meta.dirname, 'results', `agent-${stamp}`)));
const SCRATCH = join(tmpdir(), 'overtake-bench');
const CWD = join(SCRATCH, 'agent-cwd'); // neutral cwd: no project CLAUDE.md / .mcp.json
mkdirSync(OUT, { recursive: true });
mkdirSync(CWD, { recursive: true });
const NAME = 'rr-bench-agent';

function prompt(tool: 'overtake' | 'cli', run: string, spaceName: string) {
  const how = tool === 'overtake'
    ? 'Use the Overtake browser tools (MCP) for all browser work.'
    : `Use the ${CLI_BIN} CLI through Bash for all browser work (load its skill first and follow it).`;
  return `${how}
Task: open ${SITE}/r/${run}/ in a new browser space named "${spaceName}" (only create and use that one space; do not touch any other space).
Open "WEB-101 Practice Test 01", start Practice mode (the button that mentions "Reveal the answer"), and answer all 5 questions correctly: each question asks for a sum; pick the option with the correct value, click "Show answer", then go to the next question. If the page shows "Paused while you were away", click Resume.
On the results page, type the name ${NAME} and click "Submit score". When the page confirms it was saved, close the space and reply with the final score only.`;
}

interface Line { t: number; m: any }
function runClaude(tool: 'overtake' | 'cli', p: string, mcpConfigPath: string | null): Promise<{ lines: Line[]; wall: number; code: number; stderr: string }> {
  const a = ['-p', p, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-budget-usd', BUDGET, '--strict-mcp-config',
    '--disallowedTools', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__claude-in-chrome'];
  if (MODEL) a.push('--model', MODEL);
  if (tool === 'overtake') a.push('--mcp-config', mcpConfigPath!, '--allowedTools', 'mcp__overtake', '--disallowedTools', 'Bash');
  else a.push('--allowedTools', `Bash(${CLI_BIN}:*)`, 'Skill', 'Read');
  return new Promise((res) => {
    const t0 = performance.now();
    const c = spawn('claude', a, { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: Line[] = [];
    let buf = '', stderr = '';
    c.stdout.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!l.trim()) continue;
        try { lines.push({ t: performance.now() - t0, m: JSON.parse(l) }); } catch { /* ignore */ }
      }
    });
    c.stderr.on('data', (b) => (stderr += b));
    const timer = setTimeout(() => c.kill('SIGTERM'), 15 * 60_000);
    c.on('close', (code) => { clearTimeout(timer); res({ lines, wall: performance.now() - t0, code: code ?? -1, stderr: stderr.slice(-2000) }); });
  });
}

/** Split the session into model time and tool time using line arrival times. */
function analyse(lines: Line[]) {
  const pending = new Map<string, { t: number; name: string }>();
  const tools: { name: string; ms: number; isError: boolean }[] = [];
  let modelMs = 0, lastReady = lines.find((l) => l.m.type === 'system')?.t ?? 0, assistantMsgs = 0;
  for (const { t, m } of lines) {
    if (m.type === 'assistant') {
      assistantMsgs++;
      if (pending.size === 0) { modelMs += Math.max(0, t - lastReady); lastReady = t; }
      for (const c of m.message?.content ?? []) if (c.type === 'tool_use') pending.set(c.id, { t, name: c.name });
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const p = pending.get(c.tool_use_id)!;
        tools.push({ name: p.name, ms: t - p.t, isError: !!c.is_error });
        pending.delete(c.tool_use_id);
      }
      if (pending.size === 0) lastReady = t;
    }
  }
  const result = lines.find((l) => l.m.type === 'result')?.m ?? {};
  const byName: Record<string, { n: number; ms: number }> = {};
  for (const x of tools) { const k = x.name.replace(/^mcp__overtake__/, ''); (byName[k] ||= { n: 0, ms: 0 }); byName[k].n++; byName[k].ms += x.ms; }
  return {
    result: { duration_ms: result.duration_ms, duration_api_ms: result.duration_api_ms, num_turns: result.num_turns, total_cost_usd: result.total_cost_usd, usage: result.usage, modelUsage: result.modelUsage, is_error: result.is_error, subtype: result.subtype, text: String(result.result ?? '').slice(0, 300) },
    modelMsFromStream: modelMs, toolMs: tools.reduce((n, x) => n + x.ms, 0), toolCalls: tools.length, toolErrors: tools.filter((x) => x.isError).length, assistantMsgs, byName,
    bashCalls: tools.filter((x) => x.name === 'Bash').length,
  };
}

const quiz = (await startQuizServer(PORT)) as unknown as { close: () => void };
const tools = (ONLY ? [ONLY] : ['overtake', 'cli']) as ('overtake' | 'cli')[];
let env: OvertakeEnv | null = null;
writeFileSync(join(OUT, 'config.json'), JSON.stringify({ stamp, runs: RUNS, tools, budget: BUDGET, model: MODEL || '(default)', claude: execSync('claude --version').toString().trim(), cliVersion: tools.includes('cli') ? execSync(`${CLI_BIN} --version 2>&1`).toString().trim().split('\n')[0] : null }, null, 2));
try {
  if (tools.includes('overtake')) { env = new OvertakeEnv(); await env.start(); }
  for (let run = FIRST; run <= RUNS; run++) {
    for (const tool of run % 2 ? tools : [...tools].reverse()) {
      const quizRun = `agent-${tool}-${run}-${stamp.slice(11).replace(/-/g, '')}`;
      await fetch(`${SITE}/api/runs`, { method: 'POST', body: JSON.stringify({ id: quizRun, pause: false, questions: 5, seed: 2000 + run }) });
      const spaceName = `rr-bench agent ${tool} r${run} ${stamp}`;
      let cfgPath: string | null = null;
      if (tool === 'overtake') { cfgPath = join(OUT, `mcp-${tool}.json`); writeFileSync(cfgPath, JSON.stringify(env!.mcpConfig(`rr-agent-r${run}`))); }
      console.log(`[agent] ${tool} run ${run}`);
      const r = await runClaude(tool, prompt(tool, quizRun, spaceName), cfgPath);
      writeFileSync(join(OUT, `stream-${tool}-r${run}.jsonl`), r.lines.map((l) => JSON.stringify({ t: Math.round(l.t), ...l.m })).join('\n') + '\n');
      const a = analyse(r.lines);
      const state = await (await fetch(`${SITE}/api/runs/${quizRun}`)).json();
      const cps = checkpoints(state, NAME);
      // Clean up only our own space if the agent left it open (CLI browser: by exact name prefix).
      let leftOpen: unknown = null;
      if (tool === 'cli') {
        const out = execSync(`${CLI_BIN} nodejs -e 'const l = await listTaskSpaces(); const mine = l.filter(s => s.name === ${JSON.stringify(spaceName).replace(/'/g, '')}); for (const s of mine) { const t = await taskSpace(s.id); await t.finish({ keep: [] }); } console.error("LEFT=" + JSON.stringify(mine.map(s => s.id)));' 2>&1`).toString();
        leftOpen = /LEFT=(.*)/.exec(out)?.[1] ?? out.slice(-200);
      }
      const rec = { tool, run, wallMs: r.wall, exit: r.code, passed: cps.filter((c) => c.ok).length, total: cps.length, checkpoints: cps, leftOpen, ...a, stderr: r.code ? r.stderr : undefined };
      appendFileSync(join(OUT, 'agent.jsonl'), JSON.stringify(rec) + '\n');
      console.log(`[agent] ${tool} r${run}: ${(r.wall / 1000).toFixed(1)} s, checkpoints ${rec.passed}/${rec.total}, tools ${a.toolCalls} (${(a.toolMs / 1000).toFixed(1)} s), model ${(a.modelMsFromStream / 1000).toFixed(1)} s, turns ${a.result.num_turns}, cost $${a.result.total_cost_usd}`);
    }
  }
} finally {
  await env?.stop();
  quiz.close();
}
