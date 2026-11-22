import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentIdentity } from '../../extension/src/ui/identity.ts';

test('agent identity hides raw session ids', () => {
  assert.deepEqual(agentIdentity('claude-code-78505'), { label: 'Claude Code', kind: 'claude' });
  assert.deepEqual(agentIdentity('codex-4411'), { label: 'Codex', kind: 'codex' });
  assert.deepEqual(agentIdentity('gemini-cli'), { label: 'Gemini', kind: 'gemini' });
  assert.deepEqual(agentIdentity('agent-alpha'), { label: 'Agent Alpha', kind: 'generic' });
  assert.deepEqual(agentIdentity('research_bot_12345'), { label: 'Research Bot', kind: 'generic' });
  assert.deepEqual(agentIdentity(null), { label: 'Agent', kind: 'generic' });
});
