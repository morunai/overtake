#!/usr/bin/env node
// Overtake MCP server (stdio). Claude Code launches one per session; each gets its
// own agent identity, so concurrent sessions own separate Spaces safely.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrokerClient } from './broker-client.ts';
import { Engine, DEVICES } from './engine.ts';
import { redactCdp } from './redact.ts';
import { readScriptFile, runScript, scriptName } from './run.ts';
import { OvertakeError, toWireError } from '../shared/protocol.ts';
import { overtakeHome } from '../bridge/paths.ts';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const INSTRUCTIONS = `Overtake drives the user's real Google Chrome through agent Spaces (dedicated windows), with explicit human/agent control.
Rules:
- Work inside a Space you own. Create one per user goal (spaces_create) and keep using its spaceId; it starts with one tab.
- Prefer browser_snapshot (accessibility tree with @refs) to choose targets, then act with browser_click/browser_type using @refs. Use screenshots for visual checks and canvas-like pages.
- Pages often keep changing after load. To wait for an element, pass waitFor to browser_navigate or use browser_wait with a selector; do not guess with fixed delays.
- SPACE_CLOSED or TAB_CLOSED means the Space or tab is gone (the message says who closed it). Do not retry on it; tell the user or create a new Space.
- For many steps or repeated flows (test suites, filling many forms, checking many pages), write a script file once and run it with browser_run instead of one tool call per step. Re-run the same file after fixing it.
- Pass snapshot: true to browser_click, browser_type, browser_press, browser_navigate or browser_wait when you need to see the page after the action, instead of a separate browser_snapshot call.
- A USER_IN_CONTROL error is a hard stop: the human took over. Do not retry or route around it. Tell the user, and resume only after they give control back (space_wait_for_control can wait for that).
- When the user must act (login without provided credentials, CAPTCHA, 2FA, permission prompts), call space_handoff with a short reason, end your turn, and resume later with space_resume.
- A CERT_ERROR (untrusted certificate, Chrome's "Privacy error" page) cannot be bypassed from the extension: hand off so the user clicks "Proceed" once, then navigate again.
- Use browser_cdp for anything the higher-level tools do not cover. Profile-wide cookie/cache operations are denied by design.
- When finished, close the Space with spaces_close (user-opened tabs are protected and kept).`;

const client = new BrokerClient();
const engine = new Engine(client);
const server = new McpServer({ name: 'overtake', version: '0.1.0' }, { instructions: INSTRUCTIONS });

function text(v: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] };
}

// Per-process call log (tool, duration, outcome) for diagnosing agent sessions.
// Arguments and results are not logged: they can contain page data.
const logDir = join(overtakeHome(), 'logs');
try {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
} catch {
  /* logging is best-effort */
}
const logFile = join(logDir, `mcp-${process.pid}.log`);
function logCall(tool: string, ms: number, outcome: string) {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${client.agentName} ${tool} ${ms}ms ${outcome}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function wrap<A>(fn: (args: A) => Promise<ToolResult | unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      const r = await fn(args);
      if (r && typeof r === 'object' && 'content' in (r as object) && Array.isArray((r as ToolResult).content)) return r as ToolResult;
      return text(r);
    } catch (e) {
      const w = toWireError(e);
      return { isError: true, content: [{ type: 'text', text: `${w.code}: ${w.message}` }] };
    }
  };
}

// Time every tool call by name.
const register = server.registerTool.bind(server);
(server as unknown as { registerTool: typeof register }).registerTool = ((name: string, config: never, cb: (a: unknown) => Promise<ToolResult>) => {
  const timed = async (a: unknown) => {
    const t0 = Date.now();
    const r = await cb(a);
    logCall(name, Date.now() - t0, r.isError ? (r.content[0] as { text: string }).text.split(':')[0] : 'ok');
    return r;
  };
  return register(name, config, timed as never);
}) as typeof register;

