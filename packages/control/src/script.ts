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

/* theme: explicit choice beats OS, and persists per browser (S14) */
(function () {
  const btn = $("[data-theme-toggle]");
  if (!btn) return;
  const label = $("[data-theme-label]");
  function apply(mode) {
    if (mode) document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
    if (label) label.textContent = mode === "dark" ? "Dark" : mode === "light" ? "Light" : "System theme";
  }
  let stored = null;
  try { stored = localStorage.getItem("basketed-theme"); } catch (e) { /* private window */ }
  apply(stored);
  btn.addEventListener("click", function () {
    const order = [null, "dark", "light"];
    const next = order[(order.indexOf(stored) + 1) % order.length];
    stored = next;
    try { if (next) localStorage.setItem("basketed-theme", next); else localStorage.removeItem("basketed-theme"); } catch (e) { /* private window */ }
    apply(next);
  });
})();

function money(m) {
  if (!m) return "";
  return m.value.toFixed(2) + " " + m.currency;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function countdown(ms) {
  if (ms <= 0) return '<span class="ring cold">expired</span>';
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return '<span class="ring">' + mm + ":" + ss + " left</span>";
}

/* copy buttons, on every page */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const code = btn.parentElement.querySelector("code");
  try {
    await navigator.clipboard.writeText(code.textContent);
    const was = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => (btn.textContent = was), 1200);
  } catch {
    // Clipboard is blocked outside a secure context in some browsers; select
    // the text instead so the copy is still one keystroke away.
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

  function card(a) {
    expected.set(a.id, a.total.value.toFixed(2));
    const lines = a.line_items
      .map((li) => '<tr><td>' + esc(li.quantity) + ' &times; ' + esc(li.name) +
        '</td><td class="money">' + money(li.unit_price) + '</td></tr>')
      .join("");
    const adj = a.adjustments
      .map((x) => '<tr><td class="muted">' + esc(x.label) + '</td><td class="money muted">' +
        money(x.amount) + '</td></tr>')
      .join("");
    const stamp = a.mode === "simulated"
      ? '<span class="stamp sim">simulated</span>'
      : '<span class="stamp wait">awaiting you</span>';

    return '<div class="card" data-id="' + esc(a.id) + '">' +
      '<div class="row between"><strong>' + esc(a.store_id) + '</strong>' + stamp + '</div>' +
      '<table class="lines">' + lines + adj +
        '<tr class="total"><td>Total</td><td class="money">' + money(a.total) + '</td></tr>' +
      '</table>' +
      '<div class="row between">' +
        '<div class="row">' +
          '<input class="total" placeholder="' + a.total.value.toFixed(2) + '" data-total>' +
          '<button class="act go" data-approve disabled>Approve</button>' +
          '<button class="act no" data-reject>Reject</button>' +
        '</div>' +
        countdown(a.expires_in_ms) +
      '</div>' +
      '<div class="err" data-err></div>' +
      '<p class="tiny muted" style="margin:10px 0 0">Account ' + esc(a.account_handle) +
        '. Nothing has been charged. Typing the total is the authorisation.</p>' +
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
      ? orders.orders.map(order).join("")
      : '<div class="empty">No orders yet.</div>';

    const state = await (await api("/api/state")).json();
    const g = state.guardrails;
    $("#guardrails").innerHTML =
      'Caps: <span class="num">' + g.perOrderCap.toFixed(2) + " " + g.homeCurrency +
      '</span> per order, <span class="num">' + g.dailyCap.toFixed(2) + " " + g.homeCurrency +
      '</span> per 24h (<span class="num">' + g.spent_24h.toFixed(2) +
      '</span> used). Checked at confirm, never at prepare. Stores: <span class="num">' +
      (g.allowedStores.length ? g.allowedStores.map(esc).join(", ") : "any registered store") +
      '</span>. Redaction alarms: <span class="num">' +
      state.redaction_alarms + "</span>.";
  }

  function order(o) {
    const handed = o.state === "HANDED_OFF";
    const cls = o.state === "PLACED" || o.state === "CONFIRMED" ? "ok"
      : handed ? "unknown" : o.state === "FAILED" ? "dead" : "unknown";
    return '<div class="card" data-order="' + esc(o.id) + '">' +
      '<div class="row between">' +
        '<div><strong>' + esc(o.store_id) + '</strong> <span class="tiny muted num">' + esc(o.id) + '</span></div>' +
        '<span class="stamp ' + cls + '">' + esc(o.state.toLowerCase().replace("_", " ")) + '</span>' +
      '</div>' +
      '<div class="row between" style="margin-top:8px">' +
        '<span class="money">' + o.total_value.toFixed(2) + " " + esc(o.total_currency) + '</span>' +
        (o.handoff_url ? '<a href="' + esc(o.handoff_url) + '" target="_blank" rel="noreferrer">finish at the merchant &rarr;</a>' : "") +
      '</div>' +
      (handed
        ? '<p class="tiny muted" style="margin:10px 0 0">Handed off &mdash; outcome unknown. ' +
          'Basketed never took payment and has no way to know whether you completed it. ' +
          'Only you can say.</p>' +
          '<div class="row" style="margin-top:8px">' +
            '<button class="act" data-outcome="CONFIRMED">I completed it</button>' +
            '<button class="act no" data-outcome="CANCELLED">I did not</button>' +
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
      card.querySelector(".row.between:last-of-type").innerHTML =
        '<span class="stamp ok">approved</span>' +
        '<span class="tiny muted">Tell your agent to confirm. Single-use.</span>';
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
    if (c.broken) return '<span class="pill bad">reconnect needed</span>';
    if (c.connected) return '<span class="pill on">connected' + (c.username ? " as " + esc(c.username) : "") + '</span>';
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
  }
  $$(".tabs button").forEach((btn) => btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b === btn));
    applyFilter();
  }));
  $("[data-find]").addEventListener("input", applyFilter);

  refreshStatus().then(applyFilter);
  setInterval(() => refreshStatus().then(applyFilter), 8000);
}

