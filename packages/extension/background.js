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
 *   - It stores nothing on disk. State lives in `chrome.storage.session`,
 *     which is memory-only and dies with the browser — see below for why it
 *     has to live anywhere at all.
 *
 * ## Why there is state here, and why it is in storage.session (S24)
 *
 * An MV3 service worker is killed after ~30 seconds idle and restarted on the
 * next event. Until S24 the watch list and the captured headers were plain
 * `Map`s at module scope, which meant every one of those deaths silently
 * threw the capture away: the `onSendHeaders` listener re-registered on wake,
 * found an empty watch list, and dropped every request until the panel's next
 * poll re-armed it 2.5 seconds later. A user who was already signed in and
 * simply waiting saw "not signed in yet" forever, because the one request
 * that carried their credential flew during a window when nothing was
 * listening.
 *
 * `chrome.storage.session` is the MV3-sanctioned answer: memory-backed, wiped
 * on browser exit, never written to disk, and it survives the worker dying.
 */

/** URL fragment -> [header names, lower-case]. Only what the panel named. */
let watched = new Map();

/** URL fragment -> { headerName: value }, as last seen in flight. */
let capturedHeaders = new Map();

/**
 * False until `storage.session` has been read back.
 *
 * Listeners must be registered synchronously at the top level or Chrome will
 * not wake the worker for their events, so registration necessarily happens
 * before hydration finishes. Requests arriving in that gap are buffered and
 * replayed rather than dropped — that gap is exactly where the credential
 * went missing before.
 */
let hydrated = false;

/** Bounded, memory-only, cleared the moment hydration replays it. */
const preHydrationBuffer = [];
const PRE_HYDRATION_MAX = 25;

async function persist() {
  try {
    await chrome.storage.session.set({
      watched: [...watched],
      capturedHeaders: [...capturedHeaders],
    });
  } catch {
    // storage.session is unavailable in some embedders; the in-memory maps
    // still work for as long as this worker lives, so this is a degradation
    // and not a failure.
  }
}

/**
 * Keep any watched header this request carried. Returns true if it kept one.
 *
 * Split out of the listener so hydration can replay buffered requests through
 * exactly the same matching, rather than a second copy of it that could drift.
 */
function absorb(details) {
  let kept = false;
  for (const [match, names] of watched) {
    if (!details.url.includes(match)) continue;
    const bag = capturedHeaders.get(match) || {};
    for (const h of details.requestHeaders || []) {
      const name = h.name.toLowerCase();
      if (names.includes(name) && h.value && bag[name] !== h.value) {
        bag[name] = h.value;
        kept = true;
      }
    }
    capturedHeaders.set(match, bag);
  }
  return kept;
}

async function hydrate() {
  try {
    const saved = await chrome.storage.session.get(["watched", "capturedHeaders"]);
    if (Array.isArray(saved.watched)) watched = new Map(saved.watched);
    if (Array.isArray(saved.capturedHeaders)) capturedHeaders = new Map(saved.capturedHeaders);
  } catch {
    // nothing saved, or no session storage; start empty
  }
  hydrated = true;
  // Replay whatever flew while we were coming back up. This is the whole
  // point of the buffer: on a cold wake, the request that carries the
  // credential often IS the one that woke us.
  const pending = preHydrationBuffer.splice(0, preHydrationBuffer.length);
  let hit = false;
  for (const details of pending) hit = absorb(details) || hit;
  if (hit) await persist();
}

/**
 * Request headers seen in flight.
 *
 * Some retailers' credentials are not in the cookie jar at all: Tesco's basket
 * API authenticates on the `authorization` + `customer-uuid` pair its own
 * frontend sends to xapi.tesco.com, and a bearer alone returns a basket that
 * is not yours. `onSendHeaders` is observational only — it cannot block,
 * redirect or alter a request, and this listener does not try to.
 */
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!hydrated) {
      // Cannot await here; the listener is synchronous by contract. Hold the
      // request until the watch list is back, then replay it.
      if (preHydrationBuffer.length < PRE_HYDRATION_MAX) preHydrationBuffer.push(details);
      return;
    }
    if (!watched.size) return;
    if (absorb(details)) void persist();
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

void hydrate();

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
    // The version rides on the path so `basketed doctor` can report which
    // build of this extension last spoke to a panel. The panel answers the
    // bare path too, so an older extension is not locked out by a newer CLI.
    const version = encodeURIComponent(chrome.runtime.getManifest().version || "");
    const res = await fetch(`${origin}/api/extension/verify/${version}`, {
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

/**
 * Arm the header watch for a store.
 *
 * Separated from the capture so the panel can arm on PAGE LOAD, before the
 * user has clicked anything. Arming at first-poll instead was a race the
 * already-signed-in user lost: the tab opened, Tesco's frontend made its one
 * authenticated call, and the listener started watching just after it.
 */
async function arm(capture) {
  if (!capture || !capture.match) return;
  const names = (capture.headers || []).map((h) => String(h).toLowerCase());
  const had = watched.get(capture.match);
  if (had && had.length === names.length && had.every((n, i) => n === names[i])) return;
  watched.set(capture.match, names);
  await persist();
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || (msg.type !== "basketed-capture" && msg.type !== "basketed-arm")) return false;

  (async () => {
    if (!(await panelHoldsToken(msg.origin, msg.token))) {
      respond({ ok: false, error: "not the Basketed panel" });
      return;
    }
    await arm(msg.capture);

    // Arm-only: the connect page announcing itself before any click. Says
    // nothing about cookies, because nothing has been asked for yet.
    if (msg.type === "basketed-arm") {
      respond({ ok: true, armed: true });
      return;
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
      complete,
      signedIn: looksSignedIn(cookieHeader, msg.authCookies) || complete,
    });
  })();

  return true; // async respond
});
