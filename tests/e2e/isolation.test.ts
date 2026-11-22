// Storage isolation, measured rather than assumed:
//  * two Spaces in one Chrome profile share cookies/localStorage
//  * a Space in the optional isolated Chrome (separate process + profile) shares nothing
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, SITE, type Agent } from './harness.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const h = new Harness();
const isoRoot = mkdtempSync(join(tmpdir(), 'overtake-iso-'));
let iso: ChildProcess;
let isoInfo: { ready: boolean; overtakeHome: string; pid: number };
let M: Agent;
let I: Agent;

const readStore = (a: Agent, tabId: number) => a.call('browser_evaluate', { tabId, expression: `({ ls: localStorage.getItem('who'), cookie: document.cookie })` }).then((r) => r.value);

before(async () => {
  await h.start();
  iso = spawn(process.execPath, [join(ROOT, 'scripts', 'isolated-chrome.mjs'), 'e2e', '--headless'], { env: { ...process.env, OVERTAKE_ISOLATED_ROOT: isoRoot }, stdio: ['ignore', 'pipe', 'inherit'] });
  isoInfo = await new Promise((resolve, reject) => {
    let out = '';
    iso.stdout!.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    iso.on('exit', (c) => reject(new Error(`isolated launcher exited ${c}`)));
  });
  M = await h.agent('main-agent');
  I = await h.agent('isolated-agent', isoInfo.overtakeHome);
});

after(async () => {
  iso?.kill();
  await h.stop();
  rmSync(isoRoot, { recursive: true, force: true });
});

test('isolated launcher starts its own broker', () => {
  assert.equal(isoInfo.ready, true);
});

test('Spaces in one profile share storage', async () => {
  const s1 = await M.call('spaces_create', { name: 'shared 1', url: `${SITE}/?s=1` });
  const s2 = await M.call('spaces_create', { name: 'shared 2', url: `${SITE}/?s=2` });
  await M.call('browser_wait', { tabId: s1.tabId, load: true });
  await M.call('browser_wait', { tabId: s2.tabId, load: true });
  await M.call('browser_evaluate', { tabId: s1.tabId, expression: `localStorage.setItem('who', 'space-1'); document.cookie = 'who=space-1; path=/'; true` });
  const seen = await readStore(M, s2.tabId);
  assert.equal(seen.ls, 'space-1');
  assert.match(seen.cookie, /who=space-1/);
});

test('a Space in the isolated Chrome sees none of it', async () => {
  const s = await I.call('spaces_create', { name: 'isolated', url: `${SITE}/?iso=1` });
  await I.call('browser_wait', { tabId: s.tabId, load: true });
  const seen = await readStore(I, s.tabId);
  assert.equal(seen.ls, null);
  assert.doesNotMatch(seen.cookie, /who=/);
  // And the main agent cannot see or touch the isolated browser's spaces.
  const mainList = await M.call('spaces_list');
  assert.ok(!mainList.spaces.some((x: { name: string }) => x.name === 'isolated'));
});
