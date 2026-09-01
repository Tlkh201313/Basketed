import {
  approveApproval,
  rejectApproval,
  listOrders,
  listPendingApprovals,
  markOrderOutcome,
  loadGuardrails,
  saveGuardrails,
  GuardrailValueError,
  spentInWindow,
  type CartMandate,
} from "@basketed/commerce";
import { encodeSession, type CredentialKind } from "@basketed/vault";
import { authPolicyFor } from "./connections.js";
import { startLogin, captureLogin, cancelLogin, stateOf, statusOf } from "./browser-connect.js";
import { openConnect, pendingFor, closeConnect, finish, statusFor } from "./handoff.js";
import { expiryOf } from "./jwt.js";
import type { ControlDeps } from "./types.js";

/**
 * The panel's REST surface — approval channel A (§6).
 *
 * This is a SEPARATE channel from the MCP one, and that separation is most of
 * the security property -- but the route split is not what enforces it. Every
 * client Basketed installs into has a shell, so reaching these paths was never
 * beyond an agent. What is beyond it is the panel token these routes sit
 * behind, which is minted per process and printed on the server's own console.
 * See the gate in `./index.ts`.
 *
 * Same `approveApproval()` underneath, so the guarantees are identical wherever
 * the human clicked.
 */

export interface ApiResult {
  status: number;
  body: unknown;
}

/** A list of strings, or null if the caller sent something else. */
function asList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.some((v) => typeof v !== "string")) return null;
  return raw as string[];
}

function mandateOf(row: Record<string, unknown>): CartMandate | null {
  try {
    return JSON.parse(String(row["cart_json"])) as CartMandate;
  } catch {
    return null;
  }
}

/** Everything the approval card renders, built ONLY from the mandate. */
function approvalView(row: Record<string, unknown>, now: number) {
  const mandate = mandateOf(row);
  return {
    id: String(row["id"]),
    store_id: String(row["store_id"]),
    mode: mandate?.mode ?? "unknown",
    total: { value: Number(row["total_value"]), currency: String(row["total_currency"]) },
    // Numeric and enumerated fields plus the normalized product name. No
    // description, no review, no merchant message reaches this screen -- which
    // is what stops injected vendor text from steering an approval.
    line_items: (mandate?.lineItems ?? []).map((li) => ({
      name: li.name,
      quantity: li.quantity,
      unit_price: li.unitPrice,
    })),
    adjustments: (mandate?.adjustments ?? []).map((a) => ({ label: a.label, amount: a.amount })),
    subtotal: mandate?.subtotal ?? null,
    route_rung: mandate?.routeRung ?? null,
    account_handle: String(row["account_handle"]),
    expires_in_ms: Math.max(0, Number(row["expires_at"]) - now),
  };
}

/**
 * Turn a capture into the credential a store's adapter can actually use (S21).
 *
 * The rule that matters is the refusal: a store that named a header set and
 * did not get all of it is a 409, never a silent downgrade to the cookie jar.
 * Half a session looks like success here and fails at the first basket call,
 * somewhere with far less context than this route has.
 */
function sealableCredential(
  storeName: string,
  storeId: string,
  want: { match: string; headers: string[] } | undefined,
  got: { cookieHeader: string; headers: Record<string, string> },
): { ok: true; kind: CredentialKind; secret: string } | { ok: false; error: string } {
  if (want) {
    const headers: Record<string, string> = {};
    for (const name of want.headers) {
      const value = String(got.headers[name] ?? got.headers[name.toLowerCase()] ?? "").trim();
      if (value) headers[name.toLowerCase()] = value;
    }
    const missing = want.headers.filter((h) => !headers[h.toLowerCase()]);
    if (missing.length) {
      return {
        ok: false,
        error:
          `Signed in, but ${storeName} has not sent ${missing.join(" and ")} yet. ` +
          `Open your basket in that tab and this finishes by itself.`,
      };
    }
    const auth = headers["authorization"];
    const expiresAt = auth ? expiryOf(auth) : null;
    return {
      ok: true,
      kind: "session",
      secret: encodeSession({
        headers,
        ...(expiresAt === null ? {} : { expiresAt }),
        // Renewable without asking the human again: the browser they signed in
        // with is still signed in, so the session can simply be read afresh.
        // No refresh endpoint to guess at, and nothing to get wrong.
        refresh: { via: "browser", storeId },
      }),
    };
  }
  if (!got.cookieHeader) return { ok: false, error: `Not signed in at ${storeName} yet.` };
  return { ok: true, kind: "cookie", secret: got.cookieHeader };
}

