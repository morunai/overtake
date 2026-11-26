// Overtake automation engine: turns MCP tool calls into CDP commands for one tab.
// Every browser effect goes through the extension, which enforces ownership,
// control state and the input gate. The engine never fakes DOM events: input is
// CDP Input.* only, and unsupported operations surface as errors.

import { writeFile, mkdir, stat, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrokerClient, requestScope } from './broker-client.ts';
import { buildSnapshot, frameKey, type AXNode, type FrameTree, type RefTarget } from './snapshot.ts';
import { chordSteps, typeSteps } from './keys.ts';
import { OvertakeError, ErrorCode, type AgentEvent, type InputStep, type SpaceSummary } from '../shared/protocol.ts';
import { redactCdp, redactNetworkEntry, redactUrl } from './redact.ts';
import { navigationError } from './navigation-error.ts';

type Json = Record<string, unknown>;

interface NetEntry {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Json;
  responseHeaders?: Json;
  postData?: string;
  hasPostData?: boolean;
  startedAt: number;
  respondedAt?: number;
  endedAt?: number;
  encodedDataLength?: number;
  failed?: string;
  fromCache?: boolean;
  frameId?: string;
  sessionId?: string;
}

interface ConsoleEntry {
  seq: number;
  at: number;
  level: string;
  text: string;
  url?: string;
  line?: number;
  stack?: string;
}

interface InterceptRule {
  id: number;
  urlPattern: string;
  block?: boolean;
  response?: { status: number; headers: Record<string, string>; body: string };
  hits: number;
}

interface TabState {
  tabId: number;
  enabled: boolean;
  enabling: Promise<void> | null;
  net: Map<string, NetEntry>;
  console: ConsoleEntry[];
  events: { seq: number; at: number; method: string; sessionId?: string; params: unknown }[];
  refs: Map<number, RefTarget>;
  cursor: { x: number; y: number } | null;
  children: Map<string, { targetId: string; type: string; url: string }>; // OOPIF sessions
  contexts: Map<string, number>; // frameId -> default execution context id (main session)
  childContexts: Map<string, Map<string, number>>; // per cross-site frame session: frameId -> context id
  shown: { url: string; title: string }; // the url and title the agent last saw in a result
  dialog: { type: string; message: string; defaultPrompt?: string; url: string } | null;
  paused: unknown | null;
  intercepts: InterceptRule[];
  loadWaiters: Set<() => void>;
  lastNavAt: number;
  navRequestedAt: number; // main-frame renderer-initiated navigation requested (link, form, location=)
  lastLoadAt: number; // main-frame load event
  downloadAt: number; // a navigation turned into a download
  mainFrameId: string | null;
  chooserWaiters: Set<(p: { backendNodeId: number; mode: string; sessionId?: string }) => void>;
  tracing: { chunks: string[]; done: ((stream?: string) => void) | null } | null;
}

const MAX_NET = 400;
const MAX_CONSOLE = 400;
const MAX_EVENTS = 1500;

let seq = 0;
let refCounter = 0;
let evalGroup = 0;

/** Refusals that mean "stop now", as opposed to transient page states worth retrying. */
const HARD_STOP = new Set<string>([ErrorCode.USER_IN_CONTROL, ErrorCode.STOPPED, ErrorCode.NOT_OWNER, ErrorCode.SPACE_CLOSED, ErrorCode.TAB_CLOSED, ErrorCode.SPACE_NOT_FOUND, ErrorCode.TAB_NOT_IN_SPACE, ErrorCode.EXTENSION_NOT_CONNECTED, ErrorCode.AGENT_PAUSED_TIMEOUT]);
export function isHardStop(code: string) {
  return HARD_STOP.has(code);
}
function softFail<T>(fallback: T) {
  return (e: unknown): T => {
    if (e instanceof OvertakeError && HARD_STOP.has(e.code)) throw e;
    return fallback;
  };
}

/** CDP errors meaning the page's JS context went away under the call (a navigation or reload). */
const CONTEXT_GONE = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/i;
function contextGone(e: unknown) {
  return e instanceof OvertakeError && !HARD_STOP.has(e.code) && CONTEXT_GONE.test(e.message);
}

/** p, or fallback once ms pass. A local bound: the transport's own timeouts are longer and
 *  only start when the extension dequeues the call. A late result is dropped. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

/** Async mutex per key: one high-level action per space at a time. */
class KeyedMutex {
  #tails = new Map<number, Promise<void>>();
  async run<T>(key: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.#tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export const DEVICES: Record<string, { width: number; height: number; deviceScaleFactor: number; mobile: boolean; userAgent?: string }> = {
  'iPhone 15': { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  'Pixel 8': { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36' },
  iPad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  'Desktop 1440': { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
};

/** Split an element target into its kind: css (default), text= or xpath=. */
function parseSelector(target: string): { kind: 'css' | 'text' | 'xpath'; sel: string } {
  if (target.startsWith('text=')) return { kind: 'text', sel: target.slice(5) };
  if (target.startsWith('xpath=')) return { kind: 'xpath', sel: target.slice(6) };
  if (target.startsWith('css=')) return { kind: 'css', sel: target.slice(4) };
  return { kind: 'css', sel: target };
}

/** Page-side: this document, then the documents of same-origin iframes (also inside open
 *  shadow roots and nested frames), which the page can reach. Cross-site frames run in their
 *  own process and are searched through their own session. */
const FRAME_DOCS = (function frameDocs() {
      const docs: Document[] = [document];
      const walk = (root: Document | ShadowRoot) => {
        for (const e of root.querySelectorAll('*')) {
          if (docs.length > 50) return;
          if (e.shadowRoot) walk(e.shadowRoot);
          if (e.localName === 'iframe' || e.localName === 'frame') {
            let d: Document | null = null;
            try { d = (e as HTMLIFrameElement).contentDocument; } catch { /* cross-origin */ }
            if (d?.documentElement) { docs.push(d); walk(d); }
          }
        }
      };
      walk(document);
      return docs;
    }).toString();

/** Page-side finder shared by actions and browser_wait, over `docs` (FRAME_DOCS): returns the
 *  single match, or { count } when there are none or several. Visible matches in the top
 *  document come first, then visible ones in iframes, then hidden ones anywhere. With `all`,
 *  returns every match in every document. */
const FIND_ELEMENT = (function find(sel: string, kind: string, all: boolean, docs: Document[]) {
      const deepAll = (root: Document | ShadowRoot, css: string): Element[] => {
        const out = [...root.querySelectorAll(css)];
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot) out.push(...deepAll(e.shadowRoot, css));
        return out;
      };
      const inDoc = (doc: Document): Element[] => {
        let m: Element[] = [];
        if (kind === 'css') m = deepAll(doc, sel);
        else if (kind === 'xpath') {
          const r = doc.evaluate(sel, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < r.snapshotLength; i++) { const n = r.snapshotItem(i); if (n && n.nodeType === 1) m.push(n as Element); }
        } else {
          const exact = /^".*"$/.test(sel);
          const want = exact ? sel.slice(1, -1) : sel.replace(/\s+/g, ' ').trim().toLowerCase();
          const norm = (s: string) => (exact ? s.trim() : s.replace(/\s+/g, ' ').trim().toLowerCase());
          const cands = [...doc.querySelectorAll('body *')].filter((e) => e.localName !== 'overtake-overlay' && e.localName !== 'script' && e.localName !== 'style');
          const hit = cands.filter((e) => {
            const txt = norm((e as HTMLElement).innerText ?? e.textContent ?? '');
            const aria = norm(e.getAttribute('aria-label') || (e as HTMLInputElement).value || '');
            return exact ? txt === want || aria === want : txt.includes(want) || aria.includes(want);
          });
          m = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)));
        }
        return m;
      };
      const per = docs.map(inDoc);
      if (all) return per.flat();
      // Visible, and so is every iframe it sits in (as far up as this document can see).
      const shown = (e: Element) => {
        if (!((e as HTMLElement).checkVisibility?.() ?? true)) return false;
        let w: Window | null = e.ownerDocument.defaultView;
        for (let i = 0; i < 30 && w && w !== w.parent; i++) {
          let fe: Element | null = null;
          try { fe = w.frameElement; } catch { /* cross-origin parent */ }
          if (!fe) break;
          if (!(fe as HTMLElement).checkVisibility({ visibilityProperty: true })) return false;
          w = fe.ownerDocument.defaultView;
        }
        return true;
      };
      const topVis = per[0].filter(shown);
      const frameVis = per.slice(1).flat().filter(shown);
      const pick = topVis.length ? topVis : frameVis.length ? frameVis : per.flat();
      if (pick.length === 1) return pick[0];
      return { count: pick.length };
    }).toString();

/** Page-side function: the element is visible, and so is every iframe it sits in (as far up as
 *  its document can see). */
const FRAME_SHOWN_JS = `((e) => {
  if (!e.checkVisibility()) return false;
  let w = e.ownerDocument.defaultView;
  for (let i = 0; i < 30 && w && w !== w.parent; i++) {
    let fe = null;
    try { fe = w.frameElement; } catch {}
    if (!fe) break;
    if (!fe.checkVisibility({ visibilityProperty: true })) return false;
    w = fe.ownerDocument.defaultView;
  }
  return true;
})`;

/** Page-side expression, run in a frame's own context: whether the top document reaches this
 *  frame's document (FRAME_DOCS covers it), that is, every frame up to the top is same-origin. */
const REACHABLE_FROM_TOP = `(() => { let w = window; for (let i = 0; i < 30 && w !== top; i++) { if (!w.frameElement) return false; w = w.parent; } return w === top; })()`;

/** Whether a CDP error means the frame or its context is gone (as opposed to slow or failing). */
function frameGone(e: unknown) {
  return /Cannot find context|No frame|Session with given id not found|not found|detached|closed/i.test(String((e as Error)?.message ?? e));
}

/** Page-side expression: the single match for a selector as a node, or "count:N". */
function finderExpr(sel: string, kind: string, ownDocOnly = false) {
  return `(() => { const r = (${FIND_ELEMENT})(${JSON.stringify(sel)}, ${JSON.stringify(kind)}, false, ${ownDocOnly ? '[document]' : `(${FRAME_DOCS})()`}); return r && r.nodeType ? r : 'count:' + r.count; })()`;
}

/** A document the top document's script cannot reach, to search on its own. */
type OtherDoc = { sid?: string; contextId?: number; guard: boolean; targetId?: string; url?: string };

/** Page-side: the focused element, followed into open shadow roots and same-origin iframes.
 *  Returns { remote: true } when focus is inside a frame this document cannot reach
 *  (cross-site), and then `op` runs on the element: 'clear' selects an editable field's
 *  contents (true if it did), 'value' reads an editable field's value (null otherwise, capped,
 *  and only the length for a password). */
const FOCUSED_OP = (function focused(op: string) {
      let e: Element | null = document.activeElement;
      for (let i = 0; e && i < 30; i++) {
        const sr = (e as HTMLElement).shadowRoot;
        if (sr?.activeElement) { e = sr.activeElement; continue; }
        if (e.localName === 'iframe' || e.localName === 'frame') {
          let d: Document | null = null;
          try { d = (e as HTMLIFrameElement).contentDocument; } catch { /* cross-origin */ }
          if (!d) return { remote: true };
          e = d.activeElement;
          continue;
        }
        break;
      }
      if (!e) return { result: op === 'clear' ? false : null };
      const d = e.ownerDocument;
      const field = e.localName === 'input' || e.localName === 'textarea';
      const editable = field || (e as HTMLElement).isContentEditable;
      if (!editable || e === d.body && !(e as HTMLElement).isContentEditable) return { result: op === 'clear' ? false : null };
      if (op === 'clear') {
        if (field) (e as HTMLInputElement).select();
        else {
          const r = d.createRange();
          r.selectNodeContents(e);
          const s = d.defaultView!.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
        }
        return { result: true };
      }
      if (field && (e as HTMLInputElement).type === 'password') return { result: `(password, ${(e as HTMLInputElement).value.length} chars)` };
      const v = field ? (e as HTMLInputElement).value : (e as HTMLElement).innerText;
      return { result: v.length > 200 ? v.slice(0, 200) + `…(+${v.length - 200} chars)` : v };
    }).toString();

/** A long URL shortened for a receipt: apps that keep state in the URL make them very long.
 *  The full one is in location.href (browser_evaluate) or browser_tabs. */
export function capUrl(url: string, max = 300): string {
  return url.length > max ? `${url.slice(0, max)}…(+${url.length - max} chars)` : url;
}

/** Whether a request still counts as in flight for idle checks. Chrome never reports
 *  loadingFinished for some requests that did get a response (fetch with keepalive, as
 *  analytics and event beacons use), so a response more than a moment old counts as done. */
type DomSnap = { strings: string[]; documents: { nodes: { backendNodeId: number[]; attributes?: number[][] }; layout: { nodeIndex: number[]; bounds: number[][] } }[] };

/** Elements with draggable="true" in the snapshot's documents (the main page and same-process
 *  frames): native drag sources, which the accessibility tree does not mark. */
function draggableNodes(snap: DomSnap): Set<number> {
  const out = new Set<number>();
  for (const doc of snap.documents) {
    const attrs = doc.nodes.attributes || [];
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      for (let j = 0; j + 1 < a.length; j += 2) {
        if (snap.strings[a[j]] === 'draggable' && snap.strings[a[j + 1]] === 'true') out.add(doc.nodes.backendNodeId[i]);
      }
    }
  }
  return out;
}

/** A URL for an action receipt, shown without being asked for: no credentials, no query
 *  values (they can carry OAuth codes or tokens under any name), no fragment. Query names stay,
 *  for context; browser_network has the full (redacted) details. */
export function receiptUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.hash = '';
    const names = [...new Set([...u.searchParams.keys()])];
    u.search = '';
    const q = names.length ? '?' + names.map((n) => `${encodeURIComponent(n)}=…`).join('&') : '';
    return (u.toString() + q).slice(0, 200);
  } catch {
    return raw.split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//').slice(0, 200);
  }
}

/** Page-side helpers for waitForText (inlined into page expressions): shown(el) is rendered
 *  and visible; roots() is the document plus open shadow roots and same-origin iframe documents,
 *  skipping hidden iframes; count(text) is the number of visible copies across them. */
