// Overtake service worker: the authority for Spaces, ownership, the input gate and
// every CDP command: space and ownership are validated here before any agent CDP
// message reaches a tab.

import { DebuggerManager } from './debugger.ts';
import { checkCdpMethod } from './cdp-policy.ts';
import { broadcastState, sendAllFramesAcked, sendTop, sendTopAcked, type OverlayState, type Permit } from './overlay-link.ts';
import { initialControl, transition, gate, shieldActive, type ControlSnapshot, type ControlEvent } from '../../../shared/control.ts';
import { SpaceExecutor } from '../../../shared/executor.ts';
import {
  OvertakeError, ErrorCode, NATIVE_HOST_NAME, PROTOCOL_VERSION, toWireError,
  type AgentEvent, type BrokerToExtension, type ExtensionToBroker, type InputStep, type Operation, type SpaceSummary, type SpaceTab,
} from '../../../shared/protocol.ts';

// ---------------------------------------------------------------------------
// State

interface Space {
  id: number;
  name: string;
  windowId: number | null;
  groupId: number | null;
  createdBy: 'agent' | 'user';
  ctl: ControlSnapshot;
  ownerName: string | null;
  statusText: string;
  error: string | null;
  tabs: Map<number, { tabId: number; openedBy: 'agent' | 'user'; managed: boolean }>;
  createdAt: number;
}

interface PersistedSpace extends Omit<Space, 'tabs'> {
  tabs: { tabId: number; openedBy: 'agent' | 'user'; managed: boolean }[];
}

const spaces = new Map<number, Space>();
const executors = new Map<number, SpaceExecutor>();
const agents = new Map<string, { name: string; connected: boolean }>();
let nextSpaceId = 1;
let strictInputGate: boolean | null = null; // Input.setIgnoreInputEvents usable via chrome.debugger?
const busyTimers = new Map<number, ReturnType<typeof setTimeout>>();
const pendingAgentTabs = new Set<number>(); // tabs being created by tabs.create
const lastAgentAt = new Map<number, number>(); // spaceId -> last gated agent command
const spaceDownloads = new Map<number, number[]>(); // spaceId -> chrome.downloads ids

const dbg = new DebuggerManager(onCdpEvent, onDebuggerDetach, (tabId) => {
  const s = spaceOfTab(tabId);
  if (s?.ctl.owner) emit(s.ctl.owner, { type: 'debugger-attached', tabId });
});

// ---------------------------------------------------------------------------
// Persistence (survives service-worker restarts within a browser session)

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data: PersistedSpace[] = [...spaces.values()].map((s) => ({ ...s, tabs: [...s.tabs.values()] }));
    void chrome.storage.session.set({ spaces: data, nextSpaceId });
  }, 50);
}

async function restore() {
  const { spaces: saved = [], nextSpaceId: n = 1 } = (await chrome.storage.session.get(['spaces', 'nextSpaceId'])) as { spaces?: PersistedSpace[]; nextSpaceId?: number };
  nextSpaceId = n;
  const windows = new Set((await chrome.windows.getAll()).map((w) => w.id));
  for (const s of saved) {
    if (s.windowId === null || !windows.has(s.windowId)) continue;
    const space: Space = { ...s, tabs: new Map(s.tabs.map((t) => [t.tabId, t])) };
    // Agents are unknown after a restart: never come back up in an agent state.
    if (space.ctl.owner) {
      const r = transition(space.ctl, { type: 'AGENT_DISCONNECTED', agent: space.ctl.owner });
      if (r.ok) space.ctl = r.state;
    }
    spaces.set(space.id, space);
    await reconcileTabs(space);
    pushOverlay(space);
  }
}

// ---------------------------------------------------------------------------
// Summaries and notifications

function summary(s: Space): SpaceSummary {
  return {
    spaceId: s.id,
    name: s.name,
    windowId: s.windowId,
    groupId: s.groupId,
    createdBy: s.createdBy,
    owner: s.ctl.owner,
    ownerName: s.ctl.owner ? agents.get(s.ctl.owner)?.name || s.ownerName : null,
    ownerConnected: s.ctl.ownerConnected,
    control: s.ctl.control,
    userReason: s.ctl.userReason,
    statusText: s.statusText,
    actionRequired: s.ctl.actionRequired,
    error: s.error,
    tabs: [...s.tabs.values()].map((t) => ({ ...t, ...(tabInfo.get(t.tabId) || {}) })) as SpaceTab[],
    isolation: 'shared-profile',
    createdAt: s.createdAt,
  };
}

const tabInfo = new Map<number, { url?: string; title?: string; active?: boolean }>();

function overlayStateFor(s: Space | undefined): OverlayState {
  if (!s) {
    return { shield: false, control: 'NONE', spaceId: null, spaceName: '', ownerName: null, ownerConnected: false, statusText: '', actionRequired: null, userReason: null, inSpace: false, error: null, suppressForeignFrames: false };
  }
  const sum = summary(s);
  return {
    shield: shieldActive(s.ctl),
    control: s.ctl.control,
    spaceId: s.id,
    spaceName: s.name,
    ownerName: sum.ownerName,
    ownerConnected: s.ctl.ownerConnected,
    statusText: s.statusText,
    actionRequired: s.ctl.actionRequired,
    userReason: s.ctl.userReason,
    inSpace: true,
    error: s.error,
    suppressForeignFrames: s.ctl.owner !== null,
  };
}

function pushOverlay(s: Space) {
  const st = overlayStateFor(s);
  for (const tabId of s.tabs.keys()) broadcastState(tabId, st);
}

function emit(agentKey: string | null, event: AgentEvent) {
  brokerSend({ t: 'evt', agentKey, event });
}

const uiPorts = new Set<chrome.runtime.Port>();
let uiTimer: ReturnType<typeof setTimeout> | null = null;
function pushUi() {
  if (uiTimer) return;
  uiTimer = setTimeout(() => {
    uiTimer = null;
    const msg = uiSnapshot();
    for (const p of uiPorts) {
      try {
        p.postMessage(msg);
      } catch {
        uiPorts.delete(p);
      }
    }
  }, 60);
}

function uiSnapshot() {
  return {
    type: 'overtake:spaces',
    spaces: [...spaces.values()].map(summary),
    agents: [...agents.entries()].map(([agentKey, a]) => ({ agentKey, ...a })),
    brokerConnected: brokerPort !== null,
    strictInputGate,
  };
}

/** Commit a control transition: persist, update overlays, wake the executor, tell agents and UI. */
function applyControl(s: Space, ev: ControlEvent): { ok: true } | { ok: false; code: string; message: string } {
  const prevOwner = s.ctl.owner;
  const r = transition(s.ctl, ev);
  if (!r.ok) return r;
  s.ctl = r.state;
  if (s.ctl.owner) s.ownerName = agents.get(s.ctl.owner)?.name || s.ownerName;
  if (r.changed) {
    persist();
    pushOverlay(s);
    executors.get(s.id)?.notify();
    const sum = summary(s);
    emit(null, { type: 'control', space: sum });
    if (prevOwner && prevOwner !== s.ctl.owner) emit(prevOwner, { type: 'control', space: sum });
    pushUi();
    updateBadge();
  }
  return { ok: true };
}

function updateBadge() {
  const running = [...spaces.values()].filter((s) => s.ctl.control === 'AGENT_CONTROL').length;
  const needs = [...spaces.values()].some((s) => s.ctl.userReason === 'handoff');
  void chrome.action.setBadgeText({ text: needs ? '!' : running ? String(running) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: needs ? '#f59f00' : '#1c1c1e' });
}

// ---------------------------------------------------------------------------
// Lookup helpers