const tabId = z.number().int().describe('Tab id (from spaces_create, spaces_list or browser_tabs).');
const spaceId = z.number().int().describe('Space id.');
const snapshotOpts = {
  snapshot: z.boolean().default(false).describe('Also return an accessibility snapshot (with fresh @refs) of the page after the action, saving a browser_snapshot call.'),
  snapshotScope: z.enum(['viewport', 'full_page']).default('viewport').describe('Scope of that snapshot.'),
};
type SnapshotOpts = { snapshot: boolean; snapshotScope: 'viewport' | 'full_page' };

function snapshotText(r: { url: string; title: string; snapshot: string }) {
  return `url: ${r.url}\ntitle: ${r.title}\n\n${r.snapshot}`;
}

/** The action's JSON receipt, plus a snapshot of the page afterwards when asked for. The
 *  snapshot is skipped (with the reason) when it cannot be taken safely: a dialog is open, the
 *  page is still loading, the agent was paused, or control changed after the action.
 *  `since` is when the action started (Date.now()), for input and navigation actions. */
async function afterAction(tabId: number, r: unknown, o: SnapshotOpts, since?: number): Promise<ToolResult> {
  const receipt = text(r);
  if (!o.snapshot) return receipt;
  const skipped = (why: string): ToolResult => ({ content: [...receipt.content, { type: 'text', text: `snapshot skipped: ${why}` }] });
  const v = (r ?? {}) as { dialog?: unknown; loaded?: boolean; note?: string };
  if (v.dialog || engine.pendingDialog(tabId)) return skipped('a JavaScript dialog is open; handle it with browser_dialog first.');
  if (v.note) return skipped(v.note);
  if (v.loaded === false) return skipped('the page is still loading; use browser_wait, then browser_snapshot.');
  try {
    // After an input action, let the page's own fetch-and-render finish first. browser_wait
    // passes no `since`: its condition already says the page is ready.
    if (since !== undefined) await engine.settle(tabId, since);
    if ((await engine.pageInfo(tabId)).readyState === 'loading') return skipped('the page is still loading; use browser_wait, then browser_snapshot.');
    const s = await engine.snapshot(tabId, { scope: o.snapshotScope });
    return { content: [...receipt.content, { type: 'text', text: snapshotText(s) }] };
  } catch (e) {
    const w = toWireError(e);
    return skipped(`${w.code}: ${w.message}`);
  }
}

const target = z.string().describe('Element: snapshot ref "@12", "text=Sign in", "xpath=//button", a CSS selector, or viewport coordinates "x,y".');

// ---------------------------------------------------------------------------
// Spaces and control

server.registerTool('spaces_list', { description: 'List Spaces with owner, control state (AGENT_CONTROL, AGENT_PAUSED, USER_CONTROL, STOPPED), status and tabs. `you` is your agent key.', inputSchema: {} },
  wrap(async () => ({ you: client.agentKey, name: client.agentName, spaces: await engine.listSpaces() })));

server.registerTool('spaces_create', {
  description: 'Create an agent Space: a dedicated Chrome window (opened without stealing focus) owned by you, with one tab. Returns spaceId and tabId. Note: Spaces share the Chrome profile (cookies/logins).',
  inputSchema: { name: z.string().min(1).max(80).describe('Unique, descriptive goal name.'), url: z.string().optional().describe('Initial URL (default about:blank).') },
}, wrap(async ({ name, url }: { name: string; url?: string }) => {
  const s = await client.request<{ spaceId: number; tabs: { tabId: number }[] }>('spaces.create', { name, url });
  return { ...s, tabId: s.tabs[0]?.tabId };
}));

server.registerTool('spaces_close', { description: 'Close a Space you own and its agent tabs. User-opened tabs are protected: then the Space is released instead.', inputSchema: { spaceId } },
  wrap(async ({ spaceId }: { spaceId: number }) => client.request('spaces.close', { spaceId })));

server.registerTool('spaces_switch', { description: 'Bring a Space window you own to the front (this takes focus from the user; only do it when asked).', inputSchema: { spaceId } },
  wrap(async ({ spaceId }: { spaceId: number }) => client.request('spaces.switch', { spaceId })));

