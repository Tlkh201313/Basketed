/**
 * "Receipt" — the panel's design system (§7).
 *
 * Served as a string rather than a file so the whole panel survives `tsc
 * --build` with no asset-copy step and no path resolution at runtime. On a
 * 13-hour clock on Windows, a build step that can silently fail to copy a
 * stylesheet is a worse trade than a 200-line template literal.
 *
 * The rules that carry the look:
 *   - warm paper, ink, ONE accent per screen
 *   - every number is monospace and tabular — totals must line up, always
 *   - dotted tear-lines as the only divider
 *   - stamps, slightly rotated, for state
 */
export const STYLE = `
:root {
  --paper: #FAF7F2;
  --paper-2: #F2EDE4;
  --ink: #1A1714;
  --ink-2: #5C554C;
  --ink-3: #8C8479;
  --rule: #D9D1C4;
  --accent: #E4572E;
  --ok: #2E7D4F;
  --warn: #C98A16;
  --danger: #B3261E;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, "Segoe UI", Inter, Helvetica, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #141210;
    --paper-2: #1D1A17;
    --ink: #F4EFE7;
    --ink-2: #B5ADA1;
    --ink-3: #7D766C;
    --rule: #322D27;
  }
}
* { box-sizing: border-box; }
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

.wrap { max-width: 860px; margin: 0 auto; padding: 0 24px 96px; }

header.top {
  border-bottom: 1px solid var(--rule);
  margin-bottom: 40px;
  background: var(--paper);
  position: sticky; top: 0; z-index: 10;
}
header.top .wrap { display: flex; align-items: center; gap: 28px; padding-top: 18px; padding-bottom: 18px; }
.mark { font-family: var(--mono); font-weight: 700; letter-spacing: -0.03em; font-size: 17px; color: var(--ink); }
.mark span { color: var(--accent); }
nav { display: flex; gap: 20px; margin-left: auto; font-size: 14px; }
nav a { color: var(--ink-2); }
nav a.on { color: var(--ink); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }

h1 { font-size: 30px; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 10px; font-weight: 650; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); margin: 44px 0 14px; font-weight: 600; }
p.lede { color: var(--ink-2); margin: 0 0 4px; max-width: 62ch; }
p { max-width: 68ch; }
small { color: var(--ink-3); }

/* the section motif: a tear-line, never a solid rule */
.tear { border: 0; border-top: 1px dashed var(--rule); margin: 28px 0; height: 0; }

.card {
  border: 1px solid var(--rule);
  border-radius: 3px;
  background: var(--paper-2);
  padding: 18px 20px;
  margin-bottom: 14px;
}
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }

.num, .money { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.money { white-space: nowrap; }

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
.stamp.ok { color: var(--ok); }
.stamp.live { color: var(--ok); }
.stamp.wait { color: var(--accent); }
.stamp.dead { color: var(--danger); }
.stamp.unknown { color: var(--ink-3); }

pre.copy {
  position: relative;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--ink);
  color: var(--paper);
  padding: 14px 60px 14px 14px;
  border-radius: 3px;
  overflow-x: auto;
  margin: 10px 0 0;
}
@media (prefers-color-scheme: dark) { pre.copy { background: #000; color: #E8E2D8; } }
pre.copy button {
  position: absolute; top: 8px; right: 8px;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
  background: transparent; color: inherit; opacity: 0.55;
  border: 1px solid currentColor; border-radius: 2px; padding: 3px 7px; cursor: pointer;
}
pre.copy button:hover { opacity: 1; }

button.act {
  font: inherit; font-size: 14px; font-weight: 600;
  border-radius: 3px; padding: 9px 18px; cursor: pointer;
  border: 1px solid var(--rule); background: transparent; color: var(--ink);
}
button.act:hover { border-color: var(--ink-3); }
/* the ONE filled accent on the whole panel */
button.act.go { background: var(--accent); border-color: var(--accent); color: #fff; }
button.act.go:disabled { opacity: 0.4; cursor: not-allowed; }
button.act.no { color: var(--danger); }

input.total {
  font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 15px;
  padding: 8px 10px; width: 130px;
  border: 1px solid var(--rule); border-radius: 3px;
  background: var(--paper); color: var(--ink);
}
input.total:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

table.lines { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
table.lines td { padding: 4px 0; vertical-align: baseline; }
table.lines td:last-child { text-align: right; }
table.lines tr.total td { border-top: 1px dashed var(--rule); padding-top: 9px; font-weight: 650; font-size: 16px; }

.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.muted { color: var(--ink-2); }
.tiny { font-size: 12.5px; }

.ring { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--accent); font-size: 13px; }
.ring.cold { color: var(--ink-3); }

.empty { border: 1px dashed var(--rule); border-radius: 3px; padding: 34px 20px; text-align: center; color: var(--ink-3); }

.note {
  border-left: 2px solid var(--accent);
  padding: 2px 0 2px 14px;
  color: var(--ink-2);
  font-size: 14px;
  margin: 16px 0;
  max-width: 66ch;
}
.metrics { display: flex; gap: 34px; flex-wrap: wrap; margin: 6px 0 4px; }
.metric b { display: block; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 25px; font-weight: 650; letter-spacing: -0.02em; }
.metric span { font-size: 12px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.07em; }
.err { color: var(--danger); font-size: 13.5px; }
`;
