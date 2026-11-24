// Turns a failed Page.navigate into an error the agent can act on.
//
// Certificate errors need special handling. Extensions cannot bypass them: chrome.debugger does
// not expose the CDP Security domain, and Chrome's warning page cannot be attached to, so an
// agent that tries Security.* or snapshots the warning page only wastes turns. The user can click
// through the warning once, and Chrome then remembers that choice for the site until it restarts.

import { ErrorCode, OvertakeError } from '../shared/protocol.ts';

export const isCertError = (errorText: string) => /\bERR_CERT/i.test(errorText);

export function navigationError(url: string, errorText: string): OvertakeError {
  if (!isCertError(errorText)) return new OvertakeError(ErrorCode.CDP_ERROR, `Navigation to ${url} failed: ${errorText}`);
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw url */ }
  return new OvertakeError(
    ErrorCode.CERT_ERROR,
    `Navigation to ${url} failed: ${errorText}. Chrome does not trust this site's certificate and shows a warning page. ` +
      'Extensions cannot bypass certificate errors (the CDP Security domain is not available), so do not try browser_cdp. ' +
      `Call space_handoff asking the user to click "Advanced", then "Proceed to ${host} (unsafe)", end your turn, and after ` +
      'space_resume navigate again; Chrome remembers the choice for this site until it restarts. If the warning has no ' +
      'Proceed link (HSTS sites), the page cannot be opened. For local development a trusted certificate (mkcert) or ' +
      'chrome://flags/#allow-insecure-localhost avoids the warning.',
  );
}
