/**
 * The panel's design system.
 *
 * S14 merges two directions that landed on the same files within minutes of
 * each other: a Composio-shaped rail/grid layout carrying a Connect-stores
 * page, and a Gemini-inspired palette — dark glass, blue→violet→pink gradient
 * accent, pill geometry — from a parallel push. This file keeps the layout
 * (rail, app grid, connect form) and takes the palette, in both directions:
 * the bare `:root` is a light Gemini (white surfaces, the same gradient
 * accent, dark ink), and `prefers-color-scheme`/`[data-theme]` swap in the
 * dark palette traced from Gemini itself (bg #131314, surface #1E1F20).
 *
 * Google Sans is not an actual Google Fonts family (it is Google-internal), so
 * it is kept as a first preference for anyone who happens to have it and
 * Inter is what actually loads — the earlier `@import` asked Google Fonts for
 * a family it does not serve, which silently no-ops.
 */
export const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --bg: #FBFBFD;
  --bg-soft: #F3F4F6;
  --surface: #FFFFFF;
  --surface-2: #F1F3F4;
  --surface-3: #E8EAED;
  --surface-hover: #F8F9FA;
  --ink: #1F1F1F;
  --ink-2: #444746;
  --ink-3: #5F6368;
  --ink-4: #80868B;
  --rule: #DADCE0;
  --rule-soft: #EBECEE;
  --accent: #4A6FE0;
  --accent-2: #8E38C9;
  --accent-3: #D2418A;
  --accent-grad: linear-gradient(90deg, #4A6FE0 0%, #6B5FE8 20%, #8E38C9 55%, #C231A0 85%, #D2418A 100%);
  --accent-grad-strong: linear-gradient(135deg, #3E63D8 0%, #7A1FA2 52%, #C21860 100%);
  --ok: #1E8E3E;
  --ok-soft: #E6F4EA;
  --warn: #B06000;
  --warn-soft: #FEF7E0;
  --danger: #C5221F;
  --danger-soft: #FCE8E6;
  --radius-xl: 24px;
  --radius-lg: 16px;
  --radius-md: 12px;
  --radius-pill: 999px;
  --shadow: 0 1px 3px rgba(31,31,31,0.08);
  --sans: "Google Sans", "Inter", ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #131314;
    --bg-soft: #1A1A1E;
    --surface: #1E1F20;
    --surface-2: #2D2E30;
    --surface-3: #35363A;
    --surface-hover: #28292C;
    --ink: #E8EAED;
    --ink-2: #BDC1C6;
    --ink-3: #9AA0A6;
    --ink-4: #5F6368;
    --rule: #3C4043;
    --rule-soft: #2D2E30;
    --accent: #8AB4F8;
    --accent-2: #C58AF9;
    --accent-3: #F19ED2;
    --accent-grad: linear-gradient(90deg, #8AB4F8 0%, #9AB4FF 20%, #C58AF9 55%, #E8A0BF 85%, #F19ED2 100%);
    --accent-grad-strong: linear-gradient(135deg, #4285F4 0%, #8E24AA 52%, #D81B60 100%);
    --ok: #81C995;
    --ok-soft: #1E3A2A;
    --warn: #FDD663;
    --warn-soft: #3A3416;
    --danger: #F28B82;
    --danger-soft: #3A1E1E;
    --shadow: 0 1px 3px rgba(0,0,0,0.35);
  }
}
:root[data-theme="dark"] {
  --bg: #131314;
  --bg-soft: #1A1A1E;
  --surface: #1E1F20;
  --surface-2: #2D2E30;
  --surface-3: #35363A;
  --surface-hover: #28292C;
  --ink: #E8EAED;
  --ink-2: #BDC1C6;
  --ink-3: #9AA0A6;
  --ink-4: #5F6368;
  --rule: #3C4043;
  --rule-soft: #2D2E30;
  --accent: #8AB4F8;
  --accent-2: #C58AF9;
  --accent-3: #F19ED2;
  --accent-grad: linear-gradient(90deg, #8AB4F8 0%, #9AB4FF 20%, #C58AF9 55%, #E8A0BF 85%, #F19ED2 100%);
  --accent-grad-strong: linear-gradient(135deg, #4285F4 0%, #8E24AA 52%, #D81B60 100%);
  --ok: #81C995;
  --ok-soft: #1E3A2A;
  --warn: #FDD663;
  --warn-soft: #3A3416;
  --danger: #F28B82;
  --danger-soft: #3A1E1E;
  --shadow: 0 1px 3px rgba(0,0,0,0.35);
}

* { box-sizing: border-box; }
/*
 * Every component below sets its own display (flex, grid, inline-flex...),
 * which is an author-origin rule and therefore beats the browser's built-in
 * hidden-attribute rule regardless of specificity -- origin wins over
 * specificity in the cascade. Without this, setting .hidden = true from the
 * script silently does nothing on anything already styled with display:
 * the Connect-stores page's "Connected" filter is exactly this bug, setting
 * hidden on cards that a display:flex rule on .appcard keeps showing.
 */
[hidden] { display: none !important; }
html, body { height: 100%; }
html { scrollbar-gutter: stable; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: var(--radius-pill); }
::-webkit-scrollbar-track { background: transparent; }

/* --------------------------------------------------------------- frame */

.app { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100%; }

.rail {
  border-right: 1px solid var(--rule-soft);
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  display: flex; flex-direction: column; gap: 4px;
  padding: 18px 12px;
  position: sticky; top: 0; height: 100vh;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .rail { background: rgba(19,19,20,0.7); } }
:root[data-theme="dark"] .rail { background: rgba(19,19,20,0.7); }

.rail .mark {
  display: inline-flex; align-items: center; gap: 10px;
  font-family: var(--sans); font-weight: 500; font-size: 18px; letter-spacing: -0.02em;
  color: var(--ink); padding: 4px 8px 16px;
}
.rail .mark .spark {
  width: 26px; height: 26px; flex-shrink: 0; display: grid; place-items: center;
  border-radius: 50%; background: var(--accent-grad);
  box-shadow: 0 2px 8px rgba(74,111,224,0.35);
}
.rail .mark .spark svg { width: 14px; height: 14px; display: block; }
.rail .mark em {
  font-style: normal; font-weight: 700;
  background: var(--accent-grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.rail .mark b {
  font-family: var(--mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink-3);
  border: 1px solid var(--rule); border-radius: var(--radius-pill); padding: 1px 7px; margin-left: 2px;
}
.rail nav { display: flex; flex-direction: column; gap: 2px; }
.rail nav a {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: var(--radius-pill);
  color: var(--ink-2); font-size: 14px; font-weight: 500;
  border: 1px solid transparent; transition: all 0.15s ease;
}
.rail nav a:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }
.rail nav a.on { background: var(--surface-3); color: var(--ink); border-color: var(--rule); box-shadow: var(--shadow); font-weight: 600; }
.rail nav a.on svg { color: var(--accent); }
.rail nav a svg { width: 16px; height: 16px; flex: none; color: var(--ink-3); }
.rail nav a .count {
  margin-left: auto; font-family: var(--mono); font-size: 11px;
  background: var(--accent-grad); color: #fff;
  border-radius: var(--radius-pill); padding: 0 6px; min-width: 18px; text-align: center;
}
.rail .foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--rule-soft); }
.who { display: flex; align-items: center; gap: 9px; padding: 2px 8px; }
.who .dot {
  width: 26px; height: 26px; border-radius: 50%; flex: none;
  background: var(--accent-grad); color: #fff;
  display: grid; place-items: center; font-size: 12px; font-weight: 700;
}
.who small { display: block; color: var(--ink-3); font-size: 11.5px; line-height: 1.3; }

button.theme {
  font: inherit; font-size: 12.5px; color: var(--ink-2);
  display: flex; align-items: center; gap: 8px;
  background: var(--surface-2); border: 1px solid var(--rule); border-radius: var(--radius-pill);
  padding: 7px 12px; cursor: pointer; width: 100%; transition: all 0.15s;
}
button.theme:hover { color: var(--ink); border-color: var(--ink-4); background: var(--surface-3); }
button.theme svg { width: 15px; height: 15px; }

.sheet { padding: 36px 36px 96px; max-width: 1080px; }

@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; flex-direction: row; align-items: center; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--rule-soft); }
  .rail .mark { padding: 0 12px 0 4px; }
  .rail nav { flex-direction: row; flex-wrap: wrap; }
  .rail .foot { margin: 0 0 0 auto; flex-direction: row; border: 0; padding: 0; }
  .who small { display: none; }
  .sheet { padding: 24px 18px 80px; }
}

