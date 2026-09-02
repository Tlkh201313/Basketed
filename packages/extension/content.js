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

window.addEventListener("message", (event) => {
  // Only this page, and only our own shape.
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "basketed-panel" || msg.type !== "capture") return;

  chrome.runtime.sendMessage(
    {
      type: "basketed-capture",
      // Only the token and which store is being connected. The origin is not
      // ours to state -- Chrome tells the worker where this message came from,
      // and the worker compares that against the panel origin the user pinned.
      // The domains are not ours to state either: the worker asks the pinned
      // panel what is waiting on a sign-in and reads only that.
      token: msg.token,
      storeId: msg.storeId,
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
