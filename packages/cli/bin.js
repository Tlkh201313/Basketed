#!/usr/bin/env node
// node:sqlite is still flagged experimental. Its warning is noise on a
// transport where stderr is the only channel a human reads, so it is muted --
// and only it; every other warning still surfaces.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return emit.call(process, warning, ...rest);
};

const { main } = await import("./dist/index.js");

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[basketed] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