server.registerTool('spaces_rename', { description: 'Rename a Space you own.', inputSchema: { spaceId, name: z.string().min(1).max(80) } },
  wrap(async (a: { spaceId: number; name: string }) => client.request('spaces.rename', a)));

server.registerTool('space_claim', { description: 'Claim an existing Space (one you released, an unowned one, or one whose agent disconnected). Never claim a Space the user took over; claim other Spaces only when the user asks.', inputSchema: { spaceId } },
  wrap(async ({ spaceId }: { spaceId: number }) => client.request('space.claim', { spaceId })));

server.registerTool('space_release', { description: 'Release ownership of a Space, keeping its tabs open for the user.', inputSchema: { spaceId } },
  wrap(async ({ spaceId }: { spaceId: number }) => client.request('space.release', { spaceId })));

server.registerTool('space_handoff', {
  description: 'Hand control to the human (e.g. login, CAPTCHA, 2FA, a decision). The page shows "Need your action" with your reason and unblocks human input. End your turn afterwards; resume with space_resume when the user says so.',
  inputSchema: { spaceId, reason: z.string().max(200).describe('What the user should do, shown in the dock.') },
}, wrap(async (a: { spaceId: number; reason: string }) => client.request('space.handoff', a)));

server.registerTool('space_resume', { description: 'Take control back after your own space_handoff. Fails while the human holds a Take Over (they must press "Return to agent").', inputSchema: { spaceId } },
  wrap(async ({ spaceId }: { spaceId: number }) => client.request('space.resume', { spaceId })));

server.registerTool('space_wait_for_control', {
  description: 'Wait (without taking control) until the human gives this Space back to you, or until timeout. Returns inControl.',
  inputSchema: { spaceId, timeoutMs: z.number().int().min(0).max(600_000).default(60_000) },
}, wrap(async ({ spaceId, timeoutMs }: { spaceId: number; timeoutMs: number }) => engine.waitForControl(spaceId, timeoutMs)));

server.registerTool('space_status', { description: 'Set the short status text shown in the agent dock and Spaces overview.', inputSchema: { spaceId, text: z.string().max(120) } },
  wrap(async (a: { spaceId: number; text: string }) => client.request('space.setStatus', a)));

server.registerTool('space_mark_error', { description: 'Mark the task in a Space as failed with a user-visible reason (keeps the Space).', inputSchema: { spaceId, message: z.string().max(300) } },
  wrap(async (a: { spaceId: number; message: string }) => client.request('space.markError', a)));

// ---------------------------------------------------------------------------
// Tabs and navigation

server.registerTool('browser_tabs', {
  description: 'Manage tabs in a Space. list: all tabs (managed = you may operate it). new: open a tab. close: close a tab you opened. select: activate. adopt: take over a user-opened tab in your Space so you can operate it.',
  inputSchema: { action: z.enum(['list', 'new', 'close', 'select', 'adopt']), spaceId: spaceId.optional(), tabId: tabId.optional(), url: z.string().optional() },
}, wrap(async (a: { action: string; spaceId?: number; tabId?: number; url?: string }) => {
  const need = (v: number | undefined, n: string) => {
    if (v === undefined) throw new OvertakeError('BAD_REQUEST', `${n} is required for action ${a.action}.`);
    return v;
  };
  switch (a.action) {
    case 'list': return client.request('tabs.list', { spaceId: need(a.spaceId, 'spaceId') });
    case 'new': return client.request('tabs.create', { spaceId: need(a.spaceId, 'spaceId'), url: a.url });
    case 'close': return client.request('tabs.close', { tabId: need(a.tabId, 'tabId') });
    case 'select': return client.request('tabs.activate', { tabId: need(a.tabId, 'tabId') });
    case 'adopt': return client.request('tabs.adopt', { tabId: need(a.tabId, 'tabId') });
  }
}));

