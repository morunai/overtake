// Exercise real pixels and animation scheduling in both renderers. No pointer
// events are sent: the field must visibly animate as soon as the agent owns it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { join } from 'node:path';
import { Harness, SITE, sleep } from './harness.ts';

const h = new Harness();
let bundle: string;
const OUT = join(import.meta.dirname, '../../artifacts/field');

before(async () => {
  const built = await build({
    stdin: {
      contents: `import { AgentField } from './extension/src/content/agent-field.ts';
        window.field = new AgentField(document.body);`,
      resolveDir: join(import.meta.dirname, '../..'),
    },
    bundle: true, write: false, format: 'iife', target: 'chrome125',
  });
  bundle = built.outputFiles[0].text;
  await h.start();
});
after(async () => h.stop());

interface Probe {
  webgl: boolean;
  frames: number;
  fingerprint: number;
  alpha: number;
  lit: number;
}

for (const renderer of ['webgl', 'canvas', 'shader-failure'] as const) {
  test(`dot waves animate, freeze, restart and clear (${renderer})`, async () => {
    const { targetId } = await h.browser.send('Target.createTarget', { url: `${SITE}/?field=${renderer}` });
    const { sessionId } = await h.browser.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      await h.browser.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 500, deviceScaleFactor: 1, mobile: false }, sessionId);
      await h.eval(sessionId, `new Promise(resolve => document.readyState === 'complete' ? resolve(true) : addEventListener('load', () => resolve(true), {once:true}))`);
      // Keep the probe entirely in this test page. Intercept the renderer boundary
      // to read the framebuffer immediately after each draw (WebGL clears later).
      await h.eval(sessionId, `(() => {
        const style = document.createElement('style');
        style.textContent = '.field { position:fixed; inset:0; width:100%; height:100%; pointer-events:none; z-index:100; } body { background:#15171d; color:#e8eaf0; } .card { background:#1c1f27; }';
        document.head.append(style);
        const mode = ${JSON.stringify(renderer)};
        const originalContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          if (mode === 'canvas' && type === 'webgl') return null;
          return originalContext.call(this, type, ...args);
        };
        if (mode === 'shader-failure') {
          const original = WebGLRenderingContext.prototype.getShaderParameter;
          WebGLRenderingContext.prototype.getShaderParameter = function(shader, param) {
            return param === this.COMPILE_STATUS ? false : original.call(this, shader, param);
          };
        }
        let dirty = false;
        for (const [proto, method] of [[WebGLRenderingContext.prototype, 'drawArrays'], [CanvasRenderingContext2D.prototype, 'clearRect']]) {
          const original = proto[method];
          proto[method] = function(...args) { const result = original.apply(this, args); dirty = true; return result; };
        }
        window.probe = {frames:0};
        const raf = window.requestAnimationFrame;
        window.requestAnimationFrame = callback => raf.call(window, time => {
          callback(time);
          if (!dirty || !window.field) return;
          dirty = false;
          const canvas = field.canvas, w = canvas.width, height = canvas.height;
          const gl = field.usesWebGL ? canvas.getContext('webgl') : null;
          let pixels;
          if (gl) {
            pixels = new Uint8Array(w * height * 4);
            gl.readPixels(0, 0, w, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          } else pixels = canvas.getContext('2d').getImageData(0, 0, w, height).data;
          let fingerprint = 0, alpha = 0, lit = 0;
          for (let y = 4; y < height; y += 8) for (let x = 4; x < w; x += 8) {
            const a = pixels[((gl ? height - y - 1 : y) * w + x) * 4 + 3];
            fingerprint = (Math.imul(fingerprint, 31) + a) >>> 0;
            alpha += a;
            if (a > 10) lit++;
          }
          probe = {webgl:!!gl, frames:probe.frames + 1, fingerprint, alpha, lit};
        });
      })()`);
      await h.eval(sessionId, bundle);
      await h.eval(sessionId, `field.setSurface(false); field.setVisible(true)`);
      const read = () => h.eval<Probe>(sessionId, 'probe');
      await sleep(1300);
      const first = await read();
      assert.equal(first.webgl, renderer === 'webgl', 'the requested rendering path is available');
      assert.ok(first.lit > 100, 'dots appear before the first pointer action');
      await h.screenshot(sessionId, join(OUT, `${renderer}-wave-a.png`));
      await sleep(450);
      const moving = await read();
      assert.ok(moving.frames > first.frames + 3);
      assert.notEqual(moving.fingerprint, first.fingerprint, 'the actual dot pixels change');
      await h.screenshot(sessionId, join(OUT, `${renderer}-wave-b.png`));

      await h.eval(sessionId, `field.setTone('paused')`);
      await sleep(1400);
      const paused = await read();
      await sleep(200);
      assert.deepEqual(await read(), paused, 'Pause stops drawing and freezes the field');
      await h.eval(sessionId, `field.setTone('agent')`);
      await sleep(500);
      assert.ok((await read()).frames > paused.frames + 3, 'Resume restarts animation');

      await h.browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
      await sleep(1200);
      const reduced = await read();
      assert.ok(reduced.lit > 0, 'reduced motion retains a static presence');
      await sleep(200);
      assert.deepEqual(await read(), reduced, 'reduced motion stops the animation');
      await h.browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, sessionId);
      await sleep(300);
      assert.ok((await read()).frames > reduced.frames + 3, 'changing motion preference wakes an idle field');

      // Light pages use neutral grey so the white field stays legible there.
      await h.eval(sessionId, `document.body.style.background='#f5f6fa'; document.body.style.color='#191b22'; document.querySelectorAll('.card').forEach(c => c.style.background='white'); field.setSurface(true); field.pointer(220, 180, 'mousePressed')`);
      await sleep(60);
      await h.screenshot(sessionId, join(OUT, `${renderer}-light-click.png`));
      await h.eval(sessionId, 'field.setVisible(false)');
      await sleep(1500);
      const hidden = await read();
      assert.equal(hidden.alpha, 0, 'human takeover clears every sampled dot');
      await sleep(200);
      assert.deepEqual(await read(), hidden, 'a hidden field consumes no animation frames');
    } finally {
      await h.browser.send('Target.closeTarget', { targetId });
    }
  });
}

