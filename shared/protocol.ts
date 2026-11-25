// Wire protocol shared by the MCP server, the broker (native messaging host)
// and the extension service worker. Kept free of runtime dependencies so it can
// be bundled into the extension and imported directly by Node (type stripping).

export const PROTOCOL_VERSION = 1;
export const NATIVE_HOST_NAME = 'dev.overtake.broker';

/** Stable error codes. Every refusal carries one; nothing fails silently. */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  EXTENSION_NOT_CONNECTED: 'EXTENSION_NOT_CONNECTED',
  SPACE_NOT_FOUND: 'SPACE_NOT_FOUND',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  TAB_NOT_IN_SPACE: 'TAB_NOT_IN_SPACE',
  TAB_NOT_MANAGED: 'TAB_NOT_MANAGED',
  TAB_PROTECTED: 'TAB_PROTECTED',
  SPACE_NAME_IN_USE: 'SPACE_NAME_IN_USE',
  NOT_OWNER: 'NOT_OWNER',
  USER_IN_CONTROL: 'USER_IN_CONTROL',
  AGENT_PAUSED_TIMEOUT: 'AGENT_PAUSED_TIMEOUT',
  STOPPED: 'STOPPED',
  SPACE_CLOSED: 'SPACE_CLOSED',
  TAB_CLOSED: 'TAB_CLOSED',
  DEBUGGER_ATTACH_FAILED: 'DEBUGGER_ATTACH_FAILED',
  DEBUGGER_DETACHED: 'DEBUGGER_DETACHED',
  PROTECTED_PAGE: 'PROTECTED_PAGE',
  CDP_ERROR: 'CDP_ERROR',
  CERT_ERROR: 'CERT_ERROR',
  CDP_METHOD_DENIED: 'CDP_METHOD_DENIED',
  UNSUPPORTED: 'UNSUPPORTED',
  TIMEOUT: 'TIMEOUT',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_AMBIGUOUS: 'ELEMENT_AMBIGUOUS',
  ELEMENT_NOT_ACTIONABLE: 'ELEMENT_NOT_ACTIONABLE',
  PAGE_NAVIGATED: 'PAGE_NAVIGATED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface WireError {
  code: ErrorCode | string;
  message: string;
  data?: unknown;
}

export class OvertakeError extends Error {
  code: string;
  data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'OvertakeError';
    this.code = code;
    this.data = data;
  }
  toWire(): WireError {
    return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
  }
}

