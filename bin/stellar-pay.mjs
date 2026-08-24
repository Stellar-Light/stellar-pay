#!/usr/bin/env node
// Launcher for `stellar-pay …`.
//
// A published install runs the compiled CLI in dist/ directly — no TypeScript
// loader needed at runtime. A source checkout (where dist/ may not be built)
// falls back to running src/cli.ts through tsx, so `npm link` keeps working
// while you edit.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "dist", "cli.js");
const args = process.argv.slice(2);

if (existsSync(built)) {
	const r = spawnSync(process.execPath, [built, ...args], { stdio: "inherit" });
	process.exit(r.status ?? 1);
}

const tsx = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
if (!existsSync(tsx)) {
	console.error(
		"stellar-pay: no dist/ build and no tsx to run the sources.\n" +
			"  from a checkout:  npm install && npm run build",
	);
	process.exit(1);
}
const r = spawnSync(
	process.execPath,
	[tsx, join(here, "..", "src", "cli.ts"), ...args],
	{ stdio: "inherit" },
);
process.exit(r.status ?? 1);
