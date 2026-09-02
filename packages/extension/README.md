# Basketed Connect (browser extension)

Finishes a store connection **in the browser you already use**, with the
accounts you are already signed into.

## Install (one minute, once)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder (`packages/extension`)

`basketed extension` prints those three lines with the absolute path already
filled in, and says whether a browser has reported the extension yet.
`basketed doctor` reports the same thing among its other checks.

That is the whole install. The Connect page says **extension loaded** before
you press anything, rather than discovering the problem after a connect that
went nowhere.

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
- Watches for the `authorization` and `customer-uuid` headers on requests to a
  store's own API, for the one retailer whose credential is that header pair
  rather than a cookie (Tesco). `webRequest.onSendHeaders` is observational —
  it cannot block, redirect or alter a request, and this one does not try.
- Starts that watch when the Connect **page loads**, not when you press the
  button. A shopper who is already signed in would otherwise lose the race:
  the retailer's tab makes its one authenticated call on load, and a watch
  armed a moment later hears nothing at all.
- Hands what it found to the Basketed panel on `127.0.0.1`, which seals it
  with AES-256-GCM under a key on your machine.

## What it will not do

- **It talks to `127.0.0.1` and nothing else.** There is no remote endpoint in
  this code. Read `background.js` — it is under 250 lines, most of them
  comments.
- **It writes nothing to disk.** State — which headers to watch for, and the
  last values seen — lives in `chrome.storage.session`, which is memory-backed
  and wiped when the browser exits. It has to live somewhere: an MV3 service
  worker is killed after about thirty seconds idle, and holding this in plain
  variables meant every one of those deaths silently threw the capture away.
  Nothing goes to `chrome.storage.local`, and no cookie is ever kept.
- **It reads no cookie until asked.** Arming the header watch on page load
  costs no cookie read at all; that is a separate message with a separate
  answer.
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
