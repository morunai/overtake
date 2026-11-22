// Per-space FIFO command executor.
//
// * Commands for one space run strictly one at a time, in arrival order.
// * Before each command starts, the control gate is consulted *at that moment*:
//   - run        -> execute
//   - wait       -> (AGENT_PAUSED) hold the queue head until the state changes
//   - refuse     -> reject with the gate's code; nothing is dispatched
// * cancelQueued() rejects everything not yet started (Take Over / Stop / close).
// Spaces have independent executors, so different spaces run in parallel.

import { OvertakeError, ErrorCode } from './protocol.ts';
import type { GateDecision } from './control.ts';

interface Job<T> {
  agent: string;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  pausedDeadline: number;
  pausedTimeoutMs: number;
  label: string;
}

export interface ExecutorOptions {
  gate: (agent: string) => GateDecision;
  now?: () => number;
  defaultPausedTimeoutMs?: number;
}

export class SpaceExecutor {
  #queue: Job<unknown>[] = [];
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #opts: Required<ExecutorOptions>;
  inFlight: string | null = null;

  constructor(opts: ExecutorOptions) {
    this.#opts = { now: () => Date.now(), defaultPausedTimeoutMs: 120_000, ...opts };
  }

  get size(): number {
    return this.#queue.length;
  }

  submit<T>(agent: string, run: () => Promise<T>, opts: { pausedTimeoutMs?: number; label?: string } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pausedTimeoutMs = opts.pausedTimeoutMs ?? this.#opts.defaultPausedTimeoutMs;
      this.#queue.push({
        agent,
        run,
        resolve: resolve as (v: unknown) => void,
        reject,
        pausedDeadline: Number.POSITIVE_INFINITY,
        pausedTimeoutMs,
        label: opts.label || 'command',
      } as Job<unknown>);
      this.#pump();
    });
  }

  /** Re-evaluate the queue head after a control-state change. */
  notify(): void {
    this.#pump();
  }

  /** Reject every queued (not yet started) command. */
  cancelQueued(code: string, message: string): number {
    const jobs = this.#queue.splice(0);
    for (const j of jobs) j.reject(new OvertakeError(code, message));
    this.#clearTimer();
    return jobs.length;
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #pump(): void {
    if (this.#running) return;
    this.#clearTimer();
    const job = this.#queue[0];
    if (!job) return;
    const d = this.#opts.gate(job.agent);
    if (!d.run) {
      if (d.wait) {
        const now = this.#opts.now();
        if (job.pausedDeadline === Number.POSITIVE_INFINITY) job.pausedDeadline = now + job.pausedTimeoutMs;
        if (now >= job.pausedDeadline) {
          this.#queue.shift();
          job.reject(new OvertakeError(ErrorCode.AGENT_PAUSED_TIMEOUT, `The human paused the agent and did not resume within ${job.pausedTimeoutMs} ms.`));
          this.#pump();
          return;
        }
        // Wake at the deadline; notify() wakes earlier on resume.
        this.#timer = setTimeout(() => this.#pump(), Math.max(1, job.pausedDeadline - now));
        return;
      }
      this.#queue.shift();
      job.reject(new OvertakeError(d.code, d.message));
      this.#pump();
      return;
    }
    this.#queue.shift();
    this.#running = true;
    this.inFlight = job.label;
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.#running = false;
        this.inFlight = null;
        this.#pump();
      });
  }
}