export async function handleApi(
  deps: ControlDeps,
  method: string,
  path: string,
  body: () => Promise<Record<string, unknown>>,
): Promise<ApiResult | null> {
  const purchase = deps.purchase;
  const now = Date.now();
  const log = (msg: string): void => purchase.ctx.log(`panel: ${msg}`);

  if (method === "GET" && path === "/api/state") {
    const g = loadGuardrails(purchase.db);
    return {
      status: 200,
      body: {
        server: { name: "basketed", version: deps.version },
        stores: deps.registry.list().map((s) => ({
          id: s.id,
          name: s.name,
          country: s.country,
          currency: s.currency,
          mode: s.mode,
          status: s.status,
          capabilities: s.capabilities,
        })),
        summary: deps.summary,
        // Named plainly. A user reading the panel should never have to guess
        // whether the flag they set touches the purchase path.
        fast_mode: deps.policy.fastMode,
        fast_mode_scope: "read-only tools only — it is not reachable from the purchase path",
        tokens: deps.ledger.report(),
        guardrails: {
          ...g,
          spent_24h: Number(spentInWindow(purchase.db, 24 * 60 * 60 * 1000, now).toFixed(2)),
        },
        redaction_alarms: deps.redactionAlarms(),
      },
    };
  }

  if (method === "GET" && path === "/api/approvals") {
    const rows = listPendingApprovals(purchase.db, deps.principal, now);
    return { status: 200, body: { approvals: rows.map((r) => approvalView(r, now)), count: rows.length } };
  }

  const approve = /^\/api\/approvals\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approve) {
    const payload = await body();
    const result = approveApproval(purchase, decodeURIComponent(approve[1]!), deps.principal, {
      channel: "panel",
      typedTotal: String(payload["typed_total"] ?? ""),
    });
    return { status: result.ok ? 200 : 409, body: result };
  }

  const reject = /^\/api\/approvals\/([^/]+)\/reject$/.exec(path);
  if (method === "POST" && reject) {
    const result = rejectApproval(purchase, decodeURIComponent(reject[1]!), deps.principal);
    return { status: result.ok ? 200 : 409, body: result };
  }

  /*
   * Connections (S14).
   *
   * Everything served here is metadata: store, method, username, timestamps.
   * There is deliberately no route that returns a secret, not even to the
   * panel -- once a credential is in the vault the only thing that ever sees
   * it again is the request interceptor, inside the process.
   */
  if (method === "GET" && path === "/api/connections") {
    const held = new Map(deps.vault.list().map((c) => [c.storeId, c]));
    return {
      status: 200,
      body: {
        connections: deps.registry.list().map((s) => {
          const policy = authPolicyFor(s);
          const held_ = held.get(s.id) ?? null;
          return {
            store_id: s.id,
            name: s.name,
            mode: s.mode,
            country: s.country,
            currency: s.currency,
            methods: policy.methods,
            oauth: policy.oauth,
            reach: policy.reach,
            // An expired session is not a connection. Reporting it as one
            // moves the discovery to the checkout, where the retailer says it
            // instead of the panel -- see the vault's Connection.expired.
            connected: held_ !== null && !held_.broken && !held_.expired,
            broken: held_?.broken ?? false,
            expired: held_?.expired ?? false,
            expires_at: held_?.expiresAt ?? null,
            method: held_?.kind ?? null,
            username: held_?.username ?? null,
            connected_at: held_?.createdAt ?? null,
            last_used_at: held_?.lastUsedAt ?? null,
            chrome_login: policy.chromeLogin !== null,
            chrome_login_waiting: stateOf(s.id) !== "idle",
            chrome_login_logged_in: stateOf(s.id) === "logged_in",
          };
        }),
      },
    };
  }

  /*
   * The Chrome-login prototype (S15): a real Chrome window on the real site,
   * a human logging in themselves, and nothing captured until they say so.
   * Three routes, same shape as the rest of this file -- start, act, cancel.
   */
  const chromeStart = /^\/api\/connections\/([^/]+)\/chrome-login$/.exec(path);
  if (method === "POST" && chromeStart) {
    const storeId = decodeURIComponent(chromeStart[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    const policy = authPolicyFor(store);
    if (!policy.chromeLogin) {
      return { status: 400, body: { error: `Chrome login is not offered for ${store.name} in this build.` } };
    }
    const result = await startLogin(storeId, policy.chromeLogin);
    if (!result.ok) {
      log(`connect ${storeId} could not open a tab: ${result.error}`);
      return { status: 503, body: { error: result.error } };
    }
    log(
      `connect ${storeId}: tab opened at ${policy.chromeLogin.url}` +
        (result.attached ? " in the browser already running" : " in Basketed's Chrome profile") +
        (result.logged_in ? " (already signed in)" : ""),
    );
    return {
      status: 200,
      body: { ok: true, waiting: true, logged_in: result.logged_in, attached: result.attached },
    };
  }

  /*
   * Status for the open window (S18). The panel polls this so it can notice
   * the login finishing by itself. It reports a boolean and a clock and
   * nothing else -- no cookie names, no values, nothing that would turn a
   * status poll into a way to read the session.
   */
  const chromeStatus = /^\/api\/connections\/([^/]+)\/chrome-login$/.exec(path);
  if (method === "GET" && chromeStatus) {
    const storeId = decodeURIComponent(chromeStatus[1]!);
    return { status: 200, body: statusOf(storeId) };
  }

  const chromeCapture = /^\/api\/connections\/([^/]+)\/chrome-login\/capture$/.exec(path);
  if (method === "POST" && chromeCapture) {
    const storeId = decodeURIComponent(chromeCapture[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    const policy = authPolicyFor(store);
    if (!policy.chromeLogin) {
      return { status: 400, body: { error: `Chrome login is not offered for ${store.name} in this build.` } };
    }
    const captured = await captureLogin(storeId, policy.chromeLogin.domains);
    if (!captured.ok) {
      log(`connect ${storeId} capture failed: ${captured.error}`);
      return { status: 409, body: { error: captured.error } };
    }
    const sealable = sealableCredential(store.name, storeId, policy.chromeLogin.capture, captured);
    if (!sealable.ok) return { status: 409, body: { error: sealable.error } };
    const { kind, secret } = sealable;
    try {
      const saved = deps.vault.connect({ storeId, kind, username: null, secret });
      log(`connect ${storeId}: session captured and sealed as ${kind}`);
      return {
        status: 200,
        body: { ok: true, store_id: saved.storeId, method: saved.kind, connected_at: saved.createdAt },
      };
    } catch (err) {
      const reason = (err as Error).message;
      log(`connect ${storeId} could not be saved: ${reason}`);
      return { status: 503, body: { error: reason } };
    }
  }

  const chromeCancel = /^\/api\/connections\/([^/]+)\/chrome-login$/.exec(path);
  if (method === "DELETE" && chromeCancel) {
    const storeId = decodeURIComponent(chromeCancel[1]!);
    const closed = await cancelLogin(storeId);
    return { status: 200, body: { ok: true, closed } };
  }

  /*
   * Connect in the browser the user is already using (S20).
   *
   * The tab is NOT opened here. The panel is already a page in that browser,
   * so it opens the retailer with a plain target="_blank" link -- their
   * window, their profile, their logins, no automation involved. All this
   * route does is leave a note saying a sign-in is in flight, which the
   * Basketed extension (running in that same browser) reads so it can post
   * the finished session back. See handoff.ts for why it has to work this
   * way round.
   */
  const browserConnect = /^\/api\/connections\/([^/]+)\/browser-connect$/.exec(path);
  if (browserConnect) {
    const storeId = decodeURIComponent(browserConnect[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };

    if (method === "GET") return { status: 200, body: statusFor(storeId) };
    if (method === "DELETE") return { status: 200, body: { ok: true, closed: closeConnect(storeId) } };

    if (method === "POST") {
      const policy = authPolicyFor(store);
      if (!policy.chromeLogin) {
        return { status: 400, body: { error: `${store.name} needs no account: there is nothing to sign in to.` } };
      }
      const note = openConnect({
        storeId,
        storeName: store.name,
        url: policy.chromeLogin.url,
        domains: policy.chromeLogin.domains,
        authCookies: policy.chromeLogin.authCookies,
        capture: policy.chromeLogin.capture ?? null,
      });
      log(`connect ${storeId}: waiting on a sign-in at ${note.url}`);
      return { status: 200, body: { ok: true, url: note.url, waiting: true } };
    }
  }

  /*
   * How the extension proves the page that just messaged it is really the
   * panel (S20).
   *
   * The extension's content script runs on every 127.0.0.1 page, and
   * localhost is shared ground -- any local page could otherwise ask it to
   * hand over tesco.com's cookies. So the ask must carry the panel token,
   * and the extension checks it HERE before it reads a single cookie. Same
   * gate as everything else in this file; answering at all is the answer.
   */
  if (method === "GET" && path === "/api/extension/verify") {
    return { status: 200, body: { ok: true, panel: "basketed" } };
  }

  /*
   * The extension posting back a session it read from the user's own browser.
   *
   * Gated three ways: the panel token like every other route, a policy that
   * actually has somewhere to sign in, and an OPEN note for this store. The
   * last one matters -- without it, anything holding the token could seal an
   * arbitrary string against any store at any time, with no user action
   * anywhere near it.
   */
  const extCapture = /^\/api\/connections\/([^/]+)\/extension-capture$/.exec(path);
  if (method === "POST" && extCapture) {
    const storeId = decodeURIComponent(extCapture[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };
    const policy = authPolicyFor(store);
    if (!policy.chromeLogin) {
      return { status: 400, body: { error: `${store.name} needs no account: there is nothing to sign in to.` } };
    }
    const note = pendingFor(storeId);
    if (!note) {
      return { status: 409, body: { error: "No sign-in is in flight for this store. Press Connect first." } };
    }

    const payload = await body();
    const cookieHeader = String(payload["cookie_header"] ?? "").trim();
    const sent = (payload["headers"] ?? {}) as Record<string, string>;

    const sealable = sealableCredential(store.name, storeId, policy.chromeLogin.capture, {
      cookieHeader,
      headers: sent,
    });
    if (!sealable.ok) return { status: 409, body: { error: sealable.error } };
    const { kind, secret } = sealable;
    try {
      const saved = deps.vault.connect({ storeId, kind, username: null, secret });
      finish(storeId, "extension");
      closeConnect(storeId);
      log(`connect ${storeId}: sealed as ${kind}, captured from the user's own browser`);
      return {
        status: 200,
        body: { ok: true, store_id: saved.storeId, method: saved.kind, connected_at: saved.createdAt },
      };
    } catch (err) {
      const reason = (err as Error).message;
      log(`connect ${storeId} could not be saved: ${reason}`);
      return { status: 503, body: { error: reason } };
    }
  }

  const connect = /^\/api\/connections\/([^/]+)$/.exec(path);
  if (connect && (method === "POST" || method === "DELETE")) {
    const storeId = decodeURIComponent(connect[1]!);
    const store = deps.registry.list().find((s) => s.id === storeId);
    if (!store) return { status: 404, body: { error: `No such store: ${storeId}.` } };

    if (method === "DELETE") {
      const forgotten = deps.vault.forget(storeId);
      return { status: forgotten ? 200 : 404, body: { ok: forgotten, store_id: storeId } };
    }

    const policy = authPolicyFor(store);
    if (policy.methods.length === 0) {
      return { status: 400, body: { error: `${store.name} needs no account: its endpoint is anonymous.` } };
    }

    const payload = await body();
    const kind = String(payload["method"] ?? "") as CredentialKind;
    if (!policy.methods.includes(kind)) {
      return { status: 400, body: { error: `${store.name} accepts: ${policy.methods.join(", ")}.` } };
    }

    const secret = String(payload["secret"] ?? "");
    const username = payload["username"] === undefined ? null : String(payload["username"]);
    if (!secret.trim()) return { status: 400, body: { error: "Nothing was entered." } };

    try {
      const saved = deps.vault.connect({ storeId, kind, username, secret });
      log(`connected ${storeId} via ${kind}`);
      // Metadata back, never an echo of what was just sent.
      return {
        status: 200,
        body: {
          ok: true,
          store_id: saved.storeId,
          method: saved.kind,
          username: saved.username,
          connected_at: saved.createdAt,
        },
      };
    } catch (err) {
      // Covers both a bad master key (degradedVault always throws here) and
      // any crypto failure -- either way the human gets a reason, not a blank
      // 500, and it lands on stderr for whoever is debugging this machine.
      const reason = (err as Error).message;
      log(`connect ${storeId} failed: ${reason}`);
      return { status: 503, body: { error: reason } };
    }
  }

  if (method === "GET" && path === "/api/orders") {
    return { status: 200, body: { orders: listOrders(purchase.db, 50) } };
  }

  const outcome = /^\/api\/orders\/([^/]+)\/outcome$/.exec(path);
  if (method === "POST" && outcome) {
    const payload = await body();
    const want = String(payload["state"] ?? "");
    if (want !== "CONFIRMED" && want !== "CANCELLED") {
      return { status: 400, body: { error: "state must be CONFIRMED or CANCELLED." } };
    }
    // Only a human can move an order off HANDED_OFF. There is no MCP tool for
    // this, because the agent has no way to know what happened in the browser.
    const moved = markOrderOutcome(purchase.db, decodeURIComponent(outcome[1]!), want, now);
    return { status: moved ? 200 : 409, body: { ok: moved, state: moved ? want : undefined } };
  }

  if (method === "POST" && path === "/api/guardrails") {
    const payload = await body();
    const next: Record<string, unknown> = {};
    if (payload["home_currency"] !== undefined) next["homeCurrency"] = String(payload["home_currency"]);
    if (payload["per_order_cap"] !== undefined) next["perOrderCap"] = Number(payload["per_order_cap"]);
    if (payload["daily_cap"] !== undefined) next["dailyCap"] = Number(payload["daily_cap"]);

    /*
     * The two allowlists had no write route at all, so they could only ever
     * hold their default. An empty store allowlist means "any registered
     * store", which made the guardrail unreachable rather than merely unset --
     * while `evaluateGuardrails` checked it on every single confirm.
     *
     * Store ids are checked against the registry here rather than inside
     * `saveGuardrails`, which has no registry to check against. An allowlist
     * naming a store that does not exist is a typo that silently refuses
     * everything, and that is the failure this route must not ship.
     */
    if (payload["allowed_stores"] !== undefined) {
      const wanted = asList(payload["allowed_stores"]);
      if (!wanted) return { status: 400, body: { error: "allowed_stores must be a list of store ids." } };
      const known = new Set(deps.registry.list().map((s) => s.id));
      const unknown = wanted.filter((id) => !known.has(id));
      if (unknown.length) {
        return { status: 400, body: { error: `No such store: ${unknown.join(", ")}. Use the ids from /api/state.` } };
      }
      next["allowedStores"] = wanted;
    }

    // Nothing can put an address on a cart today -- there is no MCP tool for it
    // and the panel does not offer one -- so this list guards a field that is
    // always null. It is settable because the guardrail reading it is live, and
    // a dormant check with no way to arm it is worse than either alternative.
    if (payload["allowed_addresses"] !== undefined) {
      const wanted = asList(payload["allowed_addresses"]);
      if (!wanted) return { status: 400, body: { error: "allowed_addresses must be a list of address ids." } };
      next["allowedAddresses"] = wanted;
    }

    try {
      saveGuardrails(purchase.db, next);
    } catch (err) {
      // A refused write says why, in words the panel can show. `Number("abc")`
      // is NaN, and a NaN written here would read back as the DEFAULT cap --
      // the user would be running 250 while the panel showed what they typed.
      if (err instanceof GuardrailValueError) return { status: 400, body: { error: err.message } };
      throw err;
    }
    return { status: 200, body: loadGuardrails(purchase.db) };
  }

  return null;
}