function getSpace(spaceId: unknown): Space {
  const s = typeof spaceId === 'number' ? spaces.get(spaceId) : undefined;
  if (!s) throw new OvertakeError(ErrorCode.SPACE_NOT_FOUND, `Space ${String(spaceId)} does not exist.`);
  return s;
}

function spaceOfTab(tabId: number): Space | undefined {
  for (const s of spaces.values()) if (s.tabs.has(tabId)) return s;
  return undefined;
}

// Why a tab left its Space (Space closed, tab closed, by whom). Without this, the agent's
// next call on that tab only gets TAB_NOT_IN_SPACE and has to guess what happened.
// Chrome does not reuse tab ids within a session; the map is capped and in memory only.
const goneTabs = new Map<number, { code: string; message: string }>();
function rememberGone(tabId: number, code: string, message: string) {
  if (goneTabs.has(tabId)) return; // the first, most specific reason wins
  goneTabs.set(tabId, { code, message });
  if (goneTabs.size > 500) goneTabs.delete(goneTabs.keys().next().value!);
}
function rememberSpaceGone(s: Space, code: string, message: string) {
  for (const tabId of s.tabs.keys()) rememberGone(tabId, code, message);
}
/** A live tab joins a Space: any earlier "gone" reason for it no longer applies. */
function addTab(s: Space, entry: Parameters<Space['tabs']['set']>[1]) {
  goneTabs.delete(entry.tabId);
  s.tabs.set(entry.tabId, entry);
}
// The reason for a close the extension starts itself, read by windows.onRemoved, which can
// fire before chrome.windows.remove() resolves.
const closingSpaces = new Map<number, { code: string; message: string }>();
async function closeSpaceWindow(s: Space, code: string, message: string) {
  closingSpaces.set(s.id, { code, message });
  rememberSpaceGone(s, code, message);
  if (s.windowId !== null) await chrome.windows.remove(s.windowId).catch(() => {});
  endSpace(s, code, message);
}

function notInSpace(tabId: number): OvertakeError {
  const g = goneTabs.get(tabId);
  if (g) return new OvertakeError(g.code, `${g.message} Tab ${tabId} is gone; check spaces_list or create a new Space if the user wants you to continue.`);
  return new OvertakeError(ErrorCode.TAB_NOT_IN_SPACE, `Tab ${tabId} is not in any agent Space. Agents only operate tabs inside their Spaces.`);
}

function spaceOfWindow(windowId: number): Space | undefined {
  for (const s of spaces.values()) if (s.windowId === windowId) return s;
  return undefined;
}

function requireOwner(s: Space, agentKey: string) {
  if (s.ctl.owner === agentKey) return;
  if (s.ctl.control === 'STOPPED') throw new OvertakeError(ErrorCode.STOPPED, `The human stopped the agent in Space ${s.id}. Claim it again only if the user asks.`);
  throw new OvertakeError(ErrorCode.NOT_OWNER, `Space ${s.id} is not owned by this agent. Use space_claim first.`);
}

function managedTab(agentKey: string, tabId: unknown): { space: Space; tabId: number } {
  if (typeof tabId !== 'number') throw new OvertakeError(ErrorCode.BAD_REQUEST, 'tabId must be a number.');
  const space = spaceOfTab(tabId);
  if (!space) throw notInSpace(tabId);
  requireOwner(space, agentKey);
  const t = space.tabs.get(tabId)!;
  if (!t.managed) throw new OvertakeError(ErrorCode.TAB_NOT_MANAGED, `Tab ${tabId} was opened by the user; adopt it with browser_tabs {action:"adopt"} before operating it.`);
  return { space, tabId };
}

function executorFor(s: Space): SpaceExecutor {
  let ex = executors.get(s.id);
  if (!ex) {
    ex = new SpaceExecutor({ gate: (agent) => gate(spaces.get(s.id)?.ctl ?? s.ctl, agent) });
    executors.set(s.id, ex);
  }
  return ex;
}

/** Run an agent command for a space through its serialized, gated queue. */
const COMMAND_DEADLINE_MS = 45_000;

/** Run an agent command for a space through its serialized, gated queue. A command
 *  that exceeds its deadline fails with TIMEOUT and frees the queue (chrome.debugger
 *  calls cannot be cancelled, but they must never wedge a Space). */
/** browser_run runs that have ended (agentKey:runId): their queued commands must not run. */
const endedRuns = new Set<string>();
/** Commands per run still queued or running; a run's marker is kept while any remain. */
const runOutstanding = new Map<string, number>();
function endRun(runKey: string) {
  endedRuns.add(runKey);
  // Keep the set small, but never drop a marker that queued work can still look up.
  for (const k of endedRuns) {
    if (endedRuns.size <= 1000) break;
    if (!runOutstanding.get(k)) endedRuns.delete(k);
  }
}

function runGated<T>(s: Space, agentKey: string, label: string, fn: () => Promise<T>, opts: { tabId?: number; pausedTimeoutMs?: number; deadlineMs?: number; runKey?: string } = {}): Promise<T> {
  const runKey = opts.runKey;
  if (runKey !== undefined) runOutstanding.set(runKey, (runOutstanding.get(runKey) ?? 0) + 1);
  const done = () => {
    if (runKey === undefined) return;
    const n = (runOutstanding.get(runKey) ?? 1) - 1;
    if (n > 0) runOutstanding.set(runKey, n);
    else runOutstanding.delete(runKey);
  };
  const p = executorFor(s).submit(
    agentKey,
    async () => {
      if (opts.runKey !== undefined && endedRuns.has(opts.runKey)) {
        throw new OvertakeError(ErrorCode.STOPPED, `${label} was queued by a script run that has ended, so it did not run.`);
      }
      // Re-validate at execution time: the tab may have closed or left the space while queued.
      if (opts.tabId !== undefined) {
        const cur = spaceOfTab(opts.tabId);
        if (!cur) throw notInSpace(opts.tabId);
        if (cur.id !== s.id) throw new OvertakeError(ErrorCode.TAB_CLOSED, `Tab ${opts.tabId} left the Space before the command ran.`);
      }
      setBusy(s, true, label);
      lastAgentAt.set(s.id, Date.now());
      const deadline = opts.deadlineMs ?? COMMAND_DEADLINE_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new OvertakeError(ErrorCode.TIMEOUT, `${label} did not finish within ${deadline} ms; the Space's queue was released.`)), deadline);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        setBusy(s, false);
      }
    },
    { label, pausedTimeoutMs: opts.pausedTimeoutMs },
  );
  p.then(done, done);
  return p;
}

function setBusy(s: Space, busy: boolean, label?: string) {
  const prev = busyTimers.get(s.id);
  if (prev) clearTimeout(prev);
  const send = (b: boolean) => {
    for (const tabId of s.tabs.keys()) sendTop(tabId, { type: 'overtake:busy', busy: b, label });
  };
  if (busy) send(true);
  else busyTimers.set(s.id, setTimeout(() => send(false), 700));
}

// ---------------------------------------------------------------------------
// The input gate (see docs/architecture.md, "Input gate")
//
// Between actions the in-page shield blocks human input but keeps the dock
// clickable. For an agent burst:
//   1. Input.setIgnoreInputEvents(true): Chrome drops human input for the page
//   2. tell every frame's shield to let input pass (acknowledged per frame)
//   3. per step: re-check control, open the native gate, dispatch, close it
//   4. restore shields, reopen native input
// If the debugger detaches at any point, Chrome resets the ignore flag, so a
// crash cannot leave the page locked.

async function setNativeIgnore(tabId: number, ignore: boolean) {
  if (strictInputGate === false) return;
  try {
    await dbg.send(tabId, 'Input.setIgnoreInputEvents', { ignore });
    strictInputGate = true;
  } catch (e) {
    if (e instanceof OvertakeError && e.code === ErrorCode.CDP_ERROR) strictInputGate = false;
    else throw e;
  }
}

