/**
 * The client variance table (§7b).
 *
 * ONE table drives the install snippets on the panel, the badges beside them,
 * and (S7) `basketed install`. There is no per-client bespoke code anywhere, so
 * the three surfaces cannot drift apart and disagree about where a config file
 * lives — which they would, because almost every exception below fails
 * SILENTLY rather than with an error. A wrong key name does not crash a client;
 * it just means your server never appears.
 */

export type ConfigFormat = "json" | "jsonc" | "toml" | "yaml" | "ui";

export interface ClientSpec {
  id: string;
  name: string;
  /** Where the config lives. `~` is expanded by the writer, not by the shell. */
  path: { win32: string; darwin: string; linux: string } | null;
  /** The key the server list hangs off. The near-universal one is `mcpServers`. */
  key: string;
  format: ConfigFormat;
  /** Stdio, remote, or both. */
  transports: Array<"stdio" | "http">;
  /** The one thing that will silently break this client if you get it wrong. */
  gotcha?: string;
  /** A one-liner the user can paste, when the client has one. */
  command?: string;
  verified: boolean;
}

/** The four we click through on stage. Verified on Windows at S7 start. */
export const PRIMARY_CLIENTS = ["claude-code", "cursor", "codex", "claude-desktop"] as const;

export const CLIENT_ALIASES: Record<string, string> = { grok: "opencode" };

export const CLIENTS: ClientSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    path: { win32: "%USERPROFILE%\\.claude.json", darwin: "~/.claude.json", linux: "~/.claude.json" },
    key: "mcpServers",
    format: "json",
    transports: ["stdio", "http"],
    gotcha: "A remote entry with a `url` but no `type` is a hard error, not a warning.",
    command: "claude mcp add basketed -- node <path>/packages/cli/bin.js serve --stdio",
    verified: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    path: { win32: "%USERPROFILE%\\.cursor\\mcp.json", darwin: "~/.cursor/mcp.json", linux: "~/.cursor/mcp.json" },
    key: "mcpServers",
    format: "json",
    transports: ["stdio", "http"],
    gotcha: "Supports MCP elicitation, which is where approval channel B would live. Channel B is not built; use the panel or the console code.",
    verified: true,
  },
  {
    id: "codex",
    name: "Codex CLI",
    path: { win32: "%USERPROFILE%\\.codex\\config.toml", darwin: "~/.codex/config.toml", linux: "~/.codex/config.toml" },
    key: "mcp_servers",
    format: "toml",
    transports: ["stdio"],
    gotcha: "The only TOML target. Section header is `[mcp_servers.basketed]`, with an underscore.",
    verified: true,
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    path: {
      win32: "%APPDATA%\\Claude\\claude_desktop_config.json",
      darwin: "~/Library/Application Support/Claude/claude_desktop_config.json",
      linux: "~/.config/Claude/claude_desktop_config.json",
    },
    key: "mcpServers",
    format: "json",
    transports: ["stdio"],
    gotcha: "Remote servers only through Settings → Connectors. Local is the supported path here.",
    verified: true,
  },
  {
    id: "vscode",
    name: "VS Code / Copilot",
    path: { win32: ".vscode\\mcp.json", darwin: ".vscode/mcp.json", linux: ".vscode/mcp.json" },
    key: "servers",
    format: "json",
    transports: ["stdio", "http"],
    gotcha: "The key is `servers`, NOT `mcpServers`. Everything else looks identical.",
    command: "code --add-mcp '{\"name\":\"basketed\",\"command\":\"node\",\"args\":[\"packages/cli/bin.js\",\"serve\",\"--stdio\"]}'",
    verified: false,
  },
  {
    id: "opencode",
    name: "opencode",
    path: { win32: "opencode.json", darwin: "opencode.json", linux: "opencode.json" },
    key: "mcp",
    format: "jsonc",
    transports: ["stdio", "http"],
    gotcha: "Key is `mcp`, `command` is an ARRAY, and the env key is `environment`.",
    verified: false,
  },
  {
    id: "kiro",
    name: "Kiro",
    path: { win32: ".kiro\\settings\\mcp.json", darwin: ".kiro/settings/mcp.json", linux: ".kiro/settings/mcp.json" },
    key: "mcpServers",
    format: "json",
    transports: ["stdio"],
    gotcha:
      "Has `autoApprove`. Our generated config lists ONLY read-only tools there — never cart_prepare or purchase_confirm.",
    verified: false,
  },
  {
    id: "zed",
    name: "Zed",
    path: { win32: "%APPDATA%\\Zed\\settings.json", darwin: "~/.config/zed/settings.json", linux: "~/.config/zed/settings.json" },
    key: "context_servers",
    format: "json",
    transports: ["stdio"],
    gotcha: "The key is `context_servers`.",
    verified: false,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    path: {
      win32: "%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json",
      darwin: "~/.codeium/windsurf/mcp_config.json",
      linux: "~/.codeium/windsurf/mcp_config.json",
    },
    key: "mcpServers",
    format: "json",
    transports: ["stdio", "http"],
    gotcha: "Uses `serverUrl` for remote, and caps at 100 tools across ALL servers. We add 8.",
    verified: false,
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    path: { win32: "%USERPROFILE%\\.gemini\\settings.json", darwin: "~/.gemini/settings.json", linux: "~/.gemini/settings.json" },
    key: "mcpServers",
    format: "json",
    transports: ["stdio", "http"],
    gotcha: "`httpUrl` for Streamable HTTP; plain `url` means SSE.",
    verified: false,
  },
  {
    id: "goose",
    name: "Goose",
    path: { win32: "%APPDATA%\\goose\\config.yaml", darwin: "~/.config/goose/config.yaml", linux: "~/.config/goose/config.yaml" },
    key: "extensions",
    format: "yaml",
    transports: ["stdio", "http"],
    gotcha: "Uses `uri` not `url`, and `streamable_http` with an underscore.",
    verified: false,
  },
  {
    id: "warp",
    name: "Warp",
    path: { win32: "%USERPROFILE%\\.warp\\.mcp.json", darwin: "~/.warp/.mcp.json", linux: "~/.warp/.mcp.json" },
    key: "mcpServers",
    format: "json",
    transports: ["stdio", "http"],
    gotcha: "Also auto-reads ~/.claude.json and ~/.codex/config.toml — install either of those and Warp is free.",
    verified: false,
  },
  {
    id: "jetbrains",
    name: "JetBrains IDEs",
    path: null,
    key: "mcpServers",
    format: "ui",
    transports: ["stdio"],
    gotcha: "No file on disk. Paste the JSON into the IDE's MCP settings panel.",
    verified: false,
  },
];

