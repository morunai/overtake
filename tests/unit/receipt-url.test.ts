import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptUrl } from '../../mcp/engine.ts';

test('receipt URLs keep query names but no values, credentials or fragment', () => {
  assert.equal(receiptUrl('https://user:pw@example.com/cb?code=abc&state=x#frag'), 'https://example.com/cb?code=…&state=…');
  assert.equal(receiptUrl('https://example.com/api/board'), 'https://example.com/api/board');
  assert.doesNotMatch(receiptUrl('not a url ?token=1'), /token=1/);
});
