# Demo runbook

Five minutes. The last two are the strongest and they are the adversarial pass —
so do not let the first three overrun.

---

## 30 minutes before

```bash
pnpm build
pnpm preflight          # profile URL, 10 pinned stores, port 8787
pnpm test               # 460 unit tests (vitest run)
pnpm smoke              # 5 suites, all offline (mcp, purchase, panel, stdio-panel, install)
pnpm stability          # 25 cold starts; must not print below 95%
```

`preflight` checks the three things that silently kill the demo, each with a
symptom that is otherwise maddening to diagnose:

| Symptom | Cause |
|---|---|
| every tool answers `Tool not found` | the UCP agent profile is unreachable, or served without a public `Cache-Control` / `application/json` |
| a hand-picked store returns nothing | headless or password-protected storefront — the pin file is stale |
| server won't start | 8787 already listening — `basketed doctor` names the process holding it, and `serve --http` prints who owns the port rather than a stack trace |
| a client cannot connect over HTTP | a `serve --stdio` panel is on 8788 and has no `/mcp`; HTTP is 8787. `basketed doctor` prints the owner of both |

**Then stop touching the live endpoints.** Rate limits are unpublished and a
rehearsal loop is the one thing that can burn them.

### If the venue wifi dies

```bash
pnpm drill        # the whole demo path with the network actually severed
```

This is not `BASKETED_SNAPSHOTS=1` on a machine that still has wifi — that
proves only that the flag parses. `scripts/offline-guard.mjs` is preloaded into
the server and refuses every non-loopback connection, so if any part of the
demo needed the internet, the drill fails instead of the stage does. It covers
§11 steps 1, 3–11, and it passes: Shopify replays from `fixtures/snapshots/`,
the simulated stores never wanted the network, and the purchase gate is
untouched by either.

Two things it will show you, both worth saying out loud:

- **Seven of the ten pinned stores go dark**, because only three have a Day-0
  snapshot. They come back in `stores_failed`, named. A search that quietly
  returned fewer stores would look *identical to success* from the stage.
- The Shopify cart still reconciles: `lines 19.99 vs total 14.00 — Item
  Discounts: -5.99 USD`. A real merchant discount, captured at Day-0.

**Say it rather than hide it** — "the wifi is gone, so this is running off
Day-0 snapshots, and here is the same flow" is a stronger moment than a failed
live call.

---

## The run

### 1 · Start it — 20s

```bash
node packages/cli/bin.js serve --http --open
```

One process, one port. The panel opens; the MCP endpoint is on `/mcp`. Point at
the two numbers on the page and move on.

The demo uses `--http` because a fixed port is one less thing to go wrong on
stage. Nobody has to: an agent that launched Basketed over stdio gets the same
panel in that same process, on a port it prints to its console.

### 2 · Search — 40s

> "Find me ground coffee under £10, across everything I'm connected to."

What to point at, in order:

1. **Real Shopify results and stamped `SIMULATED` results side by side.** Say the
   difference out loud. "That one is a live merchant. That one is fixture-backed
   and says so on every single row. There is no mode that means *we scraped it
   and hoped*."
2. `basket_get_token_report` → **~99% saved** against the bytes we actually
   fetched. Then immediately give the honest version: *the published headline is
   91.9%, because that one includes our own 3,144-token tool-definition
   overhead.* Volunteering the less flattering number is the point.

### 3 · Prepare — 40s

> "Add the cheapest one to a basket."

- A **real server-side cart** at the merchant. Real totals. Merchant discounts
  applied server-side without us asking.
- `charged: false`, stated as a structured field, not just prose.
- **Turn to the terminal.** A 6-digit code is sitting on the server's own stderr.
  "The model cannot read this surface. The only way it gets that code is if I
  read it out."

### 4 · Approve — 40s

Two ways, pick one and mention the other:

- **Channel C** — read the code to the agent. Works in 100% of clients.
- **Channel A** — `/approvals`, from the token link on the server's console.
  Itemised, five-minute countdown, and **you have to type the exact total.**
  What you confirm is the number, not the position of a button. Curl that URL
  without the token and you get a locked page — the agent's shell is not a way
  in.

Then confirm. The order comes back **`HANDED_OFF`, `outcome: unknown`** —