export interface SnippetInput {
  /** Absolute path to `packages/cli/bin.js` on this machine. */
  binPath: string;
  /** e.g. http://127.0.0.1:8787/mcp, or null when this process serves stdio. */
  endpoint: string | null;
  platform: NodeJS.Platform;
}

/**
 * Render the config a client needs, in that client's own format.
 *
 * Windows gets no `cmd /c` wrapper here on purpose: we invoke `node` against an
 * absolute script path rather than an `npx` shim, so there is no `.cmd` shim to
 * resolve and nothing for the shell to expand.
 */
export function snippetFor(client: ClientSpec, input: SnippetInput): string {
  const args = [input.binPath, "serve", "--stdio"];

  switch (client.format) {
    case "toml":
      return [
        "[mcp_servers.basketed]",
        'command = "node"',
        `args = ${JSON.stringify(args)}`,
      ].join("\n");

    case "yaml":
      return [
        "extensions:",
        "  basketed:",
        "    enabled: true",
        "    type: stdio",
        "    cmd: node",
        "    args:",
        ...args.map((a) => `      - ${JSON.stringify(a)}`),
      ].join("\n");

    case "jsonc":
      return JSON.stringify(
        { mcp: { basketed: { type: "local", command: ["node", ...args], enabled: true } } },
        null,
        2,
      );

    default: {
      const entry: Record<string, unknown> = { command: "node", args };
      if (client.id === "claude-code") entry["type"] = "stdio";
      if (client.id === "kiro") {
        // Read-only tools only. Pre-approving a money-adjacent tool is exactly
        // the thing the purchase gate exists to prevent.
        entry["autoApprove"] = [
          "basket_list_stores",
          "basket_search_products",
          "basket_get_product_detail",
          "basket_get_token_report",
        ];
      }
      return JSON.stringify({ [client.key]: { basketed: entry } }, null, 2);
    }
  }
}

export function pathFor(client: ClientSpec, platform: NodeJS.Platform): string {
  if (!client.path) return "IDE settings panel — paste, no file";
  if (platform === "win32") return client.path.win32;
  if (platform === "darwin") return client.path.darwin;
  return client.path.linux;
}