server.registerTool('browser_navigate', {
  description: 'Navigate a tab and wait for load. Apps often keep changing after load (redirects, client rendering): pass waitFor with a selector to also wait until that element is visible.',
  inputSchema: {
    tabId, url: z.string(), waitUntil: z.enum(['load', 'commit', 'none']).default('load'), timeoutMs: z.number().int().max(120_000).default(30_000),
    waitFor: z.string().optional().describe('Selector or "text=..." that must be visible before this returns, e.g. "#add-card-btn". Fails with TIMEOUT if it does not appear within timeoutMs.'),
    ...snapshotOpts,
  },
}, wrap(async (a: { tabId: number; url: string; waitUntil: 'load' | 'commit' | 'none'; timeoutMs: number; waitFor?: string } & SnapshotOpts) => {
  const t0 = Date.now();
  return afterAction(a.tabId, await engine.navigate(a.tabId, a.url, a), a, t0);
}));

server.registerTool('browser_wait', {
  description: 'Wait until all given conditions hold: selector state, page text, URL substring, JS predicate, network idle, or load complete. Use delayMs for a plain pause (do not use page timers for delays). Fails immediately with USER_IN_CONTROL if the human takes over.',
  inputSchema: {
    tabId, delayMs: z.number().int().min(0).max(120_000).optional().describe('Plain pause in ms, measured outside the page.'), selector: z.string().optional(), state: z.enum(['visible', 'attached', 'hidden']).optional(), text: z.string().optional(), urlIncludes: z.string().optional(),
    function: z.string().optional().describe('JS expression evaluated in the page, truthy = done (may be async).'), networkIdleMs: z.number().int().optional(), load: z.boolean().optional(),
    timeoutMs: z.number().int().max(120_000).default(10_000), ...snapshotOpts,
  },
}, wrap(async (a: { tabId: number } & SnapshotOpts & Record<string, unknown>) => {
  const { snapshot, snapshotScope, ...cond } = a;
  return afterAction(a.tabId, await engine.wait(a.tabId, cond as Parameters<Engine['wait']>[1]), { snapshot, snapshotScope });
}));

// ---------------------------------------------------------------------------
// Observation

server.registerTool('browser_snapshot', {
  description: 'Accessibility snapshot of the page (includes iframe content) with @refs for interactive elements. Default scope is the viewport; use full_page for everything. Refs become stale after navigation.',
  inputSchema: { tabId, scope: z.enum(['viewport', 'full_page']).default('viewport'), maxLines: z.number().int().min(50).max(5000).optional() },
}, wrap(async (a: { tabId: number; scope: 'viewport' | 'full_page'; maxLines?: number }) => {
  return text(snapshotText(await engine.snapshot(a.tabId, a)));
}));

server.registerTool('browser_screenshot', {
  description: 'Screenshot via CDP Page.captureScreenshot: viewport (default), fullPage, or one element. The Overtake overlay is hidden from the capture unless includeOverlay. Optionally saves to an absolute path.',
  inputSchema: {
    tabId, fullPage: z.boolean().default(false), target: target.optional(), format: z.enum(['png', 'jpeg', 'webp']).default('png'), quality: z.number().int().min(1).max(100).optional(),
    path: z.string().optional().describe('Absolute file path to save the image. With a path, the image is not also returned inline unless inline is true (saves context).'),
    inline: z.boolean().optional().describe('Return the image inline. Default: true without path, false with path.'), includeOverlay: z.boolean().default(false),
  },
}, wrap(async (a: { tabId: number; fullPage: boolean; target?: string; format: 'png' | 'jpeg' | 'webp'; quality?: number; path?: string; inline?: boolean; includeOverlay: boolean }) => {
  const r = await engine.screenshot(a.tabId, a);
  const meta = { mimeType: r.mimeType, bytes: r.bytes, savedTo: r.savedTo, viewport: r.viewport, contentSize: r.contentSize, clip: r.clip, fullPage: r.fullPage };
  const content: Content[] = [{ type: 'text', text: JSON.stringify(meta) }];
  if (r.data && (a.inline ?? !a.path)) content.unshift({ type: 'image', data: r.data, mimeType: r.mimeType });
  return { content };
}));

