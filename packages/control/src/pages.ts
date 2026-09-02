import { CLIENTS, PRIMARY_CLIENTS, pathFor, snippetFor, type SnippetInput } from "./clients.js";
import { panelBase } from "./base.js";
import { STYLE } from "./style.js";
import { SCRIPT } from "./script.js";
import { authPolicyFor, methodLabel, type ConnectMethod, type StoreAuthPolicy } from "./connections.js";

/**
 * The panel's pages: Install, Connect stores, Approvals — originally just the
 * first and last (§8 S6), joined by Connect stores in S14.
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

/**
 * The mark: a `--pri` square holding a serif lowercase b.
 *
 * It replaces the gradient spark, which had the wrong job. A logo that glows
 * competes with the countdown and the typed-total field on the approvals
 * screen, and those are the two things on this panel that genuinely need to
 * catch an eye.
 */
function markup(link: string | null): string {
  const inner = `<span class="glyph" aria-hidden="true">b</span><span>basketed</span><span class="chip">local</span>`;
  return link !== null
    ? `<a class="mark" href="${link}/">${inner}</a>`
    : `<span class="mark">${inner}</span>`;
}

/** Inline, so the panel needs no icon font, no sprite file and no network. */
const ICON: Record<string, string> = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
  plug: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>`,
};

function navItem(href: string, label: string, icon: string, on: boolean): string {
  return `<a href="${href}" class="${on ? "on" : ""}">${ICON[icon]}<span>${esc(label)}</span></a>`;
}

/**
 * The frame every page hangs in.
 *
 * A left rail rather than a top bar since S14: the panel gained a third
 * section and a fourth is coming, and a rail is where a person expects to
 * find "the other pages" in a console they keep open. The 57px bar above the
 * sheet carries the page's name and its one line of live context, so the
 * headline underneath is free to be a sentence rather than a label.
 */
function shell(
  title: string,
  active: Page,
  main: string,
  token: string,
  bar = "",
  sheet = active === "home" ? "install" : active === "approvals" ? "appr" : "stores",
): string {
  // Every in-panel link is prefixed so that navigation after the first load
  // rides the path-scoped cookie instead of needing `?t=` in every href.
  const base = panelBase(token);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
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
    ${markup(base)}
    <nav>
      ${navItem(`${base}/`, "Install", "home", active === "home")}
      ${navItem(`${base}/connections`, "Connect stores", "plug", active === "connections")}
      ${navItem(`${base}/approvals`, "Approvals", "check", active === "approvals")}
    </nav>
    <div class="foot">
      <div class="themeseg" role="group" aria-label="Theme">
        <button type="button" data-theme-toggle="auto">Auto</button>
        <button type="button" data-theme-toggle="dark">Dark</button>
        <button type="button" data-theme-toggle="light">Light</button>
      </div>
      <span class="sr" data-theme-label>System theme</span>
      <div class="who">
        <span class="avatar" aria-hidden="true">B</span>
        <div>
          <b>This machine</b>
          <small>nothing leaves it</small>
        </div>
      </div>
    </div>
  </aside>
  <div class="pane">
    <header class="topbar">
      <span class="title">${esc(title)}</span>
      ${bar}
    </header>
    <main class="sheet ${sheet}">${main}</main>
  </div>
</div>
<script>window.__BASKETED_TOKEN__ = ${JSON.stringify(token)};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** A mono section heading: label, hairline, optional right-hand meta. */
function h2(label: string, meta = ""): string {
  return `<h2>${esc(label)}<i></i>${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</h2>`;
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
<meta name="color-scheme" content="light dark">
<title>Locked · Basketed</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
<aside class="rail">${markup(null)}</aside>
<div class="pane">
<main class="sheet lock">
<span class="pill neutral">locked</span>
<h1>This panel is locked.</h1>
<p class="lede">
  The approval surface is gated by a token minted when this server started and printed on its own
  console — the same surface the 6-digit approval code goes to, and one no agent can read.
</p>
<div class="sage" style="margin-top:24px">
  <span class="eyebrow">how to get in</span>
  <p>
    Look at the terminal running <span class="num">basketed serve --http</span>. Open the
    <strong>panel</strong> URL printed there; it carries the token. Nothing on this page works
    until you do.
  </p>
</div>
<div class="claim" style="margin-top:14px">
  <span class="eyebrow">if you are an agent</span>
  <p>
    There is no way through from here. Ask the person you are working for to open the panel, or use
    the 6-digit console code with <span class="num">basket_purchase_confirm</span>.
  </p>
</div>
<div class="pagefoot"><span>Basketed</span><span>local-only</span><span>token-gated</span></div>
</main>
</div>
</div>
</body>
</html>`;
}

