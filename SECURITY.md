# Security policy

Overtake lets AI agents drive a real, signed-in Chrome, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report it privately through GitHub instead: open the repository's **Security** tab and choose
**Report a vulnerability**. Include:

- what an attacker can do, and from where (a web page, another local process, an agent, another
  extension);
- steps to reproduce, ideally with a minimal page or script;
- your macOS, Chrome and Overtake versions (`chrome://version`, `git rev-parse HEAD`).

You can expect an acknowledgement within 7 days. Once a fix is available, the report will be
credited in the release notes unless you prefer otherwise.

## Supported versions

Overtake is an early preview. Only the latest commit on `main` receives security fixes.

## In scope

Problems in Overtake's own protections, for example:

- connecting to the broker without the token, or reading the token;
- the broker accepting a connection from an origin other than the Overtake extension;
- an agent acting in a Space it does not own, or on tabs outside its Spaces;
- agent commands still running after the human took over, paused or stopped a Space;
- human input reaching the page while it is supposed to be blocked, or the reverse: the human
  being unable to take back control;
- bypassing the CDP policy (for example profile-wide cookie access or browser shutdown);
- web page content being able to send commands to the extension, broker or MCP server;
- the token or other secrets appearing in logs, screenshots or tool results.

## Out of scope

- **Prompt injection as such.** A page manipulating the model into doing something the user did
  not intend is a risk for every browser agent and is not something Overtake can fully prevent.
  See [Prompt injection](README.md#prompt-injection) for mitigations. A report is still in scope
  when page content can get past one of Overtake's protections listed above.
- Data read with `browser_evaluate`. It runs JavaScript with the page's own access by design
  and is not filtered. Credentials leaking through `browser_network`, `browser_events` or
  `browser_cdp` results are in scope.
- Sites detecting automation through CDP, and Chrome's "is debugging this browser" bar.
- Attacks that require an attacker already running code as your user account, beyond what is
  listed above.
- Issues in Chrome, the MCP client or the model provider. Please report those upstream.
