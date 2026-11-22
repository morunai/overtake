// End-to-end acceptance in real Google Chrome (throwaway profile).
// Each test maps to a step of the acceptance scenario in the task brief.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Harness, SITE, sleep, pngSize, type Agent } from './harness.ts';

const SHOTS = join(import.meta.dirname, '..', '..', 'docs', 'screenshots');
const h = new Harness();
let A: Agent;
let B: Agent;
let space: { spaceId: number; tabId: number };
let human: string; // harness session on the agent's page
let ext: string; // harness session on the overview page

const code = (e: unknown) => (e as { code?: string }).code;
const count = () => h.eval<string>(human, `document.getElementById('count').dataset.count`).then(Number);

before(async () => {
  await h.start();
});
after(async () => {
  await h.stop();
});

test('1-2. extension loads and an agent connects over MCP', async () => {
  A = await h.agent('agent-alpha');
  const tools = await A.client.listTools();
  const names = tools.tools.map((t) => t.name);
  for (const n of ['spaces_create', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_cdp', 'space_handoff', 'space_wait_for_control']) assert.ok(names.includes(n), n);
  const list = await A.call('spaces_list');
  assert.equal(list.name, 'agent-alpha');
});

test('3-4. create an agent Space and navigate to the test page', async () => {
  const s = await A.call('spaces_create', { name: 'acceptance A' });
  assert.equal(s.control, 'AGENT_CONTROL');
  assert.equal(s.createdBy, 'agent');
  space = { spaceId: s.spaceId, tabId: s.tabId };
  const nav = await A.call('browser_navigate', { tabId: space.tabId, url: `${SITE}/` });
  assert.equal(nav.title, 'Agent Test Page');
  assert.equal(nav.loaded, true);
  human = await h.humanSession(`${SITE}/`);
  ext = await h.extensionPage('overview.html');
});

test('5. viewport screenshot has the viewport size and hides the overlay', async () => {
  const r = await A.callRaw('browser_screenshot', { tabId: space.tabId });
  assert.ok(!r.isError);
  const img = r.content.find((c) => c.type === 'image');
  const meta = JSON.parse(r.content.find((c) => c.type === 'text').text);
  const size = pngSize(img.data);
  // clientWidth excludes the vertical scrollbar, which the capture includes.
  assert.ok(size.width - meta.viewport.width >= 0 && size.width - meta.viewport.width <= 20, `width ${size.width} vs ${meta.viewport.width}`);
  assert.equal(size.height, meta.viewport.height);
});

test('6. full-page screenshot covers the whole document', async () => {
  const file = join(SHOTS, 'agent-fullpage.png');
  const r = await A.callRaw('browser_screenshot', { tabId: space.tabId, fullPage: true, path: file });
  // With a path, the image is saved rather than returned inline (keeps agent context small).
  assert.equal(r.content.find((c) => c.type === 'image'), undefined);
  const meta = JSON.parse(r.content.find((c) => c.type === 'text').text);
  assert.equal(meta.savedTo, file);
  const size = pngSize(readFileSync(file).toString('base64'));
  assert.ok(size.height > meta.viewport.height, 'taller than the viewport');
  assert.equal(size.height, Math.ceil(meta.contentSize.height));
  assert.equal(size.width, Math.ceil(meta.contentSize.width));
});

test('7. DOM / accessibility snapshot with refs, including iframes', async () => {
  const snap: string = await A.call('browser_snapshot', { tabId: space.tabId, scope: 'full_page' });
  assert.match(snap, /button "Click me" @\d+/);
  assert.match(snap, /iframe "child frame" @\d+\n\s+- button "Inner frame button" @\d+/);
  assert.match(snap, /iframe "cross-site frame" @\d+\n\s+- button "Inner frame button" @\d+/);
  assert.doesNotMatch(snap, /Take over|Agent control/, 'the overlay is not part of the agent view');
  const vp: string = await A.call('browser_snapshot', { tabId: space.tabId });
  assert.doesNotMatch(vp, /Bottom of page/, 'viewport scope omits content below the fold');
  assert.match(vp, /outside the viewport/);
});

test('8. JavaScript evaluation (top-level await, exceptions)', async () => {
  const r = await A.call('browser_evaluate', { tabId: space.tabId, expression: `await new Promise(r => setTimeout(r, 50)); ({ title: document.title, n: 6 * 7 })` });
  assert.deepEqual(r.value, { title: 'Agent Test Page', n: 42 });
  const ex = await A.call('browser_evaluate', { tabId: space.tabId, expression: `null.x` });
  assert.equal(ex.ok, false);
  assert.match(ex.exception, /TypeError/);
});

test('9-10. genuine CDP click; network request and response inspected', async () => {
  const snap: string = await A.call('browser_snapshot', { tabId: space.tabId });
  const ref = /button "Fetch data" (@\d+)/.exec(snap)![1];
  const click = await A.call('browser_click', { tabId: space.tabId, target: ref, label: 'fetch the data' });
  assert.ok(click.at.x > 0);
  await A.call('browser_wait', { tabId: space.tabId, text: 'hello from api' });
  const list = await A.call('browser_network', { tabId: space.tabId, urlIncludes: '/api/data' });
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].status, 200);
  const detail = await A.call('browser_network', { tabId: space.tabId, action: 'get', requestId: list.requests[0].requestId });
  assert.equal(detail.responseHeaders['x-test-header'], 'overtake');
  assert.match(detail.responseBody, /hello from api/);
  // The click was a trusted CDP event.
  const btn = /button "Click me" (@\d+)/.exec(snap)![1];
  await A.call('browser_click', { tabId: space.tabId, target: btn, label: 'click test button' });
  assert.equal(await count(), 1);
  const log = await h.eval<string>(human, `document.getElementById('log').textContent`);
  assert.match(log, /click isTrusted=true/);
});

