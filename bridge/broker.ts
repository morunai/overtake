#!/usr/bin/env node
// Overtake broker: Chrome native messaging host <-> local agent connections.
//
//   Chrome extension ──(native messaging, stdin/stdout)──▶ broker
//   MCP server(s)    ──(unix socket ~/.overtake/run/broker.sock, token auth)──▶ broker
//
// Security model
//  * Chrome only launches this host for the extension id listed in the host
//    manifest's `allowed_origins` (origin restriction).
//  * No TCP listener. The unix socket lives in a 0700 directory and is chmod 0600.
//  * Every client must present the 256-bit token from ~/.overtake/token (0600)
//    in its first message (constant-time compare) or it is disconnected.
//  * The broker stamps each forwarded request with the connection's agentKey;
//    clients cannot act as another agent. The extension enforces ownership.

import net from 'node:net';
import { appendFileSync, unlinkSync, chmodSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { ensureHome, readOrCreateToken, paths } from './paths.ts';
import { NativeReader, writeNative } from './native-io.ts';
import { PROTOCOL_VERSION, ErrorCode, OPERATIONS } from '../shared/protocol.ts';
import type { BrokerToExtension, ExtensionToBroker, ClientMessage, ResponseMessage, EventMessage, Operation } from '../shared/protocol.ts';

const MAX_LINE = 1_000_000; // Chrome refuses host->extension messages over 1 MB.
const AGENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

const p = ensureHome();
const token = readOrCreateToken();
const tokenBuf = Buffer.from(token);

function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    appendFileSync(p.brokerLog, line.replaceAll(token, '<token>'), { mode: 0o600 });
  } catch {
    /* logging must never break the host */
  }
}

interface Client {
  sock: net.Socket;
  agentKey: string | null;
  agentName: string;
  buf: string;
}

const clients = new Set<Client>();
const byAgent = new Map<string, Client>();
const pending = new Map<number, { client: Client; id: number }>();
let nextId = 1;
let extensionReady = false;

function sendToExtension(msg: BrokerToExtension) {
  writeNative(process.stdout, msg);
}

function sendToClient(c: Client, msg: ResponseMessage | EventMessage | { t: 'welcome'; agentKey: string; extensionReady: boolean } | { t: 'bye'; error: { code: string; message: string } }) {
  if (c.sock.destroyed) return;
  c.sock.write(JSON.stringify(msg) + '\n');
}

function reject(c: Client, id: number, code: string, message: string) {
  sendToClient(c, { t: 'res', id, ok: false, error: { code, message } });
}

function tokenOk(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const b = Buffer.from(candidate);
  return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
}