const VISIBLE_TEXT_JS = `
  const shown = (el) => !!el && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }));
  const roots = () => {
    const out = [document];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (out.length > 200) return;
        if (el.shadowRoot) { out.push(el.shadowRoot); walk(el.shadowRoot); }
        if (el.localName === 'iframe' && shown(el)) { try { const d = el.contentDocument; if (d) { out.push(d); walk(d); } } catch {} }
      }
    };
    walk(document);
    return out;
  };
  const visibleText = (root) => root.nodeType === 9 ? (root.body?.innerText || '')
    : [...root.childNodes].map((n) => n.nodeType === 3 ? (shown(root.host) ? n.data : '') : n.nodeType === 1 && shown(n) ? (n.innerText ?? '') : '').join('\\n');
  const count = (text) => {
    let n = 0;
    for (const r of roots()) {
      const t = visibleText(r);
      for (let i = t.indexOf(text); i >= 0; i = t.indexOf(text, i + text.length)) n++;
    }
    return n;
  };`;

function inFlight(e: NetEntry, now: number) {
  if (e.endedAt) return false;
  if (e.respondedAt) return now - e.respondedAt < 150;
  return now - e.startedAt < 30_000;
}

export class Engine {
  readonly client: BrokerClient;
  #tabs = new Map<number, TabState>();
  #spaces = new Map<number, SpaceSummary>();
  #mutex = new KeyedMutex();
  #controlWaiters = new Set<() => void>();
  #tabSpace = new Map<number, number>();
  /** Why a tab left its Space, from the extension's close events (see rememberGone there). */
  #gone = new Map<number, { code: string; message: string }>();

  constructor(client: BrokerClient) {
    this.client = client;
    client.on('event', (e: AgentEvent) => this.#onEvent(e));
  }

  // -------------------------------------------------------------------------
  // Events

  #tab(tabId: number): TabState {
    let t = this.#tabs.get(tabId);
    if (!t) {
      t = {
        tabId, enabled: false, enabling: null, net: new Map(), console: [], events: [], refs: new Map(), cursor: null, children: new Map(),
        contexts: new Map(), childContexts: new Map(), shown: { url: '', title: '' }, dialog: null, paused: null, intercepts: [], loadWaiters: new Set(), lastNavAt: 0, navRequestedAt: 0, lastLoadAt: 0, downloadAt: 0, mainFrameId: null, chooserWaiters: new Set(), tracing: null,
      };
      this.#tabs.set(tabId, t);
    }
    return t;
  }

