# Reference-MCP Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the working mechanisms out of seven abandoned or single-retailer shopping MCPs and rebuild them, improved, inside Basketed's own adapter/vault/panel architecture — so a connected store actually transacts instead of merely being connected.

**Architecture:** Nothing here is a port. Each source repo is a *single-retailer, single-user script* that keeps credentials in a plaintext `.env` or `~/.config` JSON and exposes retailer-shaped tools directly to the model. Basketed's shape is the opposite: one normalised tool surface across 21 stores, credentials sealed in a vault no tool can read, and every money-adjacent action behind a human approval. So we take their *discovered facts* — endpoints, header names, auth mechanics, the anti-bot workarounds they proved — and re-express them as (a) capability tiers on `StoreAdapter`, (b) credential kinds in the vault, (c) a browser primitive in the stealth engine. Three phases, each independently shippable.

**Tech Stack:** TypeScript (NodeNext, strict), vitest, `patchright` (stealth Chromium), `puppeteer-core` (connect flow), better-sqlite3-style `node:sqlite`, Zod schemas in `@basketed/core`, MCP SDK in `@basketed/mcp`.

**Spec:** This document's "Source study" section. The brief was given inline rather than as a separate spec doc; the findings below are the spec, and every one was read out of the source repo named, not recalled.

---

## Global Constraints

- **Licence discipline.** `tesco-grocery-mcp`, `costco-mcp`, `shopee-mcp`, `kroger-mcp`, `rohlik-mcp` are **MIT** — code may be adapted with attribution in a file header. `mcp-target` and `Fewsats/amazon-mcp` have **no licence file**: take *facts* (URLs, header names, observed behaviour) but **copy no code from those two**. Every file that owes a mechanism to a source repo names it in its header comment.
- **No new evasion.** Existing rule, unchanged: the stealth engine may keep the fingerprint patches it already has for signed-out public pages, but nothing in this plan may add automation-hiding to an authenticated session. See `packages/adapters/src/stealth/browser.ts` header.
- **No credential ever reaches an adapter.** `AdapterCtx` has no field one could travel in; secrets attach inside `authorizedFetch`'s closure. Any new credential shape keeps that property.
- **No new field that accepts a retailer password.** S19 removed the last one and a test keeps it removed.
- **Money-adjacent stays behind the human.** Nothing in this plan may become reachable under `--fast-mode`. `packages/mcp/src/policy.ts` must remain unreachable from `packages/commerce/src/purchase.ts`; a test walks the import graph.
- **Every stored plaintext must be in `vault.secrets()`** so the redaction net can watch it. A structured credential registers its *values*, not its JSON envelope.
- Node ≥ 22. `exactOptionalPropertyTypes: false`, `noUncheckedIndexedAccess: true` — index access needs a guard or `??`.
- Commit after every task. Run `npx tsc --build && npx vitest run` before each commit.

---

## Source study

Read directly from each repo's source on 2026-09-01. This is the evidence the tasks argue from.

### 1. `GavinAttard/tesco-grocery-mcp` (MIT, TS, 13 tools)

`src/client.ts` posts to `https://xapi.tesco.com/` with `x-apikey: TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA` — **the same endpoint and the same public key our own `tesco/adapter.ts:48` already uses.** Two things it does that we do not:

1. It sends **`customer-uuid`** alongside `authorization`. Our `graphqlHeaders()` sends only the bearer. A basket call authenticated by bearer alone is the most likely reason a connected Tesco still fails.
2. It **decodes the JWT `exp` claim** (`checkTokenExpiry`) and refuses with a typed `TOKEN_EXPIRED` *before* making the call, naming the expiry time.

Its tool surface, for reference: `search_products`, `get_product_details`, `get_offers`, `get_substitutions`, `browse_categories`, `get_favourites`, `get_order_history`, `get_basket`, `add_to_basket`, `remove_from_basket`, `get_delivery_slots`, `get_available_weeks`, `get_current_slot`, `book_delivery_slot`, `set_auth_token`. **Delivery slots are a capability tier we do not have at all**, and for a grocery order they are the difference between a basket and a delivery.

It also maps HTTP status to typed errors: 429 → `RATE_LIMITED` (reading `retry-after`), 401/403 → `TOKEN_EXPIRED`, 5xx → `API_ERROR`.

### 2. `thehesiod/costco-mcp` (MIT, Python)

`auth.py` is the valuable file. Costco is Azure AD B2C: the browser login yields a **refresh token**, and the server mints fresh `id_token`s on demand against
`https://signin.costco.com/{tenant}/{policy}/oauth2/v2.0/token` with `grant_type=refresh_token`, `scope=openid profile offline_access`. It checks `exp` with a 120-second buffer before reusing a cached token. API calls go to `https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql` with `costco-x-authorization: Bearer <id_token>`, `costco-x-wcs-clientid`, `client-identifier`.

**This is the pattern that makes a connection last.** Everything Basketed seals today is a snapshot that dies in hours. A refresh credential is a session that renews itself.

`auth_browser.py` launches Chrome with `--remote-debugging-port` against a persistent profile at `~/.costco-mcp/chrome-profile` — independently the same design as our `browser-connect.ts` fallback, which is a useful validation of that choice. It also supports **multiple accounts per store**, keyed by the email in the token.

### 3. `bintangtimurlangit/shopee-mcp` (MIT, TS)

The most interesting technique in the whole set. Shopee signs every API request with `af-ac-enc-dat` / `x-sap-sec` headers a hand-rolled fetch cannot produce, so `src/api/client.ts` does not fetch at all: it **loads the Shopee page in a real browser and captures the JSON that Shopee's own app fetches from `/api/v4/*`** (`captureJson(pageUrl, { apiMatch })`). Error `90309999` in that JSON means the anti-bot gate fired; it retries once before reporting "not signed in", because a timeout and a block look identical.

Our own README records Shopee as the one retailer the stealth browser could not beat. This is why: we were forging the request. Capturing the response instead sidesteps the signature entirely — **and it returns structured JSON rather than HTML we have to parse**, which is a robustness upgrade for Amazon, IKEA and Target too.

Auth signal: `SPC_U` (user id) and `SPC_EC` (encrypted session). Our `connections.ts` currently lists `SPC_ST`, `SPC_U`, `SPC_R_T_ID` — `SPC_EC` is missing.

### 4. `markswendsen-code/mcp-target` (NO LICENCE — facts only, no code)

A 35KB single-file browser driver. Tools: `status`, `login`, `logout`, `search_products`, `get_product`, `check_store_availability`, `add_to_cart`, `view_cart`, `clear_cart`, `checkout`, `get_orders`, `track_order`. Useful facts only: product URLs are `https://www.target.com/p/-/A-{tcin}`, search is `https://www.target.com/s?...`, cart at `/cart`, orders at `/account/orders/{id}`. It stores cookies as plaintext JSON in `~/.striderlabs/target/cookies.json` — precisely the failure mode our vault exists to avoid, worth naming in the write-up.

### 5. `Fewsats/amazon-mcp` (NO LICENCE, archived, 80★ — concept only)

Thin client over Fewsats' hosted service; purchase is `amazon_get_payment_offers` → pay via **L402** → order. Concept worth noting in the hackathon write-up (agent-native payment rails) but the flow is weaker than ours: no spend cap, no typed-total confirmation, no mandate. Nothing to build from.

### 6. Also found (MIT, mined for confirmation)

