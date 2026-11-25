// browser_run: run a whole flow from one script, so the agent is in the loop only at the start
// and the end. The script runs in a worker (run-worker.ts); each API call comes back here and
// goes through the same Engine methods as the tools (real input, top-hit checks, settle).
//
// Stops:
// - A hard stop (USER_IN_CONTROL, STOPPED, SPACE_CLOSED, ...) terminates the worker at once,
//   so a script cannot catch the error and keep going after the human takes over.
// - The total timeout and the step limit also terminate it.
// - Other errors are thrown into the script, which may catch them; if it does not, the run
//   fails with the step, the script line and a snapshot of the page.
import { Worker } from 'node:worker_threads';
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, basename } from 'node:path';
import { OvertakeError, ErrorCode, toWireError } from '../shared/protocol.ts';
import { isHardStop, type Engine } from './engine.ts';
import type { BrokerClient } from './broker-client.ts';

const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs']);
const MAX_SCRIPT_BYTES = 1024 * 1024;

/** Read an agent-written script file: absolute path, .js/.mjs/.cjs, at most 1 MB. */
export function readScriptFile(path: string): string {
  if (!isAbsolute(path)) throw new OvertakeError(ErrorCode.BAD_REQUEST, `file must be an absolute path: ${path}`);
  if (!SCRIPT_EXT.has(extname(path).toLowerCase())) throw new OvertakeError(ErrorCode.BAD_REQUEST, `file must be a .js, .mjs or .cjs file: ${path}`);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new OvertakeError(ErrorCode.BAD_REQUEST, `file not found: ${path}`);
  }
  if (size > MAX_SCRIPT_BYTES) throw new OvertakeError(ErrorCode.BAD_REQUEST, `file is larger than 1 MB: ${path}`);
  return readFileSync(path, 'utf8');
}

export interface RunOptions {
  tabId: number;
  code: string;
  filename: string;
  args?: unknown;
  timeoutMs: number;
  maxSteps: number;
}

export interface Step {
  n: number;
  op: string;
  detail?: string;
  line?: number;
  ms: number;
  ok: boolean;
}

export interface RunOutcome {
  ok: boolean;
  steps: number;
  ms: number;
  result?: unknown;
  error?: { code: string; message: string; step?: number; op?: string; line?: number };
  logs: string[];
  trail: Step[];
  /** Set when the run ended on a hard stop: the caller reports it as a tool error. */
  hardStop?: { code: string; message: string };
  /** When the last input or navigation started, for settling before a snapshot. */
  lastActionAt?: number;
}

const MAX_LOGS = 200;
const MAX_TRAIL = 40;

