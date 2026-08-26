#!/usr/bin/env node
import { main } from "./dist/index.js";

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[basketed] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
