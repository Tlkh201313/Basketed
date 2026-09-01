#!/usr/bin/env node
// node:sqlite is still flagged experimental. Its warning is noise on a
// transport where stderr is the only channel a human reads, so it is muted --
// and only it; every other warning still surfaces.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return emit.call(process, warning, ...rest);
};

/**
 * A fresh clone has no `dist/`, and the raw failure is
 * `ERR_MODULE_NOT_FOUND: Cannot find module .../dist/index.js` -- which reads
 * like a broken install rather than an unbuilt one, and sends people to
 * reinstall dependencies that were never the problem. So the missing build is
 * caught here and named.
 *
 * Exit 3, not 1: a wrapper script can tell "you have not built this yet" from
 * "the command you ran failed".
 */
const { existsSync } = await import("node:fs");
const { dirname, resolve } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "dist/index.js");

if (!existsSync(ENTRY)) {
  process.stderr.write(
    "[basketed] this checkout has not been built yet -- packages/cli/dist is missing.\n" +
      "[basketed] Build it once, from the repo root:\n" +
      "[basketed]\n" +
      "[basketed]     pnpm install && pnpm build\n" +
      "[basketed]\n" +
      "[basketed] Then run this command again.\n",
  );
  process.exit(3);
}

const { main } = await import("./dist/index.js");

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[basketed] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
