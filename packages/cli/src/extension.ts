import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readExtensionSeen } from "@basketed/control";

/**
 * `basketed extension` — where the browser extension is, and how to load it.
 *
 * This command exists because the extension was, until now, the one required
 * piece of Basketed with no command anywhere that mentioned it. `install`
 * writes MCP client configs; `doctor` checked everything except this; the only
 * instructions lived in a README linked from a panel notice that appears AFTER
 * a connect has already failed. A user whose Connect silently did nothing had
 * no way to find out why, and the answer was always the same: the extension is
 * not loaded.
 *
 * There is no way to install it FOR them, and pretending otherwise would be a
 * lie in a command's mouth. Chrome deliberately refuses to load an unpacked
 * extension from anywhere but a human at chrome://extensions -- that refusal
 * is a security property and Basketed is not going to try to route around it.
 * So this command does the honest maximum: it prints the exact absolute path
 * to paste, the exact page to paste it on for the browser families that can
 * take it, and whether the thing has ever actually reported in.
 */

interface Browser {
  name: string;
  page: string;
}

/*
 * Chromium only, and said so out loud. The extension is MV3 and leans on
 * `chrome.webRequest.onSendHeaders` in observe-only mode plus
 * `chrome.storage.session`; Firefox's MV3 differs on both, so listing it here
 * would send someone to a page that cannot load this folder.
 */
const BROWSERS: readonly Browser[] = [
  { name: "Chrome", page: "chrome://extensions" },
  { name: "Edge", page: "edge://extensions" },
  { name: "Brave", page: "brave://extensions" },
  { name: "Vivaldi", page: "vivaldi://extensions" },
  { name: "Opera", page: "opera://extensions" },
];

function manifestVersion(dir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

function ago(then: number, now: number): string {
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function runExtension(root: string, now = Date.now()): void {
  const out = (line = "") => process.stdout.write(`${line}\n`);
  const dir = resolve(root, "packages/extension");
  const there = existsSync(resolve(dir, "manifest.json"));
  const version = manifestVersion(dir);

  out(`basketed extension${version ? ` ${version}` : ""}`);
  out();

  if (!there) {
    out(`  Not found at ${dir}`);
    out(`  This looks like a partial checkout — the extension ships in the repo,`);
    out(`  not on a store. Pull the full tree and run this again.`);
    process.exitCode = 1;
    return;
  }

  const seen = readExtensionSeen();
  if (seen) {
    out(`  Loaded${seen.version ? ` (v${seen.version})` : ""} — it last spoke to a panel ${ago(seen.seenAt, now)}.`);
    if (version && seen.version && seen.version !== version) {
      out(`  That is not this build (v${version}). Press the reload arrow on the`);
      out(`  extension's card to pick up the newer one.`);
    }
    out();
  } else {
    // Absence is not proof: the extension may be loaded in a browser that has
    // not opened the panel yet. Say what is actually known.
    out(`  No browser has reported this extension to a Basketed panel yet.`);
    out(`  If you have already loaded it, open the panel once and it will.`);
    out();
  }

  out(`  Load this folder:`);
  out();
  out(`    ${dir}`);
  out();
  out(`  In ${BROWSERS.map((b) => b.name).join(", ")}:`);
  out(`    1. Open ${BROWSERS[0]!.page}  (${BROWSERS.slice(1).map((b) => b.page).join(", ")})`);
  out(`    2. Turn on "Developer mode"`);
  out(`    3. "Load unpacked" -> pick the folder above`);
  out();
  out(`  Then open the panel and press Connect. Chrome will not let a program`);
  out(`  load this for you — that refusal is the reason your session is safe`);
  out(`  from every other program on this machine, so it is one to keep.`);
  out();
  out(`  What it may do: read cookies for the retailers you connect, and watch`);
  out(`  request headers for the one API whose headers ARE the credential. It`);
  out(`  talks to 127.0.0.1 only, and only to a page holding this panel's token.`);
}
