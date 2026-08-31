#!/usr/bin/env node
/**
 * Three checks that silently kill the demo (§11). Run before rehearsing and
 * again 30 minutes before recording.
 *
 * 1. The UCP agent profile is reachable, JSON-typed and publicly cacheable.
 *    Get any of those wrong and every tool call fails with a message that
 *    sounds like a different problem entirely.
 * 2. Every pinned store still answers tools/list.
 * 3. The control-panel port is free.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Basketed/0.1 universal-shopping-mcp";
const PORT = Number(process.env.BASKETED_PORT ?? 8787);
const PROFILE =
  process.env.BASKETED_UCP_PROFILE ??
  "https://cdn.statically.io/gist/Tlkh201313/1d42ef351a9075c75901f539bae847bc/raw/ucp-profile.json";

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

function fetchWithTimeout(url, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12_000);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}
console.log("\n1. UCP agent profile");
try {
  const res = await fetchWithTimeout(PROFILE, { headers: { "user-agent": UA } });
  const ct = res.headers.get("content-type") ?? "";
  const cc = res.headers.get("cache-control") ?? "";
  res.ok ? ok(`reachable (${res.status})`) : bad(`unreachable (${res.status})`);
  ct.includes("application/json")
    ? ok(`content-type ${ct}`)
    : bad(`content-type is "${ct}" — must be application/json, or every call fails profile_malformed`);
  /no-store|private/.test(cc)
    ? bad(`cache-control "${cc}" is rejected — must be public/cacheable`)
    : ok(`cache-control ${cc}`);
  const body = await res.json();
  body?.ucp?.capabilities && !Array.isArray(body.ucp.capabilities)
    ? ok(`declares ${Object.keys(body.ucp.capabilities).length} capabilities as an object`)
    : bad("ucp.capabilities must be an object keyed by capability id, not an array");
} catch (err) {
  bad(`profile fetch threw: ${err}`);
}

console.log("\n2. Pinned stores");
try {
  const pinned = JSON.parse(await readFile(resolve(ROOT, "fixtures/stores.pinned.json"), "utf8"));
  const results = await Promise.all(
    pinned.stores.map(async (s) => {
      try {
        const res = await fetchWithTimeout(s.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        const j = await res.json();
        return { domain: s.domain, live: Array.isArray(j?.result?.tools) };
      } catch {
        return { domain: s.domain, live: false };
      }
    }),
  );
  const live = results.filter((r) => r.live);
  live.length ? ok(`${live.length}/${results.length} answering tools/list`) : bad("no pinned store is answering");
  for (const r of results.filter((r) => !r.live)) console.log(`        down: ${r.domain}`);
} catch (err) {
  bad(`could not read fixtures/stores.pinned.json — run "pnpm probe:stores" first (${err})`);
}

console.log(`\n3. Port ${PORT}`);
await new Promise((done) => {
  const srv = createServer();
  srv.once("error", () => {
    bad(`port ${PORT} is in use`);
    done();
  });
  srv.once("listening", () => srv.close(() => (ok(`port ${PORT} free`), done())));
  srv.listen(PORT, "127.0.0.1");
});

console.log(failures ? `\n${failures} check(s) failed.\n` : "\nAll preflight checks passed.\n");
process.exit(failures ? 1 : 0);
