/**
 * The panel's design system.
 *
 * One string, no bundler, no build step — the same trade `pages.ts` takes, for
 * the same reason: there is nothing here that can silently fail to be present
 * at runtime.
 *
 * The palette is warm paper and deep green, and the reason is the subject
 * rather than taste. This panel holds a purchase gate: the one place a person
 * must stop, read a number and type it. A console that glows and gradients
 * teaches the eye to skim, and skimming is the exact failure mode the typed
 * total exists to prevent. So depth here is hairline and surface change only —
 * no shadows anywhere — and saturation is rationed: `--clay` appears on the
 * pending badge, the active nav marker and a countdown under sixty seconds,
 * and almost nowhere else. When something is orange on this page, it is
 * because it is about to cost you money.
 *
 * Three themes, as before: bare `:root` is light, `[data-theme="dark"]` is the
 * explicit choice, and `prefers-color-scheme` guarded by
 * `:root:not([data-theme="light"])` is the un-stamped default. Every colour is
 * a token, and no component colour is declared only inside a media block —
 * that is the bug that renders one theme's text on the other theme's ground.
 *
 * The three faces are self-hosted (see packages/control/fonts/OFL.md). A
 * Google Fonts @import cannot load under this panel's CSP at all, and opening
 * the CSP for it would tell a third party which machines run Basketed.
 */
