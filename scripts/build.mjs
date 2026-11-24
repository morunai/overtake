// Builds the MV3 extension into dist/extension.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
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
  ['extension/src/overview/bg.jpg', 'bg.jpg'],
]) copyFileSync(join(root, src), join(out, dst));

// Toolbar and extension icons: the Overtake mark, pre-rendered at each size.
for (const s of [16, 32, 48, 128]) copyFileSync(join(root, 'extension/icons', `icon${s}.png`), join(out, 'icons', `icon${s}.png`));
console.log('built', out);
