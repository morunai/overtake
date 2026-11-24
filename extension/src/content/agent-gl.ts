// WebGL renderer for the agent field: one full-viewport fragment shader draws
//   * a drifting light field while the agent owns the page: soft glows that wander along the
//     viewport edges (the halo) and light the dot grid as they pass
//   * the cursor TRAIL (15 recent positions) lighting dots
//   * click RIPPLES that light and displace dots
//   * the soft cursor glow
// The physics (cursor spring, trail samples, ripple times) stay in agent-field.ts.

export interface GLFrame {
  time: number; // seconds, frozen while paused
  width: number; // CSS px
  height: number;
  dpr: number;
  gap: number;
  radius: number;
  ambient: number; // 0..1 ambient presence
  presence: number; // 0..1 overall (cursor glow, trail)
  tone: [number, number, number]; // dot colour (linear 0..1)
  glowTone: [number, number, number];
  haloTone: [number, number, number]; // edge halo colour (brand red, amber when paused)
  lightSurface: boolean;
  cursor: [number, number];
  trail: [number, number, number][]; // x, y, weight (<= 15)
  ripples: [number, number, number][]; // x, y, age seconds (<= 3)
}

const MAX_TRAIL = 15;
const MAX_RIPPLES = 3;

const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;      // CSS px
uniform float uDpr, uTime, uGap, uRadius, uAmbient, uPresence, uLight;
uniform vec3 uTone, uGlowTone, uHalo;
uniform vec2 uCursor;
uniform vec3 uTrail[${MAX_TRAIL}];
uniform vec3 uRipple[${MAX_RIPPLES}];

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// Smooth value noise and a two-octave sum: the slow light field the halo and dots share.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { return 0.65 * vnoise(p) + 0.35 * vnoise(p * 2.03 + 17.0); }

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uDpr - gl_FragCoord.y) / uDpr;
  vec2 cell = floor(p / uGap);
  vec2 c = (cell + 0.5) * uGap;
  float h = hash(cell);

  // Ripples: a ring travelling outward lights the dots and pushes them out.
  float ring = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec3 r = uRipple[i];
    if (r.z < 0.0) continue;
    vec2 dv = c - r.xy;
    float d = length(dv);
    float front = 8.0 + r.z * 200.0;
    float band = exp(-pow((d - front) / 13.0, 2.0)) * exp(-r.z * 2.4) * max(0.0, 1.0 - d / 210.0);
    if (d > 0.0) c += dv / d * band * 3.2 * sin(r.z * 18.0);
    ring = max(ring, band);
  }

  // Trail reveal: strongest sample wins, (1 - d^2)^2 falloff.
  float m = 0.0;
  for (int i = 0; i < ${MAX_TRAIL}; i++) {
    vec3 t = uTrail[i];
    if (t.z <= 0.0) continue;
    vec2 dv = (cell + 0.5) * uGap - t.xy;
    float d2 = dot(dv, dv) / (uRadius * uRadius);
    if (d2 < 1.0) m = max(m, t.z * (1.0 - d2) * (1.0 - d2));
  }

  // Drifting light: broad soft blobs that wander slowly (a few seconds to cross a blob).
  // Keep this field in sync with the Canvas fallback in agent-field.ts.
  vec2 drift = vec2(uTime * 0.21, -uTime * 0.15);
  float blob = smoothstep(0.4, 0.8, fbm(c * 0.0032 + drift + 0.45 * vec2(sin(uTime * 0.5), cos(uTime * 0.41))));
  // A faint travelling crest on top, so the grid always reads as moving.
  float crest = pow(0.5 + 0.5 * sin((c.x * 0.82 + c.y * 0.57) * 0.014 - uTime * 1.9), 3.0);

  // Edge halo: light hugging the viewport edges, concentrated in a few glows that wander along
  // them, with a slow overall breath.
  float edge = min(min(p.x, p.y), min(uRes.x - p.x, uRes.y - p.y));
  float roam = smoothstep(0.38, 0.78, fbm(p * 0.0026 + vec2(-uTime * 0.16, uTime * 0.12)));
  float pulse = 0.82 + 0.18 * sin(uTime * 0.9);
  float halo = exp(-edge / (20.0 + 58.0 * roam)) * (0.07 + 0.93 * roam) * pulse * uAmbient;

  float amb = (0.06 + 0.5 * blob + 0.16 * crest + 0.7 * halo) * (0.72 + 0.28 * h) * uAmbient;

  float lit = max(amb, max(m * (0.7 + 0.9 * h), ring * (0.75 + 0.7 * h)) * uPresence);

  // Small round dots; pointer actions light them a little more prominently.
  float radius = 0.9 + 0.3 * max(m, ring);
  float aa = 0.6 / uDpr;
  float dotMask = 1.0 - smoothstep(radius - aa, radius + aa, length(p - c));
  float a = clamp(lit, 0.0, 1.0) * dotMask * (uLight > 0.5 ? 1.0 : 0.95);

  // Soft glow around the cursor.
  float gd = length(p - uCursor);
  float g = exp(-gd * gd / (2.0 * 58.0 * 58.0)) * 0.17 * uPresence;

  float ha = halo * (uLight > 0.5 ? 0.4 : 0.66);
  vec3 col = uTone * a + uGlowTone * g + uHalo * ha;
  gl_FragColor = vec4(col, clamp(a + g + ha, 0.0, 1.0)); // premultiplied
}`;

export class GLRenderer {
  #gl: WebGLRenderingContext;
  #u: Record<string, WebGLUniformLocation | null> = {};

  static create(canvas: HTMLCanvasElement): GLRenderer | null {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) return null;
    try {
      return new GLRenderer(gl);
    } catch {
      return null;
    }
  }

  constructor(gl: WebGLRenderingContext) {
    this.#gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uRes', 'uDpr', 'uTime', 'uGap', 'uRadius', 'uAmbient', 'uPresence', 'uLight', 'uTone', 'uGlowTone', 'uHalo', 'uCursor', 'uTrail', 'uRipple']) {
      this.#u[n] = gl.getUniformLocation(prog, n);
    }
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
  }

  render(f: GLFrame) {
    const gl = this.#gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (f.ambient <= 0.001 && f.presence <= 0.001) return;
    const u = this.#u;
    gl.uniform2f(u.uRes, f.width, f.height);
    gl.uniform1f(u.uDpr, f.dpr);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uGap, f.gap);
    gl.uniform1f(u.uRadius, f.radius);
    gl.uniform1f(u.uAmbient, f.ambient);
    gl.uniform1f(u.uPresence, f.presence);
    gl.uniform1f(u.uLight, f.lightSurface ? 1 : 0);
    gl.uniform3fv(u.uTone, f.tone);
    gl.uniform3fv(u.uGlowTone, f.glowTone);
    gl.uniform3fv(u.uHalo, f.haloTone);
    gl.uniform2f(u.uCursor, f.cursor[0], f.cursor[1]);
    const trail = new Float32Array(MAX_TRAIL * 3);
    f.trail.slice(-MAX_TRAIL).forEach((t, i) => trail.set(t, i * 3));
    gl.uniform3fv(u.uTrail, trail);
    const rip = new Float32Array(MAX_RIPPLES * 3).fill(-1);
    f.ripples.slice(-MAX_RIPPLES).forEach((r, i) => rip.set(r, i * 3));
    gl.uniform3fv(u.uRipple, rip);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
