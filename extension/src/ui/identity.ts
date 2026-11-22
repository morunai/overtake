// Agent identity: a friendly label and mark from the raw agent name the MCP
// server reports (e.g. "claude-code-78505" -> "Claude Code"). Raw names and keys
// stay available in the overview's details view, never in the main UI.
//
// Marks are Overtake's own neutral monograms (no third-party logos).

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'generic';

export interface AgentIdentity {
  label: string;
  kind: AgentKind;
}

export function agentIdentity(raw: string | null | undefined): AgentIdentity {
  const name = (raw || '').trim();
  if (!name) return { label: 'Agent', kind: 'generic' };
  if (/claude/i.test(name)) return { label: /code/i.test(name) ? 'Claude Code' : 'Claude', kind: 'claude' };
  if (/codex|openai|gpt/i.test(name)) return { label: 'Codex', kind: 'codex' };
  if (/gemini/i.test(name)) return { label: 'Gemini', kind: 'gemini' };
  const clean = name.replace(/[-_]?\d{3,}$/, '').replace(/[-_]+/g, ' ').trim();
  return { label: clean ? clean.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Agent', kind: 'generic' };
}

const SPARKLE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z" fill="currentColor"/></svg>';

/** A monogram: one or two letters in the system font, drawn in the current colour. */
function monogram(text: string): string {
  const size = text.length > 1 ? 10.5 : 14;
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, system-ui, sans-serif" font-size="${size}" font-weight="650" fill="currentColor">${text}</text></svg>`;
}

export const AGENT_LOGO: Record<AgentKind, string> = {
  claude: monogram('C'),
  codex: monogram('Cx'),
  gemini: monogram('G'),
  generic: SPARKLE,
};