test('the overlay fills the viewport across reserved scrollbar gutters', async () => {
  const a = await h.agent('codex-scrollbar-check');
  const s = await a.call('spaces_create', { name: 'Scrollbar coverage', url: `${SITE}/?gutter=1` });
  try {
    await a.call('browser_wait', { tabId: s.tabId, load: true });
    const session = await h.humanSession('gutter=1');
    await h.eval(session, `(() => {
      const style = document.createElement('style');
      style.textContent = 'html { scrollbar-gutter:stable; overflow:scroll; } ::-webkit-scrollbar { width:14px; height:14px; }';
      document.head.append(style);
      document.body.style.minWidth = (innerWidth + 100) + 'px';
      document.body.style.minHeight = (innerHeight + 100) + 'px';
    })()`);
    for (const size of [{ width: 1280, height: 860 }, { width: 960, height: 720 }]) {
      await h.browser.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false }, session);
      await sleep(100);
      const viewport = await h.eval(session, '({width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth})');
      assert.ok(viewport.clientWidth < viewport.width, 'fixture has a reserved scrollbar gutter');
      for (const cls of ['wrap', 'field', 'edge']) {
        const node = await h.overlayElement(session, n => {
          const i = (n.attributes || []).indexOf('class');
          return i >= 0 && n.attributes[i + 1].split(' ').includes(cls);
        });
        assert.ok(node, `${cls} exists`);
        const { model } = await h.browser.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, session);
        assert.deepEqual(model.border, [0, 0, viewport.width, 0, viewport.width, viewport.height, 0, viewport.height], `${cls} reaches every viewport edge`);
      }
    }
    await a.call('browser_click', { tabId: s.tabId, target: '#btn', label: 'Verify input after resizing' });
    assert.equal(await h.eval(session, 'document.querySelector("#count").dataset.count'), '1');
  } finally {
    await a.call('spaces_close', { spaceId: s.spaceId });
  }
});
