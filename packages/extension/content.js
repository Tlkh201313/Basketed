/**
 * Basketed Connect — the bridge on the panel page.
 *
 * Runs only on 127.0.0.1/localhost pages. It does two things and nothing
 * else:
 *
 *   1. Marks the page, so the panel can say "extension detected" before the
 *      user commits to a flow that needs it.
 *   2. Relays one message shape between the panel and the service worker.
 *
 * It never reads a cookie itself (a content script cannot) and never posts
 * anything anywhere — the panel does its own talking to its own API, with
 * its own token. Keeping the network calls on the page side means this file
 * has no credentials in it at all.
 */

document.documentElement.setAttribute("data-basketed-extension", "1");

/**
 * The two things the panel may ask for.
 *
 * `arm` starts the header watch and returns nothing about the browser's
 * state; the connect page sends it on load, so the listener is already
 * running before the user opens the retailer's tab. `capture` is the one that
 * reads a session back. Keeping them separate means arming early costs the
 * user no cookie read at all.
 */
const RELAYED = { arm: "basketed-arm", capture: "basketed-capture" };

window.addEventListener("message", (event) => {
  // Only this page, and only our own shape.
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "basketed-panel") return;
  const type = RELAYED[msg.type];
  if (!type) return;

  chrome.runtime.sendMessage(
    {
      type: type,
      // location.origin, not anything the page handed us: the service worker
      // verifies the token against THIS origin, so the page cannot point it
      // at some other server.
      origin: window.location.origin,
      token: msg.token,
      domains: msg.domains,
      authCookies: msg.authCookies,
      capture: msg.capture,
    },
    (reply) => {
      window.postMessage(
        {
          source: "basketed-extension",
          type: "captured",
          id: msg.id,
          reply: chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : reply,
        },
        window.location.origin,
      );
    },
  );
});
