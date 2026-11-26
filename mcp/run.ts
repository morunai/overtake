// browser_run: run a whole flow from one script, so the agent is in the loop only at the start
// and the end. The script runs in a worker (run-worker.ts); each API call comes back here and
// goes through the same Engine methods as the tools (real input, top-hit checks, settle).
//
// Stops:
// - A hard stop (USER_IN_CONTROL, STOPPED, SPACE_CLOSED, ...) terminates the worker at once,
//   so a script cannot catch the error and keep going after the human takes over. It is seen
//   from control events too, so a script that is sleeping or busy is stopped as well.
// - The total timeout and the step limit also terminate it.
// - Calls run one at a time, in order. When the run ends, calls not started yet are dropped;
//   the one in flight (a single action, such as one click) finishes. A script that returns
//   without awaiting its calls still has them run before success is reported.
// - Other errors are thrown into the script, which may catch them; if it does not, the run
//   fails with the step, the script line and a snapshot of the page.
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { extname, isAbsolute, basename } from 'node:path';
import { OvertakeError, ErrorCode, toWireError } from '../shared/protocol.ts';
import { isHardStop, type Engine } from './engine.ts';
import { requestScope, type BrokerClient } from './broker-client.ts';

const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs']);
const MAX_SCRIPT_BYTES = 1024 * 1024;

/** Read an agent-written script file: absolute path, a regular .js/.mjs/.cjs file, at most 1 MB.
 *  Opened non-blocking and checked on the descriptor, so a FIFO or device cannot hang the server. */
