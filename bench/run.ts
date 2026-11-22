// Realistic-rounds benchmark: Overtake (MCP, one tool call per action) vs CLI browser
// (`<cli> nodejs`, one invocation per observe→act round, batched as its Skill says).
//
//   node bench/run.ts [--runs 5] [--questions 5] [--mode nopause|pause|both]
//        [--only overtake|cli] [--cli-focus auto|0|1] [--baseline 15] [--headful]
//        [--cli-strategy batched|per-action] [--require-clean 1] [--max-load 6] [--out DIR]
//
// Same task, same selectors, same checkpoints for both. The "agent" is a deterministic
// policy that only decides from what the previous round printed (the snapshot text):
// it must read the question in round k to answer it in round k+1. No model time.
// Rounds (see REPORT.md for why these are the observation points):
//   R1 open      create space + load home, wait, snapshot           (nothing known yet)
//   R2 course    click "Practice Test 01" link, wait, snapshot      (needs home snapshot)
//   R3 start     click "Practice ... Reveal the answer", wait, snap  (needs test page snapshot)
//   R4..R3+N  q  [resume if paused] pick answer, reveal, wait, next, wait, snapshot
//                                                                   (needs the question text)
//   R4+N submit  type name, submit, wait "Saved:", screenshot, snap (needs the score page)
//   R5+N close   spaces_close / task.finish({keep: []})            (needs confirmation)
// Checkpoints are reported by the page to the quiz server (site.mjs) and read out of band.
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { startQuizServer, checkpoints } from './site.mjs';
import { OvertakeEnv, SNAP } from './overtake-env.ts';

// The batching CLI browser under comparison. Set CLI_BROWSER_BIN to its command; it must accept
// `<bin> nodejs` with a script on stdin. CLI_BROWSER_APP is a regex for its app process (load gate).
const CLI_BIN = process.env.CLI_BROWSER_BIN || 'cli-browser';
const CLI_APP = new RegExp(process.env.CLI_BROWSER_APP || '^$');

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k: string) => args.includes(`--${k}`);
const RUNS = Number(opt('runs', '5'));
const QUESTIONS = Number(opt('questions', '5'));
const MODES = opt('mode', 'both') === 'both' ? ['nopause', 'pause'] : [opt('mode', 'nopause')];
const ONLY = opt('only', '');
const CLI_FOCUS = opt('cli-focus', 'auto');
const CLI_STRATEGY = opt('cli-strategy', 'batched'); // batched (Skill) | per-action (ablation)
const BASELINE_N = Number(opt('baseline', '15'));
const HEADFUL = flag('headful');
const REQUIRE_CLEAN = opt('require-clean', '1') === '1';
const MAX_LOAD = Number(opt('max-load', String(Math.max(4, cpus().length / 2))));
const PORT = Number(opt('port', '8766'));
const SITE = `http://127.0.0.1:${PORT}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve(opt('out', join(import.meta.dirname, 'results', stamp)));
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const NAME = 'rr-bench-agent';
const T = 10_000;

// Shared selectors (identical on both sides).
const SEL = {
  homeLink: 'a[href$="/c/web-101/41"]',
  practice: "xpath=//button[contains(., 'Reveal the answer')]",
  firstOpt: '#optList .opt',
  opt: (k: string) => `#optList .opt[data-key=${k}]`,
  reveal: 'button[data-act=reveal]',
  next: 'button[data-nav=next]',
  qnum: (n: number, total: number) => `xpath=//p[@id='qnum' and normalize-space(.)='Question ${n} of ${total}']`,
  score: '#score',
  name: '#name',
  submit: '#submit',
  saved: "xpath=//p[@id='saved' and starts-with(normalize-space(.), 'Saved:')]",
  resume: 'button[data-resume]',
  pause: '#pause',
};

