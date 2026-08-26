import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  createRuntime,
  createBasketedHttpHandler,
  serveBasketedStdio,
  toNodeHandler,
  SERVER_INFO,
  ALL_TOOL_NAMES,
} from "@basketed/mcp";
import { createPanelHandler, CLIENTS, PRIMARY_CLIENTS, pathFor, snippetFor } from "@basketed/control";
import { findRoot } from "./root.js";
import { installClient, findClient, expandPath } from "./install.js";

export { findRoot };
export * from "./install.js";

const USAGE = `basketed ${SERVER_INFO.version}

  basketed serve --stdio          MCP over stdio (Claude Code, Cursor, Codex, opencode)
  basketed serve --fast-mode      skip per-call confirmation for READ-ONLY tools only
  basketed serve --http [--port]  MCP over Streamable HTTP + control panel (port 8787)
  basketed serve --http --open    ...and open the panel in your browser
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

Environment:
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

  const runtime = await createRuntime({
    root,
    snapshots: flag(argv, "snapshots") || process.env["BASKETED_SNAPSHOTS"] === "1",
    fastMode: flag(argv, "fast-mode"),
  });

  if (!http) {
    // stdout belongs to the JSON-RPC stream from here on. Every diagnostic
    // in the whole process goes to stderr; one stray console.log corrupts the
    // stream and the client reports a parse error with no clue where it came from.
    process.stderr.write(
      `[basketed] stdio · ${runtime.summary} · root=${root}` +
        `${runtime.policy.fastMode ? " · fast-mode (read-only tools only)" : ""}\n`,
    );
    serveBasketedStdio(runtime);
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
  const panelUrl = (path: string) => `${origin}${path}?t=${panelToken}`;
  const handler = createBasketedHttpHandler(runtime);
  const node = toNodeHandler(handler, origin);

  if (!runtime.purchase) throw new Error("The purchase gate failed to initialise.");
  // Runtime satisfies ControlDeps structurally, so the panel needs no
  // dependency on the MCP package to be handed everything it renders.
  const panel = createPanelHandler(
    {
      purchase: runtime.purchase,
      registry: runtime.registry,
      principal: runtime.principal,
      policy: runtime.policy,
      ledger: runtime.ledger,
      summary: runtime.summary,
      version: SERVER_INFO.version,
      redactionAlarms: () => runtime.redactor.alarms(),
    },
    {
      root,
      binPath: resolve(root, "packages/cli/bin.js"),
      endpoint: `${origin}/mcp`,
      version: SERVER_INFO.version,
      token: panelToken,
    },
  );

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

  // 127.0.0.1, not 0.0.0.0: this process holds the approval surface and the
  // order history, and a localhost single-user build has no business being
  // reachable from the network.
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `[basketed] http · ${runtime.summary}` +
        `${runtime.policy.fastMode ? " · fast-mode (read-only tools only)" : ""}\n` +
        `[basketed] panel         ${panelUrl("/")}\n` +
        `[basketed] approvals     ${panelUrl("/approvals")}\n` +
        `[basketed] MCP endpoint  ${origin}/mcp\n` +
        `[basketed] health        ${origin}/healthz\n` +
        `[basketed] The panel links above carry a token good for this process only.\n` +
        `[basketed] Approval lives behind it, on this console, where no agent can read it.\n`,
    );
    if (flag(argv, "open")) openBrowser(panelUrl("/"));
  });
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
