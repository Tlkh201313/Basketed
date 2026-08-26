import { createServer } from "node:http";
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
import { createPanelHandler } from "@basketed/control";
import { findRoot } from "./root.js";

export { findRoot };

const USAGE = `basketed ${SERVER_INFO.version}

  basketed serve --stdio          MCP over stdio (Claude Code, Cursor, Codex, opencode)
  basketed serve --fast-mode      skip per-call confirmation for READ-ONLY tools only
  basketed serve --http [--port]  MCP over Streamable HTTP + control panel (port 8787)
  basketed serve --http --open    ...and open the panel in your browser
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
    { root, binPath: resolve(root, "packages/cli/bin.js"), endpoint: `${origin}/mcp`, version: SERVER_INFO.version },
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

  // 127.0.0.1, not 0.0.0.0: this process holds the vault, and a localhost
  // single-user build has no business being reachable from the network.
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `[basketed] http · ${runtime.summary}` +
        `${runtime.policy.fastMode ? " · fast-mode (read-only tools only)" : ""}\n` +
        `[basketed] panel         ${origin}/\n` +
        `[basketed] approvals     ${origin}/approvals\n` +
        `[basketed] MCP endpoint  ${origin}/mcp\n` +
        `[basketed] health        ${origin}/healthz\n`,
    );
    if (flag(argv, "open")) openBrowser(origin);
  });
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
