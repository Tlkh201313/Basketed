/**
 * Severs the network inside a Node process. Preloaded with `--import`.
 *
 * The wifi-failure drill (§11) is worthless if it runs with the wifi up: you
 * set BASKETED_SNAPSHOTS=1, everything passes, and you have proved nothing
 * except that the flag parses. The only honest version of that drill actually
 * takes the wire away, and this is the cheapest way to do that without asking
 * anyone to unplug a cable mid-rehearsal.
 *
 * Loopback stays open, because the panel and the MCP endpoint talk over it.
 */
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|0\.0\.0\.0|localhost)$/i;
const local = (host) => !host || LOOPBACK.test(String(host));

class OfflineError extends Error {
  constructor(what) {
    super(`offline-guard: refused ${what}`);
    this.name = "OfflineError";
    this.code = "ENETDOWN";
  }
}

/* Every HTTP client in this process ends up here, undici's fetch included. */
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const [first, second] = args;
  const host = first && typeof first === "object" ? first.host : typeof second === "string" ? second : undefined;
  if (!local(host)) {
    process.stderr.write(`[offline-guard] refused TCP ${host}\n`);
    throw new OfflineError(`TCP connect to ${host}`);
  }
  return realConnect.apply(this, args);
};
for (const mod of [tls]) {
  const orig = mod.connect;
  mod.connect = function (...args) {
    const host = args[0] && typeof args[0] === "object" ? args[0].host : typeof args[1] === "string" ? args[1] : undefined;
    if (!local(host)) {
      process.stderr.write(`[offline-guard] refused TLS ${host}\n`);
      throw new OfflineError(`TLS connect to ${host}`);
    }
    return orig.apply(this, args);
  };
}
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function (...args) {
    const first = args[0];
    let host = "";
    try {
      if (typeof first === "string") host = new URL(first).hostname;
      else if (first instanceof URL) host = first.hostname;
      else host = first?.host ?? first?.hostname ?? "";
      if (host.includes(":")) host = host.split(":")[0];
    } catch {}
    if (!local(host)) {
      process.stderr.write(`[offline-guard] refused ${mod === http ? "http" : "https"} ${host}\n`);
      throw new OfflineError(`${mod === http ? "http" : "https"} request to ${host}`);
    }
    return orig.apply(this, args);
  };
}

/* Caught earlier and more cleanly than the socket, so adapters see a real
 * rejection rather than a synchronous throw from inside a connection pool. */
const realFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
  let host = "";
  try {
    host = new URL(href).hostname;
  } catch {
    /* a relative URL cannot leave the machine */
  }
  if (!local(host)) {
    process.stderr.write(`[offline-guard] refused fetch ${host}\n`);
    throw new OfflineError(`fetch to ${host}`);
  }
  return realFetch(input, init);
};

process.stderr.write("[offline-guard] armed — loopback only\n");

// A guard that silently failed to install would make the drill vacuous, so the
// drill runs this first as a positive control.
if (process.env["BASKETED_GUARD_SELFTEST"] === "1") {
  try {
    await fetch("https://cdn.statically.io/");
    process.stderr.write("[offline-guard] selftest: LEAKED\n");
  } catch {
    process.stderr.write("[offline-guard] selftest: blocked\n");
  }
}