test('network results mask credentials (headers, cookies, tokens, passwords)', async () => {
  await A.call('browser_evaluate', { tabId: space.tabId, expression: `fetch('/api/session?token=test-query-secret&page=1', { method: 'POST', headers: { Authorization: 'Bearer test-bearer-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'tester', password: 'test-password-secret' }) }).then((r) => r.json())` });
  const list = await A.call('browser_network', { tabId: space.tabId, urlIncludes: '/api/session' });
  assert.equal(list.requests.length, 1);
  assert.ok(!list.requests[0].url.includes('test-query-secret'), 'query token masked in list');
  let detail: any;
  for (let i = 0; i < 30 && !detail?.responseBody; i++) {
    if (i) await sleep(100); // the body is captured once loadingFinished arrives
    detail = await A.call('browser_network', { tabId: space.tabId, action: 'get', requestId: list.requests[0].requestId });
  }
  const raw = JSON.stringify(detail);
  for (const secret of ['test-query-secret', 'test-bearer-secret', 'test-password-secret', 'test-session-secret', 'test-access-secret']) {
    assert.ok(!raw.includes(secret), `${secret} must not reach the agent`);
  }
  assert.match(detail.requestHeaders.Authorization, /^Bearer \[redacted \d+ chars\]$/);
  assert.match(detail.url, /page=1/, 'non-sensitive parameters stay readable');
  assert.equal(JSON.parse(detail.postData).user, 'tester');
  assert.equal(JSON.parse(detail.responseBody).user, 'tester');
  assert.equal(detail.redacted, true);
  // The raw paths mask the same data: CDP results and recorded Network events.
  const secrets = ['test-query-secret', 'test-bearer-secret', 'test-password-secret', 'test-session-secret', 'test-access-secret'];
  const body = await A.call('browser_cdp', { tabId: space.tabId, method: 'Network.getResponseBody', params: { requestId: list.requests[0].requestId } });
  assert.equal(JSON.parse(body.body).user, 'tester');
  const post = await A.call('browser_cdp', { tabId: space.tabId, method: 'Network.getRequestPostData', params: { requestId: list.requests[0].requestId } });
  assert.equal(JSON.parse(post.postData).user, 'tester');
  const jar = await A.call('browser_cdp', { tabId: space.tabId, method: 'Network.getCookies', params: { urls: [SITE] } });
  assert.ok(jar.cookies.some((c: { name: string }) => c.name === 'sid'), 'cookie names stay visible');
  const events = await A.call('browser_events', { tabId: space.tabId, methodPrefix: 'Network.', limit: 500 });
  assert.ok(events.events.some((e: { method: string }) => e.method === 'Network.requestWillBeSent'));
  for (const [what, v] of [['getResponseBody', body], ['getRequestPostData', post], ['getCookies', jar], ['events', events]] as const) {
    const json = JSON.stringify(v);
    for (const secret of secrets) assert.ok(!json.includes(secret), `${secret} leaked through ${what}`);
  }
});