const log = (file: string, rec: Record<string, unknown>) => appendFileSync(join(OUT, file), JSON.stringify({ t: Date.now(), ...rec }) + '\n');
const bytes = (s: string) => Buffer.byteLength(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the "agent" policy
// Decides only from observation text. Works on both snapshot formats.
class PolicyError extends Error {}
const policy = {
  home(obs: string) { if (!/WEB-101 Practice Test 01/.test(obs)) throw new PolicyError('home: link not observed'); return SEL.homeLink; },
  test(obs: string) { if (!/Reveal the answer/.test(obs)) throw new PolicyError('test: practice button not observed'); return SEL.practice; },
  question(obs: string) {
    const qm = /Question (\d+) of (\d+)/.exec(obs);
    const am = /What is (\d+) \+ (\d+)\?/.exec(obs);
    if (!qm || !am) throw new PolicyError('question: not observed');
    const want = String(Number(am[1]) + Number(am[2]));
    const opts = [...obs.matchAll(/\b([A-D])\. (\d+)\b/g)].map((m) => ({ key: m[1], val: m[2] }));
    const hit = opts.find((o) => o.val === want);
    if (!hit) throw new PolicyError(`question: no option equals ${want}`);
    return { num: Number(qm[1]), total: Number(qm[2]), key: hit.key, paused: /Paused while you were away/.test(obs) && !/display: none/.test(obs) };
  },
  results(obs: string) { const m = /Score: (\d+) \/ (\d+)/.exec(obs); if (!m) throw new PolicyError('results: score not observed'); return { score: Number(m[1]), total: Number(m[2]) }; },
  saved(obs: string) { if (!/Saved: /.test(obs)) throw new PolicyError('submit: confirmation not observed'); },
};

// ---------------------------------------------------------------- clean-environment gate
function envSnapshot() {
  const up = execSync('uptime').toString().trim();
  const top = execSync('ps -Ao pcpu,comm -r | head -12').toString();
  const load1 = Number(/load averages?: ([\d.]+)/.exec(up)?.[1] ?? 99);
  const busy = top.split('\n').slice(1).map((l) => { const m = /^\s*([\d.]+)\s+(.*)$/.exec(l); return m ? { cpu: Number(m[1]), comm: m[2] } : null; }).filter(Boolean) as { cpu: number; comm: string }[];
  const ps = execSync('ps -Ao args').toString();
  const otherTestChrome = ps.split('\n').filter((l) => /Google Chrome/.test(l) && /--user-data-dir=\S*(overtake-chrome-|rr-chrome-)/.test(l) && !l.includes('rr-chrome-') ).length;
  const hot = busy.filter((b) => b.cpu > 60 && !/WindowServer|kernel_task/.test(b.comm));
  const cliCpu = busy.filter((b) => CLI_APP.test(b.comm)).reduce((n, b) => n + b.cpu, 0);
  return { uptime: up, load1, top: top.trim(), otherTestChrome, hot, cliCpu, clean: load1 <= MAX_LOAD && otherTestChrome === 0 && hot.length === 0 };
}
async function waitClean(label: string) {
  for (let i = 0; i < 6; i++) {
    const s = envSnapshot();
    log('env.jsonl', { label, attempt: i, ...s });
    console.log(`[env] ${label} attempt ${i}: load1=${s.load1} hot=${s.hot.map((h) => `${h.comm.split('/').pop()}:${h.cpu}`).join(',') || '-'} testChrome=${s.otherTestChrome} -> ${s.clean ? 'clean' : 'busy'}`);
    if (s.clean) return true;
    await sleep(30_000);
  }
  return false;
}

// ---------------------------------------------------------------- Overtake
interface Ctx { mode: string; run: number; quizRun: string }
type CallRes = { text: string; bytes: number; ms: number; serverMs?: number; ok: boolean; err?: string; value?: any };

async function runOvertake(env: OvertakeEnv, ctx: Ctx) {
  const { client, pid, connectMs } = await env.agent(`rr-${ctx.mode}-r${ctx.run}`);
  log('overtake.jsonl', { kind: 'cold_start', mode: ctx.mode, run: ctx.run, ms: connectMs, note: 'spawn snapshot MCP server + initialize' });
  const logFile = join(env.home, 'logs', `mcp-${pid}.log`);
  let logLines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const serverMsOfLastCall = () => {
    // The server logs "<iso> <agent> <tool> <ms>ms <outcome>" after each call.
    const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
    const fresh = lines.slice(logLines);
    logLines = lines.length;
    const m = fresh.length ? / (\d+)ms \S+$/.exec(fresh[fresh.length - 1]) : null;
    return m ? Number(m[1]) : undefined;
  };
  let round = 0, roundName = '', calls: CallRes[] = [];
  const call = async (step: string, tool: string, a: Record<string, unknown>): Promise<CallRes> => {
    const t0 = performance.now();
    let r: CallRes;
    try {
      const res = (await client.callTool({ name: tool, arguments: a }, undefined, { timeout: 60_000 })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
      const ms = performance.now() - t0;
      const text = res.content.find((c) => c.type === 'text')?.text ?? '';
      const b = res.content.reduce((n, c) => n + bytes(c.text ?? c.data ?? ''), 0);
      let value: any; try { value = JSON.parse(text); } catch {}
      r = { text, bytes: b, ms, ok: !res.isError, err: res.isError ? text.slice(0, 300) : undefined, value };
    } catch (e) {
      r = { text: '', bytes: 0, ms: performance.now() - t0, ok: false, err: String((e as Error).message).slice(0, 300) };
    }
    r.serverMs = serverMsOfLastCall();
    calls.push(r);
    log('overtake.jsonl', { kind: 'call', mode: ctx.mode, run: ctx.run, round, roundName, step, tool, ms: r.ms, serverMs: r.serverMs, ok: r.ok, bytes: r.bytes, err: r.err, ...(tool === 'browser_click' && r.value?.timingMs ? { timing: r.value.timingMs } : {}) });
    if (!r.ok) throw Object.assign(new Error(`${step}: ${r.err}`), { call: r });
    return r;
  };
  const doRound = async <R>(name: string, fn: () => Promise<R>): Promise<R> => {
    round++; roundName = name; calls = [];
    const t0 = performance.now();
    let ok = true, err: string | undefined, out: R;
    try { out = await fn(); } catch (e) { ok = false; err = String((e as Error).message).slice(0, 300); }
    const wall = performance.now() - t0;
    const server = calls.reduce((n, c) => n + (c.serverMs ?? 0), 0);
    log('overtake.jsonl', { kind: 'round', mode: ctx.mode, run: ctx.run, round, name, wallMs: wall, browserMs: server, transportMs: calls.reduce((n, c) => n + c.ms, 0) - server, calls: calls.length, bytesOut: calls.reduce((n, c) => n + c.bytes, 0), ok, err });
    if (!ok) throw new Error(`round ${name}: ${err}`);
    return out!;
  };

  let spaceId = 0, tabId = 0;
  const snap = async () => (await call('snapshot', 'browser_snapshot', { tabId })).text;
  // Recovery an agent would do after a failed click: look, resume if paused, retry once.
  const click = async (step: string, target: string, label: string) => {
    try { return await call(step, 'browser_click', { tabId, target, label }); } catch (e) {
      const obs = await snap();
      if (!/Paused while you were away/.test(obs)) throw e;
      await call('click_resume', 'browser_click', { tabId, target: SEL.resume, label: 'Resume the test' });
      await call('wait_resumed', 'browser_wait', { tabId, selector: SEL.pause, state: 'hidden', timeoutMs: T });
      return call(step + '_retry', 'browser_click', { tabId, target, label });
    }
  };
  const t0 = performance.now();
  try {
    let obs = await doRound('open', async () => {
      const r = await call('spaces_create', 'spaces_create', { name: `rr-bench ${ctx.mode} r${ctx.run} ${stamp}`, url: `${SITE}/r/${ctx.quizRun}/` });
      ({ spaceId, tabId } = r.value);
      await call('wait_home', 'browser_wait', { tabId, selector: SEL.homeLink, state: 'visible', timeoutMs: T });
      return snap();
    });
    obs = await doRound('course', async () => {
      await click('click_course', policy.home(obs), 'Open practice test 01');
      await call('wait_test', 'browser_wait', { tabId, selector: SEL.practice, state: 'visible', timeoutMs: T });
      return snap();
    });
    obs = await doRound('start', async () => {
      await click('click_practice', policy.test(obs), 'Start practice mode');
      await call('wait_play', 'browser_wait', { tabId, selector: SEL.firstOpt, state: 'visible', timeoutMs: T });
      return snap();
    });
    for (let q = 1; q <= QUESTIONS; q++) {
      obs = await doRound(`q${q}`, async () => {
        const p = policy.question(obs);
        if (p.num !== q) throw new PolicyError(`expected question ${q}, observed ${p.num}`);
        if (p.paused) {
          await call('click_resume', 'browser_click', { tabId, target: SEL.resume, label: 'Resume the test' });
          await call('wait_resumed', 'browser_wait', { tabId, selector: SEL.pause, state: 'hidden', timeoutMs: T });
        }
        await click('click_option', SEL.opt(p.key), 'Pick the answer');
        await click('click_reveal', SEL.reveal, 'Show the answer');
        await call('wait_reveal', 'browser_wait', { tabId, selector: SEL.next, state: 'visible', timeoutMs: T });
        await click('click_next', SEL.next, q < p.total ? 'Next question' : 'See results');
        await call('wait_next', 'browser_wait', { tabId, selector: q < p.total ? SEL.qnum(q + 1, p.total) : SEL.score, state: 'visible', timeoutMs: T });
        return snap();
      });
    }
    obs = await doRound('submit', async () => {
      policy.results(obs);
      await call('type_name', 'browser_type', { tabId, target: SEL.name, text: NAME, label: 'Enter name' });
      await click('click_submit', SEL.submit, 'Submit score');
      await call('wait_saved', 'browser_wait', { tabId, selector: SEL.saved, state: 'visible', timeoutMs: T });
      await call('screenshot', 'browser_screenshot', { tabId, path: join(SHOTS, `overtake-${ctx.mode}-r${ctx.run}.png`) });
      return snap();
    });
    await doRound('close', async () => { policy.saved(obs); await call('close', 'spaces_close', { spaceId }); spaceId = 0; });
  } catch (e) {
    console.error(`[overtake] ${ctx.mode} r${ctx.run} failed: ${(e as Error).message}`);
  } finally {
    log('overtake.jsonl', { kind: 'run', mode: ctx.mode, run: ctx.run, ms: performance.now() - t0, rounds: round });
    if (spaceId) await client.callTool({ name: 'spaces_close', arguments: { spaceId } }).catch(() => {});
    await client.close();
  }
}

// ---------------------------------------------------------------- CLI browser
function cli(script: string, timeoutMs = 120_000): Promise<{ code: number; out: string; err: string; ms: number }> {
  return new Promise((res) => {
    const t0 = performance.now();
    const p = spawn(CLI_BIN, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); res({ code: code ?? -1, out, err, ms: performance.now() - t0 }); });
    p.stdin.end(script);
  });
}

