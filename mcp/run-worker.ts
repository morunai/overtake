// Worker side of browser_run. The script runs here, in a vm context that holds only the
// script API; every API call is posted to the MCP server thread, which runs it through the
// same Engine paths the tools use. The server can terminate this worker at any time (hard
// stop, timeout, step limit), so a script cannot keep running after the human takes over.
// The vm context scopes what the script sees; it is not a security boundary.
import { parentPort } from 'node:worker_threads';
import vm from 'node:vm';

type Start = { type: 'start'; code: string; filename: string; args: unknown };
type Reply = { type: 'reply'; id: number; ok: boolean; value?: unknown; error?: { code: string; message: string; step?: number; op?: string; line?: number } };

const port = parentPort!;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; line?: number }>();
let seq = 0;
let filename = 'script.js';
// Success is reported only once the script has returned and no call is pending, after the
// event loop turns once: a .then() chain on an unawaited call may start another call.
let scriptDone = false;
let result: unknown;
let reported = false;
function maybeDone() {
  if (!scriptDone || reported || pending.size) return;
  setImmediate(() => {
    if (reported || pending.size) return;
    reported = true;
    port.postMessage({ type: 'done', value: jsonSafe(result) });
  });
}
// A call the script did not await that fails, with nothing handling it, fails the run.
process.on('unhandledRejection', (e) => {
  if (reported) return;
  reported = true;
  fail(e);
});

/** Line in the script file of the innermost stack frame from it. */
function lineOf(stack: string | undefined): number | undefined {
  if (!stack) return undefined;
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}:(\\d+)`).exec(stack);
  return m ? Number(m[1]) : undefined;
}

function call(op: string, ...args: unknown[]): Promise<unknown> {
  const line = lineOf(new Error().stack);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, line });
    port.postMessage({ type: 'call', id, op, args, line });
  });
}

function toText(v: unknown) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function jsonSafe(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

function start(m: Start) {
  filename = m.filename;
  const log = (...values: unknown[]) => port.postMessage({ type: 'log', text: values.map(toText).join(' ') });
  const api = {
    args: jsonSafe(m.args),
    click: (target: string, opts?: object) => call('click', target, opts),
    type: (target: string | null, text: string, opts?: object) => call('type', target, text, opts),
    fill: (target: string, text: string, opts?: object) => call('fill', target, text, opts),
    press: (keys: string, opts?: object) => call('press', keys, opts),
    hover: (target: string, opts?: object) => call('hover', target, opts),
    scroll: (opts?: object) => call('scroll', opts),
    drag: (from: string, to: string, opts?: object) => call('drag', from, to, opts),
    upload: (target: string, files: string[]) => call('upload', target, files),
    dialog: (accept: boolean, promptText?: string) => call('dialog', accept, promptText),
    navigate: (url: string, opts?: object) => call('navigate', url, opts),
    wait: (cond: unknown) => call('wait', cond),
    sleep: (ms: number) => call('sleep', ms),
    snapshot: (opts?: object) => call('snapshot', opts),
    url: () => call('url'),
    evaluate: (fn: unknown, ...args: unknown[]) =>
      call('evaluate', typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : String(fn)),
    assert: (cond: unknown, message?: string) => {
      if (cond) return;
      const e = new Error(message || 'Assertion failed') as Error & { code: string };
      e.code = 'ASSERTION_FAILED';
      throw e;
    },
    log,
    console: { log, info: log, warn: log, error: log },
  };
  const ctx = vm.createContext(api, { codeGeneration: { strings: true, wasm: false } });
  let promise: Promise<unknown>;
  try {
    // lineOffset -1: the wrapper's first line is not in the file, so stack lines match it.
    const script = new vm.Script(`(async () => {\n${m.code}\n})()`, { filename, lineOffset: -1 });
    promise = script.runInContext(ctx) as Promise<unknown>;
  } catch (e) {
    fail(e);
    return;
  }
  promise.then(
    (v) => {
      scriptDone = true;
      result = v;
      maybeDone();
    },
    (e) => {
      if (reported) return;
      reported = true;
      fail(e);
    },
  );
}

function fail(e: unknown) {
  // The step, op and line travel with the error itself, so rethrowing an older error still
  // points at the call that raised it.
  const err = (e ?? {}) as { name?: string; message?: string; code?: unknown; stack?: string; line?: number; step?: number; op?: string };
  let message: string;
  try {
    message = typeof err.message === 'string' ? err.message : String(e);
  } catch {
    message = 'Script error';
  }
  port.postMessage({
    type: 'fail',
    error: {
      code: typeof err.code === 'string' && err.code ? err.code : err.name === 'SyntaxError' ? 'SCRIPT_SYNTAX_ERROR' : 'SCRIPT_ERROR',
      message,
      line: typeof err.line === 'number' ? err.line : lineOf(err.stack),
      ...(typeof err.step === 'number' ? { step: err.step, op: err.op } : {}),
    },
  });
}

port.on('message', (m: Start | Reply) => {
  if (m.type === 'start') return start(m);
  if (m.type === 'reply') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    setImmediate(maybeDone); // after the script's own handlers for this reply have run
    if (m.ok) p.resolve(m.value);
    else {
      const e = new Error(m.error!.message) as Error & { code: string; line?: number; step?: number; op?: string };
      e.code = m.error!.code;
      e.line = p.line;
      e.step = m.error!.step;
      e.op = m.error!.op;
      p.reject(e);
    }
  }
});
