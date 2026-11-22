// Isolated Overtake environment for the realistic-rounds benchmark.
// Same approach as tests/e2e/harness.ts (throwaway Chrome profile, Extensions.loadUnpacked,
// own OVERTAKE_HOME, native host manifest inside the profile only), but:
//  * every file comes from the pinned snapshot (RR_SNAPSHOT), not the live tree;
//  * it does not run scripts/install.mjs (that rebuilds the live dist/extension and writes
//    .mcp.json); it bundles the snapshot broker itself into the throwaway OVERTAKE_HOME.
// Nothing here touches the user's Chrome profile, ~/.overtake or the installed native host.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const SNAP = process.env.RR_SNAPSHOT || join(tmpdir(), 'overtake-bench-snapshot');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRATCH = join(SNAP, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OvertakeEnv {
  chrome!: ChildProcess;
  profile!: string;
  home!: string;
  ws!: WebSocket;

  async start({ headful = false } = {}) {
    if (!existsSync(join(SNAP, 'mcp', 'server.ts'))) throw new Error(`snapshot missing at ${SNAP}`);
    this.profile = mkdtempSync(join(SCRATCH, 'rr-chrome-'));
    this.home = mkdtempSync(join(SCRATCH, 'rr-home-'));
    for (const d of ['run', 'logs', 'bin']) mkdirSync(join(this.home, d), { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
    writeFileSync(join(this.home, 'token'), randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    const bundle = join(this.home, 'bin', 'broker.mjs');
    await build({ entryPoints: [join(SNAP, 'bridge', 'broker.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundle, logLevel: 'warning' });
    const launcher = join(this.home, 'bin', 'overtake-broker');
    writeFileSync(launcher, `#!/bin/sh\nexport OVERTAKE_HOME='${this.home}'\nexec '${process.execPath}' '${bundle}' "$@" 2>>'${join(this.home, 'logs', 'broker.stderr.log')}'\n`, { mode: 0o700 });
    const extId = readFileSync(join(SNAP, 'keys', 'extension-id.txt'), 'utf8').trim();
    const hostDir = join(this.profile, 'NativeMessagingHosts');
    mkdirSync(hostDir, { recursive: true });
    const name = 'dev.overtake.broker';
    writeFileSync(join(hostDir, `${name}.json`), JSON.stringify({ name, description: 'rr-bench broker', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extId}/`] }));
    const args = [
      `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run',
      '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1280,860', '--force-device-scale-factor=1', 'about:blank',
    ];
    if (!headful) args.unshift('--headless=new');
    this.chrome = spawn(CHROME, args, { stdio: 'ignore' });
    const portFile = join(this.profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
    const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    const r = await new Promise<any>((resolve) => {
      this.ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === 1) resolve(m); };
      this.ws.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: join(SNAP, 'dist', 'extension') } }));
    });
    if (r.error || r.result?.id !== extId) throw new Error(`extension load failed: ${JSON.stringify(r.error ?? r.result)}`);
    const sock = join(this.home, 'run', 'broker.sock');
    for (let i = 0; i < 150 && !existsSync(sock); i++) await sleep(100);
    if (!existsSync(sock)) throw new Error('broker did not start (native messaging)');
  }

  /** MCP client to the snapshot server, as Claude Code would spawn it. */
  async agent(name: string) {
    const t0 = performance.now();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(SNAP, 'mcp', 'server.ts')],
      env: { ...(process.env as Record<string, string>), OVERTAKE_HOME: this.home, OVERTAKE_AGENT_NAME: name },
      stderr: 'ignore',
    });
    const client = new Client({ name: `rr-${name}`, version: '1.0.0' });
    await client.connect(transport);
    return { client, pid: (transport as unknown as { pid: number | null }).pid, connectMs: performance.now() - t0 };
  }

  /** Config for `claude --mcp-config` pointing at this environment (real-agent benchmark). */
  mcpConfig(name: string) {
    return { mcpServers: { 'overtake': { command: process.execPath, args: [join(SNAP, 'mcp', 'server.ts')], env: { OVERTAKE_HOME: this.home, OVERTAKE_AGENT_NAME: name } } } };
  }

  async stop() {
    try { this.ws?.close(); } catch {}
    this.chrome?.kill();
    await sleep(800);
    rmSync(this.profile, { recursive: true, force: true });
    rmSync(this.home, { recursive: true, force: true });
  }
}
