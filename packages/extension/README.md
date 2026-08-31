# Basketed Connect (browser extension)

Finishes a store connection **in the browser you already use**, with the
accounts you are already signed into.

## Install (one minute, once)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder (`packages/extension`)

That is the whole install. The Connect page will say `extension detected`
instead of offering the fallback window.

Works in any Chromium browser with `chrome://extensions`: Chrome, Edge, Brave,
Arc, Opera.

## Why an extension is needed at all

Basketed's panel is already a page in your browser, so **opening** the store in
a new tab needs nothing — the Connect button is a plain link.

**Reading the session back** out of that tab is the part an outside program
cannot do. Since Chrome 136, `--remote-debugging-port` is ignored when it
points at your default profile ([Chrome for Developers, "Changes to remote
debugging switches to improve security"](https://developer.chrome.com/blog/remote-debugging-port)),
precisely so that no process on your machine can read another profile's
cookies. That is a good rule and Basketed does not try to route around it: no
profile copying, no decrypting Chrome's cookie database, no injection.

The sanctioned way in is from the inside, with a permission you granted at
install. That is this extension.

## What it does, exactly

- Reads cookies for **one store's domains at a time**, only when the Basketed
  panel asks, and only for the domains listed in `manifest.json`.
- Watches for the `Authorization` header on requests to a store's own API, for
  the one retailer whose credential is a bearer token rather than a cookie
  (Tesco). `webRequest.onSendHeaders` is observational — it cannot block,
  redirect or alter a request, and this one does not try.
- Hands what it found to the Basketed panel on `127.0.0.1`, which seals it
  with AES-256-GCM under a key on your machine.

## What it will not do

- **It talks to `127.0.0.1` and nothing else.** There is no remote endpoint in
  this code. Read `background.js` — it is 120 lines.
- **It stores nothing.** No `chrome.storage`, no cache. Every value it reads
  goes to the panel that asked and is gone when the handler returns.
- **It will not answer a page that cannot prove it is the panel.** The content
  script runs on every `127.0.0.1` page, and localhost is shared ground — any
  local page could otherwise ask for your retailer cookies. Before reading a
  single cookie, the service worker checks the caller's panel token against
  the panel itself (`GET /api/extension/verify`), at the origin the *content
  script* reports, never one the page supplied.
- **It never sees a password.** You sign in on the retailer's own page, and
  the extension only ever looks at what that produced.

## Removing it

`chrome://extensions` → Remove. Nothing is left behind; anything already
connected stays in Basketed's vault until you disconnect it in the panel.
