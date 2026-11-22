import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveName, redactBody, redactHeaders, redactNetworkEntry, redactUrl } from '../../mcp/redact.ts';

const SECRET = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';

test('redact: auth headers keep the scheme and hide the credential', () => {
  const h = redactHeaders({ Authorization: `Bearer ${SECRET}`, 'Proxy-Authorization': 'Basic dXNlcjpwYXNz', 'Content-Type': 'application/json' }) as Record<string, string>;
  assert.equal(h.Authorization, `Bearer [redacted ${SECRET.length} chars]`);
  assert.equal(h['Proxy-Authorization'], 'Basic [redacted 12 chars]');
  assert.equal(h['Content-Type'], 'application/json');
  assert.ok(!JSON.stringify(h).includes(SECRET));
});

test('redact: cookies keep names and attributes, hide values', () => {
  const h = redactHeaders({
    cookie: 'sid=abc123; theme=dark',
    'set-cookie': 'sid=abc123; Path=/; HttpOnly\nrefresh=zzz999; Secure',
  }) as Record<string, string>;
  assert.equal(h.cookie, 'sid=[redacted 6 chars]; theme=[redacted 4 chars]');
  assert.equal(h['set-cookie'], 'sid=[redacted 6 chars]; Path=/; HttpOnly\nrefresh=[redacted 6 chars]; Secure');
});

test('redact: custom token and key headers are masked, ordinary headers are not', () => {
  const h = redactHeaders({ 'X-Api-Key': 'k-123', 'X-CSRF-Token': 'c-1', 'X-Session-Id': 's-1', 'X-Request-Id': 'r-1', Accept: '*/*' }) as Record<string, string>;
  assert.equal(h['X-Api-Key'], '[redacted 5 chars]');
  assert.equal(h['X-CSRF-Token'], '[redacted 3 chars]');
  assert.equal(h['X-Session-Id'], '[redacted 3 chars]');
  assert.equal(h['X-Request-Id'], 'r-1');
  assert.equal(h.Accept, '*/*');
});

test('redact: sensitive query parameters only', () => {
  assert.equal(
    redactUrl('https://a.test/cb?code=1&access_token=abc&state=x&page=2#frag'),
    `https://a.test/cb?code=1&access_token=${encodeURIComponent('[redacted 3 chars]')}&state=x&page=2#frag`,
  );
  assert.equal(redactUrl('https://a.test/plain'), 'https://a.test/plain');
});

test('redact: JSON bodies, nested and in arrays', () => {
  const out = JSON.parse(redactBody(JSON.stringify({ user: 'moru', password: 'hunter2', nested: { refresh_token: 'r', items: [{ apiKey: 'k', id: 1 }] }, max_tokens: 1024 }))!);
  assert.equal(out.user, 'moru');
  assert.equal(out.password, '[redacted 7 chars]');
  assert.equal(out.nested.refresh_token, '[redacted 1 chars]');
  assert.equal(out.nested.items[0].apiKey, '[redacted 1 chars]');
  assert.equal(out.nested.items[0].id, 1);
  assert.equal(out.max_tokens, 1024, 'token counts are not secrets');
});

test('redact: form bodies; plain text and invalid JSON pass through', () => {
  assert.equal(redactBody('username=moru&password=hunter2', 'application/x-www-form-urlencoded'), `username=moru&password=${encodeURIComponent('[redacted 7 chars]')}`);
  assert.equal(redactBody('hello world'), 'hello world');
  assert.equal(redactBody('{not json'), '{not json');
  assert.equal(redactBody(undefined), undefined);
});

test('redact: name rules avoid common false positives', () => {
  for (const n of ['password', 'passwd', 'client_secret', 'id_token', 'sessionid', 'X-Auth-Token', 'api_key', 'otp', 'mfa_otp']) assert.ok(isSensitiveName(n), n);
  for (const n of ['author', 'passenger', 'compass', 'footprint', 'max_tokens', 'maxTokens', 'token_type', 'expires_in', 'page']) assert.ok(!isSensitiveName(n), n);
});

test('redact: a whole network entry leaks nothing', () => {
  const e = redactNetworkEntry({
    requestId: '1', url: `https://api.test/v1/posts?token=${SECRET}`, method: 'POST', mimeType: 'application/json',
    requestHeaders: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    responseHeaders: { 'set-cookie': `sid=${SECRET}; HttpOnly` },
    postData: JSON.stringify({ title: 'hi', session: SECRET }),
    responseBody: JSON.stringify({ ok: true, access_token: SECRET }),
  });
  assert.ok(!JSON.stringify(e).includes(SECRET), JSON.stringify(e));
  assert.equal(JSON.parse(e.postData as string).title, 'hi');
  assert.equal(JSON.parse(e.responseBody as string).ok, true);
});
