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
 * Every repeating timer on the page, in one list.
 *
 * Four sections start intervals and none of them stopped. On a page left open
 * for a working day that is four callbacks still firing against a document
 * nobody is looking at -- polling, re-rendering, and holding the whole closure
 * alive. "pagehide" rather than "unload", because "unload" is the one event
 * that is not guaranteed to fire and is what disqualifies a page from the
 * back/forward cache in the first place.
 */
const timers = [];
function every(fn, ms) {
  const id = setInterval(fn, ms);
  timers.push(id);
  return id;
}
window.addEventListener("pagehide", () => {
  for (const id of timers) clearInterval(id);
  timers.length = 0;
});

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
        // Wrapped and stamped with an absolute deadline so tickClocks can keep
        // it moving WITHOUT re-rendering the card -- see refresh().
        '<span data-clock data-deadline="' + (Date.now() + a.expires_in_ms) + '">' +
          countdown(a.expires_in_ms) +
        '</span>' +
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

  /* The last payload rendered into each region, so an unchanged one is a no-op. */
  const rendered = { approvals: "", orders: "", state: "" };
  let consecutiveFailures = 0;

  /**
   * True when this region's data actually changed.
   *
   * The reason this matters is not performance. The approvals list re-rendered
   * every 5 seconds unconditionally, which replaced the input a person was
   * typing their total into -- so authorising a purchase was a race against a
   * timer, and the workaround people found was to type faster.
   */
  function changed(region, payload) {
    const next = JSON.stringify(payload);
    if (rendered[region] === next) return false;
    rendered[region] = next;
    return true;
  }

  /**
   * The payload with the ticking field taken out.
   *
   * expires_in_ms differs on every poll, so diffing the raw payload would
   * always say "changed" and we would be back where we started. The countdown
   * is driven from an absolute deadline stamped into the DOM at render time
   * instead, and the diff is taken on everything else.
   */
  function withoutClocks(data) {
    return {
      approvals: (data.approvals || []).map((a) => {
        const copy = Object.assign({}, a);
        delete copy.expires_in_ms;
        return copy;
      }),
    };
  }

  function tickClocks() {
    for (const el of $$("#approvals [data-clock]")) {
      el.innerHTML = countdown(Number(el.dataset.deadline) - Date.now());
    }
  }

  /** What a person has typed, and whether they were still in the box. */
  function snapshotTyped() {
    const typed = {};
    for (const el of $$("#approvals [data-id] [data-total]")) {
      const card = el.closest("[data-id]");
      if (card && el.value) typed[card.dataset.id] = { value: el.value, focused: el === document.activeElement };
    }
    return typed;
  }

  function restoreTyped(typed) {
    for (const el of $$("#approvals [data-id] [data-total]")) {
      const card = el.closest("[data-id]");
      const saved = card && typed[card.dataset.id];
      if (!saved) continue;
      el.value = saved.value;
      // Re-run the match check, or the Approve button stays disabled against a
      // total that is now correctly typed.
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (saved.focused) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }

  /**
   * Says out loud when the page has stopped being live.
   *
   * A poll that threw used to leave the last render sitting there looking
   * current. On a page whose whole purpose is authorising money, silently
   * stale is the worst of the three states -- worse than an error, and much
   * worse than a blank.
   */
  function note(text, tone) {
    const el = $("#refresh-status");
    if (!el) return;
    el.textContent = text;
    el.className = tone ? "meta " + tone : "meta";
  }

  async function refresh() {
    try {
      const data = await (await api("/api/approvals")).json();
      if (changed("approvals", withoutClocks(data))) {
        const typed = snapshotTyped();
        approvalsEl.innerHTML = data.approvals.length
          ? data.approvals.map(card).join("")
          : '<div class="empty">Nothing waiting. Ask your agent to prepare a cart.</div>';
        restoreTyped(typed);
      }
      tickClocks();

      const orders = await (await api("/api/orders")).json();
      if (changed("orders", orders)) {
        $("#orders").innerHTML = orders.orders.length
          ? '<div class="orders">' + orders.orders.map(order).join("") + '</div>'
          : '<div class="empty">No orders yet.</div>';
      }

      const state = await (await api("/api/state")).json();
      if (changed("state", state)) {
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

      if (consecutiveFailures) note("", "");
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      note(
        "Not live -- the panel could not reach the server (" + consecutiveFailures +
          (consecutiveFailures === 1 ? " try" : " tries") + "). Showing the last state it saw.",
        "bad",
      );
    }
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
  every(refresh, 5000);
  // The clock is its own second-by-second timer now. Re-reading the whole list
  // just to move a countdown is what made the list re-render on top of a
  // half-typed total.
  every(tickClocks, 1000);
}

/* ----------------------------------------------------------- connections */

const storesEl = $("#stores");
if (storesEl) {
  /* "3h left" / "40m left". Rounded DOWN: an optimistic clock on a session
     about to die is worse than no clock at all. */
  function timeLeft(at) {
    const mins = Math.floor((at - Date.now()) / 60000);
    if (mins <= 0) return "expiring now";
    return mins >= 60 ? Math.floor(mins / 60) + "h left" : mins + "m left";
  }

  function pill(c) {
    if (c.chrome_login_logged_in) return '<span class="pill wait">signed in — finishing…</span>';
    if (c.chrome_login_waiting) return '<span class="pill off">signing in…</span>';
    if (c.broken) return '<span class="pill bad">reconnect needed</span>';
    if (c.expired) return '<span class="pill bad">session expired</span>';
    if (c.connected) {
      const who = c.username ? " as " + esc(c.username) : "";
      const left = c.expires_at ? " · " + timeLeft(c.expires_at) : "";
      return '<span class="pill on">connected' + who + left + '</span>';
    }
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
      // The server computes the lane; the poll keeps it current so a session
      // that expires while the page is open moves shelf without a reload.
      if (c.lane) card.dataset.lane = c.lane;
      if (c.state) card.dataset.state = c.state;
      const open = card.querySelector("[data-connect-open]");
      if (open) open.textContent = c.state === "expired" || c.state === "broken" ? "Reconnect" : "Connect";
      const disc = card.querySelector("[data-disconnect]");
      // An expired session is still HELD -- disconnect has to stay reachable,
      // or the only way out of one is to connect again over the top of it.
      if (disc) disc.hidden = !c.connected && !c.broken && !c.expired;
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

  /*
   * Which tab a card belongs on -- a pure function of the lane the server
   * stamped, and nothing else.
   *
   * The old test read the rendered badge with a CSS selector: it asked
   * whether a pill carried the "on" class, so the Connected tab was a query
   * over styling, and a store with no account at all was simply "not
   * connected" -- shelved beside one waiting on a sign-in that never happened.
   * Those are different situations and the shopper has something to do about
   * exactly one of them.
   */
  function laneMatches(tab, lane) {
    if (tab === "all") return true;
    if (tab === "fetch") return lane === "fetch";
    if (tab === "connected") return lane === "connected";
    if (tab === "unconnected") return lane === "unconnected";
    return true;
  }

  function applyFilter() {
    const q = ($("[data-find]").value || "").trim().toLowerCase();
    let shown = 0;
    storesEl.querySelectorAll("[data-store]").forEach((card) => {
      const matchesTab = laneMatches(activeTab, card.dataset.lane);
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
  every(() => refreshStatus().then(applyFilter), 8000);
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
function askExtension(kind, cfg) {
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
      type: kind,
      id: id,
      token: TOKEN,
      domains: cfg.domains,
      authCookies: cfg.authCookies,
      capture: cfg.capture,
    }, window.location.origin);
  });
}

function connectConfig(el) {
  function parse(raw) { try { return JSON.parse(raw || "[]"); } catch (err) { return []; } }
  function parseCapture(raw) { try { return JSON.parse(raw || "null"); } catch (err) { return null; } }
  return {
    storeId: el.dataset.store,
    name: el.dataset.name || el.dataset.store,
    url: el.getAttribute("href") || "",
    domains: parse(el.dataset.domains),
    authCookies: parse(el.dataset.authCookies),
    capture: parseCapture(el.dataset.capture),
    loginUrl: el.dataset.loginUrl || "",
  };
}

/* One attempt: ask the extension, and seal whatever it found. */
async function tryCapture(cfg) {
  const reply = await askExtension("capture", cfg);
  if (!reply) return { state: "no-extension" };
  if (!reply.ok) return { state: "no-extension", error: reply.error };
  if (!reply.signedIn) return { state: "signed-out" };
  // Signed in, but the store wants headers and none have flown yet. Reported
  // separately from "waiting" so the pump knows it is worth provoking the
  // tab rather than sitting through another 2.5 seconds of nothing.
  if (cfg.capture && !reply.complete) return { state: "no-headers" };
  let res;
  try {
    res = await api("/api/connections/" + encodeURIComponent(cfg.storeId) + "/extension-capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie_header: reply.cookieHeader, headers: reply.headers }),
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

/*
 * The retailer tab this page opened, per store.
 *
 * We hold the handle because window.open gives one and a plain target=_blank
 * anchor does not, and two things depend on having it (S24):
 *
 *   - **Closing.** A page may only close a window it opened itself. Until
 *     S24 the tab was opened by the anchor's own navigation, so nothing on
 *     this page could ever close it -- "it connected but the tab is still
 *     sitting there" was not a bug that sometimes happened, it was the only
 *     possible outcome.
 *   - **Provoking.** Tesco's credential is a header pair on a call its own
 *     frontend makes, not a cookie. A shopper who is already signed in and
 *     whose tab has finished loading makes no further calls, so there was
 *     nothing to overhear and the connect waited forever. Re-pointing the
 *     window at the store's own URL makes Tesco's own page issue its own
 *     authenticated request. Cross-origin location assignment on a window
 *     you opened is allowed; reading anything back from it is not, and we do
 *     not try.
 */
const openedTabs = new Map();

function tabFor(storeId) {
  const w = openedTabs.get(storeId);
  if (!w || w.closed) { openedTabs.delete(storeId); return null; }
  return w;
}

function closeTab(storeId) {
  const w = tabFor(storeId);
  if (!w) return false;
  openedTabs.delete(storeId);
  try { w.close(); return true; } catch (err) { return false; }
}

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

/*
 * Arm the header watch as soon as the connect page is on screen, before any
 * click. The listener has to be running BEFORE the retailer's tab loads, or
 * the one authenticated call it makes on load is the one we miss -- which is
 * exactly what happened to anyone already signed in.
 */
if (connectPage) {
  const opener = $("[data-connect-open]");
  if (opener) {
    const cfg = connectConfig(opener);
    if (cfg.capture) void askExtension("arm", cfg);
  }

  /*
   * Say whether the extension is here BEFORE the click, not after the failure.
   *
   * The old page kept its only mention of the extension in a hidden block that
   * appeared once a connect had already gone nowhere, so the single most
   * common reason Connect does nothing was invisible right up until the moment
   * it had already wasted the user's time. The content script sets the
   * attribute this reads the instant the page loads, so the answer is known
   * before anything is pressed.
   */
  const badge = $("[data-ext-badge]");
  const pill = $("[data-ext-pill]");
  const pillNote = $("[data-ext-pill-note]");
  const here = extensionPresent();

  /*
   * A session that has run out, re-armed without a click.
   *
   * An expiry is not a sign-out. The shopper is very often still signed in at
   * the store, and the only thing that lapsed is the copy Basketed holds. The
   * page still made them press Connect, wait for a tab to open on a site they
   * were already logged into, and close it again -- a full manual round trip
   * to re-read something the extension can see from here.
   *
   * So on arrival, if a credential is held and dead and the extension is
   * loaded, ask it once. If the cookies and headers are there, this finishes
   * silently and the page reloads connected. If they are not, nothing is lost
   * and the Connect button is exactly where it was.
   *
   * Deliberately no window.open: a popup outside a click handler is blocked,
   * and one that was not would be a page opening retailer tabs on its own.
   */
  const state = connectPage.dataset.state;
  if (here && opener && (state === "expired" || state === "broken")) {
    const cfg = connectConfig(opener);
    say("Session expired. Checking whether you are still signed in at " + cfg.name + "...");
    void (async () => {
      const out = await tryCapture(cfg);
      if (out.state === "connected") {
        say("Still signed in. Reconnected.");
        setTimeout(() => location.reload(), 700);
        return;
      }
      // Not a failure worth a red line: pressing Connect is the normal path
      // and it is right there. Say what happened and get out of the way.
      say("Press Reconnect to sign in at " + cfg.name + " again.");
    })();
  }
  if (badge) badge.hidden = false;
  if (pill) {
    pill.className = here ? "pill ok" : "pill wait";
    pill.textContent = here ? "extension loaded" : "extension not loaded";
  }
  if (pillNote) {
    pillNote.textContent = here
      ? "Connect finishes by itself in this browser."
      : "Connect will open the tab, but cannot read the session back. Load it once - below.";
  }
  if (!here && extMissing) extMissing.hidden = false;
}

function watchConnect(cfg) {
  stopPump(cfg.storeId);
  showWaiting();
  say("Heartbeat: watching " + cfg.name + " in the other tab...");

  // How many ticks we have let pass without the headers we need before
  // nudging the tab. One tick of patience first: if the page is still
  // loading, its own request is already on the way and a reload would only
  // interrupt it.
  let dry = 0;
  // Point the opened tab at the retailer's login page once when signed out.
  let sentToLogin = false;

  async function tick() {
    const out = await tryCapture(cfg);
    if (out.state === "connected") {
      stopPump(cfg.storeId);
      const closed = closeTab(cfg.storeId);
      say(closed ? "Connected. Closing that tab..." : "Connected. Reading this page again...");
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
      dry = 0;
      if (signinLink) signinLink.hidden = false;
      const tab = tabFor(cfg.storeId);
      if (!sentToLogin && tab && cfg.loginUrl) {
        sentToLogin = true;
        say("Heartbeat: not signed in — opening " + cfg.name + " login in that tab...");
        try { tab.location = cfg.loginUrl; } catch (err) { /* tab gone; next tick notices */ }
        return;
      }
      say("Heartbeat: waiting for you to sign in at " + cfg.name + " — finishes itself when you are through.");
      return;
    }
    if (out.state === "no-headers") {
      dry += 1;
      const tab = tabFor(cfg.storeId);
      if (dry >= 2 && tab) {
        dry = 0;
        say("Heartbeat: signed in at " + cfg.name + ". Asking that tab for the session...");
        // Their own page, their own request, their own credential on it.
        try { tab.location = cfg.url; } catch (err) { /* tab gone; next tick notices */ }
        return;
      }
      say(
        tab
          ? "Heartbeat: signed in at " + cfg.name + ". Waiting for the session..."
          : "Heartbeat: signed in at " + cfg.name + ", but that tab is closed. Press Connect again.",
      );
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
  pumps.set(cfg.storeId, every(tick, 2500));
}

/*
 * Delegated, so one handler serves the store page and every card on the list.
 *
 * The anchor stays a real anchor -- middle-click, ctrl-click and "open in new
 * tab" all still do the ordinary thing, and a browser with JavaScript off
 * still gets to the retailer. A plain left click is handled here instead so
 * the window is opened by window.open, synchronously inside the click, which
 * is both un-blockable by popup blockers and the only way this page ends up
 * holding a handle it can later close.
 */
document.addEventListener("click", (e) => {
  const el = e.target.closest ? e.target.closest("[data-connect-open]") : null;
  if (!el) return;
  // Leave every modified click to the browser.
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const cfg = connectConfig(el);

  let tab = null;
  try {
    tab = window.open(cfg.url, "basketed-connect-" + cfg.storeId);
  } catch (err) {
    tab = null;
  }
  // A blocked or failed open leaves the anchor to do its own job; only steal
  // the navigation once we actually have the window.
  if (tab) {
    e.preventDefault();
    openedTabs.set(cfg.storeId, tab);
    try { tab.focus(); } catch (err) { /* focus is a courtesy */ }
  }

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
    watch = every(async () => {
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

/* --------------------------------------------------------------- settings */

const settingsForm = $("[data-settings-form]");
if (settingsForm) {
  const msg = $("[data-settings-msg]");
  const spentEl = $("[data-settings-spent]");
  const remainEl = $("[data-settings-remaining]");
  const storesEl = $("#settings-stores");

  function saySettings(text, bad) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = bad ? "var(--bad)" : "";
  }

  async function loadSettings() {
    const state = await (await api("/api/state")).json();
    const g = state.guardrails;
    settingsForm.home_currency.value = g.homeCurrency || "USD";
    settingsForm.per_order_cap.value = g.perOrderCap;
    settingsForm.daily_cap.value = g.dailyCap;
    const spent = Number(g.spent_24h || 0);
    const remain = Math.max(0, Number(g.dailyCap) - spent);
    if (spentEl) spentEl.textContent = spent.toFixed(2) + " " + g.homeCurrency;
    if (remainEl) remainEl.textContent = remain.toFixed(2) + " " + g.homeCurrency;

    const allowed = new Set(g.allowedStores || []);
    const cartStores = (state.stores || []).filter(function (s) {
      return s.mode !== "simulated" && Array.isArray(s.capabilities) && s.capabilities.indexOf("cart") !== -1;
    });
    if (!storesEl) return;
    if (!cartStores.length) {
      storesEl.innerHTML = '<div class="empty">No cart-capable stores loaded.</div>';
      return;
    }
    storesEl.innerHTML = cartStores.map(function (s) {
      const on = allowed.size === 0 ? false : allowed.has(s.id);
      return '<label class="row" style="gap:10px;align-items:center">' +
        '<input type="checkbox" name="allowed_store" value="' + esc(s.id) + '"' + (on ? " checked" : "") + " />" +
        "<span>" + esc(s.name) + ' <span class="num">' + esc(s.id) + "</span></span>" +
        "</label>";
    }).join("") +
      '<p class="small" style="margin:8px 0 0">Leave every box unchecked to allow any cart-capable store (default).</p>';
  }

  settingsForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    const boxes = Array.prototype.slice.call(settingsForm.querySelectorAll('input[name="allowed_store"]'));
    const checked = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    // Empty list = any store (backend default). If the user checked some, send those.
    const body = {
      home_currency: String(settingsForm.home_currency.value || "").trim().toUpperCase(),
      per_order_cap: Number(settingsForm.per_order_cap.value),
      daily_cap: Number(settingsForm.daily_cap.value),
      allowed_stores: checked,
    };
    try {
      const res = await api("/api/guardrails", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        saySettings(data.error || ("Save failed (" + res.status + ")"), true);
        return;
      }
      saySettings("Saved.");
      await loadSettings();
    } catch (err) {
      saySettings(err.message || "Save failed", true);
    }
  });

  void loadSettings().catch(function (err) {
    saySettings(err.message || "Could not load settings", true);
  });
}
`;