/**
 * A copy button and the thing it copies, in one scope.
 *
 * The script walks up to `[data-copy-scope]` and takes the `<code>` inside, so
 * the button does not have to be the code block's sibling -- which it is not
 * on a client row, where the button sits in the row and the snippet sits in
 * the drawer below it.
 */
function copyBlock(text: string): string {
  return `<div data-copy-scope>
  <pre class="code"><code>${esc(text)}</code></pre>
  <div class="row" style="margin-top:10px"><button class="btn sm" type="button" data-copy>Copy</button></div>
</div>`;
}

/**
 * The read-only / money-adjacent split, for display only.
 *
 * Deliberately a literal rather than an import from the server package: this
 * is the panel's promise about the tool surface, and the honest way to keep it
 * true is `tools/list`, which the copy below tells you to go and read. A wrong
 * label here is a documentation bug; a wrong label derived from an import
 * would look authoritative while being just as wrong.
 */
const TOOL_SURFACE: { safe: [string, string][]; money: [string, string][] } = {
  safe: [
    ["basket_list_stores", "which stores are loaded, and in what mode"],
    ["basket_search_products", "search across every loaded store at once"],
    ["basket_get_product_detail", "one product, normalised"],
    ["basket_list_orders", "orders this machine has recorded"],
    ["basket_get_order_status", "where one order got to"],
    ["basket_get_token_report", "what the last call cost, in tokens"],
  ],
  money: [
    ["basket_cart_prepare", "builds a cart and stops — this is what opens an approval"],
    ["basket_purchase_confirm", "spends money, and only after you approved this exact cart"],
  ],
};

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

/** ANALYSE → PURCHASE → RECEIVE: the only step that spends money is filled. */
const PIPELINE = ["Analyse", "Extract", "Respond", "Purchase", "Receive"];

