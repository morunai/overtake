// Shared rendering helpers for the Spaces overview and the toolbar popup.
import { agentIdentity, AGENT_LOGO, type AgentIdentity } from '../ui/identity.ts';

export interface SpaceTabV { tabId: number; openedBy: string; managed: boolean; url?: string; title?: string; active?: boolean }
export interface SpaceV {
  spaceId: number; name: string; windowId: number | null; createdBy: string; owner: string | null; ownerName: string | null;
  ownerConnected: boolean; control: string; userReason: string | null; statusText: string; actionRequired: string | null;
  error: string | null; tabs: SpaceTabV[]; createdAt: number;
}
export interface AgentV { agentKey: string; name: string; connected: boolean }
export interface Snapshot { spaces: SpaceV[]; agents: AgentV[]; brokerConnected: boolean; strictInputGate: boolean | null }

export async function human(action: string, spaceId?: number, extra: Record<string, unknown> = {}) {
  const r = await chrome.runtime.sendMessage({ type: 'overtake:human', action, spaceId, extra });
  if (!r?.ok) throw new Error(r?.error?.message || 'Action failed');
  return r.result;
}

/** Ownership at a glance: who drives this Space right now. */
export type Owner = 'agent' | 'paused' | 'human' | 'needs' | 'idle' | 'failed' | 'stopped';

export function ownerState(s: SpaceV): { key: Owner; label: string } {
  if (s.error) return { key: 'failed', label: 'Failed' };
  switch (s.control) {
    case 'AGENT_CONTROL': return { key: 'agent', label: 'Agent' };
    case 'AGENT_PAUSED': return { key: 'paused', label: 'Paused' };
    case 'STOPPED': return { key: 'stopped', label: 'Stopped' };
  }
  if (s.userReason === 'handoff') return { key: 'needs', label: 'Needs you' };
  if (s.userReason === 'takeover' || s.userReason === 'agent-disconnected') return { key: 'human', label: 'You' };
  return { key: 'idle', label: s.createdBy === 'user' ? 'Yours' : 'Idle' };
}

export function activity(s: SpaceV): string {
  const tab = activeTab(s);
  if (s.error) return s.error;
  if (s.control === 'AGENT_CONTROL') return s.statusText && s.statusText !== 'Starting' ? s.statusText : 'Browsing the web';
  if (s.control === 'AGENT_PAUSED') return 'Waiting for you to resume';
  if (s.userReason === 'handoff') return s.actionRequired || 'The agent needs your help';
  if (s.userReason === 'takeover') return s.ownerConnected ? 'You took over · agent waiting' : 'You took over';
  if (s.userReason === 'agent-disconnected') return 'The agent disconnected';
  return tab?.title || host(tab?.url) || 'New tab';
}

/** Contextual actions only: the ones that make sense in this state. */
export function controls(s: SpaceV): { action: string; label: string; kind?: 'primary' | 'accent' | 'icon'; icon?: string }[] {
  if (s.control === 'AGENT_CONTROL') return [{ action: 'takeover', label: 'Take over', kind: 'primary' }, { action: 'pause', label: 'Pause', kind: 'icon', icon: ICON.pause }, { action: 'stop', label: 'Stop', kind: 'icon', icon: ICON.stop }];
  if (s.control === 'AGENT_PAUSED') return [{ action: 'resume', label: 'Resume', kind: 'primary' }, { action: 'stop', label: 'Stop', kind: 'icon', icon: ICON.stop }];
  if (s.control === 'USER_CONTROL' && s.owner && s.ownerConnected) return [{ action: 'giveback', label: 'Give back', kind: 'accent' }];
  if (s.error) return [{ action: 'dismissError', label: 'Dismiss' }];
  return [];
}

export const ICON = {
  pause: '<svg viewBox="0 0 14 14"><rect x="3" y="2.5" width="2.6" height="9" rx="1" fill="currentColor"/><rect x="8.4" y="2.5" width="2.6" height="9" rx="1" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" rx="1.8" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 14 14"><path d="M3.5 3.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v4M8 4.9v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

export function identityOf(s: SpaceV): AgentIdentity | null {
  return s.owner ? agentIdentity(s.ownerName) : null;
}

export function logo(id: AgentIdentity): HTMLElement {
  const span = el('span', { class: `logo logo-${id.kind}`, 'aria-hidden': 'true' });
  span.innerHTML = AGENT_LOGO[id.kind];
  return span;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null) n.append(c);
  return n;
}

export function iconButton(label: string, svg: string, cls = ''): HTMLButtonElement {
  const b = el('button', { class: `icon ${cls}`.trim(), title: label, 'aria-label': label });
  b.innerHTML = svg;
  return b;
}

export function activeTab(s: SpaceV): SpaceTabV | undefined {
  return s.tabs.find((t) => t.active) || s.tabs[0];
}

export function host(url?: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.protocol.startsWith('http') ? u.host : '';
  } catch {
    return '';
  }
}