const MOUSE_TYPES: Record<string, string[]> = {
  mouseMoved: ['pointermove', 'mousemove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave'],
  mousePressed: ['pointerdown', 'mousedown', 'contextmenu', 'dragstart'],
  mouseReleased: ['pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'],
  mouseWheel: ['wheel'],
};

/** The DOM events one input step will cause, so the in-page shield admits exactly those. */
function permitFor(step: InputStep, held: boolean): Permit {
  const p = step.params as Record<string, unknown>;
  if (step.method === 'Input.dispatchMouseEvent' && typeof p.x === 'number' && typeof p.y === 'number' && !step.sessionId) {
    // A move with the agent's button held can start a native drag: Chrome fires dragstart
    // at the press origin, not at this point.
    const loose = (held || (typeof p.buttons === 'number' && p.buttons > 0)) && p.type === 'mouseMoved' ? ['dragstart'] : undefined;
    return { types: MOUSE_TYPES[String(p.type)] || [], x: p.x, y: p.y, ...(loose ? { loose } : {}) };
  }
  if (step.method === 'Input.dispatchDragEvent') {
    // Only drop is blocked by the shield (enter, over, leave and end are not). Native drag
    // events reach the page even while Chrome ignores input, so a drop is admitted once, while
    // this step is dispatched, and only carrying this burst's secret mark (see DRAG_MARK). A
    // step sent to a child frame's session has that frame's coordinates: no point check.
    if (p.type !== 'drop') return { types: [] };
    const mark = (p.data as { items?: { mimeType: string; data: string }[] } | undefined)?.items?.find((i) => i?.mimeType === DRAG_MARK);
    const at = typeof p.x === 'number' && typeof p.y === 'number' && !step.sessionId ? { x: p.x, y: p.y } : {};
    return { types: mark ? ['drop'] : [], ...at, drop: mark ? [{ mimeType: DRAG_MARK, data: mark.data }] : [] };
  }
  if (step.method === 'Input.dispatchKeyEvent') {
    return { types: ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut'], key: typeof p.key === 'string' ? p.key : undefined };
  }
  if (step.method === 'Input.insertText' || step.method === 'Input.imeSetComposition') return { types: ['beforeinput', 'input', 'keydown', 'keyup'] };
  return { types: ['*'] };
}

/** Every agent drag event carries this type with a fresh secret per burst, and the shield
 *  admits a drop only when it carries the current one: payload matching alone cannot tell the
 *  agent's drop from a human's, since native drag events bypass Chrome's input gate. */
const DRAG_MARK = 'application/x-overtake-drag';

function markDrag(params: Record<string, unknown>, secret: string): Record<string, unknown> {
  const data = params.data as { items?: { mimeType: string; data: string }[] } | undefined;
  if (!data || typeof data !== 'object') return params;
  const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i?.mimeType !== DRAG_MARK);
  return { ...params, data: { ...data, items: [...items, { mimeType: DRAG_MARK, data: secret }] } };
}

/** Whether a native drag event at this point would land on a frame owner element. Drag events go
 *  to the top page's process, and the hit test goes through same-process frames to their
 *  content, so a frame element here is a cross-site iframe the drop cannot reach. Run during
 *  the burst, when the shield overlay is inert and not hit. */