- `CupOfOwls/kroger-mcp` (70★): the only source using an *official* retailer API. Keeps a **local mirror of the cart** and a `mark_order_placed` / `view_order_history` pair, because Kroger's API can add to a cart but cannot read it back. Confirms our `handoff` tier design.
- `tomaspavlin/rohlik-mcp` (119★): `delivery-slots`, `frequent-items`, `discounted-items`, `meal-suggestions`. Second independent vote for delivery slots as a first-class capability.
- `mgwalkerjr95/texas-grocery-mcp` (55★, HEB): `auth/browser_refresh.py` + `clients/graphql.py` — third independent implementation of browser-capture-then-refresh.

### What we take, and what we change

| Source | Fact taken | What we do differently |
| --- | --- | --- |
| tesco-grocery-mcp | `customer-uuid` header; JWT `exp` pre-check; slot operations | Header lifted automatically by the extension at connect time, not pasted from DevTools into a `.env`; expiry surfaced in the panel before a call fails |
| costco-mcp | Azure B2C refresh-token flow; multi-account | Refresh token sealed in the vault, refreshed inside `authorizedFetch`'s closure — the adapter never holds it |
| shopee-mcp | Capture the site's own XHR JSON instead of forging signed requests | Generalised into one `captureJson()` primitive every scrape adapter shares, not a Shopee-only path |
| mcp-target | Public URL shapes only | Cookies never touch disk in plaintext |
| kroger-mcp | Local cart mirror + handoff | Already our `handoff` tier; confirms the design |

---

## File Structure

**Phase 1 — the Tesco connection actually works**

- `packages/vault/src/index.ts` — MODIFY. `CredentialKind` gains `"session"`, drops the dead `"password"`. New `SessionSecret` envelope; `authorizedFetch` attaches every header in it; `secrets()` registers header *values*; `Connection` gains `expiresAt`/`expired`.
- `packages/control/src/jwt.ts` — CREATE. One function: read the `exp` claim from a JWT without verifying it. No dependency.
- `packages/control/src/connections.ts` — MODIFY. `ChromeLogin.bearer` (a single string) becomes `capture: { match, headers[] }`, so a store can name several headers.
- `packages/control/src/browser-connect.ts` — MODIFY. Record every named header, not just `authorization`.
- `packages/extension/background.js` — MODIFY. Same, on the extension side.
- `packages/control/src/api.ts` — MODIFY. Seal a `session` credential; compute `expiresAt`.
- `packages/control/src/pages.ts`, `script.ts` — MODIFY. Show "expires in 3h" / "expired — reconnect".
- `packages/adapters/src/tesco/adapter.ts` — MODIFY. Stop hand-setting `authorization`; let the interceptor attach the whole header set.

**Phase 2 — delivery slots**

- `packages/core/src/schema/product.ts` — MODIFY. `CapabilityTierSchema` gains `"slots"`.
- `packages/core/src/schema/slots.ts` — CREATE. `DeliverySlotSchema`, `BookedSlotSchema`.
- `packages/adapters/src/types.ts` — MODIFY. Optional `slots()` / `bookSlot()` on `StoreAdapter`; `implementedTiers` learns the new tier.
- `packages/adapters/src/tesco/slots.ts` — CREATE. The two GraphQL operations and their flatteners, kept out of the already-large adapter file.
- `packages/mcp/src/tools-slots.ts` — CREATE. `basket_list_delivery_slots` (read-only) and `basket_book_delivery_slot` (approval-gated).

**Phase 3 — capture the site's own JSON**

- `packages/adapters/src/stealth/capture.ts` — CREATE. `captureJson()` beside `renderPage()`, sharing its launch config.
- `packages/adapters/src/target/adapter.ts` — MODIFY. Prefer captured JSON, fall back to HTML.
- `packages/adapters/src/shopee/` — CREATE. A real Shopee adapter, discovery + detail.

---

## Phase 1 — the Tesco connection actually works

### Task 1: A credential that can carry more than one header

**Files:**
- Modify: `packages/vault/src/index.ts`
- Test: `packages/vault/src/vault.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type CredentialKind = "token" | "cookie" | "session"`; `interface SessionSecret { headers: Record<string, string>; expiresAt?: number }`; `encodeSession(s: SessionSecret): string`; `decodeSession(raw: string): SessionSecret | null`. `Connection` gains `expiresAt: number | null` and `expired: boolean`.

**Why:** Tesco needs `authorization` *and* `customer-uuid`. Today a credential is one string and the interceptor hard-codes which header it becomes, so a second header is unrepresentable. `"password"` goes at the same time — S19 removed the last policy that offered it, and the interceptor's password branch is now unreachable code.

- [ ] **Step 1: Write the failing test**

In `packages/vault/src/vault.test.ts`:

```ts
it("a session credential attaches every header it was sealed with", async () => {
  const vault = openVault(openDb(":memory:"), { keyPath: tmpKey() });
  vault.connect({
    storeId: "tsc:tesco",
    kind: "session",
    username: null,
    secret: encodeSession({
      headers: { authorization: "Bearer abc123", "customer-uuid": "uuid-999" },
      expiresAt: 4102444800000,
    }),
  });

  let seen: Headers | undefined;
  const spy: typeof fetch = async (_input, init) => {
    seen = new Headers(init?.headers);
    return new Response("{}", { status: 200 });
  };

  await authorizedFetch(vault, "tsc:tesco", spy)("https://xapi.tesco.com/", { method: "POST" });
  expect(seen?.get("authorization")).toBe("Bearer abc123");
  expect(seen?.get("customer-uuid")).toBe("uuid-999");
});

it("registers each header value for redaction, never the JSON envelope", () => {
  const vault = openVault(openDb(":memory:"), { keyPath: tmpKey() });
  vault.connect({
    storeId: "tsc:tesco",
    kind: "session",
    username: null,
    secret: encodeSession({ headers: { authorization: "Bearer abc123", "customer-uuid": "uuid-999" } }),
  });
  const secrets = vault.secrets();
  expect(secrets).toContain("Bearer abc123");
  expect(secrets).toContain("uuid-999");
  // The envelope itself would never appear in a response body; watching for it
  // would be a redaction rule that can never fire.
  expect(secrets.some((s) => s.startsWith("{"))).toBe(false);
});

it("reports a session's expiry, and that it has passed", () => {
  const vault = openVault(openDb(":memory:"), { keyPath: tmpKey() });
  vault.connect({
    storeId: "tsc:tesco",
    kind: "session",
    username: null,
    secret: encodeSession({ headers: { authorization: "Bearer x" }, expiresAt: 1_000 }),
  });
  const held = vault.get("tsc:tesco");
  expect(held?.expiresAt).toBe(1_000);
  expect(held?.expired).toBe(true);
});
```

Add `import { authorizedFetch, encodeSession } from "./index.js";` to the existing import line. `tmpKey()` is whatever helper the file already uses for a throwaway key path — reuse it, do not invent a second one.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/vault/src/vault.test.ts -t "session credential"`
Expected: FAIL — `encodeSession is not exported`.

- [ ] **Step 3: Implement the session kind**

In `packages/vault/src/index.ts`, replace the `CredentialKind` line:

```ts
/**
 * `password` is deliberately absent (S19): there is no field anywhere in
 * Basketed that accepts a retailer password, so a kind that could only have
 * come from one is a kind nothing can create.
 */
export type CredentialKind = "token" | "cookie" | "session";

