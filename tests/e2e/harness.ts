// Real-browser E2E harness.
//  * Launches the installed Google Chrome with a throwaway profile (the user's
//    profile is never touched) and loads the unpacked extension via CDP
//    Extensions.loadUnpacked (branded Chrome ignores --load-extension).
//  * Installs the native host into that profile only; Chrome launches the real broker.
//  * Agents connect through the real MCP server over stdio (what Claude Code does).
//  * "Human" actions are trusted CDP mouse events from the harness's own
//    connection: they behave like a person clicking the page or the dock.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestServer } from '../../test-site/server.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const SITE = 'http://127.0.0.1:8765';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  listeners = new Set<(m: any) => void>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.#pending.has(m.id)) {
        const p = this.#pending.get(m.id)!;
        this.#pending.delete(m.id);
        if (m.error) p.reject(new Error(`${m.error.message} ${m.error.data || ''}`));
        else p.resolve(m.result);
      } else for (const l of this.listeners) l(m);
    };
  }
  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    return new Cdp(ws);
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.ws.close();
  }
}

export interface Agent {
  name: string;
  client: Client;
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
  callRaw: (tool: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; content: any[] }>;
  close: () => Promise<void>;
}

export class Harness {
  chrome!: ChildProcess;
  profile!: string;
  home!: string;
  browser!: Cdp;
  server!: { close: () => void };
  extensionId = readFileSync(join(ROOT, 'keys', 'extension-id.txt'), 'utf8').trim();
  agents: Agent[] = [];

  async start({ headful = process.env.E2E_HEADFUL === '1' } = {}) {
    // Reuse a test site that is already running (e.g. `npm run test-site`).
    const running = await fetch(`${SITE}/api/data`).then((r) => r.ok, () => false);
    this.server = running ? { close: () => {} } : ((await startTestServer(8765)) as unknown as { close: () => void });
    this.profile = mkdtempSync(join(tmpdir(), 'overtake-chrome-'));
    this.home = mkdtempSync(join(tmpdir(), 'overtake-home-'));
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'install.mjs'), '--user-data-dir', this.profile, '--home', this.home], { stdio: 'pipe' });
    const args = [
      `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run',
      '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1280,860', '--force-device-scale-factor=1', 'about:blank',
    ];
    if (!headful) args.unshift('--headless=new');
    this.chrome = spawn(CHROME, args, { stdio: 'ignore' });
    const portFile = join(this.profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
    this.browser = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
    const r = await this.browser.send<{ id: string }>('Extensions.loadUnpacked', { path: join(ROOT, 'dist', 'extension') });
    if (r.id !== this.extensionId) throw new Error(`unexpected extension id ${r.id}`);
    const sock = join(this.home, 'run', 'broker.sock');
    for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
    if (!existsSync(sock)) throw new Error('broker did not start (native messaging)');
  }

  async agent(name: string, home = this.home): Promise<Agent> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'mcp', 'server.ts')],
      env: { ...(process.env as Record<string, string>), OVERTAKE_HOME: home, OVERTAKE_AGENT_NAME: name },
      stderr: 'inherit',
    });
    const client = new Client({ name: `e2e-${name}`, version: '1.0.0' });
    await client.connect(transport);
    const callRaw = async (tool: string, args: Record<string, unknown> = {}) => (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: any[] };
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await callRaw(tool, args);
      const txt = r.content.find((c) => c.type === 'text')?.text ?? '';
      if (r.isError) {
        const err = new Error(txt) as Error & { code: string };
        err.code = txt.split(':')[0];
        throw err;
      }
      try {
        return JSON.parse(txt);
      } catch {
        return txt;
      }
    };
    const a: Agent = { name, client, call, callRaw, close: () => client.close() };
    this.agents.push(a);
    return a;
  }

  /** Attach the harness ("human") to a page by URL substring; returns a flat session. */
  async humanSession(urlPart: string): Promise<string> {
    const { targetInfos } = await this.browser.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'page' && x.url.includes(urlPart));
    if (!t) throw new Error(`no page matching ${urlPart}`);
    const { sessionId } = await this.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    return sessionId;
  }

  async humanClick(sessionId: string, x: number, y: number) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.browser.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sessionId);
    }
  }

  /** A human native drop of plain text (drag events reach the page even while Chrome ignores input). */
  async humanDrop(sessionId: string, x: number, y: number, text: string) {
    const data = { items: [{ mimeType: 'text/plain', data: text }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await this.browser.send('Input.dispatchDragEvent', { type, x, y, data }, sessionId);
  }

  async eval<T = any>(sessionId: string, expression: string): Promise<T> {
    const r = await this.browser.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result.value;
  }

  /** Locate an element inside the overlay's closed shadow root (DOM.getDocument pierce). */
  async overlayElement(sessionId: string, predicate: (n: any) => boolean): Promise<any | null> {
    const { root } = await this.browser.send<{ root: any }>('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    let found: any = null;
    const walk = (n: any, inOverlay: boolean) => {
      if (found) return;
      const here = inOverlay || n.localName === 'overtake-overlay';
      if (here && predicate(n)) found = n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here);
    };
    walk(root, false);
    return found;
  }

  async overlayButton(sessionId: string, label: string) {
    const btn = await this.overlayElement(sessionId, (n) => n.localName === 'button' && (n.children || []).some((c: any) => c.nodeValue === label));
    if (!btn) return null;
    const { model } = await this.browser.send<{ model: { content: number[]; width: number; height: number } }>('DOM.getBoxModel', { backendNodeId: btn.backendNodeId }, sessionId).catch(() => ({ model: null as any }));
    if (!model || !model.width) return null;
    const c = model.content;
    return { x: (c[0] + c[4]) / 2, y: (c[1] + c[5]) / 2 };
  }

  async overlayClasses(sessionId: string, cls: string): Promise<string> {
    const n = await this.overlayElement(sessionId, (x) => (x.attributes || []).some((a: string, i: number, arr: string[]) => a === 'class' && arr[i + 1]?.split(' ').includes(cls)));
    if (!n) return '';
    const i = n.attributes.indexOf('class');
    return n.attributes[i + 1];
  }

  async overlayStyle(sessionId: string, cls: string): Promise<string> {
    const n = await this.overlayElement(sessionId, (x) => (x.attributes || []).some((a: string, i: number, arr: string[]) => a === 'class' && arr[i + 1]?.split(' ').includes(cls)));
    if (!n) return '';
    const i = n.attributes.indexOf('style');
    return i >= 0 ? n.attributes[i + 1] : '';
  }

  /** Open an extension page (overview) and act like the human clicking its buttons. */
  async extensionPage(path: string): Promise<string> {
    const { targetId } = await this.browser.send<{ targetId: string }>('Target.createTarget', { url: `chrome-extension://${this.extensionId}/${path}` });
    const { sessionId } = await this.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await sleep(500);
    return sessionId;
  }

  async humanAction(extSession: string, action: string, spaceId?: number, extra: Record<string, unknown> = {}) {
    return this.eval(extSession, `chrome.runtime.sendMessage(${JSON.stringify({ type: 'overtake:human', action, spaceId, extra })})`);
  }

  async screenshot(sessionId: string, path: string) {
    const { data } = await this.browser.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }

  async stop() {
    for (const a of this.agents) await a.close().catch(() => {});
    this.browser?.close();
    this.chrome?.kill();
    this.server?.close();
    await sleep(500);
    rmSync(this.profile, { recursive: true, force: true });
    rmSync(this.home, { recursive: true, force: true });
  }
}

export function pngSize(b64: string): { width: number; height: number } {
  const b = Buffer.from(b64, 'base64');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
