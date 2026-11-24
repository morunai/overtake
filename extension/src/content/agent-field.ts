// Agent presence field: travelling waves, a cursor trail, soft glow and click
// ripples. WebGL and Canvas 2D both animate, including before the first pointer event.
//
// Design:
//   * the dots sit on a FIXED viewport grid (~8 px); the trail reveals them, they
//     do not travel with the cursor
//   * the revealed band lags behind the cursor, brightest in its middle, broken up
//     by per-dot noise ("fragmented"), and splits into separate blobs on fast moves
//   * it fades within ~0.4 s after the cursor stops; a soft glow stays
// Added for the wave: a click sends a ripple through the grid, and dots near the
// moving cursor are displaced by a damped spring, so the mesh visibly gives way.
//
// Cursor coordinates come only from real agent input. The ambient wave has its
// own clock; it freezes on Pause and fades away on human takeover.

import { GLRenderer } from './agent-gl.ts';

export interface FieldOptions {
  /** Grid spacing in CSS px. */
  gap?: number;
  /** Trail reveal radius in CSS px. */
  radius?: number;
  /** Trail samples kept. */
  samples?: number;
}

interface Sample {
  x: number;
  y: number;
  t: number;
  s: number; // strength from speed
}

interface Ripple {
  x: number;
  y: number;
  t: number;
}

interface Dot {
  ox: number; // displacement (spring state)
  oy: number;
  vx: number;
  vy: number;
}

