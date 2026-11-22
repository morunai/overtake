// Builds the MV3 extension into dist/extension.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'extension');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'icons'), { recursive: true });

const common = { bundle: true, target: 'chrome125', sourcemap: 'linked', logLevel: 'warning', legalComments: 'none' };
await build({ ...common, entryPoints: { background: join(root, 'extension/src/background/main.ts') }, format: 'esm', outdir: out });
await build({ ...common, entryPoints: { overlay: join(root, 'extension/src/content/overlay.ts') }, format: 'iife', outdir: out });
await build({
  ...common,
  entryPoints: { overview: join(root, 'extension/src/overview/overview.ts') },
  format: 'esm',
  outdir: out,
});
for (const [src, dst] of [
  ['extension/manifest.json', 'manifest.json'],
  ['extension/src/overview/overview.html', 'overview.html'],
  ['extension/src/overview/overview.css', 'overview.css'],
]) copyFileSync(join(root, src), join(out, dst));

// --- icons: a glowing blue orb, rendered procedurally (no image dependencies)
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const d = Math.sqrt(dx * dx + dy * dy) / c;
      const hx = x + 0.5 - size * 0.38, hy = y + 0.5 - size * 0.36;
      const h = Math.max(0, 1 - Math.sqrt(hx * hx + hy * hy) / (size * 0.42));
      let r = 66 + 80 * h, g = 99 + 75 * h, b = 235 + 20 * h, a;
      if (d <= 0.78) a = 255;
      else if (d <= 1) { a = Math.round(255 * Math.pow(1 - (d - 0.78) / 0.22, 2) * 0.55); r = 92; g = 124; b = 250; }
      else a = 0;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = Math.min(255, r); raw[i + 1] = Math.min(255, g); raw[i + 2] = Math.min(255, b); raw[i + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [16, 48, 128]) writeFileSync(join(out, 'icons', `icon${s}.png`), png(s));
console.log('built', out);