async function overRemoteFrame(tabId: number, x: number, y: number): Promise<boolean> {
  try {
    const hit = (await dbg.send(tabId, 'DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y) })) as { backendNodeId: number };
    const d = (await dbg.send(tabId, 'DOM.describeNode', { backendNodeId: hit.backendNodeId })) as { node: { nodeName: string } };
    return d.node.nodeName === 'IFRAME' || d.node.nodeName === 'FRAME';
  } catch {
    return false;
  }
}

/** Native drags the page started during a drag burst (Input.dragIntercepted), by tab. */
const dragWatch = new Map<number, (data: unknown) => void>();

async function runInputBurst(s: Space, agentKey: string, tabId: number, steps: InputStep[], label?: string): Promise<{ dispatched: number; nativeDrag?: boolean; crossFrame?: boolean }> {
  await dbg.ensureAttached(tabId);
  // A drag burst intercepts native HTML5 drags only for its own duration: left on, the
  // interception would swallow the human's drags in this tab.
  const dragBurst = steps.some((st) => st.drag);
  let dragData: unknown = null;
  let dropped = false;
  let crossFrame = false;
  let sourceChecked = false;
  let last = { x: 0, y: 0 };
  if (label) {
    s.statusText = label;
    pushOverlay(s);
    pushUi();
  }
  const shield = shieldActive(s.ctl);
  let dispatched = 0;
  let pressed: { x: number; y: number; button: string } | null = null;
  const watcher = (data: unknown) => (dragData ??= data);
  const secret = crypto.randomUUID();
  try {
    // Set up inside the try, so the finally always undoes what was done.
    if (dragBurst) {
      dragWatch.set(tabId, watcher);
      await dbg.send(tabId, 'Input.setInterceptDrags', { enabled: true });
    }
    await setNativeIgnore(tabId, true);
    if (shield) await sendAllFramesAcked(tabId, { type: 'overtake:pass', pass: true });
    for (let step of steps) {
      if (step.drag === 'pointer' && dragData) continue; // the page took it as a native drag
      if (step.drag === 'native') {
        // The drag may start on the last move: give Chrome's event a moment to arrive.
        for (let i = 0; i < 10 && !dragData; i++) await new Promise((r) => setTimeout(r, 15));
        if (!dragData) continue;
        if (crossFrame) continue; // already cancelled
        step = { ...step, params: { ...step.params, data: dragData } };
        // A drag started inside a cross-site iframe cannot be completed from the top page.
        if (!sourceChecked) {
          sourceChecked = true;
          if (pressed && (await overRemoteFrame(tabId, pressed.x, pressed.y))) {
            crossFrame = true;
            step = { ...step, params: { ...step.params, type: 'dragCancel', x: pressed.x, y: pressed.y } };
          }
        }
      }
      if (step.method === 'Input.dispatchDragEvent') step = { ...step, params: markDrag(step.params, secret) };
      if (step.delayMs) await new Promise((r) => setTimeout(r, Math.min(step.delayMs!, 2000)));
      if (step.drag === 'pointer' && dragData) continue; // intercepted during the delay
      const d = gate(s.ctl, agentKey);
      if (!d.run) {
        throw new OvertakeError(d.wait ? ErrorCode.USER_IN_CONTROL : d.code, d.wait ? 'The human paused the agent mid-action.' : d.message, { dispatched });
      }
      if (step.method === 'Input.dispatchMouseEvent') {
        const p = step.params as { type: string; x: number; y: number; button?: string };
        if (typeof p.x === 'number' && typeof p.y === 'number' && !step.sessionId) {
          sendTop(tabId, { type: 'overtake:cursor', x: p.x, y: p.y, kind: p.type, label });
        }
        if (p.type === 'mousePressed') pressed = { x: p.x, y: p.y, button: p.button || 'left' };
        if (p.type === 'mouseReleased') pressed = null;
      }
      if (step.method === 'Input.dispatchDragEvent') {
        const p = step.params as { type: string; x: number; y: number };
        if (typeof p.x === 'number' && typeof p.y === 'number' && !step.sessionId) {
          sendTop(tabId, { type: 'overtake:cursor', x: p.x, y: p.y, kind: 'mouseMoved', label });
          last = { x: p.x, y: p.y };
        }
      }
      // Tell the top frame exactly which trusted events this step will produce. A native drop
      // bypasses Chrome's input gate, so its permit goes to every frame (the drop may land in
      // an iframe) and is revoked right after the dispatch.
      const isDrop = step.method === 'Input.dispatchDragEvent' && (step.params as { type?: string }).type === 'drop';
      const permit = permitFor(step, pressed !== null);
      if (shield) await (isDrop ? sendAllFramesAcked(tabId, { type: 'overtake:permit', permit }) : sendTopAcked(tabId, { type: 'overtake:permit', permit }));
      if (isDrop && step.drag === 'native') {
        // Checked right before dispatch: an iframe may have moved under the point meanwhile.
        const p = step.params as { x: number; y: number };
        if (await overRemoteFrame(tabId, p.x, p.y)) {
          // Cancel at the press origin: a drag event sent over the remote frame goes nowhere.
          crossFrame = true;
          step = { ...step, params: { ...step.params, type: 'dragCancel', x: pressed?.x ?? p.x, y: pressed?.y ?? p.y } };
        }
      }
      await setNativeIgnore(tabId, false);
      try {
        await dbg.send(tabId, step.method, step.params, step.sessionId);
      } finally {
        await setNativeIgnore(tabId, true).catch(() => {});
        if (shield && isDrop) await sendAllFramesAcked(tabId, { type: 'overtake:permit', permit: null }).catch(() => 0);
      }
      dispatched++;
      if (isDrop) dropped = true;
    }
  } catch (e) {
    // Never leave a native drag or a held button in the page after an aborted burst.
    if (dragData && !dropped) {
      await setNativeIgnore(tabId, false).catch(() => {});
      await dbg.send(tabId, 'Input.dispatchDragEvent', { type: 'dragCancel', x: pressed?.x ?? last.x, y: pressed?.y ?? last.y, data: dragData }).catch(() => {});
    }
    if (pressed) {
      await setNativeIgnore(tabId, false).catch(() => {});
      await dbg.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pressed.x, y: pressed.y, button: pressed.button, clickCount: 1 }).catch(() => {});
    }
    throw e;
  } finally {
    if (shield) await sendAllFramesAcked(tabId, { type: 'overtake:pass', pass: false }).catch(() => 0);
    await setNativeIgnore(tabId, false).catch(() => {});
    if (dragBurst) {
      if (dragWatch.get(tabId) === watcher) dragWatch.delete(tabId);
      await dbg.send(tabId, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
  }
  return dragBurst ? { dispatched, nativeDrag: !!dragData, ...(crossFrame ? { crossFrame } : {}) } : { dispatched };
}

// ---------------------------------------------------------------------------
// Space and tab lifecycle

// Tab groups are off by default: Chrome's "saved tab groups" keeps (and syncs) every
// group after its tabs close, and extensions cannot delete saved groups, so Spaces
// would leave clutter in the user's profile. The window, glow and dock mark a Space.
let useTabGroups = false;
void chrome.storage.local.get('useTabGroups').then((v) => (useTabGroups = v.useTabGroups === true));

async function ensureGroup(s: Space, tabIds: number[]) {
  if (!useTabGroups || !tabIds.length || s.windowId === null) return;
  try {
    const ids = tabIds as [number, ...number[]];
    const groupId: number = await (chrome.tabs.group as (o: unknown) => Promise<number>)(s.groupId !== null ? { groupId: s.groupId, tabIds: ids } : { tabIds: ids, createProperties: { windowId: s.windowId } });
    if (s.groupId !== groupId) {
      s.groupId = groupId;
      await chrome.tabGroups.update(groupId, { title: (s.createdBy === 'agent' ? '✦ ' : '') + s.name, color: s.createdBy === 'agent' ? 'blue' : 'grey' });
    }
  } catch {
    s.groupId = null; // grouping is cosmetic; a missing group never blocks automation
  }
}

async function reconcileTabs(s: Space) {
  if (s.windowId === null) return;
  const tabs = await chrome.tabs.query({ windowId: s.windowId });
  const live = new Set(tabs.map((t) => t.id!));
  for (const id of [...s.tabs.keys()]) if (!live.has(id)) s.tabs.delete(id);
  for (const t of tabs) {
    if (!s.tabs.has(t.id!)) addTab(s, { tabId: t.id!, openedBy: 'user', managed: false });
    tabInfo.set(t.id!, { url: t.url || t.pendingUrl, title: t.title, active: t.active });
  }
}

async function createSpace(name: string, createdBy: 'agent' | 'user', agentKey: string | null, url?: string): Promise<Space> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'Space name must not be empty.');
  if ([...spaces.values()].some((s) => s.name === clean)) throw new OvertakeError(ErrorCode.SPACE_NAME_IN_USE, `A Space named "${clean}" already exists; use its spaceId or pick another name.`);
  // Same size and position as the user's current window (a maximized window cannot be
  // created unfocused, and agent Spaces must not steal focus).
  const ref = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const bounds = ref && ref.state !== 'minimized' && ref.width && ref.height
    ? { left: ref.left, top: ref.top, width: ref.width, height: ref.height }
    : { width: 1440, height: 900 };
  const opts = { url: url || 'about:blank', focused: createdBy === 'user' };
  // Chrome rejects bounds less than 50% on-screen (e.g. a window across monitors): fall back.
  const win = await chrome.windows.create({ ...opts, ...bounds }).catch(() => chrome.windows.create(opts));
  if (!win) throw new OvertakeError(ErrorCode.INTERNAL, 'Chrome did not create a window.');
  const tab = win.tabs?.[0];
  const s: Space = {
    id: nextSpaceId++,
    name: clean,
    windowId: win.id ?? null,
    groupId: null,
    createdBy,
    ctl: initialControl(agentKey),
    ownerName: agentKey ? agents.get(agentKey)?.name || null : null,
    statusText: agentKey ? 'Starting' : '',
    error: null,
    tabs: new Map(),
    createdAt: Date.now(),
  };
  if (tab?.id !== undefined) {
    addTab(s, { tabId: tab.id, openedBy: createdBy, managed: createdBy === 'agent' });
    tabInfo.set(tab.id, { url: tab.pendingUrl || tab.url, title: tab.title, active: true });
  }
  spaces.set(s.id, s);
  await ensureGroup(s, [...s.tabs.keys()]);
  persist();
  pushOverlay(s);
  pushUi();
  updateBadge();
  emit(null, { type: 'control', space: summary(s) });
  return s;
}

function endSpace(s: Space, code: string, message: string) {
  if (spaces.get(s.id) !== s) return; // already ended (window close events race with closeSpaceWindow)
  closingSpaces.delete(s.id);
  rememberSpaceGone(s, code, message);
  executors.get(s.id)?.cancelQueued(code, message);
  executors.delete(s.id);
  for (const tabId of s.tabs.keys()) {
    void dbg.detach(tabId);
    broadcastState(tabId, overlayStateFor(undefined));
  }
  spaces.delete(s.id);
  spaceDownloads.delete(s.id);
  lastAgentAt.delete(s.id);
  persist();
  emit(null, { type: 'space-closed', spaceId: s.id, reason: message });
  pushUi();
  updateBadge();
}

async function detachSpaceDebuggers(s: Space) {
  for (const tabId of s.tabs.keys()) await dbg.detach(tabId);
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  const s = spaceOfWindow(tab.windowId);
  if (!s || s.tabs.has(tab.id)) return;
  const opener = tab.openerTabId !== undefined ? s.tabs.get(tab.openerTabId) : undefined;
  // A popup opened from an agent-managed tab while the agent drives is the agent's.
  const url = tab.pendingUrl || tab.url || '';
  const agentPopup = !!opener?.managed && s.ctl.control === 'AGENT_CONTROL' && !/^(chrome|edge|about:(?!blank)|chrome-extension):/i.test(url);
  const byAgent = pendingAgentTabs.has(tab.id) || agentPopup;
  addTab(s, { tabId: tab.id, openedBy: byAgent ? 'agent' : 'user', managed: byAgent });
  tabInfo.set(tab.id, { url: tab.pendingUrl || tab.url, title: tab.title, active: tab.active });
  void ensureGroup(s, [tab.id]);
  persist();
  pushOverlay(s);
  pushUi();
});

