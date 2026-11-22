// File upload (direct input and intercepted chooser), downloads attributed to the Space,
// and popups opened by agent clicks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Harness, type Agent } from './harness.ts';
import { startTestServer } from '../../test-site/server.mjs';

// Own server on its own port: the shared one on 8765 may be an older process reused by
// another run, and this test needs the current routes (/download).
const PORT = 8766;
const SITE = `http://127.0.0.1:${PORT}`;
let server: Server;

const h = new Harness();
let A: Agent;
let spaceId: number;
let tabId: number;
let dir: string;

before(async () => {
  server = (await startTestServer(PORT)) as Server;
  await h.start();
  dir = join(h.home, 'files');
  mkdirSync(join(dir, 'dl'), { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'alpha\n');
  writeFileSync(join(dir, 'b.txt'), 'bravo\n');
  // The harness plays the user's browser settings: downloads go to a throwaway folder,
  // never the real ~/Downloads. (Agents cannot change this; the policy denies it.)
  await h.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(dir, 'dl') });
  A = await h.agent('files');
  ({ spaceId, tabId } = await A.call('spaces_create', { name: 'files', url: `${SITE}/files.html` }));
  await A.call('browser_wait', { tabId, selector: '#choose' });
});
after(async () => {
  await h.stop();
  server?.close();
});

test('upload into a visible file input', async () => {
  const r = await A.call('browser_upload', { tabId, target: '#direct', files: [join(dir, 'a.txt')] });
  assert.equal(r.via, 'input');
  await A.call('browser_wait', { tabId, text: 'a.txt:alpha' });
});

test('upload through a button that opens the file chooser (multiple files)', async () => {
  const r = await A.call('browser_upload', { tabId, target: '#choose', files: [join(dir, 'a.txt'), join(dir, 'b.txt')] });
  assert.equal(r.via, 'chooser');
  assert.equal(r.mode, 'selectMultiple');
  await A.call('browser_wait', { tabId, text: 'a.txt:alpha | b.txt:bravo' });
});

test('upload rejects relative and missing paths', async () => {
  await assert.rejects(A.call('browser_upload', { tabId, target: '#direct', files: ['a.txt'] }), /absolute/);
  await assert.rejects(A.call('browser_upload', { tabId, target: '#direct', files: [join(dir, 'nope.txt')] }), /Not a readable file/);
});

test('a download started by an agent click is listed, awaited and saved', async () => {
  const since = Date.now();
  const click = await A.call('browser_click', { tabId, target: '#download' });
  assert.equal(click.navigated, false, 'a download is not a navigation');
  const w = await A.call('browser_downloads', { spaceId, action: 'wait', sinceMs: since, timeoutMs: 15000 });
  assert.equal(w.download.state, 'complete');
  assert.match(w.download.filename, /overtake-report.*\.txt$/);
  const out = join(dir, 'saved', 'report.txt');
  const s = await A.call('browser_downloads', { spaceId, action: 'save', downloadId: w.download.downloadId, path: out });
  assert.equal(s.saved, out);
  assert.equal(readFileSync(out, 'utf8'), 'report generated for agent\n');
  const l = await A.call('browser_downloads', { spaceId, action: 'list' });
  assert.ok(l.downloads.some((d: { downloadId: number }) => d.downloadId === w.download.downloadId));
});

test('a target=_blank click reports the popup and the new tab belongs to the agent', async () => {
  const r = await A.call('browser_click', { tabId, target: '#popup' });
  assert.equal(r.popups?.length, 1, JSON.stringify(r));
  const popup = r.popups[0];
  assert.equal(popup.managed, true);
  await A.call('browser_wait', { tabId: popup.tabId, urlIncludes: 'popup=1', load: true });
  const v = await A.call('browser_evaluate', { tabId: popup.tabId, expression: 'location.search' });
  assert.equal(v.value, '?popup=1');
});
