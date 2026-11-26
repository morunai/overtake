// Smaller, steadier results: snapshot headers only on change, short hrefs, snapshots of one part,
// stable refs, waiting for text to go away, control state after a click, frame owners.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, SITE, type Agent } from './harness.ts';

const h = new Harness();
let A: Agent;
let tabId: number;
const code = (e: unknown) => (e as { code?: string }).code;
const snapText = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

before(async () => {
  await h.start();
  A = await h.agent('results');
  ({ tabId } = await A.call('spaces_create', { name: 'results' }));
  await A.call('browser_navigate', { tabId, url: `${SITE}/console.html` });
});
after(async () => {
  await h.stop();
});

test('snapshots: links to the page print short, and the header after an action only on change', async () => {
  const s = await A.call('browser_snapshot', { tabId, scope: 'full_page' });
  assert.match(s, /^url: http:\/\/127\.0\.0\.1:8765\/console\.html#state=q+…\(\+\d+ chars\)$/m, 'a long url is cut in the header');
  assert.match(s, /link "Service 0" @\d+\n/, 'a bare "#" link has no href');
  assert.doesNotMatch(s, /href=http:\/\/127\.0\.0\.1:8765\/console\.html/);
  assert.match(s, /link "Docs" @\d+ \[href=\/docs\/start\?x=1\]/, 'same-origin links print their path');
  // An action with snapshot: true, nothing changed: no url/title header.
  let r = await A.callRaw('browser_click', { tabId, target: '#more', snapshot: true });
  assert.doesNotMatch(snapText(r), /^url: /m);
  // The url changes: the receipt says so once, and the snapshot does not repeat it.
  r = await A.callRaw('browser_click', { tabId, target: '#hash', snapshot: true });
  assert.match(snapText(r), /"url": "http:\/\/127\.0\.0\.1:8765\/console\.html#state=v+…\(\+\d+ chars\)"/);
  assert.doesNotMatch(snapText(r), /^url: /m);
});

test('a snapshot of one part, and refs that keep their numbers', async () => {
  const part = await A.call('browser_snapshot', { tabId, root: '#panel' });
  assert.match(part, /button "Run query" @\d+/);
  assert.doesNotMatch(part, /Service 0/);
  const ref = /button "Run query" (@\d+)/.exec(part)![1];
  const again = await A.call('browser_snapshot', { tabId, scope: 'full_page' });
  assert.equal(/button "Run query" (@\d+)/.exec(again)![1], ref, 'same element, same ref');
  await A.call('browser_click', { tabId, target: ref });
  await assert.rejects(A.call('browser_snapshot', { tabId, root: '#nope' }), (e: Error) => code(e) === 'ELEMENT_NOT_FOUND');
});

test('wait for text to go away', async () => {
  await A.call('browser_click', { tabId, target: '#run', waitForText: 'Running...' });
  await A.call('browser_wait', { tabId, textGone: 'Running...', timeoutMs: 5000 });
  await A.call('browser_wait', { tabId, text: 'Query complete.' });
  await assert.rejects(A.call('browser_wait', { tabId, textGone: 'Query complete.', timeoutMs: 300 }), (e: Error) => code(e) === 'TIMEOUT');
});

test('a click reports the state of the control it changed', async () => {
  let r = await A.call('browser_click', { tabId, target: '#prd' });
  assert.deepEqual(r.state, { checked: true });
  r = await A.call('browser_click', { tabId, target: 'text=/member-prd/ecs' });
  assert.deepEqual(r.state, { checked: false }, 'through its label');
  r = await A.call('browser_click', { tabId, target: '#live' });
  assert.deepEqual(r.state, { checked: true });
  r = await A.call('browser_click', { tabId, target: '#more' });
  assert.equal(typeof r.state.expanded, 'boolean');
  r = await A.call('browser_click', { tabId, target: '#docs' });
  assert.equal(r.state, undefined);
});

test('frames list the selector of their iframe element, usable as a snapshot root', async () => {
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html` });
  await A.call('browser_wait', { tabId, selector: '#run' });
  const fr = await A.call('browser_frames', { tabId });
  const owners = fr.frames.map((f: { owner?: string }) => f.owner).filter(Boolean);
  assert.ok(owners.includes('iframe#feature'), JSON.stringify(fr.frames));
  assert.ok(owners.includes('iframe#remote'), JSON.stringify(fr.frames));
  const s = await A.call('browser_snapshot', { tabId, root: 'iframe#feature' });
  assert.match(s, /button "Run query" @\d+/);
  assert.doesNotMatch(s, /Top button|Run remote query/);
});