// Downloads: chrome.downloads items carry no tab id, so attribute each new download to the
// Space whose tab is its referrer, or else to a Space whose agent acted in the last 8 s.
chrome.downloads.onCreated.addListener((item) => {
  const now = Date.now();
  const all = [...spaces.values()];
  const byReferrer = item.referrer ? all.find((s) => [...s.tabs.keys()].some((id) => tabInfo.get(id)?.url === item.referrer)) : undefined;
  const byRecent = all.filter((s) => now - (lastAgentAt.get(s.id) ?? 0) < 8000).sort((a, b) => (lastAgentAt.get(b.id) ?? 0) - (lastAgentAt.get(a.id) ?? 0))[0];
  const s = byReferrer ?? byRecent;
  if (!s) return;
  const list = spaceDownloads.get(s.id) ?? [];
  list.push(item.id);
  spaceDownloads.set(s.id, list.slice(-50));
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  const s = spaceOfWindow(info.newWindowId);
  if (!s || s.tabs.has(tabId)) return;
  addTab(s, { tabId, openedBy: 'user', managed: false });
  void ensureGroup(s, [tabId]);
  persist();
  broadcastState(tabId, overlayStateFor(s));
  pushUi();
});

chrome.tabs.onDetached.addListener((tabId, info) => {
  const s = spaceOfWindow(info.oldWindowId);
  if (!s || !s.tabs.has(tabId)) return;
  s.tabs.delete(tabId);
  void dbg.detach(tabId);
  broadcastState(tabId, overlayStateFor(undefined));
  persist();
  pushUi();
});

const agentClosingTabs = new Set<number>(); // tabs closed by the agent itself (tabs.close)

chrome.tabs.onRemoved.addListener((tabId, info) => {
  tabInfo.delete(tabId);
  const s = spaceOfTab(tabId);
  if (!s) return;
  const wasManaged = s.tabs.get(tabId)?.managed;
  s.tabs.delete(tabId);
  const byAgent = agentClosingTabs.delete(tabId);
  // The human closed the Space's last agent tab (tab ✕, "Close group", ...): that is a
  // close of the Space. Leave any remaining window/tabs to the user as a normal window.
  const endsSpace = wasManaged && !byAgent && !info.isWindowClosing && ![...s.tabs.values()].some((t) => t.managed);
  // Tabs go before their window does, so a window close is recorded here, per tab. Closes
  // the extension starts itself record their own reason first (rememberSpaceGone).
  if (info.isWindowClosing) rememberGone(tabId, closingSpaces.get(s.id)?.code ?? ErrorCode.SPACE_CLOSED, closingSpaces.get(s.id)?.message ?? `The user closed the window of Space ${s.id}.`);
  else if (endsSpace) rememberGone(tabId, ErrorCode.SPACE_CLOSED, `The user closed the last tab of Space ${s.id}.`);
  else rememberGone(tabId, ErrorCode.TAB_CLOSED, byAgent ? `Tab ${tabId} was closed by the agent.` : `The user closed tab ${tabId} in Space ${s.id}.`);
  const gone = goneTabs.get(tabId)!;
  if (s.ctl.owner) emit(s.ctl.owner, { type: 'tab-closed', tabId, spaceId: s.id, code: gone.code, reason: gone.message });
  if (endsSpace) {
    endSpace(s, ErrorCode.SPACE_CLOSED, `The user closed the last tab of Space ${s.id}.`);
    return;
  }
  persist();
  pushUi();
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!spaceOfTab(tabId)) return;
  if (change.url || change.title || change.status) {
    tabInfo.set(tabId, { url: tab.url, title: tab.title, active: tab.active });
    pushUi();
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const s = spaceOfWindow(windowId);
  if (!s) return;
  for (const id of s.tabs.keys()) {
    const info = tabInfo.get(id) || {};
    tabInfo.set(id, { ...info, active: id === tabId });
  }
  pushUi();
});

chrome.windows.onRemoved.addListener((windowId) => {
  const s = spaceOfWindow(windowId);
  if (!s) return;
  const closing = closingSpaces.get(s.id);
  endSpace(s, closing?.code ?? ErrorCode.SPACE_CLOSED, closing?.message ?? `The user closed the window of Space ${s.id}.`);
});

// ---------------------------------------------------------------------------
// Debugger events

function onCdpEvent(tabId: number, sessionId: string | undefined, method: string, params: unknown) {
  if (method === 'Input.dragIntercepted' && !sessionId) dragWatch.get(tabId)?.((params as { data?: unknown })?.data);
  const s = spaceOfTab(tabId);
  if (!s?.ctl.owner) return;
  emit(s.ctl.owner, { type: 'cdp', tabId, sessionId, method, params });
}

const healing = new Map<number, number>(); // tabId -> recent auto re-attach count

function onDebuggerDetach(tabId: number, reason: string) {
  const s = spaceOfTab(tabId);
  if (!s) return;
  if (s.ctl.owner) emit(s.ctl.owner, { type: 'debugger-detached', tabId, reason });
  // Chrome drops the session when another extension's frame commits in the page
  // (e.g. LastPass's hidden frame on every navigation). Purge and re-attach so the
  // agent's next command does not fail; bounded to avoid fighting a persistent frame.
  if (reason !== 'canceled_by_user' && s.ctl.owner && s.tabs.get(tabId)?.managed) {
    const n = (healing.get(tabId) || 0) + 1;
    healing.set(tabId, n);
    setTimeout(() => healing.set(tabId, Math.max(0, (healing.get(tabId) || 1) - 1)), 30_000);
    if (n <= 10) setTimeout(() => void dbg.ensureAttached(tabId).catch(() => {}), 50);
  }
  if (reason === 'canceled_by_user' && shieldActive(s.ctl)) {
    // The human dismissed Chrome's debugging infobar: treat it as a take-over.
    applyControl(s, { type: 'HUMAN_TAKEOVER' });
    executors.get(s.id)?.cancelQueued(ErrorCode.USER_IN_CONTROL, 'The user cancelled debugging for this tab.');
  }
}

// ---------------------------------------------------------------------------
// Agent operations (from the broker)

const PROBES: [string, Record<string, unknown>][] = [
  ['Page.captureScreenshot', { format: 'jpeg', quality: 10 }],
  ['Accessibility.getFullAXTree', { depth: 2 }],
  ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
  ['DOM.getDocument', { depth: 1 }],
  ['Runtime.evaluate', { expression: '1+1', returnByValue: true }],
  ['Network.enable', {}],
  ['Fetch.enable', { patterns: [{ urlPattern: '*__overtake_probe_never__*' }] }],
  ['Fetch.disable', {}],
  ['Emulation.setDeviceMetricsOverride', { width: 400, height: 300, deviceScaleFactor: 1, mobile: true }],
  ['Emulation.clearDeviceMetricsOverride', {}],
  ['Performance.enable', {}],
  ['Performance.getMetrics', {}],
  ['Tracing.getCategories', {}],
  ['Profiler.enable', {}],
  ['HeapProfiler.enable', {}],
  ['Debugger.enable', {}],
  ['Debugger.disable', {}],
  ['Log.enable', {}],
  ['Audits.enable', {}],
  ['Storage.getUsageAndQuota', { origin: 'https://example.com' }],
  ['Target.getTargets', {}],
  ['Browser.getVersion', {}],
  ['SystemInfo.getInfo', {}],
];

