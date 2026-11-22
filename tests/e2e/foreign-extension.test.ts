// Regression: another extension (LastPass, J2TEAM, AI sidebars...) injects its own
// chrome-extension:// iframe into every page. Chrome then refuses chrome.debugger.attach
// ("Cannot access a chrome-extension:// URL of different extension"). Agent Space tabs
// must still work; ordinary tabs must keep the other extension's frame.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Harness, SITE, sleep, type Agent } from './harness.ts';

const h = new Harness();
let A: Agent;
let tabId: number;

before(async () => {
  await h.start();
  await h.browser.send('Extensions.loadUnpacked', { path: join(import.meta.dirname, '..', 'fixtures', 'iframe-injector') });
  await h.browser.send('Target.createTarget', { url: `${SITE}/?normal=1` });
  A = await h.agent('foreign-ext');
  tabId = (await A.call('spaces_create', { name: 'foreign', url: `${SITE}/` })).tabId;
  await sleep(1500); // the injector runs at document_idle
});
after(() => h.stop());

test('agent can attach and act although another extension injects frames', async () => {
  const snap: string = await A.call('browser_snapshot', { tabId });
  assert.match(snap, /button "Click me"/);
  await A.call('browser_navigate', { tabId, url: `${SITE}/?again=1` });
  await sleep(1200); // injector re-inserts after navigation
  await A.call('browser_click', { tabId, target: '#btn' });
  const v = await A.call('browser_evaluate', { tabId, expression: `[document.getElementById('count').dataset.count, !!document.querySelector('.injected-ext-frame'), !!document.querySelector('.injected-ext-shadow-host')]` });
  assert.equal(v.value[0], '1');
  assert.equal(v.value[1], false, 'plain foreign iframe removed');
  assert.equal(v.value[2], true, 'the host element stays; only the frame inside its closed shadow root is removed');
});

test('ordinary tabs keep the other extension working', async () => {
  const s = await h.humanSession('normal=1');
  assert.equal(await h.eval(s, `!!document.querySelector('.injected-ext-frame')`), true);
  const { targetInfos } = await h.browser.send<{ targetInfos: { type: string; url: string }[] }>('Target.getTargets');
  assert.ok(targetInfos.filter((t) => t.type === 'iframe' || t.url.endsWith('/frame.html')).length >= 1);
});