const connectForm = $("[data-connect-form]");
if (connectForm) {
  const methodSel = $("[data-method]");
  function syncFields() {
    const method = methodSel.value || methodSel.getAttribute("value");
    $$("[data-fields]").forEach((el) => { el.hidden = el.dataset.fields !== method; });
  }
  if (methodSel && methodSel.tagName === "SELECT") methodSel.addEventListener("change", syncFields);
  syncFields();

  connectForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("[data-connect-msg]");
    const submitBtn = connectForm.querySelector("button[type=submit]");
    const method = methodSel.value || methodSel.getAttribute("value");
    const secretEl = connectForm.querySelector('[data-fields="' + method + '"] [data-secret]');
    const usernameEl = connectForm.querySelector('[data-fields="' + method + '"] [data-username]');
    const secret = secretEl ? secretEl.value : "";

    if (!secret.trim()) {
      msg.textContent = "Enter something first.";
      msg.className = "tiny err";
      return;
    }

    submitBtn.disabled = true;
    msg.textContent = "Connecting…";
    msg.className = "tiny muted";
    try {
      const res = await api("/api/connections/" + encodeURIComponent(connectForm.dataset.store), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: method, secret: secret, username: usernameEl ? usernameEl.value : undefined }),
      });
      const out = await res.json();
      if (!res.ok) {
        msg.textContent = out.error || ("Refused (" + res.status + ").");
        msg.className = "tiny err";
        return;
      }
      if (secretEl) secretEl.value = "";
      msg.textContent = "Connected" + (out.username ? " as " + out.username : "") + ". You can leave this page.";
      msg.className = "tiny";
      msg.style.color = "var(--ok)";
    } catch (err) {
      console.error("[basketed] connect failed: " + err.message);
      msg.textContent = "Could not reach the server. Is it still running?";
      msg.className = "tiny err";
    } finally {
      submitBtn.disabled = false;
    }
  });
}
`;
