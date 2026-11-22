// Records the agent cursor effect at 60 fps in a visible Chrome window (macOS,
// needs Screen Recording permission). Usage: node tests/e2e/record.manual.ts <recorder> <findwin> <out.mov>
import { spawn, execFileSync } from 'node:child_process';
import { Harness, SITE, sleep } from './harness.ts';

const [recorder, findwin, out] = process.argv.slice(2);
const h = new Harness();
await h.start({ headful: true });
try {
  const a = await h.agent('claude-code-1');
  const s = await a.call('spaces_create', { name: 'Motion study', url: `${SITE}/?motion=1` });
  await a.call('browser_wait', { tabId: s.tabId, load: true });
  const human = await h.humanSession('motion=1');
  await h.eval(human, `document.title='Motion study page'; document.body.style.background='#15171d'; document.body.style.color='#e8eaf0'; document.querySelectorAll('.card').forEach(c => c.style.background='#1c1f27'); 1`);
  await a.call('space_status', { spaceId: s.spaceId, text: 'Studying the page' });
  await sleep(800);
  const win = execFileSync(findwin, ['Motion study page']).toString().trim();
  if (!win) throw new Error('window not found');
  const rec = spawn(recorder, [win, '19', out], { stdio: 'inherit' });
  await sleep(1500);
  await a.call('browser_hover', { tabId: s.tabId, target: '120,90', label: 'Looking around' });
  await sleep(700);
  await a.call('browser_click', { tabId: s.tabId, target: '#fetch', label: 'Fetch the data' });
  await sleep(1300);
  await a.call('browser_drag', { tabId: s.tabId, from: '160,430', to: '980,170', label: 'Sweep across' });
  await sleep(1300);
  await a.call('browser_click', { tabId: s.tabId, target: '#btn', label: 'Click the button' });
  await sleep(1200);
  await a.call('browser_type', { tabId: s.tabId, target: '#name', text: 'hello', label: 'Type a name' });
  const ext = await h.extensionPage('overview.html');
  await sleep(1500);
  await h.humanAction(ext, 'pause', s.spaceId); // ambient freezes + amber
  await sleep(1500);
  await h.humanAction(ext, 'resume', s.spaceId);
  await sleep(1200);
  await h.humanAction(ext, 'takeover', s.spaceId); // ambient fades out
  await new Promise((r) => rec.on('exit', r));
} finally {
  await h.stop();
}
