// Regression: while an agent works, the overview used to rebuild every card on each update.
// Cards flashed (the entrance animation replayed) and clicks were lost when a card was
// replaced between mousedown and mouseup, so users had to click 2-3 times to open a Space.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, SITE, sleep, type Agent } from './harness.ts';

const h = new Harness();
let A: Agent;
let spaceId: number;
let ext: string;

before(async () => {
  await h.start();
  A = await h.agent('overview-churn');
  ({ spaceId } = await A.call('spaces_create', { name: 'Churn', url: `${SITE}/` }));
  ext = await h.extensionPage('overview.html');
  await h.browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, ext);
  await sleep(800);
  // Record card replacements and entrance animations, and every human action the page sends.
  await h.eval(ext, `(() => {
    window.__removed = 0; window.__enters = 0; window.__sent = [];
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes) if (n.classList?.contains('card')) window.__removed++; })
      .observe(document.getElementById('grid'), { childList: true });
    document.addEventListener('animationstart', (e) => { if (e.animationName === 'enter' && e.target.classList?.contains('card')) window.__enters++; }, true);
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...rest) => { window.__sent.push(m.action); return send(m, ...rest); };
    return 1;
  })()`);
});
after(() => h.stop());

async function churn(ms: number) {
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) await A.call('space_status', { spaceId, text: `Working step ${i++}` });
}

test('agent status updates patch the card in place (no rebuild, no flash)', async () => {
  await churn(2500);
  await sleep(300);
  const r = await h.eval(ext, `({ removed: window.__removed, enters: window.__enters, what: document.querySelector('.card .status')?.textContent })`);
  assert.equal(r.removed, 0, 'no card element was replaced');
  assert.equal(r.enters, 0, 'no entrance animation replayed');
  assert.match(r.what, /Working step \d+/, 'the status line still shows the latest status');
});

test('one click on a card opens its Space, even while updates stream in', async () => {
  const box = await h.eval(ext, `(() => { const r = document.querySelector('.card[data-space="${spaceId}"] .shot').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.75 }; })()`);
  const churning = churn(1500);
  await sleep(200);
  // A slow human click: updates arrive between press and release.
  await h.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' }, ext);
  await h.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, ext);
  await sleep(250);
  await h.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, ext);
  await churning;
  await sleep(700); // the open animation runs before the window switch
  const sent: string[] = await h.eval(ext, 'window.__sent');
  assert.deepEqual(sent.filter((a) => a === 'switch'), ['switch'], `one click, one switch (sent: ${sent.join(',')})`);
  assert.equal(await h.eval(ext, `document.querySelector('.card[data-space="${spaceId}"]').classList.contains('sel')`), true);
});