export function renderHome(input: HomeInput): string {
  const primary = CLIENTS.filter((c) => (PRIMARY_CLIENTS as readonly string[]).includes(c.id));
  const rest = CLIENTS.filter((c) => !(PRIMARY_CLIENTS as readonly string[]).includes(c.id));

  /**
   * One client, as a row that opens in place.
   *
   * Thirteen cards was thirteen boxes to scan for the one file path you cared
   * about. A row puts the name, the path and the config key on one line, and
   * keeps the snippet folded away until you ask for it.
   */
  const row = (c: (typeof CLIENTS)[number], n: number) => `<div class="citem" data-copy-scope>
  <div class="crow">
    <span class="n">${String(n).padStart(2, "0")}</span>
    <span class="nm">${esc(c.name)}</span>
    <span class="path">${esc(pathFor(c, input.platform))}</span>
    <span class="key">${esc(c.key)}</span>
    <span class="pill ${c.verified ? "ok" : "neutral"}">${c.verified ? "verified" : "untested"}</span>
    <button class="btn sm" type="button" data-expand>Config</button>
    <button class="btn sm pri" type="button" data-copy>Copy</button>
  </div>
  <div class="cexp" data-exp hidden>
    <pre class="code"><code>${esc(snippetFor(c, input))}</code></pre>
    ${c.gotcha ? `<p class="gotcha"><span class="tag">gotcha</span><span>${esc(c.gotcha)}</span></p>` : ""}
  </div>
</div>`;

  const toolRows = (rows: [string, string][]) =>
    rows.map(([t, d]) => `<div class="trow"><span class="t">${esc(t)}</span><span class="d">${esc(d)}</span></div>`).join("");

  return shell(
    "Install",
    "home",
    `
<div class="hero">
  <div>
    <h1>One basket. Many shops.<br>Nothing bought without you.</h1>
    <p class="lede">
      Basketed gives any MCP agent real product search across many retailers, and a purchase step
      <strong>only a human can authorise</strong>. Your accounts and tokens stay on this machine —
      there is no Basketed server to breach.
    </p>
    <div class="chips">
      ${PIPELINE.map((s) => `<span class="chip${s === "Purchase" ? " on" : ""}">${esc(s)}</span>`).join("")}
    </div>
  </div>

  <div class="hair">
    <div class="stat"><b>${esc(input.benchmark.vsNaive)}</b><span>fewer tokens vs naive MCP</span></div>
    <div class="stat"><b>${esc(input.benchmark.vsBrowse)}</b><span>fewer than browsing the storefronts</span></div>
    <div class="stat"><b>${input.storeCount}</b><span>stores loaded on this machine</span></div>
    <div class="statfoot">
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
    </div>
  </div>
</div>

${h2("Endpoint", input.endpoint ? "streamable http" : "stdio")}
${
  input.endpoint
    ? `<div class="card endpoint" data-copy-scope style="padding:14px 18px">
  <code class="url">${esc(input.endpoint)}</code>
  <span class="note">Bound to 127.0.0.1 only. stdio is the default for CLI agents.</span>
  <button class="btn sm" type="button" data-copy>Copy</button>
</div>`
    : `<div class="sage">
  <span class="eyebrow">stdio</span>
  <p>
    This process is serving <strong>stdio</strong> to the agent that launched it, and this panel
    is its only HTTP surface. There is no endpoint to paste anywhere &mdash; your client already has
    the server. Run <span class="num">basketed serve --http</span> if you want a Streamable HTTP
    endpoint too.
  </p>
</div>`
}

${h2("Install", `${primary.length} verified`)}
<p class="small" style="margin:0 0 14px">
  Paste into the file named on each row. The ${primary.length} below are the ones clicked through on
  stage; the rest are generated from the same table, so they cannot drift apart.
</p>
<div class="clients">${primary.map((c, i) => row(c, i + 1)).join("")}</div>

${h2("Everything else", `${rest.length} more`)}
<div class="clients">${rest.map((c, i) => row(c, primary.length + i + 1)).join("")}</div>

${h2("Tool surface", `${TOOL_SURFACE.safe.length + TOOL_SURFACE.money.length} tools`)}
<div class="tools">
  <div class="toolcard">
    <div class="cap">
      <span class="pill ok">read only</span>
      <span class="what">Answer questions. Never move money.</span>
    </div>
    ${toolRows(TOOL_SURFACE.safe)}
  </div>
  <div class="toolcard money">
    <div class="cap">
      <span class="pill wait">money adjacent</span>
      <span class="what">Declared <code>destructiveHint: true</code>, and gated.</span>
    </div>
    ${toolRows(TOOL_SURFACE.money)}
  </div>
</div>

${h2("What it will not do")}
<div class="claims">
  <div class="claim">
    <span class="eyebrow">no approve tool</span>
    <p>
      There is no tool that approves a purchase. No <span class="num">approve()</span>, no
      <span class="num">approved: true</span>, no override flag — check
      <span class="num">tools/list</span> yourself. Approval arrives from the Approvals page or from a
      6-digit code printed on this server's console, which the model cannot read.
    </p>
  </div>
  <div class="claim">
    <span class="eyebrow">fast mode ${input.fastMode ? "on" : "off"}</span>
    <p>
      <span class="num">--fast-mode</span> skips confirmation for read-only tools and
      <strong>${input.fastMode ? "is currently ON" : "is currently off"}</strong>. It cannot touch
      purchase: the flag lives in <span class="num">mcp/policy.ts</span>, which is not reachable from
      <span class="num">commerce/purchase.ts</span> at all, and a test walks the import graph to keep
      it that way.
    </p>
  </div>
  <div class="claim">
    <span class="eyebrow">provenance</span>
    <p>
      Every result carries where it came from &mdash; a retailer's own API, a connected account, or
      this build's demo catalogue. A demo price is never dressed up as a live one, and no store's
      source changes behind your back.
    </p>
  </div>
</div>

<div class="pagefoot">
  <span>Basketed control panel</span><span>local-only</span><span>token-gated</span>
  <span>${esc(input.summary)}</span>
</div>
`,
    input.token,
    `<span class="meta">${esc(input.summary)}</span>`,
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

/**
 * Two letters, and deliberately not a logo.
 *
 * Showing a retailer's favicon would mean this page fetching from that
 * retailer on every load — which is exactly the off-machine request the rest
 * of Basketed exists to avoid, and it would tell 21 companies that this
 * machine is running it. The monogram tile is the design, not a fallback.
 */
function monogram(name: string): string {
  const parts = name.split(/[\s&-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

/**
 * The card gets the first sentence of a store's reach; the store's own page
 * gets all of it.
 *
 * Derived here rather than in connections.ts, which stays the single source of
 * the full text — a view that needs a shorter version is the view's problem.
 */
function firstSentence(text: string): string {
  const stop = text.indexOf(". ");
  if (stop > 0 && stop < 150) return text.slice(0, stop + 1);
  return text.length > 152 ? `${text.slice(0, 152).trimEnd()}…` : text;
}

/**
 * What the mode actually means, in the reader's words.
 *
 * `native` and `simulated` are the registry's vocabulary and stay the
 * registry's vocabulary — they are the values adapters register under and the
 * values `/api` reports. They are just poor labels for a human: "simulated"
 * reads as *sandboxed*, as though a switch somewhere would make it live, and
 * "native" says nothing at all about where the numbers came from. The card
 * says which of the two you are looking at, in the terms a shopper would use.
 */
function modeLabel(mode: string): string {
  return mode === "native" ? "live data" : "sample data";
}

/**
 * Brands carried by more than one source (S18).
 *
 * Amazon, Tesco and IKEA each appear twice in the registry, and the reason is
 * real: one row is the retailer's own live data, the other is a fixture set
 * the offline drill depends on. They are genuinely different stores with
 * different capabilities, so they cannot be collapsed into one row without
 * claiming a union of capabilities neither one has — the exact overclaim
 * `StoreRegistry.register` throws on.
 *
 * What they CAN stop doing is appearing twice with no explanation. This pairs
 * them up so each card can name its twin, and so the sort can seat them next
 * to each other. Keyed on the display name, which is what a reader matches
 * on; the ids differ by design.
 */
function twinsByBrand(stores: StoreRow[]): Map<string, StoreRow> {
  const byBrand = new Map<string, StoreRow[]>();
  for (const s of stores) {
    const key = s.name.trim().toLowerCase();
    byBrand.set(key, [...(byBrand.get(key) ?? []), s]);
  }
  const twin = new Map<string, StoreRow>();
  for (const group of byBrand.values()) {
    if (group.length !== 2) continue;
    const live = group.find((s) => s.mode === "native");
    const sample = group.find((s) => s.mode !== "native");
    if (!live || !sample) continue;
    twin.set(live.id, sample);
    twin.set(sample.id, live);
  }
  return twin;
}

/**
 * The store list, as connectable things.
 *
 * Rendered server-side with `data-` attributes the script filters on, so the
 * tabs and the search box need no client-side state that could drift from the
 * server. Only the connected/not badge is filled in from /api/connections,
 * because that is the one thing which changes without a page load.
 *
 * One card per store, always — the Connected filter and the disconnect button
 * both key off a single `[data-store]` element, and a card standing for two
 * stores could not answer "is this connected?" with one badge.
 */
/**
 * The control that starts a connection (S20).
 *
 * A real anchor with `target="_blank"`, not a button that calls
 * `window.open` — because the click is then the browser's own navigation, in
 * the browser the panel is already running in. That is what makes the tab
 * appear in the user's actual window, with their actual logins, instead of a
 * second Chrome: no automation is involved in opening it at all. It also
 * means no popup blocker ever eats it, which a scripted open after an
 * `await` reliably would.
 *
 * The `data-` attributes carry an identity and a destination, and nothing
 * more. They used to carry the cookie policy too — which domains to open,
 * which names mean "signed in" — but a page is the wrong place to state that:
 * the extension now asks the panel it is pinned to instead, so no markup here
 * can widen what gets read.
 */
function connectAnchor(store: StoreRow, policy: StoreAuthPolicy, label: string, cls: string): string {
  const login = policy.chromeLogin;
  if (!login) return "";
  return `<a class="${cls}" href="${esc(login.url)}" target="_blank" rel="noopener noreferrer"
     data-connect-open data-store="${esc(store.id)}" data-name="${esc(store.name)}"
     data-login-url="${esc(login.loginUrl)}">${esc(label)}</a>`;
}

export function renderConnections(input: ConnectionsInput): string {
  const twin = twinsByBrand(input.stores);
  const base = panelBase(input.token);

  const card = (s: StoreRow) => {
    const policy = authPolicyFor(s);
    const connectable = policy.methods.length > 0;
    const other = twin.get(s.id);
    const live = s.mode === "native";
    return `<article class="appcard" data-store="${esc(s.id)}" data-name="${esc(s.name.toLowerCase())}" data-connectable="${connectable}">
  <div class="head">
    <span class="tile" aria-hidden="true">${esc(monogram(s.name))}</span>
    <div style="min-width:0">
      <div class="name"><a href="${base}/connections/${encodeURIComponent(s.id)}">${esc(s.name)}</a></div>
      <div class="where">${esc(s.id)}${s.country ? ` · ${esc(s.country)}` : ""}</div>
    </div>
    <span class="pill ${live ? "ok" : "sim"}" style="margin-left:auto">${esc(modeLabel(s.mode))}</span>
  </div>
  <p class="reach">${esc(firstSentence(policy.reach))}</p>
  ${
    other
      ? `<p class="twin">${
          live
            ? `Also listed as <a href="${base}/connections/${encodeURIComponent(other.id)}">${esc(other.id)}</a>, the demo copy the offline drill runs on. This is the live one.`
            : `The real ${esc(s.name)} is <a href="${base}/connections/${encodeURIComponent(other.id)}">${esc(other.id)}</a>. This row is demo data, kept so the demo works with the wifi off.`
        }</p>`
      : ""
  }
  <div class="foot">
    <span data-status><span class="pill off">checking</span></span>
    <span class="right">${
      connectable
        ? `<button class="btn sm danger" type="button" data-disconnect hidden>Disconnect</button>
           ${connectAnchor(s, policy, "Connect", "btn sm pri")}`
        : `<span class="none">no account needed</span>`
    }</span>
  </div>
</article>`;
  };

  // Twins adjacent, real source first, so the pair reads as a pair.
  const ordered = [...input.stores].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    if (a.mode === b.mode) return a.id.localeCompare(b.id);
    return a.mode === "native" ? -1 : 1;
  });

  const n = input.stores.length;

  return shell(
    "Connect stores",
    "connections",
    `
<h1>Connect stores</h1>
<p class="lede">
  Connect opens the store's own site in a browser tab and you sign in there. <strong>Basketed never
  asks you for a password</strong> &mdash; there is no field on this page that takes one. What comes
  back is sealed with AES-256-GCM under a key on this machine and handed to nothing but the request
  interceptor, and <strong>no agent can read it back</strong>.
</p>

<div class="sage" style="margin-top:22px">
  <span class="eyebrow">how connecting works</span>
  <p>
    None of these retailers publish a consumer OAuth flow, so nobody can offer a real
    <strong>Sign in with</strong> button for them. The next best thing is the real thing: a tab opens
    on the retailer's own page, at their own URL. Already signed in there? It finishes on its own.
    Not signed in? Sign in on their page and it finishes the moment you are through. Stores marked
    <em>no account needed</em> work signed-out and have nothing to connect.
  </p>
</div>

${h2("Stores", twin.size ? `${twin.size / 2} carried by two sources` : "")}
<div class="appgrid" id="stores">${ordered.map(card).join("")}</div>
<div class="empty" id="nostores" hidden>Nothing matches that.</div>
`,
    input.token,
    `<span class="meta"><span data-count>${n}</span> of ${n}</span>
    <div class="right">
      <div class="seg" role="group" aria-label="Filter stores">
        <button data-tab="all" class="on" type="button">All</button>
        <button data-tab="connected" type="button">Connected</button>
      </div>
      <div class="finder">
        <span class="slash" aria-hidden="true">/</span>
        <input type="search" data-find placeholder="Search stores" aria-label="Search stores">
      </div>
    </div>`,
  );
}

export interface ConnectInput {
  store: StoreRow;
  token: string;
  /** Set when a credential is already held, so the page can say so. */
  connected: { method: string; username: string | null; broken: boolean } | null;
  /** True if a Chrome login window is already open for this store (S15). */
  chromeWaiting: boolean;
  /** Which browser the login will open in, so the card can say so up front (S18). */
  chrome: { attached: boolean; where: string };
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
  const login = policy.chromeLogin;
  const store = esc(input.store.name);
  const held = input.connected;

  /*
   * Which browser the tab will open in, said before the click rather than
   * after the surprise. Attached is the good case and reads like it: their
   * own browser, their own logins, usually no sign-in at all.
   */
  const browserNote = input.chrome.attached
    ? `Opens a <strong>new tab in the browser you already have running</strong> &mdash; with the accounts
       you are already signed into. Basketed closes only that tab afterwards, never your browser.`
    : `Opens Chrome on a profile Basketed keeps in <span class="num">~/.basketed/chrome-profile</span>.
       Not a blank throwaway: <strong>you sign in once</strong> and it stays signed in next time. To use
       the browser you already have open instead, start Chrome with
       <span class="num">--remote-debugging-port=9222</span> and press Connect again &mdash; Basketed
       finds it by itself.`;

  const connectBlock = login
    ? `
<div class="two" data-connect-page data-store="${esc(input.store.id)}">
  <div class="card">
    <span class="eyebrow">sign in at ${store}</span>
    <p class="small" style="margin:8px 0 0">
      Connect opens ${store} in <strong>a new tab of this browser</strong> &mdash; the one you are
      reading this in, with the accounts you are already signed into. Nothing is launched and nothing
      is automated: it is a link. If you are already signed in at ${store}, the connection finishes on
      its own; if you are not, sign in on their page and it finishes the moment you are through.
      Basketed never asks you for a password and has no field to type one into.
    </p>
    <div class="row" style="margin-top:20px" data-connect-idle>
      ${connectAnchor(input.store, policy, held ? `Reconnect ${input.store.name}` : `Connect ${input.store.name}`, "btn pri")}
      <span class="small" data-connect-msg></span>
    </div>
    <div class="row" style="margin-top:20px" data-connect-waiting hidden>
      <span class="small" data-connect-status>Waiting for ${store} in the other tab&hellip;</span>
      <a class="btn sm" href="${esc(login.loginUrl)}" target="_blank" rel="noopener noreferrer" data-connect-signin hidden>Sign in at ${store}</a>
      <button class="btn sm danger" type="button" data-connect-cancel>Stop waiting</button>
    </div>

    <div class="claim" style="margin-top:18px" data-ext-missing hidden>
      <span class="eyebrow">to finish it automatically</span>
      <p>
        Chrome does not let an outside program read this browser's session &mdash;
        <a href="https://developer.chrome.com/blog/remote-debugging-port" target="_blank" rel="noopener noreferrer">since
        Chrome 136</a> that is blocked on purpose, and it is a good rule. The way in is from the
        inside: load <span class="num">packages/extension</span> once at
        <span class="num">chrome://extensions</span> &rarr; Developer mode &rarr; Load unpacked, and
        the connection completes by itself in this browser. It answers one address only, pinned to
        <span class="num">http://127.0.0.1:8787</span> &mdash; if this panel is on another port, paste
        this page's origin into the extension's options once. Without it, use the window below instead.
      </p>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" type="button" data-chrome-start>Sign in in a Basketed window</button>
      </div>
    </div>
    <div class="row" style="margin-top:16px" data-chrome-login-waiting hidden>
      <button class="btn sm pri" type="button" data-chrome-capture>Finish now</button>
      <button class="btn sm danger" type="button" data-chrome-cancel>Cancel</button>
      <span class="small" data-chrome-msg>A Basketed window is open. Sign in there &mdash; this page notices when you are done.</span>
    </div>
    <div hidden data-chrome-login-idle></div>
  </div>

  <div class="stack">
    <div class="sage">
      <span class="eyebrow">where the session goes</span>
      <p>
        The Basketed extension reads the session <strong>in this browser</strong>, where Chrome
        allows it, and hands it straight to this page. It talks to
        <span class="num">127.0.0.1</span> and nothing else, and it will not answer a local page that
        cannot prove it holds this panel's token. What arrives is sealed with AES-256-GCM under a key
        on this machine and handed to nothing but the request interceptor &mdash;
        <strong>no agent can read it back</strong>.
      </p>
    </div>
    <div class="risk">
      <span class="eyebrow">at your own risk</span>
      <p>
        You sign in on ${store}'s own page, the same as always &mdash; nothing about the login itself
        is automated. What IS automation is Basketed reading the session back afterwards, and that is
        real automated access to a site whose Terms of Service does not permit it, including for most
        of these retailers when the account owner is the one running it. Heavy use can get an account
        flagged.
      </p>
    </div>
  </div>
</div>`
    : `
<div class="sage" style="margin-top:20px">
  <span class="eyebrow">nothing to connect</span>
  <p>${store} works signed-out: everything this store returns is what any visitor sees, so there is no
  account to attach and no credential to hold.</p>
</div>`;

  return shell(
    `Connect ${input.store.name}`,
    "connections",
    `
<p class="small" style="margin:0 0 14px"><a href="${panelBase(input.token)}/connections">&larr; All stores</a></p>
<div class="row" style="margin-bottom:14px">
  <span class="tile" aria-hidden="true">${esc(monogram(input.store.name))}</span>
  <span class="pill ${input.store.mode === "native" ? "ok" : "sim"}">${esc(modeLabel(input.store.mode))}</span>
  ${
    held
      ? `<span class="pill ${held.broken ? "bad" : "on"}">${held.broken ? "reconnect needed" : "connected"}</span>`
      : login
        ? `<span class="pill off">not connected</span>`
        : `<span class="pill ok">ready</span>`
  }
</div>
<h1>Connect ${store}</h1>
<p class="lede" style="max-width:78ch">${esc(policy.reach)}</p>

${
  held
    ? `<div class="sage" style="margin-top:20px">
  <span class="eyebrow">already connected</span>
  <p>
    Held${held.username ? ` as <strong>${esc(held.username)}</strong>` : ""}
    as a <span class="num">${esc(methodLabel(held.method as ConnectMethod))}</span>.${
      held.broken
        ? " <strong>The stored bytes no longer decrypt with the current key</strong> &mdash; connect again to replace them."
        : " Connecting again replaces it."
    }
  </p>
  <div class="row" style="margin-top:14px">
    <button class="btn sm danger" type="button" data-connect-forget data-store="${esc(input.store.id)}">Disconnect</button>
  </div>
</div>`
    : ""
}

${connectBlock}
`,
    input.token,
    `<span class="meta">${esc(input.store.id)}</span>`,
    "store",
  );
}

/* -------------------------------------------------------------- approvals */

export function renderApprovals(token: string): string {
  return shell(
    "Approvals",
    "approvals",
    `
<h1>Every purchase stops here.</h1>
<p class="lede">
  Type the exact total to authorise it — so what you confirm is the number, not the position of a
  button. Nothing on this page is filled in by the agent that asked: every field below is a figure
  Basketed computed, or a name it normalised.
</p>

${h2("Waiting for you", "refreshes every 5s")}
<div id="approvals"><div class="empty">Loading…</div></div>

${h2("Orders")}
<div id="orders"><div class="empty">Loading…</div></div>

${h2("Guardrails", "checked at confirm, never at prepare")}
<div id="guardrails" class="hair rails"></div>
`,
    token,
  );
}