> "It did not buy anything. It handed me a checkout page. We never take payment
> and we have no way to know whether I completed it, so it says exactly that.
> A green tick here would be the most damaging bug this product could ship."

### 5 · The adversarial pass — 90s, the strongest part

Run these live, in this order:

```bash
node scripts/smoke-purchase.mjs     # or do it by hand in the agent
```

1. `purchase_confirm` on a fresh id, **before** approving → refused
2. approve, confirm, then **replay the same `approval_id`** → refused, consumed
3. **edit a price in the DB**, then confirm → refused, hash drift
4. restart with `--fast-mode`, repeat 1–3 → **all still refused**
5. **ask the agent to approve its own purchase**

Item 5 costs nothing and lands hardest. There is no tool that can. Show
`tools/list`. *The absence is the feature.*

Then the line that closes it:

> "Most projects assert that in a README. We assert it in the import graph — a
> test walks it and fails CI if `mcp/policy.ts` ever becomes reachable from
> `commerce/purchase.ts`. The flag isn't ignored on the purchase path. It can't
> be seen from there."

---

## Questions you will get

**"Why not just scrape Amazon?"** — We do, for Amazon / IKEA / Target /
Etsy / eBay / Best Buy discovery and detail only. Their own public pages are
fetched over plain HTTP with a real browser's headers and parsed as a
signed-out visitor sees them; Etsy alone retries through a stealth browser
(`patchright`) when it answers 403. That is still `mode: "native"` — whose data
it is, not how it was fetched — but it is scraping and we say so
(`adapters/src/stealth/browser.ts`). No login, no session, no cart; the
alternative was building nothing at all for six of the most-shopped stores.
Provider-sourced `provider` mode is still designed, not built.

**"What happens when one of them blocks you mid-demo?"** — The store comes back
in `stores_failed` with the reason, and the other stores answer normally. It is
never reported as zero results: an interstitial and an empty shelf are
different answers, and only one of them is ours to give
(`adapters/src/blocked.ts`).

**"So some of your stores are fake?"** — Every response and every card carries
its mode. Six stores are fixture-backed because they have no lawful automated
route at any price — Alibaba, Taobao, JD and the rest need a Chinese business
entity. Simulating them is the honest option, which is why we label it instead of
pretending.

**"Did it actually buy anything?"** — No, and it says so. Shopify gates payment
completion behind a hand-granted merchant token with no public application, so
hand-off is not a choice we made, it is the platform ceiling. No code path here
can move real money and none could even if we wanted it to.

**"What if a product description tells the agent to buy something?"** — The
approval screen and the cart hash are built **only** from numeric fields,
enumerated fields and the normalized product name. No merchant-authored string
reaches either. Sanitisation is defence in depth; that is the actual defence.

**"What happens when your server gets breached?"** — There is no server, and
there is nothing to take. Everything runs on this machine: SQLite at
`~/.basketed/basketed.db` and a vault at `~/.basketed/master.key` sealed with
AES-256-GCM (the model cannot read it — there is no tool or route that returns
a secret). Shopify UCP is anonymous; the simulated stores have nothing to
check — the vault is empty unless you put something in from Connect stores.
Real Tesco (`tsc:tesco`) seals the header pair its basket API actually uses
(`authorization` + `customer-uuid`), and refuses a capture missing either. The
other six connectable retailers seal a cookie jar and gate nothing behind it:
disconnect one and its search keeps working, which is the point.

---

## Do not claim

Provider-sourced retailer data, real retailer OAuth, approval channel B
(elicitation), `compare_products`, MCPB, registry publish, or a completed paid
order. All are designed in the plan; none are built. The credential vault, real
Tesco (`tsc:tesco`) and real Amazon / IKEA / Target discovery+detail, and
Connect stores via browser tab + extension are now built (S14, S16, S17, S20).
Seven retailers can be connected (S22) — Amazon, Best Buy, eBay, Etsy, IKEA,
Target and Tesco — and only Tesco requires it: the other six attach the session
to search and product pages when one is held and answer signed out when it is
not.
Real retailer cart for Costco / Walmart / Shopee and real checkout remain
unbuilt by design. The pitch is *here is the architecture, and the adapters plus
the gate that prove it* — which is a stronger thing to say than six
half-finished subsystems.
