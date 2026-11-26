// Apps whose feature UI lives in iframes (cloud consoles): selectors, typing, waits and
// snapshots reach into same-origin and cross-site iframes; results stay small.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, SITE, pngSize, type Agent } from './harness.ts';

const h = new Harness();
let A: Agent;
let tabId: number;

const code = (e: unknown) => (e as { code?: string }).code;
const inFeature = async (expr: string) => (await A.call('browser_evaluate', { tabId, expression: `document.getElementById('feature').contentWindow.${expr}` })).value;
const remoteFrame = async () => (await A.call('browser_frames', { tabId })).frames.find((f: { outOfProcess: boolean; sessionId?: string }) => f.outOfProcess && f.sessionId);
const inRemote = async (expr: string) => (await A.call('browser_evaluate', { tabId, frameId: (await remoteFrame()).frameId, expression: expr })).value;

before(async () => {
  await h.start();
  A = await h.agent('iframes');
  ({ tabId } = await A.call('spaces_create', { name: 'iframes' }));
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html` });
});
after(async () => {
  await h.stop();
});

test('waits find selectors and text inside same-origin and cross-site iframes', async () => {
  await A.call('browser_wait', { tabId, selector: '#run' });
  await A.call('browser_wait', { tabId, selector: 'text=Run remote query', timeoutMs: 15_000 });
  await A.call('browser_wait', { tabId, text: 'Select up to 50 log groups' });
  await A.call('browser_wait', { tabId, text: 'Run remote query' });
  await A.call('browser_wait', { tabId, selector: 'text=Nope not here', state: 'hidden' });
  await assert.rejects(A.call('browser_wait', { tabId, selector: 'text=Nope not here', timeoutMs: 300 }), (e: Error) => code(e) === 'TIMEOUT');
  await assert.rejects(A.call('browser_wait', { tabId, selector: 'xpath=//[', timeoutMs: 300 }), (e: Error) => code(e) === 'BAD_REQUEST');
});

test('actions resolve selectors in iframes: the top document first, then same-origin, then cross-site', async () => {
  const r = await A.call('browser_click', { tabId, target: 'text=Run query', waitForText: 'row 1 for all' });
  assert.equal(r.appeared, 'row 1 for all');
  assert.equal(await inFeature('runs'), 1);
  // The top document wins when it has the match.
  await A.call('browser_click', { tabId, target: 'text=Top button' });
  // Cross-site iframe: clicked at the right place, and the result says where it matched.
  const x = await A.call('browser_click', { tabId, target: 'text=Run remote query' });
  assert.match(x.clicked, /in cross-site iframe http:\/\/localhost:8765\/iframe-app-inner\.html\?remote=…/);
  assert.equal(await inRemote('runs'), 1);
  // Several matches across frames are ambiguous, as in one document.
  await assert.rejects(A.call('browser_click', { tabId, target: 'td' }), (e: Error) => code(e) === 'ELEMENT_AMBIGUOUS');
  await assert.rejects(A.call('browser_click', { tabId, target: 'text=Nowhere at all' }), (e: Error) => code(e) === 'ELEMENT_NOT_FOUND');
});

test('browser_type clears and reports the focused field inside iframes, with small values', async () => {
  let r = await A.call('browser_type', { tabId, target: '#search', text: 'member-prd' });
  assert.equal(r.value, 'member-prd');
  // No target: focus is still in the iframe's input, and clear empties it first.
  r = await A.call('browser_type', { tabId, text: '/member-prd/ecs', clear: true });
  assert.equal(r.value, '/member-prd/ecs');
  assert.equal(await inFeature(`document.getElementById('search').value`), '/member-prd/ecs');
  // contenteditable in an iframe.
  r = await A.call('browser_type', { tabId, target: '#editor', text: 'fields @timestamp', clear: true });
  assert.equal(r.value, 'fields @timestamp');
  // Long values are cut; passwords report only their length.
  r = await A.call('browser_type', { tabId, target: '#search', text: 'x'.repeat(500), clear: true });
  assert.equal(r.value, 'x'.repeat(200) + '…(+300 chars)');
  r = await A.call('browser_type', { tabId, target: '#pw', text: 'hunter2' });
  assert.equal(r.value, '(password, 7 chars)');
  // Focus on something that is not a text field: no value (not the page's whole text).
  await A.call('browser_click', { tabId, target: '#top' });
  r = await A.call('browser_type', { tabId, text: 'q' });
  assert.equal(r.value, null);
  // A cross-site iframe's field.
  r = await A.call('browser_type', { tabId, target: 'text=Remote search', text: 'abc' });
  assert.equal(r.value, 'abc');
  r = await A.call('browser_type', { tabId, text: '/x', clear: true });
  assert.equal(r.value, '/x');
  assert.equal(await inRemote(`document.getElementById('search').value`), '/x');
});

test('snapshots include table rows inside iframes, in the viewport scope too', async () => {
  for (const scope of ['viewport', 'full_page']) {
    const s = await A.call('browser_snapshot', { tabId, scope });
    assert.match(s, /row 1 for/, `${scope}:\n${s}`);
    assert.match(s, /Run remote query/, `${scope}:\n${s}`);
  }
});

test('snapshots follow nested iframes, and their refs click in the right place', async () => {
  const s = await A.call('browser_snapshot', { tabId, scope: 'full_page' });
  const refs = [...s.matchAll(/iframe "Nested frame" @\d+\n\s+- button "Inner frame button" (@\d+)/g)].map((m) => m[1]);
  assert.equal(refs.length, 2, s); // one in the same-origin frame, one in the cross-site frame
  await A.call('browser_click', { tabId, target: refs[0] });
  assert.equal(await inFeature(`document.getElementById('nested').contentDocument.getElementById('innerOut').textContent`), 'inner: 1');
  await A.call('browser_click', { tabId, target: refs[1] });
  assert.equal(await inRemote(`document.getElementById('nested').contentDocument.getElementById('innerOut').textContent`), 'inner: 1');
  // Selectors reach nested same-origin frames too. The page's own frames come first: the
  // cross-site frame's copy is searched only when the page has none.
  await A.call('browser_click', { tabId, target: '#inner' });
  assert.equal(await inFeature(`document.getElementById('nested').contentDocument.getElementById('innerOut').textContent`), 'inner: 2');
  assert.equal(await inRemote(`document.getElementById('nested').contentDocument.getElementById('innerOut').textContent`), 'inner: 1');
});

test('browser_evaluate awaits a returned Promise (async IIFE)', async () => {
  const ev = (expression: string, extra: Record<string, unknown> = {}) => A.call('browser_evaluate', { tabId, expression, ...extra });
  assert.equal((await ev('(async () => { await new Promise((r) => setTimeout(r, 50)); return 1; })()')).value, 1);
  assert.deepEqual((await ev('(async () => ({ a: [1, 2] }))()')).value, { a: [1, 2] });
  assert.deepEqual((await ev('Promise.resolve({ b: 2 })')).value, { b: 2 });
  assert.equal((await ev('await new Promise((r) => setTimeout(r, 20)); 7')).value, 7);
  const rej = await ev('(async () => { throw new Error("nope") })()');
  assert.equal(rej.ok, false);
  assert.match(rej.exception, /nope/);
  assert.deepEqual((await ev('({ c: 3 })')).value, { c: 3 });
  assert.equal((await ev('NaN')).value, 'NaN');
  const cyc = await ev('(() => { const o = {}; o.o = o; return o; })()');
  assert.equal(cyc.ok, true);
  assert.equal(cyc.value, 'Object');
  assert.match(String((await ev('(async () => 1)()', { awaitPromise: false })).value), /Promise/);
  // browser_run's evaluate(fn) with an async function.
  const run = await A.call('browser_run', { tabId, script: 'return await evaluate(async () => { await new Promise((r) => setTimeout(r, 20)); return 5; });' });
  assert.equal(run.result, 5);
});

test('action results repeat the url only when it changed, and cut long ones', async () => {
  let r = await A.call('browser_click', { tabId, target: '#top' });
  assert.equal(r.url, undefined, JSON.stringify(r));
  assert.equal(r.title, undefined);
  await A.call('browser_evaluate', { tabId, expression: `history.pushState({}, '', '?q=' + 'y'.repeat(600))` });
  r = await A.call('browser_click', { tabId, target: '#top' });
  assert.match(r.url, /^http:\/\/127\.0\.0\.1:8765\/iframe-app\.html\?q=y+…\(\+\d+ chars\)$/);
  assert.ok(r.url.length < 330);
  assert.equal(r.title, 'Iframe App');
  r = await A.call('browser_press', { tabId, keys: 'Shift' });
  assert.equal(r.url, undefined);
});

test('screenshots are in CSS pixels by default on a HiDPI page; hiDpi gives device pixels', async () => {
  await A.call('browser_cdp', { tabId, method: 'Emulation.setDeviceMetricsOverride', params: { width: 800, height: 600, deviceScaleFactor: 2, mobile: false } });
  try {
    const shot = async (extra: Record<string, unknown> = {}) => {
      const r = await A.callRaw('browser_screenshot', { tabId, ...extra });
      return { size: pngSize(r.content.find((c) => c.type === 'image').data), meta: JSON.parse(r.content.find((c) => c.type === 'text').text) };
    };
    const css = await shot();
    assert.equal(css.size.width, css.meta.viewport.width);
    assert.equal(css.size.height, css.meta.viewport.height);
    assert.equal(css.meta.scale, 1);
    const dev = await shot({ hiDpi: true });
    assert.equal(dev.meta.scale, 2);
    assert.ok(Math.abs(dev.size.width - 2 * dev.meta.viewport.width) <= 40, `${dev.size.width} vs ${dev.meta.viewport.width}`);
    const el = await shot({ target: '#top' });
    const box = await A.call('browser_evaluate', { tabId, expression: `(() => { const r = document.getElementById('top').getBoundingClientRect(); return [r.width, r.height]; })()` });
    assert.ok(Math.abs(el.size.width - box.value[0]) <= 2, `${el.size.width} vs ${box.value[0]}`);
  } finally {
    await A.call('browser_cdp', { tabId, method: 'Emulation.clearDeviceMetricsOverride', params: {} });
  }
});
