#!/usr/bin/env node
// Launcher so `stellar-pay …` works after `npm install` (via npm link / npx).
// The CLI is TypeScript run through tsx — no build step.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(here, "..", "src", "cli.ts");
const r = spawnSync(process.execPath, [tsx, cli, ...process.argv.slice(2)], {
	stdio: "inherit",
});
process.exit(r.status ?? 0);
