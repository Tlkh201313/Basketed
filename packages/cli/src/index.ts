import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import {
  createRuntime,
  createBasketedHttpHandler,
  serveBasketedStdio,
  toNodeHandler,
  SERVER_INFO,
  ALL_TOOL_NAMES,
} from "@basketed/mcp";
import {
  createPanelHandler,
  CLIENTS,
  PRIMARY_CLIENTS,
  pathFor,
  snippetFor,
  type ControlDeps,
} from "@basketed/control";
import type { Runtime } from "@basketed/mcp";
import { startHealthScheduler, healthDisabled } from "@basketed/session";
import { findRoot } from "./root.js";
import { installClient, findClient, expandPath } from "./install.js";

export { findRoot };
export * from "./install.js";

const USAGE = `basketed ${SERVER_INFO.version}

  basketed serve --stdio          MCP over stdio (Claude Code, Cursor, Codex, opencode)
                                  ...and the control panel, on a free local port
  basketed serve --stdio --no-panel   stdio only; approve with the 6-digit code
  basketed serve --fast-mode      skip per-call confirmation for READ-ONLY tools only
  basketed serve --http [--port]  MCP over Streamable HTTP + control panel (port 8787)
  basketed serve --http --open    ...and open the panel in your browser
  basketed serve --no-open        never open a browser by itself
  basketed install [--client X]   Write the MCP config for an agent client
  basketed install --all          ...for every client with a known file
  basketed install --dry-run      ...show the diff and write nothing
  basketed clients                List every supported client and its config path
  basketed doctor                 Check the install end to end
  basketed tools                  Print the tool surface and exit

Both transports are dual-era: they answer the 2026-07-28 stateless dialect and
a legacy \`initialize\` opening from the same process.

--fast-mode cannot touch purchase. It is not merely ignored on that path: the
flag lives in mcp/policy.ts and is not reachable from commerce/purchase.ts at
all, and a test asserts the import graph stays that way.

The panel comes up on BOTH transports, so plugging Basketed into a client is
all the setup there is. Its link carries a token minted per process and printed
only on this console -- the same surface the 6-digit code goes to.

On stdio the panel opens in your browser when the server starts, because a
client swallows this console and nobody would ever see the link. On http it
opens only with --open, because you are looking at the console already. One tab
per process either way, and --no-open stops it.

Environment:
  BASKETED_PANEL_PORT=n  preferred panel port (default 8787, falls back to any)
  BASKETED_NO_OPEN=1     never open a browser (same as --no-open)
  BASKETED_SNAPSHOTS=1   replay from fixtures/snapshots instead of the network
  BASKETED_ROOT=<dir>    where fixtures/ lives (auto-detected otherwise)
  BASKETED_DB=<path>     SQLite file (default ~/.basketed/basketed.db)
`;

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function value(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.split("=").slice(1).join("=");
}

/** Everything the panel needs from a runtime, in one place both transports use. */
function controlDeps(runtime: Runtime): ControlDeps {
  if (!runtime.purchase) throw new Error("The purchase gate failed to initialise.");
  return {
    purchase: runtime.purchase,
    registry: runtime.registry,
    principal: runtime.principal,
    policy: runtime.policy,
    ledger: runtime.ledger,
    summary: runtime.summary,
    version: SERVER_INFO.version,
    redactionAlarms: () => runtime.redactor.alarms(),
    vault: runtime.vault,
    sessions: runtime.sessions,
  };
}

/**
 * Bind the preferred port if it is free, otherwise take any port at all.
 *
 * A busy 8787 is a normal Tuesday -- it is a popular number and this server is
 * started by whichever client happens to launch first. Refusing to serve the
 * panel over it, or worse crashing the MCP server the client is waiting on,
 * would be a much bigger failure than moving to another port and saying so.
 */
