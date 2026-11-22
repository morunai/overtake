// Spawns the real broker with a temp OVERTAKE_HOME and plays the extension over
// native-messaging stdio, checking auth, routing, agent stamping and isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { NativeReader, encodeNative } from '../../bridge/native-io.ts';
import { BrokerClient } from '../../mcp/broker-client.ts';

const home = mkdtempSync(join(tmpdir(), 'overtake-broker-'));
const TOKEN = 'a'.repeat(64);
writeFileSync(join(home, 'token'), TOKEN + '\n', { mode: 0o600 });
const sock = join(home, 'run', 'broker.sock');
let broker: ChildProcess;
const fromBroker: Record<string, unknown>[] = [];
let onMsg: ((m: Record<string, unknown>) => void) | null = null;

function toBroker(msg: unknown) {
  broker.stdin!.write(encodeNative(msg));
}
function nextMsg(pred: (m: Record<string, unknown>) => boolean, ms = 2000): Promise<Record<string, unknown>> {
  const found = fromBroker.find(pred);
  if (found) {
    fromBroker.splice(fromBroker.indexOf(found), 1);
    return Promise.resolve(found);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for broker message')), ms);
    onMsg = (m) => {
      if (pred(m)) {
        clearTimeout(t);
        fromBroker.splice(fromBroker.indexOf(m), 1);
        onMsg = null;
        resolve(m);
      }
    };
  });
}

before(async () => {
  broker = spawn(process.execPath, [join(import.meta.dirname, '../../bridge/broker.ts')], { env: { ...process.env, OVERTAKE_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  const reader = new NativeReader((m) => {
    fromBroker.push(m as Record<string, unknown>);
    onMsg?.(m as Record<string, unknown>);
  });
  broker.stdout!.on('data', (c: Buffer) => reader.push(c));
  for (let i = 0; i < 50; i++) {
    try {
      statSync(sock);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  toBroker({ t: 'ready', extensionVersion: 'test', protocol: 1 });
});

after(() => {
  broker.kill();
  rmSync(home, { recursive: true, force: true });
});

test('socket and directories are owner-only', () => {
  assert.equal(statSync(join(home, 'run')).mode & 0o777, 0o700);
  assert.equal(statSync(sock).mode & 0o777, 0o600);
});

test('a client with a wrong token is refused before anything is forwarded', async () => {
  const bad = new BrokerClient({ socketPath: sock, token: 'b'.repeat(64), agentKey: 'badagent_1' });
  await assert.rejects(bad.connect(), (e: Error & { code: string }) => e.code === 'UNAUTHORIZED');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fromBroker.some((m) => m.agentKey === 'badagent_1'), 'nothing about the bad client reaches the extension');
});

test('a raw socket that never authenticates cannot send requests', async () => {
  const s = net.connect(sock);
  await new Promise((r) => s.on('connect', r));
  s.write(JSON.stringify({ t: 'req', id: 1, op: 'spaces.list', args: {} }) + '\n');
  const reply = await new Promise<string>((r) => s.once('data', (d) => r(String(d))));
  assert.match(reply, /UNAUTHORIZED/);
  s.destroy();
});

test('requests are stamped with the connection agentKey and responses routed back', async () => {
  const c = new BrokerClient({ socketPath: sock, token: TOKEN, agentKey: 'agentone_1', agentName: 'one' });
  await c.connect();
  const hello = await nextMsg((m) => m.t === 'agent' && m.agentKey === 'agentone_1');
  assert.equal(hello.connected, true);
  const p = c.request('spaces.list', { agentKey: 'spoofed_999' });
  const req = await nextMsg((m) => m.t === 'req');
  assert.equal(req.agentKey, 'agentone_1', 'broker stamps the authenticated identity');
  toBroker({ t: 'res', id: req.id, ok: true, result: { spaces: [] } });
  assert.deepEqual(await p, { spaces: [] });
  c.close();
  const bye = await nextMsg((m) => m.t === 'agent' && m.agentKey === 'agentone_1' && m.connected === false);
  assert.equal(bye.connected, false, 'extension learns about the disconnect');
});

test('errors and events reach only the right agent', async () => {
  const a = new BrokerClient({ socketPath: sock, token: TOKEN, agentKey: 'agentaaa_1' });
  const b = new BrokerClient({ socketPath: sock, token: TOKEN, agentKey: 'agentbbb_1' });
  await a.connect();
  await b.connect();
  const evA: unknown[] = [];
  const evB: unknown[] = [];
  a.on('event', (e) => evA.push(e));
  b.on('event', (e) => evB.push(e));
  toBroker({ t: 'evt', agentKey: 'agentaaa_1', event: { type: 'tab-closed', tabId: 1, spaceId: 1 } });
  toBroker({ t: 'evt', agentKey: null, event: { type: 'space-closed', spaceId: 9 } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(evA.length, 2);
  assert.equal(evB.length, 1, 'b only sees the broadcast');
  const p = b.request('cdp', { tabId: 1, method: 'Runtime.evaluate' });
  const req = await nextMsg((m) => m.t === 'req' && m.agentKey === 'agentbbb_1');
  toBroker({ t: 'res', id: req.id, ok: false, error: { code: 'USER_IN_CONTROL', message: 'human' } });
  await assert.rejects(p, (e: Error & { code: string }) => e.code === 'USER_IN_CONTROL');
  a.close();
  b.close();
});

test('duplicate agentKey is refused while the first is connected', async () => {
  const a = new BrokerClient({ socketPath: sock, token: TOKEN, agentKey: 'dupagent_1' });
  await a.connect();
  const b = new BrokerClient({ socketPath: sock, token: TOKEN, agentKey: 'dupagent_1' });
  await assert.rejects(b.connect(), (e: Error & { code: string }) => e.code === 'UNAUTHORIZED');
  a.close();
});

test('unknown operations are rejected by the broker', async () => {
  const a = new BrokerClient({ socketPath: sock, token: TOKEN, agentKey: 'opsagent_1' });
  await assert.rejects(a.request('shell.exec' as never, {}), (e: Error & { code: string }) => e.code === 'BAD_REQUEST');
  a.close();
});
