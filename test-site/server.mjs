// Minimal local test server: static files + JSON API, loopback only.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8765);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function startTestServer(p = port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/data') {
      // ?delay=ms answers late, like a real API, for the snapshot-after-action test.
      const delay = Math.min(Number(url.searchParams.get('delay')) || 0, 5000);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      res.writeHead(200, { 'content-type': 'application/json', 'x-test-header': 'overtake' });
      res.end(JSON.stringify({ message: 'hello from api', query: Object.fromEntries(url.searchParams) }));
      return;
    }
    if (url.pathname === '/api/session') {
      // Fake login endpoint for the redaction test: a session cookie and a token in the body.
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=test-session-secret; Path=/; HttpOnly' });
      res.end(JSON.stringify({ ok: true, user: 'tester', access_token: 'test-access-secret' }));
      return;
    }
    if (url.pathname === '/download') {
      const body = `report generated for ${url.searchParams.get('name') || 'test'}\n`;
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="overtake-report.txt"`, 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(root, rel));
      res.writeHead(200, { 'content-type': types[extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(p, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startTestServer().then(() => console.log(`test site on http://127.0.0.1:${port}`));
}