server.registerTool('browser_evaluate', {
  description: 'Evaluate JavaScript in the page (console-style: top-level await allowed). Returns the JSON value or the exception. Pass expression, or file (absolute path to a .js file) to run a script you wrote once without re-sending it. Use frameId (from browser_frames) for iframes.',
  inputSchema: {
    tabId, expression: z.string().optional(), file: z.string().optional().describe('Absolute path to a .js, .mjs or .cjs file (max 1 MB) whose contents are evaluated instead of expression.'),
    frameId: z.string().optional(), awaitPromise: z.boolean().default(true), timeoutMs: z.number().int().max(120_000).optional(),
  },
}, wrap(async (a: { tabId: number; expression?: string; file?: string; frameId?: string; awaitPromise: boolean; timeoutMs?: number }) => {
  if (!!a.expression === !!a.file) throw new OvertakeError('BAD_REQUEST', 'Pass exactly one of expression or file.');
  return engine.evaluate(a.tabId, a.file ? readScriptFile(a.file) : a.expression!, a);
}));

server.registerTool('browser_run', {
  description: [
    'Run a whole flow from one script in this tab, so you are in the loop only at the start and the end. Write the script to a file once (file), then re-run it after fixes; or pass a short one inline (script).',
    'The script is the body of an async function. Each call uses the same real input and checks as the tools:',
    'click(target, {button, clickCount, force, humanlike, label}), type(target|null, text, {clear, submit, slowly}), fill(target, text), press(keys, {repeat}), hover(target), scroll({target, dx, dy}), drag(from, to), upload(target, files), dialog(accept, promptText),',
    'navigate(url, {waitFor, waitUntil, timeoutMs}), wait(selector | ms | {selector, state, text, urlIncludes, function, networkIdleMs, load, timeoutMs}), sleep(ms), snapshot({scope}) -> text with @refs, url(), evaluate(expressionOrFunction, ...args) -> value in the page,',
    'assert(condition, message), log(...values), console.log, args (your input). Targets are the same as the tools: @refs, CSS, "text=...", "xpath=...".',
    'Errors are thrown into the script (e.code, e.message) and may be caught. Uncaught ones fail the run with the step, the script line and a snapshot of the page.',
    'USER_IN_CONTROL, STOPPED and SPACE_CLOSED end the script at once, cannot be caught, and come back as a tool error. The return value of the script is returned as result.',
  ].join(' '),
  inputSchema: {
    tabId,
    file: z.string().optional().describe('Absolute path to a .js, .mjs or .cjs script file (max 1 MB).'),
    script: z.string().max(100_000).optional().describe('The script inline, for short one-off flows.'),
    args: z.unknown().optional().describe('Any JSON value, available to the script as args.'),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000).describe('Limit for the whole run.'),
    maxSteps: z.number().int().min(1).max(5000).default(1000).describe('Limit on API calls.'),
    ...snapshotOpts,
  },
}, wrap(async (a: { tabId: number; file?: string; script?: string; args?: unknown; timeoutMs: number; maxSteps: number } & SnapshotOpts) => {
  if (!!a.file === !!a.script) throw new OvertakeError('BAD_REQUEST', 'Pass exactly one of file or script.');
  const code = a.file ? readScriptFile(a.file) : a.script!;
  const r = await runScript(engine, client, { tabId: a.tabId, code, filename: a.file || scriptName(), args: a.args, timeoutMs: a.timeoutMs, maxSteps: a.maxSteps });
  if (r.hardStop) {
    const where = [r.error?.step && `step ${r.error.step}`, r.error?.line && `line ${r.error.line}`].filter(Boolean).join(', ');
    throw new OvertakeError(r.hardStop.code, `${r.hardStop.message} browser_run stopped${where ? ` at ${where}` : ''}; the steps before it ran.`);
  }
  const { hardStop: _h, lastActionAt, ...receipt } = r;
  // A failed run always comes with the page, so the script can be fixed without another call;
  // not while paused, where a snapshot would queue behind the pause.
  const paused = engine.isPaused(await engine.spaceOf(a.tabId));
  return afterAction(a.tabId, paused ? { ...receipt, note: 'The human paused the agent, so no snapshot was taken; your next command will wait for Resume.' } : receipt, { ...a, snapshot: a.snapshot || !r.ok }, lastActionAt);
}));