  /** Authoritative membership from the extension: an earlier "gone" reason no longer applies. */
  #joined(tabId: number, spaceId: number) {
    this.#tabSpace.set(tabId, spaceId);
    this.#gone.delete(tabId);
  }

  #listeners = new Set<(e: AgentEvent) => void>();

  /** Observe broker events (after the engine has applied them). Returns an unsubscribe. */
  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Why this agent can no longer drive the Space, from the latest known state; null while it
   *  can (a pause only queues commands). */
  controlLost(spaceId: number): OvertakeError | null {
    const s = this.#spaces.get(spaceId);
    if (!s) return new OvertakeError(ErrorCode.SPACE_CLOSED, `Space ${spaceId} was closed.`);
    if (s.control === 'AGENT_PAUSED' && s.owner === this.client.agentKey) return null;
    if (s.owner !== this.client.agentKey || s.control !== 'AGENT_CONTROL') return this.#lostControl(s);
    return null;
  }

  /** True while the human has paused this agent in the Space (its commands queue). */
  isPaused(spaceId: number) {
    return this.#spaces.get(spaceId)?.control === 'AGENT_PAUSED';
  }

  #onEvent(e: AgentEvent) {
    this.#applyEvent(e);
    for (const fn of this.#listeners) {
      try {
        fn(e);
      } catch {
        /* a listener must not break event handling */
      }
    }
  }

  #applyEvent(e: AgentEvent) {
    switch (e.type) {
      case 'control':
        this.#spaces.set(e.space.spaceId, e.space);
        for (const tab of e.space.tabs) this.#joined(tab.tabId, e.space.spaceId);
        if (e.space.control === 'AGENT_CONTROL' && e.space.owner === this.client.agentKey) {
          // Interception is lifted while the human drives; restore it on return.
          for (const tab of e.space.tabs) {
            const t = this.#tabs.get(tab.tabId);
            if (t?.intercepts.length) void this.#applyFetch(t).catch(() => {});
          }
        }
        for (const w of this.#controlWaiters) w();
        return;
      case 'space-closed':
        this.#spaces.delete(e.spaceId);
        for (const [tabId, spaceId] of this.#tabSpace) {
          if (spaceId !== e.spaceId) continue;
          this.#tabSpace.delete(tabId);
          if (!this.#gone.has(tabId)) this.#gone.set(tabId, { code: ErrorCode.SPACE_CLOSED, message: e.reason || `Space ${e.spaceId} was closed.` });
        }
        for (const w of this.#controlWaiters) w();
        return;
      case 'tab-closed':
        this.#tabSpace.delete(e.tabId);
        // The latest close is the truth for this tab (it may have rejoined a Space since an older reason).
        this.#gone.set(e.tabId, { code: e.code || ErrorCode.TAB_CLOSED, message: e.reason || `Tab ${e.tabId} was closed.` });
      // falls through
      case 'debugger-attached':
      case 'debugger-detached': {
        const t = this.#tabs.get(e.tabId);
        if (t) {
          t.enabled = false;
          t.children.clear();
          t.contexts.clear();
          t.childContexts.clear();
          if (e.type === 'tab-closed') this.#tabs.delete(e.tabId);
        }
        return;
      }
      case 'extension':
        for (const t of this.#tabs.values()) t.enabled = false;
        return;
      case 'cdp':
        this.#onCdp(e.tabId, e.sessionId, e.method, e.params as Json);
        return;
    }
  }

  #onCdp(tabId: number, sessionId: string | undefined, method: string, p: Json) {
    const t = this.#tab(tabId);
    t.events.push({ seq: ++seq, at: Date.now(), method, sessionId, params: p });
    if (t.events.length > MAX_EVENTS) t.events.splice(0, t.events.length - MAX_EVENTS);
    switch (method) {
      case 'Network.requestWillBeSent': {
        const req = p.request as Json;
        const id = p.requestId as string;
        const prev = t.net.get(id);
        t.net.set(id, {
          ...(prev || {}),
          requestId: id, url: req.url as string, method: req.method as string, type: p.type as string, requestHeaders: req.headers as Json,
          hasPostData: !!req.hasPostData, postData: req.postData as string | undefined, startedAt: Date.now(), frameId: p.frameId as string, sessionId,
        });
        if (t.net.size > MAX_NET) t.net.delete(t.net.keys().next().value!);
        break;
      }
      case 'Network.responseReceived': {
        const e = t.net.get(p.requestId as string);
        const r = p.response as Json;
        if (e) Object.assign(e, { respondedAt: Date.now(), status: r.status, statusText: r.statusText, mimeType: r.mimeType, responseHeaders: r.headers, fromCache: !!r.fromDiskCache || !!r.fromServiceWorker });
        break;
      }
      case 'Network.loadingFinished': {
        const e = t.net.get(p.requestId as string);
        if (e) Object.assign(e, { endedAt: Date.now(), encodedDataLength: p.encodedDataLength });
        break;
      }
      case 'Network.loadingFailed': {
        const e = t.net.get(p.requestId as string);
        if (e) Object.assign(e, { endedAt: Date.now(), failed: (p.errorText as string) + (p.blockedReason ? ` (${p.blockedReason})` : '') });
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const args = (p.args as Json[]) || [];
        const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description as string) || (a.type as string))).join(' ');
        const top = ((p.stackTrace as Json)?.callFrames as Json[] | undefined)?.[0];
        this.#pushConsole(t, { level: p.type as string, text, url: top?.url as string, line: top ? (top.lineNumber as number) + 1 : undefined });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails as Json;
        const ex = d.exception as Json | undefined;
        const frames = ((d.stackTrace as Json)?.callFrames as Json[]) || [];
        this.#pushConsole(t, {
          level: 'exception',
          text: (ex?.description as string) || (d.text as string),
          url: d.url as string,
          line: typeof d.lineNumber === 'number' ? d.lineNumber + 1 : undefined,
          stack: frames.slice(0, 8).map((f) => `  at ${f.functionName || '<anonymous>'} (${f.url}:${(f.lineNumber as number) + 1}:${(f.columnNumber as number) + 1})`).join('\n'),
        });
        break;
      }
      case 'Log.entryAdded': {
        const en = p.entry as Json;
        this.#pushConsole(t, { level: `log.${en.level}`, text: en.text as string, url: en.url as string, line: typeof en.lineNumber === 'number' ? en.lineNumber + 1 : undefined });
        break;
      }
      case 'Runtime.executionContextCreated': {
        const c = p.context as Json;
        const aux = c.auxData as Json | undefined;
        // Context ids are per session (cross-site frames have their own).
        if (aux?.isDefault && typeof aux.frameId === 'string') {
          if (!sessionId) t.contexts.set(aux.frameId, c.id as number);
          else {
            if (!t.childContexts.has(sessionId)) t.childContexts.set(sessionId, new Map());
            t.childContexts.get(sessionId)!.set(aux.frameId, c.id as number);
          }
        }
        break;
      }
      case 'Runtime.executionContextDestroyed':
        {
          const m = sessionId ? t.childContexts.get(sessionId) : t.contexts;
          if (m) for (const [f, id] of m) if (id === p.executionContextId) m.delete(f);
        }
        break;
      case 'Runtime.executionContextsCleared':
        if (!sessionId) t.contexts.clear();
        else t.childContexts.delete(sessionId);
        break;
      case 'Target.attachedToTarget': {
        const info = p.targetInfo as Json;
        t.children.set(p.sessionId as string, { targetId: info.targetId as string, type: info.type as string, url: info.url as string });
        // Bring OOPIF sessions to parity with the main session.
        const sid = p.sessionId as string;
        for (const m of ['Runtime.enable', 'Network.enable', 'Page.enable']) void this.cdp(tabId, m, {}, sid).catch(() => {});
        break;
      }
      case 'Target.detachedFromTarget':
        t.children.delete(p.sessionId as string);
        t.childContexts.delete(p.sessionId as string);
        break;
      case 'Page.frameNavigated': {
        const frame = p.frame as Json;
        if (!frame.parentId && !sessionId) {
          t.refs.clear();
          t.lastNavAt = Date.now();
          t.mainFrameId = frame.id as string;
        }
        break;
      }
      case 'Page.frameRequestedNavigation':
        // Sent while the click is being dispatched, before the input reply arrives,
        // so a click knows at once whether it started a navigation.
        if (!sessionId && (p.disposition ?? 'currentTab') === 'currentTab' && (!t.mainFrameId || p.frameId === t.mainFrameId)) t.navRequestedAt = Date.now();
        break;
      case 'Page.loadEventFired':
        if (!sessionId) {
          t.lastLoadAt = Date.now();
          for (const w of t.loadWaiters) w();
        }
        break;
      case 'Page.downloadWillBegin':
        if (!sessionId) t.downloadAt = Date.now();
        break;
      case 'Page.fileChooserOpened':
        for (const w of [...t.chooserWaiters]) w({ backendNodeId: p.backendNodeId as number, mode: p.mode as string, sessionId });
        break;
      case 'Page.javascriptDialogOpening':
        t.dialog = { type: p.type as string, message: p.message as string, defaultPrompt: p.defaultPrompt as string, url: p.url as string };
        break;
      case 'Page.javascriptDialogClosed':
        t.dialog = null;
        break;
      case 'Debugger.paused':
        t.paused = p;
        break;
      case 'Debugger.resumed':
        t.paused = null;
        break;
      case 'Fetch.requestPaused':
        void this.#onRequestPaused(t, sessionId, p);
        break;
      case 'Tracing.dataCollected':
        t.tracing?.chunks.push(...((p.value as unknown[]) || []).map((v) => JSON.stringify(v)));
        break;
      case 'Tracing.tracingComplete':
        t.tracing?.done?.(p.stream as string | undefined);
        break;
    }
  }

  #pushConsole(t: TabState, e: Omit<ConsoleEntry, 'seq' | 'at'>) {
    t.console.push({ seq: ++seq, at: Date.now(), ...e });
    if (t.console.length > MAX_CONSOLE) t.console.splice(0, t.console.length - MAX_CONSOLE);
  }

  // -------------------------------------------------------------------------
  // Transport helpers

  cdp<T = Json>(tabId: number, method: string, params: Json = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    return this.client.request<T>('cdp', { tabId, method, params, ...(sessionId ? { sessionId } : {}), ...(timeoutMs ? { deadlineMs: timeoutMs } : {}) }, timeoutMs ? timeoutMs + 5000 : undefined);
  }

  async ensureTab(tabId: number): Promise<TabState> {
    const t = this.#tab(tabId);
    if (t.enabled) return t;
    if (!t.enabling) {
      // Shared by every caller on this tab, so it runs outside any one run's scope.
      t.enabling = requestScope.exit(() => (async () => {
        await this.cdp(tabId, 'Page.enable');
        await this.cdp(tabId, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
        await this.cdp(tabId, 'Runtime.enable');
        await this.cdp(tabId, 'Network.enable', { maxPostDataSize: 65536 });
        await this.cdp(tabId, 'Log.enable').catch(() => {});
        t.enabled = true;
      })()).finally(() => {
        t.enabling = null;
      });
    }
    await t.enabling;
    return t;
  }

  async spaceOf(tabId: number): Promise<number> {
    const known = this.#tabSpace.get(tabId);
    if (known !== undefined) return known;
    const { spaces } = await this.client.request<{ spaces: SpaceSummary[] }>('spaces.list');
    for (const s of spaces) {
      this.#spaces.set(s.spaceId, s);
      for (const tab of s.tabs) this.#joined(tab.tabId, s.spaceId);
    }
    const id = this.#tabSpace.get(tabId);
    if (id === undefined) {
      const g = this.#gone.get(tabId);
      if (g) throw new OvertakeError(g.code, `${g.message} Tab ${tabId} is gone; check spaces_list or create a new Space if the user wants you to continue.`);
      throw new OvertakeError(ErrorCode.TAB_NOT_IN_SPACE, `Tab ${tabId} is not in a Space.`);
    }
    return id;
  }

  /** Run one high-level action exclusively for the tab's space. */
  async action<T>(tabId: number, fn: (t: TabState) => Promise<T>): Promise<T> {
    const spaceId = await this.spaceOf(tabId);
    return this.#mutex.run(spaceId, async () => fn(await this.ensureTab(tabId)));
  }

  // -------------------------------------------------------------------------
  // Spaces

  async listSpaces(): Promise<SpaceSummary[]> {
    const { spaces } = await this.client.request<{ spaces: SpaceSummary[] }>('spaces.list');
    for (const s of spaces) {
      this.#spaces.set(s.spaceId, s);
      for (const tab of s.tabs) this.#joined(tab.tabId, s.spaceId);
    }
    return spaces;
  }

  async waitForControl(spaceId: number, timeoutMs: number): Promise<{ inControl: boolean; space: SpaceSummary | null }> {
    const deadline = Date.now() + timeoutMs;
    await this.listSpaces();
    for (;;) {
      const s = this.#spaces.get(spaceId) || null;
      if (!s) return { inControl: false, space: null };
      if (s.control === 'AGENT_CONTROL' && s.owner === this.client.agentKey) return { inControl: true, space: s };
      const left = deadline - Date.now();
      if (left <= 0) return { inControl: false, space: s };
      await new Promise<void>((resolve) => {
        const done = () => {
          this.#controlWaiters.delete(done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, Math.min(left, 15_000));
        this.#controlWaiters.add(done);
      });
      if (Date.now() < deadline) await this.listSpaces().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Navigation and waiting

  async navigate(tabId: number, url: string, opts: { timeoutMs?: number; waitUntil?: 'load' | 'commit' | 'none'; waitFor?: string } = {}) {
    return this.action(tabId, async (t) => {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const started = Date.now();
      const loaded = new Promise<boolean>((resolve) => {
        const w = () => {
          t.loadWaiters.delete(w);
          resolve(true);
        };
        t.loadWaiters.add(w);
        setTimeout(() => {
          t.loadWaiters.delete(w);
          resolve(false);
        }, timeoutMs);
      });
      let r: { frameId: string; loaderId?: string; errorText?: string };
      try {
        r = await this.cdp<{ frameId: string; loaderId?: string; errorText?: string }>(tabId, 'Page.navigate', { url }, undefined, timeoutMs + 5000);
      } catch (e) {
        // Chrome's error and warning pages (such as the certificate interstitial) cannot be
        // driven over CDP, so leave them through the tabs API instead.
        if (!/cannot attach to this target/i.test((e as Error).message) || !/^https?:\/\//i.test(url)) throw e;
        await this.client.request('tabs.navigate', { tabId, url });
        r = { frameId: '', loaderId: 'tabs-api' };
      }
      if (r.errorText) throw navigationError(url, r.errorText);
      let didLoad = false;
      if (r.loaderId === 'tabs-api') {
        // Load events from the warning page are unreliable here; poll until the new page is up.
        didLoad = await this.#pollLoaded(tabId, url, timeoutMs);
      } else if (opts.waitUntil !== 'none' && opts.waitUntil !== 'commit' && r.loaderId) {
        didLoad = await Promise.race([loaded, this.#pollLoaded(tabId, url, timeoutMs)]);
      }
      const isLoaded = didLoad || !r.loaderId;
      if (opts.waitFor) {
        // Same action (and Space lock) as the navigation, so no other call can navigate in between.
        // One budget: timeoutMs covers the navigation and the wait together.
        const left = timeoutMs - (Date.now() - started);
        if (left <= 0) throw new OvertakeError(ErrorCode.TIMEOUT, `Navigation used the whole ${timeoutMs} ms; ${opts.waitFor} was not checked.`);
        const w = await this.#waitIn(t, { selector: opts.waitFor, state: 'visible', timeoutMs: left });
        if (w.url !== undefined) this.#saw(t, { url: w.url, title: w.title ?? '' });
        return { url: w.url, title: w.title, readyState: w.readyState, loaded: isLoaded, sameDocument: !r.loaderId, found: opts.waitFor };
      }
      const info = await this.pageInfo(tabId);
      this.#saw(t, info);
      return { ...info, loaded: isLoaded, sameDocument: !r.loaderId };
    });
  }

  /** Poll readyState: survives a dropped/re-attached debugger session, where the
   *  load event can be lost. Resolves false on timeout. */
  async #pollLoaded(tabId: number, url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const target = url.split('#')[0];
    await sleep(150);
    while (Date.now() < deadline) {
      const r = await this.cdp<{ result: { value?: { href: string; state: string } } }>(tabId, 'Runtime.evaluate', {
        expression: '({ href: location.href, state: document.readyState })', returnByValue: true,
      }, undefined, 5000).catch(softFail(null));
      const v = r?.result.value;
      if (v && v.state === 'complete' && (v.href.split('#')[0] === target || !target.startsWith('http'))) return true;
      await sleep(250);
    }
    return false;
  }

  /** Let the page finish reacting to an action before it is observed: wait until requests
   *  started since `since` have finished and the DOM has been quiet for `quietMs`, at most
   *  `maxMs`. Pages commonly fetch and render a moment after a click, and a snapshot taken
   *  at once shows the old state. Best-effort: never throws. Polled from here, not with page
   *  timers, which background throttling can stretch. */
  async settle(tabId: number, since: number, { quietMs = 120, maxMs = 1500 } = {}) {
    const t = this.#tabs.get(tabId);
    const deadline = since + maxMs;
    const watch = `(() => { let last = performance.now(); const mo = new MutationObserver(() => { last = performance.now(); });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      return { idle: () => performance.now() - last, stop: () => mo.disconnect() }; })()`;
    const obs = await this.cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.evaluate', { expression: watch }, undefined, 2000).catch(() => null);
    const objectId = obs?.result.objectId;
    try {
      while (Date.now() < deadline) {
        const now = Date.now();
        const busy = t && [...t.net.values()].some((e) => e.startedAt >= since && e.type !== 'EventSource' && e.type !== 'WebSocket' && inFlight(e, now));
        if (!busy) {
          if (!objectId) break;
          const r = await this.cdp<{ result: { value?: number } }>(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return this.idle(); }', returnByValue: true }, undefined, 1000).catch(() => null);
          if (r?.result.value === undefined || r.result.value >= quietMs) break; // quiet, or the document went away
        }
        await sleep(Math.max(10, Math.min(30, deadline - now)));
      }
    } finally {
      if (objectId) {
        void this.cdp(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { this.stop(); }' }).catch(() => {});
        void this.cdp(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
  }

  /** Start watching for text that appears because of what happens from now on. The page
   *  counts the visible copies of the text (innerText, across open shadow roots and same-origin
   *  iframes, found afresh at every check); the text is seen once there are more than at their
   *  lowest since the watch began. So a "Saved" already on the page does not count, but
   *  "Saved", "Saving...", "Saved" does, as does text split across elements or revealed by a
   *  style change. A mutation observer also catches visible text re-added between two checks.
   *  The watch stops itself after ttlMs, in case unwatchText cannot run. */
  async watchText(tabId: number, text: string, ttlMs: number): Promise<string> {
    return this.action(tabId, async () => {
      const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const expr = `(() => { const text = ${JSON.stringify(text)}; const id = ${JSON.stringify(id)};
        const w = (window.__overtakeWatch ||= {});
        ${VISIBLE_TEXT_JS}
        const has = (node) => {
          // The matching text itself must be rendered: innerText leaves out hidden descendants.
          if (node.nodeType === 3) return node.data.includes(text) && shown(node.parentElement ?? node.parentNode?.host);
          return node.nodeType === 1 && shown(node) && (node.innerText ?? '').includes(text);
        };
        const entry = { seen: false, low: 0 };
        const observers = [];
        // Matching disconnects the observers; the ttl still removes the entry if unwatchText
        // never comes (a take-over, a disconnect).
        const stop = () => { for (const o of observers) o.disconnect(); observers.length = 0; };
        const onMutations = (list) => {
          for (const m of list) {
            if ((m.type === 'characterData' && has(m.target)) || [...m.addedNodes].some(has)) { entry.seen = true; stop(); return; }
          }
        };
        for (const r of roots()) {
          const o = new MutationObserver(onMutations);
          o.observe(r, { subtree: true, childList: true, characterData: true });
          observers.push(o);
        }
        entry.check = () => {
          if (!entry.seen) {
            const c = count(text);
            if (c > entry.low) { entry.seen = true; stop(); }
            else entry.low = Math.min(entry.low, c);
          }
          return entry.seen;
        };
        entry.stop = () => { stop(); clearTimeout(entry.ttl); delete w[id]; };
        entry.low = count(text);
        entry.ttl = setTimeout(entry.stop, ${Math.max(1000, Math.round(ttlMs))});
        w[id] = entry; })()`;
      await this.cdp(tabId, 'Runtime.evaluate', { expression: expr });
      return id;
    });
  }

  /** Wait for a watchText watch. If the page navigated (the watch is gone), the text on the new
   *  page counts. */
  async awaitText(tabId: number, id: string, text: string, timeoutMs: number) {
    // After a navigation the watch is gone: then the text anywhere visible on the new page counts.
    const fn = `(() => { const w = window.__overtakeWatch?.[${JSON.stringify(id)}]; if (w) return w.check(); ${VISIBLE_TEXT_JS} return count(${JSON.stringify(text)}) > 0; })()`;
    try {
      await this.wait(tabId, { function: fn, timeoutMs });
    } catch (e) {
      if (e instanceof OvertakeError && e.code === ErrorCode.TIMEOUT) throw new OvertakeError(ErrorCode.TIMEOUT, `The action ran, but "${text.slice(0, 80)}" did not appear on the page within ${timeoutMs} ms (text that was already there does not count).`);
      throw e;
    }
    return { appeared: text };
  }

  /** Stop a watchText watch and forget it. Best effort: if the human has control, the watch
   *  still stops itself when its ttl ends. */
  async unwatchText(tabId: number, id: string) {
    const expr = `window.__overtakeWatch?.[${JSON.stringify(id)}]?.stop()`;
    await this.cdp(tabId, 'Runtime.evaluate', { expression: expr }).catch(() => {});
  }

  /** Requests the page made since `since` (an action's start), skipping static assets. Waits
   *  briefly (at most maxMs) for ones still in flight, so a save the action triggered shows
   *  its status. */
  async requestsSince(tabId: number, since: number, maxMs = 1000) {
    const t = this.#tabs.get(tabId);
    if (!t) return [];
    const skip = new Set(['Image', 'Font', 'Stylesheet', 'Script', 'Media', 'Manifest', 'Ping', 'CSPViolationReport', 'EventSource', 'WebSocket']);
    const pick = () => [...t.net.values()].filter((e) => e.startedAt >= since && !skip.has(e.type || '') && !e.url.startsWith('data:'));
    await sleep(30); // a request started by the action's last event may not be reported yet
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && pick().some((e) => inFlight(e, Date.now()))) await sleep(25);
    return pick().slice(0, 10).map((e) => ({ method: e.method, url: receiptUrl(e.url), status: e.status ?? (e.failed ? `failed: ${e.failed}` : 'pending'), ms: e.endedAt ? e.endedAt - e.startedAt : undefined }));
  }

  /** Page URL, title and readyState. timeoutMs bounds the whole call, retries included. */
  async pageInfo(tabId: number, timeoutMs?: number) {
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    // Read-only, so safe to retry when a redirect replaces the document mid-call.
    for (let i = 0; ; i++) {
      const left = deadline !== undefined ? deadline - Date.now() : undefined;
      if (left !== undefined && left <= 0) throw new OvertakeError(ErrorCode.TIMEOUT, `The page did not answer within ${timeoutMs} ms.`);
      try {
        const r = await this.cdp<{ result: { value: { url: string; title: string; readyState: string } } }>(tabId, 'Runtime.evaluate', {
          expression: '({url: location.href, title: document.title, readyState: document.readyState})', returnByValue: true,
        }, undefined, left !== undefined ? Math.max(left, 100) : undefined);
        return r.result.value;
      } catch (e) {
        if (i >= 5 || !contextGone(e)) throw e;
        await sleep(200);
      }
    }
  }

  async wait(tabId: number, cond: { delayMs?: number; selector?: string; state?: 'visible' | 'attached' | 'hidden'; text?: string; urlIncludes?: string; function?: string; networkIdleMs?: number; load?: boolean; timeoutMs?: number }) {
    if (cond.delayMs) {
      // A plain pause (no page timers, so background throttling cannot stretch it).
      // Control is re-checked afterwards, so a take-over during the pause is reported.
      await sleep(Math.min(cond.delayMs, 120_000));
      const spaceId = await this.spaceOf(tabId);
      const s = (await this.listSpaces()).find((x) => x.spaceId === spaceId);
      if (!s) throw new OvertakeError(ErrorCode.SPACE_CLOSED, `Space ${spaceId} was closed.`);
      if (s.owner !== this.client.agentKey || s.control !== 'AGENT_CONTROL') {
        if (s.control === 'AGENT_PAUSED' && s.owner === this.client.agentKey) return { waited: cond.delayMs, note: 'The human paused the agent; your next command will wait for Resume.' };
        throw this.#lostControl(s);
      }
      if (!cond.selector && !cond.text && !cond.urlIncludes && !cond.function && !cond.networkIdleMs && !cond.load) return { waited: cond.delayMs };
    }
    return this.action(tabId, (t) => this.#waitIn(t, cond));
  }

  #lostControl(s: SpaceSummary) {
    return new OvertakeError(s.control === 'STOPPED' ? ErrorCode.STOPPED : s.owner === this.client.agentKey ? ErrorCode.USER_IN_CONTROL : ErrorCode.NOT_OWNER,
      'Control changed while waiting: the human has this Space now. This is a hard stop; wait until they give control back.');
  }

  /** The polling part of wait, for callers already inside the tab's action. */
  async #waitIn(t: TabState, cond: { selector?: string; state?: 'visible' | 'attached' | 'hidden'; text?: string; urlIncludes?: string; function?: string; networkIdleMs?: number; load?: boolean; timeoutMs?: number }) {
    const tabId = t.tabId;
    {
      const timeoutMs = cond.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeoutMs;
      // Selector and text are checked in every frame: the page with its same-origin iframes,
      // and each cross-site iframe through its own session. Each reports
      // { n: matches, vis: visible matches, text: whether the text is in it }.
      let probe: ((ownDocOnly: boolean) => string) | null = null;
      if (cond.selector || cond.text) {
        const { kind, sel } = cond.selector ? parseSelector(cond.selector) : { kind: '', sel: '' };
        probe = (ownDocOnly) => {
          const docs = ownDocOnly ? '[document]' : `(${FRAME_DOCS})()`;
          // Same selector forms as the action tools (css incl. open shadow roots, text=, xpath=).
          const matches = cond.selector ? `(${FIND_ELEMENT})(${JSON.stringify(sel)}, ${JSON.stringify(kind)}, true, docs)` : '[]';
          const hasText = cond.text ? `docs.some((d) => (d.body?.innerText || '').includes(${JSON.stringify(cond.text)}))` : 'false';
          return `(() => { const docs = ${docs}; const a = ${matches}; const shown = ${FRAME_SHOWN_JS}; return { n: a.length, vis: a.filter(shown).length, text: ${hasText} }; })()`;
        };
      }
      const state = cond.state || 'visible';
      const check = async (): Promise<boolean> => {
        if (probe) {
          const left = deadline - Date.now();
          type V = { n: number; vis: number; text: boolean };
          type Probe = { result: { value?: V | null }; exceptionDetails?: unknown };
          const absent: V = { n: 0, vis: 0, text: false };
          // Selector and text are checked in every document: the page with the frames it
          // reaches, then each document it cannot reach, on its own. A probe that fails or times
          // out is unknown: it cannot prove absence (state "hidden"), but a match found elsewhere
          // still counts. Only a frame that is gone counts as having nothing.
          const ask = (o?: OtherDoc): Promise<{ v?: V; bad?: boolean }> => within(
            this.cdp<Probe>(tabId, 'Runtime.evaluate', { expression: o?.guard ? `(${REACHABLE_FROM_TOP}) ? null : ${probe!(true)}` : probe!(!!o), returnByValue: true, ...(o?.contextId ? { contextId: o.contextId } : {}) }, o?.sid, Math.max(left, 100))
              .then((r) => (r.exceptionDetails ? { bad: true } : r.result.value ? { v: r.result.value } : o?.guard ? { v: absent } : {}))
              .catch((e) => { softFail(null)(e); return o && frameGone(e) ? { v: absent } : {}; }),
            left, {});
          // Decide as soon as the answers so far settle it: a match proven in one frame does not
          // wait for a slow or unresponsive other one.
          const docs = this.#otherDocs(t);
          const answers: ({ v?: V; bad?: boolean } | undefined)[] = new Array(docs.length + 1);
          const decide = (): boolean | undefined => {
            const top = answers[0];
            if (top?.bad && cond.selector) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Invalid selector ${cond.selector}`);
            const done = answers.filter((a) => a).length;
            const pending = docs.length + 1 - done;
            const known = answers.filter((a) => a?.v).map((a) => a!.v!);
            const unknown = done - known.length > 0;
            const n = known.reduce((sum, v) => sum + v.n, 0);
            const vis = known.reduce((sum, v) => sum + v.vis, 0);
            let selOk: boolean | undefined = true;
            if (cond.selector) {
              if (state === 'hidden') selOk = vis > 0 ? false : pending ? undefined : !unknown;
              else selOk = (state === 'attached' ? n > 0 : vis > 0) ? true : pending ? undefined : false;
            }
            let textOk: boolean | undefined = true;
            if (cond.text) textOk = known.some((v) => v.text) ? true : pending ? undefined : false;
            if (selOk === false || textOk === false) return false;
            return selOk && textOk ? true : undefined;
          };
          const ok = await new Promise<boolean>((resolve, reject) => {
            let settled = false;
            const settle = (f: () => boolean | undefined) => {
              if (settled) return;
              try {
                const d = f();
                if (d !== undefined) { settled = true; resolve(d); }
              } catch (e) { settled = true; reject(e); }
            };
            [undefined, ...docs].forEach((o, i) => {
              void ask(o).then((a) => { answers[i] = a; settle(decide); }, (e) => settle(() => { throw e; }));
            });
          });
          if (!ok) return false;
        }
        const parts: string[] = [];
        if (cond.urlIncludes) parts.push(`location.href.includes(${JSON.stringify(cond.urlIncludes)})`);
        if (cond.function) parts.push(`!!(await (async () => (${cond.function}))())`);
        if (cond.load) parts.push(`document.readyState === 'complete'`);
        if (parts.length) {
          // Bounded by what is left, so a stuck page cannot hold the Space past timeoutMs.
          const left = deadline - Date.now();
          const r = await within(
            this.cdp<{ result: { value: boolean } }>(tabId, 'Runtime.evaluate', { expression: `(async () => ${parts.join(' && ')})()`, awaitPromise: true, returnByValue: true }, undefined, Math.max(left, 100)).catch(softFail({ result: { value: false } })),
            left, { result: { value: false } });
          if (!r.result.value) return false;
        }
        if (cond.networkIdleMs) {
          const now = Date.now();
          const inflight = [...t.net.values()].filter((e) => inFlight(e, now));
          const lastEnd = Math.max(0, ...[...t.net.values()].map((e) => e.endedAt || (e.respondedAt ? e.respondedAt + 150 : 0)));
          if (inflight.length || now - lastEnd < cond.networkIdleMs) return false;
        }
        return true;
      };
      const started = Date.now();
      while (!(await check())) {
        if (Date.now() > deadline) {
          // A bounded check can hide a take-over error, so ask the latest control state first.
          const s = this.#spaces.get(this.#tabSpace.get(tabId) ?? -1);
          if (s && s.control !== 'AGENT_PAUSED' && (s.owner !== this.client.agentKey || s.control !== 'AGENT_CONTROL')) throw this.#lostControl(s);
          throw new OvertakeError(ErrorCode.TIMEOUT, `Condition not met within ${timeoutMs} ms: ${JSON.stringify(cond)}`);
        }
        // Poll fast at first (most conditions are met within a few hundred ms), then back off.
        const elapsed = Date.now() - started;
        await sleep(elapsed < 1000 ? 20 : elapsed < 5000 ? 50 : 100);
      }
      const info = await within(this.pageInfo(tabId, 1000).catch(softFail(null)), 1000, null);
      return { satisfied: true, ...(info ?? { url: undefined, title: undefined, readyState: undefined }) };
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot

  async snapshot(tabId: number, opts: { scope?: 'viewport' | 'full_page'; maxLines?: number } = {}) {
    return this.action(tabId, async (t) => {
      const { nodes } = await this.cdp<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree', {});
      const children = new Map<string, FrameTree>();
      // Frames in the same process as a document are read through that document's session;
      // a cross-site frame through its own session, offset by its <iframe> in the page.
      // Nested frames are followed too (consoles often put iframes inside iframes).
      const localFrames = new Map<string, Set<string>>();
      const framesOf = async (sid?: string) => {
        const key = sid ?? '';
        let set = localFrames.get(key);
        if (!set) {
          set = new Set();
          const tree = await this.cdp<{ frameTree: { frame: { id: string }; childFrames?: unknown[] } }>(tabId, 'Page.getFrameTree', {}, sid).catch(() => null);
          const collect = (ft: { frame: { id: string }; childFrames?: unknown[] }, depth: number) => {
            if (depth > 0) set!.add(ft.frame.id);
            for (const c of (ft.childFrames || []) as typeof ft[]) collect(c, depth + 1);
          };
          if (tree) collect(tree.frameTree, 0);
          localFrames.set(key, set);
        }
        return set;
      };
      let budget = 60; // frames read per snapshot
      const expand = async (axNodes: AXNode[], sid: string | undefined, owner: number | undefined, depth: number): Promise<void> => {
        if (depth > 6) return;
        for (const n of axNodes) {
          if (budget <= 0) return;
          if ((n.role?.value !== 'Iframe' && n.role?.value !== 'iframe') || n.backendDOMNodeId === undefined) continue;
          const d = await this.cdp<{ node: { frameId?: string } }>(tabId, 'DOM.describeNode', { backendNodeId: n.backendDOMNodeId }, sid).catch(() => null);
          const fid = d?.node.frameId;
          if (!fid) continue;
          budget--;
          if ((await framesOf(sid)).has(fid)) {
            const sub = await this.cdp<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree', { frameId: fid }, sid).catch(() => null);
            if (!sub) continue;
            children.set(frameKey(sid, n.backendDOMNodeId), { nodes: sub.nodes, sessionId: sid, frameId: fid, ownerBackendNodeId: owner });
            await expand(sub.nodes, sid, owner, depth + 1);
          } else if (!sid) {
            // Out-of-process iframe: find its session. (One inside another cross-site frame
            // is not followed: its coordinates would need two offsets.)
            const child = [...t.children.entries()].find(([, v]) => v.targetId === fid);
            if (!child) continue;
            const sub = await this.cdp<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree', {}, child[0]).catch(() => null);
            if (!sub) continue;
            children.set(frameKey(sid, n.backendDOMNodeId), { nodes: sub.nodes, sessionId: child[0], frameId: fid, ownerBackendNodeId: n.backendDOMNodeId });
            await expand(sub.nodes, child[0], n.backendDOMNodeId, depth + 1);
          }
        }
      };
      await expand(nodes, undefined, undefined, 0);
      const dom = await this.cdp<DomSnap>(tabId, 'DOMSnapshot.captureSnapshot', { computedStyles: [] }).catch(() => null);
      let visible: Set<number> | undefined;
      if ((opts.scope || 'viewport') === 'viewport') visible = dom ? await this.#visibleNodes(tabId, dom) : new Set();
      const draggable = dom ? draggableNodes(dom) : undefined;
      const exclude = new Set<number>();
      const host = await this.cdp<{ result: { objectId?: string } }>(tabId, 'Runtime.evaluate', { expression: `document.querySelector('overtake-overlay')` }).catch(() => null);
      if (host?.result.objectId) {
        const d = await this.cdp<{ node: { backendNodeId: number } }>(tabId, 'DOM.describeNode', { objectId: host.result.objectId }).catch(() => null);
        if (d) exclude.add(d.node.backendNodeId);
        void this.cdp(tabId, 'Runtime.releaseObject', { objectId: host.result.objectId }).catch(() => {});
      }
      const out = buildSnapshot({ main: { nodes }, children, visible, exclude, draggable, nextRef: () => ++refCounter, maxLines: opts.maxLines });
      t.refs = out.refs;
      const info = await this.pageInfo(tabId);
      this.#saw(t, info);
      return { url: info.url, title: info.title, snapshot: out.text, refCount: out.refs.size };
    });
  }

  async #visibleNodes(tabId: number, snap: DomSnap): Promise<Set<number>> {
    const m = await this.cdp<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>(tabId, 'Page.getLayoutMetrics');
    const vp = m.cssVisualViewport;
    const doc = snap.documents[0];
    const visible = new Set<number>();
    if (!doc) return visible;
    for (let i = 0; i < doc.layout.nodeIndex.length; i++) {
      const [x, y, w, h] = doc.layout.bounds[i];
      if (w <= 0 || h <= 0) continue;
      if (x + w < vp.pageX || x > vp.pageX + vp.clientWidth || y + h < vp.pageY || y > vp.pageY + vp.clientHeight) continue;
      visible.add(doc.nodes.backendNodeId[doc.layout.nodeIndex[i]]);
    }
    return visible;
  }

  // -------------------------------------------------------------------------
  // Target resolution

  async #resolve(t: TabState, target: string): Promise<{ point?: { x: number; y: number }; node?: RefTarget & { objectId?: string }; desc: string }> {
    const tabId = t.tabId;
    const coord = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(target);
    if (coord) return { point: { x: Number(coord[1]), y: Number(coord[2]) }, desc: `point ${coord[1]},${coord[2]}` };
    const ref = /^@(\d+)$|^ref=(\d+)$/.exec(target.trim());
    if (ref) {
      const id = Number(ref[1] ?? ref[2]);
      const r = t.refs.get(id);
      if (!r) throw new OvertakeError(ErrorCode.ELEMENT_NOT_FOUND, `Ref @${id} is unknown or stale (the page navigated or a newer snapshot replaced it). Take a new browser_snapshot.`);
      return { node: r, desc: `@${id} ${r.role}${r.name ? ` "${r.name}"` : ''}` };
    }
    const { kind, sel } = parseSelector(target);
    const finder = finderExpr(sel, kind);
    type Found = { result: { type: string; subtype?: string; objectId?: string; value?: string }; exceptionDetails?: Json };
    const find = (sid?: string) => this.cdp<Found>(tabId, 'Runtime.evaluate', { expression: finder, returnByValue: false }, sid);
    const countOf = (r: Found) => Number(/^count:(\d+)$/.exec(r.result.value ?? '')?.[1] ?? 0);
    const tooMany = (count: number) => new OvertakeError(ErrorCode.ELEMENT_AMBIGUOUS, `${target} matched ${count} elements; make it unique (or use a snapshot @ref).`);
    // Finding is read-only: if the document was just replaced, look again in the new one.
    const r = await find().catch(async (e) => {
      if (!contextGone(e)) throw e;
      await sleep(300);
      return find();
    });
    if (r.exceptionDetails) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Invalid selector ${target}`);
    if (r.result.subtype === 'node' && r.result.objectId) {
      const d = await this.cdp<{ node: { backendNodeId: number; nodeName: string } }>(tabId, 'DOM.describeNode', { objectId: r.result.objectId });
      return { node: { backendNodeId: d.node.backendNodeId, role: d.node.nodeName.toLowerCase(), name: '', objectId: r.result.objectId }, desc: target };
    }
    if (r.result.objectId) void this.cdp(tabId, 'Runtime.releaseObject', { objectId: r.result.objectId }).catch(() => {});
    if (countOf(r)) throw tooMany(countOf(r));
    // Nothing in the page or its same-origin iframes. Look in documents the page cannot reach,
    // each on its own (so none is counted twice): same-process frames of another origin on the
    // same site (their nodes and coordinates work like the page's), then the documents of each
    // cross-site iframe, which run in their own process, offset by the iframe in the page.
    const own = finderExpr(sel, kind, true);
    const hits: { node: RefTarget & { objectId?: string }; url: string }[] = [];
    let more = 0;
    const owners = new Map<string, number | null>();
    for (const o of this.#otherDocs(t)) {
      const fr = await this.cdp<Found>(tabId, 'Runtime.evaluate', { expression: o.guard ? `(${REACHABLE_FROM_TOP}) ? 'count:0' : ${own}` : own, returnByValue: false, ...(o.contextId ? { contextId: o.contextId } : {}) }, o.sid).catch(() => null);
      if (!fr || fr.exceptionDetails) continue;
      if (fr.result.subtype !== 'node' || !fr.result.objectId) {
        more += countOf(fr);
        continue;
      }
      const d = await this.cdp<{ node: { backendNodeId: number; nodeName: string } }>(tabId, 'DOM.describeNode', { objectId: fr.result.objectId }, o.sid).catch(() => null);
      if (!o.sid) {
        if (d) hits.push({ node: { backendNodeId: d.node.backendNodeId, role: d.node.nodeName.toLowerCase(), name: '', objectId: fr.result.objectId }, url: '' });
        continue;
      }
      void this.cdp(tabId, 'Runtime.releaseObject', { objectId: fr.result.objectId }, o.sid).catch(() => {});
      if (!owners.has(o.sid)) owners.set(o.sid, (await this.cdp<{ backendNodeId: number }>(tabId, 'DOM.getFrameOwner', { frameId: o.targetId }).catch(() => null))?.backendNodeId ?? null);
      const owner = owners.get(o.sid);
      if (!d || !owner) continue; // e.g. a cross-site frame nested in another one
      hits.push({ node: { backendNodeId: d.node.backendNodeId, role: d.node.nodeName.toLowerCase(), name: '', sessionId: o.sid, ownerBackendNodeId: owner }, url: o.url || '' });
    }
    if (hits.length + more > 1) {
      for (const h of hits) if (h.node.objectId) void this.cdp(tabId, 'Runtime.releaseObject', { objectId: h.node.objectId }).catch(() => {});
      throw tooMany(hits.length + more);
    }
    if (hits.length && !hits[0].node.sessionId) return { node: hits[0].node, desc: target };
    if (hits.length) {
      // The target's url can be empty before its first navigation is reported: ask the frame.
      const url = hits[0].url || (await this.cdp<{ result: { value?: string } }>(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, hits[0].node.sessionId).catch(() => null))?.result.value || '';
      return { node: hits[0].node, desc: `${target} (in cross-site iframe ${receiptUrl(url)})` };
    }
    throw new OvertakeError(ErrorCode.ELEMENT_NOT_FOUND, `${target} matched no element.`);
  }

  /** Documents the top document cannot script, each to be searched on its own: same-process
   *  frames of another origin (guard: skip those the top does reach), and every document of
   *  each cross-site frame's session (its default context when none is known yet). */
  #otherDocs(t: TabState): OtherDoc[] {
    const out: OtherDoc[] = [];
    for (const [fid, contextId] of t.contexts) if (fid !== t.mainFrameId) out.push({ contextId, guard: true });
    for (const [sid, c] of t.children) {
      if (c.type !== 'iframe') continue;
      const ctxs = t.childContexts.get(sid);
      if (ctxs?.size) for (const contextId of ctxs.values()) out.push({ sid, contextId, guard: false, targetId: c.targetId, url: c.url });
      else out.push({ sid, guard: false, targetId: c.targetId, url: c.url });
    }
    return out;
  }

  /** Scroll into view, verify the element is the top hit target, return root-viewport coordinates. */
  async #pointFor(t: TabState, node: RefTarget & { objectId?: string }, force = false): Promise<{ x: number; y: number }> {
    const tabId = t.tabId;
    const sid = node.sessionId;
    await this.cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }, sid).catch(() => {});
    let objectId = node.objectId;
    if (!objectId || sid) {
      const res = await this.cdp<{ object: { objectId: string } }>(tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId }, sid).catch(() => null);
      if (!res) throw new OvertakeError(ErrorCode.ELEMENT_NOT_FOUND, 'The element is no longer in the document. Take a new snapshot.');
      objectId = res.object.objectId;
    }
    const check = await this.cdp<{ result: { value: { ok: boolean; reason?: string; top?: string; disabled?: boolean; detached?: boolean } } }>(tabId, 'Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function(){
        if (!this.isConnected) return { ok: false, detached: true };
        const r = this.getBoundingClientRect();
        if (!r.width || !r.height) return { ok: false, reason: 'the element has no size (hidden?)' };
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const root = this.getRootNode();
        const stack = (root.elementsFromPoint ? root : document).elementsFromPoint(cx, cy).filter((e) => e.localName !== 'overtake-overlay');
        const top = stack[0];
        const desc = (e) => e ? e.localName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') : 'nothing';
        const ok = !!top && (top === this || this.contains(top) || (top.localName === 'label' && top.control === this));
        if (!ok) return { ok, top: desc(top), disabled: !!this.disabled };
        // Inside an iframe: that iframe must be visible and on top at this point in its own
        // document, and so on up (as far as this document can see), or the click lands on
        // whatever covers it.
        let el = this, x = cx, y = cy;
        for (let i = 0; i < 30; i++) {
          let fe = null;
          try { fe = el.ownerDocument.defaultView.frameElement; } catch {}
          if (!fe) break;
          if (!fe.checkVisibility({ visibilityProperty: true })) return { ok: false, reason: 'the iframe it is in is hidden' };
          const fr = fe.getBoundingClientRect();
          const k = fe.clientWidth ? fr.width / (fe.offsetWidth || fr.width) : 1;
          x = fr.left + (fe.clientLeft + x) * k;
          y = fr.top + (fe.clientTop + y) * k;
          const froot = fe.getRootNode();
          const hit = (froot.elementsFromPoint ? froot : fe.ownerDocument).elementsFromPoint(x, y).filter((e) => e.localName !== 'overtake-overlay')[0];
          if (hit !== fe) return { ok: false, top: desc(hit), disabled: !!this.disabled };
          el = fe;
        }
        return { ok, top: desc(top), disabled: !!this.disabled };
      }`,
    }, sid);
    const v = check.result.value;
    // Pages that re-render replace their elements: an old ref then points at a removed one.
    if (v.detached) throw new OvertakeError(ErrorCode.ELEMENT_NOT_FOUND, 'The element is no longer in the page (it was removed or re-rendered, so this ref is stale). Take a new browser_snapshot.');
    if (!force) {
      if (v.reason) throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, `Cannot act on the element: ${v.reason}.`);
      if (!v.ok) throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, `The element is covered by ${v.top} at its center. Close the covering element or pass force:true.`);
    }
    const q = await this.cdp<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { backendNodeId: node.backendNodeId }, sid).catch(() => ({ quads: [] as number[][] }));
    if (!q.quads.length) throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, 'The element has no visible box.');
    const quad = q.quads[0];
    let x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    let y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    if (sid && node.ownerBackendNodeId !== undefined) {
      [x, y] = await this.#frameToRoot(tabId, sid, node.ownerBackendNodeId, [x, y]);
      // The cross-site iframe itself must be visible and on top at that point in the page.
      if (!force) {
        const owner = await this.cdp<{ object: { objectId: string } }>(tabId, 'DOM.resolveNode', { backendNodeId: node.ownerBackendNodeId }).catch(() => null);
        if (owner) {
          const o = await this.cdp<{ result: { value?: { ok?: boolean; reason?: string; top?: string } } }>(tabId, 'Runtime.callFunctionOn', {
            objectId: owner.object.objectId, returnByValue: true, arguments: [{ value: x }, { value: y }],
            functionDeclaration: `function (x, y) {
              const vis = this.checkVisibility({ visibilityProperty: true }) && (${FRAME_SHOWN_JS})(this);
              if (!vis) return { reason: 'the iframe it is in is hidden' };
              if (this.ownerDocument !== document) return { ok: true };
              const hit = document.elementsFromPoint(x, y).filter((e) => e.localName !== 'overtake-overlay')[0];
              return { ok: hit === this, top: hit ? hit.localName + (hit.id ? '#' + hit.id : '') : 'nothing' };
            }`,
          }).catch(() => null);
          void this.cdp(tabId, 'Runtime.releaseObject', { objectId: owner.object.objectId }).catch(() => {});
          const ov = o?.result.value;
          if (ov?.reason) throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, `Cannot act on the element: ${ov.reason}.`);
          if (ov && ov.ok === false) throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, `The element is covered by ${ov.top} at its center. Close the covering element or pass force:true.`);
        }
      }
    }
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }

  /** For an element inside a frame: the part of it that shows through its frame and every
   *  enclosing frame the frame's document can see, as fractions of the element's own box
   *  ([u0, v0, u1, v1]); [] when none of it shows; null for an element of the top page. */
  async #frameClip(tabId: number, node: RefTarget & { objectId?: string }): Promise<number[] | null> {
    const sid = node.sessionId;
    let objectId = sid ? undefined : node.objectId;
    if (!objectId) objectId = (await this.cdp<{ object: { objectId: string } }>(tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId }, sid).catch(() => null))?.object.objectId;
    if (!objectId) return null;
    const r = await this.cdp<{ result: { value?: number[] | null } }>(tabId, 'Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: `function () {
        let w = this.ownerDocument.defaultView;
        if (!w || w === w.top) return null;
        const r0 = this.getBoundingClientRect();
        let R = [r0.left, r0.top, r0.right, r0.bottom], C = R.slice();
        for (let i = 0; i < 30; i++) {
          C = [Math.max(C[0], 0), Math.max(C[1], 0), Math.min(C[2], w.innerWidth), Math.min(C[3], w.innerHeight)];
          if (C[2] <= C[0] || C[3] <= C[1]) return [];
          let fe = null;
          try { fe = w.frameElement; } catch {}
          if (!fe) break;
          const fr = fe.getBoundingClientRect();
          const k = fr.width / (fe.offsetWidth || fr.width || 1);
          const up = (q) => [fr.left + (fe.clientLeft + q[0]) * k, fr.top + (fe.clientTop + q[1]) * k, fr.left + (fe.clientLeft + q[2]) * k, fr.top + (fe.clientTop + q[3]) * k];
          R = up(R);
          C = up(C);
          w = fe.ownerDocument.defaultView;
          if (w === w.top) break;
        }
        const W = R[2] - R[0] || 1, H = R[3] - R[1] || 1;
        return [(C[0] - R[0]) / W, (C[1] - R[1]) / H, (C[2] - R[0]) / W, (C[3] - R[1]) / H];
      }`,
    }, sid).catch(() => null);
    if (objectId !== node.objectId) void this.cdp(tabId, 'Runtime.releaseObject', { objectId }, sid).catch(() => {});
    return r?.result.value ?? null;
  }

  /** Map points (x0, y0, x1, y1, ...) in a cross-site frame's viewport to the page's viewport,
   *  through its <iframe>'s content box as drawn (so a scaled or rotated iframe maps right). */
  async #frameToRoot(tabId: number, sid: string, owner: number, pts: number[]): Promise<number[]> {
    const box = await this.cdp<{ model: { content: number[] } }>(tabId, 'DOM.getBoxModel', { backendNodeId: owner });
    const c = box.model.content; // corners: top-left, top-right, bottom-right, bottom-left
    const size = await this.cdp<{ result: { value?: [number, number] } }>(tabId, 'Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true }, sid).catch(() => null);
    const w = size?.result.value?.[0] || Math.hypot(c[2] - c[0], c[3] - c[1]);
    const h = size?.result.value?.[1] || Math.hypot(c[6] - c[0], c[7] - c[1]);
    const out: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const u = pts[i] / w;
      const v = pts[i + 1] / h;
      out.push(c[0] + u * (c[2] - c[0]) + v * (c[6] - c[0]), c[1] + u * (c[3] - c[1]) + v * (c[7] - c[1]));
    }
    return out;
  }

  #jump(t: TabState, to: { x: number; y: number }): InputStep[] {
    t.cursor = to;
    return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: to.x, y: to.y, button: 'none' } }];
  }

  #path(t: TabState, to: { x: number; y: number }): InputStep[] {
    const from = t.cursor || { x: Math.max(0, to.x - 160), y: Math.max(0, to.y - 90) };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    // Few real mouseMoved steps: the overlay's spring animates the visible cursor smoothly
    // between them, and each step pays the input-gate handshake (benchmark: 14 steps = 360 ms).
    const n = Math.max(2, Math.min(6, Math.round(dist / 120)));
    const steps: InputStep[] = [];
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
      steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, button: 'none' }, delayMs: i === 1 ? 0 : 12 });
    }
    t.cursor = to;
    return steps;
  }

  async #receiptAfter(t: TabState, navBefore: number) {
    // No fixed pause: a navigation the action caused was announced (frameRequestedNavigation)
    // before the input reply. Then wait for its commit and load, using the recorded event
    // times, so a page that loaded before we started waiting is not missed (benchmark: that
    // cost ~150 ms per navigating click).
    await sleep(0);
    if (t.lastNavAt > navBefore || t.navRequestedAt > navBefore) {
      const commitBy = Date.now() + 3000;
      const loadBy = Date.now() + 8000;
      let lastPoll = 0;
      for (;;) {
        const now = Date.now();
        if (t.downloadAt > navBefore && t.lastNavAt <= navBefore) break; // it became a download
        if (t.lastNavAt > navBefore) {
          if (t.lastLoadAt >= t.lastNavAt || now > loadBy) break;
          // Fallback if the load event was missed (e.g. re-attach): the committed document's readyState.
          if (now - lastPoll > 150) {
            lastPoll = now;
            const r = await this.cdp<{ result: { value?: string } }>(t.tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, undefined, 2000).catch(() => null);
            if (r?.result.value === 'complete' && t.lastNavAt > navBefore) break;
          }
        } else if (now > commitBy) break; // requested but never committed (cancelled, or very slow)
        await sleep(10);
      }
    }
    const info = t.dialog ? { url: '', title: '' } : await this.pageInfo(t.tabId).catch(() => ({ url: '', title: '' }));
    // A requested navigation can turn into a download or be cancelled: report only commits.
    const navigated = t.lastNavAt > navBefore;
    if (t.dialog) return { navigated, dialog: t.dialog };
    // The url and title only when they changed since the agent last saw them: on apps that
    // keep state in the URL, repeating a long one after every click costs many tokens.
    return { navigated, ...this.#changedPage(t, info) };
  }

  /** The url (capped) and title, if they differ from what the agent last saw on this tab. */
  #changedPage(t: TabState, info: { url: string; title: string }): { url?: string; title?: string } {
    if (!info.url || (info.url === t.shown.url && info.title === t.shown.title)) return {};
    t.shown = { url: info.url, title: info.title };
    return { url: capUrl(info.url), title: info.title };
  }

  /** Note what a full result (navigate, snapshot) showed the agent. */
  #saw(t: TabState, info: { url: string; title: string }) {
    if (info.url) t.shown = { url: info.url, title: info.title };
  }

  async #tabsBefore(tabId: number): Promise<Set<number>> {
    const sid = await this.spaceOf(tabId);
    const r = await this.client.request<{ tabs: { tabId: number }[] }>('tabs.list', { spaceId: sid });
    return new Set(r.tabs.map((x) => x.tabId));
  }

  async #popups(tabId: number, before: Set<number>) {
    const sid = await this.spaceOf(tabId);
    const r = await this.client.request<{ tabs: { tabId: number; url?: string; managed: boolean }[] }>('tabs.list', { spaceId: sid });
    return r.tabs.filter((x) => !before.has(x.tabId));
  }

  // -------------------------------------------------------------------------
  // Actions

  async click(tabId: number, target: string, opts: { button?: 'left' | 'right' | 'middle'; clickCount?: number; label?: string; force?: boolean; modifiers?: number; humanlike?: boolean } = {}) {
    return this.action(tabId, async (t) => {
      const tm: Record<string, number> = {};
      let t0 = performance.now();
      const lap = (k: string) => { const n = performance.now(); tm[k] = Math.round(n - t0); t0 = n; };
      const r = await this.#resolve(t, target);
      lap('resolve');
      const pt = r.point ?? (await this.#pointFor(t, r.node!, opts.force));
      lap('point');
      const navBefore = Date.now();
      const before = await this.#tabsBefore(tabId);
      lap('tabs');
      const button = opts.button || 'left';
      const count = opts.clickCount || 1;
      // Default: the visible cursor glides (overlay animation) but the page only gets a
      // move onto the target, press and release, each still through the input gate.
      // humanlike: real pointer moves along the path too (hover effects on the way).
      const steps = opts.humanlike ? this.#path(t, pt) : this.#jump(t, pt);
      for (let i = 1; i <= count; i++) {
        steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: pt.x, y: pt.y, button, clickCount: i, modifiers: opts.modifiers || 0 }, delayMs: i === 1 ? 0 : 40 });
        steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: pt.x, y: pt.y, button, clickCount: i, modifiers: opts.modifiers || 0 } });
      }
      await this.client.request('input.batch', { tabId, steps, label: opts.label || `click ${r.desc}`.slice(0, 60) });
      lap('input');
      if (r.node?.objectId) void this.cdp(tabId, 'Runtime.releaseObject', { objectId: r.node.objectId }).catch(() => {});
      const receipt = await this.#receiptAfter(t, navBefore);
      lap('receipt');
      const popups = await this.#popups(tabId, before).catch(() => []);
      lap('popups');
      return { clicked: r.desc, at: pt, ...receipt, ...(popups.length ? { popups } : {}), timingMs: tm };
    });
  }

  /** Choose option(s) in a native <select>, matched by value, then by visible label. The element
   *  must pass the same visibility and top-hit checks as a click, and the cursor moves there;
   *  the choice itself is set in the page with input and change events, because the native
   *  option popup is drawn outside the page and does not take CDP input reliably. */
  async select(tabId: number, target: string, values: string | string[], opts: { label?: string; force?: boolean } = {}) {
    return this.action(tabId, async (t) => {
      const r = await this.#resolve(t, target);
      if (!r.node) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'select needs an element (@ref or selector), not coordinates.');
      const pt = await this.#pointFor(t, r.node, opts.force);
      await this.client.request('input.batch', { tabId, steps: this.#jump(t, pt), label: opts.label || `select in ${r.desc}`.slice(0, 60) });
      const sid = r.node.sessionId;
      let objectId = sid ? undefined : r.node.objectId;
      if (!objectId) {
        const res = await this.cdp<{ object: { objectId: string } }>(tabId, 'DOM.resolveNode', { backendNodeId: r.node.backendNodeId }, sid).catch(() => null);
        if (!res) throw new OvertakeError(ErrorCode.ELEMENT_NOT_FOUND, 'The element is no longer in the document. Take a new snapshot.');
        objectId = res.object.objectId;
      }
      const want = (Array.isArray(values) ? values : [values]).map(String);
      type Out = { error?: string; tag?: string; missing?: string[]; available?: string[]; changed?: boolean; selected?: { value: string; label: string }[] };
      const res = await this.cdp<{ result: { value: Out } }>(tabId, 'Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        arguments: [{ value: want }],
        functionDeclaration: `function(want){
          if (this.localName !== 'select') return { error: 'not-select', tag: this.localName };
          if (this.matches(':disabled')) return { error: 'disabled' }; // also a disabled fieldset
          if (want.length > 1 && !this.multiple) return { error: 'single' };
          const opts = [...this.options];
          const usable = opts.filter((o) => !o.matches(':disabled')); // includes disabled optgroups
          const label = (o) => (o.label || o.textContent || '').trim();
          const picked = [], missing = [];
          for (const w of want) {
            const o = usable.find((x) => x.value === w) || usable.find((x) => label(x) === w.trim()) || usable.find((x) => label(x).toLowerCase() === w.trim().toLowerCase());
            if (!o) missing.push(w);
            else picked.push(o);
          }
          if (missing.length) return { error: 'missing', missing, available: usable.slice(0, 40).map((o) => o.value === label(o) ? o.value : label(o) + ' (' + o.value + ')') };
          this.focus();
          const before = opts.map((o) => o.selected);
          for (const o of opts) o.selected = picked.includes(o);
          // Like a user re-picking the current choice: no events when nothing changed.
          const changed = opts.some((o, i) => o.selected !== before[i]);
          if (changed) {
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { changed, selected: [...this.selectedOptions].map((o) => ({ value: o.value, label: label(o) })) };
        }`,
      }, sid);
      void this.cdp(tabId, 'Runtime.releaseObject', { objectId }, sid).catch(() => {});
      if (r.node.objectId && r.node.objectId !== objectId) void this.cdp(tabId, 'Runtime.releaseObject', { objectId: r.node.objectId }).catch(() => {});
      const v = res.result.value;
      if (v.error === 'not-select') throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, `${r.desc} is a <${v.tag}>, not a <select>. For a custom dropdown, click it, then click the option.`);
      if (v.error === 'disabled') throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, `${r.desc} is disabled.`);
      if (v.error === 'single') throw new OvertakeError(ErrorCode.BAD_REQUEST, `${r.desc} takes one value (it is not a multiple select).`);
      if (v.error === 'missing') throw new OvertakeError(ErrorCode.ELEMENT_NOT_FOUND, `No enabled option matches ${v.missing!.map((m) => JSON.stringify(m)).join(', ')} in ${r.desc}. Options: ${v.available!.join(', ')}.`);
      return { selectedIn: r.desc, selected: v.selected, changed: v.changed, at: pt };
    });
  }

  async hover(tabId: number, target: string, label?: string) {
    return this.action(tabId, async (t) => {
      const r = await this.#resolve(t, target);
      const pt = r.point ?? (await this.#pointFor(t, r.node!, true));
      await this.client.request('input.batch', { tabId, steps: this.#path(t, pt), label: label || `hover ${r.desc}`.slice(0, 60) });
      return { hovered: r.desc, at: pt };
    });
  }

  async type(tabId: number, opts: { target?: string; text: string; clear?: boolean; submit?: boolean; slowly?: boolean; label?: string }) {
    return this.action(tabId, async (t) => {
      const steps: InputStep[] = [];
      let desc = 'focused element';
      if (opts.target) {
        const r = await this.#resolve(t, opts.target);
        desc = r.desc;
        const pt = r.point ?? (await this.#pointFor(t, r.node!));
        // Same as a default click: visual glide only, real move onto the field, press, release.
        steps.push(...this.#jump(t, pt));
        steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 } });
        steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 } });
        await this.client.request('input.batch', { tabId, steps: steps.splice(0), label: opts.label || `type into ${desc}`.slice(0, 60) });
      }
      // The focused field may be inside an iframe: FOCUSED_OP follows focus there.
      if (opts.clear && (await this.#onFocused(t, 'clear'))) steps.push(...chordSteps('Backspace'));
      if (opts.slowly) steps.push(...typeSteps(opts.text).map((s) => ({ ...s, delayMs: 25 })));
      else if (opts.text) steps.push({ method: 'Input.insertText', params: { text: opts.text } });
      if (opts.submit) steps.push(...chordSteps('Enter'));
      const navBefore = Date.now();
      if (steps.length) await this.client.request('input.batch', { tabId, steps });
      // The field's value, to check what was typed. Null when focus is not on an editable
      // field (the page body, say), capped for long values.
      const value = await this.#onFocused(t, 'value').catch(() => null);
      const receipt = opts.submit ? await this.#receiptAfter(t, navBefore) : {};
      return { typedInto: desc, value, ...receipt };
    });
  }

  /** Run FOCUSED_OP where focus is: the page (with its same-origin iframes), or the cross-site
   *  iframe that has focus. */
  async #onFocused(t: TabState, op: 'clear' | 'value'): Promise<unknown> {
    type R = { result: { value?: { remote?: boolean; result?: unknown } } };
    const run = (sid?: string, guard = '') => this.cdp<R>(t.tabId, 'Runtime.evaluate', {
      expression: `(() => { ${guard} return (${FOCUSED_OP})(${JSON.stringify(op)}); })()`, returnByValue: true,
    }, sid).catch(() => null);
    const top = (await run())?.result.value;
    if (!top?.remote) return top?.result ?? null;
    // Focus is in a frame the page cannot reach: a same-process one of another origin, or one
    // in a cross-site frame's session. Ask each such document that has focus; ancestors of the
    // focused frame have focus too, and answer remote.
    for (const o of this.#otherDocs(t)) {
      const r = await this.cdp<R>(t.tabId, 'Runtime.evaluate', {
        expression: `(() => { if (!document.hasFocus()${o.guard ? ` || (${REACHABLE_FROM_TOP})` : ''}) return { away: true }; return (${FOCUSED_OP})(${JSON.stringify(op)}); })()`, returnByValue: true, ...(o.contextId ? { contextId: o.contextId } : {}),
      }, o.sid).catch(() => null);
      const v = r?.result.value as { remote?: boolean; result?: unknown; away?: boolean } | undefined;
      if (v && !v.away && !v.remote) return v.result ?? null;
    }
    return null;
  }

  async press(tabId: number, keys: string, repeat = 1) {
    return this.action(tabId, async (t) => {
      const steps: InputStep[] = [];
      for (let i = 0; i < Math.min(repeat, 50); i++) steps.push(...chordSteps(keys));
      const navBefore = Date.now();
      await this.client.request('input.batch', { tabId, steps });
      return { pressed: keys, repeat, ...(await this.#receiptAfter(t, navBefore)) };
    });
  }

  async scroll(tabId: number, opts: { target?: string; dx?: number; dy?: number; label?: string }) {
    return this.action(tabId, async (t) => {
      let pt: { x: number; y: number };
      if (opts.target) {
        const r = await this.#resolve(t, opts.target);
        pt = r.point ?? (await this.#pointFor(t, r.node!, true));
      } else {
        const m = await this.cdp<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(tabId, 'Page.getLayoutMetrics');
        pt = { x: Math.round(m.cssVisualViewport.clientWidth / 2), y: Math.round(m.cssVisualViewport.clientHeight / 2) };
      }
      const steps = this.#path(t, pt);
      const dx = opts.dx || 0;
      const dy = opts.dy ?? 600;
      const n = Math.max(1, Math.min(20, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 200)));
      for (let i = 0; i < n; i++) steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: dx / n, deltaY: dy / n }, delayMs: 24 });
      await this.client.request('input.batch', { tabId, steps, label: opts.label || 'scroll' });
      await sleep(250);
      const pos = await this.cdp<{ result: { value: { x: number; y: number; maxY: number } } }>(tabId, 'Runtime.evaluate', {
        expression: '({x: scrollX, y: scrollY, maxY: document.documentElement.scrollHeight - innerHeight})', returnByValue: true,
      });
      return { scrolledAt: pt, delta: { dx, dy }, scroll: pos.result.value };
    });
  }

  async drag(tabId: number, from: string, to: string, label?: string) {
    return this.action(tabId, async (t) => {
      const a = await this.#resolve(t, from);
      const pa = a.point ?? (await this.#pointFor(t, a.node!, true));
      const b = await this.#resolve(t, to);
      const pb = b.point ?? (await this.#pointFor(t, b.node!, true));
      const steps: InputStep[] = this.#path(t, pa);
      steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: pa.x, y: pa.y, button: 'left', clickCount: 1, buttons: 1 }, delayMs: 40 });
      const n = 12;
      const at = (i: number) => ({ x: pa.x + ((pb.x - pa.x) * i) / n, y: pa.y + ((pb.y - pa.y) * i) / n });
      // Pointer moves first. If the page starts a native HTML5 drag on one of them, the
      // extension intercepts it, skips the remaining pointer steps and runs the native ones
      // (drag events with the page's own drag data) instead; otherwise those are skipped.
      for (let i = 1; i <= n; i++) steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', ...at(i), button: 'left', buttons: 1 }, delayMs: 18, drag: 'pointer' });
      steps.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: pb.x, y: pb.y, button: 'left', clickCount: 1 }, delayMs: 40, drag: 'pointer' });
      steps.push({ method: 'Input.dispatchDragEvent', params: { type: 'dragEnter', ...at(1) }, drag: 'native' });
      for (let i = 2; i <= n; i++) steps.push({ method: 'Input.dispatchDragEvent', params: { type: 'dragOver', ...at(i) }, delayMs: 18, drag: 'native' });
      steps.push({ method: 'Input.dispatchDragEvent', params: { type: 'drop', x: pb.x, y: pb.y }, delayMs: 40, drag: 'native' });
      t.cursor = pb;
      // Native drag events go to the top page's process and cannot reach a cross-site
      // (out-of-process) iframe. The extension hit-tests the press origin and, right before
      // the drop, the drop point; if either is such an iframe it cancels the drag (the source
      // gets dragend) and reports crossFrame, rather than claim a drop that never happened.
      const r = await this.client.request<{ nativeDrag?: boolean; crossFrame?: boolean }>('input.batch', { tabId, steps, label: label || `drag ${a.desc} → ${b.desc}`.slice(0, 60) });
      if (r.nativeDrag && r.crossFrame) {
        throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, 'The page started a native HTML5 drag, and native drags into or out of a cross-site iframe cannot be completed from here; the drag was cancelled. Try the page\'s own alternative (a menu, buttons or keyboard reordering), or browser_evaluate.');
      }
      return { dragged: { from: pa, to: pb }, kind: r.nativeDrag ? 'html5' : 'pointer' };
    });
  }

  // -------------------------------------------------------------------------
  // Screenshots

  async screenshot(tabId: number, opts: { fullPage?: boolean; target?: string; format?: 'png' | 'jpeg' | 'webp'; quality?: number; path?: string; includeOverlay?: boolean; hiDpi?: boolean }) {
    return this.action(tabId, async (t) => {
      const format = opts.format || 'png';
      const params: Json = { format, ...(format !== 'png' && opts.quality ? { quality: opts.quality } : {}) };
      let clip: { x: number; y: number; width: number; height: number } | null = null;
      const m = await this.cdp<{ cssContentSize: { width: number; height: number }; cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number; scale?: number } }>(tabId, 'Page.getLayoutMetrics');
      if (opts.target) {
        const r = await this.#resolve(t, opts.target);
        if (!r.node) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'Screenshot target must be an element, not coordinates.');
        await this.cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: r.node.backendNodeId }, r.node.sessionId).catch(() => {});
        const q = await this.cdp<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { backendNodeId: r.node.backendNodeId }, r.node.sessionId);
        let quad = q.quads[0];
        if (r.node.sessionId && r.node.ownerBackendNodeId !== undefined) quad = await this.#frameToRoot(tabId, r.node.sessionId, r.node.ownerBackendNodeId, quad);
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        let box = { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
        // An element in a frame is cut to that frame's viewport, so the capture never shows the
        // page around the frame (the element can be larger than its frame).
        const inFrame = await this.#frameClip(tabId, r.node);
        if (inFrame) {
          if (inFrame.length < 4) throw new OvertakeError(ErrorCode.ELEMENT_NOT_ACTIONABLE, 'The element is outside the visible area of its frame.');
          const [u0, v0, u1, v1] = inFrame;
          const bw = box.right - box.x, bh = box.bottom - box.y;
          box = { x: box.x + u0 * bw, y: box.y + v0 * bh, right: box.x + u1 * bw, bottom: box.y + v1 * bh };
        }
        const vp = (await this.cdp<{ cssVisualViewport: { pageX: number; pageY: number } }>(tabId, 'Page.getLayoutMetrics')).cssVisualViewport;
        clip = { x: box.x + vp.pageX, y: box.y + vp.pageY, width: box.right - box.x, height: box.bottom - box.y };
        params.captureBeyondViewport = true;
      } else if (opts.fullPage) {
        clip = { x: 0, y: 0, width: Math.ceil(m.cssContentSize.width), height: Math.min(Math.ceil(m.cssContentSize.height), 16384) };
        params.captureBeyondViewport = true;
      }
      // CSS pixels by default, the units clicks take: on a HiDPI screen, a zoomed page or a
      // pinch-zoomed one, a device-pixel image would need every coordinate divided by the
      // device pixel ratio times the pinch zoom.
      const dprR = await this.cdp<{ result: { value?: number } }>(tabId, 'Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }).catch(() => null);
      const dpr = typeof dprR?.result.value === 'number' && dprR.result.value > 0 ? dprR.result.value : 1;
      const pinch = m.cssVisualViewport.scale && m.cssVisualViewport.scale > 0 ? m.cssVisualViewport.scale : 1;
      const factor = dpr * pinch;
      // A capture with a clip comes out at clip size times devicePixelRatio (pinch zoom does not
      // apply); one without, at the window's device pixels (pinch zoom applies).
      const clipped = !!clip;
      const native = clipped ? dpr : factor;
      const cssScale = !opts.hiDpi && Math.abs(native - 1) > 0.01;
      if (cssScale && !clip) clip = { x: m.cssVisualViewport.pageX, y: m.cssVisualViewport.pageY, width: m.cssVisualViewport.clientWidth, height: m.cssVisualViewport.clientHeight };
      if (clip) params.clip = { ...clip, scale: cssScale ? 1 / dpr : 1 };
      const r = await this.client.request<{ data: string }>('screenshot', { tabId, params, includeOverlay: !!opts.includeOverlay }, 60_000);
      const bytes = Buffer.from(r.data, 'base64');
      let savedTo: string | undefined;
      if (opts.path || bytes.length > 4_500_000) {
        const p = opts.path && isAbsolute(opts.path) ? opts.path : join(tmpdir(), `overtake-${tabId}-${Date.now()}.${format}`);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, bytes);
        savedTo = p;
      }
      return {
        data: bytes.length <= 4_500_000 ? r.data : undefined,
        mimeType: `image/${format}`,
        bytes: bytes.length,
        savedTo,
        viewport: { width: m.cssVisualViewport.clientWidth, height: m.cssVisualViewport.clientHeight },
        contentSize: m.cssContentSize,
        clip,
        fullPage: !!opts.fullPage,
        // Image pixels per CSS pixel: 1 unless hiDpi.
        scale: cssScale || Math.abs(native - 1) <= 0.01 ? 1 : Math.round(native * 1000) / 1000,
      };
    });
  }

  // -------------------------------------------------------------------------
  // JavaScript

  async evaluate(tabId: number, expression: string, opts: { frameId?: string; awaitPromise?: boolean; timeoutMs?: number } = {}) {
    return this.action(tabId, async (t) => {
      // Console-style (replMode: top-level await). The result comes back as a handle, not by
      // value: in replMode, awaitPromise awaits the top-level code, and a Promise it returns
      // (an async IIFE, say) would otherwise be serialized as {}. Such a Promise is awaited too.
      const group = `overtake-eval-${++evalGroup}`;
      const params: Json = { expression, returnByValue: false, objectGroup: group, awaitPromise: opts.awaitPromise !== false, replMode: true, userGesture: true, generatePreview: false };
      let sessionId: string | undefined;
      if (opts.frameId) {
        const child = [...t.children.entries()].find(([, v]) => v.targetId === opts.frameId);
        if (child) sessionId = child[0];
        else {
          const ctx = t.contexts.get(opts.frameId);
          if (!ctx) throw new OvertakeError(ErrorCode.BAD_REQUEST, `No execution context for frame ${opts.frameId}. List frames with browser_frames.`);
          params.contextId = ctx;
        }
      }
      if (opts.timeoutMs) params.timeout = opts.timeoutMs;
      type Remote = { type: string; subtype?: string; objectId?: string; value?: unknown; description?: string; unserializableValue?: string };
      type EvalResult = { result: Remote; exceptionDetails?: { text: string; exception?: { description?: string } } };
      let madeObjects = false;
      const budget = (opts.timeoutMs ?? 30_000) + 5000;
      const until = Date.now() + budget;
      try {
        let r = await this.cdp<EvalResult>(tabId, 'Runtime.evaluate', params, sessionId, budget);
        madeObjects = !!r.result.objectId || !!r.exceptionDetails;
        if (!r.exceptionDetails && r.result.subtype === 'promise' && r.result.objectId && opts.awaitPromise !== false) {
          r = await this.cdp<EvalResult>(tabId, 'Runtime.awaitPromise', { promiseObjectId: r.result.objectId, returnByValue: false }, sessionId, Math.max(until - Date.now(), 100));
        }
        if (r.exceptionDetails) {
          return { ok: false, exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
        }
        let v = r.result;
        if (v.objectId && v.subtype !== 'promise') {
          // Objects come back by value (JSON), as before.
          // Objects that are not JSON (cycles, say) fall back to their description.
          const j = await this.cdp<EvalResult>(tabId, 'Runtime.callFunctionOn', { objectId: v.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true }, sessionId, Math.max(until - Date.now(), 100))
            .catch((e) => { if (contextGone(e)) throw e; return null; });
          v = j && !j.exceptionDetails ? { ...j.result, type: v.type } : { type: v.type, description: v.description };
        }
        return { ok: true, type: v.type, value: v.value !== undefined ? v.value : v.unserializableValue ?? v.description };
      } catch (e) {
        // Not retried: the script may already have run in part (or caused the navigation).
        if (contextGone(e)) throw await this.#navigatedError(tabId);
        throw e;
      } finally {
        // Only when there is something to free: calls to a tab run in order, so a needless one
        // would wait behind a page that is now busy.
        if (madeObjects) void this.cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: group }, sessionId).catch(() => {});
      }
    });
  }

  /** The page navigated under a script. Wait briefly for the new document, then say where it is. */
  async #navigatedError(tabId: number): Promise<OvertakeError> {
    let info: { url: string; title: string; readyState: string } | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const left = Math.min(1000, deadline - Date.now());
      info = await within(this.pageInfo(tabId, left).catch(softFail(null)), left, null);
      if (info && info.readyState !== 'loading') break;
      await sleep(200);
    }
    const where = info ? `It is now at ${info.url} (readyState ${info.readyState}).` : 'The new page did not answer yet.';
    return new OvertakeError(ErrorCode.PAGE_NAVIGATED,
      `The page navigated while the script ran, so its result was lost; the script may have run in part. ${where} Wait for what you need with browser_wait (selector, text or urlIncludes), then evaluate again.`,
      info ?? undefined);
  }

  // -------------------------------------------------------------------------
  // Network / console / events

  network(tabId: number, opts: { urlIncludes?: string; type?: string; status?: number; failedOnly?: boolean; limit?: number }) {
    const t = this.#tab(tabId);
    let list = [...t.net.values()];
    if (opts.urlIncludes) list = list.filter((e) => e.url.includes(opts.urlIncludes!));
    if (opts.type) list = list.filter((e) => (e.type || '').toLowerCase() === opts.type!.toLowerCase());
    if (opts.status !== undefined) list = list.filter((e) => e.status === opts.status);
    if (opts.failedOnly) list = list.filter((e) => e.failed || (e.status ?? 0) >= 400);
    list = list.slice(-(opts.limit ?? 50));
    return list.map((e) => ({ requestId: e.requestId, method: e.method, url: redactUrl(e.url).slice(0, 300), type: e.type, status: e.status ?? (e.failed ? 'failed' : 'pending'), mimeType: e.mimeType, ms: e.endedAt ? e.endedAt - e.startedAt : undefined, bytes: e.encodedDataLength, failed: e.failed, fromCache: e.fromCache || undefined }));
  }

  async networkDetail(tabId: number, requestId: string, includeBody = true) {
    return this.action(tabId, async (t) => {
      const e = t.net.get(requestId);
      if (!e) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Unknown requestId ${requestId}; list requests first.`);
      let body: { body: string; base64Encoded: boolean } | null = null;
      let bodyError: string | undefined;
      if (includeBody && e.endedAt && !e.failed) {
        body = await this.cdp<{ body: string; base64Encoded: boolean }>(tabId, 'Network.getResponseBody', { requestId }, e.sessionId).catch((err) => {
          bodyError = (err as Error).message;
          return null;
        });
      }
      let postData = e.postData;
      if (!postData && e.hasPostData) postData = (await this.cdp<{ postData: string }>(tabId, 'Network.getRequestPostData', { requestId }, e.sessionId).catch(() => null))?.postData;
      const text = body ? (body.base64Encoded ? `[base64 ${body.body.length} chars]` : body.body) : undefined;
      // Credentials (auth headers, cookies, tokens, passwords) are masked: tool results reach the model and its logs.
      return redactNetworkEntry({ ...e, postData: postData?.slice(0, 20_000), responseBody: text?.slice(0, 100_000), responseBodyTruncated: (text?.length ?? 0) > 100_000, bodyError, redacted: true });
    });
  }

  clearNetwork(tabId: number) {
    this.#tab(tabId).net.clear();
  }

  consoleEntries(tabId: number, opts: { level?: string; sinceSeq?: number; limit?: number }) {
    let list = this.#tab(tabId).console;
    if (opts.sinceSeq) list = list.filter((e) => e.seq > opts.sinceSeq!);
    if (opts.level) list = list.filter((e) => e.level.includes(opts.level!));
    return list.slice(-(opts.limit ?? 100));
  }

  events(tabId: number, opts: { methodPrefix?: string; sinceSeq?: number; limit?: number }) {
    let list = this.#tab(tabId).events;
    if (opts.sinceSeq) list = list.filter((e) => e.seq > opts.sinceSeq!);
    if (opts.methodPrefix) list = list.filter((e) => e.method.startsWith(opts.methodPrefix!));
    return list.slice(-(opts.limit ?? 50)).map((e) => {
      const params = redactCdp(e.params); // Network/Fetch events carry headers and cookies
      const s = JSON.stringify(params);
      return { seq: e.seq, at: e.at, method: e.method, sessionId: e.sessionId, params: s.length > 4000 ? s.slice(0, 4000) + '…' : params };
    });
  }

  latestSeq(): number {
    return seq;
  }

  // -------------------------------------------------------------------------
  // Interception (Fetch domain)

  async #applyFetch(t: TabState) {
    if (!t.intercepts.length) {
      await this.cdp(t.tabId, 'Fetch.disable').catch(() => {});
      return;
    }
    await this.cdp(t.tabId, 'Fetch.enable', { patterns: t.intercepts.map((r) => ({ urlPattern: r.urlPattern, requestStage: 'Request' })) });
  }

  async #onRequestPaused(t: TabState, sessionId: string | undefined, p: Json) {
    const req = p.request as Json;
    const url = req.url as string;
    const rule = t.intercepts.find((r) => globToRegExp(r.urlPattern).test(url));
    const requestId = p.requestId as string;
    try {
      if (!rule) await this.cdp(t.tabId, 'Fetch.continueRequest', { requestId }, sessionId);
      else if (rule.block) {
        rule.hits++;
        await this.cdp(t.tabId, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
      } else if (rule.response) {
        rule.hits++;
        const headers = Object.entries(rule.response.headers).map(([name, value]) => ({ name, value }));
        await this.cdp(t.tabId, 'Fetch.fulfillRequest', { requestId, responseCode: rule.response.status, responseHeaders: headers, body: Buffer.from(rule.response.body).toString('base64') }, sessionId);
      }
    } catch {
      // Lost control mid-flight: the extension disables Fetch on take-over, which releases the request.
    }
  }

  async intercept(tabId: number, opts: { action: 'add' | 'remove' | 'list' | 'clear'; urlPattern?: string; block?: boolean; status?: number; body?: string; contentType?: string; headers?: Record<string, string>; ruleId?: number }) {
    return this.action(tabId, async (t) => {
      if (opts.action === 'add') {
        if (!opts.urlPattern) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'urlPattern is required.');
        const rule: InterceptRule = {
          id: t.intercepts.reduce((m, r) => Math.max(m, r.id), 0) + 1,
          urlPattern: opts.urlPattern,
          block: !!opts.block,
          response: opts.block ? undefined : { status: opts.status ?? 200, headers: { 'content-type': opts.contentType || 'application/json', ...(opts.headers || {}) }, body: opts.body ?? '' },
          hits: 0,
        };
        t.intercepts.push(rule);
      } else if (opts.action === 'remove') t.intercepts = t.intercepts.filter((r) => r.id !== opts.ruleId);
      else if (opts.action === 'clear') t.intercepts = [];
      if (opts.action !== 'list') await this.#applyFetch(t);
      return { rules: t.intercepts.map((r) => ({ id: r.id, urlPattern: r.urlPattern, mode: r.block ? 'block' : `fulfill ${r.response?.status}`, hits: r.hits })) };
    });
  }

  // -------------------------------------------------------------------------
  // Emulation

  async emulate(tabId: number, opts: { device?: string; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; userAgent?: string; touch?: boolean; colorScheme?: 'light' | 'dark'; offline?: boolean; reset?: boolean }) {
    return this.action(tabId, async () => {
      if (opts.reset) {
        await this.cdp(tabId, 'Emulation.clearDeviceMetricsOverride');
        await this.cdp(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
        await this.cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
        await this.cdp(tabId, 'Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
        await this.cdp(tabId, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
        return { reset: true };
      }
      const dev = opts.device ? DEVICES[opts.device] : undefined;
      if (opts.device && !dev) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Unknown device "${opts.device}". Known: ${Object.keys(DEVICES).join(', ')}`);
      const width = opts.width ?? dev?.width;
      const height = opts.height ?? dev?.height;
      const applied: Json = {};
      if (width && height) {
        const metrics = { width, height, deviceScaleFactor: opts.deviceScaleFactor ?? dev?.deviceScaleFactor ?? 1, mobile: opts.mobile ?? dev?.mobile ?? false };
        await this.cdp(tabId, 'Emulation.setDeviceMetricsOverride', metrics);
        applied.metrics = metrics;
      }
      const ua = opts.userAgent ?? dev?.userAgent;
      if (ua) {
        await this.cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: ua });
        applied.userAgent = ua;
      }
      const touch = opts.touch ?? dev?.mobile;
      if (touch !== undefined) {
        await this.cdp(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
        applied.touch = touch;
      }
      if (opts.colorScheme) {
        await this.cdp(tabId, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.colorScheme }] });
        applied.colorScheme = opts.colorScheme;
      }
      if (opts.offline !== undefined) {
        await this.cdp(tabId, 'Network.emulateNetworkConditions', { offline: opts.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        applied.offline = opts.offline;
      }
      return { applied };
    });
  }

  // -------------------------------------------------------------------------
  // Performance tracing

  async traceStart(tabId: number, categories?: string[]) {
    return this.action(tabId, async (t) => {
      if (t.tracing) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'A trace is already running for this tab.');
      t.tracing = { chunks: [], done: null };
      try {
        await this.cdp(tabId, 'Tracing.start', {
          transferMode: 'ReportEvents',
          traceConfig: { includedCategories: categories?.length ? categories : ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'loading', 'latencyInfo'] },
        });
      } catch (e) {
        t.tracing = null;
        throw e;
      }
      await this.cdp(tabId, 'Performance.enable').catch(() => {});
      return { tracing: true };
    });
  }

  async traceStop(tabId: number, path?: string) {
    return this.action(tabId, async (t) => {
      if (!t.tracing) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'No trace is running for this tab.');
      const tr = t.tracing;
      const done = new Promise<void>((resolve) => {
        tr.done = () => resolve();
        setTimeout(resolve, 20_000);
      });
      await this.cdp(tabId, 'Tracing.end');
      await done;
      t.tracing = null;
      const events = tr.chunks.map((c) => JSON.parse(c) as { name?: string; dur?: number; cat?: string });
      const metrics = await this.cdp<{ metrics: { name: string; value: number }[] }>(tabId, 'Performance.getMetrics').catch(() => ({ metrics: [] }));
      const out = path && isAbsolute(path) ? path : join(tmpdir(), `overtake-trace-${tabId}-${Date.now()}.json`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify({ traceEvents: events }));
      const longTasks = events.filter((e) => e.name === 'RunTask' && (e.dur ?? 0) > 50_000).length;
      const pick = ['JSHeapUsedSize', 'Nodes', 'LayoutCount', 'RecalcStyleCount', 'ScriptDuration', 'TaskDuration'];
      return { savedTo: out, eventCount: events.length, longTasksOver50ms: longTasks, metrics: Object.fromEntries(metrics.metrics.filter((m) => pick.includes(m.name)).map((m) => [m.name, m.value])), note: 'Open the file in Chrome DevTools > Performance > Load profile.' };
    });
  }

  // -------------------------------------------------------------------------
  // JavaScript debugging

  async debug(tabId: number, opts: { action: string; url?: string; urlRegex?: string; line?: number; column?: number; condition?: string; breakpointId?: string; expression?: string }) {
    // While paused, the action that triggered the pause still holds the space lock;
    // inspection and resume must not wait behind it (they use the extension's immediate lane).
    const unlocked = ['state', 'evaluate', 'resume', 'step_over', 'step_into', 'step_out'].includes(opts.action);
    const run = unlocked ? async <T>(fn: (t: TabState) => Promise<T>) => fn(this.#tab(tabId)) : <T>(fn: (t: TabState) => Promise<T>) => this.action(tabId, fn);
    return run(async (t) => {
      switch (opts.action) {
        case 'enable':
          await this.cdp(tabId, 'Debugger.enable', { maxScriptsCacheSize: 10_000_000 });
          return { enabled: true };
        case 'disable':
          await this.cdp(tabId, 'Debugger.disable');
          t.paused = null;
          return { enabled: false };
        case 'set_breakpoint': {
          if (opts.line === undefined || (!opts.url && !opts.urlRegex)) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'url (or urlRegex) and line (1-based) are required.');
          await this.cdp(tabId, 'Debugger.enable', {});
          const r = await this.cdp<{ breakpointId: string; locations: unknown[] }>(tabId, 'Debugger.setBreakpointByUrl', { lineNumber: opts.line - 1, columnNumber: opts.column, ...(opts.urlRegex ? { urlRegex: opts.urlRegex } : { url: opts.url }), condition: opts.condition });
          return r;
        }
        case 'remove_breakpoint':
          await this.cdp(tabId, 'Debugger.removeBreakpoint', { breakpointId: opts.breakpointId });
          return { removed: opts.breakpointId };
        case 'pause':
          await this.cdp(tabId, 'Debugger.pause');
          await sleep(100);
          return this.#pausedState(t);
        case 'resume':
        case 'step_over':
        case 'step_into':
        case 'step_out': {
          const m = { resume: 'Debugger.resume', step_over: 'Debugger.stepOver', step_into: 'Debugger.stepInto', step_out: 'Debugger.stepOut' }[opts.action]!;
          await this.cdp(tabId, m);
          await sleep(opts.action === 'resume' ? 50 : 150);
          return opts.action === 'resume' ? { resumed: true } : this.#pausedState(t);
        }
        case 'state':
          return this.#pausedState(t);
        case 'evaluate': {
          const p = t.paused as { callFrames?: { callFrameId: string }[] } | null;
          if (!p?.callFrames?.length) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'Not paused.');
          const r = await this.cdp<{ result: { value?: unknown; description?: string }; exceptionDetails?: { text: string } }>(tabId, 'Debugger.evaluateOnCallFrame', { callFrameId: p.callFrames[0].callFrameId, expression: opts.expression || 'undefined', returnByValue: true });
          return r.exceptionDetails ? { ok: false, exception: r.exceptionDetails.text } : { ok: true, value: r.result.value ?? r.result.description };
        }
      }
      throw new OvertakeError(ErrorCode.BAD_REQUEST, `Unknown debug action ${opts.action}`);
    });
  }

  async #pausedState(t: TabState) {
    const p = t.paused as { reason: string; hitBreakpoints?: string[]; callFrames: { callFrameId: string; functionName: string; url: string; location: { lineNumber: number; columnNumber: number }; scopeChain: { type: string; object: { objectId?: string } }[] }[] } | null;
    if (!p) return { paused: false };
    const frames = p.callFrames.slice(0, 6).map((f) => ({ function: f.functionName || '<anonymous>', url: f.url, line: f.location.lineNumber + 1, column: f.location.columnNumber + 1 }));
    let locals: Record<string, unknown> = {};
    const local = p.callFrames[0]?.scopeChain.find((s) => s.type === 'local');
    if (local?.object.objectId) {
      const props = await this.cdp<{ result: { name: string; value?: { value?: unknown; description?: string; type: string } }[] }>(t.tabId, 'Runtime.getProperties', { objectId: local.object.objectId, ownProperties: true }).catch(() => ({ result: [] }));
      locals = Object.fromEntries(props.result.slice(0, 30).map((pr) => [pr.name, pr.value ? pr.value.value ?? pr.value.description ?? pr.value.type : undefined]));
    }
    return { paused: true, reason: p.reason, hitBreakpoints: p.hitBreakpoints, callFrames: frames, locals };
  }

  // -------------------------------------------------------------------------
  // Frames, dialogs

  async frames(tabId: number) {
    return this.action(tabId, async (t) => {
      const tree = await this.cdp<{ frameTree: { frame: { id: string; url: string; name?: string }; childFrames?: unknown[] } }>(tabId, 'Page.getFrameTree');
      const out: { frameId: string; url: string; name?: string; depth: number; outOfProcess: boolean; sessionId?: string }[] = [];
      const walk = (ft: { frame: { id: string; url: string; name?: string }; childFrames?: unknown[] }, depth: number) => {
        const child = [...t.children.entries()].find(([, v]) => v.targetId === ft.frame.id);
        out.push({ frameId: ft.frame.id, url: ft.frame.url, name: ft.frame.name, depth, outOfProcess: !!child, sessionId: child?.[0] });
        for (const c of (ft.childFrames || []) as typeof ft[]) walk(c, depth + 1);
      };
      walk(tree.frameTree, 0);
      // OOPIFs appear in the main frame tree only as placeholders on some versions; list sessions too.
      for (const [sid, v] of t.children) if (v.type === 'iframe' && !out.some((f) => f.frameId === v.targetId)) out.push({ frameId: v.targetId, url: v.url, depth: 1, outOfProcess: true, sessionId: sid });
      return { frames: out };
    });
  }

  /**
   * Put local files into a file input. A target that is (or resolves to) an <input type=file>
   * is set directly; anything else is clicked with the native file chooser intercepted, and
   * the files go to the input that opened it. The page receives normal input/change events.
   */
  async upload(tabId: number, target: string, files: string[], label?: string) {
    if (!files.length) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'Give at least one file.');
    for (const f of files) {
      if (!isAbsolute(f)) throw new OvertakeError(ErrorCode.BAD_REQUEST, `File paths must be absolute: ${f}`);
      const st = await stat(f).catch(() => null);
      if (!st?.isFile()) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Not a readable file: ${f}`);
    }
    const direct = await this.action(tabId, async (t) => {
      const r = await this.#resolve(t, target);
      if (!r.node) return null;
      const sid = r.node.sessionId;
      let objectId = r.node.objectId;
      if (!objectId) objectId = (await this.cdp<{ object: { objectId: string } }>(tabId, 'DOM.resolveNode', { backendNodeId: r.node.backendNodeId }, sid)).object.objectId;
      const info = await this.cdp<{ result: { value: { multiple: boolean } | null } }>(tabId, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function(){ return this.localName === 'input' && this.type === 'file' ? { multiple: this.multiple } : null; }`,
      }, sid);
      void this.cdp(tabId, 'Runtime.releaseObject', { objectId }, sid).catch(() => {});
      const v = info.result.value;
      if (!v) return null;
      if (files.length > 1 && !v.multiple) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'This file input accepts a single file.');
      await this.cdp(tabId, 'DOM.setFileInputFiles', { files, backendNodeId: r.node.backendNodeId }, sid);
      return { uploaded: files.length, via: 'input', target: r.desc };
    });
    if (direct) return direct;
    const t = this.#tab(tabId);
    let waiter: ((p: { backendNodeId: number; mode: string; sessionId?: string }) => void) | null = null;
    const opened = new Promise<{ backendNodeId: number; mode: string; sessionId?: string }>((resolve, reject) => {
      waiter = resolve;
      t.chooserWaiters.add(resolve);
      setTimeout(() => reject(new OvertakeError(ErrorCode.TIMEOUT, `Clicking ${target} did not open a file chooser within 5 s.`)), 5000);
    });
    opened.catch(() => {});
    await this.cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      await this.click(tabId, target, { label: label || 'Choose a file' });
      const ev = await opened;
      if (files.length > 1 && ev.mode !== 'selectMultiple') throw new OvertakeError(ErrorCode.BAD_REQUEST, 'This file chooser accepts a single file.');
      await this.cdp(tabId, 'DOM.setFileInputFiles', { files, backendNodeId: ev.backendNodeId }, ev.sessionId);
      return { uploaded: files.length, via: 'chooser', mode: ev.mode };
    } finally {
      if (waiter) t.chooserWaiters.delete(waiter);
      await this.cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
    }
  }

  /**
   * Downloads started from a Space (Chrome saves them to the user's download folder; changing
   * that is profile-wide and denied). wait: until the given (or newest recent) download finishes.
   * save: copy a finished download to an absolute path.
   */
  async downloads(spaceId: number, opts: { action: 'list' | 'wait' | 'save'; downloadId?: number; sinceMs?: number; timeoutMs?: number; path?: string }) {
    type D = { downloadId: number; url: string; filename: string; state: string; startTime: string; error?: string; bytesReceived: number; totalBytes: number };
    const list = async () => (await this.client.request<{ downloads: D[] }>('downloads.list', { spaceId })).downloads;
    if (opts.action === 'list') return { downloads: await list() };
    if (opts.action === 'save') {
      if (opts.downloadId === undefined || !opts.path) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'save needs downloadId and path.');
      if (!isAbsolute(opts.path)) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'path must be absolute.');
      const d = (await list()).find((x) => x.downloadId === opts.downloadId);
      if (!d) throw new OvertakeError(ErrorCode.BAD_REQUEST, `Download ${opts.downloadId} is not one of this Space's downloads.`);
      if (d.state !== 'complete') throw new OvertakeError(ErrorCode.BAD_REQUEST, `Download ${d.downloadId} is ${d.state}; wait for it first.`);
      await mkdir(dirname(opts.path), { recursive: true });
      await copyFile(d.filename, opts.path);
      return { saved: opts.path, from: d.filename, bytes: d.totalBytes || d.bytesReceived };
    }
    const since = opts.sinceMs ?? Date.now() - 15_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    for (;;) {
      const all = await list();
      const d = opts.downloadId !== undefined
        ? all.find((x) => x.downloadId === opts.downloadId)
        : all.filter((x) => Date.parse(x.startTime) >= since).sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))[0];
      if (d?.state === 'complete') return { download: d };
      if (d?.state === 'interrupted') throw new OvertakeError(ErrorCode.BAD_REQUEST, `Download ${d.downloadId} failed: ${d.error ?? 'interrupted'}.`);
      if (Date.now() > deadline) throw new OvertakeError(ErrorCode.TIMEOUT, d ? `Download ${d.downloadId} still ${d.state} (${d.bytesReceived}/${d.totalBytes} bytes).` : 'No download from this Space started in the time window.');
      await sleep(250);
    }
  }

  async dialog(tabId: number, accept: boolean, promptText?: string) {
    const t = this.#tab(tabId);
    if (!t.dialog) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'No JavaScript dialog is open on this tab.');
    await this.cdp(tabId, 'Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) });
    const was = t.dialog;
    t.dialog = null;
    return { handled: was, accepted: accept };
  }

  pendingDialog(tabId: number) {
    return this.#tabs.get(tabId)?.dialog ?? null;
  }
}