/**
 * What a `session` credential seals: the exact headers a signed-in browser
 * sent, lifted from the store's own API call.
 *
 * One string was enough while every store's credential was one header. Tesco's
 * is not -- its basket API wants `authorization` AND `customer-uuid`, and a
 * bearer alone gets a basket that is not yours. Rather than teach the vault
 * about retailers, the capture side names the headers and the vault carries
 * whatever it is given.
 */
export interface SessionSecret {
  headers: Record<string, string>;
  /** Unix ms. Read from the JWT's `exp` at capture time when there is one. */
  expiresAt?: number;
}

export function encodeSession(s: SessionSecret): string {
  return JSON.stringify(s);
}

export function decodeSession(raw: string): SessionSecret | null {
  try {
    const parsed = JSON.parse(raw) as SessionSecret;
    if (!parsed || typeof parsed !== "object" || typeof parsed.headers !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
```

Add to `Connection`:

```ts
  /** Unix ms the store said this session stops working, when it said so. */
  expiresAt: number | null;
  /** True once that moment has passed. A dead session, not a missing one. */
  expired: boolean;
```

In the row-mapping helper that builds a `Connection` (there are two call sites — `list()` and `get()`; change both, or better, factor the mapping into one local function first), compute:

```ts
const session = kind === "session" && !broken ? decodeSession(revealPlaintext(row)) : null;
const expiresAt = session?.expiresAt ?? null;
return { ..., expiresAt, expired: expiresAt !== null && expiresAt <= Date.now() };
```

`revealPlaintext` is whatever the file already uses to unseal — reuse it; do not add a second decrypt path. If unsealing throws, `broken` is already true and `expiresAt` stays `null`.

In `authorizedFetch`, replace the branch chain:

```ts
    if (cred.kind === "token") headers.set("authorization", `Bearer ${cred.secret}`);
    else if (cred.kind === "cookie") headers.set("cookie", cred.secret);
    else if (cred.kind === "session") {
      const session = decodeSession(cred.secret);
      if (!session) return base(input, init);
      // Verbatim, in the order the browser sent them. The vault does not know
      // or care what any of these mean.
      for (const [name, value] of Object.entries(session.headers)) headers.set(name, value);
    } else return base(input, init);
```

In `secrets()`, expand a session into its values:

```ts
      // A session seals several secrets in one envelope. The redaction net
      // watches for the VALUES: the envelope is a shape no response body will
      // ever contain, so registering it would be a rule that cannot fire.
      if (c.kind === "session") {
        const session = decodeSession(plain);
        if (session) out.push(...Object.values(session.headers));
        continue;
      }
      out.push(plain);
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run packages/vault/src/vault.test.ts`
Expected: PASS. Existing tests that use `kind: "password"` will now fail to typecheck — rewrite each to `kind: "token"`, and delete the test named "a password connection attaches nothing" (the branch it covered no longer exists; the kind cannot be constructed).

- [ ] **Step 5: Full build and suite**

Run: `npx tsc --build && npx vitest run`
Expected: PASS. `packages/control/src/api.ts` will complain about `CredentialKind` if anything still names `"password"` — remove those references; the policy tables stopped offering it in S19.

- [ ] **Step 6: Commit**

```bash
git add packages/vault/src/index.ts packages/vault/src/vault.test.ts packages/control/src/api.ts
git commit -m "vault: a session credential can carry several headers, and knows when it dies"
```

---

### Task 2: Read a JWT's expiry without trusting it

**Files:**
- Create: `packages/control/src/jwt.ts`
- Test: `packages/control/src/jwt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `expiryOf(token: string): number | null` — Unix **ms**, or `null` when the string is not a JWT or carries no `exp`.

**Why:** Both `tesco-grocery-mcp` and `costco-mcp` decode `exp` to answer "is this still good?" before spending a network call on the answer. Ours can do it at capture time and show it in the panel.

- [ ] **Step 1: Write the failing test**

Create `packages/control/src/jwt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expiryOf } from "./jwt.js";

/** A JWT with the given exp, unsigned -- the signature is never checked here. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.signature-we-never-verify`;
}

describe("expiryOf", () => {
  it("reads the exp claim as milliseconds", () => {
    expect(expiryOf(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });

  it("tolerates a Bearer prefix, because that is how the header arrives", () => {
    expect(expiryOf(`Bearer ${jwt({ exp: 1_800_000_000 })}`)).toBe(1_800_000_000_000);
  });

  it("returns null for a token with no exp, and for something that is not a JWT", () => {
    expect(expiryOf(jwt({ sub: "someone" }))).toBeNull();
    expect(expiryOf("not-a-jwt")).toBeNull();
    expect(expiryOf("")).toBeNull();
  });

  /*
   * The signature is not checked and must not be: this is a hint for the
   * panel, not an authorisation decision. A forged exp costs a wrong label on
   * a card the user owns -- checking it would mean holding a retailer's public
   * key, which we have no way to obtain.
   */
  it("does not care that the signature is nonsense", () => {
    const parts = jwt({ exp: 1_800_000_000 }).split(".");
    expect(expiryOf(`${parts[0]}.${parts[1]}.zzzz`)).toBe(1_800_000_000_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/control/src/jwt.test.ts`
Expected: FAIL — cannot resolve `./jwt.js`.

- [ ] **Step 3: Implement it**

Create `packages/control/src/jwt.ts`:

```ts
/**
 * Read the expiry out of a bearer token, when it is a JWT (S21).
 *
 * Both of the reference implementations this was learned from
 * (GavinAttard/tesco-grocery-mcp, thehesiod/costco-mcp -- both MIT) do the
 * same thing for the same reason: a session that has already expired should
 * be reported as expired, not discovered as a 401 halfway through a basket.
 *
 * The signature is deliberately not verified, and cannot be: we would need
 * the retailer's public key. Nothing is authorised on the strength of this
 * value -- it decides what a card in the panel says, and nothing else.
 */
export function expiryOf(token: string): number | null {
  const raw = token.replace(/^Bearer\s+/i, "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const body = parts[1];
  if (!body) return null;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/control/src/jwt.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/jwt.ts packages/control/src/jwt.test.ts
git commit -m "control: read a session's expiry from its JWT, for the panel to show"
```

---

### Task 3: Capture every header the store's API needs, not just one

**Files:**
- Modify: `packages/control/src/connections.ts`
- Modify: `packages/control/src/browser-connect.ts`
- Modify: `packages/extension/background.js`
- Modify: `packages/control/src/api.ts`
- Test: `packages/control/src/panel.test.ts`

**Interfaces:**
- Consumes: `encodeSession`, `SessionSecret` (Task 1); `expiryOf` (Task 2).
- Produces: `ChromeLogin.capture?: { match: string; headers: string[] }` replacing `ChromeLogin.bearer?: string`. `captureLogin()` returns `{ ok: true; cookieHeader: string; headers: Record<string, string> }` — `bearer` is gone, folded into `headers`.

**Why:** `tesco-grocery-mcp`'s client sends `customer-uuid` next to `authorization`. Our capture lifts one header and calls it "bearer", which cannot express that.

- [ ] **Step 1: Write the failing test**

In `packages/control/src/panel.test.ts`, inside the S20 describe block:

```ts
it("seals every header the store named, and the session's expiry with them", async () => {
  // A JWT that expires in 2027, so the sealed session is not born expired.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = `Bearer ${b64({ alg: "none" })}.${b64({ exp: 1_800_000_000 })}.sig`;

  await panel("/api/connections/tsc%3Atesco/browser-connect", { method: "POST" });
  const res = await panel("/api/connections/tsc%3Atesco/extension-capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cookie_header: "junk=1",
      headers: { authorization: token, "customer-uuid": "uuid-999" },
    }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, store_id: "tsc:tesco", method: "session" });

  const held = vault.get("tsc:tesco");
  expect(held?.expiresAt).toBe(1_800_000_000_000);

  const revealed = vault.reveal("tsc:tesco")!;
  const session = decodeSession(revealed.secret)!;
  expect(session.headers["customer-uuid"]).toBe("uuid-999");
});

it("refuses a capture that is missing a header the store requires", async () => {
  await panel("/api/connections/tsc%3Atesco/browser-connect", { method: "POST" });
  const res = await panel("/api/connections/tsc%3Atesco/extension-capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cookie_header: "junk=1", headers: { authorization: "Bearer x" } }),
  });
  // Sealing a half-session would look like success here and fail at the first
  // basket call, which is the exact failure this whole task exists to remove.
  expect(res.status).toBe(409);
  expect(vault.get("tsc:tesco")).toBeNull();
});
```

The test registry must now include real Tesco. In the `beforeEach`, alongside `registry.register(new TargetAdapter())`, add `registry.register(new TescoAdapter());` and extend the import from `@basketed/adapters`. Add `decodeSession` to the `@basketed/vault` import.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/control/src/panel.test.ts -t "seals every header"`
Expected: FAIL — the route seals `method: "token"` and ignores `headers`.

- [ ] **Step 3: Change the policy shape**

In `packages/control/src/connections.ts`, replace the `bearer?: string` field on `ChromeLogin`:

```ts
  /**
   * Headers to lift from the store's own API call, when the credential is not
   * in the cookie jar at all.
   *
   * Tesco is the case that forced this: its basket API is authenticated by
   * `authorization` AND `customer-uuid` together, and a bearer on its own
   * returns somebody else's empty basket. Learned from
   * GavinAttard/tesco-grocery-mcp (MIT), whose client sends the same pair.
   *
   * Every header named here is REQUIRED -- a capture missing one is refused
   * rather than sealed, because a half-session fails later and confusingly.
   */
  capture?: { match: string; headers: string[] };
```

Update the two Tesco entries in `CHROME_LOGIN`:

```ts
  "tsc:tesco": {
    url: "https://www.tesco.com/groceries/en-GB/",
    loginUrl: "https://www.tesco.com/account/login/en-GB",
    domains: ["tesco.com"],
    authCookies: ["_ttoken", "trefresh", "atrc_", "access_token"],
    capture: { match: "xapi.tesco.com", headers: ["authorization", "customer-uuid"] },
  },
```

Leave `sim:tesco` without a `capture` block — the fixture twin has no basket to authenticate against.

Also add Shopee's missing signed-in cookie while here — `shopee-mcp` checks `SPC_U` and `SPC_EC`:

```ts
    authCookies: ["SPC_ST", "SPC_U", "SPC_EC", "SPC_R_T_ID"],
```

Change `REAL_TESCO_POLICY.methods` from `["token"]` to `["session"]`.

- [ ] **Step 4: Record every named header in both capture paths**

In `packages/control/src/browser-connect.ts`, replace `bearerMatch`/`bearer` on `CaptureSession` with:

```ts
  /** What to lift, and from where. Null when the cookie jar is the credential. */
  capture: { match: string; headers: string[] } | null;
  /** Header name (lower-cased) -> value, as last seen. Never logged, never served. */
  captured: Record<string, string>;
```

`watchForBearer` becomes `watchForHeaders`:

```ts
function watchForHeaders(page: Page, storeId: string, want: { match: string; headers: string[] }): void {
  page.on("request", (req: HTTPRequest) => {
    try {
      if (!req.url().includes(want.match)) return;
      const sent = req.headers();
      const s = sessions.get(storeId);
      if (!s) return;
      for (const name of want.headers) {
        const value = sent[name.toLowerCase()];
        if (value) s.captured[name.toLowerCase()] = value;
      }
      // A complete set IS proof of a signed-in session, and it usually
      // arrives before the cookie signature does.
      if (want.headers.every((h) => s.captured[h.toLowerCase()])) s.loggedIn = true;
    } catch {
      // a request that vanished mid-flight tells us nothing; ignore it
    }
  });
}
```

`captureLogin` returns `{ ok: true; cookieHeader: string; headers: Record<string, string> }` — replace the `bearer` field with `headers: s.captured`.

In `packages/extension/background.js`, replace the single-match bearer map with a per-match header map:

```js
/**
 * Request headers seen in flight, keyed by the URL fragment that identifies
 * the API they belong to, then by header name.
 *
 * Some retailers' credentials are not in the cookie jar at all: Tesco's basket
 * API is authenticated by an `authorization` + `customer-uuid` pair its own
 * frontend sends to xapi.tesco.com. `onSendHeaders` is observational only --
 * it cannot block, redirect or alter a request, and this listener does not try.
 */
const capturedHeaders = new Map(); // match -> { name: value }
const watched = new Map();         // match -> [header names]

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    for (const [match, names] of watched) {
      if (!details.url.includes(match)) continue;
      const bag = capturedHeaders.get(match) || {};
      for (const h of details.requestHeaders || []) {
        const name = h.name.toLowerCase();
        if (names.includes(name) && h.value) bag[name] = h.value;
      }
      capturedHeaders.set(match, bag);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);
```

In the `basketed-capture` message handler, replace the bearer lookup:

```js
    if (msg.capture) watched.set(msg.capture.match, msg.capture.headers.map((h) => h.toLowerCase()));
    const headers = msg.capture ? capturedHeaders.get(msg.capture.match) || {} : {};
    const complete = msg.capture ? msg.capture.headers.every((h) => headers[h.toLowerCase()]) : false;
    respond({
      ok: true,
      cookieHeader,
      headers,
      signedIn: looksSignedIn(cookieHeader, msg.authCookies) || complete,
    });
```

And in `packages/control/src/pages.ts`'s `connectAnchor`, replace `data-bearer` with the whole capture block:

```ts
     data-capture="${esc(JSON.stringify(login.capture ?? null))}"
```

…and in `packages/control/src/script.ts`, `connectConfig` reads `capture: JSON.parse(el.dataset.capture || "null")`, passes `capture` in the postMessage instead of `bearerMatch`, and sends `headers: reply.headers` in the `extension-capture` body instead of `bearer`.

- [ ] **Step 5: Seal it as a session**

In `packages/control/src/api.ts`, in the `extension-capture` route, replace the bearer branch:

```ts
    const payload = await body();
    const cookieHeader = String(payload["cookie_header"] ?? "").trim();
    const sent = (payload["headers"] ?? {}) as Record<string, unknown>;
    const want = policy.chromeLogin.capture;

    if (want) {
      const headers: Record<string, string> = {};
      for (const name of want.headers) {
        const value = String(sent[name] ?? sent[name.toLowerCase()] ?? "").trim();
        if (value) headers[name.toLowerCase()] = value;
      }
      const missing = want.headers.filter((h) => !headers[h.toLowerCase()]);
      if (missing.length) {
        return {
          status: 409,
          body: {
            error:
              `Signed in, but ${store.name} has not sent ${missing.join(" and ")} yet. ` +
              `Open your basket in that tab and it will finish by itself.`,
          },
        };
      }
      const auth = headers["authorization"];
      const expiresAt = auth ? expiryOf(auth) : null;
      const secret = encodeSession(expiresAt === null ? { headers } : { headers, expiresAt });
      // ...vault.connect({ storeId, kind: "session", username: null, secret })
    }
```

Apply the identical change to the `chrome-login/capture` route, which now reads `captured.headers` instead of `captured.bearer`.

- [ ] **Step 6: Let the interceptor do its job**

`graphqlHeaders()` already sets no `authorization` — the interceptor attaches it — so there is nothing to delete. Update its header comment, which currently says only "Authorization: Bearer <token>", to name the pair:

```ts
 * Never sets authorization itself, and never could -- the credential is
 * attached by `authorizedFetch` inside the vault, after this function has
 * finished describing the request. Since S21 that is a header SET
 * (`authorization` + `customer-uuid`), not a single bearer: Tesco's basket
 * API needs both, and a bearer alone returns a basket that is not yours.
```

- [ ] **Step 7: Run everything**

Run: `npx tsc --build && npx vitest run`
Expected: PASS. The S20 test asserting `method: "cookie"` for `sim:amazon` still passes — that store has no `capture` block and still seals a cookie jar.

- [ ] **Step 8: Commit**

```bash
git add packages/control packages/extension packages/adapters/src/tesco
git commit -m "connect: capture the full header set a store's API needs, sealed as one session"
```

---

### Task 4: Say when a session dies, before it does

**Files:**
- Modify: `packages/control/src/api.ts` (the `/api/connections` list)
- Modify: `packages/control/src/script.ts` (the status pill)
- Modify: `packages/control/src/pages.ts` (the store page's held-credential card)
- Test: `packages/control/src/panel.test.ts`

**Interfaces:**
- Consumes: `Connection.expiresAt` / `.expired` (Task 1).
- Produces: `/api/connections` rows gain `expires_at: number | null` and `expired: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
it("reports a connected store whose session has expired as needing a reconnect", async () => {
  vault.connect({
    storeId: "sim:amazon",
    kind: "session",
    username: null,
    secret: encodeSession({ headers: { authorization: "Bearer x" }, expiresAt: 1_000 }),
  });
  const list = (await (await panel("/api/connections")).json()) as {
    connections: Array<Record<string, unknown>>;
  };
  const amazon = list.connections.find((c) => c["store_id"] === "sim:amazon");
  expect(amazon).toMatchObject({ connected: false, expired: true, expires_at: 1_000 });
});
```

`connected: false` is the load-bearing assertion: an expired session is not a connection, and a panel that shows it green is lying.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/control/src/panel.test.ts -t "expired"`
Expected: FAIL — `expired` is undefined and `connected` is `true`.

- [ ] **Step 3: Report it**

In `api.ts`'s `/api/connections` mapper:

```ts
            connected: held_ !== null && !held_.broken && !held_.expired,
            broken: held_?.broken ?? false,
            expired: held_?.expired ?? false,
            expires_at: held_?.expiresAt ?? null,
```

- [ ] **Step 4: Show it**

In `script.ts`'s `pill()`, above the `c.connected` branch:

```js
    if (c.expired) return '<span class="pill bad">session expired</span>';
```

and, for a live one, append the runway so the user can see it coming:

```js
    if (c.connected) {
      const left = c.expires_at ? " · " + hoursLeft(c.expires_at) : "";
      return '<span class="pill on">connected' + esc(left) + '</span>';
    }
```

with, near the other helpers:

```js
/* "3h left" / "40m left". Rounded down, because an optimistic clock on a
   session that is about to die is worse than no clock. */
function hoursLeft(at) {
  const ms = at - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  return mins >= 60 ? Math.floor(mins / 60) + "h left" : mins + "m left";
}
```

In `pages.ts`, the already-connected card gains a sentence when `held.expired` is true: `<strong>This session has expired</strong> &mdash; connect again to replace it.` Thread `expired`/`expiresAt` through `ConnectInput.connected` from `index.ts`.

- [ ] **Step 5: Run everything**

Run: `npx tsc --build && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/control
git commit -m "panel: an expired session reads as expired, not as connected"
```

---

## Phase 2 — delivery slots

### Task 5: A `slots` capability tier

**Files:**
- Modify: `packages/core/src/schema/product.ts`
- Create: `packages/core/src/schema/slots.ts`
- Modify: `packages/core/src/index.ts` (export the new schemas)
- Modify: `packages/adapters/src/types.ts`
- Test: `packages/adapters/src/conformance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DeliverySlot {
    id: string;
    start: string;       // ISO 8601
    end: string;         // ISO 8601
    available: boolean;
    price: Money | null; // null when the retailer does not price slots
  }
  export interface BookedSlot { slotId: string; start: string; end: string; expiresAt: string | null }
  ```
  `StoreAdapter` gains `slots?(range: { start: string; end: string }, ctx: AdapterCtx): Promise<DeliverySlot[]>` and `bookSlot?(slotId: string, ctx: AdapterCtx): Promise<BookedSlot>`.

**Why:** Two independent sources (`tesco-grocery-mcp`, `rohlik-mcp`) make delivery slots a first-class surface, and for groceries they are the step between a basket and an order. It is a tier, not a tool bolted onto Tesco, because Rohlik/HEB/Ocado all have one.

- [ ] **Step 1: Write the failing test**

In `packages/adapters/src/conformance.test.ts`:

```ts
it("a store claiming the slots tier implements both halves of it", () => {
  for (const adapter of registry.list().map((s) => registry.get(s.id)!)) {
    if (!adapter.manifest.capabilities.includes("slots")) continue;
    expect(typeof adapter.slots, `${adapter.manifest.id} claims slots but cannot list them`).toBe("function");
    expect(typeof adapter.bookSlot, `${adapter.manifest.id} claims slots but cannot book one`).toBe("function");
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/adapters/src/conformance.test.ts -t "slots tier"`
Expected: FAIL — `"slots"` is not a member of `CapabilityTier`.

- [ ] **Step 3: Add the tier and the schemas**

`packages/core/src/schema/product.ts`:

```ts
export const CapabilityTierSchema = z.enum(["discovery", "detail", "cart", "slots", "handoff", "checkout"]);
```

Create `packages/core/src/schema/slots.ts`:

```ts
import { z } from "zod";
import { MoneySchema } from "./money.js";

/**
 * A delivery window (S21).
 *
 * Its own tier rather than part of `cart`, because the two are genuinely
 * separable: Tesco will hold a basket with no slot and a slot with no basket,
 * and a store can support one without the other. Both reference groceries
 * MCPs studied for this (GavinAttard/tesco-grocery-mcp, tomaspavlin/rohlik-mcp
 * -- both MIT) model them as a separate surface for the same reason.
 */
export const DeliverySlotSchema = z.object({
  id: z.string().min(1),
  start: z.string().datetime(),
  end: z.string().datetime(),
  available: z.boolean(),
  price: MoneySchema.nullable(),
});
export type DeliverySlot = z.infer<typeof DeliverySlotSchema>;

export const BookedSlotSchema = z.object({
  slotId: z.string().min(1),
  start: z.string().datetime(),
  end: z.string().datetime(),
  /** When the retailer will release an unpaid reservation, if it says. */
  expiresAt: z.string().datetime().nullable(),
});
export type BookedSlot = z.infer<typeof BookedSlotSchema>;
```

Check the real name of the money schema in `packages/core/src/schema/` before writing that import — use whatever the repo already calls it.

`packages/adapters/src/types.ts`, on `StoreAdapter` after `buildCart`:

```ts
  /** List delivery windows. Requires a connected account at every retailer studied. */
  slots?(range: { start: string; end: string }, ctx: AdapterCtx): Promise<DeliverySlot[]>;
  /** Reserve one. Commits the shopper to a window; never reachable under fast-mode. */
  bookSlot?(slotId: string, ctx: AdapterCtx): Promise<BookedSlot>;
```

and in `implementedTiers`, add:

```ts
  if (typeof adapter.slots === "function" && typeof adapter.bookSlot === "function") tiers.push("slots");
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/adapters/src/conformance.test.ts`
Expected: PASS — no adapter claims the tier yet, so the loop body does not run. That is the correct green: the gate exists before anything walks through it.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/adapters/src/types.ts packages/adapters/src/conformance.test.ts
git commit -m "core: delivery slots are a capability tier, not a Tesco feature"
```

---

### Task 6: Tesco delivery slots

**Files:**
- Create: `packages/adapters/src/tesco/slots.ts`
- Modify: `packages/adapters/src/tesco/adapter.ts`
- Test: `packages/adapters/src/tesco/slots.test.ts`

**Interfaces:**
- Consumes: `DeliverySlot`, `BookedSlot` (Task 5); the adapter's private `#basketOp` GraphQL helper — promote it to an exported `sendOperation(query, variables, ctx)` in `slots.ts`'s own module rather than reaching into the class.
- Produces: `DELIVERY_SLOTS_QUERY`, `BOOK_SLOT_MUTATION`, `flattenSlots(raw): DeliverySlot[]`.

**Why:** Tesco is the one store where we already hold a real, working credential, so it is where a new tier can be proven end to end.

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/tesco/slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { flattenSlots } from "./slots.js";

/** The shape Tesco's DeliverySlots operation returns, trimmed to what we read. */
const RAW = [
  {
    slots: [
      { slotId: "s1", start: "2026-09-03T09:00:00Z", end: "2026-09-03T10:00:00Z", status: "AVAILABLE",
        charge: { value: 4.5, currency: "GBP" } },
      { slotId: "s2", start: "2026-09-03T10:00:00Z", end: "2026-09-03T11:00:00Z", status: "UNAVAILABLE",
        charge: null },
    ],
  },
];

describe("flattenSlots", () => {
  it("keeps only available slots by default, and normalises the money", () => {
    const out = flattenSlots(RAW, false);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "s1",
      start: "2026-09-03T09:00:00Z",
      end: "2026-09-03T10:00:00Z",
      available: true,
      price: { value: 4.5, currency: "GBP" },
    });
  });

  it("includes unavailable slots when asked, marked as such", () => {
    const out = flattenSlots(RAW, true);
    expect(out).toHaveLength(2);
    expect(out[1]?.available).toBe(false);
    expect(out[1]?.price).toBeNull();
  });

  it("drops a slot with no id rather than inventing one", () => {
    const out = flattenSlots([{ slots: [{ start: "2026-09-03T09:00:00Z", end: "x", status: "AVAILABLE" }] }], true);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/adapters/src/tesco/slots.test.ts`
Expected: FAIL — cannot resolve `./slots.js`.

- [ ] **Step 3: Implement the flattener and the operations**

Create `packages/adapters/src/tesco/slots.ts`:

```ts
import type { DeliverySlot } from "@basketed/core";

/**
 * Tesco delivery slots (S21).
 *
 * The operation names and the `type: "DELIVERY_VAN"` variable were learned
 * from GavinAttard/tesco-grocery-mcp (MIT), which drives the same
 * xapi.tesco.com endpoint this adapter already uses for search and basket.
 * The query bodies here are written against the fields we actually read --
 * deliberately narrower than theirs, because every field asked for is a field
 * that can change shape underneath us, and `basket_get_token_report` counts
 * every byte Tesco sends back.
 */
export const DELIVERY_SLOTS_QUERY = `query DeliverySlots($type: String!, $start: String!, $end: String!) {
  delivery: slots(type: $type, start: $start, end: $end) {
    slots {
      slotId
      start
      end
      status
      charge { value currency }
    }
  }
}`;

export const BOOK_SLOT_MUTATION = `mutation BookSlot($slotId: ID!) {
  bookSlot(slotId: $slotId) {
    slotId
    start
    end
    expiresAt
  }
}`;

interface RawSlot {
  slotId?: unknown;
  start?: unknown;
  end?: unknown;
  status?: unknown;
  charge?: { value?: unknown; currency?: unknown } | null;
}

/**
 * A slot with no id cannot be booked, so it is not a slot -- dropping it beats
 * handing the model something it can only fail with.
 */
export function flattenSlots(raw: Array<{ slots?: RawSlot[] }>, includeUnavailable: boolean): DeliverySlot[] {
  const out: DeliverySlot[] = [];
  for (const day of raw) {
    for (const s of day.slots ?? []) {
      const id = typeof s.slotId === "string" ? s.slotId : null;
      const start = typeof s.start === "string" ? s.start : null;
      const end = typeof s.end === "string" ? s.end : null;
      if (!id || !start || !end) continue;
      const available = s.status === "AVAILABLE";
      if (!available && !includeUnavailable) continue;
      const value = typeof s.charge?.value === "number" ? s.charge.value : null;
      const currency = typeof s.charge?.currency === "string" ? s.charge.currency : null;
      out.push({
        id,
        start,
        end,
        available,
        price: value !== null && currency !== null ? { value, currency } : null,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/adapters/src/tesco/slots.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the adapter**

In `packages/adapters/src/tesco/adapter.ts`, add `"slots"` to `manifest.capabilities` and:

```ts
  async slots(range: { start: string; end: string }, ctx: AdapterCtx): Promise<DeliverySlot[]> {
    const data = await this.#op<{ delivery?: Array<{ slots?: unknown[] }> }>(
      DELIVERY_SLOTS_QUERY,
      { type: "DELIVERY_VAN", start: range.start, end: range.end },
      ctx,
    );
    return flattenSlots((data.delivery ?? []) as Array<{ slots?: never[] }>, false);
  }

  async bookSlot(slotId: string, ctx: AdapterCtx): Promise<BookedSlot> {
    const data = await this.#op<{ bookSlot?: BookedSlot }>(BOOK_SLOT_MUTATION, { slotId }, ctx);
    const booked = data.bookSlot;
    if (!booked?.slotId) throw new Error("Tesco did not confirm the slot. It may have been taken.");
    return booked;
  }
```

`#op` is `#basketOp` generalised over its return type — rename it and widen the generic; it already maps 401/403 to "reconnect Tesco", which is exactly the error a stale slot call should give.

- [ ] **Step 6: Run everything**

Run: `npx tsc --build && npx vitest run`
Expected: PASS — including the conformance test from Task 5, which now actually walks its loop body for `tsc:tesco`.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/tesco
git commit -m "tesco: list and book real delivery slots"
```

---

### Task 7: Two MCP tools for slots

**Files:**
- Create: `packages/mcp/src/tools-slots.ts`
- Modify: `packages/mcp/src/tools.ts` (register them; extend the READ_ONLY list)
- Test: `packages/mcp/src/slots.test.ts`

**Interfaces:**
- Consumes: `adapter.slots` / `adapter.bookSlot` (Task 6).
- Produces: `basket_list_delivery_slots({ store_id, start?, end? })` and `basket_book_delivery_slot({ store_id, slot_id })`.

**Design decision to carry into the code, not to re-litigate:** listing is read-only and belongs in the fast-mode allow-list. **Booking does not.** It spends no money, but it commits the shopper to a window a real van drives to, and `mcp-target`'s `checkout` tool is exactly the shape we refuse to ship. It goes behind the same human approval as a purchase, and a test asserts it is absent from the read-only list.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp/src/slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS } from "./tools.js";

describe("delivery slot tools", () => {
  it("listing slots is read-only; booking one is not", () => {
    expect(READ_ONLY_TOOLS).toContain("basket_list_delivery_slots");
    // Booking commits a delivery window. If this ever passes, fast-mode can
    // book a van without a human, which is the thing this project exists to
    // make impossible.
    expect(READ_ONLY_TOOLS).not.toContain("basket_book_delivery_slot");
  });
});
```

The list to assert against is **`NEVER_ALLOW` in `packages/mcp/src/policy.ts:27`** (currently `basket_cart_prepare`, `basket_purchase_confirm`, `basket_cancel_order`) — fast-mode skips confirmation for everything *not* on it. So the test is the other way round from the sketch above:

```ts
import { NEVER_ALLOW } from "./policy.js";
import { TOOL_NAMES } from "./tools.js";

it("listing slots is read-only; booking one can never be auto-approved", () => {
  expect(TOOL_NAMES).toContain("basket_list_delivery_slots");
  expect(NEVER_ALLOW).toContain("basket_book_delivery_slot");
});
```

`TOOL_NAMES` (`tools.ts:347`) is the wire-order list the install writers and the conformance test read; add the listing tool there. `NEVER_ALLOW` is the fast-mode blocklist; add the booking tool there.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/mcp/src/slots.test.ts`
Expected: FAIL — `basket_list_delivery_slots` is not in the list.

- [ ] **Step 3: Implement the tools**

Create `packages/mcp/src/tools-slots.ts` following the exact shape of the existing registrations in `tools.ts` (same `outputSchema`, same structured-plus-text mirroring, same annotations). Sketch:

```ts
server.registerTool(
  "basket_list_delivery_slots",
  {
    title: "List delivery slots",
    description:
      "Delivery windows a connected store can deliver in. Requires a connected account: " +
      "no retailer shows slots to a signed-out visitor. Slot ids are what basket_book_delivery_slot takes.",
    inputSchema: {
      store_id: z.string(),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    outputSchema: { slots: z.array(DeliverySlotSchema), store_id: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ store_id, start, end }) => { /* resolve adapter, default the range to today..+7d, call slots() */ },
);
```

`basket_book_delivery_slot` takes `{ store_id, slot_id }`, is annotated `readOnlyHint: false`, and routes through the same approval path `basket_purchase_confirm` uses. Read `packages/mcp/src/tools-purchase.ts` first and mirror it — do not invent a second approval mechanism.

- [ ] **Step 4: Run everything**

Run: `npx tsc --build && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Verify against the running server**

Run: `npm run smoke:mcp`
Expected: exit 0, and the new tools appear in the tool list with their annotations.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp
git commit -m "mcp: list delivery slots freely, book one only through a human"
```

---

## Phase 3 — capture the site's own JSON

### Task 8: `captureJson()` beside `renderPage()`

**Files:**
- Create: `packages/adapters/src/stealth/capture.ts`
- Test: `packages/adapters/src/stealth/capture.test.ts`

**Interfaces:**
- Consumes: the launch config in `stealth/browser.ts` — export `launchStealth()` from it rather than duplicating the flag lists.
- Produces: `captureJson<T>(pageUrl: string, opts: { match: string; settleMs?: number; timeoutMs?: number }): Promise<T>`.

**Why:** `shopee-mcp` proved the technique that beats a retailer we could not beat: stop forging the signed request and let the site's own app make it, then read the response. It returns structured JSON instead of HTML, which is strictly better input for an adapter than a DOM we have to guess at.

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/stealth/capture.test.ts`. It must not touch a retailer — serve the fixture locally:

```ts
import { describe, expect, it, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { captureJson } from "./capture.js";

/** A page that fetches its own JSON API, exactly like a retailer's app does. */
let server: Server;
const started = new Promise<string>((done) => {
  server = createServer((req, res) => {
    if (req.url?.includes("/api/v4/items")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ id: 1, name: "captured" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>store</title><script>fetch("/api/v4/items")</script>`);
  });
  server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`));
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

describe("captureJson", () => {
  it("returns the JSON the page fetched for itself", async () => {
    const url = await started;
    const out = await captureJson<{ items: Array<{ name: string }> }>(url, { match: "/api/v4/items" });
    expect(out.items[0]?.name).toBe("captured");
  }, 60_000);

  it("times out with a named error when the page never calls that API", async () => {
    const url = await started;
    await expect(
      captureJson(url, { match: "/api/v4/nothing-like-this", timeoutMs: 3_000 }),
    ).rejects.toThrow(/never called/i);
  }, 60_000);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/adapters/src/stealth/capture.test.ts`
Expected: FAIL — cannot resolve `./capture.js`.

- [ ] **Step 3: Implement it**

Create `packages/adapters/src/stealth/capture.ts`:

```ts
import { launchStealth } from "./browser.js";

/**
 * Load a page and return the JSON that page fetched for itself (S21).
 *
 * The technique is from bintangtimurlangit/shopee-mcp (MIT), and the reason
 * it exists is worth keeping: Shopee signs every API request with headers
 * (`af-ac-enc-dat`, `x-sap-sec`) that a hand-rolled fetch cannot produce, so
 * a request forged from outside is rejected no matter how good the
 * fingerprint is. Letting the retailer's own app make its own request
 * sidesteps the signature completely -- we are a reader of the response, not
 * a forger of the request.
 *
 * It is also simply better input than HTML: a captured `/api/v4/*` payload is
 * the same structured record the site's own UI renders from, so an adapter
 * built on it does not break the first time a class name changes.
 *
 * Same disclosure as `renderPage`: this is a signed-out public page, and this
 * function must never be pointed at an authenticated session.
 */
export async function captureJson<T>(
  pageUrl: string,
  opts: { match: string; settleMs?: number; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const browser = await launchStealth();
  try {
    const context = await browser.newContext({ colorScheme: "dark", deviceScaleFactor: 2 });
    const page = await context.newPage();

    let resolveHit: ((v: T) => void) | null = null;
    const hit = new Promise<T>((res) => { resolveHit = res; });

    page.on("response", (response) => {
      if (!response.url().includes(opts.match)) return;
      void response
        .json()
        .then((body) => resolveHit?.(body as T))
        // A matching URL that is not JSON is not our payload; keep listening.
        .catch(() => {});
    });

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

    const timer = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`${pageUrl} never called ${opts.match} within ${timeoutMs}ms.`)),
        timeoutMs,
      ),
    );
    return await Promise.race([hit, timer]);
  } finally {
    await browser.close();
  }
}
```

Extract `launchStealth()` out of `renderPage` in `browser.ts` and have `renderPage` call it too — one launch config, two consumers, no drift.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/adapters/src/stealth/capture.test.ts`
Expected: PASS, 2 tests. Slow (a real browser launches) — that is why the timeouts are 60s.

- [ ] **Step 5: Keep it out of the offline drill**

`scripts/drill-offline.mjs` excludes network-bound stores by id. This test launches a browser but never leaves `127.0.0.1`, so it stays in the suite; confirm with `npm run drill` that it still passes with the wire cut.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/stealth
git commit -m "stealth: capture the JSON a retailer's own app fetches, instead of parsing its HTML"
```

---

### Task 9: Target reads captured JSON, and falls back to HTML

**Files:**
- Modify: `packages/adapters/src/target/adapter.ts`
- Test: `packages/adapters/src/target/adapter.test.ts`

**Interfaces:**
- Consumes: `captureJson` (Task 8).
- Produces: no signature change — `search`/`detail` keep their contract; only how they get the bytes changes.

**Why:** Target's own frontend calls `redsky.target.com/redsky_aggregations/...`; capturing that gives priced, in-stock, structured records instead of scraped DOM. HTML stays as the fallback so a change on Target's side degrades rather than breaks.

- [ ] **Step 1: Write the failing test**

Add to `packages/adapters/src/target/adapter.test.ts` a test that injects a fake capture function returning a canned redsky payload and asserts the adapter produces the same normalised `Product[]` it produces from the HTML fixture. Make `captureJson` injectable exactly the way the existing tests inject `renderPage` — read that file first and follow its pattern; do not introduce a second injection style.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/adapters/src/target/adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement: capture first, HTML on throw**

```ts
    try {
      const json = await this.#capture<RedskySearch>(searchUrl, { match: "redsky_aggregations", settleMs: 1_500 });
      return this.#fromRedsky(json);
    } catch (err) {
      // Not a failure worth surfacing: Target changed something, or the page
      // served from cache without re-calling its API. The HTML path is the
      // one that has been verified live, so it stays the floor, not the roof.
      ctx.log(`target: capture missed (${(err as Error).message}) -- falling back to HTML`);
      return this.#fromHtml(await this.#render(searchUrl));
    }
```

- [ ] **Step 4: Run everything**

Run: `npx tsc --build && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Verify live, once**

Run: `npm run smoke:live`
Expected: Target search returns priced results and the log shows the capture path, not the fallback. If it shows the fallback, the `match` string is wrong — fix it before committing, because a fallback that always fires is a feature that does not exist.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/target
git commit -m "target: read the JSON the page fetches, keep HTML as the floor"
```

---

### Task 10: A real Shopee adapter

**Files:**
- Create: `packages/adapters/src/shopee/adapter.ts`, `packages/adapters/src/shopee/index.ts`
- Modify: `packages/adapters/src/index.ts`, `packages/mcp/src/runtime.ts` (register it)
- Modify: `README.md` ("Where the data comes from" — Shopee moves out of the blocked list)
- Test: `packages/adapters/src/shopee/adapter.test.ts`

**Interfaces:**
- Consumes: `captureJson` (Task 8).
- Produces: `class ShopeeAdapter implements StoreAdapter` with `manifest.id = "shp:shopee"`, capabilities `["discovery", "detail"]`.

**Why:** Our README currently records Shopee as the one retailer the stealth browser could not beat. Task 8 removes that reason. Turning a documented failure into a working store is the single most legible improvement in this plan.

- [ ] **Step 1: Write the failing test** — canned `/api/v4/search/search_items` payload in, normalised `Product[]` out, following the Amazon/IKEA adapter test pattern exactly.
- [ ] **Step 2: Run and watch it fail.** Run: `npx vitest run packages/adapters/src/shopee/adapter.test.ts`
- [ ] **Step 3: Implement.** Search page `https://shopee.sg/search?keyword=<q>` with `match: "/api/v4/search/search_items"`; detail `https://shopee.sg/product/<shopid>/<itemid>` with `match: "/api/v4/pdp/get_pc"`. Prices in Shopee's payload are integers scaled by 100,000 — divide, and put the arithmetic in one named function with a comment saying why. Treat `error === 90309999` as `SHOPEE_BLOCKED` and throw a typed error naming it, as `shopee-mcp` does.
- [ ] **Step 4: Run and watch it pass.**
- [ ] **Step 5: Verify live once.** Run: `npm run smoke:live`. If Shopee's gate still fires, **stop and report** rather than adding evasion — the constraint at the top of this plan is not negotiable, and a documented "still blocked" is an acceptable outcome.
- [ ] **Step 6: Update the README's provenance table** to match whatever actually happened, including "still blocked" if that is the truth.
- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/shopee packages/adapters/src/index.ts packages/mcp/src/runtime.ts README.md
git commit -m "shopee: a real adapter, via the JSON its own app fetches"
```

---

## Follow-on plans (scoped, not detailed here)

These are separate plans because each is independently shippable and each would double the length of this one. Written now so the order is decided rather than discovered.

**Plan B — sessions that renew themselves (from `costco-mcp`).** A `refresh` field on `SessionSecret` plus a per-store refresher invoked inside `authorizedFetch`'s closure when `expiresAt` is within a 120-second buffer. First consumer: a real Costco adapter against `ecom-api.costco.com`, whose Azure B2C refresh flow is the cleanest documented example. Depends on Phase 1. Biggest single win for demo reliability — every credential we hold today dies in hours.

**Plan C — the shopper's own history.** `basket_list_store_orders` / `basket_reorder`, reading the retailer's order history rather than only orders Basketed placed (Tesco `get_order_history` + favourites; Costco receipts; Target `get_orders`). Needs a `history` tier and a decision about how much of a stranger's purchase history should ever reach a model — that decision is the plan's first section, not an afterthought.

**Plan D — multi-account per store (from `costco-mcp`).** The vault is keyed by `store_id` alone; Costco's is keyed by account email. Changes a primary key and every route that assumes one credential per store. Worth doing only if a demo needs it.

---

## Self-review

**Spec coverage.** Every numbered source in the brief maps to at least one task: tesco-grocery-mcp → Tasks 2, 3, 4, 6, 7; costco-mcp → Task 2 (expiry) and Plan B (refresh); shopee-mcp → Tasks 8, 10; mcp-target → Task 9 (facts only, no code); Fewsats/amazon-mcp → no task, and the plan says why (nothing to build from, and no licence). The "search for more" instruction is discharged in "Also found", and two of the three found repos independently confirm the delivery-slots decision in Phase 2.

**Placeholders.** None. Three tasks (9, 10, and the `tools-slots.ts` body in Task 7) deliberately say "read the existing file and follow its pattern" rather than reproducing a fixture or a registration block verbatim — that is a pointer to real code in this repo, not a TBD, and the alternative is a copied block that drifts from its neighbours the day one of them changes.

**Type consistency.** `SessionSecret` is defined in Task 1 and consumed by name in Tasks 3 and 4. `ChromeLogin.capture` is defined in Task 3 and read in Task 3's own extension and script changes. `DeliverySlot`/`BookedSlot` are defined in Task 5 and consumed in Tasks 6 and 7. `captureJson` is defined in Task 8 with the exact signature Tasks 9 and 10 call. `expiryOf` returns **milliseconds** everywhere — Task 2 defines it, Task 3 stores it, Task 4 compares it against `Date.now()`.

**One risk named up front.** Tasks 6 and 10 write GraphQL/JSON shapes against APIs nobody documents. The tests are all against canned payloads, so a green suite does not prove Tesco answers that query. Both tasks therefore end with a live verification step, and neither may be marked done on unit tests alone.