function short(v: unknown, n = 60) {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

type Opts = Record<string, unknown> | undefined;

export async function runScript(engine: Engine, client: BrokerClient, o: RunOptions): Promise<RunOutcome> {
  const { tabId } = o;
  const spaceId = await engine.spaceOf(tabId);
  const t0 = Date.now();
  const logs: string[] = [];
  const trail: Step[] = [];
  let steps = 0;
  let lastActionAt: number | undefined;
  let lastStatusAt = 0;

  const status = (text: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastStatusAt < 400) return;
    lastStatusAt = now;
    void client.request('space.setStatus', { spaceId, text: text.slice(0, 120) }).catch(() => {});
  };

  const acting = <T>(p: () => Promise<T>) => {
    lastActionAt = Date.now();
    return p();
  };

  const ops: Record<string, (...a: any[]) => Promise<unknown>> = {
    click: (target: string, opts: Opts) => acting(() => engine.click(tabId, target, { label: `script: click`, ...opts })),
    type: (target: string | null, text: string, opts: Opts) => acting(() => engine.type(tabId, { ...opts, target: target ?? undefined, text: String(text) })),
    fill: (target: string, text: string, opts: Opts) => acting(() => engine.type(tabId, { ...opts, target, text: String(text), clear: true })),
    press: (keys: string, opts: Opts) => acting(() => engine.press(tabId, keys, Number(opts?.repeat ?? 1))),
    hover: (target: string, opts: Opts) => acting(() => engine.hover(tabId, target, opts?.label as string | undefined)),
    scroll: (opts: Opts) => acting(() => engine.scroll(tabId, { dx: 0, dy: 600, ...opts })),
    drag: (from: string, to: string, opts: Opts) => acting(() => engine.drag(tabId, from, to, opts?.label as string | undefined)),
    upload: (target: string, files: string[]) => acting(() => engine.upload(tabId, target, files)),
    dialog: (accept: boolean, promptText?: string) => engine.dialog(tabId, !!accept, promptText),
    navigate: (url: string, opts: Opts) => acting(() => engine.navigate(tabId, url, opts ?? {})),
    wait: (cond: unknown) => {
      if (typeof cond === 'number') return engine.wait(tabId, { delayMs: cond });
      if (typeof cond === 'string') return engine.wait(tabId, { selector: cond, state: 'visible' });
      if (!cond || typeof cond !== 'object') throw new OvertakeError(ErrorCode.BAD_REQUEST, 'wait takes a selector string, a number of ms, or a condition object.');
      return engine.wait(tabId, cond as Parameters<Engine['wait']>[1]);
    },
    sleep: (ms: number) => engine.wait(tabId, { delayMs: Math.max(0, Number(ms) || 0) }),
    snapshot: async (opts: Opts) => {
      if (lastActionAt !== undefined) await engine.settle(tabId, lastActionAt);
      const s = await engine.snapshot(tabId, { scope: opts?.scope === 'full_page' ? 'full_page' : 'viewport' });
      return `url: ${s.url}\ntitle: ${s.title}\n\n${s.snapshot}`;
    },
    url: async () => (await engine.pageInfo(tabId)).url,
    evaluate: async (expression: string) => {
      const r = await engine.evaluate(tabId, expression);
      if (!r.ok) throw new OvertakeError('PAGE_EXCEPTION', String(r.exception));
      return r.value;
    },
  };

  const worker = new Worker(new URL('./run-worker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
  status('Running a script', true);

  const outcome = await new Promise<RunOutcome>((resolve) => {
    let settled = false;
    const finish = (r: Omit<RunOutcome, 'steps' | 'ms' | 'logs' | 'trail' | 'lastActionAt'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ...r, steps, ms: Date.now() - t0, logs, trail: trail.slice(-MAX_TRAIL), lastActionAt });
    };
    const timer = setTimeout(() => finish({ ok: false, error: { code: ErrorCode.TIMEOUT, message: `The script did not finish within ${o.timeoutMs} ms.`, step: steps } }), o.timeoutMs);

    worker.on('message', async (m: any) => {
      if (settled) return;
      if (m.type === 'log') {
        if (logs.length < MAX_LOGS) logs.push(String(m.text).slice(0, 2000));
        else if (logs.length === MAX_LOGS) logs.push('(more logs dropped)');
        return;
      }
      if (m.type === 'done') return finish({ ok: true, result: m.value });
      if (m.type === 'fail') {
        const last = trail[trail.length - 1];
        return finish({ ok: false, error: { ...m.error, ...(last && !last.ok ? { step: last.n, op: last.op } : {}) } });
      }
      if (m.type !== 'call') return;
      const n = ++steps;
      if (n > o.maxSteps) {
        return finish({ ok: false, error: { code: 'STEP_LIMIT', message: `The script went over maxSteps (${o.maxSteps}).`, step: n, op: m.op, line: m.line } });
      }
      const fn = ops[m.op];
      const detail = m.args?.length ? short(m.args.filter((a: unknown) => a !== undefined && a !== null).slice(0, 2).map((a: unknown) => short(a, 40)).join(' ')) : undefined;
      status(`Script step ${n}: ${m.op}${detail ? ` ${detail}` : ''}`);
      const s0 = Date.now();
      try {
        if (!fn) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Unknown script call ${m.op}.`);
        const value = await fn(...(m.args ?? []));
        trail.push({ n, op: m.op, detail, line: m.line, ms: Date.now() - s0, ok: true });
        if (!settled) worker.postMessage({ type: 'reply', id: m.id, ok: true, value });
      } catch (e) {
        const w = toWireError(e);
        trail.push({ n, op: m.op, detail, line: m.line, ms: Date.now() - s0, ok: false });
        if (isHardStop(w.code)) {
          // Terminate now: the script must not be able to catch this and continue.
          return finish({ ok: false, hardStop: { code: w.code, message: w.message }, error: { code: w.code, message: w.message, step: n, op: m.op, line: m.line } });
        }
        if (!settled) worker.postMessage({ type: 'reply', id: m.id, ok: false, error: { code: w.code, message: w.message } });
      }
    });
    worker.on('error', (e: Error) => finish({ ok: false, error: { code: 'SCRIPT_ERROR', message: e.message, step: steps } }));
    worker.on('exit', (code) => finish({ ok: false, error: { code: 'SCRIPT_ERROR', message: `The script worker exited (${code}).`, step: steps } }));
    worker.postMessage({ type: 'start', code: o.code, filename: o.filename, args: o.args ?? null });
  });

  if (!outcome.hardStop) status(outcome.ok ? `Script done (${outcome.steps} steps)` : `Script failed at step ${outcome.error?.step ?? '?'}`, true);
  return outcome;
}

export function scriptName(file?: string) {
  return file ? basename(file) : 'inline-script.js';
}
