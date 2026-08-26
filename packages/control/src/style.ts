/**
 * "Gemini" — the panel's design system.
 *
 * Google Gemini-inspired: dark base, blue→violet gradient accent,
 * pill geometry, glass cards, and Google Sans-like typography.
 * Ships as a string (no asset copy, no path resolution).
 *
 * Palette traced from Gemini (2025-2026):
 *   bg #131314, surface #1E1F20, rule #3C4043, ink #E8EAED,
 *   accent gradient #8AB4F8 → #C58AF9 → #F19ED2, ok #81C995
 */
export const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
:root {
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
  --accent-solid: #8AB4F8;
  --ok: #81C995;
  --ok-soft: #1E3A2A;
  --warn: #FDD663;
  --warn-soft: #3A3416;
  --danger: #F28B82;
  --danger-soft: #3A1E1E;
  --radius-xl: 24px;
  --radius-lg: 16px;
  --radius-md: 12px;
  --radius-pill: 999px;
  --sans: "Google Sans", "Inter", ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
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
  position: relative;
  min-height: 100vh;
}
/* subtle Gemini glow — top-center radial */
body::before {
  content: "";
  position: fixed; inset: 0;
  pointer-events: none;
  background:
    radial-gradient(900px 420px at 50% -8%, rgba(138,180,248,0.14), transparent 70%),
    radial-gradient(700px 380px at 90% 4%, rgba(197,138,249,0.10), transparent 70%),
    radial-gradient(600px 360px at 8% 12%, rgba(241,158,210,0.07), transparent 70%);
  z-index: -1;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }

/* layout */
.wrap { max-width: 920px; margin: 0 auto; padding: 0 24px 96px; }
@media (max-width: 640px) { .wrap { padding: 0 16px 64px; } }

