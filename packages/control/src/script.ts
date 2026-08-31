/**
 * The panel's client-side script.
 *
 * Plain ES2022 against the same REST surface the tests hit. Shipped as a string
 * for the same reason the CSS is: no bundler, nothing to copy, nothing that can
 * silently fail to be there at runtime.
 */
export const SCRIPT = String.raw`
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

/*
 * Every /api call goes through here so none can be written without the token.
 * The cookie would usually carry it anyway, but the header is what makes the
 * requirement explicit at the call site -- a fetch that forgets it fails loudly
 * in development rather than silently relying on ambient credentials.
 */
const TOKEN = window.__BASKETED_TOKEN__ || "";

/*
 * Every call goes through here, and every call is logged to the console on
 * failure -- a 401 here means the token this tab loaded with is stale (the
 * server behind it restarted and printed a new one), and "why did my click
 * just do nothing" should have an answer in devtools, not silence.
 */
function api(path, init) {
  const opts = init || {};
  return fetch(path, Object.assign({}, opts, {
    headers: Object.assign({}, opts.headers || {}, { "x-basketed-token": TOKEN }),
  })).then((res) => {
    if (res.status === 401) {
      console.error("[basketed] 401 from " + path + " -- this tab's token is stale. Reload from the link the server just printed.");
    } else if (!res.ok) {
      console.error("[basketed] " + res.status + " from " + path);
    }
    return res;
  }).catch((err) => {
    console.error("[basketed] " + path + " did not reach the server: " + err.message);
    throw err;
  });
}

/*
 * theme: explicit choice beats OS, and persists per browser (S14).
 *
 * Three buttons rather than one cycling button, because "System theme" as the
 * label of a button that will next give you Dark told you the current state
 * and the next state with the same three words. The label element survives as
 * the screen-reader announcement of which of the three is live.
 */
(function () {
  const btns = $$("[data-theme-toggle]");
  if (!btns.length) return;
  const label = $("[data-theme-label]");
  function apply(mode) {
    if (mode) document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
    if (label) label.textContent = mode === "dark" ? "Dark" : mode === "light" ? "Light" : "System theme";
    btns.forEach((b) => {
      const on = (b.dataset.themeToggle || "auto") === (mode || "auto");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  let stored = null;
  try { stored = localStorage.getItem("basketed-theme"); } catch (e) { /* private window */ }
  apply(stored);
  btns.forEach((btn) => btn.addEventListener("click", function () {
    const next = btn.dataset.themeToggle === "auto" ? null : btn.dataset.themeToggle;
    stored = next;
    try { if (next) localStorage.setItem("basketed-theme", next); else localStorage.removeItem("basketed-theme"); } catch (e) { /* private window */ }
    apply(next);
  }));
})();

function money(m) {
  if (!m) return "";
  return m.value.toFixed(2) + " " + m.currency;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/*
 * The one element on the mandate card allowed to change colour, because it is
 * the only thing on it that is running out. Under a minute it turns clay.
 */
function countdown(ms) {
  if (ms <= 0) return '<span class="clock dead">expired</span>';
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return '<span class="clock' + (s < 60 ? " soon" : "") + '">' + mm + ":" + ss + " left</span>";
}
/* client rows open in place; the drawer is a sibling, not a child, of the row */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-expand]");
  if (!btn) return;
  const panel = btn.closest("[data-copy-scope]").querySelector("[data-exp]");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  btn.textContent = panel.hidden ? "Config" : "Hide";
  btn.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
});

/*
 * copy buttons, on every page.
 *
 * Scoped rather than sibling-based: on a client row the button is in the row
 * and the <code> it copies is in the drawer below, so walking up to the
 * enclosing [data-copy-scope] is what makes them the same thing.
 */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const scope = btn.closest("[data-copy-scope]") || btn.parentElement;
  const code = scope.querySelector("code");
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.textContent);
    const was = btn.textContent;
    btn.textContent = "Copied ✓";
    btn.classList.add("flash");
    setTimeout(() => { btn.textContent = was; btn.classList.remove("flash"); }, 1400);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
});

/* ------------------------------------------------------------- approvals */

const approvalsEl = $("#approvals");
if (approvalsEl) {
  let expected = new Map();

  /*
   * The mandate card is assembled from numeric and enumerated fields only,
   * plus the product name Basketed already normalised. Nothing a merchant
   * wrote reaches this markup, and nothing an agent wrote reaches it at all --
   * that is the whole point of the screen, so keep it that way when editing.
   */
  function card(a) {
    expected.set(a.id, a.total.value.toFixed(2));
    const lines = a.line_items
      .map((li) => '<tr><td><span class="q">' + esc(li.quantity) + ' &times;</span> ' + esc(li.name) +
        '</td><td>' + money(li.unit_price) + '</td></tr>')
      .join("");
    const adj = a.adjustments
      .map((x) => '<tr class="adj"><td>' + esc(x.label) + '</td><td>' +
        money(x.amount) + '</td></tr>')
      .join("");
    const stamp = a.mode === "simulated"
      ? '<span class="pill sim">demo order</span>'
      : '<span class="pill wait">awaiting you</span>';

    return '<div class="mandate" data-id="' + esc(a.id) + '">' +
      '<div class="mhead">' +
        '<span class="store">' + esc(a.store_id) + '</span>' +
        '<span class="ref">account <span class="num">' + esc(a.account_handle) + '</span></span>' +
        stamp +
        countdown(a.expires_in_ms) +
      '</div>' +
      '<table class="lines">' + lines + adj +
        '<tr class="sum"><td>Total</td><td>' + money(a.total) + '</td></tr>' +
      '</table>' +
      '<div class="strip" data-strip>' +
        '<span class="ask">Type <span class="num">' + a.total.value.toFixed(2) +
          '</span> to authorise</span>' +
        '<input class="typed" placeholder="' + a.total.value.toFixed(2) + '" data-total ' +
          'inputmode="decimal" autocomplete="off" aria-label="Type the total to authorise">' +
        '<button class="btn pri" data-approve disabled>Approve</button>' +
        '<button class="btn danger" data-reject>Reject</button>' +
        '<span class="why">Nothing has been charged. Typing the total is the authorisation.</span>' +
      '</div>' +
      '<div class="err" data-err style="padding:0 18px 12px"></div>' +
    '</div>';
  }

  async function refresh() {
    const res = await api("/api/approvals");
    const data = await res.json();
    approvalsEl.innerHTML = data.approvals.length
      ? data.approvals.map(card).join("")
      : '<div class="empty">Nothing waiting. Ask your agent to prepare a cart.</div>';

    const orders = await (await api("/api/orders")).json();
    $("#orders").innerHTML = orders.orders.length
      ? '<div class="orders">' + orders.orders.map(order).join("") + '</div>'
      : '<div class="empty">No orders yet.</div>';

    const state = await (await api("/api/state")).json();
    const g = state.guardrails;
    const alarms = state.redaction_alarms;
    $("#guardrails").innerHTML =
      tile("per order", g.perOrderCap.toFixed(2) + " " + g.homeCurrency) +
      tile("per 24h", g.dailyCap.toFixed(2) + " " + g.homeCurrency) +
      tile("used in 24h", g.spent_24h.toFixed(2) + " " + g.homeCurrency) +
      tile("allowed stores", g.allowedStores.length ? String(g.allowedStores.length) : "any") +
      // Zero is the only good number here, so zero is the only one shown in
      // green -- an alarm count styled like every other figure is a count
      // nobody reads.
      tile("redaction alarms", String(alarms), alarms > 0 ? "risk" : "good");
  }

  function tile(label, value, tone) {
    return '<div class="tile2"><span class="eyebrow">' + esc(label) + '</span>' +
      '<b' + (tone ? ' class="' + tone + '"' : "") + '>' + esc(value) + '</b></div>';
  }

  function order(o) {
    const handed = o.state === "HANDED_OFF";
    const cls = o.state === "PLACED" || o.state === "CONFIRMED" ? "ok"
      : handed ? "wait" : o.state === "FAILED" ? "bad" : "neutral";
    return '<div class="orow" data-order="' + esc(o.id) + '">' +
      '<div class="line">' +
        '<span class="store">' + esc(o.store_id) + '</span>' +
        '<span class="oid">' + esc(o.id) + '</span>' +
        '<span class="pill ' + cls + '">' + esc(o.state.toLowerCase().replace("_", " ")) + '</span>' +
        '<span class="amt">' + o.total_value.toFixed(2) + " " + esc(o.total_currency) + '</span>' +
      '</div>' +
      (o.handoff_url
        ? '<div class="line" style="margin-top:8px"><a href="' + esc(o.handoff_url) +
          '" target="_blank" rel="noreferrer">finish at the merchant &rarr;</a></div>'
        : "") +
      (handed
        ? '<p class="said">Handed off &mdash; outcome unknown. ' +
          'Basketed never took payment and has no way to know whether you completed it. ' +
          'Only you can say.</p>' +
          '<div class="line" style="margin-top:10px">' +
            '<button class="btn sm" data-outcome="CONFIRMED">I completed it</button>' +
            '<button class="btn sm danger" data-outcome="CANCELLED">I did not</button>' +
          '</div>'
        : "") +
    '</div>';
  }

  /* typing the total is the authorisation, so the button stays dead until it matches */
  approvalsEl.addEventListener("input", (e) => {
    const input = e.target.closest("[data-total]");
    if (!input) return;
    const card = input.closest("[data-id]");
    const want = expected.get(card.dataset.id);
    card.querySelector("[data-approve]").disabled =
      input.value.replace(/[^\d.]/g, "") !== want;
    // The border is a mirror of the line above, never a second opinion: it
    // reads the same disabled flag rather than re-deciding what "matches"
    // means.
    const matched = !card.querySelector("[data-approve]").disabled;
    input.classList.toggle("yes", matched);
    input.classList.toggle("no", !matched && input.value.length > 0);
  });

  approvalsEl.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const id = card.dataset.id;
    const errEl = card.querySelector("[data-err]");

    if (e.target.closest("[data-approve]")) {
      const typed = card.querySelector("[data-total]").value;
      const res = await api("/api/approvals/" + encodeURIComponent(id) + "/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typed_total: typed }),
      });
      const out = await res.json();
      if (!out.ok) { errEl.textContent = out.reason || "Refused."; return; }
      // Approved, not executed. The agent still has to call purchase_confirm,
      // and it will now succeed exactly once.
      errEl.textContent = "";
      card.querySelector("[data-strip]").innerHTML =
        '<span class="pill ok">approved</span>' +
        '<span class="ask">Tell your agent to confirm. Single-use.</span>';
      return;
    }

    if (e.target.closest("[data-reject]")) {
      await api("/api/approvals/" + encodeURIComponent(id) + "/reject", { method: "POST" });
      refresh();
    }
  });

  $("#orders").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-outcome]");
    if (!btn) return;
    const id = btn.closest("[data-order]").dataset.order;
    await api("/api/orders/" + encodeURIComponent(id) + "/outcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: btn.dataset.outcome }),
    });
    refresh();
  });

  refresh();
  // A five-minute TTL needs a visible clock, so the page re-reads rather than
  // letting a card sit there looking live after it has expired.
  setInterval(refresh, 5000);
}

/* ----------------------------------------------------------- connections */

const storesEl = $("#stores");
if (storesEl) {
  function pill(c) {
    if (c.chrome_login_logged_in) return '<span class="pill wait">signed in — finishing…</span>';
    if (c.chrome_login_waiting) return '<span class="pill off">signing in…</span>';
    if (c.broken) return '<span class="pill bad">reconnect needed</span>';
    if (c.connected) return '<span class="pill on">connected' + (c.username ? " as " + esc(c.username) : "") + '</span>';
    // A store with no account to sign in to is not "not connected" -- it is
    // finished. Saying otherwise reads as a step the reader still has to take.
    if (!c.methods || !c.methods.length) return '<span class="pill ok">ready</span>';
    return '<span class="pill off">not connected</span>';
  }

  async function refreshStatus() {
    let data;
    try {
      const res = await api("/api/connections");
      if (!res.ok) throw new Error("status " + res.status);
      data = await res.json();
    } catch (err) {
      console.error("[basketed] could not load connection status: " + err.message);
      storesEl.querySelectorAll("[data-status]").forEach((el) => {
        el.innerHTML = '<span class="pill bad">could not check</span>';
      });
      return;
    }
    const byId = new Map(data.connections.map((c) => [c.store_id, c]));
    storesEl.querySelectorAll("[data-store]").forEach((card) => {
      const c = byId.get(card.dataset.store);
      if (!c) return;
      const status = card.querySelector("[data-status]");
      if (status) status.innerHTML = pill(c);
      const disc = card.querySelector("[data-disconnect]");
      if (disc) disc.hidden = !c.connected && !c.broken;
    });
  }

  storesEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-disconnect]");
    if (!btn) return;
    const card = btn.closest("[data-store]");
    btn.disabled = true;
    try {
      const res = await api("/api/connections/" + encodeURIComponent(card.dataset.store), { method: "DELETE" });
      if (!res.ok) throw new Error("status " + res.status);
    } catch (err) {
      console.error("[basketed] disconnect failed: " + err.message);
    } finally {
      btn.disabled = false;
      refreshStatus();
    }
  });

  /* tabs and search are pure client-side filters over server-rendered cards */
  let activeTab = "all";
  const countEl = $("[data-count]");
  function applyFilter() {
    const q = ($("[data-find]").value || "").trim().toLowerCase();
    let shown = 0;
    storesEl.querySelectorAll("[data-store]").forEach((card) => {
      const matchesTab = activeTab === "all" || card.querySelector("[data-status] .pill.on, [data-status] .pill.bad");
      const matchesText = !q || card.dataset.name.indexOf(q) !== -1 || card.dataset.store.toLowerCase().indexOf(q) !== -1;
      const show = Boolean(matchesTab) && matchesText;
      card.hidden = !show;
      if (show) shown += 1;
    });
    $("#nostores").hidden = shown !== 0;
    if (countEl) countEl.textContent = shown;
  }
  $$("[data-tab]").forEach((btn) => btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    $$("[data-tab]").forEach((b) => b.classList.toggle("on", b === btn));
    applyFilter();
  }));
  $("[data-find]").addEventListener("input", applyFilter);

  /* the mono "/" in the search box is a promise, so make it true */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    $("[data-find]").focus();
  });

  refreshStatus().then(applyFilter);
  setInterval(() => refreshStatus().then(applyFilter), 8000);
}

/*
 * The connect page (S19). One button, no fields.
 *
 * Everything the old form did -- pick a method, type a secret, post it here --
 * is gone: the only way to connect a store is now to sign in at the store, in
 * a real browser tab, on the retailer's own page. This script decides when to
 * open that tab and when the sign-in has finished; it never handles a
 * credential, because there is no longer one on this page to handle.
 */
/* ------------------------------------------------- connecting a store (S20)
 *
 * The tab is opened by the browser, not by us: every Connect control is a
 * real <a target="_blank">, so the click lands in THIS browser window, with
 * the logins already in it. Nothing here launches anything.
 *
 * Reading the session back out of that tab is the half Chrome will not let an
 * outside program do -- since Chrome 136 the remote-debugging port is ignored
 * on the default profile, deliberately, so that no process can lift another
 * profile's cookies. The sanctioned way in is from the inside, so the
 * Basketed extension does that part and this code asks it. No extension, no
 * capture: the card says so and offers the Basketed-window route, instead of
 * spinning forever pretending.
 */
function extensionPresent() {
  return document.documentElement.getAttribute("data-basketed-extension") === "1";
}

/*
 * One round trip to the extension. The token goes with it because the
 * extension refuses to read a cookie for a local page that cannot prove it is
 * the panel -- localhost is shared ground, and "a page on 127.0.0.1" is not
 * an identity.
 */
function askExtension(cfg) {
  return new Promise((resolve) => {
    if (!extensionPresent()) { resolve(null); return; }
    const id = "bk" + Math.random().toString(36).slice(2);
    let timer = null;
    function onReply(e) {
      const d = e.data;
      if (e.source !== window || !d || d.source !== "basketed-extension" || d.id !== id) return;
      window.removeEventListener("message", onReply);
      clearTimeout(timer);
      resolve(d.reply || null);
    }
    window.addEventListener("message", onReply);
    timer = setTimeout(() => { window.removeEventListener("message", onReply); resolve(null); }, 4000);
    window.postMessage({
      source: "basketed-panel",
      type: "capture",
      id: id,
      token: TOKEN,
      domains: cfg.domains,
      authCookies: cfg.authCookies,
      bearerMatch: cfg.bearerMatch,
    }, window.location.origin);
  });
}

function connectConfig(el) {
  function parse(raw) { try { return JSON.parse(raw || "[]"); } catch (err) { return []; } }
  return {
    storeId: el.dataset.store,
    name: el.dataset.name || el.dataset.store,
    domains: parse(el.dataset.domains),
    authCookies: parse(el.dataset.authCookies),
    bearerMatch: el.dataset.bearer || "",
    loginUrl: el.dataset.loginUrl || "",
  };
}

/* One attempt: ask the extension, and seal whatever it found. */
async function tryCapture(cfg) {
  const reply = await askExtension(cfg);
  if (!reply) return { state: "no-extension" };
  if (!reply.ok) return { state: "no-extension", error: reply.error };
  if (!reply.signedIn) return { state: "signed-out" };
  let res;
  try {
    res = await api("/api/connections/" + encodeURIComponent(cfg.storeId) + "/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: reply.cookieHeader, bearer: reply.bearer }),
    });
  } catch (err) {
    return { state: "waiting", error: "Could not reach the server." };
  }
  if (res.ok) return { state: "connected" };
  const out = await res.json().catch(() => ({}));
  // 409 is "signed in, but the credential is not there yet" -- keep waiting.
  return { state: res.status === 409 ? "waiting" : "failed", error: out.error };
}

const pumps = new Map();

function stopPump(storeId) {
  const t = pumps.get(storeId);
  if (t) { clearInterval(t); pumps.delete(storeId); }
}

/* The connect card, when we are on the store's own page. Absent on the list. */
const connectPage = $("[data-connect-page]");
const idleRow = $("[data-connect-idle]");
const waitingRow = $("[data-connect-waiting]");
const statusEl = $("[data-connect-status]");
const signinLink = $("[data-connect-signin]");
const extMissing = $("[data-ext-missing]");

function say(text) { if (statusEl) statusEl.textContent = text; }

function showWaiting() {
  if (idleRow) idleRow.hidden = true;
  if (waitingRow) waitingRow.hidden = false;
}
function showIdle() {
  if (idleRow) idleRow.hidden = false;
  if (waitingRow) waitingRow.hidden = true;
  if (signinLink) signinLink.hidden = true;
}

function watchConnect(cfg) {
  stopPump(cfg.storeId);
  showWaiting();
  say("Waiting for " + cfg.name + " in the other tab...");

  async function tick() {
    const out = await tryCapture(cfg);
    if (out.state === "connected") {
      stopPump(cfg.storeId);
      say("Connected. Reading this page again...");
      setTimeout(() => location.reload(), 900);
      return;
    }
    if (out.state === "no-extension") {
      stopPump(cfg.storeId);
      if (extMissing) extMissing.hidden = false;
      say("The tab is open. Basketed cannot read it back without the extension.");
      return;
    }
    if (out.state === "signed-out") {
      say("Not signed in at " + cfg.name + " yet - sign in in that tab and this finishes itself.");
      if (signinLink) signinLink.hidden = false;
      return;
    }
    if (out.state === "failed") {
      stopPump(cfg.storeId);
      say(out.error || "That did not work.");
      return;
    }
    if (out.error) say(out.error);
  }

  void tick();
  pumps.set(cfg.storeId, setInterval(tick, 2500));
}

/*
 * Delegated, so one handler serves the store page and every card on the list.
 * The click's own navigation opens the tab; this only registers that a
 * sign-in is in flight and starts watching for it to finish.
 */
document.addEventListener("click", (e) => {
  const el = e.target.closest ? e.target.closest("[data-connect-open]") : null;
  if (!el) return;
  const cfg = connectConfig(el);
  api("/api/connections/" + encodeURIComponent(cfg.storeId) + "/browser-connect", { method: "POST" })
    .catch((err) => console.error("[basketed] connect could not be registered: " + err.message));
  watchConnect(cfg);
});

const cancelWait = $("[data-connect-cancel]");
if (cancelWait) {
  cancelWait.addEventListener("click", async () => {
    const el = $("[data-connect-open]");
    const storeId = el ? el.dataset.store : null;
    if (storeId) {
      stopPump(storeId);
      try {
        await api("/api/connections/" + encodeURIComponent(storeId) + "/browser-connect", { method: "DELETE" });
      } catch (err) {
        console.error("[basketed] could not stop waiting: " + err.message);
      }
    }
    showIdle();
  });
}

/*
 * The fallback for a browser with no extension in it: a window Basketed does
 * drive, on its own persistent profile. Sign in once there and it stays
 * signed in. Same capture route, same vault, same disclosure -- only the
 * window differs.
 */
if (connectPage) {
  const storeId = connectPage.dataset.store;
  const chromeWaitRow = $("[data-chrome-login-waiting]");
  const chromeMsg = $("[data-chrome-msg]");
  const captureBtn = $("[data-chrome-capture]");
  const startBtn = $("[data-chrome-start]");
  let watch = null;
  let capturing = false;

  function stopWatch() { if (watch) { clearInterval(watch); watch = null; } }

  function watchForLogin() {
    stopWatch();
    watch = setInterval(async () => {
      if (capturing) return;
      try {
        const res = await api("/api/connections/" + encodeURIComponent(storeId) + "/chrome-login");
        if (!res.ok) return;
        const out = await res.json();
        if (out.state === "idle") { stopWatch(); return; }
        if (out.logged_in) { stopWatch(); await runCapture(); }
      } catch (err) {
        console.error("[basketed] sign-in status failed: " + err.message);
      }
    }, 1500);
  }

  async function runCapture() {
    if (capturing) return;
    capturing = true;
    if (captureBtn) captureBtn.disabled = true;
    if (chromeMsg) chromeMsg.textContent = "Signed in. Finishing...";
    try {
      const res = await api("/api/connections/" + encodeURIComponent(storeId) + "/chrome-login/capture", { method: "POST" });
      const out = await res.json();
      if (!res.ok) {
        if (chromeMsg) chromeMsg.textContent = out.error || ("Refused (" + res.status + ").");
        watchForLogin();
        return;
      }
      stopWatch();
      if (chromeMsg) chromeMsg.textContent = "Connected. Reading this page again...";
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      console.error("[basketed] capture failed: " + err.message);
      if (chromeMsg) chromeMsg.textContent = "Could not reach the server.";
    } finally {
      capturing = false;
      if (captureBtn) captureBtn.disabled = false;
    }
  }

  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      if (chromeWaitRow) chromeWaitRow.hidden = false;
      if (chromeMsg) chromeMsg.textContent = "Opening a Basketed window...";
      try {
        const res = await api("/api/connections/" + encodeURIComponent(storeId) + "/chrome-login", { method: "POST" });
        const out = await res.json();
        if (!res.ok) {
          if (chromeMsg) chromeMsg.textContent = out.error || ("Refused (" + res.status + ").");
          return;
        }
        if (out.logged_in) {
          if (chromeMsg) chromeMsg.textContent = "That profile is already signed in. Finishing...";
          await runCapture();
        } else {
          if (chromeMsg) chromeMsg.textContent = "A Basketed window is open. Sign in there - this page notices when you are done.";
          watchForLogin();
        }
      } catch (err) {
        console.error("[basketed] could not open the window: " + err.message);
        if (chromeMsg) chromeMsg.textContent = "Could not reach the server.";
      } finally {
        startBtn.disabled = false;
      }
    });
  }

  if (captureBtn) captureBtn.addEventListener("click", () => void runCapture());

  const cancelBtn = $("[data-chrome-cancel]");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      stopWatch();
      try {
        await api("/api/connections/" + encodeURIComponent(storeId) + "/chrome-login", { method: "DELETE" });
      } catch (err) {
        console.error("[basketed] cancel failed: " + err.message);
      } finally {
        cancelBtn.disabled = false;
        if (chromeWaitRow) chromeWaitRow.hidden = true;
      }
    });
  }

  // A window left open by an earlier visit is still live on the server.
  if (chromeWaitRow && !chromeWaitRow.hidden) watchForLogin();
}


/* Disconnect, from the store's own page. Outside the block above because a
 * store can hold a credential after its policy stopped offering a way to add
 * one -- and a held credential must always have a way out. */
const forgetBtn = $("[data-connect-forget]");
if (forgetBtn) {
  forgetBtn.addEventListener("click", async () => {
    forgetBtn.disabled = true;
    try {
      const res = await api("/api/connections/" + encodeURIComponent(forgetBtn.dataset.store), { method: "DELETE" });
      if (!res.ok) throw new Error("status " + res.status);
      location.reload();
    } catch (err) {
      console.error("[basketed] disconnect failed: " + err.message);
      forgetBtn.disabled = false;
    }
  });
}
`;
