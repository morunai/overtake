// README showcase: real public sites in a throwaway headless Chrome profile (no logins, nothing
// personal). Writes stills and a screencast of the hero flow.
//   node tests/e2e/showcase.manual.ts [outDir] [--only hero|overview|states|gif]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, sleep } from './harness.ts';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const out = args.find((a) => !a.startsWith('--') && a !== only) || join(import.meta.dirname, '..', '..', 'artifacts', 'showcase');
mkdirSync(out, { recursive: true });
const want = (s: string) => !only || only === s;

const W = 1280, H = 800, DSF = 2;
const h = new Harness();
await h.start();

async function human(urlPart: string) {
  const s = await h.humanSession(urlPart);
  await h.browser.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DSF, mobile: false }, s);
  return s;
}
async function shot(session: string, name: string) {
  const { data } = await h.browser.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, session);
  writeFileSync(join(out, name), Buffer.from(data, 'base64'));
}
/** Viewport centre of the first visible link whose text is exactly `text` (CSS px). */
async function linkAt(session: string, text: string) {
  const r = await h.eval(session, `(() => { for (const a of document.querySelectorAll('a')) { if (a.textContent.trim() !== ${JSON.stringify(text)}) continue; const b = a.getBoundingClientRect(); if (b.width && b.top > 60 && b.bottom < innerHeight - 40) return Math.round(b.left + b.width / 2) + ',' + Math.round(b.top + b.height / 2); } return null; })()`);
  if (!r) throw new Error(`no visible link "${text}"`);
  return r as string;
}
/** Capture frames while `during` runs, so the best mid-motion frame can be picked. */
async function burst(session: string, prefix: string, during: Promise<unknown>, max = 30) {
  let i = 0, done = false;
  void during.finally(() => (done = true));
  while (!done && i < max) await shot(session, `${prefix}-${String(i++).padStart(2, '0')}.png`);
  await during;
  for (let k = 0; k < 6; k++) { await shot(session, `${prefix}-${String(i++).padStart(2, '0')}.png`); await sleep(70); }
}

try {
  const claude = await h.agent('Claude Code');
  const codex = await h.agent('Codex');
  const ext = await h.extensionPage('overview.html');

  if (want('hero') || want('gif') || want('overview') || want('states')) {
    // Space 1: research on Wikipedia (hero).
    const s1 = await claude.call('spaces_create', { name: 'Browser history research', url: 'https://en.wikipedia.org/wiki/Web_browser' });
    await claude.call('browser_wait', { tabId: s1.tabId, load: true });
    const p1 = await human('wikipedia.org/wiki/Web_browser');
    await claude.call('space_status', { spaceId: s1.spaceId, text: 'Researching the history of web browsers' });
    await sleep(600);

    if (want('gif')) {
      const frames: { data: string; ts: number }[] = [];
      await h.browser.send('Page.enable', {}, p1);
      const onFrame = (m: any) => {
        if (m.sessionId !== p1 || m.method !== 'Page.screencastFrame') return;
        frames.push({ data: m.params.data, ts: m.params.metadata.timestamp });
        void h.browser.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, p1).catch(() => {});
      };
      h.browser.listeners.add(onFrame);
      await h.browser.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 1 }, p1);
      await sleep(900);
      await claude.call('browser_hover', { tabId: s1.tabId, target: '640,420', label: 'Reading the article' });
      await sleep(700);
      await claude.call('browser_click', { tabId: s1.tabId, target: await linkAt(p1, 'Firefox'), label: 'Open the Firefox article' });
      await claude.call('browser_wait', { tabId: s1.tabId, load: true });
      await sleep(1200);
      await h.humanAction(ext, 'takeover', s1.spaceId);
      await sleep(1600);
      await h.humanAction(ext, 'giveback', s1.spaceId);
      await sleep(900);
      await claude.call('browser_hover', { tabId: s1.tabId, target: '760,360', label: 'Back to work' });
      await sleep(1200);
      await h.browser.send('Page.stopScreencast', {}, p1);
      h.browser.listeners.delete(onFrame);
      mkdirSync(join(out, 'gif'), { recursive: true });
      const t0 = frames[0]?.ts ?? 0;
      frames.forEach((f, i) => writeFileSync(join(out, 'gif', `${String(i).padStart(4, '0')}.jpg`), Buffer.from(f.data, 'base64')));
      writeFileSync(join(out, 'gif', 'times.txt'), frames.map((f) => (f.ts - t0).toFixed(3)).join('\n'));
      console.log('gif frames', frames.length);
      await claude.call('browser_navigate', { tabId: s1.tabId, url: 'https://en.wikipedia.org/wiki/Web_browser' });
      await sleep(600);
    }

    if (want('hero')) {
      await claude.call('browser_hover', { tabId: s1.tabId, target: '760,640' });
      await sleep(500);
      await burst(p1, 'hero', claude.call('browser_type', { tabId: s1.tabId, target: '480,33', text: 'History of the web browser', label: 'Search Wikipedia' }));
      await sleep(700);
      await shot(p1, 'hero-idle.png');
    }

    if (want('overview') || want('states')) {
      // Space 2: Hacker News, Codex, running.
      const s2 = await codex.call('spaces_create', { name: 'Morning tech digest', url: 'https://news.ycombinator.com/' });
      await codex.call('browser_wait', { tabId: s2.tabId, load: true });
      await codex.call('space_status', { spaceId: s2.spaceId, text: 'Reading the top stories' });
      await codex.call('browser_hover', { tabId: s2.tabId, target: '300,160', label: 'Scanning headlines' });
      // Space 3: MDN, paused.
      const s3 = await claude.call('spaces_create', { name: 'Fetch API reference', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API' });
      await claude.call('browser_wait', { tabId: s3.tabId, load: true });
      await claude.call('space_status', { spaceId: s3.spaceId, text: 'Checking browser support' });
      await claude.call('browser_hover', { tabId: s3.tabId, target: '640,400', label: 'Reading the guide' });
      // Space 4: GitHub sign-in, needs you.
      const s4 = await codex.call('spaces_create', { name: 'Open a pull request', url: 'https://github.com/login' });
      await codex.call('browser_wait', { tabId: s4.tabId, load: true });
      await codex.call('space_status', { spaceId: s4.spaceId, text: 'Waiting for sign-in' });
      // Space 5: Python docs, human in control.
      const s5 = await claude.call('spaces_create', { name: 'Python asyncio notes', url: 'https://docs.python.org/3/library/asyncio.html' });
      await claude.call('browser_wait', { tabId: s5.tabId, load: true });
      await claude.call('space_status', { spaceId: s5.spaceId, text: 'Collecting examples' });
      await sleep(800);

      const p3 = await human('developer.mozilla.org');
      const p4 = await human('github.com/login');
      const p5 = await human('docs.python.org');
      await h.humanAction(ext, 'pause', s3.spaceId);
      await codex.call('space_handoff', { spaceId: s4.spaceId, reason: 'Sign in to GitHub to continue' });
      await h.humanAction(ext, 'takeover', s5.spaceId);
      await sleep(900);
      if (want('states')) {
        await shot(p3, 'state-paused.png');
        await shot(p4, 'state-handoff.png');
        await shot(p5, 'state-human.png');
      }
      if (want('overview')) {
        await sleep(3500); // let previews refresh
        await h.browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: DSF, mobile: false }, ext);
        await sleep(900);
        await shot(ext, 'overview.png');
      }
    }
  }
  console.log('showcase in', out);
} finally {
  await h.stop();
}