export function readScriptFile(path: string): string {
  if (!isAbsolute(path)) throw new OvertakeError(ErrorCode.BAD_REQUEST, `file must be an absolute path: ${path}`);
  if (!SCRIPT_EXT.has(extname(path).toLowerCase())) throw new OvertakeError(ErrorCode.BAD_REQUEST, `file must be a .js, .mjs or .cjs file: ${path}`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    throw new OvertakeError(ErrorCode.BAD_REQUEST, `cannot open ${path}: ${(e as NodeJS.ErrnoException).code || (e as Error).message}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new OvertakeError(ErrorCode.BAD_REQUEST, `not a regular file: ${path}`);
    if (st.size > MAX_SCRIPT_BYTES) throw new OvertakeError(ErrorCode.BAD_REQUEST, `file is larger than 1 MB: ${path}`);
    const buf = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > MAX_SCRIPT_BYTES) throw new OvertakeError(ErrorCode.BAD_REQUEST, `file is larger than 1 MB: ${path}`);
    }
    return buf.subarray(0, len).toString('utf8');
  } catch (e) {
    if (e instanceof OvertakeError) throw e;
    throw new OvertakeError(ErrorCode.BAD_REQUEST, `cannot read ${path}: ${(e as NodeJS.ErrnoException).code || (e as Error).message}`);
  } finally {
    closeSync(fd);
  }
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

function short(v: unknown, n = 60): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)) ?? String(v);
  } catch {
    s = Object.prototype.toString.call(v);
  }
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

type Opts = Record<string, unknown> | undefined;
type Call = { id: number; op: string; args?: unknown[]; line?: number };
type Where = { step?: number; op?: string; line?: number };

export async function runScript(engine: Engine, client: BrokerClient, o: RunOptions): Promise<RunOutcome> {
  const { tabId } = o;
  const spaceId = await engine.spaceOf(tabId);
  const t0 = Date.now();
  // Subscribe before refreshing state, so a take-over that arrives while the list is in
  // flight is not lost if the list reply is older than it.
  let pendingStop: { code: string; message: string } | null = null;
  let onStop = (code: string, message: string) => { pendingStop ??= { code, message }; };
  const unsubscribe = engine.subscribe((e) => {
    if (e.type === 'extension' && !e.connected) return onStop(ErrorCode.EXTENSION_NOT_CONNECTED, 'The Overtake extension disconnected.');
    if (e.type === 'space-closed' && e.spaceId === spaceId) return onStop(ErrorCode.SPACE_CLOSED, e.reason || `Space ${spaceId} was closed.`);
    if (e.type === 'control' && e.space.spaceId === spaceId) {
      const lost = engine.controlLost(spaceId);
      if (lost) onStop(lost.code, lost.message);
    }
  });
  try {
    await engine.listSpaces();
  } catch (e) {
    unsubscribe();
    throw e;
  }
  const stopped = pendingStop as { code: string; message: string } | null;
  const before = stopped ? new OvertakeError(stopped.code, stopped.message) : engine.controlLost(spaceId);
  if (before) {
    unsubscribe();
    throw before;
  }
  // Requests made for this run carry its runId. When the run ends, run.cancel tells the
  // extension to refuse any of them still queued (behind a pause, say), and later sub-steps
  // of an action in flight are refused the same way.
  const scope = { runId: randomUUID() };
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
    click: (target: string, opts: Opts) => acting(() => engine.click(tabId, target, { label: 'script: click', ...opts })),
    type: (target: string | null, text: string, opts: Opts) => acting(() => engine.type(tabId, { ...opts, target: target ?? undefined, text: String(text) })),
    fill: (target: string, text: string, opts: Opts) => acting(() => engine.type(tabId, { ...opts, target, text: String(text), clear: true })),
    select: (target: string, values: string | string[], opts: Opts) => acting(() => engine.select(tabId, target, values, opts ?? {})),
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
      const s = await engine.snapshot(tabId, { scope: opts?.scope === 'full_page' ? 'full_page' : 'viewport', root: typeof opts?.root === 'string' ? opts.root : undefined });
      return `url: ${s.url}\ntitle: ${s.title}\n\n${s.snapshot}`;
    },
    url: async () => (await engine.pageInfo(tabId)).url,
    evaluate: async (expression: string) => {
      const r = await engine.evaluate(tabId, String(expression));
      if (!r.ok) throw new OvertakeError('PAGE_EXCEPTION', String(r.exception));
      return r.value;
    },
  };

  const worker = new Worker(new URL('./run-worker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
  status('Running a script', true);

  const outcome = await new Promise<RunOutcome>((resolve) => {
    let ended = false;
    let active: (Where & { started: number }) | null = null;
    const queue: Call[] = [];
    let pumping: Promise<void> | null = null;
    let drained: (() => void) | null = null;

    const finish = (r: Omit<RunOutcome, 'steps' | 'ms' | 'logs' | 'trail' | 'lastActionAt'>) => {
      if (ended) return;
      ended = true;
      queue.length = 0; // calls not started yet never run
      void requestScope.exit(() => client.request('run.cancel', { runId: scope.runId })).catch(() => {});
      clearTimeout(timer);
      unsubscribe();
      void worker.terminate().catch(() => {});
      resolve({ ...r, steps, ms: Date.now() - t0, logs, trail: trail.slice(-MAX_TRAIL), lastActionAt });
    };
    const hardStop = (code: string, message: string, where: Where = active ?? {}) =>
      finish({ ok: false, hardStop: { code, message }, error: { code, message, ...where } });
    const fail = (error: RunOutcome['error'] & object) => finish({ ok: false, error });

    const timer = setTimeout(() => fail({ code: ErrorCode.TIMEOUT, message: `The script did not finish within ${o.timeoutMs} ms.`, ...(active ?? { step: steps }) }), o.timeoutMs);

    // Control changes stop the run at once, even while the script sleeps or computes.
    onStop = (code, message) => hardStop(code, message);

    const runOne = async (m: Call) => {
      const n = ++steps;
      if (n > o.maxSteps) return fail({ code: 'STEP_LIMIT', message: `The script went over maxSteps (${o.maxSteps}).`, step: n, op: m.op, line: m.line });
      const args = Array.isArray(m.args) ? m.args : [];
      const detail = args.length ? short(args.filter((a) => a !== undefined && a !== null).slice(0, 2).map((a) => short(a, 40)).join(' ')) : undefined;
      const where: Where = { step: n, op: m.op, line: m.line };
      active = { ...where, started: Date.now() };
      status(`Script step ${n}: ${m.op}${detail ? ` ${detail}` : ''}`);
      const s0 = Date.now();
      try {
        const fn = Object.hasOwn(ops, m.op) ? ops[m.op] : undefined;
        if (!fn) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Unknown script call ${m.op}.`);
        const value = await requestScope.run(scope, () => fn(...args));
        trail.push({ n, op: m.op, detail, line: m.line, ms: Date.now() - s0, ok: true });
        if (!ended) worker.postMessage({ type: 'reply', id: m.id, ok: true, value });
      } catch (e) {
        const w = toWireError(e);
        trail.push({ n, op: m.op, detail, line: m.line, ms: Date.now() - s0, ok: false });
        // Terminate now: the script must not be able to catch this and continue.
        if (isHardStop(w.code)) return hardStop(w.code, w.message, where);
        if (!ended) worker.postMessage({ type: 'reply', id: m.id, ok: false, error: { code: w.code, message: w.message, ...where } });
      } finally {
        active = null;
      }
    };

    // One call at a time, in order (the Engine serializes per Space anyway).
    const pump = () => {
      if (pumping) return;
      pumping = (async () => {
        while (!ended && queue.length) await runOne(queue.shift()!);
        pumping = null;
        drained?.();
      })().catch((e) => fail({ code: ErrorCode.INTERNAL, message: (e as Error).message }));
    };

    worker.on('message', (m: any) => {
      if (ended) return;
      try {
        if (m.type === 'log') {
          if (logs.length < MAX_LOGS) logs.push(String(m.text).slice(0, 2000));
          else if (logs.length === MAX_LOGS) logs.push('(more logs dropped)');
        } else if (m.type === 'call') {
          queue.push(m);
          pump();
        } else if (m.type === 'done') {
          // Calls the script started but did not await still run before success is reported.
          const ok = () => finish({ ok: true, result: m.value });
          if (!pumping && !queue.length) ok();
          else drained = () => { if (!queue.length && !pumping) ok(); };
        } else if (m.type === 'fail') {
          fail(m.error);
        }
      } catch (e) {
        fail({ code: ErrorCode.INTERNAL, message: (e as Error).message });
      }
    });
    worker.on('error', (e: Error) => fail({ code: 'SCRIPT_ERROR', message: e.message, ...(active ?? { step: steps }) }));
    worker.on('exit', (code) => fail({ code: 'SCRIPT_ERROR', message: `The script worker exited (${code}).`, ...(active ?? { step: steps }) }));
    worker.postMessage({ type: 'start', code: o.code, filename: o.filename, args: o.args ?? null });
  });

  if (!outcome.hardStop) status(outcome.ok ? `Script done (${outcome.steps} steps)` : `Script failed at step ${outcome.error?.step ?? '?'}`, true);
  return outcome;
}

export function scriptName(file?: string) {
  return file ? basename(file) : 'inline-script.js';
}
