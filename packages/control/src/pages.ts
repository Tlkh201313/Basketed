import { CLIENTS, PRIMARY_CLIENTS, pathFor, snippetFor, type SnippetInput } from "./clients.js";
import { STYLE } from "./style.js";
import { SCRIPT } from "./script.js";

/**
 * The two pages the demo rests on (§8 S6): Home/Install and Approvals.
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

function shell(title: string, active: "home" | "approvals", main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Basketed</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="mark" href="/">basket<span>ed</span></a>
  <nav>
    <a href="/" class="${active === "home" ? "on" : ""}">Install</a>
    <a href="/approvals" class="${active === "approvals" ? "on" : ""}">Approvals</a>
  </nav>
</div></header>
<main class="wrap">${main}</main>
<script>${SCRIPT}</script>
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
<p class="tiny muted" style="margin:0">Streamable HTTP, bound to 127.0.0.1 only. stdio is the default for CLI agents.</p>
${copyBlock(input.endpoint)}

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
  );
}

/* -------------------------------------------------------------- approvals */

export function renderApprovals(): string {
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
  );
}