/* ---------------------------------------------------------- typography */

h1 { font-size: 32px; line-height: 1.18; letter-spacing: -0.03em; margin: 0 0 12px; font-weight: 400; color: var(--ink); }
h1 strong {
  font-weight: 700;
  background: var(--accent-grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); margin: 40px 0 16px; font-weight: 600; }
h3 { font-size: 15px; margin: 0 0 4px; font-weight: 600; color: var(--ink); }
p.lede { color: var(--ink-2); margin: 0 0 6px; max-width: 64ch; font-size: 16px; line-height: 1.6; }
p { max-width: 68ch; color: var(--ink-2); }
small { color: var(--ink-3); }
.muted { color: var(--ink-2); }
.tiny { font-size: 12.5px; line-height: 1.5; }
.num, .money { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.money { white-space: nowrap; }
.tear { border: 0; border-top: 1px solid var(--rule-soft); margin: 32px 0; height: 0; }
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.err { color: var(--danger); font-size: 13px; margin-top: 8px; font-weight: 500; }

/* -------------------------------------------------------------- pieces */

.card {
  border: 1px solid var(--rule-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 20px;
  margin-bottom: 14px;
  transition: border-color 0.15s, background 0.15s;
}
.card:hover { border-color: var(--rule); background: var(--surface-hover); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 14px; }

/* stamps — Gemini pills */
.stamp {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--sans); font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  padding: 4px 10px; border-radius: var(--radius-pill);
  border: 1px solid var(--rule); background: var(--surface-2); color: var(--ink-2); line-height: 1;
}
.stamp::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: 0.9; }
.stamp.sim { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.stamp.ok, .stamp.live { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.stamp.wait { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.stamp.dead { color: var(--danger); background: var(--danger-soft); border-color: transparent; }
.stamp.unknown { color: var(--ink-3); }

/* code blocks — Gemini dark surface with gradient top border */
pre.copy {
  position: relative;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.65;
  background: var(--bg); color: var(--ink);
  padding: 16px 64px 16px 16px; border-radius: var(--radius-md);
  border: 1px solid var(--rule-soft);
  overflow-x: auto; margin: 12px 0 0;
}
pre.copy::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: var(--accent-grad); opacity: 0.9; border-radius: var(--radius-md) var(--radius-md) 0 0;
}
pre.copy code { color: inherit; }
pre.copy button {
  position: absolute; top: 10px; right: 10px;
  font-family: var(--sans); font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
  background: var(--surface-2); color: var(--ink-2);
  border: 1px solid var(--rule); border-radius: var(--radius-pill);
  padding: 5px 12px; cursor: pointer; transition: all 0.15s;
}
pre.copy button:hover { background: var(--surface-3); color: var(--ink); border-color: var(--ink-4); }
pre.copy button.flash { background: var(--accent-grad-strong); color: #fff; border-color: transparent; }

/* buttons — Gemini */
button.act {
  font-family: var(--sans); font-size: 13.5px; font-weight: 500;
  border-radius: var(--radius-pill); padding: 9px 18px; cursor: pointer;
  border: 1px solid var(--rule); background: var(--surface-2); color: var(--ink);
  transition: all 0.15s; letter-spacing: 0.01em;
}
button.act:hover { background: var(--surface-3); border-color: var(--ink-4); }
button.act.go { background: var(--accent-grad-strong); border-color: transparent; color: #fff; font-weight: 600; box-shadow: 0 2px 10px rgba(74,111,224,0.28); }
button.act.go:hover { filter: brightness(1.06); box-shadow: 0 4px 16px rgba(74,111,224,0.38); }
button.act.go:disabled { opacity: 0.42; cursor: not-allowed; box-shadow: none; filter: none; }
button.act.no { color: var(--danger); }
button.act.no:hover { background: var(--danger-soft); border-color: transparent; }
button.act.sm { font-size: 12.5px; padding: 6px 14px; }

input.total, input.field, select.field {
  font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 14px;
  padding: 9px 14px;
  border: 1px solid var(--rule); border-radius: var(--radius-pill);
  background: var(--surface-2); color: var(--ink);
  outline: none; transition: all 0.15s;
}
input.total { width: 140px; }
input.field, select.field { width: 100%; font-family: var(--sans); border-radius: var(--radius-md); }
input.total::placeholder { color: var(--ink-4); }
input.field:focus, input.total:focus, select.field:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); background: var(--surface); }
input.total:hover, input.field:hover { border-color: var(--ink-4); }
label.lab { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-3); margin: 14px 0 6px; font-weight: 600; }

table.lines { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px; }
table.lines td { padding: 6px 0; vertical-align: baseline; color: var(--ink-2); }
table.lines td:last-child { text-align: right; }
table.lines tr.total td { border-top: 1px solid var(--rule); padding-top: 12px; font-weight: 600; font-size: 16px; color: var(--ink); }

.ring { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--accent); font-size: 13px; font-weight: 500; }
.ring.cold { color: var(--ink-3); }
.empty { border: 1px dashed var(--rule); border-radius: var(--radius-lg); padding: 36px 20px; text-align: center; color: var(--ink-3); background: var(--surface); }
.note {
  border: 1px solid var(--rule-soft); border-left: 3px solid transparent; border-image: var(--accent-grad) 1;
  background: var(--surface); padding: 14px 16px; border-radius: 0 var(--radius-md) var(--radius-md) 0;
  color: var(--ink-2); font-size: 14px; line-height: 1.6; margin: 16px 0; max-width: 68ch;
}
.note .num { color: var(--ink); }