/** Stable per-cell noise in [0,1). */
function hash(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Two-octave value noise, for patchy (not salt-and-pepper) fragmentation. */
function noise(ix: number, iy: number): number {
  const coarse = hash(ix >> 2, iy >> 2);
  return 0.6 * coarse + 0.4 * hash(ix, iy);
}

/** Smooth value noise over the continuous plane (same shape as the shader's vnoise). */
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
const fbm = (x: number, y: number) => 0.65 * vnoise(x, y) + 0.35 * vnoise(x * 2.03 + 17, y * 2.03 + 17);
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export class AgentField {
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D | null = null;
  #gl: GLRenderer | null = null;
  // Ambient "agent is working" field: eased presence and its own clock.
  #ambient = 0;
  #clock = 0;
  #light = false;
  #lastAmbientDraw = 0;
  #pendingRipple: { x: number; y: number; since: number } | null = null;
  /** Called when a deferred click ripple fires (the cursor reached the click point). */
  onArrive: (() => void) | null = null;
  #cursorEl: HTMLElement | null = null;
  #gap: number;
  #radius: number;
  #max: number;
  #dpr = 1;
  #w = 0;
  #h = 0;

  // cursor spring (critically damped toward the latest real coordinate)
  #pos = { x: -200, y: -200 };
  #vel = { x: 0, y: 0 };
  #target = { x: -200, y: -200 };
  #placed = false;

  #trail: Sample[] = [];
  #lastSampleAt = 0;
  #ripples: Ripple[] = [];
  #dots = new Map<number, Dot>();
  #raf = 0;
  #last = 0;
  #visible = false;
  #tone: 'agent' | 'paused' = 'agent';
  #reduced = false;
  #glow = 0; // 0..1 eased presence

  constructor(parent: HTMLElement | ShadowRoot, opts: FieldOptions = {}) {
    this.#gap = opts.gap ?? 8;
    this.#radius = opts.radius ?? 44;
    this.#max = opts.samples ?? 15;
    let canvas = document.createElement('canvas');
    this.#gl = GLRenderer.create(canvas);
    // A canvas that acquired WebGL cannot subsequently acquire a 2D context,
    // including when shader compilation failed. Use a fresh canvas on fallback.
    if (!this.#gl) {
      canvas = document.createElement('canvas');
      this.#ctx = canvas.getContext('2d');
    }
    this.canvas = canvas;
    this.canvas.className = 'field';
    this.canvas.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.canvas);
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    this.#reduced = mq.matches;
    mq.addEventListener?.('change', (e) => {
      this.#reduced = e.matches;
      if (this.#reduced) {
        this.#trail = [];
        this.#ripples = [];
        this.#dots.clear();
        this.#pos = { ...this.#target };
        this.#vel = { x: 0, y: 0 };
      }
      this.#wake();
    });
    addEventListener('resize', () => this.#resize(), { passive: true });
    this.#resize();
  }

  /** The DOM cursor (arrow + label) that follows the simulated position. */
  bindCursor(el: HTMLElement) {
    this.#cursorEl = el;
  }

  get position() {
    return { ...this.#pos };
  }

  setVisible(v: boolean) {
    if (this.#visible === v) return;
    this.#visible = v;
    if (!v) {
      this.#trail = [];
      this.#ripples = [];
    }
    this.#wake();
  }

  /** Light page background: dots switch from near-white to grey to stay legible. */
  setSurface(light: boolean) {
    if (this.#light === light) return;
    this.#light = light;
    this.#wake();
  }

  get usesWebGL() {
    return this.#gl !== null;
  }

  setTone(t: 'agent' | 'paused') {
    if (this.#tone === t) return;
    this.#tone = t;
    this.#wake();
  }

  /** A real agent pointer event at viewport coordinates. */
  pointer(x: number, y: number, kind: string) {
    this.#target = { x, y };
    if (!this.#placed || this.#reduced) {
      // First appearance (or reduced motion): place without a sweep from off-screen.
      this.#pos = { x, y };
      this.#vel = { x: 0, y: 0 };
      this.#placed = true;
    }
    if (kind === 'mousePressed' && !this.#reduced) {
      // The real click can land before the visible cursor finishes its glide (only the final
      // pointer position is sent). Ripple when the cursor arrives, so it reads as move-then-click.
      if (Math.hypot(x - this.#pos.x, y - this.#pos.y) > 14) this.#pendingRipple = { x, y, since: performance.now() };
      else this.#ripples.push({ x, y, t: performance.now() });
    }
    this.#wake();
  }

  /** Whether the visible cursor is still travelling to its last target. */
  get gliding() {
    return Math.hypot(this.#target.x - this.#pos.x, this.#target.y - this.#pos.y) > 14;
  }

  #resize() {
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#w = innerWidth;
    this.#h = innerHeight;
    this.canvas.width = Math.round(this.#w * this.#dpr);
    this.canvas.height = Math.round(this.#h * this.#dpr);
    this.#wake();
  }

  #wake() {
    if (!this.#raf) {
      this.#last = 0;
      this.#raf = requestAnimationFrame((t) => this.#frame(t));
    }
  }

  #frame(now: number) {
    this.#raf = 0;
    const dt = this.#last ? Math.min(0.05, (now - this.#last) / 1000) : 1 / 60;
    this.#last = now;
    const active = this.#step(now, dt);
    const ambientOnly = !this.#trail.length && !this.#ripples.length && this.#vel.x === 0 && this.#vel.y === 0;
    const fading = this.#glow !== (this.#visible ? 1 : 0);
    // Always paint the final state, even if it falls inside the 30 fps throttle.
    // Otherwise takeover can leave the last faint dots on the canvas indefinitely.
    if (!active || fading || !ambientOnly || now - this.#lastAmbientDraw >= 32) {
      this.#lastAmbientDraw = now;
      this.#draw(now);
    }
    if (active) this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  /** Advance physics; returns whether another frame is needed. */
  #step(now: number, dt: number): boolean {
    // Presence fade.
    const goal = this.#visible ? 1 : 0;
    this.#glow += (goal - this.#glow) * (1 - Math.exp(-dt * (goal ? 6 : 9)));
    if (Math.abs(goal - this.#glow) < 0.004) this.#glow = goal;
    // Ambient field: full while the agent drives, dimmed and frozen while paused,
    // gone (fast fade) when the human has the page.
    const animating = this.#visible && this.#tone === 'agent' && !this.#reduced;
    const aGoal = !this.#visible ? 0 : this.#tone === 'paused' ? 0.6 : 1;
    this.#ambient += (aGoal - this.#ambient) * (1 - Math.exp(-dt * (aGoal > this.#ambient ? 3 : 10)));
    if (Math.abs(aGoal - this.#ambient) < 0.003) this.#ambient = aGoal;
    if (animating) this.#clock += dt;

    // Critically damped spring toward the real coordinate (ω = 16 rad/s).
    const w = 16;
    const ax = w * w * (this.#target.x - this.#pos.x) - 2 * w * this.#vel.x;
    const ay = w * w * (this.#target.y - this.#pos.y) - 2 * w * this.#vel.y;
    this.#vel.x += ax * dt;
    this.#vel.y += ay * dt;
    this.#pos.x += this.#vel.x * dt;
    this.#pos.y += this.#vel.y * dt;
    const speed = Math.hypot(this.#vel.x, this.#vel.y);
    const pr = this.#pendingRipple;
    if (pr && (Math.hypot(pr.x - this.#pos.x, pr.y - this.#pos.y) <= 14 || now - pr.since > 600)) {
      this.#ripples.push({ x: pr.x, y: pr.y, t: now });
      this.#pendingRipple = null;
      this.onArrive?.();
    }
    if (speed < 2 && Math.hypot(this.#target.x - this.#pos.x, this.#target.y - this.#pos.y) < 0.3) {
      this.#pos = { ...this.#target };
      this.#vel = { x: 0, y: 0 };
    }

    // Trail samples while moving (the shader reads up to 15 recent positions).
    if (!this.#reduced && this.#visible && speed > 25 && now - this.#lastSampleAt > 18) {
      this.#trail.push({ x: this.#pos.x, y: this.#pos.y, t: now, s: Math.min(1, 0.6 + speed / 1100) });
      if (this.#trail.length > this.#max) this.#trail.shift();
      this.#lastSampleAt = now;
    }
    this.#trail = this.#trail.filter((p) => now - p.t < 700);
    this.#ripples = this.#ripples.filter((r) => now - r.t < 1150);

    if (this.#cursorEl) {
      this.#cursorEl.style.transform = `translate(${this.#pos.x.toFixed(2)}px, ${this.#pos.y.toFixed(2)}px)`;
    }

    // Dot springs settle back to rest.
    let springing = false;
    const k = 220;
    const c = 2 * Math.sqrt(k) * 0.55; // under-damped: a small elastic overshoot
    for (const [key, d] of this.#dots) {
      d.vx += (-k * d.ox - c * d.vx) * dt;
      d.vy += (-k * d.oy - c * d.vy) * dt;
      d.ox += d.vx * dt;
      d.oy += d.vy * dt;
      if (Math.abs(d.ox) + Math.abs(d.oy) + Math.abs(d.vx) * 0.02 + Math.abs(d.vy) * 0.02 < 0.02) this.#dots.delete(key);
      else springing = true;
    }

    return (
      animating ||
      (this.#ambient !== 0 && this.#ambient !== 0.6 && this.#ambient !== 1) ||
      speed > 0 ||
      this.#trail.length > 0 ||
      this.#ripples.length > 0 ||
      springing ||
      (this.#glow !== 0 && this.#glow !== 1)
    );
  }

  /** Trail weight for a sample of age `a` ms: lags the tip, then decays. */
  #weight(p: Sample, now: number): number {
    const a = now - p.t;
    const lag = Math.min(1, a / 55); // a small gap right at the cursor tip
    return p.s * lag * Math.exp(-a / 260);
  }

  #draw(now: number) {
    if (this.#gl) {
      const paused = this.#tone === 'paused';
      const tone: [number, number, number] = paused
        ? (this.#light ? [0.72, 0.45, 0.05] : [1.0, 0.84, 0.55])
        : (this.#light ? [0.56, 0.57, 0.59] : [0.98, 0.98, 0.98]);
      const glowTone: [number, number, number] = paused ? [0.96, 0.7, 0.26] : [0.76, 0.77, 0.79];
      this.#gl.render({
        time: this.#clock,
        width: this.#w,
        height: this.#h,
        dpr: this.#dpr,
        gap: this.#gap,
        radius: this.#radius,
        ambient: this.#reduced ? this.#ambient * 0.6 : this.#ambient,
        presence: this.#placed ? this.#glow : 0,
        tone,
        glowTone,
        haloTone: paused ? [0.96, 0.66, 0.2] : [1.0, 0.22, 0.29],
        lightSurface: this.#light,
        cursor: [this.#pos.x, this.#pos.y],
        trail: this.#reduced ? [] : this.#trail.map((p) => [p.x, p.y, this.#weight(p, now)] as [number, number, number]),
        ripples: this.#reduced ? [] : this.#ripples.map((r) => [r.x, r.y, (now - r.t) / 1000] as [number, number, number]),
      });
      return;
    }
    const ctx = this.#ctx;
    if (!ctx) return;
    const dpr = this.#dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.#w, this.#h);
    if (this.#glow <= 0.001 && this.#ambient <= 0.001) return;
    const paused = this.#tone === 'paused';
    const rgb = paused ? '245,179,66' : '194,196,201';

    // Soft presence glow around the cursor.
    if (this.#placed) {
      const g = ctx.createRadialGradient(this.#pos.x, this.#pos.y, 0, this.#pos.x, this.#pos.y, 120);
      g.addColorStop(0, `rgba(${rgb},${0.2 * this.#glow})`);
      g.addColorStop(0.45, `rgba(${rgb},${0.07 * this.#glow})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(this.#pos.x - 120, this.#pos.y - 120, 240, 240);
    }

    const R = this.#radius;
    const gap = this.#gap;
    const trail = this.#trail.map((p) => ({ p, w: this.#weight(p, now) })).filter((e) => e.w > 0.02);
    const ripples = this.#ripples.map((r) => ({ r, age: (now - r.t) / 1000 }));
    if (!this.#ambient && !trail.length && !ripples.length && !this.#dots.size) return;

    // Bounding box of everything that can light a dot.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number, r: number) => {
      x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
    };
    for (const e of trail) grow(e.p.x, e.p.y, R + 6);
    for (const e of ripples) grow(e.r.x, e.r.y, 40 + e.age * 200);
    if (this.#ambient > 0) {
      x0 = 0; y0 = 0; x1 = this.#w; y1 = this.#h;
    }
    const ix0 = Math.max(0, Math.floor(x0 / gap)), ix1 = Math.min(Math.ceil(this.#w / gap), Math.ceil(x1 / gap));
    const iy0 = Math.max(0, Math.floor(y0 / gap)), iy1 = Math.min(Math.ceil(this.#h / gap), Math.ceil(y1 / gap));
    const speed = Math.hypot(this.#vel.x, this.#vel.y);
    const ambient = this.#ambient * (this.#reduced ? 0.6 : 1);
    ctx.fillStyle = paused
      ? (this.#light ? 'rgb(184,115,13)' : 'rgb(255,214,140)')
      : (this.#light ? 'rgb(143,145,150)' : 'rgb(250,250,250)');

    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const bx = ix * gap + gap / 2;
        const by = iy * gap + gap / 2;
        // Trail reveal: strongest sample wins, smooth (1 - d²)² falloff.
        let m = 0;
        for (const e of trail) {
          const dx = bx - e.p.x, dy = by - e.p.y;
          const d2 = (dx * dx + dy * dy) / (R * R);
          if (d2 < 1) m = Math.max(m, e.w * (1 - d2) * (1 - d2));
        }
        // Ripple: a ring travelling outward; dots on the ring light up and are pushed.
        let ring = 0;
        let push = 0;
        let pdx = 0, pdy = 0;
        for (const e of ripples) {
          const dx = bx - e.r.x, dy = by - e.r.y;
          const d = Math.hypot(dx, dy);
          const front = 8 + e.age * 200;
          const band = Math.exp(-(((d - front) / 13) ** 2)) * Math.exp(-e.age * 2.4) * Math.max(0, 1 - d / 210);
          if (band > ring) {
            ring = band;
            push = band;
            pdx = d ? dx / d : 0;
            pdy = d ? dy / d : 0;
          }
        }
        const n = noise(ix, iy);
        // Same drifting light as the shader (the halo itself is CSS-only in this fallback).
        const t = this.#clock;
        const blob = smooth(0.4, 0.8, fbm(bx * 0.0032 + t * 0.21 + 0.45 * Math.sin(t * 0.5), by * 0.0032 - t * 0.15 + 0.45 * Math.cos(t * 0.41)));
        const crest = (0.5 + 0.5 * Math.sin((bx * 0.82 + by * 0.57) * 0.014 - t * 1.9)) ** 3;
        const amb = (0.06 + 0.5 * blob + 0.16 * crest) * (0.72 + 0.28 * hash(ix, iy)) * ambient;
        const lit = Math.max(amb, Math.max(m * (0.7 + 0.9 * n), ring * (0.75 + 0.7 * n)) * this.#glow);
        const key = iy * 100003 + ix;
        let dot = this.#dots.get(key);
        // Elastic displacement: the moving cursor and ripple fronts kick nearby dots.
        if (push > 0.05 || (m > 0.15 && speed > 120)) {
          if (!dot) {
            dot = { ox: 0, oy: 0, vx: 0, vy: 0 };
            this.#dots.set(key, dot);
          }
          if (push > 0.05) {
            dot.vx += pdx * push * 170 * (1 / 60);
            dot.vy += pdy * push * 170 * (1 / 60);
          }
          if (m > 0.15 && speed > 120) {
            const dx = bx - this.#pos.x, dy = by - this.#pos.y;
            const d = Math.hypot(dx, dy) || 1;
            const f = Math.min(1, speed / 1400) * m * 40 * (1 / 60);
            dot.vx += (dx / d) * f;
            dot.vy += (dy / d) * f;
          }
        }
        if (lit < 0.02) continue;
        const ox = dot ? dot.ox : 0;
        const oy = dot ? dot.oy : 0;
        ctx.globalAlpha = Math.min(1, lit);
        ctx.beginPath();
        ctx.arc(bx + ox, by + oy, 0.9 + 0.3 * Math.max(m, ring), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}
