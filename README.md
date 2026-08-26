# Basketed

**One basket. Many shops. Nothing bought without you.**

A Universal Shopping MCP server plus a self-hosted control panel. Any MCP agent
gets real product search across many retailers, token-efficient comparison, and
a purchase step **only a human can authorise**.

`ANALYSE → EXTRACT → RESPOND → PURCHASE → RECEIVE`

```bash
pnpm i && pnpm build
node packages/cli/bin.js install --client claude-code   # or --all
node packages/cli/bin.js serve --http --open            # panel + MCP on one port
```

---

## What is actually here

| | |
|---|---|
| **Cross-retailer basket behind a mandatory human approval gate** | Nobody has shipped this. Official merchant servers are one-retailer and stop at a checkout URL; community shopping servers automate purchases with no approval at all. The middle was empty. |
| **The vault is on your machine** | There is no Basketed server to breach. After the May 2026 Composio breach — ~5,241 API keys and ~5,001 OAuth tokens taken from a store holding ~1.7M live credentials — that is a product claim, not a checkbox. |
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

**Three approval channels, all converging on one function** so the security
properties are identical wherever the human clicked:

| | How | Works on |
|---|---|---|
| **A — panel** | `/approvals`, opened from the token link on the server's console; itemised, **type the exact total** | always |
| **B — elicitation** | the client renders the dialog; the human answers | Claude Code, Cursor |
| **C — console code** | a 6-digit code printed on the server's own stderr | **100% of clients** |

Channel C is safe because the model has no read access to that surface. The only
way an agent obtains the code is for a person to read it out — which is exactly
the human act we want to require.

Channel A rests on the same fact, not on the route split. Every client Basketed
installs into has a shell, so "the agent speaks MCP and cannot reach `/api`" was
never true on its own — a local process can call any port on 127.0.0.1 and forge
any header. The panel is therefore behind a token minted per process and printed
on that same console; `serve --http --open` opens the link for you. `/api` also
refuses any request whose `Origin` is not exactly the panel's, and refuses a
mutating request that sends none, which is what keeps a web page from driving the
panel through your browser.

**What does not exist, on purpose:** an `approve()` tool, an `approved: true`
parameter, an override flag, or a `set_delivery_address` tool. Run `tools/list`
and check. The absence is the feature.

### The adversarial pass

```bash
pnpm smoke        # four smoke suites, all offline
pnpm test         # 77 unit tests
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
| `native` | the retailer's own official endpoint — Shopify UCP |
| `provider` | real retailer data via a licensed commercial provider *(designed, not built)* |
| `connected` | the user's own account via real retailer OAuth *(designed, not built)* |
| `simulated` | fixture-backed and stamped **SIMULATED** |

| Tier | Who has it |
|---|---|
| `discovery` `detail` | every adapter |
| `cart` | Shopify UCP, simulated |
| `handoff` | Shopify UCP |
| `checkout` | **nobody.** Shopify gates payment completion behind a hand-granted merchant token with no public application. Interface defined, not implemented. |

**No scraper, and no anti-bot circumvention.** Cloudflare challenges, WAF
fingerprinting and CAPTCHAs are access controls the operator deliberately
enabled. Defeating them destroys the "the user is the actor" defence that makes
agentic shopping defensible at all, and it breaks constantly. Retailers behind
one are `provider` or `simulated`. This is not a capability we ship disabled —
it is one we do not build.

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
| Cursor | `mcpServers` | supports elicitation → channel B lights up |
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

- Tokens live only in the backend vault, AES-256-GCM, AAD-bound to their account
  handle. They are never returned by a tool, never logged, never in an error.
- The agent sees only an **opaque account handle**. The vault returns a
  *configured client*, never a credential.
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
- We never touch card data (out of PCI scope), never store retailer passwords,
  and ship no scraper.

---

## Not built, stated so nobody claims it

Provider adapters, real retailer OAuth, the mock IdP, `compare_products`,
Stores/Settings/Orders pages, MCPB, registry publish, and ChatGPT plugin
submission. All are designed in the plan and none are built. The pitch is *here
is the architecture, and the two adapters plus the gate that prove it*.

`docs/` — [BENCHMARK](docs/BENCHMARK.md)

Requires **Node ≥ 22** (`node:sqlite`, so there is no native build step — which
matters on Windows, where this was developed and verified).
