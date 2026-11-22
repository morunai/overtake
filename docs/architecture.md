# Overtake architecture

Overtake runs an agent browser inside stock Google Chrome. The **extension service worker** is
the authority: it validates Space, ownership and control state before any agent CDP message
reaches a tab. The **MCP server (Node)** is the engine that turns tool calls into CDP commands.

```
Claude Code session ──stdio MCP──▶ mcp/server.ts + engine.ts           (one per agent; stable agentKey)
Claude Code session ──stdio MCP──▶ mcp/server.ts + engine.ts
                                        │  unix socket ~/.overtake/run/broker.sock (0600, dir 0700)
                                        │  first message must carry the 256-bit token (~/.overtake/token, 0600)
                                        ▼
                                 bridge/broker.ts  (Chrome native-messaging host; launched by Chrome only
                                        │            for the extension id in allowed_origins; no TCP)
                                        │  native messaging (stdin/stdout, length-prefixed JSON)
                                        ▼
                      extension service worker (authority)
                        Spaces = dedicated windows + tab group
                        control state machine per Space        shared/control.ts
                        FIFO executor per Space (gated)        shared/executor.ts
                        CDP policy (deny-list, validation)     cdp-policy.ts
                        input gate (browser + page level)      main.ts runInputBurst
                        chrome.debugger: the only CDP client   debugger.ts
                                        │ chrome.tabs.sendMessage (acknowledged)
                                        ▼
                      overlay content script (every frame)     content/overlay.ts
                        closed Shadow DOM in the top layer: glow, cursor, ripples, dock, input shield
```

| Concern | Where it lives |
|---|---|
| Agent transport | MCP stdio → token-authenticated unix socket → native messaging |
| High-level automation (snapshot, click, wait, files) | MCP server process, `mcp/engine.ts` |
| CDP dispatch with ownership and control checks | `cdp` op in the service worker, before `chrome.debugger.sendCommand` |
| Command ordering | per-Space `SpaceExecutor` in the extension, plus a per-Space mutex in the engine |
| Human input shield and dock | Shadow-DOM overlay with a hit-test blocker, capture-phase filters and a dock |
| Agent cursor | derived by the service worker from every agent `Input.dispatchMouseEvent` |
| Action labels / status | `label` on input bursts → dock status + cursor label; `space_status` |
| Control states | `AGENT_CONTROL`, `USER_CONTROL` (takeover / handoff), `AGENT_PAUSED`, `STOPPED` |
| Spaces overview | `overview.html` extension page with live previews |

## Transport decision: Option A (extension-owned `chrome.debugger`)

| Criterion | A: `chrome.debugger` in the extension | B: external CDP (chrome-devtools-mcp `--autoConnect`, remote debugging) |
|---|---|---|
| Works in the everyday Chrome without relaunching or flags | **yes** | needs remote debugging enabled and a per-connection approval |
| One authority for ownership and gating | **yes**: the same process owns tabs, windows, UI and CDP | no: any client holding the endpoint can drive every tab, so gating would be advisory |
| Competing debugger attachments | none (single client per tab) | an extension for the UI plus an external client would mean two clients per target |
| Exposes a local control surface | no (native messaging plus a 0600 socket) | a browser-wide DevTools endpoint |
| Page-level CDP coverage | measured: Page, Runtime, DOM, DOMSnapshot, Accessibility, Network, Fetch, Emulation, Input, Log, Audits, Performance, Tracing, Debugger, Storage (per-origin) all **ok** | full |
| Gaps | `Profiler.*`, `HeapProfiler.*` "wasn't found"; `Target.getTargets` "Not allowed"; `Browser.*` and `SystemInfo.*` unavailable; Chrome's "is debugging this browser" infobar | none, but no ownership model |

These gaps are reported by `browser_capabilities`; the exact output is in the README. A,
plus a raw `browser_cdp` passthrough, covers every capability in the brief. Performance
work uses `Tracing`, which is available, instead of `Profiler`. Chrome DevTools MCP is not
bundled, to avoid a second debugger attached to agent tabs. Its high-level tools
(snapshot, click, network, console, emulation, trace) have equivalents here, and anything
else is reachable through `browser_cdp`.

## Control state machine (`shared/control.ts`)

| From \ event | agent claim | agent handoff | agent resume | human Take over | human Give back | human Pause / Resume | human Stop | owner disconnects |
|---|---|---|---|---|---|---|---|---|
| AGENT_CONTROL | – | USER(handoff) | – | USER(takeover) | – | → PAUSED | STOPPED, owner cleared | USER(agent-disconnected) |
| AGENT_PAUSED | – | USER(handoff) | refused | USER(takeover) | – | → AGENT | STOPPED | USER(agent-disconnected) |
| USER(takeover) | **refused** | – | **refused** | – | → AGENT | – | STOPPED | flag only |
| USER(handoff) | → AGENT | – | → AGENT (owner) | – | → AGENT | – | STOPPED | flag only |
| USER(unclaimed/released/disconnected) | → AGENT | – | – | – | if owner is connected | – | STOPPED | – |
| STOPPED | → AGENT (explicit) | – | – | – | – | – | – | – |

