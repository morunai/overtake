// Pure agent/human control state machine for one Space.
//
// States:   USER_CONTROL | AGENT_CONTROL | AGENT_PAUSED | STOPPED
// Rules:
//  * Only the owning agent can execute commands, and only in AGENT_CONTROL.
//  * AGENT_PAUSED queues the owner's commands (they wait, they do not run).
//  * A human Take Over can only be undone by a human Give Back; the agent cannot
//    take control back by itself (a take-over is a hard stop for the agent).
//  * An agent-initiated hand-off may be resumed by the same owner.
//  * Stop cancels the owner, releases ownership and never leaves input blocked.
//  * A disconnected owner never leaves the space in an agent state.

import type { ControlState, UserControlReason } from './protocol.ts';
import { ErrorCode } from './protocol.ts';

export interface ControlSnapshot {
  control: ControlState;
  owner: string | null;
  ownerConnected: boolean;
  userReason: UserControlReason | null;
  actionRequired: string | null;
}

export type ControlEvent =
  | { type: 'AGENT_CLAIM'; agent: string; force?: boolean }
  | { type: 'AGENT_RELEASE'; agent: string }
  | { type: 'AGENT_HANDOFF'; agent: string; reason?: string }
  | { type: 'AGENT_RESUME'; agent: string }
  | { type: 'AGENT_DISCONNECTED'; agent: string }
  | { type: 'AGENT_RECONNECTED'; agent: string }
  | { type: 'HUMAN_TAKEOVER' }
  | { type: 'HUMAN_GIVE_BACK' }
  | { type: 'HUMAN_PAUSE' }
  | { type: 'HUMAN_RESUME' }
  | { type: 'HUMAN_STOP' }
  | { type: 'HUMAN_ASSIGN'; agent: string };

export type TransitionResult =
  | { ok: true; state: ControlSnapshot; changed: boolean }
  | { ok: false; code: string; message: string };

export function initialControl(createdByAgent: string | null): ControlSnapshot {
  return createdByAgent
    ? { control: 'AGENT_CONTROL', owner: createdByAgent, ownerConnected: true, userReason: null, actionRequired: null }
    : { control: 'USER_CONTROL', owner: null, ownerConnected: false, userReason: 'unclaimed', actionRequired: null };
}

const ok = (prev: ControlSnapshot, next: ControlSnapshot): TransitionResult => ({
  ok: true,
  state: next,
  changed: JSON.stringify(prev) !== JSON.stringify(next),
});
const fail = (code: string, message: string): TransitionResult => ({ ok: false, code, message });

const agentState = (agent: string): ControlSnapshot => ({
  control: 'AGENT_CONTROL', owner: agent, ownerConnected: true, userReason: null, actionRequired: null,
});

