// Validation for raw CDP commands coming from agents. The extension is the
// authority: the MCP server validates too, but cannot be trusted to.

import { ErrorCode, OvertakeError, INPUT_METHODS } from '../../../shared/protocol.ts';

const METHOD_RE = /^[A-Z][A-Za-z]{1,40}\.[a-z][A-Za-z]{1,60}$/;

/** Methods an agent may never call directly, with the reason surfaced to it. */
const DENY: Record<string, string> = {
  'Input.setIgnoreInputEvents': 'reserved for the Overtake input gate',
  'Network.getAllCookies': 'reads cookies for every site in the user profile',
  'Storage.getCookies': 'reads cookies for every site in the user profile',
  'Network.clearBrowserCookies': 'clears cookies for the whole user profile',
  'Network.clearBrowserCache': 'clears the whole profile cache',
  'Storage.clearCookies': 'clears cookies for the whole user profile',
  'Storage.setCookies': 'writes cookies at profile scope; use Network.setCookie for the page',
  'Browser.close': 'closes the user\'s browser',
  'Browser.crash': 'crashes the user\'s browser',
  'Browser.crashGpuProcess': 'crashes the user\'s browser',
  'Target.createTarget': 'use browser_tabs (tabs are created inside the owned Space)',
  'Target.closeTarget': 'use browser_tabs to close agent-opened tabs',
  'Target.attachToBrowserTarget': 'browser-wide attachment is not allowed',
  'Target.exposeDevToolsProtocol': 'would expose CDP to page script',
  'Page.setDownloadBehavior': 'changes the profile-wide download setting',
  'Browser.setDownloadBehavior': 'changes the profile-wide download setting',
  'SystemInfo.getProcessInfo': 'not needed for page automation',
};

export interface PolicyResult {
  input: boolean;
}

export function checkCdpMethod(method: unknown, params: unknown): PolicyResult {
  if (typeof method !== 'string' || !METHOD_RE.test(method)) {
    throw new OvertakeError(ErrorCode.BAD_REQUEST, `Invalid CDP method name: ${String(method).slice(0, 80)}`);
  }
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    throw new OvertakeError(ErrorCode.BAD_REQUEST, 'CDP params must be an object.');
  }
  if (params && 'sessionId' in (params as object)) {
    throw new OvertakeError(ErrorCode.BAD_REQUEST, 'Pass sessionId as a separate argument, not inside params.');
  }
  const reason = DENY[method];
  if (reason) throw new OvertakeError(ErrorCode.CDP_METHOD_DENIED, `${method} is not allowed: ${reason}.`);
  return { input: INPUT_METHODS.has(method) };
}

export const DENIED_METHODS = Object.keys(DENY);
