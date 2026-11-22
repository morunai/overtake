// Redacts credentials from captured network traffic before it reaches the agent.
// Tool results go into the model's context (and often into logs and transcripts), so session
// tokens, cookies, API keys and passwords must never be returned verbatim.

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
]);

/** Names (header, query parameter, JSON or form field) whose values are treated as secrets. */
const SENSITIVE_NAME = /(passw(or)?d|passphrase|^pass$|^pwd$|secret|token|api[-_]?key|session|cookie|credential|auth|signature|private[-_]?key|(^|[-_])otp($|[-_]))/i;

/** Names that look sensitive but are routinely harmless and useful for debugging. */
const SAFE_NAME = /^(author|authors|authority|authored|token_type|expires_in|session_state)$|(^|[-_])(max|input|output|total|completion|prompt)[-_]?tokens?$/i;

export const isSensitiveName = (name: string) => !SAFE_NAME.test(name) && SENSITIVE_NAME.test(name);

const mask = (value: string) => `[redacted ${value.length} chars]`;

/** Keep the auth scheme ("Bearer", "Basic") so the agent can still see what kind of auth was used. */
function maskHeader(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (lower === 'authorization' || lower === 'proxy-authorization') {
    const m = /^(\w+)\s+(.+)$/s.exec(value);
    if (m) return `${m[1]} ${mask(m[2])}`;
  }
  if (lower === 'cookie') {
    return value.split(/;\s*/).map((pair) => {
      const i = pair.indexOf('=');
      return i < 0 ? pair : `${pair.slice(0, i)}=${mask(pair.slice(i + 1))}`;
    }).join('; ');
  }
  if (lower === 'set-cookie') {
    // One header may carry several cookies separated by newlines; keep attributes, mask values.
    return value.split('\n').map((line) => {
      const i = line.indexOf('=');
      const end = line.indexOf(';');
      if (i < 0) return line;
      const v = line.slice(i + 1, end < 0 ? undefined : end);
      return `${line.slice(0, i)}=${mask(v)}${end < 0 ? '' : line.slice(end)}`;
    }).join('\n');
  }
  return mask(value);
}

export function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object') return headers;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    const sensitive = SENSITIVE_HEADERS.has(lower) || isSensitiveName(lower);
    out[name] = sensitive && typeof value === 'string' ? maskHeader(name, value) : value;
  }
  return out;
}

/** Masks sensitive query parameter values; leaves the rest of the URL intact. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const masked = query.split('&').map((pair) => {
    const i = pair.indexOf('=');
    if (i < 0) return pair;
    let name = pair.slice(0, i);
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    return isSensitiveName(name) ? `${pair.slice(0, i)}=${encodeURIComponent(mask(pair.slice(i + 1)))}` : pair;
  }).join('&');
  return url.slice(0, q + 1) + masked + (hash < 0 ? '' : url.slice(hash));
}

function redactJsonValue(v: unknown, depth = 0): unknown {
  if (depth > 20 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactJsonValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = isSensitiveName(k) && (typeof x === 'string' || typeof x === 'number') ? mask(String(x)) : redactJsonValue(x, depth + 1);
  }
  return out;
}

/**
 * Masks sensitive fields in a request or response body. Handles JSON and
 * application/x-www-form-urlencoded; anything else is returned unchanged.
 */
export function redactBody(body: string | undefined, contentType?: string): string | undefined {
  if (!body) return body;
  const t = body.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(redactJsonValue(JSON.parse(body)));
    } catch {
      return body;
    }
  }
  const looksForm = /x-www-form-urlencoded/i.test(contentType ?? '') || /^[\w.%-]+=[^\s]*(&[\w.%-]+=[^\s]*)*$/.test(body);
  if (looksForm) return redactUrl(`?${body}`).slice(1);
  return body;
}

const headerValue = (headers: unknown, name: string): string | undefined => {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (k.toLowerCase() === name) return String(v);
  return undefined;
};

/** Redacts one captured network entry (as returned by browser_network get). */
export function redactNetworkEntry<T extends Record<string, unknown>>(e: T): T {
  return {
    ...e,
    url: typeof e.url === 'string' ? redactUrl(e.url) : e.url,
    requestHeaders: redactHeaders(e.requestHeaders),
    responseHeaders: redactHeaders(e.responseHeaders),
    postData: redactBody(e.postData as string | undefined, headerValue(e.requestHeaders, 'content-type')),
    responseBody: redactBody(e.responseBody as string | undefined, (e.mimeType as string | undefined) ?? headerValue(e.responseHeaders, 'content-type')),
  };
}