export function toWireError(err: unknown): WireError {
  if (err instanceof OvertakeError) return err.toWire();
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return { code: String((err as WireError).code), message: String((err as WireError).message) };
  }
  return { code: ErrorCode.INTERNAL, message: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// Control model (see shared/control.ts for the transition rules)

export type ControlState = 'USER_CONTROL' | 'AGENT_CONTROL' | 'AGENT_PAUSED' | 'STOPPED';

/** Why a space is in USER_CONTROL. Determines who may move it back to the agent. */
export type UserControlReason =
  | 'unclaimed' // never owned by an agent (user-created space)
  | 'takeover' // human pressed Take Over — only the human can Give Back
  | 'handoff' // agent asked the human to act — the owner may resume
  | 'released' // owner released it
  | 'agent-disconnected'; // owning agent's connection dropped

export interface SpaceTab {
  tabId: number;
  openedBy: 'agent' | 'user';
  /** Agent may operate this tab (agent-opened, agent popup, or explicitly adopted). */
  managed: boolean;
  url?: string;
  title?: string;
  active?: boolean;
}

export interface SpaceSummary {
  spaceId: number;
  name: string;
  windowId: number | null;
  groupId: number | null;
  createdBy: 'agent' | 'user';
  owner: string | null; // agentKey
  ownerName: string | null;
  ownerConnected: boolean;
  control: ControlState;
  userReason: UserControlReason | null;
  statusText: string;
  actionRequired: string | null;
  error: string | null;
  tabs: SpaceTab[];
  isolation: 'shared-profile';
  createdAt: number;
}

// ---------------------------------------------------------------------------
// MCP server <-> broker (unix socket, newline-delimited JSON)

export interface HelloMessage {
  t: 'hello';
  protocol: number;
  token: string;
  agentKey: string;
  agentName: string;
}

export type ClientMessage = HelloMessage | RequestMessage;

export interface RequestMessage {
  t: 'req';
  id: number;
  op: Operation;
  args: Record<string, unknown>;
}

export interface ResponseMessage {
  t: 'res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: WireError;
}

export interface EventMessage {
  t: 'evt';
  event: AgentEvent;
}

export type AgentEvent =
  | { type: 'cdp'; tabId: number; sessionId?: string; method: string; params: unknown }
  | { type: 'control'; space: SpaceSummary }
  | { type: 'space-closed'; spaceId: number; reason?: string }
  | { type: 'tab-closed'; tabId: number; spaceId: number; code?: string; reason?: string }
  | { type: 'debugger-detached'; tabId: number; reason: string }
  | { type: 'debugger-attached'; tabId: number } // fresh session: CDP domain state must be rebuilt
  | { type: 'extension'; connected: boolean };

/** Operations the extension serves. `agentKey` is attached by the broker, never by the client. */
export type Operation =
  | 'hello'
  | 'capabilities'
  | 'spaces.list'
  | 'spaces.create'
  | 'spaces.close'
  | 'spaces.switch'
  | 'spaces.rename'
  | 'space.claim'
  | 'space.release'
  | 'space.handoff'
  | 'space.resume'
  | 'space.setStatus'
  | 'space.markError'
  | 'tabs.list'
  | 'downloads.list'
  | 'tabs.create'
  | 'tabs.close'
  | 'tabs.activate'
  | 'tabs.navigate'
  | 'tabs.adopt'
  | 'cdp'
  | 'input.batch'
  | 'screenshot'
  | 'run.cancel';

export const OPERATIONS: readonly Operation[] = [
  'hello', 'capabilities', 'spaces.list', 'spaces.create', 'spaces.close', 'spaces.switch', 'spaces.rename',
  'space.claim', 'space.release', 'space.handoff', 'space.resume', 'space.setStatus', 'space.markError',
  'tabs.list', 'downloads.list', 'tabs.create', 'tabs.close', 'tabs.activate', 'tabs.navigate', 'tabs.adopt', 'cdp', 'input.batch', 'screenshot', 'run.cancel',
];

// ---------------------------------------------------------------------------
// broker <-> extension (Chrome native messaging, 32-bit length-prefixed JSON)

export type BrokerToExtension =
  | { t: 'req'; id: number; agentKey: string; op: Operation; args: Record<string, unknown> }
  | { t: 'agent'; agentKey: string; agentName: string; connected: boolean }
  | { t: 'ping'; n: number };

export type ExtensionToBroker =
  | { t: 'res'; id: number; ok: boolean; result?: unknown; error?: WireError }
  | { t: 'evt'; agentKey: string | null; event: AgentEvent } // null = broadcast to every agent
  | { t: 'pong'; n: number }
  | { t: 'ready'; extensionVersion: string; protocol: number };

/** One step of an agent input burst executed atomically behind the input gate. */
export interface InputStep {
  method:
    | 'Input.dispatchMouseEvent'
    | 'Input.dispatchKeyEvent'
    | 'Input.insertText'
    | 'Input.dispatchDragEvent'
    | 'Input.dispatchTouchEvent'
    | 'Input.synthesizeScrollGesture'
    | 'Input.imeSetComposition';
  params: Record<string, unknown>;
  sessionId?: string;
  /** Delay before this step, ms (used for natural cursor motion). */
  delayMs?: number;
}

export const INPUT_METHODS = new Set<string>([
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchDragEvent',
  'Input.dispatchTouchEvent', 'Input.synthesizeScrollGesture', 'Input.imeSetComposition', 'Input.emulateTouchFromMouseEvent',
  'Input.synthesizePinchGesture', 'Input.synthesizeTapGesture',
]);