async function probeCapabilities(tabId: number) {
  await dbg.ensureAttached(tabId);
  const results: Record<string, string> = {};
  for (const [m, p] of PROBES) {
    try {
      await dbg.send(tabId, m, p);
      results[m] = 'ok';
    } catch (e) {
      results[m] = 'unavailable: ' + (e instanceof Error ? e.message : String(e)).slice(0, 160);
    }
  }
  // Tracing start/stop needs a round trip; test it separately.
  try {
    await dbg.send(tabId, 'Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline'] } });
    await dbg.send(tabId, 'Tracing.end', {});
    results['Tracing.start'] = 'ok';
  } catch (e) {
    results['Tracing.start'] = 'unavailable: ' + (e instanceof Error ? e.message : String(e)).slice(0, 160);
  }
  await setNativeIgnore(tabId, false);
  results['Input.setIgnoreInputEvents (input gate)'] = strictInputGate ? 'ok' : 'unavailable';
  return { transport: 'chrome.debugger (extension-owned, protocol 1.3)', results, childSessions: dbg.childSessions(tabId) };
}

const IMMEDIATE = new Set([
  'Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest', 'Fetch.continueWithAuth', 'Fetch.continueResponse',
  'Debugger.resume', 'Debugger.stepOver', 'Debugger.stepInto', 'Debugger.stepOut', 'Debugger.evaluateOnCallFrame', 'Debugger.getScriptSource',
  'Runtime.terminateExecution', 'Page.handleJavaScriptDialog', 'Runtime.getProperties',
]);

/** Stop agent-installed request interception so no request hangs while the human drives. */
async function releaseInterception(s: Space) {
  for (const tabId of s.tabs.keys()) {
    if (dbg.isAttached(tabId)) await dbg.send(tabId, 'Fetch.disable', {}).catch(() => {});
  }
}

async function handleRequest(agentKey: string, op: Operation, args: Record<string, unknown>): Promise<unknown> {
  // Commands made for a browser_run carry its runId. Once the run ends (run.cancel), any of
  // them still queued, for example behind a pause, is refused instead of running late.
  const runKey = typeof args.runId === 'string' ? `${agentKey}:${args.runId}` : undefined;
  const gated = <T>(s: Space, key: string, label: string, fn: () => Promise<T>, opts: Parameters<typeof runGated>[4] = {}) => runGated(s, key, label, fn, { ...opts, runKey });
  switch (op) {
    case 'run.cancel': {
      if (typeof args.runId !== 'string') throw new OvertakeError(ErrorCode.BAD_REQUEST, 'runId must be a string.');
      endRun(`${agentKey}:${args.runId}`);
      return { cancelled: true };
    }
    case 'hello':
      return { extensionVersion: chrome.runtime.getManifest().version, agentKey };

    case 'capabilities': {
      const { space, tabId } = managedTab(agentKey, args.tabId);
      return gated(space, agentKey, 'probing capabilities', () => probeCapabilities(tabId), { tabId });
    }

    case 'spaces.list':
      return { spaces: [...spaces.values()].map(summary), you: agentKey };

    case 'spaces.create': {
      const s = await createSpace(String(args.name ?? ''), 'agent', agentKey, typeof args.url === 'string' ? args.url : undefined);
      return summary(s);
    }

    case 'spaces.close': {
      const s = getSpace(args.spaceId);
      requireOwner(s, agentKey);
      const userTabs = [...s.tabs.values()].filter((t) => t.openedBy === 'user');
      if (userTabs.length && s.windowId !== null) {
        // Human tabs are protected: close only the agent's tabs and release the space.
        const agentTabs = [...s.tabs.values()].filter((t) => t.openedBy === 'agent').map((t) => t.tabId);
        executorFor(s).cancelQueued(ErrorCode.SPACE_CLOSED, 'The space is being closed.');
        for (const id of agentTabs) {
          agentClosingTabs.add(id);
          await chrome.tabs.remove(id).catch(() => {});
        }
        applyControl(s, { type: 'AGENT_RELEASE', agent: agentKey });
        await detachSpaceDebuggers(s);
        return { closed: false, released: true, keptUserTabs: userTabs.map((t) => t.tabId), note: 'User-opened tabs are protected, so the Space was released instead of closed.' };
      }
      await closeSpaceWindow(s, ErrorCode.SPACE_CLOSED, `Space ${s.id} was closed by its agent.`);
      return { closed: true };
    }

    case 'spaces.switch': {
      const s = getSpace(args.spaceId);
      requireOwner(s, agentKey);
      if (s.windowId !== null) await chrome.windows.update(s.windowId, { focused: true });
      return { switched: true };
    }

    case 'spaces.rename': {
      const s = getSpace(args.spaceId);
      requireOwner(s, agentKey);
      return renameSpace(s, String(args.name ?? ''));
    }

    case 'space.claim': {
      const s = getSpace(args.spaceId);
      const r = applyControl(s, { type: 'AGENT_CLAIM', agent: agentKey });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      s.error = null;
      if (s.createdBy === 'user') for (const t of s.tabs.values()) if (t.openedBy === 'agent') t.managed = true;
      persist();
      return summary(s);
    }

    case 'space.release': {
      const s = getSpace(args.spaceId);
      const r = applyControl(s, { type: 'AGENT_RELEASE', agent: agentKey });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      executorFor(s).cancelQueued(ErrorCode.NOT_OWNER, 'The space was released.');
      await detachSpaceDebuggers(s);
      return summary(s);
    }

    case 'space.handoff': {
      const s = getSpace(args.spaceId);
      const r = applyControl(s, { type: 'AGENT_HANDOFF', agent: agentKey, reason: typeof args.reason === 'string' ? args.reason.slice(0, 200) : undefined });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      executorFor(s).cancelQueued(ErrorCode.USER_IN_CONTROL, 'Control was handed to the user.');
      await releaseInterception(s);
      return summary(s);
    }

    case 'space.resume': {
      const s = getSpace(args.spaceId);
      const r = applyControl(s, { type: 'AGENT_RESUME', agent: agentKey });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      return summary(s);
    }

    case 'space.setStatus': {
      const s = getSpace(args.spaceId);
      requireOwner(s, agentKey);
      const d = gate(s.ctl, agentKey);
      if (!d.run && !d.wait) throw new OvertakeError(d.code, d.message);
      s.statusText = String(args.text ?? '').slice(0, 120);
      persist();
      pushOverlay(s);
      pushUi();
      return { ok: true };
    }

    case 'space.markError': {
      const s = getSpace(args.spaceId);
      requireOwner(s, agentKey);
      s.error = String(args.message ?? 'Task failed').slice(0, 300);
      persist();
      pushOverlay(s);
      pushUi();
      return summary(s);
    }

    case 'downloads.list': {
      const s = getSpace(args.spaceId);
      requireOwner(s, agentKey);
      const ids = spaceDownloads.get(s.id) ?? [];
      const items = (await Promise.all(ids.map((id) => chrome.downloads.search({ id })))).flat();
      return {
        downloads: items.map((d) => ({
          downloadId: d.id, url: d.finalUrl || d.url, filename: d.filename, state: d.state, mime: d.mime,
          bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, startTime: d.startTime, endTime: d.endTime,
          error: d.error, danger: d.danger,
        })),
      };
    }

    case 'tabs.list': {
      const s = getSpace(args.spaceId);
      await reconcileTabs(s);
      return { tabs: summary(s).tabs };
    }

    case 'tabs.create': {
      const s = getSpace(args.spaceId);
      requireOwner(s, agentKey);
      return gated(s, agentKey, 'opening a tab', async () => {
        if (s.windowId === null) throw new OvertakeError(ErrorCode.SPACE_CLOSED, 'Space has no window.');
        const tab = await chrome.tabs.create({ windowId: s.windowId, url: typeof args.url === 'string' ? args.url : 'about:blank', active: args.active !== false });
        pendingAgentTabs.add(tab.id!);
        setTimeout(() => pendingAgentTabs.delete(tab.id!), 5000);
        addTab(s, { tabId: tab.id!, openedBy: 'agent', managed: true });
        tabInfo.set(tab.id!, { url: tab.pendingUrl || tab.url, title: tab.title, active: tab.active });
        await ensureGroup(s, [tab.id!]);
        persist();
        broadcastState(tab.id!, overlayStateFor(s));
        pushUi();
        return { tabId: tab.id! };
      });
    }

    case 'tabs.close': {
      const { space, tabId } = managedTab(agentKey, args.tabId);
      if (space.tabs.get(tabId)!.openedBy !== 'agent') throw new OvertakeError(ErrorCode.TAB_PROTECTED, `Tab ${tabId} was opened by the user and is protected.`);
      return gated(space, agentKey, 'closing a tab', async () => {
        agentClosingTabs.add(tabId);
        await dbg.detach(tabId);
        await chrome.tabs.remove(tabId);
        return { closed: true };
      }, { tabId });
    }

    case 'tabs.activate': {
      const { space, tabId } = managedTab(agentKey, args.tabId);
      return gated(space, agentKey, 'switching tab', async () => {
        await chrome.tabs.update(tabId, { active: true });
        return { active: true };
      }, { tabId });
    }

    case 'tabs.navigate': {
      // Fallback for tabs the debugger cannot drive: Chrome's own error and warning pages (for
      // example the certificate interstitial) refuse CDP, including Page.navigate.
      const { space, tabId } = managedTab(agentKey, args.tabId);
      const url = args.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'tabs.navigate only accepts http(s) URLs.');
      return gated(space, agentKey, 'navigating', async () => {
        await chrome.tabs.update(tabId, { url });
        return { navigating: true };
      }, { tabId });
    }

    case 'tabs.adopt': {
      if (typeof args.tabId !== 'number') throw new OvertakeError(ErrorCode.BAD_REQUEST, 'tabId must be a number.');
      const tabId = args.tabId;
      const space = spaceOfTab(tabId);
      if (!space) throw notInSpace(tabId);
      requireOwner(space, agentKey);
      return gated(space, agentKey, 'adopting a tab', async () => {
        space.tabs.get(tabId)!.managed = true;
        persist();
        pushUi();
        return { adopted: true, openedBy: space.tabs.get(tabId)!.openedBy };
      });
    }

    case 'cdp': {
      const { space, tabId } = managedTab(agentKey, args.tabId);
      const method = args.method as string;
      const params = (args.params as Record<string, unknown> | undefined) || {};
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
      const policy = checkCdpMethod(method, params);
      if (IMMEDIATE.has(method)) {
        // Unblocking commands bypass the FIFO (they resolve work the queue head may be
        // waiting on, e.g. a paused fetch or breakpoint) but are still ownership-gated.
        const d = gate(space.ctl, agentKey);
        if (!d.run && !d.wait) throw new OvertakeError(d.code, d.message);
        await dbg.ensureAttached(tabId);
        return dbg.send(tabId, method, params, sessionId);
      }
      return gated(space, agentKey, method, async () => {
        await dbg.ensureAttached(tabId);
        if (policy.input) {
          await runInputBurst(space, agentKey, tabId, [{ method: method as InputStep['method'], params, sessionId }]);
          return {};
        }
        return dbg.send(tabId, method, params, sessionId);
      }, {
        tabId,
        pausedTimeoutMs: typeof args.pausedTimeoutMs === 'number' ? args.pausedTimeoutMs : undefined,
        deadlineMs: typeof args.deadlineMs === 'number' ? Math.min(Math.max(args.deadlineMs, 1000), 300_000) : undefined,
      });
    }

    case 'input.batch': {
      const { space, tabId } = managedTab(agentKey, args.tabId);
      const steps = args.steps as InputStep[];
      if (!Array.isArray(steps) || steps.length === 0 || steps.length > 2000) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'steps must be a non-empty array (max 2000).');
      for (const st of steps) {
        const pol = checkCdpMethod(st?.method, st?.params ?? {});
        if (!pol.input) throw new OvertakeError(ErrorCode.BAD_REQUEST, `${st.method} is not an input method.`);
        if (st.drag !== undefined) {
          const ok = (st.drag === 'pointer' && st.method === 'Input.dispatchMouseEvent') || (st.drag === 'native' && st.method === 'Input.dispatchDragEvent');
          if (!ok || st.sessionId) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'drag steps are mouse events (pointer) or drag events (native) in the top frame.');
        }
      }
      const label = typeof args.label === 'string' ? args.label.slice(0, 80) : undefined;
      return gated(space, agentKey, label || 'input', () => runInputBurst(space, agentKey, tabId, steps, label), { tabId });
    }

    case 'screenshot': {
      const { space, tabId } = managedTab(agentKey, args.tabId);
      const params = (args.params as Record<string, unknown> | undefined) || {};
      const includeOverlay = args.includeOverlay === true;
      return gated(space, agentKey, 'screenshot', async () => {
        await dbg.ensureAttached(tabId);
        const hide = !includeOverlay && shieldActive(space.ctl);
        if (hide) await sendTopAcked(tabId, { type: 'overtake:hidden', hidden: true });
        try {
          return await dbg.send(tabId, 'Page.captureScreenshot', params);
        } finally {
          if (hide) sendTop(tabId, { type: 'overtake:hidden', hidden: false });
        }
      }, { tabId });
    }
  }
  throw new OvertakeError(ErrorCode.BAD_REQUEST, `Unsupported operation ${op}`);
}

