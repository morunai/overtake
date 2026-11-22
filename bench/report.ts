// Summarise a realistic-rounds results folder:  node bench/report.ts <dir>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Rec = Record<string, any>;
const load = (dir: string, f: string): Rec[] => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const pct = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  // nearest-rank
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const med = (xs: number[]) => pct(xs, 50);
const f = (n: number) => (Number.isFinite(n) ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)) : '–');
const kb = (n: number) => (Number.isFinite(n) ? (n / 1024).toFixed(1) : '–');
let TOOLS = [['overtake', 'Overtake (MCP)'], ['cli', 'CLI browser (CLI)']] as [string, string][];

export function report(dir: string): string {
  const cfg = existsSync(join(dir, 'config.json')) ? JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) : {};
  const recs: Record<string, Rec[]> = { overtake: load(dir, 'overtake.jsonl'), cli: load(dir, 'cli.jsonl') };
  const cps = load(dir, 'checkpoints.jsonl');
  const base = load(dir, 'baseline.jsonl');
  const envs = load(dir, 'env.jsonl');
  TOOLS = [['overtake', 'Overtake (MCP)'], ['cli', `CLI browser (CLI, ${cfg.cliStrategy ?? 'batched'}${cfg.cliFocus && cfg.cliFocus !== 'auto' ? `, focus=${cfg.cliFocus}` : ''})`]];
  const modes: string[] = cfg.modes ?? [...new Set(cps.map((c) => c.mode))];
  const L: string[] = [];
  L.push(`# Realistic-rounds results ${cfg.stamp ?? ''}`, '');
  L.push(`${cfg.runs} runs × ${cfg.questions} questions per mode · modes ${modes.join(', ')} · Overtake headless=${!cfg.headful} · ${cfg.cliVersion?.split('\n')[0] ?? ''} · ${cfg.chrome ?? ''} · node ${cfg.node ?? ''}`, '');
  L.push('Medians / p95 are nearest-rank over runs (totals) or over every round of that name (per round). All times ms.', '');

  for (const mode of modes) {
    L.push(`## Mode: ${mode}`, '');
    L.push('### Totals per run', '');
    L.push('| | wall med | wall p95 | browser med | transport med | rounds | tool calls / invocations | SDK calls inside invocations | bytes to agent (KB) | checkpoints | runs all-pass |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const [tool, label] of TOOLS) {
      const rounds = recs[tool].filter((r) => r.kind === 'round' && r.mode === mode);
      if (!rounds.length) continue;
      const runs = [...new Set(rounds.map((r) => r.run))];
      const per = runs.map((run) => {
        const rs = rounds.filter((r) => r.run === run);
        const sum = (k: string) => rs.reduce((n, r) => n + (r[k] ?? 0), 0);
        return { wall: sum('wallMs'), browser: sum('browserMs'), transport: sum('transportMs'), rounds: rs.length, calls: sum('calls'), sdk: sum('sdkCalls'), bytes: sum('bytesOut'), ok: rs.every((r) => r.ok) };
      });
      const c = cps.filter((x) => x.tool === tool && x.mode === mode);
      const passed = c.reduce((n, x) => n + x.passed, 0), total = c.reduce((n, x) => n + x.total, 0);
      const allPass = c.filter((x) => x.passed === x.total).length;
      L.push(`| ${label} | ${f(med(per.map((p) => p.wall)))} | ${f(pct(per.map((p) => p.wall), 95))} | ${f(med(per.map((p) => p.browser)))} | ${f(med(per.map((p) => p.transport)))} | ${f(med(per.map((p) => p.rounds)))} | ${f(med(per.map((p) => p.calls)))} | ${tool === 'cli' ? f(med(per.map((p) => p.sdk))) : '–'} | ${kb(med(per.map((p) => p.bytes)))} | ${passed}/${total} (${total ? ((100 * passed) / total).toFixed(0) : 0}%) | ${allPass}/${c.length} |`);
    }
    L.push('', '### Per round (median / p95 over all runs)', '');
    L.push('| round | OT wall | OT p95 | OT browser | OT transport | OT calls | CLI wall | CLI p95 | CLI browser | CLI transport (process+connect) | CLI SDK calls | ok OT | ok CLI |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const names = [...new Set([...recs.overtake, ...recs.cli].filter((r) => r.kind === 'round' && r.mode === mode).sort((a, b) => a.round - b.round).map((r) => r.name))];
    for (const n of names) {
      const a = recs.overtake.filter((r) => r.kind === 'round' && r.mode === mode && r.name === n);
      const b = recs.cli.filter((r) => r.kind === 'round' && r.mode === mode && r.name === n);
      const m = (rs: Rec[], k: string, p = 50) => f(pct(rs.filter((r) => r.ok).map((r) => r[k]), p));
      L.push(`| ${n} | ${m(a, 'wallMs')} | ${m(a, 'wallMs', 95)} | ${m(a, 'browserMs')} | ${m(a, 'transportMs')} | ${m(a, 'calls')} | ${m(b, 'wallMs')} | ${m(b, 'wallMs', 95)} | ${m(b, 'browserMs')} | ${m(b, 'transportMs')} | ${m(b, 'sdkCalls')} | ${a.filter((r) => r.ok).length}/${a.length} | ${b.filter((r) => r.ok).length}/${b.length} |`);
    }
    L.push('', '### Per action (median / p95; Overtake = MCP call wall incl. stdio, server = handler time; CLI browser = in-process SDK call)', '');
    L.push('| step | OT wall | OT p95 | OT server | CLI | CLI p95 | n OT | n CLI |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    const steps = [...new Set([...recs.overtake, ...recs.cli].filter((r) => r.kind === 'call' && r.mode === mode).map((r) => r.step))];
    for (const s of steps) {
      const a = recs.overtake.filter((r) => r.kind === 'call' && r.mode === mode && r.step === s && r.ok);
      const b = recs.cli.filter((r) => r.kind === 'call' && r.mode === mode && r.step === s && r.ok);
      L.push(`| ${s} | ${f(med(a.map((r) => r.ms)))} | ${f(pct(a.map((r) => r.ms), 95))} | ${f(med(a.map((r) => r.serverMs)))} | ${f(med(b.map((r) => r.ms)))} | ${f(pct(b.map((r) => r.ms), 95))} | ${a.length} | ${b.length} |`);
    }
    const fails = [...recs.overtake, ...recs.cli].filter((r) => r.mode === mode && r.kind === 'round' && !r.ok);
    const cpf = cps.filter((x) => x.mode === mode && x.passed < x.total);
    if (fails.length || cpf.length) {
      L.push('', '### Failures', '');
      for (const r of fails) L.push(`- ${recs.overtake.includes(r) ? 'Overtake' : 'CLI browser'} run ${r.run} round ${r.name}: ${String(r.err ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
      for (const x of cpf) L.push(`- checkpoints ${x.tool} run ${x.run}: failed ${x.checkpoints.filter((c: Rec) => !c.ok).map((c: Rec) => c.name).join(', ')} (page pauses: ${x.pauses})`);
    }
    const pauses = cps.filter((x) => x.mode === mode);
    if (mode === 'pause') L.push('', `Page pause events per run: ${TOOLS.map(([t, l]) => `${l} ${pauses.filter((x) => x.tool === t).map((x) => x.pauses).join('/')}`).join(' · ')}`);
    L.push('');
  }
  if (base.length) {
    L.push('## Transport baselines', '');
    L.push('| probe | median | p95 | n |', '|---|---:|---:|---:|');
    for (const s of [...new Set(base.map((b) => `${b.tool}:${b.step}`))]) {
      const xs = base.filter((b) => `${b.tool}:${b.step}` === s).map((b) => b.ms);
      L.push(`| ${s} | ${f(med(xs))} | ${f(pct(xs, 95))} | ${xs.length} |`);
    }
    const cold = recs.overtake.filter((r) => r.kind === 'cold_start').map((r) => r.ms);
    if (cold.length) L.push(`| overtake:cold_start (MCP server spawn + initialize, once per session) | ${f(med(cold))} | ${f(pct(cold, 95))} | ${cold.length} |`);
    L.push('');
  }
  const sent = load(dir, 'sentinel.jsonl').filter((x) => x.ok && x.clicks);
  if (sent.length) {
    L.push('## Sentinel (6 clicks on a trivial page before each run, not part of the timed rounds)', '');
    L.push('| tool | mode | run | attempt | median click | max click |', '|---|---|---:|---:|---:|---:|');
    for (const x of sent) L.push(`| ${x.tool} | ${x.mode} | ${x.run} | ${x.attempt ?? 0} | ${f(med(x.clicks))} | ${f(Math.max(...x.clicks))} |`);
    const slow = cps.filter((x) => x.sentinelOk === false);
    if (slow.length) L.push('', `Runs measured while the CLI browser sentinel was still slow after retries: ${slow.map((x) => `${x.mode} r${x.run}`).join(', ')}.`);
    L.push('');
  }
  if (envs.length) {
    L.push('## Environment checks', '');
    for (const e of envs) L.push(`- ${e.label}${e.attempt != null ? ` #${e.attempt}` : ''}: load1 ${e.load1 ?? '–'}${e.hot?.length ? `, hot ${e.hot.map((h: Rec) => `${String(h.comm).split('/').pop()} ${h.cpu}%`).join(', ')}` : ''}${e.cliCpu != null ? `, the CLI browser CPU ${e.cliCpu.toFixed(0)}%` : ''}${e.otherTestChrome ? `, other test Chrome ${e.otherTestChrome}` : ''}${e.clean != null ? ` → ${e.clean ? 'clean' : 'busy'}` : ''}${e.verdict ? ` → ${e.verdict}` : ''}`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node bench/report.ts <results dir>');
  const md = report(dir);
  writeFileSync(join(dir, 'summary.md'), md);
  console.log(md);
}
