#!/usr/bin/env node
/**
 * The install writers, against throwaway files (§7b).
 *
 * The property under test is the one that would be a SERIOUS bug to get wrong:
 * users already have MCP servers configured, and merge-not-overwrite is not the
 * default behaviour — it is what you get only if you write this carefully. So
 * every case below starts from a populated config and asserts the other
 * servers, and the unrelated top-level keys, are all still there afterwards.
 *
 * Runs against temp files. It never touches a real client config.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { installClient, findClient, expandPath, diffLines } from "../packages/cli/dist/install.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = mkdtempSync(join(tmpdir(), "basketed-install-"));
const BIN = resolve(ROOT, "packages/cli/bin.js");

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

const opts = (path, dryRun = false) => ({ binPath: BIN, path, dryRun, cwd: DIR });

try {
  console.log("\n── merge, never overwrite ─────────────────────────────────────────");

  const claude = join(DIR, "claude.json");
  writeFileSync(
    claude,
    JSON.stringify(
      {
        numStartups: 41,
        theme: "dark",
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
        },
      },
      null,
      2,
    ),
  );

  const r1 = installClient(findClient("claude-code"), opts(claude));
  const after = JSON.parse(readFileSync(claude, "utf8"));
  check("wrote the entry", r1.action === "updated" && Boolean(after.mcpServers.basketed));
  check("kept the other server", Boolean(after.mcpServers.filesystem), "filesystem survived");
  check("kept unrelated top-level keys", after.numStartups === 41 && after.theme === "dark");
  check("backed the file up first", Boolean(r1.backup) && readdirSync(DIR).some((f) => f.includes("backup")));
  check("Claude Code gets an explicit type", after.mcpServers.basketed.type === "stdio", "a url with no type is a hard error there");
  check("the command is node against an absolute path", after.mcpServers.basketed.command === "node" && after.mcpServers.basketed.args[0] === BIN);

  const r2 = installClient(findClient("claude-code"), opts(claude));
  check("re-running is a no-op", r2.action === "unchanged", "idempotent, and no second backup");

  console.log("\n── the per-client exceptions that fail silently ───────────────────");

  const vscode = join(DIR, "vscode.json");
  writeFileSync(vscode, JSON.stringify({ servers: { other: { command: "x" } } }, null, 2));
  installClient(findClient("vscode"), opts(vscode));
  const vs = JSON.parse(readFileSync(vscode, "utf8"));
  check("VS Code uses `servers`, not `mcpServers`", Boolean(vs.servers?.basketed) && !vs.mcpServers, Object.keys(vs).join(", "));
  check("VS Code kept its other server", Boolean(vs.servers.other));

  const zed = join(DIR, "zed.json");
  installClient(findClient("zed"), opts(zed));
  check("Zed uses `context_servers`", Boolean(JSON.parse(readFileSync(zed, "utf8")).context_servers?.basketed));

  const oc = join(DIR, "opencode.json");
  writeFileSync(oc, '{\n  // a comment the user wrote\n  "mcp": { "other": { "type": "local" } }\n}');
  installClient(findClient("opencode"), opts(oc));
  const ocj = JSON.parse(readFileSync(oc, "utf8"));
  check("opencode parses JSONC and keeps `mcp`", Boolean(ocj.mcp?.basketed) && Boolean(ocj.mcp?.other));
  check("opencode `command` is an array", Array.isArray(ocj.mcp.basketed.command), JSON.stringify(ocj.mcp.basketed.command));

  const kiro = join(DIR, "kiro.json");
  installClient(findClient("kiro"), opts(kiro));
  const auto = JSON.parse(readFileSync(kiro, "utf8")).mcpServers.basketed.autoApprove;
  check("Kiro autoApprove lists only read-only tools", Array.isArray(auto) && auto.length === 4);
  check(
    "Kiro autoApprove NEVER lists a money-adjacent tool",
    !auto.some((t) => /cart_prepare|purchase_confirm/.test(t)),
    "pre-approving those would defeat the whole gate",
  );

  console.log("\n── TOML is spliced, not re-serialised ─────────────────────────────");

  const toml = join(DIR, "config.toml");
  writeFileSync(
    toml,
    ['# my codex config', 'model = "gpt-5"', "", "[mcp_servers.other]", 'command = "npx"', ""].join("\n"),
  );
  installClient(findClient("codex"), opts(toml));
  const t = readFileSync(toml, "utf8");
  check("comment survived", t.includes("# my codex config"), "a TOML round-trip would have eaten it");
  check("unrelated keys survived", t.includes('model = "gpt-5"') && t.includes("[mcp_servers.other]"));
  check("section header uses an underscore", t.includes("[mcp_servers.basketed]"));

  // Replacing an existing section must not duplicate it.
  installClient(findClient("codex"), opts(toml));
  check("re-running does not duplicate the section", (readFileSync(toml, "utf8").match(/\[mcp_servers\.basketed\]/g) ?? []).length === 1);

  console.log("\n── refusals ───────────────────────────────────────────────────────");

  const broken = join(DIR, "broken.json");
  writeFileSync(broken, "{ this is not json ");
  const r3 = installClient(findClient("cursor"), opts(broken));
  check("an unparseable config is refused, not replaced", r3.action === "skipped", r3.note?.slice(0, 46));
  check("...and left byte-identical", readFileSync(broken, "utf8") === "{ this is not json ");

  const r4 = installClient(findClient("jetbrains"), opts(join(DIR, "unused.json")));
  check("a UI-only client reports manual", r4.action === "manual");

  const r5 = installClient(findClient("goose"), opts(join(DIR, "goose.yaml")));
  check("YAML says so rather than writing a merge it cannot promise", r5.action === "manual", r5.note?.slice(0, 40));

  const dry = join(DIR, "dry.json");
  installClient(findClient("cursor"), opts(dry, true));
  check("--dry-run writes nothing", !readdirSync(DIR).includes("dry.json"));

  console.log("\n── paths ──────────────────────────────────────────────────────────");

  const home = expandPath("~/x", DIR);
  check("~ expands to the home directory", !home.includes("~") && home.endsWith("x"), home);
  check("%USERPROFILE% expands", !expandPath("%USERPROFILE%\\y", DIR).includes("%"));
  check("a project-scoped path resolves against cwd, not home", expandPath(".vscode/mcp.json", DIR).startsWith(DIR));
  check("diffLines reports only what is new", diffLines("a\nb", "a\nb\nc").join("") === "+ c");
} finally {
  rmSync(DIR, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nInstall writers verified on this platform.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
