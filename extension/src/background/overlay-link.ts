// Messaging between the service worker and the in-page overlay content script.

export interface OverlayState {
  shield: boolean; // block human page input + show glow
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
  /** Remove other extensions' frames: Chrome refuses chrome.debugger on tabs that contain them. */
  suppressForeignFrames: boolean;
}

/** Trusted events the top frame should admit for the agent step being dispatched. */
export interface Permit {
  types: string[]; // DOM event types, or ['*']
  x?: number; // mouse: viewport coordinates of the agent event
  y?: number;
  key?: string; // keyboard: KeyboardEvent.key
  /** Types admitted without the coordinate check: the native drag events Chrome fires away
   *  from the step's point (dragstart at the press origin, dragend on the source). */
  loose?: string[];
}

export type OverlayMessage =
  | { type: 'overtake:state'; state: OverlayState }
  | { type: 'overtake:pass'; pass: boolean } // agent burst in progress
  | { type: 'overtake:permit'; permit: Permit } // admit exactly the next step's events (top frame)
  | { type: 'overtake:hidden'; hidden: boolean } // hide visuals for agent screenshots
  | { type: 'overtake:cursor'; x: number; y: number; kind: string; label?: string }
  | { type: 'overtake:busy'; busy: boolean; label?: string }
  | { type: 'overtake:purge' }; // remove foreign extension frames now (acknowledged)

const FRAME_TIMEOUT_MS = 400;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

async function frameIds(tabId: number): Promise<number[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return frames ? frames.map((f) => f.frameId) : [0];
  } catch {
    return [0];
  }
}

/** Send to every frame and wait for each live content script to acknowledge. */
export async function sendAllFramesAcked(tabId: number, msg: OverlayMessage): Promise<number> {
  const ids = await frameIds(tabId);
  const acks = await Promise.all(
    ids.map((frameId) =>
      withTimeout(
        chrome.tabs.sendMessage(tabId, msg, { frameId }).then(
          (r) => r === 'ack',
          () => false,
        ),
        FRAME_TIMEOUT_MS,
      ),
    ),
  );
  return acks.filter(Boolean).length;
}

export async function sendTopAcked(tabId: number, msg: OverlayMessage): Promise<boolean> {
  const r = await withTimeout(
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).then(
      (v) => v === 'ack',
      () => false,
    ),
    FRAME_TIMEOUT_MS,
  );
  return r === true;
}

/** Fire-and-forget to the top frame (cursor animation must never delay actions). */
export function sendTop(tabId: number, msg: OverlayMessage): void {
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
}

export function broadcastState(tabId: number, state: OverlayState): void {
  void frameIds(tabId).then((ids) => {
    for (const frameId of ids) chrome.tabs.sendMessage(tabId, { type: 'overtake:state', state } satisfies OverlayMessage, { frameId }).catch(() => {});
  });
}
