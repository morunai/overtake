// Chrome native messaging framing: 32-bit native-endian (little-endian on
// supported Macs) length prefix followed by UTF-8 JSON.

import type { Writable } from 'node:stream';

export class NativeReader {
  #buf: Buffer = Buffer.alloc(0);
  #onMessage: (msg: unknown) => void;
  constructor(onMessage: (msg: unknown) => void) {
    this.#onMessage = onMessage;
  }
  push(chunk: Buffer) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    while (this.#buf.length >= 4) {
      const len = this.#buf.readUInt32LE(0);
      if (this.#buf.length < 4 + len) return;
      const body = this.#buf.subarray(4, 4 + len).toString('utf8');
      this.#buf = this.#buf.subarray(4 + len);
      try {
        this.#onMessage(JSON.parse(body));
      } catch {
        /* malformed frame from Chrome is ignored */
      }
    }
  }
}

export function encodeNative(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export function writeNative(out: Writable, msg: unknown) {
  out.write(encodeNative(msg));
}
