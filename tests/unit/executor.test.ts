import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceExecutor } from '../../shared/executor.ts';
import { gate, initialControl, transition, type ControlSnapshot, type ControlEvent } from '../../shared/control.ts';

const A = 'agentA_123';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(start: ControlSnapshot = initialControl(A)) {
  let state = start;
  const ex = new SpaceExecutor({ gate: (agent) => gate(state, agent), defaultPausedTimeoutMs: 1000 });
  const apply = (e: ControlEvent) => {
    const r = transition(state, e);
    assert.ok(r.ok);
    state = r.state;
    ex.notify();
  };
  return { ex, apply, get state() { return state; } };
}

test('commands run strictly in order, one at a time', async () => {
  const { ex } = harness();
  const log: string[] = [];
  let active = 0;
  const job = (name: string, ms: number) => ex.submit(A, async () => {
    active++;
    assert.equal(active, 1, 'never two commands at once');
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    active--;
    return name;
  });
  const results = await Promise.all([job('a', 30), job('b', 5), job('c', 10)]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('take over: in-flight finishes, queued commands are refused, nothing else runs', async () => {
  const h = harness();
  const ran: string[] = [];
  const first = h.ex.submit(A, async () => {
    ran.push('first');
    await sleep(40);
    return 'first';
  });
  const second = h.ex.submit(A, async () => {
    ran.push('second');
    return 'second';
  });
  const secondRefused = assert.rejects(second, (e: Error & { code: string }) => e.code === 'USER_IN_CONTROL');
  await sleep(5);
  h.apply({ type: 'HUMAN_TAKEOVER' });
  h.ex.cancelQueued('USER_IN_CONTROL', 'taken over');
  assert.equal(await first, 'first');
  await secondRefused;
  // New submissions while the human has control are refused at dispatch time.
  await assert.rejects(h.ex.submit(A, async () => ran.push('third')), (e: Error & { code: string }) => e.code === 'USER_IN_CONTROL');
  assert.deepEqual(ran, ['first']);
});

test('give back: the agent can resume', async () => {
  const h = harness();
  h.apply({ type: 'HUMAN_TAKEOVER' });
  await assert.rejects(h.ex.submit(A, async () => 1));
  h.apply({ type: 'HUMAN_GIVE_BACK' });
  assert.equal(await h.ex.submit(A, async () => 42), 42);
});

test('pause holds the queue until resume, then drains in order', async () => {
  const h = harness();
  h.apply({ type: 'HUMAN_PAUSE' });
  const order: number[] = [];
  const p1 = h.ex.submit(A, async () => order.push(1));
  const p2 = h.ex.submit(A, async () => order.push(2));
  await sleep(50);
  assert.deepEqual(order, [], 'nothing runs while paused');
  h.apply({ type: 'HUMAN_RESUME' });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});

test('paused commands time out with AGENT_PAUSED_TIMEOUT', async () => {
  const h = harness();
  h.apply({ type: 'HUMAN_PAUSE' });
  await assert.rejects(h.ex.submit(A, async () => 1, { pausedTimeoutMs: 60 }), (e: Error & { code: string }) => e.code === 'AGENT_PAUSED_TIMEOUT');
});

test('stop cancels queued work', async () => {
  const h = harness();
  const slow = h.ex.submit(A, () => sleep(30).then(() => 'done'));
  const queued = h.ex.submit(A, async () => 'never');
  const refused = assert.rejects(queued, (e: Error & { code: string }) => e.code === 'STOPPED');
  h.apply({ type: 'HUMAN_STOP' });
  assert.equal(h.ex.cancelQueued('STOPPED', 'stopped'), 1);
  assert.equal(await slow, 'done');
  await refused;
});

test('a failing command does not poison the queue', async () => {
  const { ex } = harness();
  await assert.rejects(ex.submit(A, async () => {
    throw new Error('boom');
  }));
  assert.equal(await ex.submit(A, async () => 'ok'), 'ok');
});

test('disconnect refuses queued commands for the gone agent', async () => {
  const h = harness();
  h.apply({ type: 'HUMAN_PAUSE' });
  const p = h.ex.submit(A, async () => 1);
  h.apply({ type: 'AGENT_DISCONNECTED', agent: A });
  await assert.rejects(p, (e: Error & { code: string }) => e.code === 'USER_IN_CONTROL');
});

test('separate spaces run concurrently', async () => {
  const a = harness();
  const b = harness();
  const t0 = Date.now();
  await Promise.all([a.ex.submit(A, () => sleep(60)), b.ex.submit(A, () => sleep(60))]);
  assert.ok(Date.now() - t0 < 110, 'two spaces should not serialize each other');
});