export function transition(s: ControlSnapshot, e: ControlEvent): TransitionResult {
  switch (e.type) {
    case 'AGENT_CLAIM': {
      if (s.owner === e.agent) {
        if (s.control === 'AGENT_CONTROL' || s.control === 'AGENT_PAUSED') return ok(s, { ...s, ownerConnected: true });
        if (s.control === 'USER_CONTROL' && s.userReason === 'takeover') {
          return fail(ErrorCode.USER_IN_CONTROL, 'The human took over this space; wait until they give control back.');
        }
        return ok(s, agentState(e.agent));
      }
      if (s.owner && s.ownerConnected && !e.force) {
        return fail(ErrorCode.NOT_OWNER, 'This space is owned by another connected agent.');
      }
      if (s.control === 'USER_CONTROL' && s.userReason === 'takeover' && s.owner && s.ownerConnected) {
        return fail(ErrorCode.USER_IN_CONTROL, 'The human controls this space.');
      }
      return ok(s, agentState(e.agent));
    }
    case 'AGENT_RELEASE': {
      if (s.owner !== e.agent) return fail(ErrorCode.NOT_OWNER, 'Only the owning agent can release this space.');
      return ok(s, { control: 'USER_CONTROL', owner: null, ownerConnected: false, userReason: 'released', actionRequired: null });
    }
    case 'AGENT_HANDOFF': {
      if (s.owner !== e.agent) return fail(ErrorCode.NOT_OWNER, 'Only the owning agent can hand off this space.');
      if (s.control === 'USER_CONTROL' || s.control === 'STOPPED') {
        return fail(ErrorCode.USER_IN_CONTROL, 'The space is not under agent control.');
      }
      return ok(s, { ...s, control: 'USER_CONTROL', userReason: 'handoff', actionRequired: e.reason || 'The agent needs your action' });
    }
    case 'AGENT_RESUME': {
      if (s.owner !== e.agent) return fail(ErrorCode.NOT_OWNER, 'Only the owning agent can resume this space.');
      if (s.control === 'AGENT_CONTROL') return ok(s, s);
      if (s.control === 'USER_CONTROL' && s.userReason === 'handoff') return ok(s, agentState(e.agent));
      if (s.control === 'AGENT_PAUSED') return fail(ErrorCode.USER_IN_CONTROL, 'The human paused the agent; wait for Resume.');
      return fail(ErrorCode.USER_IN_CONTROL, 'The human controls this space; wait until they give control back.');
    }
    case 'AGENT_DISCONNECTED': {
      if (s.owner !== e.agent) return ok(s, s);
      if (s.control === 'AGENT_CONTROL' || s.control === 'AGENT_PAUSED') {
        return ok(s, { ...s, ownerConnected: false, control: 'USER_CONTROL', userReason: 'agent-disconnected', actionRequired: null });
      }
      return ok(s, { ...s, ownerConnected: false });
    }
    case 'AGENT_RECONNECTED': {
      if (s.owner !== e.agent) return ok(s, s);
      // Reconnection restores the connection flag only; control stays with the human
      // until the agent explicitly claims again (an explicit, visible transition).
      return ok(s, { ...s, ownerConnected: true });
    }
    case 'HUMAN_TAKEOVER': {
      if (s.control === 'AGENT_CONTROL' || s.control === 'AGENT_PAUSED') {
        return ok(s, { ...s, control: 'USER_CONTROL', userReason: 'takeover', actionRequired: null });
      }
      if (s.control === 'USER_CONTROL') return ok(s, s);
      return fail(ErrorCode.STOPPED, 'The agent was stopped; there is nothing to take over.');
    }
    case 'HUMAN_GIVE_BACK': {
      if (s.control !== 'USER_CONTROL') return fail(ErrorCode.BAD_REQUEST, 'Only a space under human control can be given back.');
      if (!s.owner) return fail(ErrorCode.BAD_REQUEST, 'No agent owns this space; assign one first.');
      if (!s.ownerConnected) return fail(ErrorCode.BAD_REQUEST, 'The owning agent is disconnected.');
      return ok(s, agentState(s.owner));
    }
    case 'HUMAN_PAUSE': {
      if (s.control === 'AGENT_PAUSED') return ok(s, s);
      if (s.control !== 'AGENT_CONTROL') return fail(ErrorCode.BAD_REQUEST, 'Only a running agent can be paused.');
      return ok(s, { ...s, control: 'AGENT_PAUSED' });
    }
    case 'HUMAN_RESUME': {
      if (s.control === 'AGENT_CONTROL') return ok(s, s);
      if (s.control !== 'AGENT_PAUSED') return fail(ErrorCode.BAD_REQUEST, 'The agent is not paused.');
      return ok(s, { ...s, control: 'AGENT_CONTROL' });
    }
    case 'HUMAN_STOP': {
      return ok(s, { control: 'STOPPED', owner: null, ownerConnected: false, userReason: null, actionRequired: null });
    }
    case 'HUMAN_ASSIGN': {
      return ok(s, agentState(e.agent));
    }
  }
}

/** Gate decision for one agent command. */
export type GateDecision = { run: true } | { run: false; wait: true } | { run: false; wait: false; code: string; message: string };

export function gate(s: ControlSnapshot, agent: string): GateDecision {
  if (s.owner !== agent) {
    if (s.control === 'STOPPED') return { run: false, wait: false, code: ErrorCode.STOPPED, message: 'The human stopped the agent in this space. Claim it again only if the user asks.' };
    return { run: false, wait: false, code: ErrorCode.NOT_OWNER, message: 'This agent does not own the space. Use space_claim first.' };
  }
  switch (s.control) {
    case 'AGENT_CONTROL':
      return { run: true };
    case 'AGENT_PAUSED':
      return { run: false, wait: true };
    case 'USER_CONTROL':
      return {
        run: false,
        wait: false,
        code: ErrorCode.USER_IN_CONTROL,
        message: s.userReason === 'handoff'
          ? 'Control is with the user (hand-off). Wait for space_wait_for_control or resume only when the user says so.'
          : 'The human has control of this space. This is a hard stop: do not retry; wait until they give control back.',
      };
    case 'STOPPED':
      return { run: false, wait: false, code: ErrorCode.STOPPED, message: 'The agent was stopped.' };
  }
}

/** Whether page input from the human must be blocked in this state. */
export function shieldActive(s: ControlSnapshot): boolean {
  return s.control === 'AGENT_CONTROL' || s.control === 'AGENT_PAUSED';
}