server.registerTool('browser_network', {
  description: 'Inspect network traffic captured since the tab was first used: list (filters), get (headers, post data, response body), or clear. Credentials (auth headers, cookies, token/password fields) are masked.',
  inputSchema: { tabId, action: z.enum(['list', 'get', 'clear']).default('list'), requestId: z.string().optional(), urlIncludes: z.string().optional(), type: z.string().optional(), status: z.number().int().optional(), failedOnly: z.boolean().optional(), includeBody: z.boolean().default(true), limit: z.number().int().max(400).default(50) },
}, wrap(async (a: { tabId: number; action: string; requestId?: string; urlIncludes?: string; type?: string; status?: number; failedOnly?: boolean; includeBody: boolean; limit: number }) => {
  await engine.ensureTab(a.tabId);
  if (a.action === 'clear') {
    engine.clearNetwork(a.tabId);
    return { cleared: true };
  }
  if (a.action === 'get') {
    if (!a.requestId) throw new OvertakeError('BAD_REQUEST', 'requestId is required.');
    return engine.networkDetail(a.tabId, a.requestId, a.includeBody);
  }
  return { requests: engine.network(a.tabId, a) };
}));

server.registerTool('browser_console', {
  description: 'Console messages, uncaught exceptions (with stacks) and browser log entries for a tab.',
  inputSchema: { tabId, level: z.string().optional().describe('Filter, e.g. "error", "exception", "warning".'), sinceSeq: z.number().int().optional(), limit: z.number().int().max(400).default(100) },
}, wrap(async (a: { tabId: number; level?: string; sinceSeq?: number; limit: number }) => {
  await engine.ensureTab(a.tabId);
  return { entries: engine.consoleEntries(a.tabId, a) };
}));

server.registerTool('browser_events', {
  description: 'Raw CDP events received for a tab (for domains you enabled with browser_cdp), filtered by method prefix and sequence.',
  inputSchema: { tabId, methodPrefix: z.string().optional(), sinceSeq: z.number().int().optional(), limit: z.number().int().max(500).default(50) },
}, wrap(async (a: { tabId: number; methodPrefix?: string; sinceSeq?: number; limit: number }) => ({ latestSeq: engine.latestSeq(), events: engine.events(a.tabId, a) })));

server.registerTool('browser_frames', { description: 'Frame tree of a tab, including out-of-process iframes and their CDP session ids.', inputSchema: { tabId } },
  wrap(async ({ tabId }: { tabId: number }) => engine.frames(tabId)));

// ---------------------------------------------------------------------------
// Input (real CDP Input events behind the Overtake input gate)

server.registerTool('browser_click', {
  description: 'Click an element with real CDP mouse input (the visible agent cursor glides there). Verifies the element is the top hit target unless force. Returns navigation, popups and dialogs observed.',
  inputSchema: {
    tabId, target, button: z.enum(['left', 'right', 'middle']).default('left'), clickCount: z.number().int().min(1).max(3).default(1), force: z.boolean().default(false),
    humanlike: z.boolean().default(false).describe('Also send real pointer moves along the path (slower; for pages that react to hover on the way).'),
    label: z.string().max(60).optional().describe('3-6 word description shown next to the agent cursor.'), ...snapshotOpts,
  },
}, wrap(async (a: { tabId: number; target: string; button: 'left' | 'right' | 'middle'; clickCount: number; force: boolean; humanlike: boolean; label?: string } & SnapshotOpts) => { const t0 = Date.now(); return afterAction(a.tabId, await engine.click(a.tabId, a.target, a), a, t0); }));

server.registerTool('browser_hover', { description: 'Move the mouse over an element.', inputSchema: { tabId, target, label: z.string().max(60).optional() } },
  wrap(async (a: { tabId: number; target: string; label?: string }) => engine.hover(a.tabId, a.target, a.label)));