// What the agent writes each round. The prelude only adds timing; the body is what the
// Skill recommends: act, wait for the final expected state, print the next snapshot last.
function cliScript(space: string | number, body: string, focus: boolean) {
  return `const __steps = []; const __T0 = performance.now(); let task;
const time = async (step, fn) => { const s = performance.now(); try { const v = await fn(); __steps.push({ step, ms: performance.now() - s, ok: true, bytes: v == null ? 0 : (typeof v === 'string' ? v.length : JSON.stringify(v).length) }); return v; } catch (e) { __steps.push({ step, ms: performance.now() - s, ok: false, err: String(e && e.message || e).slice(0, 300) }); throw e; } };
try {
  task = await time('connect', () => taskSpace(${JSON.stringify(space)}));
  const page = task.page("p1");
  ${focus ? "await time('focus_emulation', () => page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }));" : ''}
  ${body}
} finally {
  console.error('@@RR ' + JSON.stringify({ spaceId: task && task.spaceId, script: performance.now() - __T0, steps: __steps }));
}`;
}
const W = (sel: string, state = 'visible') => `{ state: ${JSON.stringify(state)}, timeout: ${T} }`;

async function runCli(ctx: Ctx, focus: boolean) {
  let round = 0;
  let space: string | number = `rr-bench ${ctx.mode} r${ctx.run} ${stamp}`;
  let spaceId: number | undefined;
  // A round is a list of statements. "batched" (the Skill's recommendation) runs them in one
  // invocation; "per-action" (ablation) runs each statement in its own invocation.
  const doRound = async (name: string, stmts: string[]) => {
    round++;
    const groups = CLI_STRATEGY === 'per-action' ? stmts.map((x) => [x]) : [stmts];
    let printed = '', wall = 0, script = 0, steps: { step: string; ms: number; ok: boolean; err?: string; bytes?: number }[] = [], code = 0, tail = '';
    for (const g of groups) {
      const r = await cli(cliScript(space, g.join('\n  '), focus));
      const all = r.out + r.err;
      const m = /@@RR (.*)$/m.exec(all);
      const meta = m ? JSON.parse(m[1]) : { steps: [], script: NaN };
      if (meta.spaceId) { spaceId = meta.spaceId; space = meta.spaceId; }
      printed += all.replace(/^@@RR .*$/m, '');
      wall += r.ms; script += meta.script; steps.push(...meta.steps); code = r.code; tail = (r.err || r.out).slice(-300);
      if (r.code !== 0 || meta.steps.some((s: { ok: boolean }) => !s.ok)) break;
    }
    for (const s of steps) log('cli.jsonl', { kind: 'call', mode: ctx.mode, strategy: CLI_STRATEGY, run: ctx.run, round, roundName: name, ...s });
    const connect = steps.filter((s) => s.step === 'connect').reduce((n, s) => n + s.ms, 0);
    const browser = steps.filter((s) => s.step !== 'connect').reduce((n, s) => n + s.ms, 0);
    const ok = code === 0 && steps.every((s) => s.ok);
    const err = ok ? undefined : (steps.find((s) => !s.ok)?.err ?? tail);
    log('cli.jsonl', { kind: 'round', mode: ctx.mode, strategy: CLI_STRATEGY, run: ctx.run, round, name, wallMs: wall, scriptMs: script, connectMs: connect, browserMs: browser, transportMs: wall - browser, processMs: wall - script, calls: groups.length, sdkCalls: steps.length, bytesOut: bytes(printed), ok, err });
    if (!ok) throw new Error(`round ${name}: ${err}`);
    return printed;
  };
  const J = JSON.stringify;
  const SNAPSHOT = "console.log(await time('snapshot', () => page.snapshot()));";
  const t0 = performance.now();
  try {
    let obs = await doRound('open', [
      `await time('goto_home', () => page.goto(${J(`${SITE}/r/${ctx.quizRun}/`)}));`,
      `await time('wait_home', () => page.waitForSelector(${J(SEL.homeLink)}, ${W('')}));`,
      `console.log({ taskSpaceId: task.spaceId, page: page.label }); ${SNAPSHOT}`,
    ]);
    obs = await doRound('course', [
      `await time('click_course', () => page.click(${J(policy.home(obs))}, { label: 'Open practice test 01' }));`,
      `await time('wait_test', () => page.waitForSelector(${J(SEL.practice)}, ${W('')}));`,
      SNAPSHOT,
    ]);
    obs = await doRound('start', [
      `await time('click_practice', () => page.click(${J(policy.test(obs))}, { label: 'Start practice mode' }));`,
      `await time('wait_play', () => page.waitForSelector(${J(SEL.firstOpt)}, ${W('')}));`,
      SNAPSHOT,
    ]);
    for (let q = 1; q <= QUESTIONS; q++) {
      const p = policy.question(obs);
      if (p.num !== q) throw new PolicyError(`expected question ${q}, observed ${p.num}`);
      // In pause mode the agent knows the site pauses between its rounds, so it guards.
      const guard = ctx.mode === 'pause' || p.paused ? [`if (await time('check_paused', () => page.evaluate("getComputedStyle(document.querySelector('#pause')).display !== 'none'"))) { await time('click_resume', () => page.click(${J(SEL.resume)}, { label: 'Resume the test' })); await time('wait_resumed', () => page.waitForSelector(${J(SEL.pause)}, ${W('', 'hidden')})); }`] : [];
      obs = await doRound(`q${q}`, [
        ...guard,
        `await time('click_option', () => page.click(${J(SEL.opt(p.key))}, { label: 'Pick the answer' }));`,
        `await time('click_reveal', () => page.click(${J(SEL.reveal)}, { label: 'Show the answer' }));`,
        `await time('wait_reveal', () => page.waitForSelector(${J(SEL.next)}, ${W('')}));`,
        `await time('click_next', () => page.click(${J(SEL.next)}, { label: ${J(q < p.total ? 'Next question' : 'See results')} }));`,
        `await time('wait_next', () => page.waitForSelector(${J(q < p.total ? SEL.qnum(q + 1, p.total) : SEL.score)}, ${W('')}));`,
        SNAPSHOT,
      ]);
    }
    policy.results(obs);
    obs = await doRound('submit', [
      `await time('type_name', () => page.fill(${J(SEL.name)}, ${J(NAME)}));`,
      `await time('click_submit', () => page.click(${J(SEL.submit)}, { label: 'Submit score' }));`,
      `await time('wait_saved', () => page.waitForSelector(${J(SEL.saved)}, ${W('')}));`,
      `console.log({ screenshot: await time('screenshot', () => page.screenshot({ path: ${J(join(SHOTS, `cli-${ctx.mode}-r${ctx.run}.png`))} })) });`,
      SNAPSHOT,
    ]);
    policy.saved(obs);
    await doRound('close', [`await time('close', () => task.finish({ keep: [] }));`]);
    spaceId = undefined;
  } catch (e) {
    console.error(`[cli] ${ctx.mode} r${ctx.run} failed: ${(e as Error).message}`);
  } finally {
    log('cli.jsonl', { kind: 'run', mode: ctx.mode, strategy: CLI_STRATEGY, run: ctx.run, ms: performance.now() - t0, rounds: round });
    // Only ever finish our own space (id printed by our own round 1).
    if (spaceId) await cli(`const t = await taskSpace(${spaceId}); await t.finish({ keep: [] });`);
  }
}

