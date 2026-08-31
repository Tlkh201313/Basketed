# Fonts bundled with the control panel

Three families, self-hosted rather than loaded from Google Fonts. The panel's
whole claim is that nothing leaves this machine; a webfont `@import` would have
told fonts.googleapis.com, on every page load, that this person is running
Basketed. It would also never have loaded at all under the panel's
`default-src 'none'` CSP without opening `style-src` to a third party.

So the bytes ship here and the CSP gains exactly one directive: `font-src 'self'`.

Each file is the **latin subset, variable** build, fetched once from
fonts.gstatic.com and committed. All three are licensed under the
SIL Open Font License 1.1, which permits redistribution in this form.

| File | Family | Axes | Upstream |
|---|---|---|---|
| `source-serif-4-latin.woff2` | Source Serif 4 | `opsz 8..60`, `wght 200..900` | https://fonts.google.com/specimen/Source+Serif+4 |
| `instrument-sans-latin.woff2` | Instrument Sans | `wght 400..700` | https://fonts.google.com/specimen/Instrument+Sans |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | `wght 100..800` | https://fonts.google.com/specimen/JetBrains+Mono |

Copyright and full licence text for each family is carried inside the woff2's
own `name` table, as the OFL requires. The licence itself is at
https://openfontlicense.org/.

If a file here is ever missing, `style.ts`'s fallback stacks (Georgia /
system sans / Consolas) still render the design as a serif+grotesque pairing.
Nothing breaks; it just stops being the intended type.