test('11. blue shield and animated agent cursor are visible; human input is blocked', async () => {
  const wrap = await h.overlayClasses(human, 'wrap');
  assert.match(wrap, /\bon\b/, 'glowing shield is on');
  const cursor = await h.overlayClasses(human, 'cursor');
  assert.match(cursor, /\bshow\b/, 'agent cursor shown');
  const style = await h.overlayStyle(human, 'cursor');
  assert.match(style, /translate\(/, 'cursor positioned from real click coordinates');
  await h.screenshot(human, join(SHOTS, 'agent-control.png'));
  // A human click on the page is swallowed by the shield.
  const before = await count();
  const box = await h.eval<{ x: number; y: number }>(human, `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await h.humanClick(human, box.x, box.y);
  await sleep(150);
  assert.equal(await count(), before, 'human click blocked during agent control');
  // Human typing is blocked too.
  await h.browser.send('Input.insertText', { text: 'zzz' }, human);
  assert.equal(await h.eval(human, `document.getElementById('name').value`), '');
});

test('12-13. human takes over from the dock; agent actions cannot continue', async () => {
  const takeover = await h.overlayButton(human, 'Take over');
  assert.ok(takeover, 'dock Take over button is visible');
  await h.humanClick(human, takeover!.x, takeover!.y);
  await sleep(300);
  const list = await A.call('spaces_list');
  const s = list.spaces.find((x: { spaceId: number }) => x.spaceId === space.spaceId);
  assert.equal(s.control, 'USER_CONTROL');
  assert.equal(s.userReason, 'takeover');
  const before = await count();
  await assert.rejects(A.call('browser_click', { tabId: space.tabId, target: '#btn' }), (e) => code(e) === 'USER_IN_CONTROL');
  await assert.rejects(A.call('browser_evaluate', { tabId: space.tabId, expression: '1' }), (e) => code(e) === 'USER_IN_CONTROL');
  await assert.rejects(A.call('space_resume', { spaceId: space.spaceId }), (e) => code(e) === 'USER_IN_CONTROL');
  await assert.rejects(A.call('space_claim', { spaceId: space.spaceId }), (e) => code(e) === 'USER_IN_CONTROL');
  assert.equal(await count(), before, 'no agent click landed');
  // Human input works again.
  const box = await h.eval<{ x: number; y: number }>(human, `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await h.humanClick(human, box.x, box.y);
  await sleep(150);
  assert.equal(await count(), before + 1, 'human click works after take over');
  assert.doesNotMatch(await h.overlayClasses(human, 'wrap'), /\bon\b/, 'shield removed');
  await h.screenshot(human, join(SHOTS, 'user-control.png'));
});

test('14-15. human gives control back from the dock; the agent resumes', async () => {
  const waiter = A.call('space_wait_for_control', { spaceId: space.spaceId, timeoutMs: 10_000 });
  await sleep(200);
  const back = await h.overlayButton(human, 'Give back');
  assert.ok(back);
  await h.humanClick(human, back!.x, back!.y);
  const w = await waiter;
  assert.equal(w.inControl, true, 'space_wait_for_control resolved on give back');
  const before = await count();
  await A.call('browser_click', { tabId: space.tabId, target: '#btn', label: 'resume clicking' });
  assert.equal(await count(), before + 1);
});

test('a take-over during a wait is reported at once, not masked as a timeout', async () => {
  const pending = A.call('browser_wait', { tabId: space.tabId, function: 'false', timeoutMs: 20_000 }).then(() => 'resolved', (e) => code(e));
  await sleep(500);
  const t0 = Date.now();
  await h.humanAction(ext, 'takeover', space.spaceId);
  assert.equal(await pending, 'USER_IN_CONTROL');
  assert.ok(Date.now() - t0 < 2000, `reported after ${Date.now() - t0} ms`);
  const delayed = A.call('browser_wait', { tabId: space.tabId, delayMs: 300 }).then(() => 'resolved', (e) => code(e));
  assert.equal(await delayed, 'USER_IN_CONTROL', 'delayMs re-checks control');
  await h.humanAction(ext, 'giveback', space.spaceId);
  assert.deepEqual(await A.call('browser_wait', { tabId: space.tabId, delayMs: 300 }), { waited: 300 });
});

test('pause queues agent commands until resume; stop cancels and releases', async () => {
  await h.humanAction(ext, 'pause', space.spaceId);
  const before = await count();
  const pending = A.call('browser_click', { tabId: space.tabId, target: '#btn' });
  await sleep(600);
  assert.equal(await count(), before, 'nothing ran while paused');
  await h.screenshot(human, join(SHOTS, 'agent-paused.png'));
  await h.humanAction(ext, 'resume', space.spaceId);
  await pending;
  assert.equal(await count(), before + 1, 'queued click ran after resume');

  await h.humanAction(ext, 'stop', space.spaceId);
  await assert.rejects(A.call('browser_evaluate', { tabId: space.tabId, expression: '1' }), (e) => code(e) === 'STOPPED');
  assert.doesNotMatch(await h.overlayClasses(human, 'wrap'), /\bon\b/, 'stop never leaves the page locked');
  const claimed = await A.call('space_claim', { spaceId: space.spaceId });
  assert.equal(claimed.control, 'AGENT_CONTROL');
});

test('agent hand-off shows "Need your action" and the owner can resume', async () => {
  const r = await A.call('space_handoff', { spaceId: space.spaceId, reason: 'Please sign in to continue' });
  assert.equal(r.userReason, 'handoff');
  await sleep(200);
  await h.screenshot(human, join(SHOTS, 'handoff.png'));
  await assert.rejects(A.call('browser_evaluate', { tabId: space.tabId, expression: '1' }), (e) => code(e) === 'USER_IN_CONTROL');
  const resumed = await A.call('space_resume', { spaceId: space.spaceId });
  assert.equal(resumed.control, 'AGENT_CONTROL');
});

test('16. a second agent works in its own Space independently and concurrently', async () => {
  B = await h.agent('agent-beta');
  const sb = await B.call('spaces_create', { name: 'acceptance B', url: `${SITE}/?space=b` });
  await B.call('browser_wait', { tabId: sb.tabId, load: true });
  // B cannot touch A's tab, and vice versa.
  await assert.rejects(B.call('browser_click', { tabId: space.tabId, target: '#btn' }), (e) => code(e) === 'NOT_OWNER');
  await assert.rejects(A.call('browser_evaluate', { tabId: sb.tabId, expression: '1' }), (e) => code(e) === 'NOT_OWNER');
  const humanB = await h.humanSession('?space=b');
  const a0 = await count();
  const t0 = Date.now();
  await Promise.all([
    (async () => { for (let i = 0; i < 4; i++) await A.call('browser_click', { tabId: space.tabId, target: '#btn' }); })(),
    (async () => { for (let i = 0; i < 4; i++) await B.call('browser_click', { tabId: sb.tabId, target: '#btn' }); })(),
  ]);
  const elapsed = Date.now() - t0;
  assert.equal(await count(), a0 + 4);
  assert.equal(Number(await h.eval(humanB, `document.getElementById('count').dataset.count`)), 4);
  await h.screenshot(humanB, join(SHOTS, 'second-space.png'));
  // Overview with both spaces.
  await sleep(3000); // previews refresh every 2.5 s
  await h.screenshot(ext, join(SHOTS, 'spaces-overview.png'));
  console.log(`  concurrent 4+4 clicks in ${elapsed} ms`);
});

test('agent disconnect returns control to the user and removes the shield', async () => {
  const sb = (await A.call('spaces_list')).spaces.find((s: { name: string }) => s.name === 'acceptance B');
  const humanB = await h.humanSession('?space=b');
  assert.match(await h.overlayClasses(humanB, 'wrap'), /\bon\b/);
  await B.close();
  await sleep(600);
  const after = (await A.call('spaces_list')).spaces.find((s: { spaceId: number }) => s.spaceId === sb.spaceId);
  assert.equal(after.control, 'USER_CONTROL');
  assert.equal(after.userReason, 'agent-disconnected');
  assert.doesNotMatch(await h.overlayClasses(humanB, 'wrap'), /\bon\b/);
  // Another agent may claim an orphaned space.
  const claimed = await A.call('space_claim', { spaceId: sb.spaceId });
  assert.equal(claimed.owner, (await A.call('spaces_list')).you);
  await A.call('spaces_close', { spaceId: sb.spaceId });
});

test('navigation and frame handling: OOPIF click via ref, frame-scoped evaluate', async () => {
  const frames = await A.call('browser_frames', { tabId: space.tabId });
  const oopif = frames.frames.find((f: { url: string; outOfProcess: boolean }) => f.outOfProcess);
  assert.ok(oopif, 'cross-site iframe is out-of-process');
  const snap: string = await A.call('browser_snapshot', { tabId: space.tabId, scope: 'full_page' });
  const xref = /iframe "cross-site frame" @\d+\n\s+- button "Inner frame button" (@\d+)/.exec(snap)![1];
  await A.call('browser_click', { tabId: space.tabId, target: xref, label: 'click inside OOPIF' });
  const v = await A.call('browser_evaluate', { tabId: space.tabId, frameId: oopif.frameId, expression: `document.getElementById('innerOut').textContent` });
  assert.equal(v.value, 'inner: 1');
  const local = frames.frames.find((f: { url: string; outOfProcess: boolean; depth: number }) => !f.outOfProcess && f.depth === 1);
  const sref = /iframe "child frame" @\d+\n\s+- button "Inner frame button" (@\d+)/.exec(snap)![1];
  await A.call('browser_click', { tabId: space.tabId, target: sref });
  const v2 = await A.call('browser_evaluate', { tabId: space.tabId, frameId: local.frameId, expression: `document.getElementById('innerOut').textContent` });
  assert.equal(v2.value, 'inner: 1');
  // Refs go stale after navigation.
  await A.call('browser_navigate', { tabId: space.tabId, url: `${SITE}/?nav=2` });
  await assert.rejects(A.call('browser_click', { tabId: space.tabId, target: xref }), (e) => code(e) === 'ELEMENT_NOT_FOUND');
  human = await h.humanSession('?nav=2');
  assert.match(await h.overlayClasses(human, 'wrap'), /\bon\b/, 'shield is re-applied after navigation');
});

test('typing, keys, scroll and drag use real input', async () => {
  const t = await A.call('browser_type', { tabId: space.tabId, target: '#name', text: 'hello agent', clear: true });
  assert.equal(t.value, 'hello agent');
  await A.call('browser_press', { tabId: space.tabId, keys: 'ControlOrMeta+a' });
  await A.call('browser_type', { tabId: space.tabId, text: 'replaced', slowly: true });
  assert.equal(await h.eval(human, `document.getElementById('name').value`), 'replaced');
  const sc = await A.call('browser_scroll', { tabId: space.tabId, dy: 900 });
  assert.ok(sc.scroll.y > 300, `scrolled to ${sc.scroll.y}`);
  const d = await A.call('browser_drag', { tabId: space.tabId, from: '200,300', to: '400,320' });
  assert.equal(d.dragged.to.x, 400);
});

test('console, exceptions, interception, emulation, tracing, debugging', async () => {
  await A.call('browser_navigate', { tabId: space.tabId, url: `${SITE}/?nav=3` });
  await A.call('browser_click', { tabId: space.tabId, target: '#boom' });
  await sleep(200);
  const con = await A.call('browser_console', { tabId: space.tabId, level: 'exception' });
  assert.ok(con.entries.some((e: { text: string }) => /boom from test page/.test(e.text)));

  await A.call('browser_intercept', { tabId: space.tabId, action: 'add', urlPattern: '*/api/data*', body: JSON.stringify({ message: 'mocked by agent' }) });
  await A.call('browser_click', { tabId: space.tabId, target: '#fetch' });
  await A.call('browser_wait', { tabId: space.tabId, text: 'mocked by agent' });
  await A.call('browser_intercept', { tabId: space.tabId, action: 'clear' });

  const em = await A.call('browser_emulate', { tabId: space.tabId, device: 'iPhone 15' });
  assert.equal(em.applied.metrics.width, 393);
  const w = await A.call('browser_evaluate', { tabId: space.tabId, expression: 'innerWidth' });
  assert.equal(w.value, 393);
  await A.call('browser_emulate', { tabId: space.tabId, reset: true });

  await A.call('browser_trace', { tabId: space.tabId, action: 'start' });
  await A.call('browser_click', { tabId: space.tabId, target: '#slow' });
  const tr = await A.call('browser_trace', { tabId: space.tabId, action: 'stop' });
  assert.ok(tr.eventCount > 50, `trace events: ${tr.eventCount}`);

  await A.call('browser_debug', { tabId: space.tabId, action: 'enable' });
  const bp = await A.call('browser_debug', { tabId: space.tabId, action: 'set_breakpoint', urlRegex: '127\\.0\\.0\\.1:8765/\\?nav=3', line: 35 });
  assert.ok(bp.breakpointId);
  // Clicking calls slowWork(); the breakpoint pauses the page while the click receipt waits.
  const clicking = A.call('browser_click', { tabId: space.tabId, target: '#slow' }).catch((e) => e);
  let st: { paused: boolean; callFrames?: { function: string }[]; locals?: Record<string, unknown> } = { paused: false };
  for (let i = 0; i < 30 && !st.paused; i++) {
    await sleep(100);
    st = await A.call('browser_debug', { tabId: space.tabId, action: 'state' });
  }
  assert.equal(st.paused, true, 'breakpoint hit');
  assert.equal(st.callFrames![0].function, 'slowWork');
  assert.ok('n' in st.locals!);
  const ev = await A.call('browser_debug', { tabId: space.tabId, action: 'evaluate', expression: 'n * 2' });
  assert.equal(ev.value, 2000);
  await A.call('browser_debug', { tabId: space.tabId, action: 'resume' });
  await clicking;
  await A.call('browser_debug', { tabId: space.tabId, action: 'disable' });
});

test('raw CDP is validated: denied methods and malformed names are refused', async () => {
  const r = await A.call('browser_cdp', { tabId: space.tabId, method: 'DOM.getDocument', params: { depth: 0 } });
  assert.ok(r.root);
  await assert.rejects(A.call('browser_cdp', { tabId: space.tabId, method: 'Network.getAllCookies' }), (e) => code(e) === 'CDP_METHOD_DENIED');
  await assert.rejects(A.call('browser_cdp', { tabId: space.tabId, method: 'Input.setIgnoreInputEvents', params: { ignore: true } }), (e) => code(e) === 'CDP_METHOD_DENIED');
  // Raw Input.* still goes through the gate and lands.
  const before = await count();
  const box = await h.eval<{ x: number; y: number }>(human, `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await A.call('browser_cdp', { tabId: space.tabId, method: 'Input.dispatchMouseEvent', params: { type, x: box.x, y: box.y, button: 'left', clickCount: 1 } });
  assert.equal(await count(), before + 1);
});

test('CDP attachment failure is reported honestly (protected page)', async () => {
  const t = await A.call('browser_tabs', { action: 'new', spaceId: space.spaceId, url: 'chrome://version/' });
  await sleep(300);
  await assert.rejects(A.call('browser_snapshot', { tabId: t.tabId }), (e) => code(e) === 'PROTECTED_PAGE');
  await A.call('browser_tabs', { action: 'close', tabId: t.tabId });
});

test('tab closed during execution fails fast instead of hanging', async () => {
  const t = await A.call('browser_tabs', { action: 'new', spaceId: space.spaceId, url: `${SITE}/?closing=1` });
  await A.call('browser_wait', { tabId: t.tabId, load: true });
  const long = A.call('browser_evaluate', { tabId: t.tabId, expression: 'await new Promise(r => setTimeout(r, 5000)); 1' }).then(() => 'resolved', (e) => code(e));
  await sleep(400);
  const { targetInfos } = await h.browser.send<{ targetInfos: { targetId: string; url: string }[] }>('Target.getTargets');
  await h.browser.send('Target.closeTarget', { targetId: targetInfos.find((x) => x.url.includes('closing=1'))!.targetId });
  const t0 = Date.now();
  const outcome = await long;
  assert.ok(['DEBUGGER_DETACHED', 'TAB_CLOSED', 'CDP_ERROR'].includes(String(outcome)), `outcome ${outcome}`);
  assert.ok(Date.now() - t0 < 3000, 'failed fast');
  const tabs = await A.call('browser_tabs', { action: 'list', spaceId: space.spaceId });
  assert.ok(!tabs.tabs.some((x: { tabId: number }) => x.tabId === t.tabId));
});

test('human input during an agent burst is dropped by the browser-level gate', async () => {
  await A.call('browser_navigate', { tabId: space.tabId, url: `${SITE}/?burst=1` });
  human = await h.humanSession('?burst=1');
  const before = await count();
  const box = await h.eval<{ x: number; y: number }>(human, `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  let stop = false;
  const spam = (async () => {
    let n = 0;
    while (!stop) {
      await h.humanClick(human, box.x, box.y);
      n++;
    }
    return n;
  })();
  await A.call('browser_type', { tabId: space.tabId, target: '#name', text: 'x'.repeat(60), slowly: true });
  stop = true;
  const humanClicks = await spam;
  assert.ok(humanClicks > 5, `human clicked ${humanClicks} times during the burst`);
  console.log(`  ${humanClicks} human click attempts during a ${60 * 2}-event agent burst`);
  assert.equal(await count(), before, 'no human click landed during agent control');
  assert.equal((await h.eval<string>(human, `document.getElementById('name').value`)).length, 60, 'all agent keystrokes landed');
});

test('the human closing the last agent tab ends the Space', async () => {
  const s = await A.call('spaces_create', { name: 'closed by human', url: `${SITE}/?human-close=1` });
  await A.call('browser_wait', { tabId: s.tabId, load: true });
  const { targetInfos } = await h.browser.send<{ targetInfos: { targetId: string; url: string }[] }>('Target.getTargets');
  await h.browser.send('Target.closeTarget', { targetId: targetInfos.find((x) => x.url.includes('human-close=1'))!.targetId });
  await sleep(400);
  const list = await A.call('spaces_list');
  assert.ok(!list.spaces.some((x: { spaceId: number }) => x.spaceId === s.spaceId), 'Space ended');
});

test('click receipts: navigation is detected from events, humanlike clicks still work', async () => {
  await A.call('browser_navigate', { tabId: space.tabId, url: `${SITE}/` });
  const plain = await A.call('browser_click', { tabId: space.tabId, target: '#btn' });
  assert.equal(plain.navigated, false);
  const human = await A.call('browser_click', { tabId: space.tabId, target: '#btn', humanlike: true });
  assert.equal(human.navigated, false);
  const t0 = Date.now();
  const link = await A.call('browser_click', { tabId: space.tabId, target: '#navlink' });
  assert.equal(link.navigated, true, 'link click reports the navigation');
  assert.match(link.url, /via=link/, 'and returns after the new page loaded');
  assert.ok(Date.now() - t0 < 5000);
  await A.call('browser_navigate', { tabId: space.tabId, url: `${SITE}/` });
});

test('closing the space ends it and releases the debugger', async () => {
  const r = await A.call('spaces_close', { spaceId: space.spaceId });
  assert.equal(r.closed, true);
  const list = await A.call('spaces_list');
  assert.ok(!list.spaces.some((s: { spaceId: number }) => s.spaceId === space.spaceId));
});
