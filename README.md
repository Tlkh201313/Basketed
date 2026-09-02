# Basketed

**One basket. Many shops. Nothing bought without you.**

A Universal Shopping MCP server plus a self-hosted control panel. Any MCP agent
gets real product search across many retailers, token-efficient comparison, and
a purchase step **only a human can authorise**.

`ANALYSE → EXTRACT → RESPOND → PURCHASE → RECEIVE`

```bash
pnpm i && pnpm build
node packages/cli/bin.js install claude-code            # or --all
```

That is the whole setup. Your client launches Basketed itself over stdio, and
the control panel comes up in the same process — its link, and a link to any
cart waiting on you, are printed on the server's console. `serve --http --open`
is the other way in: same panel, plus a Streamable HTTP endpoint on `/mcp`.

---

## What is actually here

| | |
|---|---|
| **Cross-retailer basket behind a mandatory human approval gate** | Nobody has shipped this. Official merchant servers are one-retailer and stop at a checkout URL; community shopping servers automate purchases with no approval at all. The middle was empty. |
| **Everything runs on your machine** | There is no Basketed server to breach. After the May 2026 Composio breach — ~5,241 API keys and ~5,001 OAuth tokens taken from a store holding ~1.7M live credentials — a hosted shopping agent is a target by construction. The [credential vault](#security) is sealed with AES-256-GCM under a key that never leaves this machine, and **the model cannot read it** — there is no tool and no route that returns a secret. Neither shipped adapter authenticates as anybody yet, so today the vault is empty unless you put something in it from the Connect stores page. |
| **A published token benchmark for e-commerce MCP** | **91.9%** fewer tokens than a naive MCP server, **99.3%** fewer than browsing the storefronts, on one real shopping task — and the figure *includes* our own 3,144-token tool-definition overhead. Method in [`docs/BENCHMARK.md`](docs/BENCHMARK.md). |

---

## The purchase gate

An agent can *propose* a purchase. Only a human can authorise one, and the
authorisation always arrives from a surface the model cannot author.

```
cart_prepare ──► PENDING ──(human)──► APPROVED ──(purchase_confirm)──► order
                    │                                                    │
                    └──► EXPIRED (5 min) / REJECTED                       └─► HANDED_OFF
                                                                              outcome: unknown
```

**Two approval channels, both converging on one function** so the security
properties are identical wherever the human clicked:

| | How | Works on |
|---|---|---|
| **A — panel** | `/approvals`, opened from the token link on the server's console; itemised, **type the exact total** | always — the panel runs on stdio too |
| **C — console code** | a 6-digit code printed on the server's own stderr | **100% of clients** |

Channel **B — elicitation**, where the client renders the dialog itself, is
designed and **not built**. `ApprovalChannel` is `"console" | "panel"`, and
that is the whole list. The letter is kept so the plan and the code use the
same names for the same things.

Channel C is safe because the model has no read access to that surface. The only
way an agent obtains the code is for a person to read it out — which is exactly
the human act we want to require.

Channel A rests on the same fact, not on the route split. Every client Basketed
installs into has a shell, so "the agent speaks MCP and cannot reach `/api`" was
never true on its own — a local process can call any port on 127.0.0.1 and forge
any header. The panel is therefore behind a token minted per process and printed
on that same console — on both transports, so a client that launched Basketed
over stdio still has channel A.

On stdio the panel also **opens in your browser when the server starts**. That
is not a convenience: a client captures its MCP server's stderr, so the link is
written where no human will ever read it, and a panel nobody can reach is not a
channel. The tab is the channel there. **One tab per machine, not one per
server**: Basketed installs into Claude Code, Cursor and Codex, and each of them
starts its own stdio server, so opening three editors used to open three
browser windows on three ports. It does not any more. Every server reads the
same database as the same user, so the approval queue in one panel is already
the queue for all of them: a second server finds the live panel's handoff
record, prints that origin, opens nothing, and points its approval links there.
It still serves a panel of its own, and falls back to it the moment the first
editor closes. `--no-open` (or `BASKETED_NO_OPEN=1`) turns the tab off
entirely, and the tab polls, so a cart that needs you later shows up in the tab
that is already open. `/api` also
refuses any request whose `Origin` is not exactly the panel's, and refuses a
mutating request that sends none, which is what keeps a web page from driving the
panel through your browser.

**What does not exist, on purpose:** an `approve()` tool, an `approved: true`
parameter, an override flag, or a `set_delivery_address` tool. Run `tools/list`
and check. The absence is the feature.

### The adversarial pass

```bash
pnpm smoke        # six smoke suites, all offline
pnpm test         # 486 unit tests
pnpm drill        # the whole demo path with the network genuinely severed
pnpm stability    # 25 cold starts, measured: last run 25/25 (100%)
pnpm smoke:live   # ...and against live merchants, spending real requests
```

1. `purchase_confirm` before approving → refused
2. approve, confirm, then replay the same `approval_id` → refused, consumed
3. change a price in the DB after approval → refused, hash drift
4. restart with `--fast-mode` and repeat 1–3 → **all still refused**
5. ask the agent to approve its own purchase → there is no tool that can

### `--fast-mode` cannot touch purchase, and it is proved twice

Behaviourally, and by **walking the real import graph**: nothing reachable from
`commerce/purchase.ts` imports `mcp/policy.ts`, where the flag lives. The flag
is not ignored on the purchase path — it is not reachable from it, and a
refactor that wires them together fails CI.

### The offline drill actually cuts the network

`pnpm drill` preloads a guard that refuses every non-loopback connection in the
server process, then walks the whole demo path. Setting a snapshot flag on a
machine that still has wifi proves only that the flag parses. Under a real cut,
seven of the ten pinned Shopify stores go dark — and come back **named** in
`stores_failed`, because a search that silently returns fewer stores looks
exactly like success.

---

## Where the data comes from

Every adapter declares two independent things, and neither may be overstated.
**Every response carries its mode**, and the panel shows it as a badge.

| Mode | Meaning |
|---|---|
| `native` | the retailer's own live page or endpoint reaching a real signed-out shopper — Shopify UCP; (S16) real Tesco: `search.api.tesco.com` / `xapi.tesco.com`, the same requests tesco.com's own frontend makes, ported and verified live, not scraped; and (S17) real Amazon/IKEA/Target + (S21) real Etsy/eBay/Best Buy: no JSON API exists for any of the six, so the adapter fetches their own public search/detail pages with a real browser's headers and parses what a signed-out visitor would see (Etsy retries through a stealth browser on a 403) — still `native` because the label describes *whose* data it is, not *how* it was fetched |
| `provider` | real retailer data via a licensed commercial provider *(designed, not built)* |
| `connected` | the user's own account via real retailer OAuth *(designed, not built)* |
| `simulated` | fixture-backed and stamped **SIMULATED** |

| Tier | Who has it |
|---|---|
| `discovery` `detail` | every adapter, plus real Tesco, and (S17) real Amazon, IKEA, Target and (S21) real Etsy, eBay, Best Buy |
| `cart` | Shopify UCP, simulated, real Tesco (sealed session, see [Connect stores](#security)), and (S22) real eBay/Best Buy (local cart, no retailer API — see below) |
| `handoff` | Shopify UCP, real Tesco (`tesco.com/groceries/.../trolley`), eBay (`cart.ebay.com`), Best Buy (`bestbuy.com/cart`) — local handoff, human completes checkout (`HANDED_OFF/unknown`) |
| `checkout` | **nobody.** Shopify gates payment completion behind a hand-granted merchant token with no public application; Tesco's basket API is unofficial and this project does not touch card data regardless. Interface defined, not implemented. |

**Real Tesco is not a licensed integration.** `search.api.tesco.com` and
`xapi.tesco.com` are public endpoints Tesco's own website calls, with an API
key that is public and embedded in their frontend JS — but Tesco does not
document or support third-party use of either, and using them this way sits
outside Tesco's Terms of Service, same as any unofficial API client. There is
one Tesco in the live product (`tsc:tesco`). Demo catalogues (`sim:*`) load
only with `--simulated`.

**Amazon, IKEA, Target (S17) and Etsy, eBay, Best Buy (S21) do circumvent anti-bot detection.**
Shopify UCP and Tesco are plain, unmodified HTTP calls — no anti-bot layer to
get past. For these six there is no JSON API at all, so the adapter fetches the
retailer's own public search and detail pages and parses what a signed-out
visitor would see. Those requests carry a real browser's User-Agent,
`Accept-Language` and `Referer` rather than a library's defaults, which is a
deliberate step past a check that exists to keep non-browsers out. We are not
going to describe that as anything other than what it is.

Etsy is the one that still reaches for a browser. When its search or listing
page answers 403, the adapter retries once through `patchright`, a
stealth-patched Chromium that renders the page the way a real signed-out
browser would — see `adapters/src/stealth/browser.ts`. That lane is bounded to
two concurrent browsers, each on a deadline, and `BASKETED_NO_BROWSER=1` turns
it off entirely.

The scope is hard: unauthenticated public pages only. No login, no session
automation, no retailer cart API, so "the user is the actor" still holds for
anything these adapters touch. Cart-tier automation would need a signed-in
session and is out of scope for exactly that reason. eBay and Best Buy expose a
**local billing handoff** (S22) — `cart` built locally from cached search
prices, `handoff` to `cart.ebay.com` / `bestbuy.com/cart` where the human pays.
No retailer cart API is called and no payment is completed by Basketed
(`HANDED_OFF/unknown`).

When one of these pages comes back as an interstitial, or as markup this
adapter no longer recognises, the store is reported in `stores_failed` with the
reason. It is never reported as zero results: "the store does not stock it" and
"the store would not show us" are different answers, and only one of them is
ours to give.

Costco and Walmart were tried and refused: both sit behind Akamai/PerimeterX
configurations neither the plain-HTTP path nor the stealth browser could get
past cleanly enough to trust, so both stayed `simulated`. Shopee was tried, briefly misread as
bypassed (a webpack bundle name that looked like real product markup), then
re-verified and found genuinely blocked — its `search_items` API returns a
risk-control error regardless of stealth config — so it also stayed `simulated`.
Retailers behind a challenge we did not get past are `provider` or `simulated`;
this is not a line we pretend not to have crossed for the six we did.

**`HANDED_OFF` never claims success.** When the route ends in a URL a human
completes themselves, we genuinely do not know the outcome, and the order says
exactly that until a person marks it in the panel. Quietly showing a green tick
for an order nobody paid for would be the most damaging bug this could ship.

---

## Tools

Two lanes on one server.

**Fetch lane** — no account needed:

| | |
|---|---|
| `basket_list_stores` | each row carries `mode` and `status` |
| `basket_search_products` | `response_format` · `fields` · `budget_tokens` · `max_results` |
| `basket_get_product_detail` | heavy fields only via `include` |
| `basket_get_token_report` | tokens served vs baseline, cumulative |
| `basket_auth_status` | which stores are signed in, which need Connect |

**Purchase lane** — Connect and/or a human; spend caps live in the panel Settings page:

| | |
|---|---|
| `basket_list_delivery_slots` | Tesco delivery windows (needs a connected session) |
| `basket_list_accounts` | opaque handles for `cart_prepare` (never credentials) |
| `basket_cart_prepare` | builds a real cart, mints a Cart Mandate, returns `approval_id`. **`charged: false`.** |
| `basket_purchase_confirm` | succeeds only against a human-approved, unexpired, unconsumed, hash-matching mandate |
| `basket_list_orders` · `basket_get_order_status` | reads; `cart_json` and `approval_id` are stripped |

Connect opens the retailer's own site in a new tab, then a **Heartbeat** watches until you are signed in (or were already) and seals the session. Basketed never asks for a store password. Caps (per-order, rolling 24h, store allowlist) are edited under **Settings** — human approval cannot be turned off.

The Connect-stores page has four tabs: **All**, **Connected**, **Unconnected**
and **Fetch**. Fetch is where the Shopify merchants live and it is not a lesser
shelf — their agentic endpoint is anonymous, there is no account to connect, and
searching them signed out is the product rather than a limitation. Unconnected
means there genuinely is a sign-in still to do.

Seven retailers offer one, and only Tesco requires it. Amazon, Best Buy, eBay,
Etsy, IKEA and Target answer perfectly well signed out and always will;
connecting one attaches your session to their search and product pages, which
is the difference between a generic listing and your prices, your store's stock
and your delivery estimate — plus a request that is turned away as a robot far
less often. Nothing is refused for want of a session on those six, and an
expired one degrades to the signed-out answer rather than failing. Tesco is the
exception: its search is public, its trolley and delivery slots are not.

Which shelf a store lands on, and whether its session gates anything, comes
from the adapter's own `account` declaration — `uses` for what genuinely needs
a sign-in, `improves` for what merely answers better with one. A store cannot
be advertised as connectable by the panel while its adapter never reads a
session, and registration refuses a session that reads nothing at all. Connect drives Chrome, Edge,
Brave or Chromium, whichever is installed (`BASKETED_CHROME` names another),
and `basketed doctor` prints which one it would open.

### Token levers

`response_format`: `concise` (default) · `detailed` · `compact` (short keys plus
a one-line legend). `fields` for an explicit allowlist. `budget_tokens` for a
hard ceiling — trimmed `url` → `image` → `attrs` → truncate name → drop rows,
with `_meta.truncated` naming what went. **`id`, `price` and `mode` are never
dropped:** a result must not lose its provenance to save tokens.

---

## Install

`basketed install` is driven by one variance table, the same one the panel
renders from — so the installer, the copy blocks and the badges cannot disagree
about where a config file lives. That matters because almost every exception
below fails *silently*: a wrong key name does not error, your server just never
appears.

```bash
basketed clients                       # every client, its file, its key
basketed install claude-code           # or codex, cursor, opencode, zed, grok...
basketed install codex opencode        # several at once
basketed install --all --dry-run       # show the diff, write nothing
basketed doctor                        # check the install end to end
```

| Client | Key | The thing that will silently break it |
|---|---|---|
| Claude Code | `mcpServers` | a `url` with no `type` is a **hard error** |
| Cursor | `mcpServers` | supports elicitation, where channel B *would* live — it is not built |
| Codex CLI | `[mcp_servers.x]` | the only **TOML** target, with an underscore |
| Claude Desktop | `mcpServers` | remote only via Settings → Connectors |
| VS Code | **`servers`** | *not* `mcpServers` |
| opencode | **`mcp`** | `command` is an **array**; env key is `environment` |
| Kiro | `mcpServers` | has `autoApprove` — we list **only** read-only tools there |
| Zed | **`context_servers`** | — |
| Windsurf | `mcpServers` | `serverUrl`; hard cap of 100 tools across all servers |
| Gemini CLI | `mcpServers` | `httpUrl` for Streamable HTTP, `url` means SSE |
| Goose | **`extensions`** | `uri` not `url`; `streamable_http` with an underscore |
| Warp | `mcpServers` | also reads `~/.claude.json` and `~/.codex/config.toml` — **free** |

**Writes are merge-then-replace, never overwrite.** The existing file is backed
up to `<file>.basketed-backup-<timestamp>`, unrelated keys and other servers are
preserved, the write is atomic, and the diff is printed. A config we cannot
parse is refused and left byte-identical rather than replaced.

**Kiro's `autoApprove` is a trap.** Our generated config lists only the
read-only tools there, and `basketed doctor` warns if a money-adjacent tool has
been added by hand.

---

## Protocol

Dual-era, both transports. MCP **`2026-07-28`** removed `initialize`, sessions
and server-initiated requests; a modern client cannot talk to a legacy server
and vice versa. "Installs into any agent" rests entirely on serving both from
one binary, so `scripts/smoke-mcp.mjs` opens the same binary twice — once with
`initialize`, once stateless — because neither failure is visible from the
server's own logs.

Also: `server/discover`, `outputSchema` on every tool, structured output
mirrored as text for older clients, deterministic tool order, all four
annotations, namespaced names.

---

## Security

- **The credential vault is built.** `packages/vault` seals each stored secret
  with AES-256-GCM under a 32-byte key at `~/.basketed/master.key` (mode 0600).
  There is exactly one function that returns plaintext — `reveal()` — and it is
  called from nowhere except the request interceptor that attaches a header to
  an outbound fetch; a test walks the workspace for other call sites and fails
  if one appears. The panel — behind the same per-process token as everything
  else in this list — writes to it and reads back metadata only. **No MCP tool
  receives a credential, ever**: `AdapterCtx` has no field one could travel in.
  A bad or missing key file degrades the Connect-stores page; it never takes
  the MCP server down, so a client cannot fail to start because of this file.
  Neither shipped adapter authenticates with what is stored — Shopify UCP is
  anonymous — so connecting is only offered where an adapter will actually
  send the session. Real Tesco (`tsc:tesco`) is that store: what it seals is
  the header pair its basket adapter calls with (`authorization` and
  `customer-uuid`, plus `x-customer-uuid` so Tesco's gateway accepts either
  name).
- **Connect signs you in in the browser you already use — there is no password
  box. Covers Amazon, Best Buy, eBay, Etsy, IKEA, Target and Tesco.**
  Not one of those retailers publishes a consumer OAuth flow, so the
  alternative to a password-paste box is not a nicer password-paste box: it is
  opening the retailer's own login page in the browser you already use and
  letting you sign in there. Basketed has
  **no field anywhere that accepts a retailer password**, and the route refuses
  one even if a policy offered it — a test asserts both.

  Six of the seven are optional, and stay optional. Amazon, Best Buy, eBay,
  Etsy, IKEA and Target search and price perfectly well signed out and always
  will; connecting one buys the prices, stock and delivery estimates your own
  account sees, and a request that is turned away as a robot far less often.
  Nothing is refused for want of a session on those six — an expired one
  degrades to the signed-out answer rather than failing the search. Tesco is
  the single store where connecting unlocks something: its search is public,
  its trolley and its delivery slots are not.

  Connect is a plain `<a target="_blank">`, so the tab opens in **the same
  browser window the panel is running in**, with the accounts already in it.
  Nothing is launched and nothing about the login is automated. If you are
  already signed in, the connection finishes on its own; if you are not, you
  land on the retailer's sign-in page and it finishes the moment you are
  through.

  Reading the session back out of that tab is the half an outside program
  cannot do, and should not be able to: since Chrome 136,
  `--remote-debugging-port` is ignored against the default profile
  ([Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port))
  exactly so that no process can lift another profile's cookies. Basketed does
  not route around that — no profile copying, no decrypting Chrome's cookie
  store, no injection. It goes in the sanctioned way instead: a small extension
  (`packages/extension`, load-unpacked, ~120 lines) that reads the session from
  the inside, talks to `127.0.0.1` and nothing else, stores nothing, and
  refuses any local page that cannot prove it holds the panel token. Without
  the extension the tab still opens — the panel then offers a Basketed-driven
  window on its own persistent profile, which does auto-capture, rather than
  spinning forever.

  Every one of these retailers' Terms of Service prohibits automated access,
  including by the account owner; that risk is disclosed on the Connect page
  itself, not just here. What is sealed is what the store's adapter can
  actually use: the cookie jar, or — for real Tesco, whose basket API
  authenticates on `authorization` **and** `customer-uuid` together — both of
  those headers as its own frontend sends them to `xapi.tesco.com`, read out
  of the signed-in tab instead of asked for by hand. A capture that is missing
  one of them is refused rather than sealed: half a session looks connected
  and fails at the first add-to-basket.
- The agent sees only an **opaque account handle**, never anything that could
  become one.
- **The approval surface is behind a per-process token** printed on the server's
  own console, beside the 6-digit code. Route separation is not the gate: every
  client Basketed installs into has a shell, so the agent could always reach
  `127.0.0.1` and forge any header. `/api` also requires an `Origin` exactly
  equal to the panel's, and refuses a mutating request that sends none.
- **Vendor text is untrusted data.** NFKC-normalised, stripped of control chars,
  zero-width and bidi overrides, HTML-stripped, length-capped, injection
  patterns flagged. The real defence is stronger: the **approval screen and the
  cart hash are built only from numeric and enumerated fields plus the
  normalized product name.** No merchant-authored string reaches either.
- `approval_id` is CSPRNG, bound server-side to a principal derived from the
  local session — never from anything the agent supplied — and re-checked inside
  the atomic consume. Possession is never authentication (`2026-07-28` State
  Handle Hijacking).
- Redaction layer over every response, as a net rather than the defence. A hit
  is a bug; the panel shows the count.
- We never touch card data (out of PCI scope) and never store retailer
  passwords in the clear. We do ship a scraper (S17/S21, Amazon/IKEA/Target
  + Etsy/eBay/Best Buy discovery and detail) — see "Where the data comes
  from" for exactly what it does and does not touch: no login, no session.
  eBay/Best Buy add a local cart+handoff (S22) — no retailer cart API is
  called, human completes checkout.

---

## Not built, stated so nobody claims it

Real retailer *cart* adapters for Costco/Walmart/Amazon/Etsy (none publish a
consumer API; the vault holds a credential — pasted or Chrome-captured —
nothing yet authenticates with it for those), real retailer OAuth (none of the four
publish one — see [Connect stores](#security)), a Chrome-login capture for
any store outside that prototype four, real Shopee/Costco/Walmart discovery
(all three were tried this session — see "Where the data comes from" — and
stayed `simulated`), the mock IdP, approval channel B (elicitation),
`compare_products`, the Orders page, MCPB, registry publish, and ChatGPT
plugin submission. All are designed in the plan and none are built.

Tesco is the one retailer adapter that moved off this list (S16) — see
"Where the data comes from", above: real search, real detail, and a real
basket behind the shopper's own pasted session token. Amazon, IKEA and Target
discovery/detail moved off this list too (S17) — real search and product data,
no basket — Etsy, eBay and Best Buy discovery/detail moved off this list
in the same way (S21), and eBay and Best Buy **local cart+handoff** moved off
this list too (S22) — local cart from cached prices, handoff to the retailer's
own cart page, human completes checkout, `HANDED_OFF/unknown` (no retailer cart
API called). Costco, Walmart and Shopee stay here in full: none has an
equivalent real endpoint or a stealth-browser path this project could get
past cleanly, and `sim:amazon`'s cart stays here alongside them — see [Connect
stores](#security) for what a Chrome-login session on those three can and
cannot do instead.

The credential vault is the other item that moved off this list (S14) — see
Security, above — and the drift guard that used to check it here now checks
the opposite: that this file stops disclaiming it exactly when it stops being
true.

`docs/` — [BENCHMARK](docs/BENCHMARK.md)

Requires **Node ≥ 22** (`node:sqlite`, so there is no native build step — which
matters on Windows, where this was developed and verified).
