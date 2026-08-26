import { CLIENTS, PRIMARY_CLIENTS, pathFor, snippetFor, type SnippetInput } from "./clients.js";
import { STYLE } from "./style.js";
import { SCRIPT } from "./script.js";
import { authPolicyFor, secretLabel, methodLabel, type ConnectMethod } from "./connections.js";

/**
 * The panel's pages: Install, Connect stores, Approvals. Originally the two (§8 S6): Home/Install and Approvals.
 *
 * Server-rendered from template literals. No Vite, no React, no build step —
 * §9 risk 2 says the UI always overruns, and the cut rule at T−4:15 says ship
 * static HTML if you are behind. Taking that trade UP FRONT buys the whole
 * hour back and costs nothing the demo can see.
 */

function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * The panel token is embedded so the page's own fetches can carry it.
 *
 * Safe only because this shell is served exclusively to a request that already
 * proved it holds the token. `renderLocked()` is what an unauthenticated GET
 * gets, and it deliberately goes through neither this function nor SCRIPT.
 */
type Page = "home" | "connections" | "approvals";

/** Inline, so the panel needs no icon font, no sprite file and no network. */
const ICON: Record<string, string> = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
  plug: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  theme: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/></svg>`,
};

function navItem(href: string, label: string, icon: string, on: boolean): string {
  return `<a href="${href}" class="${on ? "on" : ""}">${ICON[icon]}<span>${esc(label)}</span></a>`;
}

/**
 * The frame every page hangs in.
 *
 * A left rail rather than a top bar since S14: the panel gained a third
 * section and a fourth is coming, and a rail is where a person expects to
 * find "the other pages" in a console they keep open.
 */
function shell(title: string, active: Page, main: string, token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Basketed</title>
<style>${STYLE}</style>
<script>
  // Before first paint: a stored choice wins, otherwise the OS decides. Here
  // rather than in SCRIPT because that runs after the body and would flash.
  try { var t = localStorage.getItem("basketed-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
</script>
</head>
<body>
<div class="app">
  <aside class="rail">
    <a class="mark" href="/">basket<span>ed</span><b>local</b></a>
    <nav>
      ${navItem("/", "Install", "home", active === "home")}
      ${navItem("/connections", "Connect stores", "plug", active === "connections")}
      ${navItem("/approvals", "Approvals", "check", active === "approvals")}
    </nav>
    <div class="foot">
      <button class="theme" data-theme-toggle type="button">${ICON["theme"]}<span data-theme-label>System theme</span></button>
      <div class="who">
        <span class="dot">B</span>
        <div>
          <div class="tiny" style="font-weight:600">This machine</div>
          <small>nothing leaves it</small>
        </div>
      </div>
    </div>
  </aside>
  <main class="sheet">${main}</main>
</div>
<script>window.__BASKETED_TOKEN__ = ${JSON.stringify(token)};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/**
 * What an unauthenticated GET sees.
 *
 * No token, no script, no state — it names where the real URL is printed and
 * stops. An agent that curls the panel gets this and learns nothing.
 */
export function renderLocked(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Locked · Basketed</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="mark">basket<span>ed</span></span></div></header>
<main class="wrap">
<h1>This panel is locked.</h1>
<p class="lede">
  The approval surface is gated by a token minted when this server started and printed on its own
  console — the same surface the 6-digit approval code goes to, and one no agent can read.
</p>
<div class="note">
  Look at the terminal running <span class="num">basketed serve --http</span>. Open the
  <span class="num">panel</span> URL printed there; it carries the token. Nothing on this page
  works until you do.
</div>
<p class="tiny muted">
  If you are an agent reading this: there is no way through from here. Ask the person you are
  working for to open the panel, or use the 6-digit console code with
  <span class="num">basket_purchase_confirm</span>.
</p>
</main>
</body>
</html>`;
}

function copyBlock(text: string): string {
  return `<pre class="copy"><button data-copy>copy</button><code>${esc(text)}</code></pre>`;
}