server.registerTool('browser_type', {
  description: 'Type text. With target, clicks it first. clear replaces existing text; submit presses Enter; slowly sends per-key events instead of a single insertText.',
  inputSchema: { tabId, text: z.string(), target: target.optional(), clear: z.boolean().default(false), submit: z.boolean().default(false), slowly: z.boolean().default(false), label: z.string().max(60).optional(), ...snapshotOpts },
}, wrap(async (a: { tabId: number; text: string; target?: string; clear: boolean; submit: boolean; slowly: boolean; label?: string } & SnapshotOpts) => { const t0 = Date.now(); return afterAction(a.tabId, await engine.type(a.tabId, a), a, t0); }));

server.registerTool('browser_press', {
  description: 'Press a key or chord, Playwright syntax: "Enter", "Tab", "Shift+Tab", "ControlOrMeta+a", "ArrowDown".',
  inputSchema: { tabId, keys: z.string(), repeat: z.number().int().min(1).max(50).default(1), ...snapshotOpts },
}, wrap(async (a: { tabId: number; keys: string; repeat: number } & SnapshotOpts) => { const t0 = Date.now(); return afterAction(a.tabId, await engine.press(a.tabId, a.keys, a.repeat), a, t0); }));

server.registerTool('browser_scroll', {
  description: 'Scroll with real mouse-wheel input at an element or the viewport center. Positive dy scrolls down.',
  inputSchema: { tabId, target: target.optional(), dx: z.number().default(0), dy: z.number().default(600), label: z.string().max(60).optional() },
}, wrap(async (a: { tabId: number; target?: string; dx: number; dy: number; label?: string }) => engine.scroll(a.tabId, a)));

server.registerTool('browser_drag', { description: 'Drag with real mouse input from one target to another (pointer-event drags; native HTML5 drag-and-drop may not respond).', inputSchema: { tabId, from: target, to: target, label: z.string().max(60).optional() } },
  wrap(async (a: { tabId: number; from: string; to: string; label?: string }) => engine.drag(a.tabId, a.from, a.to, a.label)));

server.registerTool('browser_upload', {
  description: 'Upload local files: target an <input type=file> directly, or a button/area that opens the file chooser (it is clicked and the chooser is answered). Paths must be absolute.',
  inputSchema: { tabId, target, files: z.array(z.string()).min(1).max(20).describe('Absolute file paths.'), label: z.string().max(60).optional() },
}, wrap(async (a: { tabId: number; target: string; files: string[]; label?: string }) => engine.upload(a.tabId, a.target, a.files, a.label)));

server.registerTool('browser_downloads', {
  description: 'Downloads started from your Space. list; wait (for downloadId, or the newest download started since sinceMs, default the last 15 s) until it completes; save (copy a completed download to an absolute path). Files land in the user\'s normal download folder first.',
  inputSchema: {
    spaceId, action: z.enum(['list', 'wait', 'save']).default('list'), downloadId: z.number().int().optional(),
    sinceMs: z.number().int().optional().describe('Epoch ms; wait picks the newest download started after this.'),
    timeoutMs: z.number().int().min(0).max(600_000).default(30_000), path: z.string().optional().describe('save: absolute destination path.'),
  },
}, wrap(async (a: { spaceId: number; action: 'list' | 'wait' | 'save'; downloadId?: number; sinceMs?: number; timeoutMs: number; path?: string }) => engine.downloads(a.spaceId, a)));

server.registerTool('browser_dialog', { description: 'Accept or dismiss an open JavaScript alert/confirm/prompt.', inputSchema: { tabId, accept: z.boolean(), promptText: z.string().optional() } },
  wrap(async (a: { tabId: number; accept: boolean; promptText?: string }) => engine.dialog(a.tabId, a.accept, a.promptText)));

// ---------------------------------------------------------------------------
// Advanced CDP

server.registerTool('browser_intercept', {
  description: 'Intercept network requests in a tab (CDP Fetch): add a rule that fulfills (mock) or blocks matching URLs (glob with *), remove/clear rules, or list them. Interception is lifted automatically while the human has control.',
  inputSchema: { tabId, action: z.enum(['add', 'remove', 'list', 'clear']), urlPattern: z.string().optional(), block: z.boolean().optional(), status: z.number().int().optional(), body: z.string().optional(), contentType: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), ruleId: z.number().int().optional() },
}, wrap(async (a: { tabId: number; action: 'add' | 'remove' | 'list' | 'clear' } & Record<string, unknown>) => engine.intercept(a.tabId, a as Parameters<Engine['intercept']>[1])));

