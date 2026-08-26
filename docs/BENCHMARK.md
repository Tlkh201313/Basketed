# Token benchmark

Measured with `js-tiktoken` (`o200k_base`) on 2026-08-26.
Reproduce with `pnpm bench`.

**Task.** Find the cheapest ground coffee rated 4.2 or better across 3 connected
stores, then buy it. All three arms answer the same task against the same stores
(shp:deathwishcoffee.com, shp:chubbiesshorts.com, shp:allbirds.com).

| arm | tool defs | search | drill-down | task total |
|---|---:|---:|---:|---:|
| A — naive MCP (upstream JSON, unmodified) | 0 | 57,296 | — | 57,296 |
| B — raw browse (storefront search HTML) | 0 | 715,465 | — | 715,465 |
| C — Basketed (concise, 8 results + 1 drill-down) | 3,144 | 1,153 | 361 | 4,658 |

- **vs naive MCP:** 91.9% fewer tokens
- **vs raw browse:** 99.3% fewer tokens

## Method, stated so it can be checked

- **Arm A** is the upstream JSON exactly as the retailer returns it, 20 results
  per store, every field. This is what a shopping MCP server that simply
  forwards its upstream would cost.
- **Arm B** is the HTML of the equivalent storefront search page, as a
  web-browsing agent would ingest it.
- **Arm C** is Basketed at its defaults — `response_format: "concise"`,
  `max_results: 8` — plus one tier-2 drill-down, **and our own tool-definition
  overhead**. That overhead is a real cost we impose on every session before
  doing any work, and leaving it out would be the flattering version of this
  table.
- Anything that could not be measured is printed as `not measured` rather than
  dropped from a total.

The runtime trimmer inside the server uses a cheaper chars/3.6 heuristic,
because `budget_tokens` only has to keep a response under a client's output
cap. Every number on this page is a real tokeniser count.
