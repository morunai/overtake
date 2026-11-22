// Visual capture: drives real agent actions through MCP and records frames of the
// page (overlay included) while they run, so motion can be inspected frame by frame.
//   node tests/e2e/visual.manual.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, SITE, sleep } from './harness.ts';

const out = process.argv[2] || join(import.meta.dirname, '..', '..', 'artifacts', 'visual');
mkdirSync(out, { recursive: true });
const h = new Harness();
await h.start({ headful: process.env.E2E_HEADFUL === '1' });

async function burst(session: string, prefix: string, during: Promise<unknown>, max = 40) {
  let i = 0;
  let done = false;
  void during.finally(() => (done = true));
  while (!done && i < max) {
    const { data } = await h.browser.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, session);
    writeFileSync(join(out, `${prefix}-${String(i++).padStart(2, '0')}.png`), Buffer.from(data, 'base64'));
  }
  await during;
  for (let k = 0; k < 10; k++) {
    const { data } = await h.browser.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, session);
    writeFileSync(join(out, `${prefix}-${String(i++).padStart(2, '0')}.png`), Buffer.from(data, 'base64'));
    await sleep(60);
  }
}

try {
  const a = await h.agent('claude-code-78505');
  const s = await a.call('spaces_create', { name: 'Visual check', url: `${SITE}/?dark=1` });
  await a.call('browser_wait', { tabId: s.tabId, load: true });
  const human = await h.humanSession('dark=1');
  await h.eval(human, `document.body.style.background='#15171d'; document.body.style.color='#e8eaf0'; document.querySelectorAll('.card').forEach(c => c.style.background='#1c1f27'); 1`);
  await a.call('space_status', { spaceId: s.spaceId, text: 'Reading the test page' });
  await a.call('browser_hover', { tabId: s.tabId, target: '60,80' });
  await sleep(400);
  // Long glide + click while capturing.
  await burst(human, 'dark-click', a.call('browser_click', { tabId: s.tabId, target: '#fetch', label: 'Fetch the data' }));
  await burst(human, 'dark-sweep', a.call('browser_drag', { tabId: s.tabId, from: '120,420', to: '980,160', label: 'Sweep across' }));
  await sleep(900);
  await h.screenshot(human, join(out, 'dark-idle.png'));
  // Light page.
  await h.eval(human, `document.body.style.background=''; document.body.style.color=''; document.querySelectorAll('.card').forEach(c => c.style.background=''); 1`);
  await burst(human, 'light-click', a.call('browser_click', { tabId: s.tabId, target: '#btn', label: 'Click the button' }));
  await sleep(900);
  await h.screenshot(human, join(out, 'light-idle.png'));
  // States.
  const ext = await h.extensionPage('overview.html');
  await h.humanAction(ext, 'pause', s.spaceId);
  await sleep(500);
  await h.screenshot(human, join(out, 'state-paused.png'));
  await h.humanAction(ext, 'resume', s.spaceId);
  await h.humanAction(ext, 'takeover', s.spaceId);
  await sleep(500);
  await h.screenshot(human, join(out, 'state-human.png'));
  await h.humanAction(ext, 'giveback', s.spaceId);
  await a.call('space_handoff', { spaceId: s.spaceId, reason: 'Sign in to continue' });
  await sleep(500);
  await h.screenshot(human, join(out, 'state-handoff.png'));
  await a.call('space_resume', { spaceId: s.spaceId });
  // Overview with a second agent space.
  const b = await h.agent('codex-4411');
  const s2 = await b.call('spaces_create', { name: 'Docs research', url: `${SITE}/?b=1` });
  await b.call('browser_wait', { tabId: s2.tabId, load: true });
  await b.call('space_status', { spaceId: s2.spaceId, text: 'Comparing API references' });
  await b.call('browser_click', { tabId: s2.tabId, target: '#btn', label: 'Open reference' });
  await h.humanAction(ext, 'create', undefined, { name: 'Personal' });
  await h.humanAction(ext, 'pause', s2.spaceId);
  await sleep(3200);
  await h.browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, ext);
  await sleep(600);
  await h.screenshot(ext, join(out, 'overview.png'));
  await h.browser.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, ext);
  await sleep(400);
  await h.screenshot(ext, join(out, 'overview-narrow.png'));
  await h.browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, ext);
  await h.eval(ext, `document.querySelector('.card').click(); document.getElementById('details').click(); 1`);
  await sleep(400);
  await h.screenshot(ext, join(out, 'overview-details.png'));
  console.log('frames in', out);
} finally {
  await h.stop();
}
