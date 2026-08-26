import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { CLIENTS, pathFor, snippetFor, type ClientSpec } from "@basketed/control";

/**
 * `basketed install` (§7b).
 *
 * Everything here is driven by the one variance table in `@basketed/control`,
 * the same table the panel renders from — so the installer, the copy blocks and
 * the badges cannot disagree about where a config file lives or what its key is
 * called. That matters more than it sounds: almost every exception in that
 * table fails SILENTLY. A wrong key name does not raise an error, it just means
 * your server never appears, and you spend an hour looking in the wrong place.
 *
 * The write is merge-then-replace, never overwrite. Users have existing MCP
 * servers configured, and clobbering someone's ~/.claude.json would be a
 * serious bug — and it is the default behaviour if you write this carelessly.
 */

export interface InstallOptions {
  /** Absolute path to packages/cli/bin.js. */
  binPath: string;
  /** Where the config file goes, if the caller wants to override discovery. */
  path?: string;
  dryRun: boolean;
  /** Project-scoped clients resolve relative paths against this. */
  cwd: string;
}

export interface InstallReport {
  client: string;
  path: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "manual";
  backup?: string;
  note?: string;
  /** What the file will look like, for --dry-run. */
  preview?: string;
}

/* ------------------------------------------------------------------ paths */

/** `~`, `%USERPROFILE%` and `%APPDATA%` are expanded here, never by a shell. */
export function expandPath(raw: string, cwd: string): string {
  let p = raw;
  if (p.startsWith("~/") || p === "~") p = join(homedir(), p.slice(1));
  p = p.replace(/%USERPROFILE%/gi, homedir());
  p = p.replace(/%APPDATA%/gi, process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"));
  p = p.replace(/%LOCALAPPDATA%/gi, process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"));
  // A project-scoped path like `.vscode/mcp.json` resolves against the project,
  // not the home directory.
  return resolve(cwd, p);
}

/* ------------------------------------------------------------------ merge */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge that preserves every key it did not come to change. */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? mergeInto(out[k], v) : v;
  }
  return out;
}

/**
 * Strip `//` and `/* *\/` comments so JSONC parses.
 *
 * Comments inside the file are LOST on write, which is why this is used only
 * for opencode — the one JSONC target — and why the backup is written first.
 */
function stripJsonc(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/**
 * Splice one TOML section, leaving the rest of the file byte-identical.
 *
 * Deliberately not a TOML parser: round-tripping TOML loses comments and
 * reorders keys, and Codex's config is a file people hand-edit. Replacing one
 * `[section]` block by text is both smaller and less destructive.
 */
function spliceTomlSection(existing: string, header: string, block: string): string {
  const lines = existing.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) {
    const sep = existing.trim().length ? "\n\n" : "";
    return `${existing.trimEnd()}${sep}${block}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end += 1;
  return [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end)].join("\n");
}

/* ------------------------------------------------------------------ write */

function backupOf(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.basketed-backup-${stamp}`;
}

/** Write via a temp file and rename, so a crash mid-write cannot truncate. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.basketed-tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** A compact "what changed" so nothing is written silently. */
export function diffLines(before: string, after: string): string[] {
  const a = new Set(before.split(/\r?\n/));
  const out: string[] = [];
  for (const line of after.split(/\r?\n/)) {
    if (!a.has(line) && line.trim()) out.push(`+ ${line}`);
  }
  return out.slice(0, 40);
}

/* ---------------------------------------------------------------- install */

export function installClient(spec: ClientSpec, opts: InstallOptions): InstallReport {
  const snippet = snippetFor(spec, {
    binPath: opts.binPath,
    endpoint: "http://127.0.0.1:8787/mcp",
    platform: process.platform,
  });

  if (spec.format === "ui" || !spec.path) {
    return {
      client: spec.id,
      path: pathFor(spec, process.platform),
      action: "manual",
      note: "No file on disk. Paste this into the IDE's MCP settings panel.",
      preview: snippet,
    };
  }

  if (spec.format === "yaml") {
    // Goose's config is YAML and merging it properly needs a YAML round-trip we
    // are not shipping today. Saying so beats writing a file we cannot promise
    // preserves the user's other extensions.
    return {
      client: spec.id,
      path: expandPath(pathFor(spec, process.platform), opts.cwd),
      action: "manual",
      note: "YAML merge is not automated. Paste this under the existing `extensions:` key.",
      preview: snippet,
    };
  }

  const path = opts.path ? resolve(opts.cwd, opts.path) : expandPath(pathFor(spec, process.platform), opts.cwd);
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, "utf8") : "";

  let after: string;
  if (spec.format === "toml") {
    after = spliceTomlSection(before, "[mcp_servers.basketed]", snippet);
  } else {
    let current: Record<string, unknown> = {};
    if (existed && before.trim()) {
      try {
        current = JSON.parse(spec.format === "jsonc" ? stripJsonc(before) : before) as Record<string, unknown>;
      } catch (err) {
        // Refuse rather than guess. Replacing a file we could not read would
        // destroy whatever the user actually had in it.
        return {
          client: spec.id,
          path,
          action: "skipped",
          note: `Existing file is not valid ${spec.format.toUpperCase()} (${(err as Error).message}). Not touching it.`,
          preview: snippet,
        };
      }
    }
    after = `${JSON.stringify(mergeInto(current, JSON.parse(snippet) as Record<string, unknown>), null, 2)}\n`;
  }

  if (before === after) return { client: spec.id, path, action: "unchanged" };
  if (opts.dryRun) {
    return { client: spec.id, path, action: existed ? "updated" : "created", preview: diffLines(before, after).join("\n") };
  }

  let backup: string | undefined;
  if (existed) {
    backup = backupOf(path);
    copyFileSync(path, backup);
  }
  writeAtomic(path, after);

  return {
    client: spec.id,
    path,
    action: existed ? "updated" : "created",
    ...(backup ? { backup } : {}),
    preview: diffLines(before, after).join("\n"),
  };
}

export function findClient(id: string): ClientSpec | undefined {
  return CLIENTS.find((c) => c.id === id || c.name.toLowerCase() === id.toLowerCase());
}