Gate (`gate()`), evaluated *when a command reaches the head of the Space's queue*:
- owner and AGENT_CONTROL: run
- owner and AGENT_PAUSED: wait (default 120 s, then `AGENT_PAUSED_TIMEOUT`)
- anything else: refuse (`USER_IN_CONTROL`, `NOT_OWNER`, `STOPPED`)

Take over, hand-off, stop and disconnect also reject every queued command and lift
agent request interception (`Fetch.disable`), so no request hangs while the human
drives. Commands that resolve work the queue head is waiting on bypass the FIFO but are
still ownership-gated. These are `Fetch.continue*/fulfill/fail`,
`Debugger.resume/step*/evaluateOnCallFrame`, `Page.handleJavaScriptDialog`,
`Runtime.getProperties` and `Runtime.terminateExecution`; without the bypass, a breakpoint
or a paused request would deadlock the queue. Every queued command has a 45 s deadline
(callers can raise it to 300 s), so a hung CDP call fails with `TIMEOUT` instead of wedging
a Space. A real Claude Code session hit exactly this before it was fixed.

## Input gate

A native browser could block human input with a view above the page that CDP input bypasses.
An extension cannot draw there. Measured facts in Chrome 158:

1. `Input.setIgnoreInputEvents(true)` drops all input for the page, from every source,
   **including CDP input** (tested from the same and from another DevTools session).
2. It resets automatically when the session that set it detaches, so a crash fails open.
3. Toggling it off and on takes about 0.5 ms.

Two layers follow from that:

* **Between agent actions** the overlay's hit-test blocker covers the page, iframes
  included, and capture-phase listeners in every frame cancel trusted pointer, keyboard,
  wheel, touch, clipboard and `beforeinput` events. The dock is exempt, so Take over is
  always clickable.
* **During an agent burst** (`input.batch`), for each step:
  1. `setIgnoreInputEvents(true)`: Chrome drops human input.
  2. All frames are told to pass input (acknowledged). The top frame makes the overlay
     `inert`, so CDP clicks hit page elements.
  3. The top frame receives an acknowledged **permit** that names the DOM event types and
     coordinates (or key) this step will produce; only matching trusted events pass.
  4. The gate opens, the step is dispatched, and the gate closes.
  5. When the burst ends, the shields are restored and the native gate reopens.

Measured in `tests/e2e/acceptance.test.ts`: **10,104–10,483 trusted human clicks during
a 120-event agent typing burst; none landed; all 60 agent keystrokes landed.**

Escape routes outside the page: the toolbar icon (opens the Spaces overview tab), the
`Alt+Shift+E` command (take over / give back), and the overview page.
Dismissing Chrome's debugging infobar ("Cancel") is treated as a Take over.

Limits (stated, not hidden):
* The overlay lives inside the page. It cannot cover browser chrome, and DevTools or the
  omnibox remain usable.
* Subframes cannot see the top frame's permit, so during a burst they rely on the native
  gate alone. That leaves a residual window of about 1 ms per step, and only for input
  that targets an iframe.
* Page top-layer content (modal `<dialog>`, fullscreen) is answered by re-raising the
  overlay popover, but a page that hostilely fights the top layer can cover the dock. The
  toolbar icon and keyboard escape routes still work.
* Content scripts do not run on `chrome://` pages, and the debugger cannot attach there
  either: such tabs report `PROTECTED_PAGE`.

## Visuals

Layers inside the overlay's closed shadow root (top layer):

| Layer | Role | Pointer events |
|---|---|---|
| `.edge` | atmospheric edge light (blue; amber when paused) | none |
| `.blocker` | **the input shield**, the only layer that blocks input | auto while the agent drives |
| `canvas.field` | agent field: trail-revealed dot grid, click ripples, cursor glow (`agent-field.ts`) | none |
| `.cursor` | arrow + action label, positioned by the field's spring each frame | none |
| `.dock` | floating control dock | interactive |

The service worker relays the coordinates of every agent `Input.dispatchMouseEvent` step to the
top frame, and those are the only source of motion. The field smooths them with a critically
damped spring (ω = 16 rad/s). While moving, it records up to 15 trail samples and reveals the fixed 8 px grid with a `(1 − d²)²` falloff, per-dot two-octave noise, a
55 ms lag at the tip and a 260 ms decay. `mousePressed` adds a ripple ring (200 px/s) that lights
and pushes the dots it touches; they settle on an under-damped spring. Idle cursors bob by 2.5 px
and the action label fades after 2.6 s. The dock's text and actions follow the bridge's control
state; nothing changes ownership on the client side. Agent screenshots hide the overlay for one
frame unless `includeOverlay`.