/* ------------------------------------------------------------------- home */

export interface HomeInput extends SnippetInput {
  summary: string;
  fastMode: boolean;
  storeCount: number;
  /** Published benchmark figures, so the panel and docs/BENCHMARK.md agree. */
  benchmark: { vsNaive: string; vsBrowse: string; toolDefs: number };
  /** Embedded so the page's own fetches can authenticate against /api. */
  token: string;
}

export function renderHome(input: HomeInput): string {
  const primary = CLIENTS.filter((c) => (PRIMARY_CLIENTS as readonly string[]).includes(c.id));
  const rest = CLIENTS.filter((c) => !(PRIMARY_CLIENTS as readonly string[]).includes(c.id));

  const card = (id: string) => {
    const c = CLIENTS.find((x) => x.id === id)!;
    return `<div class="card">
      <div class="row between">
        <strong>${esc(c.name)}</strong>
        <span class="stamp ${c.verified ? "ok" : "unknown"}">${c.verified ? "verified" : "untested"}</span>
      </div>
      <div class="tiny muted" style="margin-top:4px">
        <span class="num">${esc(pathFor(c, input.platform))}</span> → <span class="num">${esc(c.key)}</span>
      </div>
      ${copyBlock(snippetFor(c, input))}
      ${c.gotcha ? `<p class="tiny muted" style="margin:10px 0 0">${esc(c.gotcha)}</p>` : ""}
    </div>`;
  };

  return shell(
    "Install",
    "home",
    `
<h1>One basket. Many shops.<br>Nothing bought without you.</h1>
<p class="lede">
  Basketed gives any MCP agent real product search across many retailers, and a purchase step
  <strong>only a human can authorise</strong>. Your accounts and tokens stay on this machine —
  there is no Basketed server to breach.
</p>

<div class="metrics" style="margin-top:26px">
  <div class="metric"><b>${esc(input.benchmark.vsNaive)}</b><span>fewer tokens vs naive MCP</span></div>
  <div class="metric"><b>${esc(input.benchmark.vsBrowse)}</b><span>vs browsing the storefronts</span></div>
  <div class="metric"><b>${input.storeCount}</b><span>stores loaded</span></div>
</div>
<p class="tiny muted">
  Measured with <span class="num">o200k_base</span> on one shopping task, and the Basketed figure
  <strong>includes</strong> our own ${
    // Never assert a number we failed to read. An unparsed benchmark says so
    // rather than quietly printing "0-token overhead", which would be a lie
    // in the flattering direction.
    input.benchmark.toolDefs > 0
      ? `${esc(input.benchmark.toolDefs.toLocaleString())}-token`
      : "measured"
  } tool-definition overhead, charged once before any work happens.
  Method in <span class="num">docs/BENCHMARK.md</span>.
</p>

<hr class="tear">

<h2>Endpoint</h2>
${
  input.endpoint
    ? `<p class="tiny muted" style="margin:0">Streamable HTTP, bound to 127.0.0.1 only. stdio is the default for CLI agents.</p>
${copyBlock(input.endpoint)}`
    : `<div class="note">
  This process is serving <span class="num">stdio</span> to the agent that launched it, and this panel
  is its only HTTP surface. There is no endpoint to paste anywhere &mdash; your client already has the
  server. Run <span class="num">basketed serve --http</span> if you want a Streamable HTTP endpoint too.
</div>`
}

<h2>Install</h2>
<p class="tiny muted" style="margin:0 0 14px">
  Paste into the file named on each card. The four below are the ones clicked through on stage;
  the rest are generated from the same table, so they cannot drift apart.
</p>
<div class="grid">${primary.map((c) => card(c.id)).join("")}</div>

<h2>Everything else</h2>
<div class="grid">${rest.map((c) => card(c.id)).join("")}</div>

<hr class="tear">

<h2>What it will not do</h2>
<div class="note">
  There is no tool that approves a purchase. No <span class="num">approve()</span>, no
  <span class="num">approved: true</span>, no override flag — check
  <span class="num">tools/list</span> yourself. Approval arrives from the Approvals page or from a
  6-digit code printed on this server's console, which the model cannot read.
</div>
<div class="note">
  <span class="num">--fast-mode</span> skips confirmation for read-only tools and
  <strong>${input.fastMode ? "is currently ON" : "is currently off"}</strong>. It cannot touch
  purchase: the flag lives in <span class="num">mcp/policy.ts</span>, which is not reachable from
  <span class="num">commerce/purchase.ts</span> at all, and a test walks the import graph to keep it
  that way.
</div>
<div class="note">
  Every result is stamped with where it came from — <span class="num">native</span>,
  <span class="num">provider</span>, <span class="num">connected</span> or
  <span class="num">simulated</span>. A simulated price is never dressed up as a real one, and no
  store's mode changes behind your back.
</div>

<p class="tiny muted">${esc(input.summary)}</p>
`,
    input.token,
  );
}