async function listenSomewhere(server: Server, preferred: number): Promise<number | null> {
  for (const port of [preferred, 0]) {
    const bound = await new Promise<number | null>((res) => {
      const onError = () => {
        server.removeListener("listening", onListening);
        res(null);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        res((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (bound !== null) return bound;
  }
  return null;
}

interface StdioPanel extends PanelHandle {
  /** Let go of the listening socket and anything still attached to it. */
  close(): void;
}

interface PanelHandle {
  origin: string;
  token: string;
  /** A link a human can follow. Carries the token, so console and browser only. */
  url(path: string): string;
}

/**
 * Wire the panel to a runtime: token-free base for `approve_url`, tokened link
 * for the console, and the one browser tab this process is allowed to open.
 *
 * `openAtStartup` is true for stdio and follows `--open` for http, and the
 * asymmetry is the whole point. On http a person is looking at the console the
 * link was printed on. On stdio nobody is: the client swallows the server's
 * stderr, so the link is written somewhere no human will ever read, and the
 * panel might as well not exist. Opening the tab IS the channel there.
 *
 * Either way it is one tab per process. After that the panel polls every five
 * seconds, so an approval that arrives later appears in the tab that is already
 * open rather than spawning another one. `--no-open` turns all of it off.
 */
function attachPanel(
  runtime: Runtime,
  panel: PanelHandle,
  opts: { mayOpen: boolean; openAtStartup: boolean },
): void {
  if (!runtime.purchase) return;
  const mayOpen = opts.mayOpen;
  let opened = false;

  if (mayOpen && opts.openAtStartup) {
    opened = true;
    openBrowser(panel.url("/"));
  }

  runtime.purchase.panelBase = panel.origin;
  runtime.purchase.summon = (approvalId) => {
    const link = panel.url(`/approvals/${approvalId}`);
    process.stderr.write(`[basketed] approve here    ${link}\n`);
    if (!mayOpen || opened) return;
    opened = true;
    openBrowser(link);
  };
}

function panelBanner(panel: PanelHandle): string {
  return (
    `[basketed] panel         ${panel.url("/")}\n` +
    `[basketed] approvals     ${panel.url("/approvals")}\n` +
    `[basketed] The panel links above carry a token good for this process only.\n` +
    `[basketed] Approval lives behind it, on this console, where no agent can read it.\n`
  );
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "serve";

  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "tools") {
    process.stdout.write(`${ALL_TOOL_NAMES.join("\n")}\n`);
    return;
  }

  if (command === "clients") {
    for (const c of CLIENTS) {
      const primary = (PRIMARY_CLIENTS as readonly string[]).includes(c.id) ? "*" : " ";
      process.stdout.write(
        `${primary} ${c.id.padEnd(15)} ${c.key.padEnd(16)} ${c.format.padEnd(5)} ${pathFor(c, process.platform)}\n`,
      );
    }
    process.stdout.write("\n* = verified by hand. Others are generated from the same table.\n");
    return;
  }

  if (command === "install") {
    return runInstall(argv);
  }

  if (command === "doctor") {
    return runDoctor(argv);
  }

  if (command !== "serve") {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const root = findRoot();
  const http = flag(argv, "http");

  const snapshots = flag(argv, "snapshots") || process.env["BASKETED_SNAPSHOTS"] === "1";
  const runtime = await createRuntime({
    root,
    snapshots,
    fastMode: flag(argv, "fast-mode"),
  });

  const mayOpen = !flag(argv, "no-open") && process.env["BASKETED_NO_OPEN"] !== "1";

  // The headless session check (S23): every few hours, each connected store's
  // profile is asked whether it is still signed in, so a "connected" pill is
  // never a stale claim. Never under snapshots -- nothing should touch the
  // network there -- and never when the user has switched it off.
  const health =
    snapshots || healthDisabled()
      ? null
      : startHealthScheduler(runtime.sessions, { vault: runtime.vault, log: (line) => process.stderr.write(`${line}\n`) });

  // The S15-S19 Chrome profile is orphaned by the per-store profiles (S23).
  // Said once, never deleted: it may hold a session the user still wants.
  const oldProfile = resolve(homedir(), ".basketed", "chrome-profile");
  if (existsSync(oldProfile)) {
    process.stderr.write(`note: ${oldProfile} is no longer used; sign-ins now live in ~/.basketed/profiles. Safe to delete.
`);
  }

  // A sign-in window is a real Chromium process spawned as a child of this
  // one -- it does not exit just because this process does. Ctrl+C on either
  // transport must not leave it running with a signed-in session sitting in it.
  const shutdown = (): Promise<void> => {
    health?.stop();
    return runtime.sessions.closeAll();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }

  if (!http) {
    // stdout belongs to the JSON-RPC stream from here on. Every diagnostic
    // in the whole process goes to stderr; one stray console.log corrupts the
    // stream and the client reports a parse error with no clue where it came from.
    process.stderr.write(
      `[basketed] stdio · ${runtime.summary} · root=${root}` +
        `${runtime.policy.fastMode ? " · fast-mode (read-only tools only)" : ""}\n`,
    );

    /*
     * The panel comes up alongside stdio, in this same process.
     *
     * Approval channel A used to require a second command nobody runs, which
     * left channel C (read the 6-digit code aloud) as the only one a plugged-in
     * client ever saw. Same process means the same database and the same
     * purchase gate -- there is no syncing, and no second thing to keep alive.
     */
    const panel = flag(argv, "no-panel") ? null : await startStdioPanel(runtime, root, mayOpen);
    process.stderr.write(
      panel
        ? panelBanner(panel)
        : flag(argv, "no-panel")
          ? `[basketed] panel off (--no-panel). Approve with the 6-digit code.\n`
          : `[basketed] panel could not bind a port. Approve with the 6-digit code.\n`,
    );

    serveBasketedStdio(runtime);

    /*
     * EOF on stdin is the client saying it is finished with this server.
     *
     * Leaving is not automatic: on Windows a stdout pipe that has been written
     * to stays an active handle, so a server that has answered even one tool
     * call never reaches "nothing left to run" and lingers after its client is
     * gone. That used to leave a stray process; with a panel in it, it would
     * leave one still answering HTTP on a port with a live token. The timer is
     * unreffed so a process that CAN exit on its own still does, immediately --
     * this only backstops the case where a pipe is holding the door open.
     */
    process.stdin.once("end", () => {
      panel?.close();
      void shutdown();
      setTimeout(() => process.exit(0), 250).unref();
    });
    return;
  }

  const port = Number(value(argv, "port") ?? process.env["PORT"] ?? 8787);
  const origin = `http://127.0.0.1:${port}`;
  /*
   * The panel token. Minted per process, printed only on stderr, never on disk.
   *
   * Binding the approval surface to the browser's Origin header alone would
   * bind nothing: every client we install into (Claude Code, Cursor, Codex) has
   * a shell, and a local process can reach 127.0.0.1 and forge any header it
   * likes. The one thing it cannot do is read this console -- the same reason
   * the 6-digit approval code lives here. Per process, so it dies with the
   * server and cannot be replayed against the next one.
   */
  const panelToken = randomBytes(32).toString("base64url");
  const panelUrl = (path: string): string => `${origin}${path}?t=${panelToken}`;
  const handler = createBasketedHttpHandler(runtime);
  const node = toNodeHandler(handler, origin);

  // Runtime satisfies ControlDeps structurally, so the panel needs no
  // dependency on the MCP package to be handed everything it renders.
  const panel = createPanelHandler(controlDeps(runtime), {
    root,
    binPath: resolve(root, "packages/cli/bin.js"),
    origin,
    endpoint: `${origin}/mcp`,
    version: SERVER_INFO.version,
    token: panelToken,
  });

  const panelHandle: PanelHandle = { origin, token: panelToken, url: panelUrl };
  attachPanel(runtime, panelHandle, { mayOpen, openAtStartup: flag(argv, "open") });

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_INFO, stores: runtime.summary }));
      return;
    }

    const fail = (err: Error) => {
      runtime.ctx.log(`request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error." }));
    };

    if (path === "/mcp") {
      // DNS rebinding: a page on any site can resolve its own hostname to
      // 127.0.0.1 and POST here from the victim's browser. Every such request
      // carries an Origin, and it is never ours. An absent Origin is a real
      // MCP client -- those are not browsers -- and is allowed through; what
      // protects them is that /mcp has no route to an approval at all.
      const reqOrigin = req.headers.origin;
      if (reqOrigin && reqOrigin !== origin) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Cross-origin request refused." }));
        return;
      }
      node(req, res).catch(fail);
      return;
    }

    // The panel and the MCP endpoint share one port and one process, but they
    // are separate channels: nothing an agent can reach serves /api/*.
    panel(req, res)
      .then((served) => {
        if (served) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. MCP is POST /mcp; the panel is /." }));
      })
      .catch(fail);
  });

  /*
   * A busy port is a message, not a stack trace.
   *
   * Unlike the stdio panel, this one does NOT quietly move: the port is half
   * of the endpoint people paste into a client config, so changing it behind
   * their back turns one clear failure into a confusing one. 8787 is a popular
   * number -- it is worth saying which process to look for.
   */
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    process.stderr.write(
      `[basketed] port ${port} is already in use by another process.\n` +
        `[basketed] Pick a free one: basketed serve --http --port 8790 --open\n` +
        `[basketed] (stdio needs no port at all, and brings the panel with it.)\n`,
    );
    process.exitCode = 1;
    server.close();
  });

  // 127.0.0.1, not 0.0.0.0: this process holds the approval surface and the
  // order history, and a localhost single-user build has no business being
  // reachable from the network.
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `[basketed] http · ${runtime.summary}` +
        `${runtime.policy.fastMode ? " · fast-mode (read-only tools only)" : ""}\n` +
        panelBanner(panelHandle) +
        `[basketed] MCP endpoint  ${origin}/mcp\n` +
        `[basketed] health        ${origin}/healthz\n`,
    );
    // The tab, if one was asked for, is opened by attachPanel above.
  });
}

/**
 * The panel, served next to a stdio MCP server.
 *
 * Returns null rather than throwing: the client is waiting on a JSON-RPC
 * handshake, and no panel is a smaller failure than no server.
 */
async function startStdioPanel(runtime: Runtime, root: string, mayOpen: boolean): Promise<StdioPanel | null> {
  const token = randomBytes(32).toString("base64url");

  // Assigned right after the port is known, because the handler needs the
  // origin it is going to be reached on. Requests that arrive in that window
  // get a 503 rather than a crash.
  let serve: ReturnType<typeof createPanelHandler> | undefined;
  const server = createServer((req, res) => {
    if (!serve) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Panel still starting." }));
      return;
    }
    serve(req, res)
      .then((served) => {
        if (served) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. This process serves MCP over stdio; / is the panel." }));
      })
      .catch((err: Error) => {
        runtime.ctx.log(`panel request failed: ${err.message}`);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error." }));
      });
  });

  const preferred = Number(process.env["BASKETED_PANEL_PORT"] ?? 8787);
  const port = await listenSomewhere(server, Number.isFinite(preferred) ? preferred : 8787);
  if (port === null) return null;

  /*
   * The panel must not be what keeps this process alive.
   *
   * A stdio server is finished the moment its client closes stdin, and by then
   * the panel is the only thing here still holding an operating-system handle:
   * an open tab polls every five seconds over a keep-alive connection, which is
   * a live socket whether or not anyone is looking at it. Unreffing tells Node
   * those handles do not get a vote on whether to stay up (in-flight requests
   * still finish); closing on EOF is what actually lets go of them.
   */
  const sockets = new Set<Socket>();
  server.unref();
  server.on("connection", (socket) => {
    socket.unref();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const origin = `http://127.0.0.1:${port}`;
  serve = createPanelHandler(controlDeps(runtime), {
    root,
    binPath: resolve(root, "packages/cli/bin.js"),
    origin,
    // stdio: there is no Streamable HTTP endpoint to advertise, and the panel
    // says so rather than printing one that would not answer.
    endpoint: null,
    version: SERVER_INFO.version,
    token,
  });

  const panel: StdioPanel = {
    origin,
    token,
    url: (path) => `${origin}${path}?t=${token}`,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
  attachPanel(runtime, panel, { mayOpen, openAtStartup: true });
  return panel;
}

/* ------------------------------------------------------------- install */

function runInstall(argv: string[]): void {
  const root = findRoot();
  const binPath = resolve(root, "packages/cli/bin.js");
  const dryRun = flag(argv, "dry-run");
  const wanted = value(argv, "client");

  const targets = flag(argv, "all")
    ? CLIENTS
    : wanted
      ? [findClient(wanted)].filter((c): c is NonNullable<typeof c> => Boolean(c))
      : CLIENTS.filter((c) => (PRIMARY_CLIENTS as readonly string[]).includes(c.id));

  if (!targets.length) {
    process.stderr.write(
      `Unknown client "${wanted}". Run \`basketed clients\` to see the list.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${dryRun ? "Would write" : "Writing"} MCP config for ${targets.length} client(s).\n` +
      `Server: node ${binPath} serve --stdio\n\n`,
  );

  for (const spec of targets) {
    const report = installClient(spec, { binPath, dryRun, cwd: process.cwd(), ...(value(argv, "path") ? { path: value(argv, "path")! } : {}) });
    process.stdout.write(`${spec.name}\n  ${report.action.toUpperCase()}  ${report.path}\n`);
    // Nothing is ever written silently: the backup path and the diff both print.
    if (report.backup) process.stdout.write(`  backup   ${report.backup}\n`);
    if (report.note) process.stdout.write(`  note     ${report.note}\n`);
    if (report.preview) {
      for (const line of report.preview.split("\n")) process.stdout.write(`  ${line}\n`);
    }
    if (spec.gotcha) process.stdout.write(`  !        ${spec.gotcha}\n`);
    process.stdout.write("\n");
  }

  process.stdout.write(
    dryRun
      ? "Nothing was written. Drop --dry-run to apply.\n"
      : "Restart the client, then ask it to list its tools — basket_* should be there.\n",
  );
}

/* -------------------------------------------------------------- doctor */

async function runDoctor(argv: string[]): Promise<void> {
  const root = findRoot();
  let bad = 0;
  const say = (ok: boolean, label: string, detail = "") => {
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}\n`);
  };

  process.stdout.write("basketed doctor\n\n");
  say(Number(process.versions.node.split(".")[0]) >= 22, "Node >= 22 (node:sqlite)", process.versions.node);
  say(existsSync(resolve(root, "fixtures/stores.pinned.json")), "project root found", root);
  say(existsSync(resolve(root, "packages/cli/dist/index.js")), "built", "run `pnpm build` if this fails");

  const runtime = await createRuntime({ root, snapshots: true });
  say(runtime.registry.list().length > 0, "stores load", runtime.summary);
  say(Boolean(runtime.purchase), "purchase gate initialised");
  say(!runtime.policy.fastMode, "fast mode off by default");

  const port = Number(value(argv, "port") ?? 8787);
  const free = await new Promise<boolean>((res) => {
    const probe = createServer();
    probe.once("error", () => res(false));
    probe.once("listening", () => probe.close(() => res(true)));
    probe.listen(port, "127.0.0.1");
  });
  say(free, `port ${port} is free`, free ? "" : "something is already listening");

  // The project-scoped config in this repo is the safest demo target: it needs
  // no write to anything in the user's home directory.
  const projectConfig = resolve(root, ".mcp.json");
  if (existsSync(projectConfig)) {
    say(readFileSync(projectConfig, "utf8").includes("basketed"), "project .mcp.json is wired", projectConfig);
  }

  process.stdout.write("\nclients\n");
  for (const spec of CLIENTS.filter((c) => (PRIMARY_CLIENTS as readonly string[]).includes(c.id))) {
    if (!spec.path) continue;
    const path = expandPath(pathFor(spec, process.platform), process.cwd());
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";

    if (!text.includes("basketed")) {
      // Not installed is a thing to DO, not a thing that is broken. Reporting
      // it as a failure would make `doctor` cry wolf on a clean machine and
      // train people to ignore the one line that matters.
      process.stdout.write(
        `  --    ${spec.name.padEnd(15)} not installed — \`basketed install --client ${spec.id}\`\n`,
      );
      continue;
    }

    say(true, `${spec.name} is wired`, path);
    // Kiro's autoApprove would let a user silently pre-approve a tool call.
    // A money-adjacent tool in that list defeats the entire purchase gate.
    if (/autoApprove/.test(text) && /cart_prepare|purchase_confirm/.test(text)) {
      say(false, `${spec.name} autoApprove lists a money-adjacent tool`, "remove it — this defeats the approval gate");
    }
  }

  process.stdout.write(bad === 0 ? "\nAll checks passed.\n" : `\n${bad} check(s) failed.\n`);
  if (bad > 0) process.exitCode = 1;
}

function openBrowser(url: string): void {
  // Said out loud, because a tab appearing by itself should be explainable --
  // and because on stdio this line is the only trace a human could ever find.
  process.stderr.write(`[basketed] opening the panel in your browser (--no-open to stop that)\n`);
  const cmd =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  try {
    spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Not being able to open a browser is not a reason to fail to serve.
  }
}
