// Apps whose feature UI lives in iframes (cloud consoles): selectors, typing, waits and
// snapshots reach into same-origin and cross-site iframes; results stay small.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Harness, SITE, pngSize, type Agent } from './harness.ts';
import { startTestServer } from '../../test-site/server.mjs';

const h = new Harness();
let A: Agent;
let tabId: number;

const code = (e: unknown) => (e as { code?: string }).code;
const inFeature = async (expr: string) => (await A.call('browser_evaluate', { tabId, expression: `document.getElementById('feature').contentWindow.${expr}` })).value;
const remoteFrame = async () => (await A.call('browser_frames', { tabId })).frames.find((f: { outOfProcess: boolean; sessionId?: string }) => f.outOfProcess && f.sessionId);
const inRemote = async (expr: string) => (await A.call('browser_evaluate', { tabId, frameId: (await remoteFrame()).frameId, expression: expr })).value;

// A second origin on the same site (127.0.0.1, another port): its frames share the page's
// process, but the page's script cannot reach into them.
const ALT_PORT = 8767;
let alt: Server;

before(async () => {
  alt = (await startTestServer(ALT_PORT)) as Server;
  await h.start();
  A = await h.agent('iframes');
  ({ tabId } = await A.call('spaces_create', { name: 'iframes' }));
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html` });
});
after(async () => {
  await h.stop();
  alt?.close();
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

test('frames of another origin on the same site, and a scaled cross-site frame', async () => {
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html?alt=${ALT_PORT}&scaled=1` });
  await A.call('browser_wait', { tabId, selector: 'text=Run alt query' });
  await A.call('browser_wait', { tabId, text: 'Run alt query' });
  const altFrame = (await A.call('browser_frames', { tabId })).frames.find((f: { url: string }) => f.url.includes(`:${ALT_PORT}/`));
  const inAlt = async (expr: string) => (await A.call('browser_evaluate', { tabId, frameId: altFrame.frameId, expression: expr })).value;
  await A.call('browser_click', { tabId, target: 'text=Run alt query' });
  assert.equal(await inAlt('runs'), 1);
  let r = await A.call('browser_type', { tabId, target: 'text=Alt search', text: 'abc' });
  assert.equal(r.value, 'abc');
  r = await A.call('browser_type', { tabId, text: 'XYZ', clear: true });
  assert.equal(r.value, 'XYZ');
  assert.equal(await inAlt(`document.getElementById('search').value`), 'XYZ');
  // A visible element is not "hidden", even while the page is too busy to answer.
  await assert.rejects(A.call('browser_wait', { tabId, selector: 'text=Run alt query', state: 'hidden', timeoutMs: 300 }), (e: Error) => code(e) === 'TIMEOUT');
  await A.call('browser_evaluate', { tabId, expression: 'setTimeout(() => { const end = Date.now() + 1200; while (Date.now() < end) {} }, 0); 1' });
  await assert.rejects(A.call('browser_wait', { tabId, selector: '#top', state: 'hidden', timeoutMs: 400 }), (e: Error) => code(e) === 'TIMEOUT');
  // The cross-site frame is drawn at half size: clicks and element screenshots map through that.
  await A.call('browser_wait', { tabId, selector: 'text=Run remote query', timeoutMs: 15_000 });
  const before = await inRemote('runs');
  await A.call('browser_click', { tabId, target: 'text=Run remote query' });
  assert.equal(await inRemote('runs'), before + 1);
  const shot = await A.callRaw('browser_screenshot', { tabId, target: 'text=Run remote query' });
  const clip = JSON.parse(shot.content.find((c) => c.type === 'text').text).clip;
  const box = (await A.call('browser_evaluate', { tabId, expression: `(() => { const r = document.getElementById('remote').getBoundingClientRect(); return [r.x, r.y, r.right, r.bottom]; })()` })).value;
  assert.ok(clip.x >= box[0] && clip.y >= box[1] && clip.x + clip.width <= box[2] + 1 && clip.y + clip.height <= box[3] + 1, `${JSON.stringify(clip)} in ${box}`);
});

test('a busy frame cannot prove absence; once it answers, waits go on', async () => {
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html` });
  await A.call('browser_wait', { tabId, selector: 'text=Run remote query', timeoutMs: 15_000 });
  const f = await remoteFrame();
  await A.call('browser_evaluate', { tabId, frameId: f.frameId, expression: 'setTimeout(() => { const end = Date.now() + 1500; while (Date.now() < end) {} }, 0); 1' });
  // The busy frame does not answer in time: "hidden" is not proven from its silence.
  await assert.rejects(A.call('browser_wait', { tabId, selector: 'text=Nope not here', state: 'hidden', timeoutMs: 400 }), (e: Error) => code(e) === 'TIMEOUT');
  // Calls to a tab run in order, so the next ones wait for the frame, then succeed.
  await A.call('browser_wait', { tabId, selector: '#top', timeoutMs: 5000 });
  await A.call('browser_wait', { tabId, selector: 'text=Nope not here', state: 'hidden', timeoutMs: 5000 });
});

test('a frame of another origin inside a cross-site frame is searched, typed into and waited on', async (t) => {
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html?remotealt=${ALT_PORT}` });
  await A.call('browser_wait', { tabId, selector: 'text=Run alt query', state: 'attached', timeoutMs: 15_000 });
  await A.call('browser_wait', { tabId, text: 'Run alt query' });
  // Chrome sizes a frame nested in a cross-site frame only when the window paints; the test
  // browser's window may be covered on screen and not painting. Then its elements are found but
  // have no size, and clicking or typing there is checked only when it does paint.
  const shown = await A.call('browser_wait', { tabId, selector: 'text=Run alt query', timeoutMs: 3000 }).then(() => true, () => false);
  if (!shown) {
    t.diagnostic('the nested frame has no size (window not painting); click and type not checked');
    return;
  }
  await A.call('browser_click', { tabId, target: 'text=Run alt query' });
  await A.call('browser_wait', { tabId, text: 'row 1 for all' });
  let r = await A.call('browser_type', { tabId, target: 'text=Alt search', text: 'abc' });
  assert.equal(r.value, 'abc');
  r = await A.call('browser_type', { tabId, text: 'XYZ', clear: true });
  assert.equal(r.value, 'XYZ');
});