server.registerTool('browser_emulate', {
  description: `Device/viewport emulation. Presets: ${Object.keys(DEVICES).join(', ')}. Or set width/height/deviceScaleFactor/mobile, userAgent, touch, colorScheme, offline. reset clears all.`,
  inputSchema: { tabId, device: z.string().optional(), width: z.number().int().optional(), height: z.number().int().optional(), deviceScaleFactor: z.number().optional(), mobile: z.boolean().optional(), userAgent: z.string().optional(), touch: z.boolean().optional(), colorScheme: z.enum(['light', 'dark']).optional(), offline: z.boolean().optional(), reset: z.boolean().optional() },
}, wrap(async (a: { tabId: number } & Record<string, unknown>) => engine.emulate(a.tabId, a as Parameters<Engine['emulate']>[1])));

server.registerTool('browser_trace', {
  description: 'Performance tracing: start, then stop to save a Chrome trace JSON (loadable in DevTools Performance) with a metrics summary.',
  inputSchema: { tabId, action: z.enum(['start', 'stop']), categories: z.array(z.string()).optional(), path: z.string().optional() },
}, wrap(async (a: { tabId: number; action: 'start' | 'stop'; categories?: string[]; path?: string }) => (a.action === 'start' ? engine.traceStart(a.tabId, a.categories) : engine.traceStop(a.tabId, a.path))));

server.registerTool('browser_debug', {
  description: 'JavaScript debugger: enable, set_breakpoint (url|urlRegex + 1-based line, optional condition), remove_breakpoint, pause, resume, step_over, step_into, step_out, state (call frames + locals), evaluate (on the top paused frame), disable.',
  inputSchema: { tabId, action: z.enum(['enable', 'disable', 'set_breakpoint', 'remove_breakpoint', 'pause', 'resume', 'step_over', 'step_into', 'step_out', 'state', 'evaluate']), url: z.string().optional(), urlRegex: z.string().optional(), line: z.number().int().optional(), column: z.number().int().optional(), condition: z.string().optional(), breakpointId: z.string().optional(), expression: z.string().optional() },
}, wrap(async (a: { tabId: number; action: string } & Record<string, unknown>) => engine.debug(a.tabId, a as Parameters<Engine['debug']>[1])));

server.registerTool('browser_cdp', {
  description: 'Send any Chrome DevTools Protocol command to a tab you control (validated; Input.* goes through the input gate; profile-wide cookie/cache commands are denied; credentials in results such as headers, cookie values and token fields are masked). Use sessionId (browser_frames) for out-of-process iframes. Events arrive in browser_events.',
  inputSchema: { tabId, method: z.string().regex(/^[A-Z][A-Za-z]+\.[a-z][A-Za-z]+$/), params: z.record(z.string(), z.unknown()).default({}), sessionId: z.string().optional() },
}, wrap(async (a: { tabId: number; method: string; params: Record<string, unknown>; sessionId?: string }) => {
  if (a.method.startsWith('Network.') || a.method.startsWith('Runtime.') || a.method.startsWith('Page.')) await engine.ensureTab(a.tabId);
  // Raw results can carry credentials (headers, cookies, bodies); mask them like browser_network does.
  return redactCdp(await client.request('cdp', { tabId: a.tabId, method: a.method, params: a.params, sessionId: a.sessionId }));
}));

server.registerTool('browser_capabilities', { description: 'Probe which CDP domains work on this tab through the extension-owned debugger, and whether the browser-level input gate is available.', inputSchema: { tabId } },
  wrap(async ({ tabId }: { tabId: number }) => client.request('capabilities', { tabId }, 60_000)));

await server.connect(new StdioServerTransport());
process.stdin.on('end', () => {
  client.close();
  process.exit(0);
});