export const STYLE = `
@font-face {
  font-family: "Source Serif 4";
  src: url("/fonts/source-serif-4-latin.woff2") format("woff2");
  font-weight: 200 900; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Instrument Sans";
  src: url("/fonts/instrument-sans-latin.woff2") format("woff2");
  font-weight: 400 700; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "JetBrains Mono";
  src: url("/fonts/jetbrains-mono-latin.woff2") format("woff2");
  font-weight: 100 800; font-style: normal; font-display: swap;
}

:root {
  --bg: #F4F2EC;
  --rail: #EEECE3;
  --surface: #FFFFFF;
  --sunken: #F7F5EE;
  --tint: #E9EFE3;
  --tint-line: #CFDCC4;
  --ink: #1E2A22;
  --ink2: #4C5A50;
  /* ink3 is the quietest tier that still carries words: every label, caption,
     meta line and ordinal clears 4.5:1 on all five grounds in both themes.
     ink4 is BELOW that bar on purpose and is therefore reserved for the things
     WCAG exempts -- placeholders, :disabled text, borders, the finder's slash.
     Never set real copy in ink4; reach for ink3 and let the ramp stay honest. */
  --ink3: #606C64;
  --ink4: #727F76;
  --rule: #E2DED0;
  --rule2: #D0CBB9;
  --pri: #2C4A34;
  --pri-hover: #22392A;
  --pri-ink: #F7F5EE;
  --clay: #A64C2E;
  --clay-bg: #F6E7DF;
  --ok: #35664A;
  --ok-bg: #E4EBDF;
  --sim: #7E6224;
  --sim-bg: #F4EBD6;
  --bad: #93392C;
  --bad-bg: #F6E4DE;
  --sage: #5F6E4C;

  --display: "Source Serif 4", "Iowan Old Style", Georgia, serif;
  --sans: "Instrument Sans", ui-sans-serif, system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #12150F;
    --rail: #171B14;
    --surface: #1C211A;
    --sunken: #232821;
    --tint: #202B1E;
    --tint-line: #35462F;
    --ink: #E9ECE3;
    --ink2: #B2BDAA;
    --ink3: #86927D;
    --ink4: #6B7663;
    --rule: #2A3125;
    --rule2: #3A4234;
    --pri: #A8BE9C;
    --pri-hover: #C0D2B5;
    --pri-ink: #14200F;
    --clay: #E0A088;
    --clay-bg: #2E1D17;
    --ok: #93C79F;
    --ok-bg: #1D2A20;
    --sim: #D6BB80;
    --sim-bg: #2A2417;
    --bad: #E09C8D;
    --bad-bg: #2E1D19;
    --sage: #A8BE9C;
  }
}

:root[data-theme="dark"] {
  --bg: #12150F;
  --rail: #171B14;
  --surface: #1C211A;
  --sunken: #232821;
  --tint: #202B1E;
  --tint-line: #35462F;
  --ink: #E9ECE3;
  --ink2: #B2BDAA;
  --ink3: #86927D;
  --ink4: #6B7663;
  --rule: #2A3125;
  --rule2: #3A4234;
  --pri: #A8BE9C;
  --pri-hover: #C0D2B5;
  --pri-ink: #14200F;
  --clay: #E0A088;
  --clay-bg: #2E1D17;
  --ok: #93C79F;
  --ok-bg: #1D2A20;
  --sim: #D6BB80;
  --sim-bg: #2A2417;
  --bad: #E09C8D;
  --bad-bg: #2E1D19;
  --sage: #A8BE9C;
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
  font-size: 14.5px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: var(--pri); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--pri); outline-offset: 2px; }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: var(--rule2); border-radius: 999px; }
::-webkit-scrollbar-track { background: transparent; }
::selection { background: var(--tint); color: var(--ink); }

/* ================================================================= frame */

.app { display: grid; grid-template-columns: 244px minmax(0, 1fr); min-height: 100%; }

.rail {
  background: var(--rail);
  border-right: 1px solid var(--rule);
  display: flex; flex-direction: column;
  padding: 18px 14px 16px;
  position: sticky; top: 0; height: 100vh;
}

/*
 * The mark: a --pri square holding a serif lowercase b. The old gradient
 * spark is retired -- a mark that glows competes with the one element on the
 * approvals screen that is allowed to.
 */
.mark {
  display: flex; align-items: center; gap: 9px;
  color: var(--ink); padding: 2px 6px 20px;
  font-family: var(--sans); font-size: 16px; font-weight: 600; letter-spacing: -0.02em;
}
.mark:hover { text-decoration: none; }
.mark .glyph {
  width: 30px; height: 30px; flex: none; border-radius: 9px;
  background: var(--pri); color: var(--pri-ink);
  display: grid; place-items: center;
  font-family: var(--display); font-size: 17px; font-weight: 600; line-height: 1;
  padding-bottom: 2px;
}
.mark .chip {
  font-family: var(--mono); font-size: 9px; font-weight: 500; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3);
  border: 1px solid var(--rule2); border-radius: 5px;
  padding: 2px 5px; margin-left: 2px; line-height: 1;
}

.rail nav { display: flex; flex-direction: column; gap: 2px; }
.rail nav a {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 11px; border-radius: 9px;
  color: var(--ink2); font-size: 13.5px; font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
}
.rail nav a:hover { background: var(--sunken); color: var(--ink); text-decoration: none; }
.rail nav a svg { width: 16px; height: 16px; flex: none; color: var(--ink3); }
.rail nav a.on { background: var(--surface); color: var(--ink); font-weight: 600; }
.rail nav a.on svg { color: var(--pri); }
/* The one place --clay carries navigation rather than money: a 2px marker,
   not a fill, so it reads as "you are here" without shouting. */
.rail nav a.on::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px;
  width: 2px; border-radius: 2px; background: var(--clay);
}

.rail .foot { margin-top: auto; display: flex; flex-direction: column; gap: 12px; }

.themeseg {
  display: grid; grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--rule2); border-radius: 8px; padding: 2px; gap: 2px;
}
.themeseg button {
  font-family: var(--sans); font-size: 11.5px; font-weight: 500;
  border: 0; background: transparent; color: var(--ink3);
  padding: 5px 0; border-radius: 6px; cursor: pointer; line-height: 1.4;
  transition: background 0.15s ease, color 0.15s ease;
}
.themeseg button:hover { color: var(--ink); background: var(--sunken); }
.themeseg button.on { background: var(--pri); color: var(--pri-ink); font-weight: 600; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.who { display: flex; align-items: center; gap: 9px; padding-top: 12px; border-top: 1px solid var(--rule); }
.who .avatar {
  width: 26px; height: 26px; flex: none; border-radius: 7px;
  background: var(--sunken); border: 1px solid var(--rule2); color: var(--ink3);
  display: grid; place-items: center;
  font-family: var(--mono); font-size: 11px; font-weight: 600;
}
.who b { display: block; font-size: 12px; font-weight: 600; color: var(--ink2); line-height: 1.35; }
.who small { display: block; font-size: 11px; color: var(--ink3); line-height: 1.35; }

.pane { display: flex; flex-direction: column; min-width: 0; }

/* --------------------------------------------------------------- topbar */

.topbar {
  height: 57px; flex: none;
  position: sticky; top: 0; z-index: 5;
  background: var(--bg);
  border-bottom: 1px solid var(--rule);
  display: flex; align-items: center; gap: 12px;
  padding: 0 32px;
}
.topbar .title { font-size: 14px; font-weight: 600; line-height: 1.6; color: var(--ink); white-space: nowrap; }
.topbar .meta {
  font-family: var(--mono); font-size: 11.5px; color: var(--ink3);
  font-variant-numeric: tabular-nums; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.topbar .right { margin-left: auto; display: flex; align-items: center; gap: 12px; }

main.sheet {
  padding: 30px 32px 90px;
  width: 100%;
  max-width: var(--sheet, 1120px);
}
.sheet.stores { --sheet: 1220px; }
.sheet.store  { --sheet: 900px;  --h1: 31px; }
.sheet.appr   { --sheet: 1020px; --h1: 31px; }
.sheet.lock   { --sheet: 760px;  --h1: 35px; padding-top: 64px; }

/* ============================================================ typography */

h1 {
  font-family: var(--display);
  font-size: var(--h1, 40px);
  line-height: 1.08; letter-spacing: -0.022em; font-weight: 500;
  color: var(--ink); margin: 0 0 14px; text-wrap: balance;
}
.sheet.store h1, .sheet.appr h1 { line-height: 1.12; letter-spacing: -0.02em; }
.sheet.lock h1 { line-height: 1.10; letter-spacing: -0.02em; }

.lede { font-size: 15.5px; line-height: 1.6; color: var(--ink2); margin: 0; max-width: 56ch; }
.lede strong { font-weight: 600; color: var(--ink); }

p { color: var(--ink2); max-width: 68ch; }
.body { font-size: 14.5px; line-height: 1.6; color: var(--ink2); }
.small { font-size: 12.5px; line-height: 1.55; color: var(--ink3); }
.small strong, .body strong { color: var(--ink); font-weight: 600; }

/*
 * Section rhythm: a mono label, a hairline that eats the remaining width, and
 * optional right-hand meta. One rule, every screen, so the eye learns where a
 * section starts and stops re-reading the heading to find out.
 */
h2 {
  display: flex; align-items: center; gap: 14px;
  font-family: var(--mono); font-size: 11px; font-weight: 500;
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink3);
  line-height: 1; margin: 36px 0 14px;
}
h2 i { flex: 1; height: 1px; background: var(--rule); }
h2 .meta {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.02em;
  text-transform: none; color: var(--ink3); font-variant-numeric: tabular-nums;
}

.eyebrow {
  font-family: var(--mono); font-size: 10.5px; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; line-height: 1;
  color: var(--sage); display: block;
}
.num, .money {
  font-family: var(--mono); font-variant-numeric: tabular-nums;
  font-size: 0.94em; color: var(--ink);
}
.money { white-space: nowrap; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.err { color: var(--bad); font-size: 12.5px; margin-top: 8px; }

/* ================================================================ pieces */

.pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 10px; font-weight: 500;
  letter-spacing: 0.08em; text-transform: uppercase; line-height: 1;
  padding: 5px 9px; border-radius: 999px;
  background: var(--sunken); color: var(--ink3); border: 1px solid transparent;
  white-space: nowrap;
}
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.pill.bare::before { display: none; }
.pill.ok, .pill.on { background: var(--ok-bg); color: var(--ok); }
.pill.sim { background: var(--sim-bg); color: var(--sim); }
.pill.bad { background: var(--bad-bg); color: var(--bad); }
.pill.wait { background: var(--clay-bg); color: var(--clay); }
.pill.off, .pill.neutral { background: var(--sunken); color: var(--ink3); border-color: var(--rule); }

.card {
  border: 1px solid var(--rule); border-radius: 14px;
  background: var(--surface); padding: 18px 20px;
}

/*
 * A 1px-gap grid: the container paints --rule, the children paint --surface,
 * and the gap IS the hairline. Cheaper than per-cell borders and it never
 * doubles up at a seam.
 */
.hair { display: grid; gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 14px; overflow: hidden; }
.hair > * { background: var(--surface); }

.btn {
  font-family: var(--sans); font-size: 12.5px; font-weight: 600;
  display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--rule2); border-radius: 7px;
  background: transparent; color: var(--ink2);
  padding: 7px 13px; cursor: pointer; line-height: 1.4; white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
.btn:hover { background: var(--sunken); border-color: var(--ink4); color: var(--ink); text-decoration: none; }
.btn.pri { background: var(--pri); border-color: var(--pri); color: var(--pri-ink); }
.btn.pri:hover { background: var(--pri-hover); border-color: var(--pri-hover); color: var(--pri-ink); }
.btn.danger { color: var(--bad); }
.btn.danger:hover { background: var(--bad-bg); border-color: transparent; color: var(--bad); }
.btn:disabled, .btn.pri:disabled {
  background: var(--sunken); border-color: var(--rule); color: var(--ink4);
  cursor: not-allowed;
}
.btn.sm { font-size: 11.5px; padding: 5px 10px; border-radius: 6px; }
.btn.flash { background: var(--ok-bg); border-color: transparent; color: var(--ok); }

.field {
  font-family: var(--sans); font-size: 13.5px;
  width: 100%; padding: 9px 12px;
  border: 1px solid var(--rule2); border-radius: 8px;
  background: var(--sunken); color: var(--ink);
  outline: none;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.field.mono { font-family: var(--mono); font-size: 13px; letter-spacing: 0.02em; }
.field::placeholder { color: var(--ink4); }
.field:focus { border-color: var(--pri); background: var(--surface); }
select.field { cursor: pointer; }
label.lab {
  display: block; margin: 16px 0 6px;
  font-family: var(--mono); font-size: 10.5px; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink3);
}

pre.code {
  font-family: var(--mono); font-size: 12.5px; line-height: 1.6;
  background: var(--sunken); color: var(--ink2);
  border-radius: 9px; padding: 13px 15px; margin: 0;
  overflow-x: auto; white-space: pre;
}

.empty {
  border: 1px dashed var(--rule2); border-radius: 14px;
  padding: 40px 20px; text-align: center;
  color: var(--ink3); font-size: 13px;
}

/*
 * A claim card, not a callout: 2px of --pri on the left edge and nothing else.
 * The three on the Install page carry load-bearing promises, and a box that
 * looked like a marketing highlight would undercut them.
 */
.claim {
  border: 1px solid var(--rule); border-left: 2px solid var(--pri);
  border-radius: 0 10px 10px 0; background: var(--surface);
  padding: 14px 16px;
}
.claim .eyebrow { margin-bottom: 7px; }
.claim p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink2); max-width: none; }

.sage {
  background: var(--tint); border: 1px solid var(--tint-line); border-radius: 14px;
  padding: 14px 16px;
}
.sage .eyebrow { color: var(--pri); margin-bottom: 7px; }
.sage p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink2); max-width: 96ch; }
.sage p strong { color: var(--ink); font-weight: 600; }

.pagefoot {
  margin-top: 44px; padding-top: 14px; border-top: 1px solid var(--rule);
  font-family: var(--mono); font-size: 11px; color: var(--ink3);
  display: flex; flex-wrap: wrap; gap: 6px 10px;
}
.pagefoot span:not(:last-child)::after { content: " ·"; color: var(--rule2); }

/* ============================================================== install */

.hero { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 40px; align-items: start; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 22px; }
.chip {
  font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.08em;
  text-transform: uppercase; line-height: 1;
  border: 1px solid var(--rule2); border-radius: 6px; padding: 5px 9px;
  color: var(--ink3);
}
/* The one loud element in the hero, and it names the only step that spends
   money. Everything else in this palette defers to it. */
.chip.on { background: var(--pri); border-color: var(--pri); color: var(--pri-ink); }

.stat { display: flex; align-items: baseline; gap: 12px; padding: 14px 16px; }
.stat b {
  font-family: var(--mono); font-size: 26px; font-weight: 600; letter-spacing: -0.03em;
  line-height: 1; color: var(--ink); font-variant-numeric: tabular-nums;
  min-width: 92px;
}
.stat span { font-size: 12.5px; line-height: 1.45; color: var(--ink3); }
.statfoot { padding: 12px 16px; font-size: 11.5px; line-height: 1.5; color: var(--ink3); background: var(--sunken) !important; }
.statfoot .num { color: var(--ink2); }

.endpoint { display: flex; align-items: center; gap: 16px; padding: 14px 18px; }
.endpoint .url { font-family: var(--mono); font-size: 13px; color: var(--ink); overflow-x: auto; white-space: nowrap; }
.endpoint .note {
  font-size: 12px; color: var(--ink3); line-height: 1.45;
  padding-left: 16px; border-left: 1px solid var(--rule); max-width: 36ch;
}
.endpoint .btn { margin-left: auto; background: var(--sunken); }

/* --------------------------------------------------------------- clients */

.clients { border: 1px solid var(--rule); border-radius: 14px; background: var(--surface); overflow: hidden; }
.citem { border-top: 1px solid var(--rule); }
.citem:first-child { border-top: 0; }
.crow { display: flex; align-items: center; gap: 12px; padding: 11px 16px; }
.crow .n { font-family: var(--mono); font-size: 11px; color: var(--ink3); width: 22px; flex: none; font-variant-numeric: tabular-nums; }
.crow .nm { font-size: 14px; font-weight: 600; color: var(--ink); min-width: 150px; }
.crow .path {
  font-family: var(--mono); font-size: 11.5px; color: var(--ink3);
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crow .key {
  font-family: var(--mono); font-size: 11px; color: var(--ink2);
  background: var(--sunken); border-radius: 5px; padding: 3px 7px; line-height: 1; flex: none;
}
.crow .btn { flex: none; }
.cexp { padding: 0 16px 16px 68px; border-top: 1px solid var(--rule); }
.cexp pre.code { margin-top: 14px; }
.cexp .gotcha { display: flex; gap: 9px; align-items: flex-start; margin: 11px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--ink2); max-width: 80ch; }
.cexp .gotcha .tag {
  font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase;
  background: var(--sim-bg); color: var(--sim); border-radius: 4px; padding: 3px 6px; line-height: 1; flex: none; margin-top: 2px;
}

/* ----------------------------------------------------------- tool surface */

.tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
.toolcard { border: 1px solid var(--rule); border-radius: 14px; background: var(--surface); overflow: hidden; }
.toolcard.money { border-color: var(--rule2); }
.toolcard .cap { display: flex; align-items: center; gap: 9px; padding: 12px 16px; border-bottom: 1px solid var(--rule); background: var(--sunken); }
.toolcard.money .cap { background: var(--clay-bg); border-bottom-color: var(--rule2); }
.toolcard .cap .what { font-size: 12.5px; color: var(--ink2); line-height: 1.4; }
.toolcard .cap .what code { font-family: var(--mono); font-size: 11.5px; color: var(--ink); }
.trow { display: flex; gap: 14px; align-items: baseline; padding: 10px 16px; border-top: 1px solid var(--rule); }
.trow:nth-of-type(1) { border-top: 0; }
.trow .t { font-family: var(--mono); font-size: 12.5px; color: var(--ink); flex: none; }
.trow .d { font-size: 12px; color: var(--ink3); line-height: 1.45; }

.claims { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }

/* ======================================================== connect stores */

.seg { display: inline-flex; border: 1px solid var(--rule2); border-radius: 8px; padding: 2px; gap: 2px; }
.seg button {
  font-family: var(--sans); font-size: 12.5px; font-weight: 600;
  border: 0; background: transparent; color: var(--ink3);
  padding: 5px 13px; border-radius: 6px; cursor: pointer; line-height: 1.4;
  transition: background 0.15s ease, color 0.15s ease;
}
.seg button:hover { color: var(--ink); background: var(--sunken); }
.seg button.on { background: var(--pri); color: var(--pri-ink); }

.finder { position: relative; }
.finder input {
  font-family: var(--sans); font-size: 12.5px;
  width: 210px; max-width: 46vw; padding: 6px 11px 6px 25px;
  border: 1px solid var(--rule2); border-radius: 8px;
  background: var(--surface); color: var(--ink); outline: none;
  transition: border-color 0.15s ease;
}
.finder input::placeholder { color: var(--ink4); }
.finder input:focus { border-color: var(--pri); }
.finder .slash {
  position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
  font-family: var(--mono); font-size: 11px; color: var(--ink4); pointer-events: none;
}

.appgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(324px, 1fr)); gap: 12px; }
.appcard {
  border: 1px solid var(--rule); border-radius: 14px; background: var(--surface);
  padding: 14px 16px; display: flex; flex-direction: column; gap: 11px;
  transition: border-color 0.15s ease;
}
.appcard:hover { border-color: var(--rule2); }
.appcard .head { display: flex; align-items: center; gap: 11px; }
.tile {
  width: 36px; height: 36px; flex: none; border-radius: 9px;
  border: 1px solid var(--rule); background: var(--sunken); color: var(--ink3);
  display: grid; place-items: center;
  font-family: var(--mono); font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
}
.appcard .name { font-size: 14.5px; font-weight: 600; color: var(--ink); line-height: 1.25; }
.appcard .where {
  font-family: var(--mono); font-size: 11px; color: var(--ink3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* min-height so a one-line reach and a three-line reach still line their
   footers up -- a ragged grid reads as broken rather than as varied. */
.appcard .reach { font-size: 12.5px; line-height: 1.5; color: var(--ink2); margin: 0; min-height: 38px; max-width: none; }
/* The twin note (S18): the same brand carried by a second source. Set on the
   sunken ground so it reads as a footnote about the card, not more card. */
.appcard .twin {
  margin: 10px 0 0; padding: 8px 10px; border-radius: 6px;
  background: var(--sunken); border: 1px solid var(--rule);
  font-size: 11.5px; line-height: 1.45; color: var(--ink3);
}
.appcard .twin a { color: var(--pri); }
.appcard .foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 11px; border-top: 1px solid var(--rule); }
.appcard .foot .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.appcard .foot .none { font-size: 12px; color: var(--ink3); }

/* ============================================================ one store */

.two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
.stack { display: flex; flex-direction: column; gap: 14px; }

/* The disclosure block. --bad on the left edge because what it says is that
   this feature can get your account restricted, and that is not a footnote. */
.risk {
  border: 1px solid var(--rule); border-left: 2px solid var(--bad);
  border-radius: 0 10px 10px 0; background: var(--surface);
  padding: 15px 17px;
}
.risk .eyebrow { color: var(--bad); margin-bottom: 8px; }
.risk p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--ink2); max-width: 78ch; }
.risk .row { margin-top: 14px; }

.or { display: flex; align-items: center; gap: 14px; margin: 26px 0; }
.or i { flex: 1; height: 1px; background: var(--rule); }
.or span {
  font-family: var(--mono); font-size: 10.5px; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink3);
}

/* ============================================================= approvals */

.mandate { border: 1px solid var(--rule2); border-radius: 14px; background: var(--surface); overflow: hidden; margin-bottom: 14px; }
.mandate .mhead {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 18px; background: var(--sunken); border-bottom: 1px solid var(--rule);
}
.mandate .mhead .store { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--ink); }
.mandate .mhead .ref { font-size: 12.5px; color: var(--ink3); }
.mandate .mhead .ref .num { color: var(--ink2); }
.clock {
  margin-left: auto;
  font-family: var(--mono); font-size: 12.5px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: var(--ink2); white-space: nowrap;
}
/* Under a minute the clock is the only thing on the card allowed to change
   colour, because it is the only thing on the card that is running out. */
.clock.soon { color: var(--clay); }
.clock.dead { color: var(--ink3); }

table.lines { width: 100%; border-collapse: collapse; }
table.lines td { padding: 11px 18px; border-top: 1px solid var(--rule); vertical-align: baseline; }
table.lines tr:first-child td { border-top: 0; }
table.lines td:first-child { font-size: 12.5px; color: var(--ink2); }
table.lines td:last-child { text-align: right; font-family: var(--mono); font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
table.lines td .q { font-family: var(--mono); color: var(--ink3); font-size: 11.5px; }
table.lines tr.adj td, table.lines tr.adj td:last-child { color: var(--ink3); }
table.lines tr.sum td { border-top: 1px solid var(--rule2); font-size: 14px; font-weight: 600; color: var(--ink); }
table.lines tr.sum td:last-child { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; }

.strip {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 14px 18px; background: var(--tint); border-top: 1px solid var(--rule);
}
.strip .ask { font-size: 12.5px; color: var(--ink2); }
.strip .ask .num { color: var(--ink); font-weight: 500; }
input.typed {
  font-family: var(--mono); font-size: 13.5px; font-variant-numeric: tabular-nums;
  width: 130px; padding: 8px 11px;
  border: 1px solid var(--rule2); border-radius: 7px;
  background: var(--surface); color: var(--ink); outline: none;
  transition: border-color 0.15s ease;
}
input.typed::placeholder { color: var(--ink4); }
input.typed.no { border-color: var(--bad); }
input.typed.yes { border-color: var(--pri); }
.strip .why { margin-left: auto; font-size: 12px; color: var(--ink3); max-width: 34ch; line-height: 1.45; }

.orders { border: 1px solid var(--rule); border-radius: 14px; background: var(--surface); overflow: hidden; }
.orow { padding: 13px 18px; border-top: 1px solid var(--rule); }
.orow:first-child { border-top: 0; }
.orow .line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.orow .store { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--ink); }
.orow .oid { font-family: var(--mono); font-size: 11.5px; color: var(--ink3); }
.orow .amt { margin-left: auto; font-family: var(--mono); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
.orow .said { margin: 9px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--ink3); max-width: 74ch; }

.rails { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.rails .tile2 { padding: 13px 16px; }
.rails .tile2 .eyebrow { color: var(--ink3); margin-bottom: 8px; }
.rails .tile2 b {
  font-family: var(--mono); font-size: 17px; font-weight: 600; line-height: 1;
  font-variant-numeric: tabular-nums; color: var(--ink); letter-spacing: -0.02em;
}
.rails .tile2 b.good { color: var(--ok); }
.rails .tile2 b.risk { color: var(--bad); }

/* ================================================================ locked */

.sheet.lock .pill { margin-bottom: 20px; }

/* ============================================================ responsive */

@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; }
  .rail {
    position: static; height: auto;
    flex-direction: row; align-items: center; flex-wrap: wrap; gap: 10px;
    padding: 10px 16px;
    border-right: 0; border-bottom: 1px solid var(--rule);
  }
  .mark { padding: 0 8px 0 0; }
  .mark .chip { display: none; }
  .rail nav { flex-direction: row; flex-wrap: wrap; }
  .rail nav a.on::before { top: auto; bottom: 0; left: 8px; right: 8px; width: auto; height: 2px; }
  .rail .foot { margin: 0 0 0 auto; flex-direction: row; align-items: center; gap: 10px; }
  .who { display: none; }
  .topbar { padding: 0 16px; gap: 10px; }
  .topbar .meta { display: none; }
  main.sheet { padding: 20px 16px 72px; }
  .hero { grid-template-columns: 1fr; gap: 24px; }
  .two { grid-template-columns: 1fr; }
  h1 { font-size: 30px; }
  .sheet.lock h1 { font-size: 28px; }
  .crow { flex-wrap: wrap; gap: 8px; }
  .crow .path { flex-basis: 100%; order: 9; }
  .cexp { padding-left: 16px; }
  .endpoint { flex-wrap: wrap; }
  .endpoint .note { padding-left: 0; border-left: 0; max-width: none; }
  .endpoint .btn { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;
