# Basketed

**One basket. Many shops. Nothing bought without you.**

A Universal Shopping MCP server plus a self-hosted control panel. Any MCP agent
gets real product search across many retailers, token-efficient comparison, and
a purchase step **only a human can authorise**.

`ANALYSE → EXTRACT → RESPOND → PURCHASE → RECEIVE`

```bash
pnpm i && pnpm build
node packages/cli/bin.js install --client claude-code   # or --all
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
channel. The tab is the channel there. One tab per process; `--no-open` (or
`BASKETED_NO_OPEN=1`) turns it off, and the tab polls, so a cart that needs you
later shows up in the tab that is already open. `/api` also
refuses any request whose `Origin` is not exactly the panel's, and refuses a
mutating request that sends none, which is what keeps a web page from driving the
panel through your browser.

**What does not exist, on purpose:** an `approve()` tool, an `approved: true`
parameter, an override flag, or a `set_delivery_address` tool. Run `tools/list`
and check. The absence is the feature.

### The adversarial pass

```bash
pnpm smoke        # five smoke suites, all offline
pnpm test         # 203 unit tests
pnpm drill        # the whole demo path with the network genuinely severed
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
| `native` | the retailer's own live page or endpoint reaching a real signed-out shopper — Shopify UCP; (S16) real Tesco: `search.api.tesco.com` / `xapi.tesco.com`, the same requests tesco.com's own frontend makes, ported and verified live, not scraped; and (S17) real Amazon/IKEA/Target + (S21) real Etsy/eBay/Best Buy: no JSON API exists for any of the six, so a stealth browser renders their own public search/detail pages and the adapter parses what a signed-out visitor would see — still `native` because the label describes *whose* data it is, not *how* it was fetched |
| `provider` | real retailer data via a licensed commercial provider *(designed, not built)* |
| `connected` | the user's own account via real retailer OAuth *(designed, not built)* |
| `simulated` | fixture-backed and stamped **SIMULATED** |

| Tier | Who has it |
|---|---|
| `discovery` `detail` | every adapter, plus real Tesco, and (S17) real Amazon, IKEA, Target and (S21) real Etsy, eBay, Best Buy |
| `cart` | Shopify UCP, simulated, and real Tesco (via a bearer token pasted from the shopper's own tesco.com session — see [Connect stores](#security)) |
| `handoff` | Shopify UCP, real Tesco (`tesco.com/groceries/.../trolley`, real basket) |
| `checkout` | **nobody.** Shopify gates payment completion behind a hand-granted merchant token with no public application; Tesco's basket API is unofficial and this project does not touch card data regardless. Interface defined, not implemented. |

**Real Tesco is not a licensed integration.** `search.api.tesco.com` and
`xapi.tesco.com` are public endpoints Tesco's own website calls, with an API
key that is public and embedded in their frontend JS — but Tesco does not
document or support third-party use of either, and using them this way sits
outside Tesco's Terms of Service, same as any unofficial API client. `sim:tesco`
is untouched by this and stays exactly what it always was: fixture data, still
what the offline drill runs against, still real-network-free.

**Amazon, IKEA, Target (S17) and Etsy, eBay, Best Buy (S21) do circumvent anti-bot detection.** Shopify UCP
and Tesco are plain, unmodified HTTP calls — no anti-bot layer to get past. For
these six there is no JSON API and no HTTP-only path in either: `patchright`
(a stealth-patched Chromium) renders the retailer's own public search/detail
pages the way a real signed-out browser would, specifically to defeat
fingerprinting that would otherwise reject a plain client outright. That is a
real, deliberate anti-bot bypass, done because the alternative was building
nothing at all for three of the internet's most-shopped stores — scoped hard
to unauthenticated public pages: no login, no session automation, no cart, so
"the user is the actor" still holds for anything these adapters touch. Cart-tier
automation would require a signed-in session and is out of scope for exactly
that reason. Etsy, eBay and Best Buy use the same engine and same scope.

Costco and Walmart were tried and refused: both sit behind Akamai/PerimeterX
configurations the same stealth browser could not get past cleanly enough to
trust, so both stayed `simulated`. Shopee was tried, briefly misread as
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

Read-only:

| | |
|---|---|
| `basket_list_stores` | each row carries `mode` and `status` |
| `basket_search_products` | `response_format` · `fields` · `budget_tokens` · `max_results` |
| `basket_get_product_detail` | heavy fields only via `include` |
| `basket_get_token_report` | tokens served vs baseline, cumulative |

Money-adjacent — `destructiveHint: true`, never promotable to ALLOW:

| | |
|---|---|
| `basket_cart_prepare` | builds a real cart, mints a Cart Mandate, returns `approval_id`. **`charged: false`.** |
| `basket_purchase_confirm` | succeeds only against a human-approved, unexpired, unconsumed, hash-matching mandate |
| `basket_list_orders` · `basket_get_order_status` | reads; `cart_json` and `approval_id` are stripped |

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
basketed install --client claude-code
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

**Kiro's `autoApprove` is a trap.** Our generated config lists only the four
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
  anonymous and the simulated stores have nothing to check it against — so
  connecting Costco, Walmart, Shopee, Taobao or `sim:amazon` holds a credential
  for an adapter that does not exist yet and changes no result you see today.
  Real Tesco (`tsc:tesco`) is the exception: what it seals is the bearer its
  basket adapter actually calls with. (`sim:amazon` is the sign-in target — not
  the real `amz:amazon` discovery/detail adapter below, which needs no
  credential at all.)
- **Connect signs you in at the store, in a browser — there is no password box
  (S19), and it is the browser you already have open (S20). Covers Amazon,
  Costco, IKEA, Shopee, Taobao, Tesco and Walmart.**
  None of them publish a consumer OAuth flow, so the alternative to a
  password-paste box is not a nicer password-paste box: it is opening the
  retailer's own login page in the browser you already use and letting you sign
  in there. Basketed has **no field anywhere that accepts a retailer password**,
  and the route refuses one even if a policy offered it — a test asserts both.

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
  actually use: the cookie jar, or — for real Tesco, whose basket API is a
  bearer API — the `Authorization` token its own frontend sends to
  `xapi.tesco.com`, read out of the signed-in tab instead of asked for by hand.
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
  passwords in the clear. We do ship a scraper (S17, Amazon/IKEA/Target
  discovery and detail) — see "Where the data comes from" for exactly what it
  does and does not touch: no login, no session, no cart.

---

## Not built, stated so nobody claims it

Real retailer *cart* adapters for Costco/Walmart/Amazon (none publish a
consumer API; the vault holds a credential — pasted or Chrome-captured —
nothing yet authenticates with it), real retailer OAuth (none of the four
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
no basket — and Etsy, eBay and Best Buy discovery/detail moved off this list
in the same way (S21). Costco, Walmart and Shopee stay here in full: none has an
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
