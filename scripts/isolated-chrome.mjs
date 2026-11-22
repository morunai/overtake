#!/usr/bin/env node
// Optional isolated mode: a separate Google Chrome process with its own profile
// (cookies, storage, logins fully separate from your everyday Chrome), running
// the same Overtake extension and its own broker/socket.
//
//   node scripts/isolated-chrome.mjs <name> [--headless] [--url URL]
//
// Tab groups / windows in your main Chrome are organisation only; they share the
// profile's cookies. Use this mode
// when an agent needs a clean identity.
//
// Security: Chrome is controlled through --remote-debugging-pipe, which only this
// launcher holds (no TCP port). The launcher stays alive as the pipe holder and
// exits when Chrome exits (Chrome also exits if the launcher is killed).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--url');
if (!name || !/^[\w-]{1,40}$/.test(name)) {
  console.error('usage: node scripts/isolated-chrome.mjs <name> [--headless] [--url URL]   (name: letters, digits, - or _)');
  process.exit(2);
}
const headless = args.includes('--headless');
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'about:blank';
const base = process.env.OVERTAKE_ISOLATED_ROOT || join(homedir(), '.overtake', 'isolated');
const home = join(base, name, 'state');
const profile = join(base, name, 'profile');
mkdirSync(profile, { recursive: true, mode: 0o700 });

execFileSync(process.execPath, [join(root, 'scripts', 'install.mjs'), '--user-data-dir', profile, '--home', home], { stdio: 'ignore' });

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromeArgs = [
  `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', url,
];
if (headless) chromeArgs.unshift('--headless=new');
const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];

let buf = '';
const loaded = new Promise((resolve, reject) => {
  fromChrome.on('data', (d) => {
    buf += d;
    const parts = buf.split('\0');
    buf = parts.pop();
    for (const p of parts) {
      const m = JSON.parse(p);
      if (m.id === 1) (m.error ? reject(new Error(m.error.message)) : resolve(m.result.id));
    }
  });
});
toChrome.write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: join(root, 'dist', 'extension') } }) + '\0');

try {
  const id = await loaded;
  const sock = join(home, 'run', 'broker.sock');
  for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  console.log(JSON.stringify({
    ready: existsSync(sock), name, extensionId: id, pid: chrome.pid, overtakeHome: home, profile,
    mcp: `claude mcp add overtake-${name} -e OVERTAKE_HOME='${home}' -- '${process.execPath}' '${join(root, 'mcp', 'server.ts')}'`,
  }));
} catch (e) {
  console.error('failed to load the extension:', e.message);
  chrome.kill();
  process.exit(1);
}

chrome.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => chrome.kill());
