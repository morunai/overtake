// Overtake in-page overlay. Runs in every frame at document_start.
//
// Top frame: closed Shadow DOM in the top layer (popover) with
//   - red glowing frame around the controlled page
//   - agent cursor + click ripples, positioned from real CDP input coordinates
//   - floating dock: status + Take over / Pause / Resume / Stop / Give back
//   - an input blocker (hit-test layer) while the agent is in control
// Every frame: capture-phase listeners that cancel trusted human input while the
// shield is up. During an agent burst the service worker sets `pass`, the host
// becomes `inert` (excluded from hit-testing) so CDP clicks reach the page; Chrome
// itself drops human input during that window (Input.setIgnoreInputEvents).
//
// Fail-open: if the extension disappears or stops answering, the shield removes itself.

interface OverlayState {
  shield: boolean;
  control: string;
  spaceId: number | null;
  spaceName: string;
  ownerName: string | null;
  ownerConnected: boolean;
  statusText: string;
  actionRequired: string | null;
  userReason: string | null;
  inSpace: boolean;
  error: string | null;
  suppressForeignFrames: boolean;
}

import { AgentField } from './agent-field.ts';
import { agentIdentity, AGENT_LOGO } from '../ui/identity.ts';

(() => {
  const w = window as unknown as { __overtakeOverlay?: boolean };
  if (w.__overtakeOverlay) return;
  w.__overtakeOverlay = true;

  const isTop = window === window.top;
  let state: OverlayState | null = null;
  let pass = false;
  let hidden = false;
  let busy = false;
  let alive = true;

  // ---------------------------------------------------------------------------
  // Input blocking (all frames)

  const BLOCKED = [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'touchstart', 'touchend', 'touchmove', 'keydown', 'keyup', 'keypress', 'wheel', 'dragstart', 'drop', 'beforeinput', 'paste', 'cut',
  ];
  let host: HTMLElement | null = null;

  // During an agent burst the top frame keeps filtering: only trusted events that
  // match the permit for the step being dispatched (type + coordinates or key)
  // pass. Subframes cannot see the top frame's permit and pass during bursts;
  // Chrome's own input gate covers them outside the per-step dispatch window.
  let permit: { types: string[]; x?: number; y?: number; key?: string; loose?: string[]; until: number } | null = null;

  function permitted(e: Event): boolean {
    if (!permit || Date.now() > permit.until) return false;
    if (permit.loose?.includes(e.type)) return true;
    if (!permit.types.includes('*') && !permit.types.includes(e.type)) return false;
    if (permit.x !== undefined && 'clientX' in e) {
      const me = e as MouseEvent;
      if (Math.abs(me.clientX - permit.x) > 2 || Math.abs(me.clientY - permit.y!) > 2) return false;
    }
    if (permit.key !== undefined && e instanceof KeyboardEvent && e.key !== permit.key && e.key.toLowerCase() !== permit.key.toLowerCase()) return false;
    return true;
  }

  function onInput(e: Event) {
    if (!alive || !state?.shield || !e.isTrusted) return;
    if (host && e.composedPath().includes(host)) return; // the dock stays usable
    if (pass && (!isTop || permitted(e))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  for (const t of BLOCKED) window.addEventListener(t, onInput, { capture: true, passive: false });

  // ---------------------------------------------------------------------------
  // Top-frame UI
  //
  // Layers (all inside one closed shadow root in the top layer):
  //   .edge     atmospheric edge light            pointer-events: none
  //   .blocker  input shield (hit-test layer)      the ONLY layer that blocks input
  //   canvas    agent field: dot grid, glow        pointer-events: none
  //   .cursor   arrow + action label               pointer-events: none
  //   .dock     floating control dock              interactive
  // Visuals never take part in input gating; the gate is the blocker + listeners above.

  let root: ShadowRoot | null = null;
  const el: Record<string, HTMLElement> = {};
  let field: AgentField | null = null;
  let lastControl = '';

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  /* The host already covers 100vw × 100vh. A second fixed layer would use the
     page's scrollbar-gutter-adjusted viewport and leave an unpainted edge. */
  .wrap { position: absolute; inset: 0; pointer-events: none; --red: 255 61 79; --red-text: 255 128 140; --amber: 245 179 66; --tone: var(--red);
    --ease-out: cubic-bezier(0.22, 1, 0.36, 1); --ease-io: cubic-bezier(0.65, 0, 0.35, 1); --fast: 120ms; --base: 180ms; --slow: 280ms; }
  .wrap.paused { --tone: var(--amber); }

  /* Edge light: a faint static base and hairline. The moving halo is drawn by the field shader. */
  .edge { position: absolute; inset: 0; opacity: 0; transition: opacity 420ms var(--ease-out); pointer-events: none;
    background:
      linear-gradient(to top, rgb(var(--tone) / .1), rgb(var(--tone) / 0) 90px),
      linear-gradient(to right, rgb(var(--tone) / .08), rgb(var(--tone) / 0) 60px),
      linear-gradient(to left, rgb(var(--tone) / .08), rgb(var(--tone) / 0) 60px),
      linear-gradient(to bottom, rgb(var(--tone) / .06), rgb(var(--tone) / 0) 40px);
    box-shadow: inset 0 0 0 1px rgb(var(--tone) / .4), inset 0 0 32px rgb(var(--tone) / .08); }
  .edge::after { content: ""; position: absolute; inset: 0; background: radial-gradient(120% 60% at 50% 105%, rgb(var(--tone) / .08), transparent 60%);
    animation: breathe 5.5s var(--ease-io) infinite; }
  .on .edge { opacity: 1; }
  .busy .edge::after { animation-duration: 2.4s; }
  @keyframes breathe { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }

  .blocker { position: absolute; inset: 0; pointer-events: none; }
  .on .blocker { pointer-events: auto; cursor: default; }

  .field { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* Agent cursor: dark arrow, white outline (legible anywhere), label pill. */
  .cursor { position: absolute; left: 0; top: 0; pointer-events: none; opacity: 0; transition: opacity var(--slow) var(--ease-out); will-change: transform; }
  .cursor.show { opacity: 1; }
  .cursor .arrow { position: absolute; left: -3px; top: -2px; width: 22px; height: 24px; filter: drop-shadow(0 2px 3px rgb(0 0 0 / .35)); transform-origin: 3px 2px; transition: transform var(--fast) var(--ease-out); }
  .cursor.idle .arrow, .cursor.idle .label { animation: bob 2.8s var(--ease-io) infinite; }
  .cursor.press .arrow { transform: scale(.86); }
  @keyframes bob { 0%, 100% { translate: 0 0 } 50% { translate: 0 -2.5px } }
  .label { position: absolute; left: 16px; top: 18px; display: flex; align-items: center; gap: 6px; white-space: nowrap; max-width: 260px;
    padding: 5px 10px 5px 8px; border-radius: 9px; font-size: 12px; font-weight: 550; letter-spacing: -.005em; color: #eef0f6;
    background: rgb(22 23 28 / .92); box-shadow: 0 0 0 1px rgb(255 255 255 / .10), 0 6px 18px rgb(0 0 0 / .28);
    opacity: 0; translate: -4px 0; transition: opacity var(--base) var(--ease-out), translate var(--base) var(--ease-out); }
  .label.show { opacity: 1; translate: 0 0; }
  .label i { width: 6px; height: 6px; border-radius: 50%; background: rgb(var(--tone)); box-shadow: 0 0 8px rgb(var(--tone) / .8); flex: none; }
  .label span { overflow: hidden; text-overflow: ellipsis; }

  /* Dock: a native-feeling floating control panel. Graphite, hairline border, soft shadow. */
  .dock { position: absolute; left: 16px; top: 16px; display: flex; align-items: center; gap: 12px; padding: 12px 12px 12px 8px; min-height: 64px;
    border-radius: 20px; color: #f2f2f4; pointer-events: none; opacity: 0; translate: 0 -8px; scale: .98; transform-origin: top left;
    background: rgb(32 32 35 / .88); backdrop-filter: blur(24px) saturate(1.4); -webkit-backdrop-filter: blur(24px) saturate(1.4);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / .1), inset 0 1px 0 rgb(255 255 255 / .06), 0 2px 6px rgb(0 0 0 / .18), 0 14px 36px rgb(0 0 0 / .34);
    transition: opacity var(--slow) var(--ease-out), translate var(--slow) var(--ease-out), scale var(--slow) var(--ease-out), width var(--slow) var(--ease-io);
    interpolate-size: allow-keywords; max-width: calc(100vw - 16px); }
  .dock.show { opacity: 1; translate: 0 0; scale: 1; pointer-events: auto; }
  .dock.dragging { transition: none; cursor: grabbing; }
  .grip { flex: none; width: 16px; height: 40px; display: grid; place-items: center; border-radius: 6px; color: rgb(255 255 255 / .32); cursor: grab; touch-action: none;
    transition: color var(--fast), background var(--fast); }
  .grip:hover { color: rgb(255 255 255 / .62); }
  .dragging .grip { cursor: grabbing; color: rgb(255 255 255 / .75); }
  .grip svg { width: 6px; height: 12px; }
  .divider { flex: none; width: 1px; height: 28px; margin-right: 2px; background: rgb(255 255 255 / .1); }
  .mark { position: relative; width: 36px; height: 36px; flex: none; display: grid; place-items: center; border-radius: 50%; background: rgb(255 255 255 / .08); }
  .mark svg { width: 18px; height: 18px; color: #ececf0; }
  .mark::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; padding: 3px; opacity: 0; transition: opacity var(--base);
    background: conic-gradient(rgb(var(--tone)) 0 28%, rgb(var(--tone) / 0) 52% 100%);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
  .agent .mark::after { opacity: .95; animation: orbit 2.8s linear infinite; }
  .busy .mark::after { animation-duration: 1.4s; }
  .paused .mark::after { opacity: .9; animation: none; background: rgb(var(--amber) / .9); }
  @keyframes orbit { to { rotate: 360deg } }
  .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin-left: 2px; margin-right: 6px; }
  .t1 { font-size: 14px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap; }
  .t2 { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; color: #9a9aa2; }
  .agent .t2 { color: rgb(var(--red-text)); }
  .paused .t2 { color: rgb(var(--amber)); }
  .need .t2 { color: #ffb36b; }
  /* Live activity shimmer: a light band sweeping across the status text. */
  .busy .t2 { background: linear-gradient(105deg, rgb(var(--red-text)) 40%, #fff 50%, rgb(var(--red-text)) 60%) 100% 0 / 250% 100% no-repeat;
    -webkit-background-clip: text; background-clip: text; color: transparent; animation: sweep 1.9s linear infinite; }
  @keyframes sweep { 0% { background-position: 100% 0 } 70%, 100% { background-position: 0% 0 } }
  .swap .txt, .swap .btns { animation: swap var(--base) var(--ease-out); }
  @keyframes swap { from { opacity: 0; translate: 0 3px } }
  .btns { display: flex; align-items: center; gap: 8px; }
  button { all: unset; box-sizing: border-box; cursor: pointer; height: 40px; padding: 0 20px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    font-size: 13px; font-weight: 600; color: #ececf0; background: rgb(255 255 255 / .07); box-shadow: inset 0 0 0 1px rgb(255 255 255 / .06);
    transition: background var(--fast) var(--ease-out), color var(--fast), scale var(--fast) var(--ease-out); }
  button:hover { background: rgb(255 255 255 / .12); }
  button:active { scale: .97; }
  button:focus-visible { outline: 2px solid rgb(var(--red)); outline-offset: 2px; }
  button.primary { background: #f2f2f4; color: #141416; box-shadow: none; }
  button.primary:hover { background: #fff; }
  button.accent { background: rgb(230 38 58); color: #fff; box-shadow: none; }
  button.accent:hover { background: rgb(245 56 75); }
  button.icon { width: 40px; padding: 0; }
  button.icon svg { width: 14px; height: 14px; }
  button.stop:hover { background: rgb(250 82 82 / .16); color: #ff8f8f; }
  button[hidden] { display: none; }
  @media (prefers-reduced-motion: reduce) { .edge::after, .mark::after, .busy .t2, .cursor.idle .arrow, .cursor.idle .label { animation: none !important; } }
  `;

  const ARROW = `<svg class="arrow" viewBox="0 0 22 24" aria-hidden="true"><path d="M3.2 2.3c-.4-.3-1 0-.9.6l2.3 17.6c.1.6.9.8 1.2.2l3.6-6.2 7.1.2c.6 0 .9-.7.5-1.1Z" fill="#0d0f14" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const ICON_PAUSE = `<svg viewBox="0 0 14 14"><rect x="3" y="2.5" width="2.6" height="9" rx="1" fill="currentColor"/><rect x="8.4" y="2.5" width="2.6" height="9" rx="1" fill="currentColor"/></svg>`;
  const ICON_GRIP = `<svg viewBox="0 0 6 12"><g fill="currentColor"><circle cx="1" cy="1.5" r="1"/><circle cx="5" cy="1.5" r="1"/><circle cx="1" cy="6" r="1"/><circle cx="5" cy="6" r="1"/><circle cx="1" cy="10.5" r="1"/><circle cx="5" cy="10.5" r="1"/></g></svg>`;
  const ICON_STOP = `<svg viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" rx="1.8" fill="currentColor"/></svg>`;

  function buildUi() {
    if (!isTop || host) return;
    host = document.createElement('overtake-overlay');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;color-scheme:normal!important;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="wrap">
        <div class="edge"></div>
        <div class="blocker"></div>
        <div class="cursor">${ARROW}<div class="label"><i></i><span></span></div></div>
        <div class="dock" role="toolbar" aria-label="Agent control">
          <div class="grip" title="Drag to move" aria-hidden="true">${ICON_GRIP}</div>
          <div class="divider" aria-hidden="true"></div>
          <div class="mark"></div>
          <div class="txt"><span class="t1"></span><span class="t2" aria-live="polite"></span></div>
          <div class="btns">
            <button data-a="takeover" class="primary">Take over</button>
            <button data-a="resume" class="primary">Resume</button>
            <button data-a="giveback" class="accent">Give back</button>
            <button data-a="pause" class="icon" title="Pause the agent" aria-label="Pause">${ICON_PAUSE}</button>
            <button data-a="stop" class="icon stop" title="Stop the agent" aria-label="Stop">${ICON_STOP}</button>
            <button data-a="dismissError">Dismiss</button>
          </div>
        </div>
      </div>`;
    for (const k of ['wrap', 'edge', 'blocker', 'cursor', 'dock', 'mark', 't1', 't2', 'label']) el[k] = root.querySelector('.' + k) as HTMLElement;
    el.labelText = el.label.querySelector('span') as HTMLElement;
    // The field canvas sits between the blocker and the cursor.
    field = new AgentField(el.wrap);
    el.wrap.insertBefore(field.canvas, el.cursor);
    field.bindCursor(el.cursor);
    root.querySelector('.btns')!.addEventListener('click', (e) => {
      if (!e.isTrusted) return; // page script cannot press the dock
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      void chrome.runtime.sendMessage({ type: 'overtake:human', action: b.dataset.a! }).catch(() => teardown());
    });
    bindDrag(root.querySelector('.grip') as HTMLElement);
    // Swallow everything that reaches the blocker.
    for (const t of ['pointerdown', 'mousedown', 'click', 'wheel', 'contextmenu', 'dblclick']) {
      el.blocker.addEventListener(t, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
    }
    attachHost();
  }

  // ---------------------------------------------------------------------------
  // Dock dragging: by the grip only, trusted pointer input only, always kept inside the viewport.
  // The position is kept in extension storage (pages cannot read it) so it survives navigation.

  const DOCK_MARGIN = 8;
  const DOCK_KEY = 'overtake.dockPos';
  let dockPos: { x: number; y: number } | null = null;

  function placeDock(x: number, y: number) {
    const d = el.dock;
    if (!d) return;
    const maxX = Math.max(DOCK_MARGIN, innerWidth - d.offsetWidth - DOCK_MARGIN);
    const maxY = Math.max(DOCK_MARGIN, innerHeight - d.offsetHeight - DOCK_MARGIN);
    dockPos = { x: Math.round(Math.min(Math.max(DOCK_MARGIN, x), maxX)), y: Math.round(Math.min(Math.max(DOCK_MARGIN, y), maxY)) };
    d.style.left = `${dockPos.x}px`;
    d.style.top = `${dockPos.y}px`;
  }

  function bindDrag(grip: HTMLElement) {
    try {
      chrome.storage.local.get(DOCK_KEY).then((r) => {
        const p = r?.[DOCK_KEY] as { x?: unknown; y?: unknown } | undefined;
        if (p && typeof p.x === 'number' && typeof p.y === 'number') placeDock(p.x, p.y);
      }).catch(() => {});
    } catch {
      /* extension context gone (reloaded): keep the default position */
    }
    grip.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      e.preventDefault();
      const r = el.dock.getBoundingClientRect();
      const ox = e.clientX - r.left;
      const oy = e.clientY - r.top;
      grip.setPointerCapture(e.pointerId);
      el.dock.classList.add('dragging');
      const move = (ev: PointerEvent) => {
        if (ev.isTrusted) placeDock(ev.clientX - ox, ev.clientY - oy);
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        el.dock.classList.remove('dragging');
        try {
          if (dockPos) void chrome.storage.local.set({ [DOCK_KEY]: dockPos }).catch(() => {});
        } catch {
          /* extension context gone */
        }
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    });
    // Keep the dock reachable when the window shrinks or the dock grows with longer text.
    addEventListener('resize', () => dockPos && placeDock(dockPos.x, dockPos.y));
    el.dock.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'width' && dockPos) placeDock(dockPos.x, dockPos.y);
    });
  }

  function attachHost() {
    if (!host) return;
    const parent = document.documentElement;
    if (!parent) return;
    if (host.parentNode !== parent) parent.appendChild(host);
    syncPopover();
  }

  function syncPopover() {
    if (!host || !host.isConnected) return;
    const want = !!state?.inSpace && (state.shield || state.control !== 'NONE');
    try {
      if (want && !host.matches(':popover-open')) host.showPopover();
      if (!want && host.matches(':popover-open')) host.hidePopover();
    } catch {
      /* popover unsupported in this document (e.g. some XML docs) */
    }
  }

  /** Move above page top-layer content (dialogs, fullscreen) by re-showing. */
  function raise() {
    if (!host || !host.matches(':popover-open')) return;
    try {
      host.hidePopover();
      host.showPopover();
    } catch {
      /* ignore */
    }
  }

  let stoppedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Is the page background light? (transparent backgrounds render white). */
  function pageIsLight(): boolean {
    for (const n of [document.body, document.documentElement]) {
      if (!n) continue;
      const m = getComputedStyle(n).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
      return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]) > 140;
    }
    return true;
  }

  function render() {
    if (!isTop) return;
    if (!state?.inSpace) {
      if (host) {
        el.wrap?.classList.remove('on');
        el.dock?.classList.remove('show');
        field?.setVisible(false);
        el.cursor?.classList.remove('show');
        syncPopover();
      }
      return;
    }
    buildUi();
    attachHost();
    const s = state;
    const wrap = el.wrap;
    const agentDriving = s.control === 'AGENT_CONTROL';
    wrap.classList.toggle('on', s.shield);
    wrap.classList.toggle('agent', agentDriving);
    wrap.classList.toggle('busy', busy && agentDriving);
    wrap.classList.toggle('paused', s.control === 'AGENT_PAUSED');
    wrap.classList.toggle('user', s.control === 'USER_CONTROL' || s.control === 'STOPPED');
    wrap.classList.toggle('need', s.control === 'USER_CONTROL' && s.userReason === 'handoff');
    host!.inert = pass;
    host!.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');

    const who = agentIdentity(s.ownerName);
    el.mark.innerHTML = AGENT_LOGO[who.kind];
    let t1 = who.label;
    let t2 = '';
    const show: Record<string, boolean> = {};
    switch (s.control) {
      case 'AGENT_CONTROL':
        t2 = s.statusText && s.statusText !== 'Starting' ? s.statusText : 'Browsing the web';
        show.takeover = show.pause = show.stop = true;
        break;
      case 'AGENT_PAUSED':
        t2 = 'Paused';
        show.resume = show.stop = true;
        break;
      case 'USER_CONTROL':
        if (s.userReason === 'handoff') {
          t1 = 'Your turn';
          t2 = s.actionRequired || `${who.label} needs your help`;
          show.giveback = s.ownerConnected;
        } else if (s.userReason === 'takeover') {
          t1 = "You're in control";
          t2 = s.ownerConnected ? `${who.label} is waiting` : `${who.label} disconnected`;
          show.giveback = s.ownerConnected;
        } else if (s.userReason === 'agent-disconnected') {
          t1 = "You're in control";
          t2 = `${who.label} disconnected`;
        } else {
          t1 = '';
        }
        break;
      case 'STOPPED':
        t1 = 'Agent stopped';
        t2 = 'You have the page back';
        break;
    }
    if (s.error) {
      t1 = 'Task failed';
      t2 = s.error;
      show.dismissError = true;
    }
    const stateKey = `${s.control}|${s.userReason}|${!!s.error}`;
    if (lastControl && stateKey !== lastControl) {
      el.dock.classList.remove('swap');
      void el.dock.offsetWidth;
      el.dock.classList.add('swap');
    }
    lastControl = stateKey;
    el.t1.textContent = t1;
    el.t2.textContent = t2;
    el.t2.title = t2;
    for (const b of root!.querySelectorAll('button')) (b as HTMLButtonElement).hidden = !show[(b as HTMLElement).dataset.a!];
    // A stop is acknowledged briefly, then the dock gets out of the way.
    if (stoppedTimer) clearTimeout(stoppedTimer);
    el.dock.classList.toggle('show', !!t1);
    if (dockPos) placeDock(dockPos.x, dockPos.y);
    if (s.control === 'STOPPED') stoppedTimer = setTimeout(() => el.dock.classList.remove('show'), 3000);

    field!.setSurface(pageIsLight());
    field!.setVisible(s.shield);
    field!.setTone(s.control === 'AGENT_PAUSED' ? 'paused' : 'agent');
    if (!s.shield) {
      el.cursor.classList.remove('show', 'idle');
      el.label.classList.remove('show');
    }
    syncPopover();
  }

  // ---------------------------------------------------------------------------
  // Cursor (driven by real CDP input coordinates from the service worker)

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let labelTimer: ReturnType<typeof setTimeout> | null = null;

  function moveCursor(x: number, y: number, kind: string, label?: string) {
    if (!isTop || !state?.shield) return;
    buildUi();
    const c = el.cursor;
    c.classList.add('show');
    c.classList.remove('idle');
    field!.pointer(x, y, kind);
    if (kind === 'mousePressed') {
      const press = () => {
        c.classList.add('press');
        setTimeout(() => c.classList.remove('press'), 140);
      };
      // Press the arrow when it arrives, in step with the deferred ripple.
      if (field!.gliding) field!.onArrive = () => { field!.onArrive = null; press(); };
      else press();
    }
    if (label) {
      el.labelText.textContent = label;
      el.label.classList.add('show');
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => el.label.classList.remove('show'), 2600);
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => c.classList.add('idle'), 1200);
  }

  // ---------------------------------------------------------------------------
  // Foreign extension frames
  //
  // Chrome refuses chrome.debugger.attach on a tab containing a frame that belongs
  // to a different extension ("Cannot access a chrome-extension:// URL of different
  // extension"). Password managers and AI sidebars inject such frames into every page.
  // While an agent owns this Space, remove them and keep them out. Only Space tabs are
  // affected; other tabs keep those extensions working.

  const OWN = `chrome-extension://${chrome.runtime.id}/`;
  let frameObserver: MutationObserver | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const observedRoots = new WeakSet<Node>();

  /** Shadow roots, including closed ones (content-script-only API). */
  function shadowOf(el: Element): ShadowRoot | null {
    try {
      return (chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) as ShadowRoot | null) ?? el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  }

  function isForeign(n: Node, inShadow: boolean): boolean {
    if (!(n instanceof HTMLElement)) return false;
    const tag = n.localName;
    if (tag !== 'iframe' && tag !== 'frame' && tag !== 'embed' && tag !== 'object') return false;
    if (host && n.getRootNode() === root) return false; // never our own UI
    const src = (n as HTMLIFrameElement).src || n.getAttribute('src') || (n as HTMLObjectElement).data || '';
    if (src.startsWith('chrome-extension://')) return !src.startsWith(OWN);
    // Extensions also hide frames in (closed) shadow roots and navigate them through
    // contentWindow.location, leaving no src. Such a frame without a web src that is
    // cross-origin to the page is an extension frame.
    if (inShadow && (tag === 'iframe' || tag === 'frame') && !/^(https?|blob|data):/i.test(src)) {
      try {
        void (n as HTMLIFrameElement).contentWindow?.location.href;
        return false; // same-origin (about:blank/srcdoc): a normal frame
      } catch {
        return true;
      }
    }
    return false;
  }

  function purgeIn(rootNode: ParentNode, inShadow = false) {
    for (const f of rootNode.querySelectorAll('iframe, frame, embed, object')) if (isForeign(f, inShadow)) f.remove();
    for (const e of rootNode.querySelectorAll('*')) {
      const sr = shadowOf(e);
      if (!sr || sr === root) continue;
      if (frameObserver && !observedRoots.has(sr)) {
        observedRoots.add(sr);
        frameObserver.observe(sr, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data'] });
      }
      purgeIn(sr, true);
    }
  }

  function syncFrameSuppression() {
    const on = alive && !!state?.suppressForeignFrames;
    if (on && !frameObserver) {
      frameObserver = new MutationObserver((records) => {
        for (const r of records) {
          const inShadow = r.target.getRootNode() instanceof ShadowRoot;
          if (r.type === 'attributes' && isForeign(r.target, inShadow)) (r.target as Element).remove();
          for (const n of r.addedNodes) {
            if (isForeign(n, inShadow)) (n as Element).remove();
            else if (n instanceof Element) {
              const sr = shadowOf(n);
              if (n.firstElementChild || sr) purgeIn(n.parentNode || n, inShadow);
            }
          }
        }
      });
      frameObserver.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data'] });
      purgeIn(document);
      // Shadow roots attached after insertion and location-navigated frames are not
      // observable as mutations: sweep periodically while the agent owns the Space.
      sweepTimer = setInterval(() => purgeIn(document), 400);
    } else if (!on && frameObserver) {
      frameObserver.disconnect();
      frameObserver = null;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging

  function apply(next: OverlayState) {
    const wasShield = !!state?.shield;
    state = next;
    syncFrameSuppression();
    if (!next.shield) pass = false;
    if (next.shield && !wasShield && isTop) raise();
    render();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'overtake:state':
        apply(msg.state);
        sendResponse('ack');
        return false;
      case 'overtake:pass':
        pass = !!msg.pass;
        if (!pass) permit = null;
        if (host) host.inert = pass;
        // Chrome routes input to out-of-process iframes by the hit-test data of the last
        // painted frame, so until a frame without the blocker is painted, agent clicks into a
        // cross-site iframe still land on the blocker. Wait for that frame when there are frames.
        if (pass && host && document.querySelector('iframe')) {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              sendResponse('ack');
            }
          };
          requestAnimationFrame(() => requestAnimationFrame(finish));
          setTimeout(finish, 50);
          return true;
        }
        sendResponse('ack');
        return false;
      case 'overtake:permit':
        permit = { ...msg.permit, until: Date.now() + 1500 };
        sendResponse('ack');
        return false;
      case 'overtake:hidden':
        hidden = !!msg.hidden;
        if (host) host.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
        if (!hidden) {
          sendResponse('ack');
          return false;
        }
        // Let the compositor produce a frame without the overlay before capture.
        {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              sendResponse('ack');
            }
          };
          requestAnimationFrame(() => requestAnimationFrame(finish));
          setTimeout(finish, 80);
        }
        return true;
      case 'overtake:cursor':
        moveCursor(msg.x, msg.y, msg.kind, msg.label);
        return false;
      case 'overtake:purge':
        purgeIn(document);
        sendResponse('ack');
        return false;
      case 'overtake:busy':
        busy = !!msg.busy;
        render();
        return false;
    }
    return false;
  });

  function teardown() {
    if (!alive) return;
    alive = false;
    state = null;
    frameObserver?.disconnect();
    frameObserver = null;
    if (sweepTimer) clearInterval(sweepTimer);
    for (const t of BLOCKED) window.removeEventListener(t, onInput, { capture: true });
    try {
      host?.remove();
    } catch {
      /* ignore */
    }
    host = null;
  }

  function hello() {
    try {
      if (!chrome.runtime?.id) return teardown();
      chrome.runtime.sendMessage({ type: 'overtake:hello' }).then(
        (s: OverlayState | undefined) => {
          if (s) apply(s);
          else if (state?.shield) apply({ ...state, shield: false });
        },
        () => teardown(), // extension reloaded/removed: fail open
      );
    } catch {
      teardown();
    }
  }

  hello();
  // Heartbeat: keeps state honest after service-worker restarts and guarantees
  // the shield cannot outlive the extension.
  setInterval(() => {
    if (alive && state?.inSpace) hello();
  }, 2000);

  if (isTop) {
    // Pages that rewrite the document (document.open, framework hydration) can drop the host.
    const mo = new MutationObserver(() => {
      if (host && state?.inSpace && host.parentNode !== document.documentElement) attachHost();
    });
    const watch = () => document.documentElement && mo.observe(document.documentElement, { childList: true });
    watch();
    document.addEventListener('DOMContentLoaded', () => {
      watch();
      if (state?.inSpace) render();
    });
    // New top-layer content (modal dialogs, fullscreen) would cover the dock: raise again.
    document.addEventListener('fullscreenchange', raise, true);
    document.addEventListener('toggle', (e) => {
      if (e.target !== host && (e as ToggleEvent).newState === 'open') setTimeout(raise, 0);
    }, true);
  }
})();