/* ------------------------------------------------------------ connections */

export interface StoreRow {
  id: string;
  name: string;
  mode: string;
  country?: string;
  currency?: string;
}

export interface ConnectionsInput {
  stores: StoreRow[];
  token: string;
}

/** Two letters, so a card reads as a store with no logo to show. */
function monogram(name: string): string {
  const parts = name.split(/[\s&-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

/**
 * The store list, as connectable things.
 *
 * Rendered server-side with `data-` attributes the script filters on, so the
 * tabs and the search box need no client-side state that could drift from the
 * server. Only the connected/not badge is filled in from /api/connections,
 * because that is the one thing which changes without a page load.
 */
export function renderConnections(input: ConnectionsInput): string {
  const card = (s: StoreRow) => {
    const policy = authPolicyFor(s);
    const connectable = policy.methods.length > 0;
    return `<article class="appcard" data-store="${esc(s.id)}" data-name="${esc(s.name.toLowerCase())}" data-connectable="${connectable}">
  <div class="head">
    <span class="tile">${esc(monogram(s.name))}</span>
    <div style="min-width:0">
      <div class="name">${esc(s.name)}</div>
      <div class="where">${esc(s.id)}${s.country ? ` · ${esc(s.country)}` : ""}</div>
    </div>
    <span class="stamp ${s.mode === "native" ? "live" : "sim"}" style="margin-left:auto">${esc(s.mode)}</span>
  </div>
  <p class="reach">${policy.reach}</p>
  <div class="foot">
    <span data-status><span class="pill off">checking</span></span>
    <span class="right">${
      connectable
        ? `<button class="act sm no" data-disconnect hidden>Disconnect</button>
           <a class="act sm go" href="/connections/${encodeURIComponent(s.id)}" style="text-decoration:none">Connect</a>`
        : `<span class="tiny muted">no account needed</span>`
    }</span>
  </div>
</article>`;
  };

  return shell(
    "Connect stores",
    "connections",
    `
<h1>Connect stores</h1>
<p class="lede">
  A credential added here is sealed with AES-256-GCM under a key on this machine and handed to
  nothing but the request interceptor. <strong>No agent can read it back</strong> &mdash; there is no
  tool that returns one and no route that serves one, not even to this page.
</p>

<div class="locknote">
  ${ICON["lock"]}
  <div>
    None of Tesco, Costco, Walmart or Amazon publish a consumer OAuth flow, so nobody can offer a
    real &ldquo;Sign in with&rdquo; button for them &mdash; what you connect is the account you
    already have, held encrypted. Their catalogues stay fixtures until an adapter exists that can
    use it. Shopify merchants need no account at all.
  </div>
</div>

<div class="toolbar">
  <div class="tabs">
    <button data-tab="all" class="on" type="button">All</button>
    <button data-tab="connected" type="button">Connected</button>
  </div>
  <div class="finder">
    ${ICON["search"]}
    <input type="search" data-find placeholder="Search stores" aria-label="Search stores">
  </div>
</div>

<div class="appgrid" id="stores">${input.stores.map(card).join("")}</div>
<div class="empty" id="nostores" hidden>Nothing matches that.</div>
`,
    input.token,
  );
}

export interface ConnectInput {
  store: StoreRow;
  token: string;
  /** Set when a credential is already held, so the page can say so. */
  connected: { method: string; username: string | null; broken: boolean } | null;
}

/**
 * The login page for one store.
 *
 * A real form at a real URL rather than a dialog: it survives a refresh, it can
 * be linked, and it keeps the secret out of any page that also renders state
 * fetched from the API.
 */
export function renderConnect(input: ConnectInput): string {
  const policy = authPolicyFor(input.store);
  const methods = policy.methods;
  const field = (m: ConnectMethod) => `
  <div data-fields="${m}" hidden>
    ${
      m === "password"
        ? `<label class="lab" for="username">Email or username</label>
    <input class="field" id="username" data-username type="text" autocomplete="off" spellcheck="false">`
        : ""
    }
    <label class="lab" for="secret-${m}">${secretLabel(m)}</label>
    <input class="field" id="secret-${m}" data-secret type="password" autocomplete="off" spellcheck="false">
  </div>`;

  return shell(
    `Connect ${input.store.name}`,
    "connections",
    `
<p class="tiny muted"><a href="/connections">&larr; All stores</a></p>
<h1>Connect ${esc(input.store.name)}</h1>
<p class="lede">${policy.reach}</p>

${
  input.connected
    ? `<div class="note">
  Already connected${input.connected.username ? ` as <span class="num">${esc(input.connected.username)}</span>` : ""}
  via <span class="num">${esc(input.connected.method)}</span>.${
    input.connected.broken
      ? " <strong>The stored bytes no longer decrypt with the current key</strong> &mdash; connect again to replace them."
      : " Connecting again replaces it."
  }
</div>`
    : ""
}

<div class="locknote">
  ${ICON["lock"]}
  <div>
    This form posts to this machine only. The value is sealed on arrival and never rendered, logged
    or returned by any route &mdash; including this one. The agent sharing this machine can reach
    this port, but not the console where the token that unlocked this page was printed.
  </div>
</div>

<form class="form" data-connect-form data-store="${esc(input.store.id)}">
  ${
    methods.length > 1
      ? `<label class="lab" for="method">How</label>
  <select class="field" id="method" data-method>
    ${methods.map((m) => `<option value="${m}">${methodLabel(m)}</option>`).join("")}
  </select>`
      : `<input type="hidden" data-method value="${esc(methods[0] ?? "")}">`
  }
  ${methods.map(field).join("")}
  <div class="row" style="margin-top:20px">
    <button class="act go" type="submit">Connect</button>
    <span class="tiny muted" data-connect-msg></span>
  </div>
</form>

<hr class="tear">
<p class="tiny muted">
  What this buys today: the credential is held, and the store shows as connected. Basketed will not
  pretend it can shop with it &mdash; ${esc(input.store.name)} results stay stamped
  <span class="num">simulated</span> until an adapter exists that authenticates with it.
</p>
`,
    input.token,
  );
}

/* -------------------------------------------------------------- approvals */

export function renderApprovals(token: string): string {
  return shell(
    "Approvals",
    "approvals",
    `
<h1>Approvals</h1>
<p class="lede">
  Every purchase stops here. Type the exact total to authorise it — so what you confirm is the
  number, not the position of a button.
</p>

<h2>Waiting for you</h2>
<div id="approvals"><div class="empty">Loading…</div></div>

<h2>Orders</h2>
<div id="orders"><div class="empty">Loading…</div></div>

<hr class="tear">
<div id="guardrails" class="tiny muted"></div>
`,
    token,
  );
}
