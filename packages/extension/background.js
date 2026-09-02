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
 *   - It never talks to anything but the ONE local origin pinned in settings,
 *     and only to answer a page served from that same origin holding the
 *     panel token.
 *   - It stores nothing but that pinned origin. Every value it reads goes to
 *     the panel that asked and is gone when the message handler returns.
 */

/**
 * The panel's address, pinned — and the entire reason this extension is safe.
 *
 * Cookies and content scripts do not distinguish ports: `127.0.0.1:9999` is
 * the same host as `127.0.0.1:8787`, so the content script runs on every local
 * page and any of them can message this worker. Asking the CALLER whether it
 * is the panel — which is what this used to do — is circular: a hostile local
 * server answers "yes, I am the panel" to its own verify route and is handed
 * the user's retailer cookies.
 *
 * So the answer cannot come from the caller. It comes from here: one origin
 * the user pinned, and a token that must check out AGAINST THAT ORIGIN rather
 * than against whoever is asking.
 *
 * Defaulted to the port `basketed serve` prefers, so the usual install needs
 * nothing typed. Residual risk, stated plainly: a hostile server that occupies
 * 8787 while the real panel is not running would be trusted. That is a much
 * narrower window than "any local port", and it is the same assumption the
 * user already makes when they open the panel at all — and the options page is
 * there for anyone whose panel lives elsewhere.
 */
const DEFAULT_ORIGIN = "http://127.0.0.1:8787";

async function pinnedOrigin() {
  const stored = await chrome.storage.local.get({ panelOrigin: DEFAULT_ORIGIN });
  return String(stored.panelOrigin || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

/**
 * Bearer tokens seen in flight, keyed by the URL fragment that identifies the
 * API they belong to.
 *
 * Some retailers' credentials are not in the cookie jar at all: Tesco's
 * basket is a bearer API, and its own frontend sends the token as an
 * `Authorization` header to xapi.tesco.com. `onSendHeaders` is observational
 * only — it cannot block, redirect or alter a request, and this listener does
 * not try to.
 */
const bearers = new Map();

/** Only ever recorded for a URL the PANEL named. Nothing else is looked at. */
const watchedMatches = new Set();

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!watchedMatches.size) return;
    for (const match of watchedMatches) {
      if (!details.url.includes(match)) continue;
      const header = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === "authorization");
      if (!header || !header.value) continue;
      bearers.set(match, header.value.replace(/^Bearer\s+/i, "").trim());
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

/**
 * Ask the PINNED panel — never the caller — whether this token is real, and
 * what is currently waiting on a sign-in.
 *
 * Returns null for "not the panel, or it does not know you". The pending list
 * is where the domains come from: see whyNotTheCaller in the handler below.
 */
async function askPinnedPanel(origin, token) {
  if (!token) return null;
  try {
    const res = await fetch(`${origin}/api/extension/verify`, {
      headers: { "x-basketed-token": token },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || body.panel !== "basketed") return null;
    return Array.isArray(body.pending) ? body.pending : [];
  } catch {
    return null;
  }
}

/** The origin a message actually came from, per Chrome — not per the page. */
function senderOrigin(sender) {
  if (sender && sender.origin) return sender.origin;
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
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

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== "basketed-capture") return false;

  (async () => {
    const origin = await pinnedOrigin();

    // 1. The tab really is the pinned panel's origin. Chrome says so, not the
    //    page: `sender.origin` cannot be forged by page script.
    if (senderOrigin(sender) !== origin) {
      respond({ ok: false, error: `not the Basketed panel (this extension is pinned to ${origin})` });
      return;
    }

    // 2. And it holds the token, checked against the PINNED origin.
    const pending = await askPinnedPanel(origin, msg.token);
    if (pending === null) {
      respond({ ok: false, error: "not the Basketed panel" });
      return;
    }

    /*
     * whyNotTheCaller: the domains come from the server's pending note, not
     * from `msg`. Even a page that holds the token should not get to name the
     * jar it wants opened — "read cookies for X" is a policy decision, and the
     * note also proves the user pressed Connect on this store within the last
     * fifteen minutes. No note, nothing read.
     */
    const note = pending.find((p) => p.store_id === msg.storeId);
    if (!note) {
      respond({ ok: false, error: "no sign-in is in flight for that store" });
      return;
    }

    const bearerMatch = note.bearer_match || "";
    if (bearerMatch) watchedMatches.add(bearerMatch);

    const cookieHeader = await cookiesFor(note.domains || []);
    const bearer = bearerMatch ? bearers.get(bearerMatch) || "" : "";
    respond({
      ok: true,
      cookieHeader,
      bearer,
      signedIn: looksSignedIn(cookieHeader, note.auth_cookies) || Boolean(bearer),
    });
  })();

  return true; // async respond
});