// ---------------------------------------------------------------- per-run sentinel
// 6 clicks on a trivial page, outside the timed rounds: flags runs where the browser itself
// was slow (e.g. other activity in the CLI browser), so they can be identified in the report.
async function sentinelCli(label: Record<string, unknown>) {
  const r = await cli(`const t = await taskSpace(${JSON.stringify(`rr-bench sentinel ${stamp}`)}); const p = t.page('p1'); await p.goto(${JSON.stringify(`${SITE}/sentinel`)}); const xs = []; for (let i = 0; i < 6; i++) { const s = performance.now(); await p.click(i % 2 ? '#a' : '#b'); xs.push(performance.now() - s); } console.error('@@S ' + JSON.stringify(xs)); await t.finish({ keep: [] });`);
  const m = /@@S (.*)$/m.exec(r.out + r.err);
  const clicks: number[] | null = m ? JSON.parse(m[1]) : null;
  log('sentinel.jsonl', { tool: 'cli', ...label, clicks, ok: !!m });
  return clicks;
}
// the CLI browser sometimes enters a state where clicks are paced to ~1 s apart, even on a trivial
// page (see REPORT.md). Wait for it to pass rather than publish contaminated runs.
const SENTINEL_MAX = Number(opt('sentinel-max', '200'));
async function sentinelGateCli(label: Record<string, unknown>) {
  for (let i = 0; i < 6; i++) {
    const c = await sentinelCli({ ...label, attempt: i });
    if (c && Math.max(...c) <= SENTINEL_MAX) return true;
    console.log(`[rr] CLI browser sentinel slow (max ${c ? Math.round(Math.max(...c)) : '?'} ms), waiting 20 s`);
    await sleep(20_000);
  }
  return false;
}
async function sentinelOvertake(env: OvertakeEnv, label: Record<string, unknown>) {
  const { client } = await env.agent('rr-sentinel');
  const c = async (name: string, a: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: a })) as any).content[0].text);
  const { spaceId, tabId } = await c('spaces_create', { name: `rr-bench sentinel ${stamp}`, url: `${SITE}/sentinel` });
  await c('browser_wait', { tabId, selector: '#a', state: 'visible' });
  const xs: number[] = [];
  for (let i = 0; i < 6; i++) { const s = performance.now(); await c('browser_click', { tabId, target: i % 2 ? '#a' : '#b' }); xs.push(performance.now() - s); }
  await c('spaces_close', { spaceId });
  await client.close();
  log('sentinel.jsonl', { tool: 'overtake', ...label, clicks: xs, ok: true });
}