test('a frame the page cannot reach and its nested frame are each searched once', async () => {
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html?alt=${ALT_PORT}&only=alt` });
  await A.call('browser_wait', { tabId, selector: '#inner' });
  await A.call('browser_click', { tabId, target: '#inner' });
  await A.call('browser_wait', { tabId, text: 'inner: 1' });
});

test('element screenshots stay inside the frame, and pinch zoom still gives CSS pixels', async () => {
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html?wide=1` });
  await A.call('browser_wait', { tabId, selector: '#wide' });
  const shot = await A.callRaw('browser_screenshot', { tabId, target: '#wide' });
  const clip = JSON.parse(shot.content.find((c) => c.type === 'text').text).clip;
  const box = (await A.call('browser_evaluate', { tabId, expression: `(() => { const r = document.getElementById('feature').getBoundingClientRect(); return [r.x, r.y, r.right, r.bottom]; })()` })).value;
  assert.ok(clip.x >= box[0] - 1 && clip.y >= box[1] - 1 && clip.x + clip.width <= box[2] + 1 && clip.y + clip.height <= box[3] + 1, `${JSON.stringify(clip)} in ${box}`);
  await A.call('browser_cdp', { tabId, method: 'Emulation.setPageScaleFactor', params: { pageScaleFactor: 2 } });
  try {
    const r = await A.callRaw('browser_screenshot', { tabId });
    const meta = JSON.parse(r.content.find((c) => c.type === 'text').text);
    const size = pngSize(r.content.find((c) => c.type === 'image').data);
    assert.equal(meta.scale, 1);
    assert.ok(Math.abs(size.width - meta.viewport.width) <= 2 && Math.abs(size.height - meta.viewport.height) <= 2, `${JSON.stringify(size)} vs ${JSON.stringify(meta.viewport)}`);
  } finally {
    await A.call('browser_cdp', { tabId, method: 'Emulation.setPageScaleFactor', params: { pageScaleFactor: 1 } });
  }
});

test('hidden or covered iframes are not clicked through, and nested-frame screenshots stay inside', async () => {
  await A.call('browser_navigate', { tabId, url: `${SITE}/iframe-app.html?traps=1` });
  await A.call('browser_wait', { tabId, selector: '#big', state: 'attached' });
  // An element in a visibility:hidden iframe is hidden, and clicking it would hit the page.
  await A.call('browser_wait', { tabId, selector: '#ghost', state: 'hidden' });
  await assert.rejects(A.call('browser_wait', { tabId, selector: '#ghost', timeoutMs: 300 }), (e: Error) => code(e) === 'TIMEOUT');
  await assert.rejects(A.call('browser_click', { tabId, target: '#ghost' }), (e: Error) => code(e) === 'ELEMENT_NOT_ACTIONABLE' && /iframe it is in is hidden/.test(e.message));
  assert.equal((await A.call('browser_evaluate', { tabId, expression: 'underClicks' })).value, 0);
  // Page elements drawn over a same-origin and a cross-site frame.
  await assert.rejects(A.call('browser_click', { tabId, target: 'text=Run query' }), (e: Error) => code(e) === 'ELEMENT_NOT_ACTIONABLE' && /covered by div\.cover/.test(e.message));
  await A.call('browser_wait', { tabId, selector: 'text=Run remote query', timeoutMs: 15_000 });
  await assert.rejects(A.call('browser_click', { tabId, target: 'text=Run remote query' }), (e: Error) => code(e) === 'ELEMENT_NOT_ACTIONABLE' && /covered by div/.test(e.message));
  // A large element in a frame nested in a small frame: cut to the outer frame.
  const shot = await A.callRaw('browser_screenshot', { tabId, target: '#big' });
  const clip = JSON.parse(shot.content.find((c) => c.type === 'text').text).clip;
  const box = (await A.call('browser_evaluate', { tabId, expression: `(() => { const r = document.getElementById('outer').getBoundingClientRect(); return [r.x + scrollX, r.y + scrollY, r.right + scrollX, r.bottom + scrollY]; })()` })).value;
  assert.ok(clip.x >= box[0] - 1 && clip.y >= box[1] - 1 && clip.x + clip.width <= box[2] + 1 && clip.y + clip.height <= box[3] + 1, `${JSON.stringify(clip)} in ${box}`);
  // hiDpi with a clip under pinch zoom: scale matches the image.
  await A.call('browser_cdp', { tabId, method: 'Emulation.setPageScaleFactor', params: { pageScaleFactor: 2 } });
  try {
    const r = await A.callRaw('browser_screenshot', { tabId, fullPage: true, hiDpi: true });
    const meta = JSON.parse(r.content.find((c) => c.type === 'text').text);
    const size = pngSize(r.content.find((c) => c.type === 'image').data);
    assert.ok(Math.abs(size.width - meta.scale * meta.clip.width) <= 2, `${size.width} vs ${meta.scale} * ${meta.clip.width}`);
  } finally {
    await A.call('browser_cdp', { tabId, method: 'Emulation.setPageScaleFactor', params: { pageScaleFactor: 1 } });
  }
});