.metrics { display: flex; gap: 36px; flex-wrap: wrap; margin: 8px 0 6px; }
.metric b {
  display: block; font-family: var(--sans); font-size: 27px; font-weight: 700; letter-spacing: -0.03em;
  background: var(--accent-grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  line-height: 1.1;
}
.metric span { font-size: 11px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }

.panel-foot {
  margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--rule-soft);
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  color: var(--ink-4); font-size: 12px;
}
.panel-foot .spark-sm { width: 18px; height: 18px; border-radius: 50%; background: var(--accent-grad); display: grid; place-items: center; flex-shrink: 0; }
.panel-foot .spark-sm svg { width: 11px; height: 11px; }

/* --------------------------------------------------------- connect grid */

.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 22px 0 18px; }
.tabs { display: inline-flex; background: var(--surface-2); border: 1px solid var(--rule); border-radius: var(--radius-pill); padding: 3px; }
.tabs button {
  font: inherit; font-size: 13px; font-weight: 550;
  border: 1px solid transparent; background: transparent; color: var(--ink-2);
  padding: 6px 16px; border-radius: var(--radius-pill); cursor: pointer; transition: all 0.15s;
}
.tabs button:hover:not(.on) { color: var(--ink); }
/* Needs more than a shade of white-on-off-white: the active tab also gets its
   own border and a bolder weight, so which one is selected reads at a glance
   instead of needing a side-by-side comparison to spot. */
