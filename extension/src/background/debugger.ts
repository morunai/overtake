// chrome.debugger ownership: one attachment per agent-managed tab, flat child
// sessions for out-of-process iframes, and event fan-out.

import { OvertakeError, ErrorCode } from '../../../shared/protocol.ts';

export type CdpEventListener = (tabId: number, sessionId: string | undefined, method: string, params: unknown) => void;
export type DetachListener = (tabId: number, reason: string) => void;
export type AttachListener = (tabId: number) => void;

const PROTECTED_RE = /^(chrome|chrome-extension|devtools|edge|about:(?!blank)|view-source|chrome-search|chrome-untrusted):/i;

export class DebuggerManager {
  #attached = new Set<number>();
  #attaching = new Map<number, Promise<void>>();
  #childSessions = new Map<number, Map<string, { targetId: string; type: string; url: string }>>();
  #onEvent: CdpEventListener;
  #onDetach: DetachListener;

  #onAttach: AttachListener;

  constructor(onEvent: CdpEventListener, onDetach: DetachListener, onAttach: AttachListener) {
    this.#onEvent = onEvent;
    this.#onDetach = onDetach;
    this.#onAttach = onAttach;
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source.tabId;
      if (tabId === undefined || !this.#attached.has(tabId)) return;
      const sessionId = (source as { sessionId?: string }).sessionId;
      if (method === 'Target.attachedToTarget') {
        const p = params as { sessionId: string; targetInfo: { targetId: string; type: string; url: string } };
        let m = this.#childSessions.get(tabId);
        if (!m) this.#childSessions.set(tabId, (m = new Map()));
        m.set(p.sessionId, { targetId: p.targetInfo.targetId, type: p.targetInfo.type, url: p.targetInfo.url });
        // Child sessions need their own auto-attach for nested OOPIFs.
        void this.send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, p.sessionId).catch(() => {});
      } else if (method === 'Target.detachedFromTarget') {
        const p = params as { sessionId: string };
        this.#childSessions.get(tabId)?.delete(p.sessionId);
      }
      this.#onEvent(tabId, sessionId, method, params);
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
      const tabId = source.tabId;
      if (tabId === undefined) return;
      const was = this.#attached.delete(tabId);
      this.#childSessions.delete(tabId);
      if (was) this.#onDetach(tabId, reason);
    });
  }

  isAttached(tabId: number): boolean {
    return this.#attached.has(tabId);
  }

  childSessions(tabId: number) {
    return [...(this.#childSessions.get(tabId) || new Map()).entries()].map(([sessionId, v]) => ({ sessionId, ...v }));
  }

  async ensureAttached(tabId: number): Promise<void> {
    if (this.#attached.has(tabId)) return;
    const inflight = this.#attaching.get(tabId);
    if (inflight) return inflight;
    const p = this.#attach(tabId).finally(() => this.#attaching.delete(tabId));
    this.#attaching.set(tabId, p);
    return p;
  }

  async #attach(tabId: number): Promise<void> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new OvertakeError(ErrorCode.TAB_NOT_FOUND, `Tab ${tabId} does not exist.`);
    }
    const url = tab.pendingUrl || tab.url || '';
    if (PROTECTED_RE.test(url)) {
      throw new OvertakeError(ErrorCode.PROTECTED_PAGE, `Chrome does not allow extensions to debug ${url.split('?')[0]}. Navigate the tab to a web page first.`);
    }
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already attached/i.test(msg)) {
        // A previous service-worker instance may still hold it: reset cleanly
        // (detaching also clears any input-ignore state left behind).
        await chrome.debugger.detach({ tabId }).catch(() => {});
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
        } catch (e2) {
          throw new OvertakeError(ErrorCode.DEBUGGER_ATTACH_FAILED, `Could not attach to tab ${tabId}: ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      } else if (/different extension/i.test(msg)) {
        // Another extension (password manager, translator, AI sidebar...) put its own
        // chrome-extension:// frame into the page; Chrome forbids attaching while it is there.
        // Space tabs suppress such frames; purge now and retry once.
        await this.#purge(tabId);
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
        } catch (e2) {
          throw new OvertakeError(ErrorCode.DEBUGGER_ATTACH_FAILED,
            `Could not attach to tab ${tabId}: another extension keeps a frame in this page (${e2 instanceof Error ? e2.message : String(e2)}). Disable that extension's site access for this site, or use the isolated Chrome mode.`);
        }
      } else {
        throw new OvertakeError(ErrorCode.DEBUGGER_ATTACH_FAILED, `Could not attach to tab ${tabId}: ${msg}`);
      }
    }
    this.#attached.add(tabId);
    // Announce before auto-attach so child-session events arrive after the reset.
    this.#onAttach(tabId);
    await this.send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    // Agent windows open without focus, usually behind the user's window. macOS occlusion
    // then marks the page hidden: rAF and input acks crawl (clicks took 1-12 s in the
    // benchmark) and focus-aware sites pause ("paused while you were away"). Focus emulation
    // keeps the page visible and focused while attached, without taking real focus.
    await this.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }

  async #purge(tabId: number): Promise<void> {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) || [{ frameId: 0 }];
    await Promise.all(frames.map((f) => chrome.tabs.sendMessage(tabId, { type: 'overtake:purge' }, { frameId: f.frameId }).catch(() => {})));
    await new Promise((r) => setTimeout(r, 150)); // let the removed frames' hosts go away
  }

  async detach(tabId: number): Promise<void> {
    if (!this.#attached.has(tabId)) return;
    this.#attached.delete(tabId);
    this.#childSessions.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  async send<T = unknown>(tabId: number, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.#attached.has(tabId)) throw new OvertakeError(ErrorCode.DEBUGGER_DETACHED, `Debugger is not attached to tab ${tabId}.`);
    const target: chrome.debugger.Debuggee & { sessionId?: string } = { tabId };
    if (sessionId) target.sessionId = sessionId;
    try {
      return (await chrome.debugger.sendCommand(target, method, params)) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.#attached.has(tabId)) throw new OvertakeError(ErrorCode.DEBUGGER_DETACHED, `Debugger detached from tab ${tabId} during ${method}.`);
      throw new OvertakeError(ErrorCode.CDP_ERROR, `${method}: ${msg}`);
    }
  }
}