// ---------------------------------------------------------------- transport baselines
async function baselines(env: OvertakeEnv | null, tools: string[]) {
  if (tools.includes('overtake') && env) {
    const { client } = await env.agent('rr-baseline');
    const r = (await client.callTool({ name: 'spaces_create', arguments: { name: `rr-bench baseline ${stamp}`, url: 'about:blank' } })) as any;
    const { spaceId, tabId } = JSON.parse(r.content[0].text);
    for (const [step, fn] of [
      ['mcp_ping', () => client.ping()],
      ['spaces_list', () => client.callTool({ name: 'spaces_list', arguments: {} })],
      ['evaluate_1', () => client.callTool({ name: 'browser_evaluate', arguments: { tabId, expression: '1' } })],
    ] as [string, () => Promise<unknown>][]) {
      for (let i = 0; i < BASELINE_N; i++) { const t0 = performance.now(); await fn(); log('baseline.jsonl', { tool: 'overtake', step, i, ms: performance.now() - t0 }); }
    }
    await client.callTool({ name: 'spaces_close', arguments: { spaceId } });
    await client.close();
  }
  if (tools.includes('cli')) {
    for (let i = 0; i < BASELINE_N; i++) { const r = await cli('console.log(1)'); log('baseline.jsonl', { tool: 'cli', step: 'cli_noop', i, ms: r.ms, ok: r.code === 0 }); }
    const mk = await cli(`const t = await taskSpace(${JSON.stringify(`rr-bench baseline ${stamp}`)}); console.log('ID=' + t.spaceId);`);
    const id = Number(/ID=(\d+)/.exec(mk.out + mk.err)?.[1]);
    if (id) {
      for (let i = 0; i < BASELINE_N; i++) { const r = await cli(`const t = await taskSpace(${id}); console.log(await t.page('p1').url());`); log('baseline.jsonl', { tool: 'cli', step: 'cli_taskspace_url', i, ms: r.ms, ok: r.code === 0 }); }
      for (let i = 0; i < BASELINE_N; i++) { const r = await cli(`const t = await taskSpace(${id}); const p = t.page('p1'); const s = performance.now(); await p.evaluate('1'); console.error('@@E ' + (performance.now() - s));`); const m = /@@E ([\d.]+)/.exec(r.err + r.out); log('baseline.jsonl', { tool: 'cli', step: 'sdk_evaluate_1', i, ms: m ? Number(m[1]) : NaN, ok: !!m }); }
      await cli(`const t = await taskSpace(${id}); await t.finish({ keep: [] });`);
    }
  }
}

