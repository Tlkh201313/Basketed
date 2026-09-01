/**
 * Basketed Connect — service worker.
 *
 * The one thing this extension exists to do: read the session for a store
 * the user just signed into, IN THE BROWSER THEY ALREADY USE, and hand it to
 * the Basketed panel running on this machine.
 *
 * Why it has to be an extension. Chrome 136 stopped honouring
 * `--remote-debugging-port` against the default profile, on purpose, so that
 * no process can read another profile's cookies over CDP. That is the right
 * call, and it means an outside program cannot capture a session from the
 * user's real browser — ever. The sanctioned way in is from the inside, with
 * a permission the user granted at install: `chrome.cookies`. That is this
 * file.
 *
 * What it will not do:
 *   - It never reads a cookie for a domain the panel did not ask about, and
 *     the manifest's host permissions list is the outer bound on that.
 *   - It never talks to anything but 127.0.0.1/localhost, and only to answer
 *     a page that proved it holds the panel token.
 *   - It stores nothing. Every value it reads goes to the panel that asked
 *     and is gone when the message handler returns.
 */

/**
 * Request headers seen in flight, keyed by the URL fragment identifying the
 * API they belong to, then by header name.
 *
 * Some retailers' credentials are not in the cookie jar at all: Tesco's basket
 * API authenticates on the `authorization` + `customer-uuid` pair its own
 * frontend sends to xapi.tesco.com, and a bearer alone returns a basket that
 * is not yours. `onSendHeaders` is observational
 * only — it cannot block, redirect or alter a request, and this listener does
 * not try to.
 */
const capturedHeaders = new Map(); // match -> { headerName: value }

/** match -> header names, lower-case. Only what the panel named is ever read. */
const watched = new Map();

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!watched.size) return;
    for (const [match, names] of watched) {
      if (!details.url.includes(match)) continue;
      const bag = capturedHeaders.get(match) || {};
      for (const h of details.requestHeaders || []) {
        const name = h.name.toLowerCase();
        if (names.includes(name) && h.value) bag[name] = h.value;
      }
      capturedHeaders.set(match, bag);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

/**
 * Ask the panel itself whether the page that messaged us is really the panel.
 *
 * The content script runs on every 127.0.0.1 page, and localhost is shared
 * ground — without this, any local page could ask for a retailer's cookies.
 * The token is the same one that gates every other panel route, and a page
 * that does not hold it gets a 401 here and nothing at all from us.
 */
async function panelHoldsToken(origin, token) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return false;
  if (!token) return false;
  try {
    const res = await fetch(`${origin}/api/extension/verify`, {
      headers: { "x-basketed-token": token },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.panel === "basketed";
  } catch {
    return false;
  }
}

/** Every cookie this browser holds for a domain and its subdomains. */
async function cookiesFor(domains) {
  const seen = new Map();
  for (const domain of domains) {
    let jar = [];
    try {
      jar = await chrome.cookies.getAll({ domain });
    } catch {
      // no permission for that domain, or none set yet — say so by omission
    }
    for (const c of jar) if (c.value) seen.set(c.name, c.value);
  }
  return [...seen].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Does this jar carry a cookie only a signed-in session has? */
function looksSignedIn(cookieHeader, authCookies) {
  if (!authCookies || !authCookies.length) return false;
  const names = cookieHeader.split("; ").map((pair) => pair.slice(0, pair.indexOf("=")).toLowerCase());
  return authCookies.some((prefix) => names.some((n) => n.startsWith(String(prefix).toLowerCase())));
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.type !== "basketed-capture") return false;

  (async () => {
    if (!(await panelHoldsToken(msg.origin, msg.token))) {
      respond({ ok: false, error: "not the Basketed panel" });
      return;
    }
    // Arm the listener before answering: the page asks repeatedly while it
    // waits, so the first ask starts watching and a later one collects.
    if (msg.capture) {
      watched.set(msg.capture.match, (msg.capture.headers || []).map((h) => String(h).toLowerCase()));
    }

    const cookieHeader = await cookiesFor(msg.domains || []);
    const headers = msg.capture ? capturedHeaders.get(msg.capture.match) || {} : {};
    // A COMPLETE set proves a signed-in session. A partial one proves nothing:
    // the signed-out site calls the same API with fewer headers on it.
    const complete = msg.capture
      ? (msg.capture.headers || []).every((h) => headers[String(h).toLowerCase()])
      : false;
    respond({
      ok: true,
      cookieHeader,
      headers,
      signedIn: looksSignedIn(cookieHeader, msg.authCookies) || complete,
    });
  })();

  return true; // async respond
});
