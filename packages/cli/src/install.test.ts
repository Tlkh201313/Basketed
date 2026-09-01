import { describe, expect, it } from "vitest";
import { CLIENTS, CLIENT_ALIASES, PRIMARY_CLIENTS, pathFor, snippetFor } from "@basketed/control";
import { TOOL_NAMES, NEVER_ALLOW } from "@basketed/mcp";
import { findClient, resolveTargets, expandPath } from "./install.js";

/**
 * Which clients `basketed install` actually installs into.
 *
 * The bug this covers was silent and therefore expensive: `basketed install
 * opencode` read only `--client`, ignored the positional entirely, and wrote
 * the four PRIMARY_CLIENTS instead. It printed success. The client the user
 * named was never touched, and they went looking for a broken MCP server
 * rather than a config that was never written.
 */
describe("resolveTargets", () => {
  it("installs the four primaries when nobody named anything", () => {
    const t = resolveTargets([]);
    expect(t.ok).toBe(true);
    expect(t.ok && t.targets.map((c) => c.id)).toEqual([...PRIMARY_CLIENTS]);
  });

  it("takes a client as a bare word, the way everyone types it", () => {
    const t = resolveTargets(["opencode"]);
    expect(t.ok && t.targets.map((c) => c.id)).toEqual(["opencode"]);
  });

  it("still takes --client, which is what the help text has always said", () => {
    const t = resolveTargets(["--client", "zed"]);
    expect(t.ok && t.targets.map((c) => c.id)).toEqual(["zed"]);
  });

  it("takes several at once", () => {
    const t = resolveTargets(["codex", "cursor", "zed"]);
    expect(t.ok && t.targets.map((c) => c.id)).toEqual(["codex", "cursor", "zed"]);
  });

  it("REFUSES a name it does not know instead of installing something else", () => {
    const t = resolveTargets(["emacs"]);
    expect(t.ok).toBe(false);
    expect(!t.ok && t.unknown).toEqual(["emacs"]);
  });

  it("refuses the whole run if one name of several is unknown", () => {
    // Half-installing and reporting success is how the original bug felt.
    const t = resolveTargets(["codex", "nvim"]);
    expect(t.ok).toBe(false);
    expect(!t.ok && t.unknown).toEqual(["nvim"]);
  });

  it("--all means every client with a config file we know", () => {
    const t = resolveTargets(["--all"]);
    expect(t.ok && t.targets.length).toBe(CLIENTS.length);
  });

  it("does not mistake a flag or its value for a client name", () => {
    const t = resolveTargets(["--dry-run", "--path", "some/file.json"]);
    expect(t.ok && t.targets.map((c) => c.id)).toEqual([...PRIMARY_CLIENTS]);
  });

  it("resolves every alias to a client that exists", () => {
    for (const [alias, target] of Object.entries(CLIENT_ALIASES)) {
      expect(findClient(alias), `alias ${alias} -> ${target}`).toBeDefined();
    }
  });

  it("knows every CLI by the name its users call it", () => {
    // Each of these is a name someone will type at the prompt. A miss here is
    // the silent-wrong-install bug all over again.
    for (const name of ["claude", "claude-code", "cursor", "codex", "opencode", "grok", "windsurf", "zed", "gemini"]) {
      expect(findClient(name), `no client answers to "${name}"`).toBeDefined();
    }
  });
});

/**
 * The config we write has to be usable from wherever the user actually works.
 *
 * A config written into the Basketed checkout is a config that works in
 * exactly one directory -- the one nobody shops from.
 */
describe("where each client's config lands", () => {
  it("puts every CLI's config somewhere global, not in whatever repo you ran it from", () => {
    // VS Code and Kiro are workspace-scoped BY DESIGN (they configure a
    // project), so they are named here rather than silently exempted.
    const workspaceScoped = new Set(["vscode", "kiro"]);
    for (const c of CLIENTS) {
      if (!c.path || workspaceScoped.has(c.id)) continue;
      for (const platform of ["win32", "darwin", "linux"] as const) {
        const p = pathFor(c, platform);
        expect(
          /^(~|%USERPROFILE%|%APPDATA%|\/)/.test(p),
          `${c.id} on ${platform} writes to a relative path (${p}) -- it would land in the current repo`,
        ).toBe(true);
      }
    }
  });

  it("keeps every separator in the path -- a lost backslash is a silent wrong file", () => {
    /*
     * This caught a real one. A Windows path written into the table with
     * single backslashes is read by TypeScript as escape sequences, so
     * "%USERPROFILE%\.config\opencode\opencode.json" became
     * "C:\Users\me.configopencodeopencode.json" -- one nonsense filename
     * in the home directory, written without complaint.
     */
    for (const c of CLIENTS) {
      if (!c.path) continue;
      for (const platform of ["win32", "darwin", "linux"] as const) {
        const template = pathFor(c, platform);
        const expanded = expandPath(template, "/cwd");
        const leaf = template.split(/[\\/]/).pop()!;
        expect(expanded.endsWith(leaf), `${c.id}/${platform}: "${template}" expanded to "${expanded}"`).toBe(true);
        // Every segment the template asked for is still a segment.
        const wanted = template.replace(/^%[A-Z_]+%|^~/, "").split(/[\\/]/).filter(Boolean);
        for (const segment of wanted) {
          expect(expanded.includes(segment), `${c.id}/${platform} lost the "${segment}" segment`).toBe(true);
        }
      }
    }
  });
});

/**
 * Kiro pre-approves whatever is in `autoApprove`, with no human in the loop.
 * A money-adjacent name in that list would silently defeat the purchase gate,
 * so the list is checked against the real tool tables rather than eyeballed.
 */
describe("Kiro's autoApprove list", () => {
  const kiro = CLIENTS.find((c) => c.id === "kiro")!;
  const approved = (
    JSON.parse(snippetFor(kiro, { binPath: "/bin.js", endpoint: null, platform: "linux" })) as {
      mcpServers: { basketed: { autoApprove?: string[] } };
    }
  ).mcpServers.basketed.autoApprove!;

  it("pre-approves nothing that can never be auto-confirmed", () => {
    for (const name of NEVER_ALLOW) expect(approved).not.toContain(name);
  });

  it("covers exactly the read-only tools, so a new one is not silently left out", () => {
    expect([...approved].sort()).toEqual([...TOOL_NAMES].sort());
  });
});