// ---------------------------------------------------------------- main
const tools = ONLY ? [ONLY] : ['overtake', 'cli'];
const manifest = existsSync(join(SNAP, 'MANIFEST.sha256')) ? readFileSync(join(SNAP, 'MANIFEST.sha256'), 'utf8') : '';
const cliVersion = execSync(`${CLI_BIN} --version 2>&1`).toString().trim();
writeFileSync(join(OUT, 'config.json'), JSON.stringify({ stamp, runs: RUNS, questions: QUESTIONS, modes: MODES, tools, cliFocus: CLI_FOCUS, cliStrategy: CLI_STRATEGY, headful: HEADFUL, maxLoad: MAX_LOAD, node: process.version, cliVersion, snapshot: SNAP, snapshotTime: existsSync(join(SNAP, 'SNAPSHOT_TIME')) ? readFileSync(join(SNAP, 'SNAPSHOT_TIME'), 'utf8').trim() : null, chrome: execSync(`'${process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}' --version`).toString().trim() }, null, 2));
writeFileSync(join(OUT, 'snapshot-manifest.sha256'), manifest);

const quiz = (await startQuizServer(PORT)) as unknown as { close: () => void };
let env: OvertakeEnv | null = null;
try {
  if (tools.includes('overtake')) { env = new OvertakeEnv(); await env.start({ headful: HEADFUL }); }
  if (BASELINE_N > 0) {
    if (!(await waitClean('baselines')) && REQUIRE_CLEAN) throw new Error('environment never got clean (baselines)');
    console.log('[rr] transport baselines');
    await baselines(env, tools);
  }
  for (const mode of MODES) {
    if (!(await waitClean(`series ${mode}`))) {
      log('env.jsonl', { label: `series ${mode}`, verdict: 'unclean' });
      if (REQUIRE_CLEAN) { console.error(`[rr] series ${mode} skipped: environment not clean`); continue; }
    }
    const focus = CLI_FOCUS === 'auto' ? mode === 'pause' : CLI_FOCUS === '1';
    for (let run = 1; run <= RUNS; run++) {
      const order = run % 2 ? tools : [...tools].reverse();
      for (const tool of order) {
        const quizRun = `${tool}-${mode}-${run}-${stamp.slice(11).replace(/-/g, '')}`;
        // Same questions for both browsers in a given run (seed = run), different per run.
        await fetch(`${SITE}/api/runs`, { method: 'POST', body: JSON.stringify({ id: quizRun, pause: mode === 'pause', questions: QUESTIONS, seed: 1000 + run }) });
        console.log(`[rr] ${mode} run ${run} ${tool}`);
        let sentinelOk = true;
        if (tool === 'overtake') await sentinelOvertake(env!, { mode, run }).catch((e) => log('sentinel.jsonl', { tool, mode, run, ok: false, err: String(e) }));
        else sentinelOk = await sentinelGateCli({ mode, run });
        const ctx = { mode, run, quizRun };
        await (tool === 'overtake' ? runOvertake(env!, ctx) : runCli(ctx, focus));
        const state = await (await fetch(`${SITE}/api/runs/${quizRun}`)).json();
        const cps = checkpoints(state, NAME);
        const shot = join(SHOTS, `${tool}-${mode}-r${run}.png`);
        cps.push({ name: 'screenshot_file', ok: existsSync(shot) && statSync(shot).size > 1000 });
        log('checkpoints.jsonl', { tool, mode, run, sentinelOk, cliFocus: tool === 'cli' ? focus : undefined, passed: cps.filter((c) => c.ok).length, total: cps.length, checkpoints: cps, pauses: state.events.filter((e: any) => e.type === 'pause').length, events: state.events.length });
        writeFileSync(join(OUT, `events-${quizRun}.json`), JSON.stringify(state.events));
      }
    }
  }
} finally {
  await env?.stop();
  quiz.close();
}
log('env.jsonl', { label: 'end', ...envSnapshot() });
console.log(`[rr] results in ${OUT}`);
const { report } = await import('./report.ts');
writeFileSync(join(OUT, 'summary.md'), report(OUT));
console.log(readFileSync(join(OUT, 'summary.md'), 'utf8'));