async function renameSpace(s: Space, name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'Name must not be empty.');
  if ([...spaces.values()].some((o) => o !== s && o.name === clean)) throw new OvertakeError(ErrorCode.SPACE_NAME_IN_USE, `A Space named "${clean}" already exists.`);
  s.name = clean;
  if (s.groupId !== null) await chrome.tabGroups.update(s.groupId, { title: (s.createdBy === 'agent' ? '✦ ' : '') + clean }).catch(() => {});
  persist();
  pushOverlay(s);
  pushUi();
  return summary(s);
}

// ---------------------------------------------------------------------------
// Human operations (dock, popup, overview, keyboard command)

type HumanAction = 'takeover' | 'giveback' | 'pause' | 'resume' | 'stop' | 'close' | 'rename' | 'assign' | 'switch' | 'create' | 'dismissError';

async function handleHuman(action: HumanAction, spaceId: number | undefined, extra: Record<string, unknown> = {}): Promise<unknown> {
  if (action === 'create') {
    const s = await createSpace(String(extra.name || `Space ${nextSpaceId}`), 'user', null, typeof extra.url === 'string' ? extra.url : 'chrome://newtab/');
    return summary(s);
  }
  const s = getSpace(spaceId);
  switch (action) {
    case 'takeover': {
      const r = applyControl(s, { type: 'HUMAN_TAKEOVER' });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      executorFor(s).cancelQueued(ErrorCode.USER_IN_CONTROL, 'The human took over this space.');
      for (const tabId of s.tabs.keys()) if (dbg.isAttached(tabId)) await setNativeIgnore(tabId, false).catch(() => {});
      await releaseInterception(s);
      return summary(s);
    }
    case 'giveback': {
      const r = applyControl(s, { type: 'HUMAN_GIVE_BACK' });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      return summary(s);
    }
    case 'pause': {
      const r = applyControl(s, { type: 'HUMAN_PAUSE' });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      return summary(s);
    }
    case 'resume': {
      const r = applyControl(s, { type: 'HUMAN_RESUME' });
      if (!r.ok) throw new OvertakeError(r.code, r.message);
      return summary(s);
    }
    case 'stop': {
      applyControl(s, { type: 'HUMAN_STOP' });
      executorFor(s).cancelQueued(ErrorCode.STOPPED, 'The human stopped the agent.');
      s.statusText = 'Stopped';
      await detachSpaceDebuggers(s);
      pushOverlay(s);
      return summary(s);
    }
    case 'close': {
      await closeSpaceWindow(s, ErrorCode.SPACE_CLOSED, `Space ${s.id} was closed by the user.`);
      return { closed: true };
    }
    case 'rename':
      return renameSpace(s, String(extra.name ?? ''));
    case 'assign': {
      const agentKey = String(extra.agentKey ?? '');
      if (!agents.get(agentKey)?.connected) throw new OvertakeError(ErrorCode.BAD_REQUEST, 'That agent is not connected.');
      applyControl(s, { type: 'HUMAN_ASSIGN', agent: agentKey });
      for (const t of s.tabs.values()) t.managed = true; // the human handed the whole space over
      persist();
      pushUi();
      return summary(s);
    }
    case 'switch': {
      if (s.windowId !== null) await chrome.windows.update(s.windowId, { focused: true });
      return { switched: true };
    }
    case 'dismissError': {
      s.error = null;
      persist();
      pushOverlay(s);
      pushUi();
      return summary(s);
    }
  }
}