.tabs button.on { background: var(--surface); color: var(--accent); border-color: var(--rule); box-shadow: var(--shadow); font-weight: 700; }
.finder { position: relative; margin-left: auto; }
.finder input {
  font: inherit; font-size: 13.5px;
  padding: 8px 14px 8px 34px; width: 260px; max-width: 46vw;
  border: 1px solid var(--rule); border-radius: var(--radius-pill);
  background: var(--surface); color: var(--ink);
}
.finder svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--ink-3); }

.appgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.appcard {
  border: 1px solid var(--rule-soft); border-radius: var(--radius-lg);
  background: var(--surface); box-shadow: var(--shadow);
  padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  transition: border-color 0.15s, background 0.15s;
}
.appcard:hover { border-color: var(--rule); background: var(--surface-hover); }
.appcard .head { display: flex; align-items: center; gap: 11px; }
.tile {
  width: 34px; height: 34px; flex: none; border-radius: var(--radius-md);
  display: grid; place-items: center;
  font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: -0.02em;
  background: var(--accent-grad); color: #fff;
}
.appcard .name { font-weight: 600; font-size: 14.5px; line-height: 1.2; color: var(--ink); }
.appcard .where { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.appcard .reach { font-size: 12.5px; color: var(--ink-2); line-height: 1.45; margin: 0; max-width: none; }
.appcard .foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 4px; }
.appcard .foot .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }

.pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600;
  padding: 4px 11px; border-radius: var(--radius-pill);
}
.pill.on { background: var(--ok-soft); color: var(--ok); }
.pill.off { background: var(--surface-3); color: var(--ink-3); }
.pill.bad { background: var(--danger-soft); color: var(--danger); }
.pill svg { width: 12px; height: 12px; }

.locknote {
  display: flex; gap: 10px; align-items: flex-start;
  border: 1px solid var(--rule-soft); border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  padding: 13px 16px; margin: 18px 0; font-size: 13px; color: var(--ink-2); max-width: 70ch;
}
.locknote svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent); }
.form { max-width: 460px; }
`;
