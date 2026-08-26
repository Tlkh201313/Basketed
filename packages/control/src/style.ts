/**
 * "Receipt" — the panel's design system (§7, rebuilt in S14).
 *
 * Served as a string rather than a file so the whole panel survives `tsc
 * --build` with no asset-copy step and no path resolution at runtime.
 *
 * S14 borrows a SHAPE from console UIs like Composio's — a persistent left
 * rail, a searchable card grid, one filled primary button — and keeps the
 * things that make this panel look like this project rather than that one:
 *
 *   - warm paper and ink, ONE accent (ember, not the console blue everyone uses)
 *   - every number monospace and tabular; totals must line up, always
 *   - dotted tear-lines as the only divider
 *   - stamps, slightly rotated, for state
 *
 * Theming is deliberate in all three states a viewer can be in: the bare
 * `:root` carries the complete light palette, `prefers-color-scheme: dark`
 * redefines only the tokens (guarded so an explicit light choice still wins),
 * and `[data-theme]` wins over both so the toggle works in either direction.
 */
export const STYLE = `
:root {
  --paper: #FAF7F2;
  --paper-2: #F2EDE4;
  --raise: #FFFFFF;
  --ink: #1A1714;
  --ink-2: #5C554C;
  --ink-3: #8C8479;
  --rule: #D9D1C4;
  --rule-2: #E7E0D5;
  --accent: #E4572E;
  --accent-ink: #FFFFFF;
  --accent-soft: rgba(228, 87, 46, 0.09);
  --ok: #2E7D4F;
  --ok-soft: rgba(46, 125, 79, 0.10);
  --warn: #C98A16;
  --danger: #B3261E;
  --shadow: 0 1px 2px rgba(26, 23, 20, 0.05);
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, "Segoe UI", Inter, Helvetica, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #141210;
    --paper-2: #1B1815;
    --raise: #221E1A;
    --ink: #F4EFE7;
    --ink-2: #B5ADA1;
    --ink-3: #7D766C;
    --rule: #322D27;
    --rule-2: #2A2521;
    --accent: #FF6B3D;
    --accent-ink: #17120F;
    --accent-soft: rgba(255, 107, 61, 0.13);
    --ok: #4FB37A;
    --ok-soft: rgba(79, 179, 122, 0.13);
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }
}
:root[data-theme="dark"] {
  --paper: #141210;
  --paper-2: #1B1815;
  --raise: #221E1A;
  --ink: #F4EFE7;
  --ink-2: #B5ADA1;
  --ink-3: #7D766C;
  --rule: #322D27;
  --rule-2: #2A2521;
  --accent: #FF6B3D;
  --accent-ink: #17120F;
  --accent-soft: rgba(255, 107, 61, 0.13);
  --ok: #4FB37A;
  --ok-soft: rgba(79, 179, 122, 0.13);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

/* ------------------------------------------------------------- the frame */

.app { display: grid; grid-template-columns: 244px minmax(0, 1fr); min-height: 100%; }

.rail {
  border-right: 1px solid var(--rule);
  background: var(--paper-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 12px;
  position: sticky;
  top: 0;
  height: 100vh;
}
.rail .mark {
  font-family: var(--mono); font-weight: 700; letter-spacing: -0.03em;
  font-size: 17px; color: var(--ink); padding: 4px 10px 14px;
}
.rail .mark span { color: var(--accent); }
.rail .mark b {
  font-family: var(--mono); font-size: 9.5px; font-weight: 600; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink-3);
  border: 1px solid var(--rule); border-radius: 3px; padding: 1px 5px; margin-left: 7px;
  vertical-align: 2px;
}
.rail nav { display: flex; flex-direction: column; gap: 2px; }
.rail nav a {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 6px;
  color: var(--ink-2); font-size: 14px; font-weight: 500;
}
.rail nav a:hover { background: var(--rule-2); color: var(--ink); text-decoration: none; }
.rail nav a.on { background: var(--raise); color: var(--ink); font-weight: 600; box-shadow: var(--shadow); }
.rail nav a.on svg { color: var(--accent); }
.rail nav a svg { width: 16px; height: 16px; flex: none; color: var(--ink-3); }
.rail nav a .count {
  margin-left: auto; font-family: var(--mono); font-size: 11px;
  background: var(--accent); color: var(--accent-ink);
  border-radius: 20px; padding: 0 6px; min-width: 18px; text-align: center;
}
.rail .foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px dashed var(--rule); }
.who { display: flex; align-items: center; gap: 9px; padding: 2px 8px; }
.who .dot {
  width: 26px; height: 26px; border-radius: 50%; flex: none;
  background: var(--accent); color: var(--accent-ink);
  display: grid; place-items: center; font-size: 12px; font-weight: 700;
}
.who small { display: block; color: var(--ink-3); font-size: 11.5px; line-height: 1.3; }

button.theme {
  font: inherit; font-size: 12.5px; color: var(--ink-2);
  display: flex; align-items: center; gap: 8px;
  background: transparent; border: 1px solid var(--rule); border-radius: 6px;
  padding: 7px 10px; cursor: pointer; width: 100%;
}
button.theme:hover { color: var(--ink); border-color: var(--ink-3); }
button.theme svg { width: 15px; height: 15px; }

.sheet { padding: 34px 34px 96px; max-width: 1080px; }

@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; flex-direction: row; align-items: center; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--rule); }
  .rail .mark { padding: 0 12px 0 4px; }
  .rail nav { flex-direction: row; flex-wrap: wrap; }
  .rail .foot { margin: 0 0 0 auto; flex-direction: row; border: 0; padding: 0; }
  .who small { display: none; }
  .sheet { padding: 22px 18px 80px; }
}

/* ------------------------------------------------------------ typography */

h1 { font-size: 28px; line-height: 1.18; letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 650; }
h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); margin: 40px 0 14px; font-weight: 600; }
h3 { font-size: 15px; margin: 0 0 4px; font-weight: 650; }
p.lede { color: var(--ink-2); margin: 0 0 4px; max-width: 64ch; }
p { max-width: 68ch; }
small { color: var(--ink-3); }
.muted { color: var(--ink-2); }
.tiny { font-size: 12.5px; }
.num, .money { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.money { white-space: nowrap; }
.tear { border: 0; border-top: 1px dashed var(--rule); margin: 28px 0; height: 0; }
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.err { color: var(--danger); font-size: 13.5px; }

/* ---------------------------------------------------------------- pieces */

.card {
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--paper-2);
  padding: 18px 20px;
  margin-bottom: 14px;
}
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }

.stamp {
  display: inline-block;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 2px 7px;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  transform: rotate(-1.6deg);
  opacity: 0.92;
}
.stamp.sim { color: var(--warn); }
.stamp.ok, .stamp.live { color: var(--ok); }
.stamp.wait { color: var(--accent); }
.stamp.dead { color: var(--danger); }
.stamp.unknown { color: var(--ink-3); }

pre.copy {
  position: relative;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
  background: var(--ink); color: var(--paper);
  padding: 14px 60px 14px 14px; border-radius: 6px;
  overflow-x: auto; margin: 10px 0 0;
}
pre.copy button {
  position: absolute; top: 8px; right: 8px;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
  background: transparent; color: inherit; opacity: 0.55;
  border: 1px solid currentColor; border-radius: 3px; padding: 3px 7px; cursor: pointer;
}
pre.copy button:hover { opacity: 1; }

button.act {
  font: inherit; font-size: 13.5px; font-weight: 600;
  border-radius: 6px; padding: 8px 16px; cursor: pointer;
  border: 1px solid var(--rule); background: var(--raise); color: var(--ink);
}
button.act:hover { border-color: var(--ink-3); }
button.act.go { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.act.go:hover { filter: brightness(1.06); }
button.act.go:disabled { opacity: 0.4; cursor: not-allowed; filter: none; }
button.act.no { color: var(--danger); }
button.act.sm { font-size: 12.5px; padding: 6px 12px; }

input.total, input.field, select.field {
  font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 14px;
  padding: 9px 11px;
  border: 1px solid var(--rule); border-radius: 6px;
  background: var(--paper); color: var(--ink);
}
input.total { width: 130px; }
input.field, select.field { width: 100%; font-family: var(--sans); }
input.field:focus, input.total:focus, select.field:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
label.lab { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); margin: 14px 0 5px; font-weight: 600; }

table.lines { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
table.lines td { padding: 4px 0; vertical-align: baseline; }
table.lines td:last-child { text-align: right; }
table.lines tr.total td { border-top: 1px dashed var(--rule); padding-top: 9px; font-weight: 650; font-size: 16px; }

.ring { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--accent); font-size: 13px; }
.ring.cold { color: var(--ink-3); }
.empty { border: 1px dashed var(--rule); border-radius: 8px; padding: 34px 20px; text-align: center; color: var(--ink-3); }
.note {
  border-left: 2px solid var(--accent);
  padding: 2px 0 2px 14px; color: var(--ink-2); font-size: 14px;
  margin: 16px 0; max-width: 66ch;
}
.metrics { display: flex; gap: 34px; flex-wrap: wrap; margin: 6px 0 4px; }
.metric b { display: block; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 25px; font-weight: 650; letter-spacing: -0.02em; }
.metric span { font-size: 12px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.07em; }

/* --------------------------------------------------------- connect grid */

.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 22px 0 18px; }
.tabs { display: inline-flex; background: var(--paper-2); border: 1px solid var(--rule); border-radius: 8px; padding: 3px; }
.tabs button {
  font: inherit; font-size: 13px; font-weight: 550;
  border: 0; background: transparent; color: var(--ink-2);
  padding: 6px 14px; border-radius: 6px; cursor: pointer;
}
.tabs button.on { background: var(--raise); color: var(--ink); box-shadow: var(--shadow); }
.finder { position: relative; margin-left: auto; }
.finder input {
  font: inherit; font-size: 13.5px;
  padding: 8px 12px 8px 32px; width: 260px; max-width: 46vw;
  border: 1px solid var(--rule); border-radius: 8px;
  background: var(--raise); color: var(--ink);
}
.finder svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--ink-3); }

.appgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.appcard {
  border: 1px solid var(--rule); border-radius: 8px;
  background: var(--raise); box-shadow: var(--shadow);
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
}
.appcard .head { display: flex; align-items: center; gap: 11px; }
.tile {
  width: 34px; height: 34px; flex: none; border-radius: 8px;
  display: grid; place-items: center;
  font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: -0.02em;
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid var(--rule);
}
.appcard .name { font-weight: 600; font-size: 14.5px; line-height: 1.2; }
.appcard .where { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.appcard .reach { font-size: 12.5px; color: var(--ink-2); line-height: 1.45; margin: 0; max-width: none; }
.appcard .foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 4px; }
.appcard .foot .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }

.pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600;
  padding: 4px 9px; border-radius: 20px;
}
.pill.on { background: var(--ok-soft); color: var(--ok); }
.pill.off { background: var(--rule-2); color: var(--ink-3); }
.pill.bad { background: rgba(179, 38, 30, 0.12); color: var(--danger); }
.pill svg { width: 12px; height: 12px; }

.locknote {
  display: flex; gap: 10px; align-items: flex-start;
  border: 1px dashed var(--rule); border-radius: 8px;
  background: var(--accent-soft);
  padding: 12px 14px; margin: 18px 0; font-size: 13px; color: var(--ink-2); max-width: 70ch;
}
.locknote svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent); }
.form { max-width: 460px; }
`;