/* header — glass, Gemini-style */
header.top {
  position: sticky; top: 0; z-index: 20;
  background: rgba(19,19,20,0.78);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border-bottom: 1px solid var(--rule-soft);
}
header.top .wrap {
  display: flex; align-items: center; gap: 28px;
  padding-top: 14px; padding-bottom: 14px;
}
/* mark — word + spark */
.mark {
  display: inline-flex; align-items: center; gap: 10px;
  font-family: var(--sans);
  font-weight: 500;
  font-size: 22px;
  letter-spacing: -0.02em;
  color: var(--ink);
  text-decoration: none !important;
}
.mark .spark {
  width: 32px; height: 32px; flex-shrink: 0;
  display: grid; place-items: center;
  border-radius: 50%;
  background: var(--accent-grad);
  box-shadow: 0 2px 10px rgba(138,180,248,0.35);
}
.mark .spark svg { width: 18px; height: 18px; display: block; }
.mark em {
  font-style: normal;
  background: var(--accent-grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  font-weight: 700;
}
/* Gemini-style nav pills */
nav { display: flex; gap: 8px; margin-left: auto; align-items: center; }
nav a {
  color: var(--ink-2);
  font-size: 14px; font-weight: 500;
  padding: 7px 16px; border-radius: var(--radius-pill);
  border: 1px solid transparent;
  transition: all 0.15s ease;
  text-decoration: none !important;
}
nav a:hover { background: var(--surface-2); color: var(--ink); border-color: var(--rule-soft); }
nav a.on {
  background: var(--surface-3);
  color: var(--ink);
  border-color: var(--rule);
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
/* hero */
h1 {
  font-size: 36px; line-height: 1.15; letter-spacing: -0.03em;
  margin: 0 0 14px; font-weight: 400;
  color: var(--ink);
}
h1 strong {
  font-weight: 700;
  background: var(--accent-grad);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
}
@media (max-width: 640px) { h1 { font-size: 28px; } }
h2 {
  font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--ink-3); margin: 40px 0 16px;
}
p.lede { color: var(--ink-2); margin: 0 0 6px; max-width: 62ch; font-size: 16px; line-height: 1.6; }
p { max-width: 68ch; color: var(--ink-2); }
small { color: var(--ink-3); }

/* dividers — Gemini hairline, not dotted */
.tear { border: 0; border-top: 1px solid var(--rule-soft); margin: 32px 0; height: 0; }

/* cards — Gemini surface */
.card {
  border: 1px solid var(--rule-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 20px;
  margin-bottom: 14px;
  transition: border-color 0.15s, background 0.15s;
}
.card:hover { border-color: var(--rule); background: var(--surface-hover); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }

/* numbers */
.num, .money { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.money { white-space: nowrap; }

/* stamps — Gemini pills */
.stamp {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--sans);
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--rule);
  background: var(--surface-2);
  color: var(--ink-2);
  line-height: 1;
}
.stamp::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: 0.9;
}
.stamp.sim { color: #FDD663; background: var(--warn-soft); border-color: #5A4A0A; }
.stamp.ok, .stamp.live { color: var(--ok); background: var(--ok-soft); border-color: #2A5A3A; }
.stamp.wait { color: var(--accent); background: rgba(138,180,248,0.12); border-color: rgba(138,180,248,0.35); }
.stamp.dead { color: var(--danger); background: var(--danger-soft); border-color: #6A2424; }
.stamp.unknown { color: var(--ink-3); }

/* code blocks — Gemini dark surface with gradient top border */
pre.copy {
  position: relative;
  font-family: var(--mono);
  font-size: 12.5px; line-height: 1.65;
  background: #0F0F10;
  color: #E8EAED;
  padding: 16px 64px 16px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--rule-soft);
  overflow-x: auto;
  margin: 12px 0 0;
}
pre.copy::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 1px;
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

/* buttons — Gemini */
button.act {
  font-family: var(--sans); font-size: 14px; font-weight: 500;
  border-radius: var(--radius-pill); padding: 9px 20px; cursor: pointer;
  border: 1px solid var(--rule); background: var(--surface-2); color: var(--ink);
  transition: all 0.15s; letter-spacing: 0.01em;
}
button.act:hover { background: var(--surface-3); border-color: var(--ink-4); transform: translateY(-0.5px); }
button.act:active { transform: translateY(0); }
button.act.go {
  background: var(--accent-grad-strong);
  border-color: transparent; color: #fff;
  box-shadow: 0 2px 10px rgba(66,133,244,0.35);
  font-weight: 600;
}
button.act.go:hover { box-shadow: 0 4px 16px rgba(66,133,244,0.45); filter: brightness(1.05); }
button.act.go:disabled { opacity: 0.42; cursor: not-allowed; box-shadow: none; transform: none; filter: none; }
button.act.no { color: var(--danger); }
button.act.no:hover { background: var(--danger-soft); border-color: #8A2E2E; }

/* inputs — Gemini pill */
input.total {
  font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 15px;
  padding: 9px 16px; width: 150px;
  border: 1px solid var(--rule); border-radius: var(--radius-pill);
  background: var(--surface-2); color: var(--ink);
  outline: none; transition: all 0.15s;
}
input.total::placeholder { color: var(--ink-4); }
input.total:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(138,180,248,0.18); background: var(--surface); }
input.total:hover { border-color: var(--ink-4); }

/* tables */
table.lines { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px; }
table.lines td { padding: 6px 0; vertical-align: baseline; color: var(--ink-2); }
table.lines td:last-child { text-align: right; }
table.lines tr.total td { border-top: 1px solid var(--rule); padding-top: 12px; font-weight: 600; font-size: 16px; color: var(--ink); }

/* layout helpers */
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.muted { color: var(--ink-2); }
.tiny { font-size: 12.5px; line-height: 1.5; }
.tiny.muted { color: var(--ink-3); }

/* countdown ring — Gemini */
.ring { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--accent); font-size: 13px; font-weight: 500; }
.ring.cold { color: var(--ink-3); }

/* empty — dashed Gemini */
.empty {
  border: 1px dashed var(--rule);
  border-radius: var(--radius-lg);
  padding: 36px 20px; text-align: center; color: var(--ink-3);
  background: rgba(255,255,255,0.02);
}

/* note — Gemini left-accent with gradient */
.note {
  border: 1px solid var(--rule-soft);
  border-left: 3px solid transparent;
  border-image: var(--accent-grad) 1;
  background: var(--surface);
  padding: 14px 16px 14px 16px;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  color: var(--ink-2);
  font-size: 14px; line-height: 1.6;
  margin: 16px 0;
  max-width: 68ch;
}
.note .num { color: var(--ink); }

/* metrics — Gemini */
.metrics { display: flex; gap: 36px; flex-wrap: wrap; margin: 8px 0 6px; }
.metric b {
  display: block;
  font-family: var(--sans); font-size: 28px; font-weight: 700; letter-spacing: -0.03em;
  background: var(--accent-grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  line-height: 1.1;
}
.metric span { font-size: 11px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }

/* error */
.err { color: var(--danger); font-size: 13px; margin-top: 8px; font-weight: 500; }

/* footer — Gemini attribution */
.gemini-foot {
  margin-top: 48px; padding-top: 20px;
  border-top: 1px solid var(--rule-soft);
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  color: var(--ink-4); font-size: 12px;
}
.gemini-foot .spark-sm { width: 18px; height: 18px; border-radius: 50%; background: var(--accent-grad); display: grid; place-items: center; flex-shrink: 0; }
.gemini-foot .spark-sm svg { width: 11px; height: 11px; }

/* scrollbar — Gemini dark */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 999px; }
::-webkit-scrollbar-track { background: transparent; }

/* focus visible */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;
