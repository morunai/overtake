// README demo: records the whole Chrome window (tab strip, toolbar and page) while two agents
// work in Spaces, a human takes over and gives control back, and the Spaces overview shows both.
// Runs a visible Chrome with a throwaway profile and public sites only (no logins, nothing
// personal). macOS only: uses `screencapture -v`, which needs Screen Recording permission.
//   node tests/e2e/demo.manual.ts [out.mov]
// Keep the mouse away from the top-left of the screen while it records.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Harness, sleep } from './harness.ts';

const out = process.argv[2] || join(import.meta.dirname, '..', '..', 'artifacts', 'demo.mov');
const BOUNDS = { left: 40, top: 60, width: 1280, height: 800 };
const SECONDS = 34; // recording length; the storyboard below fits inside it
const h = new Harness();
await h.start({ headful: true });

type TargetInfo = { targetId: string; type: string; url: string };
const targets = async () => (await h.browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
const targetFor = async (urlPart: string) => {
  for (let i = 0; i < 50; i++) {
    const t = (await targets()).find((x) => x.url.includes(urlPart));
    if (t) return t;
    await sleep(100);
  }
  throw new Error(`no page matching ${urlPart}`);
};
/** Put a tab's window at the recorded rectangle. */
async function place(targetId: string) {
  const { windowId } = await h.browser.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId });
  await h.browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await h.browser.send('Browser.setWindowBounds', { windowId, bounds: BOUNDS });
}
const front = (targetId: string) => h.browser.send('Target.activateTarget', { targetId });
async function linkAt(session: string, text: string) {
  const r = await h.eval(session, `(() => { for (const a of document.querySelectorAll('a')) { if (a.textContent.trim() !== ${JSON.stringify(text)}) continue; const b = a.getBoundingClientRect(); if (b.width && b.top > 60 && b.bottom < innerHeight - 40) return Math.round(b.left + b.width / 2) + ',' + Math.round(b.top + b.height / 2); } return null; })()`);
  if (!r) throw new Error(`no visible link "${text}"`);
  return r as string;
}

let rec: ReturnType<typeof spawn> | null = null;
try {
  const claude = await h.agent('Claude Code');
  const codex = await h.agent('Codex');

  // The overview in the first window, replacing the initial blank tab.
  const blank = (await targets())[0];
  const { targetId: overviewId } = await h.browser.send<{ targetId: string }>('Target.createTarget', { url: `chrome-extension://${h.extensionId}/overview.html` });
  if (blank) await h.browser.send('Target.closeTarget', { targetId: blank.targetId });
  const { sessionId: ext } = await h.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId: overviewId, flatten: true });
  await place(overviewId);
  await front(overviewId);
  spawn('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${h.chrome.pid}) to true`], { stdio: 'ignore' });
  await sleep(1500);

  const { left, top, width, height } = BOUNDS;
  rec = spawn('screencapture', ['-x', '-v', '-V', String(SECONDS), '-R', `${left},${top},${width},${height}`, out], { stdio: 'ignore' });
  await sleep(2200); // the empty overview

  // Two agents open Spaces; their cards appear live. Space windows open behind the overview.
  const s1 = await claude.call('spaces_create', { name: 'Browser history research', url: 'https://en.wikipedia.org/wiki/Web_browser' });
  const t1 = await targetFor('wikipedia.org/wiki/Web_browser');
  await place(t1.targetId);
  await front(overviewId);
  await claude.call('space_status', { spaceId: s1.spaceId, text: 'Researching the history of web browsers' });
  await sleep(1800);
  const s2 = await codex.call('spaces_create', { name: 'Morning tech digest', url: 'https://news.ycombinator.com/' });
  const t2 = await targetFor('news.ycombinator.com');
  await place(t2.targetId);
  await front(overviewId);
  await codex.call('space_status', { spaceId: s2.spaceId, text: 'Scanning headlines' });
  await sleep(2600);

  // The human opens Claude's Space from the overview.
  const card = await h.eval<{ x: number; y: number }>(ext, `(() => { const r = document.querySelector('.card[data-space="${s1.spaceId}"] .shot').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await h.humanClick(ext, card.x, card.y);
  await sleep(1600);
  const p1 = await h.humanSession('wikipedia.org/wiki/Web_browser');

  // The agent works: cursor, label, click ripple, scrolling.
  await claude.call('browser_hover', { tabId: s1.tabId, target: '640,420', label: 'Reading the article' });
  await sleep(900);
  const history = await linkAt(p1, 'History').catch(() => null);
  if (history) await claude.call('browser_click', { tabId: s1.tabId, target: history, label: 'Open the History section' });
  else await claude.call('browser_scroll', { tabId: s1.tabId, dy: 600, label: 'Scrolling to History' });
  await sleep(1400);
  await claude.call('browser_scroll', { tabId: s1.tabId, dy: 300, label: 'Reading the history' });
  await sleep(1000);

  // The human takes over from the dock, looks around, then gives control back.
  const take = await h.overlayButton(p1, 'Take over');
  if (take) await h.humanClick(p1, take.x, take.y);
  await sleep(2200);
  const back = await h.overlayButton(p1, 'Give back');
  if (back) await h.humanClick(p1, back.x, back.y);
  await sleep(900);
  await claude.call('browser_scroll', { tabId: s1.tabId, dy: 400, label: 'Back to work' });
  await sleep(1400);

  // Back to the overview: both Spaces running.
  await front(overviewId);
  await codex.call('browser_scroll', { tabId: s2.tabId, dy: 300, label: 'Scanning headlines' });
  await sleep(3500);
} finally {
  // screencapture only writes the file when its fixed duration ends; let it finish.
  if (rec && rec.exitCode === null) await new Promise((r) => rec!.on('exit', r));
  await h.stop();
}
console.log('demo recorded to', out);
