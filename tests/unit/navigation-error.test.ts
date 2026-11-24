import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCertError, navigationError } from '../../mcp/navigation-error.ts';

test('navigation errors: certificate failures become CERT_ERROR with hand-off guidance', () => {
  for (const e of ['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED']) {
    assert.ok(isCertError(e), e);
  }
  const err = navigationError('https://localhost:8443/app', 'net::ERR_CERT_AUTHORITY_INVALID');
  assert.equal(err.code, 'CERT_ERROR');
  assert.match(err.message, /ERR_CERT_AUTHORITY_INVALID/);
  assert.match(err.message, /space_handoff/);
  assert.match(err.message, /Proceed to localhost:8443 \(unsafe\)/);
});

test('navigation errors: other failures stay CDP_ERROR with the original text', () => {
  for (const e of ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_SSL_PROTOCOL_ERROR']) {
    const err = navigationError('https://example.test/', e);
    assert.equal(err.code, 'CDP_ERROR', e);
    assert.equal(err.message, `Navigation to https://example.test/ failed: ${e}`);
  }
});