A separate ambient clock drives soft diagonal waves through the grid even before the first
pointer action. Small white dots (neutral grey on light pages) remain faintly visible across the
page and brighten under broad passing crests. WebGL and the Canvas 2D fallback both support this effect. Ambient
frames are capped at about 30 fps; pointer activity uses the display refresh rate. Pause freezes
the clock and dims the field in amber. Human takeover fades to a fully cleared canvas. Reduced
motion keeps a static field and suppresses pointer trails and ripples; changing that preference
wakes the renderer. Settled paused, reduced-motion and hidden fields request no more frames.

## Spaces

* The overview shows Spaces in a stable order (oldest first) as 16:10 preview cards about
  428 px wide at a 2000 px window, plus a New Space tile; narrower windows get fewer columns.
  Cards update in place (no rebuilds while an agent works) and open on one click or Enter.
* A Space is a dedicated window, created unfocused so it doesn't steal the user's focus,
  at the size and position of the user's current window.
  Tab groups are off by default: Chrome's saved tab groups keep and sync every group after its
  tabs close, and extensions cannot delete saved groups. They can be enabled with
  `chrome.storage.local.set({useTabGroups: true})` in the extension's service worker console.
* If the human closes the Space's last agent tab (tab ✕, "Close group" and so on), the Space
  ends: queued work is cancelled and the agent gets `SPACE_CLOSED`. Chrome-created pages such
  as New Tab are never counted as the agent's.
* Tabs carry `openedBy` (`agent`/`user`) and `managed`. Agents may only operate managed
  tabs. User-opened tabs need an explicit `adopt` and can never be closed by an agent;
  closing a Space that contains them releases it instead. Popups opened by a managed tab
  while the agent drives are adopted automatically.
* **Isolation:** Spaces in one profile share cookies and storage. This was measured. For real
  isolation, `scripts/isolated-chrome.mjs <name>` runs a **separate Chrome process with its
  own profile**: same extension, its own broker and socket, controlled over
  `--remote-debugging-pipe` (no port). The isolation E2E test verifies it shares nothing.
* State lives in `chrome.storage.session`, so it survives service-worker restarts. After a
  restart, no Space comes back in an agent state.

## Security model

* No TCP listener anywhere. The socket and directories are owner-only; the token is
  checked in constant time in the first message, and unauthenticated sockets are dropped
  after 5 s.
* Origin restriction: Chrome launches the broker only for `chrome-extension://<fixed id>/`
  (the manifest `key` pins the id).
* Per-session authorization: the broker stamps each request with the connection's agentKey
  (clients cannot spoof one; tested), and the extension enforces ownership per Space and tab.
* Human actions come only from the extension's own pages, or from a content script acting
  on its own tab's Space. Dock buttons ignore untrusted (script-generated) clicks.
* CDP deny-list: profile-wide cookie reads and writes, cache clearing, browser close/crash,
  target creation and closing, download behaviour, and the gate's own
  `Input.setIgnoreInputEvents`.
* Network results: `browser_network`, `browser_events` and `browser_cdp` mask credentials before returning them to the agent:
  `Authorization`, `Cookie`, `Set-Cookie` and other auth headers, plus token, password,
  session and API-key fields in query strings and JSON or form bodies (`mcp/redact.ts`).
  Tool results land in the model's context and transcripts, so they are treated as logs.
  `browser_evaluate` is deliberately not filtered: page JavaScript can read whatever the page
  can, and an output filter would only give a false sense of safety.
* Logs: the broker logs connection events with the token redacted. The MCP server logs tool
  name, duration and outcome, never arguments or page data.

## Failure handling

| Event | Behaviour (tested) |
|---|---|
| Tab closed during a command | fails fast (`DEBUGGER_DETACHED`/`TAB_CLOSED`, under 3 s), tab removed from the Space |
| Navigation | the debugger stays attached; refs invalidate (`ELEMENT_NOT_FOUND: stale`); the shield is re-applied at `document_start` |
| Debugger re-attached (e.g. after Stop) | `debugger-attached` event → the engine rebuilds domain state and child sessions |
| Agent process exits | broker → extension: Space goes to `USER_CONTROL(agent-disconnected)`, shield removed, queue rejected |
| Extension reloaded or removed | content scripts detect a dead runtime → shield removes itself (fail-open heartbeat, 2 s) |
| Service worker restarts | the native port keeps it alive; if it restarts anyway, Spaces restore without agent control |
| Protected page | `PROTECTED_PAGE`, never a fake success |