const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}/`;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('overtake:')) return false;
  // Extension pages (overview/popup) have our origin even when opened in a tab;
  // content scripts report the web page's URL and never our origin.
  const fromExtensionPage = sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_ORIGIN);
  const tabId = sender.tab?.id;
  if (msg.type === 'overtake:hello') {
    sendResponse(overlayStateFor(tabId !== undefined && !fromExtensionPage ? spaceOfTab(tabId) : undefined));
    return false;
  }
  if (msg.type === 'overtake:ui:get') {
    sendResponse(uiSnapshot());
    return false;
  }
  if (msg.type === 'overtake:human') {
    // Content scripts may only act on the space of their own tab; extension pages on any.
    let spaceId: number | undefined = msg.spaceId;
    if (!fromExtensionPage) {
      if (tabId === undefined) return false;
      spaceId = spaceOfTab(tabId)?.id;
      if (spaceId === undefined) return false;
    }
    handleHuman(msg.action, spaceId, msg.extra || {}).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: toWireError(e) }),
    );
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-overview') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('overview.html') });
    return;
  }
  if (command === 'toggle-control') {
    const active = tab?.id !== undefined ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const s = active?.id !== undefined ? spaceOfTab(active.id) : undefined;
    if (!s) return;
    if (shieldActive(s.ctl)) await handleHuman('takeover', s.id).catch(() => {});
    else await handleHuman('giveback', s.id).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Overview previews (only while an overview page is open)

const previews = new Map<number, { dataUrl: string; at: number }>();
let previewLoop: ReturnType<typeof setInterval> | null = null;
const overviewPorts = new Set<chrome.runtime.Port>();

async function capturePreview(s: Space): Promise<void> {
  const active = [...s.tabs.keys()].find((id) => tabInfo.get(id)?.active) ?? [...s.tabs.keys()][0];
  if (active === undefined) return;
  let dataUrl: string | null = null;
  if (dbg.isAttached(active)) {
    const r = await Promise.race([
      dbg.send<{ data: string }>(active, 'Page.captureScreenshot', { format: 'jpeg', quality: 62 }).catch(() => null),
      new Promise<null>((res) => setTimeout(() => res(null), 2500)),
    ]);
    if (r?.data) dataUrl = 'data:image/jpeg;base64,' + r.data;
  }
  if (!dataUrl && s.windowId !== null) {
    dataUrl = await chrome.tabs.captureVisibleTab(s.windowId, { format: 'jpeg', quality: 62 }).catch(() => null);
  }
  if (dataUrl) previews.set(s.id, { dataUrl, at: Date.now() });
}

function startPreviews() {
  if (previewLoop) return;
  const tick = async () => {
    for (const s of spaces.values()) await capturePreview(s);
    const msg = { type: 'overtake:previews', previews: Object.fromEntries([...previews].map(([k, v]) => [k, v])) };
    for (const p of overviewPorts) {
      try {
        p.postMessage(msg);
      } catch {
        overviewPorts.delete(p);
      }
    }
  };
  void tick();
  previewLoop = setInterval(tick, 2500);
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port.sender?.url?.startsWith(EXTENSION_ORIGIN)) {
    port.disconnect();
    return;
  }
  if (port.name === 'overtake-ui' || port.name === 'overtake-overview') {
    uiPorts.add(port);
    port.postMessage(uiSnapshot());
    if (port.name === 'overtake-overview') {
      overviewPorts.add(port);
      startPreviews();
    }
    port.onDisconnect.addListener(() => {
      uiPorts.delete(port);
      overviewPorts.delete(port);
      if (!overviewPorts.size && previewLoop) {
        clearInterval(previewLoop);
        previewLoop = null;
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Broker link (native messaging)

let brokerPort: chrome.runtime.Port | null = null;
let brokerBackoff = 1000;

function brokerSend(msg: ExtensionToBroker) {
  try {
    brokerPort?.postMessage(msg);
  } catch {
    /* port died; onDisconnect handles it */
  }
}

function connectBroker() {
  if (brokerPort) return;
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    scheduleReconnect();
    return;
  }
  brokerPort = port;
  port.onMessage.addListener((msg: BrokerToExtension) => {
    brokerBackoff = 1000;
    if (msg.t === 'ping') brokerSend({ t: 'pong', n: msg.n });
    else if (msg.t === 'agent') onAgent(msg.agentKey, msg.agentName, msg.connected);
    else if (msg.t === 'req') {
      handleRequest(msg.agentKey, msg.op, msg.args || {}).then(
        (result) => brokerSend({ t: 'res', id: msg.id, ok: true, result }),
        (e) => brokerSend({ t: 'res', id: msg.id, ok: false, error: toWireError(e) }),
      );
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    brokerPort = null;
    for (const [key, a] of agents) if (a.connected) onAgent(key, a.name, false);
    pushUi();
    scheduleReconnect();
  });
  brokerSend({ t: 'ready', extensionVersion: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION });
  pushUi();
}

function scheduleReconnect() {
  setTimeout(connectBroker, brokerBackoff);
  brokerBackoff = Math.min(brokerBackoff * 2, 30_000);
}

function onAgent(agentKey: string, name: string, connected: boolean) {
  agents.set(agentKey, { name, connected });
  for (const s of spaces.values()) {
    if (s.ctl.owner !== agentKey) continue;
    if (!connected) {
      applyControl(s, { type: 'AGENT_DISCONNECTED', agent: agentKey });
      executors.get(s.id)?.cancelQueued(ErrorCode.USER_IN_CONTROL, 'The owning agent disconnected.');
      void releaseInterception(s);
    } else {
      applyControl(s, { type: 'AGENT_RECONNECTED', agent: agentKey });
    }
  }
  if (!connected) {
    // Forget disconnected agents that own nothing, to keep the roster small.
    if (![...spaces.values()].some((s) => s.ctl.owner === agentKey)) agents.delete(agentKey);
  }
  pushUi();
}

chrome.alarms.create('overtake-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'overtake-keepalive') {
    if (!brokerPort) connectBroker();
    else brokerSend({ t: 'pong', n: Date.now() });
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('overview.html') });
});

// ---------------------------------------------------------------------------
// Boot

void restore().then(() => {
  connectBroker();
  updateBadge();
});
