// Unix-socket client for the Overtake broker. One instance per MCP server process.
// The agentKey is stable for the life of this process so ownership survives
// broker/extension reconnects.

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { paths, readToken } from '../bridge/paths.ts';
import { OvertakeError, ErrorCode, PROTOCOL_VERSION } from '../shared/protocol.ts';
import type { AgentEvent, Operation, ResponseMessage } from '../shared/protocol.ts';

export interface BrokerClientOptions {
  socketPath?: string;
  token?: string;
  agentName?: string;
  agentKey?: string;
  requestTimeoutMs?: number;
}

export class BrokerClient extends EventEmitter {
  readonly agentKey: string;
  readonly agentName: string;
  #opts: BrokerClientOptions;
  #sock: net.Socket | null = null;
  #ready: Promise<void> | null = null;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  #nextId = 1;
  #buf = '';
  #closed = false;

  constructor(opts: BrokerClientOptions = {}) {
    super();
    this.setMaxListeners(100);
    this.#opts = opts;
    this.agentKey = opts.agentKey || randomBytes(12).toString('base64url');
    this.agentName = opts.agentName || process.env.OVERTAKE_AGENT_NAME || `claude-code-${process.pid}`;
  }

  /** Connect lazily; reconnects on the next request after a drop. */
  connect(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      const token = this.#opts.token ?? readToken();
      if (!token) {
        reject(new OvertakeError(ErrorCode.EXTENSION_NOT_CONNECTED, 'No Overtake token found. Run `npm run install:host` and load the extension in Chrome.'));
        return;
      }
      const sockPath = this.#opts.socketPath || paths().socket;
      const sock = net.connect(sockPath);
      let welcomed = false;
      sock.setEncoding('utf8');
      sock.on('connect', () => {
        sock.write(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, token, agentKey: this.agentKey, agentName: this.agentName }) + '\n');
      });
      sock.on('data', (chunk: string) => {
        this.#buf += chunk;
        let nl: number;
        while ((nl = this.#buf.indexOf('\n')) >= 0) {
          const line = this.#buf.slice(0, nl);
          this.#buf = this.#buf.slice(nl + 1);
          if (!line) continue;
          let msg: { t: string } & Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.t === 'welcome') {
            welcomed = true;
            this.#sock = sock;
            resolve();
          } else if (msg.t === 'bye') {
            const err = msg.error as { code: string; message: string };
            reject(new OvertakeError(err.code, err.message));
          } else if (msg.t === 'res') this.#onResponse(msg as unknown as ResponseMessage);
          else if (msg.t === 'evt') this.emit('event', msg.event as AgentEvent);
        }
      });
      sock.on('error', (e: NodeJS.ErrnoException) => {
        if (!welcomed) {
          reject(new OvertakeError(ErrorCode.EXTENSION_NOT_CONNECTED,
            e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
              ? 'The Overtake broker is not running. Open Google Chrome with the Overtake extension loaded (it starts the broker).'
              : `Cannot reach the Overtake broker: ${e.message}`));
        }
      });
      sock.on('close', () => {
        this.#sock = null;
        this.#ready = null;
        this.#buf = '';
        for (const [, p] of this.#pending) {
          clearTimeout(p.timer);
          p.reject(new OvertakeError(ErrorCode.EXTENSION_NOT_CONNECTED, 'Connection to the Overtake broker closed.'));
        }
        this.#pending.clear();
        if (welcomed) this.emit('event', { type: 'extension', connected: false } satisfies AgentEvent);
      });
    }).catch((e) => {
      this.#ready = null;
      throw e;
    });
    return this.#ready;
  }

  #onResponse(msg: ResponseMessage) {
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new OvertakeError(msg.error?.code || ErrorCode.INTERNAL, msg.error?.message || 'Unknown error', msg.error?.data));
  }

  async request<T = unknown>(op: Operation, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this.#closed) throw new OvertakeError(ErrorCode.EXTENSION_NOT_CONNECTED, 'Client closed.');
    await this.connect();
    const sock = this.#sock;
    if (!sock) throw new OvertakeError(ErrorCode.EXTENSION_NOT_CONNECTED, 'Not connected to the Overtake broker.');
    const id = this.#nextId++;
    const t = timeoutMs ?? this.#opts.requestTimeoutMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new OvertakeError(ErrorCode.TIMEOUT, `${op} timed out after ${t} ms.`));
      }, t);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(JSON.stringify({ t: 'req', id, op, args }) + '\n');
    });
  }

  close() {
    this.#closed = true;
    this.#sock?.end();
  }
}