function handleClientMessage(c: Client, msg: ClientMessage) {
  if (!c.agentKey) {
    if (msg.t !== 'hello' || !tokenOk(msg.token)) {
      log('rejected unauthenticated client');
      sendToClient(c, { t: 'bye', error: { code: ErrorCode.UNAUTHORIZED, message: 'Invalid or missing token.' } });
      c.sock.end();
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      sendToClient(c, { t: 'bye', error: { code: ErrorCode.BAD_REQUEST, message: `Protocol ${msg.protocol} unsupported; broker speaks ${PROTOCOL_VERSION}.` } });
      c.sock.end();
      return;
    }
    if (typeof msg.agentKey !== 'string' || !AGENT_KEY_RE.test(msg.agentKey)) {
      sendToClient(c, { t: 'bye', error: { code: ErrorCode.BAD_REQUEST, message: 'agentKey must match [A-Za-z0-9_-]{8,64}.' } });
      c.sock.end();
      return;
    }
    if (byAgent.has(msg.agentKey)) {
      sendToClient(c, { t: 'bye', error: { code: ErrorCode.UNAUTHORIZED, message: 'This agentKey is already connected.' } });
      c.sock.end();
      return;
    }
    c.agentKey = msg.agentKey;
    c.agentName = String(msg.agentName || 'agent').replace(/[^\w .:@#()-]/g, '').slice(0, 64) || 'agent';
    byAgent.set(c.agentKey, c);
    log('agent connected', c.agentName, c.agentKey.slice(0, 6));
    sendToExtension({ t: 'agent', agentKey: c.agentKey, agentName: c.agentName, connected: true });
    sendToClient(c, { t: 'welcome', agentKey: c.agentKey, extensionReady });
    return;
  }
  if (msg.t !== 'req' || typeof msg.id !== 'number') return;
  if (!OPERATIONS.includes(msg.op as Operation)) {
    reject(c, msg.id, ErrorCode.BAD_REQUEST, `Unknown operation ${String(msg.op)}`);
    return;
  }
  if (!extensionReady) {
    reject(c, msg.id, ErrorCode.EXTENSION_NOT_CONNECTED, 'The Overtake extension has not finished connecting.');
    return;
  }
  const id = nextId++;
  pending.set(id, { client: c, id: msg.id });
  sendToExtension({ t: 'req', id, agentKey: c.agentKey, op: msg.op, args: msg.args && typeof msg.args === 'object' ? msg.args : {} });
}

function dropClient(c: Client) {
  if (!clients.has(c)) return;
  clients.delete(c);
  if (c.agentKey && byAgent.get(c.agentKey) === c) {
    byAgent.delete(c.agentKey);
    log('agent disconnected', c.agentName);
    sendToExtension({ t: 'agent', agentKey: c.agentKey, agentName: c.agentName, connected: false });
  }
  for (const [id, entry] of pending) if (entry.client === c) pending.delete(id);
}

function onExtensionMessage(msg: ExtensionToBroker) {
  switch (msg.t) {
    case 'ready':
      extensionReady = true;
      log('extension ready', msg.extensionVersion);
      // Re-announce agents that connected before the extension finished starting.
      for (const c of byAgent.values()) sendToExtension({ t: 'agent', agentKey: c.agentKey!, agentName: c.agentName, connected: true });
      for (const c of byAgent.values()) sendToClient(c, { t: 'evt', event: { type: 'extension', connected: true } });
      return;
    case 'res': {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      sendToClient(entry.client, { t: 'res', id: entry.id, ok: msg.ok, result: msg.result, error: msg.error });
      return;
    }
    case 'evt': {
      if (msg.agentKey === null) for (const c of byAgent.values()) sendToClient(c, { t: 'evt', event: msg.event });
      else {
        const c = byAgent.get(msg.agentKey);
        if (c) sendToClient(c, { t: 'evt', event: msg.event });
      }
      return;
    }
    case 'pong':
      return;
  }
}

async function listen() {
  if (existsSync(p.socket)) {
    const alive = await new Promise<boolean>((resolve) => {
      const s = net.connect(p.socket, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (alive) {
      log('another broker already owns', p.socket, '- this Chrome instance cannot serve agents');
      // Keep the native port open so the extension can show the reason, but serve nothing.
      return null;
    }
    unlinkSync(p.socket);
  }
  const server = net.createServer((sock) => {
    const c: Client = { sock, agentKey: null, agentName: '', buf: '' };
    clients.add(c);
    const authTimer = setTimeout(() => {
      if (!c.agentKey) sock.destroy();
    }, 5000);
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      c.buf += chunk;
      if (c.buf.length > MAX_LINE * 4) {
        log('client exceeded buffer limit');
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, nl);
        c.buf = c.buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (line.length > MAX_LINE) {
          try {
            const id = JSON.parse(line.slice(0, 200).replace(/,"op".*$/, '}'))?.id;
            if (typeof id === 'number') reject(c, id, ErrorCode.BAD_REQUEST, 'Request exceeds 1 MB.');
          } catch {
            /* ignore */
          }
          continue;
        }
        let msg: ClientMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          sock.destroy();
          return;
        }
        handleClientMessage(c, msg);
      }
    });
    sock.on('close', () => {
      clearTimeout(authTimer);
      dropClient(c);
    });
    sock.on('error', () => dropClient(c));
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(p.socket, () => resolve());
  });
  chmodSync(p.socket, 0o600);
  log('listening on', p.socket);
  return server;
}

const server = await listen();

const reader = new NativeReader((msg) => onExtensionMessage(msg as ExtensionToBroker));
process.stdin.on('data', (chunk: Buffer) => reader.push(chunk));
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  log('shutting down');
  for (const c of clients) {
    sendToClient(c, { t: 'evt', event: { type: 'extension', connected: false } });
    c.sock.end();
  }
  if (server) {
    server.close();
    try {
      unlinkSync(paths().socket);
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(0), 50);
}
