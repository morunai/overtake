import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialControl, transition, gate, shieldActive, type ControlSnapshot, type ControlEvent } from '../../shared/control.ts';

const A = 'agentA_123';
const B = 'agentB_456';

function step(s: ControlSnapshot, e: ControlEvent): ControlSnapshot {
  const r = transition(s, e);
  assert.ok(r.ok, `expected ${e.type} to succeed: ${!r.ok ? r.message : ''}`);
  return r.state;
}
function refuse(s: ControlSnapshot, e: ControlEvent, code: string) {
  const r = transition(s, e);
  assert.equal(r.ok, false, `expected ${e.type} to be refused`);
  if (!r.ok) assert.equal(r.code, code);
}

test('agent-created space starts in AGENT_CONTROL owned by its creator', () => {
  const s = initialControl(A);
  assert.equal(s.control, 'AGENT_CONTROL');
  assert.equal(s.owner, A);
  assert.deepEqual(gate(s, A), { run: true });
  assert.equal(shieldActive(s), true);
});

test('only the owner can execute; others get NOT_OWNER', () => {
  const s = initialControl(A);
  const d = gate(s, B);
  assert.equal(d.run, false);
  assert.equal(!d.run && !d.wait && d.code, 'NOT_OWNER');
});

test('human take over suspends the agent and cannot be undone by the agent', () => {
  let s = step(initialControl(A), { type: 'HUMAN_TAKEOVER' });
  assert.equal(s.control, 'USER_CONTROL');
  assert.equal(s.userReason, 'takeover');
  assert.equal(shieldActive(s), false);
  const d = gate(s, A);
  assert.equal(!d.run && !d.wait && d.code, 'USER_IN_CONTROL');
  refuse(s, { type: 'AGENT_RESUME', agent: A }, 'USER_IN_CONTROL');
  refuse(s, { type: 'AGENT_CLAIM', agent: A }, 'USER_IN_CONTROL');
  s = step(s, { type: 'HUMAN_GIVE_BACK' });
  assert.equal(s.control, 'AGENT_CONTROL');
  assert.equal(s.owner, A);
});

test('agent hand-off can be resumed by the same owner, not by others', () => {
  let s = step(initialControl(A), { type: 'AGENT_HANDOFF', agent: A, reason: 'Log in please' });
  assert.equal(s.control, 'USER_CONTROL');
  assert.equal(s.actionRequired, 'Log in please');
  refuse(s, { type: 'AGENT_RESUME', agent: B }, 'NOT_OWNER');
  s = step(s, { type: 'AGENT_RESUME', agent: A });
  assert.equal(s.control, 'AGENT_CONTROL');
  assert.equal(s.actionRequired, null);
});

test('pause queues (wait) instead of refusing; resume continues', () => {
  let s = step(initialControl(A), { type: 'HUMAN_PAUSE' });
  assert.equal(s.control, 'AGENT_PAUSED');
  assert.deepEqual(gate(s, A), { run: false, wait: true });
  assert.equal(shieldActive(s), true, 'page stays shielded while paused');
  refuse(s, { type: 'AGENT_RESUME', agent: A }, 'USER_IN_CONTROL');
  s = step(s, { type: 'HUMAN_RESUME' });
  assert.deepEqual(gate(s, A), { run: true });
});

test('stop releases ownership and unblocks the page', () => {
  const s = step(initialControl(A), { type: 'HUMAN_STOP' });
  assert.equal(s.control, 'STOPPED');
  assert.equal(s.owner, null);
  assert.equal(shieldActive(s), false);
  const d = gate(s, A);
  assert.equal(!d.run && !d.wait && d.code, 'STOPPED');
  // After a stop the agent may explicitly claim again (only if the user asks).
  const again = step(s, { type: 'AGENT_CLAIM', agent: A });
  assert.equal(again.control, 'AGENT_CONTROL');
});

test('disconnect never leaves an agent state behind', () => {
  for (const start of [initialControl(A), step(initialControl(A), { type: 'HUMAN_PAUSE' })]) {
    const s = step(start, { type: 'AGENT_DISCONNECTED', agent: A });
    assert.equal(s.control, 'USER_CONTROL');
    assert.equal(s.userReason, 'agent-disconnected');
    assert.equal(s.ownerConnected, false);
    assert.equal(shieldActive(s), false);
    refuse(s, { type: 'HUMAN_GIVE_BACK' }, 'BAD_REQUEST');
  }
});

test('reconnect restores the flag only; the agent must claim explicitly', () => {
  let s = step(initialControl(A), { type: 'AGENT_DISCONNECTED', agent: A });
  s = step(s, { type: 'AGENT_RECONNECTED', agent: A });
  assert.equal(s.ownerConnected, true);
  assert.equal(s.control, 'USER_CONTROL');
  s = step(s, { type: 'AGENT_CLAIM', agent: A });
  assert.equal(s.control, 'AGENT_CONTROL');
});

test('another agent can claim only when the owner is gone', () => {
  const s = initialControl(A);
  refuse(s, { type: 'AGENT_CLAIM', agent: B }, 'NOT_OWNER');
  const gone = step(s, { type: 'AGENT_DISCONNECTED', agent: A });
  const taken = step(gone, { type: 'AGENT_CLAIM', agent: B });
  assert.equal(taken.owner, B);
});

test('user space is unclaimed and needs an explicit claim', () => {
  const s = initialControl(null);
  assert.equal(s.control, 'USER_CONTROL');
  assert.equal(s.userReason, 'unclaimed');
  assert.equal(gate(s, A).run, false);
  const c = step(s, { type: 'AGENT_CLAIM', agent: A });
  assert.equal(c.owner, A);
});

test('release returns the space to the user', () => {
  const s = step(initialControl(A), { type: 'AGENT_RELEASE', agent: A });
  assert.equal(s.owner, null);
  assert.equal(s.userReason, 'released');
  refuse(initialControl(A), { type: 'AGENT_RELEASE', agent: B }, 'NOT_OWNER');
});
