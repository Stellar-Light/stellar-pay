/**
 * Mongo → catalog.json, the trimmed snapshot the MCP and CLI read.
 *   npm run export            # writes ./catalog.json
 *
 * SIZE IS A CORRECTNESS CONCERN, not housekeeping. The snapshot is served
 * through GitHub's contents API, which hard-fails over 1 MB — so an unbounded
 * export would one day break the public feed for every user at once, remotely
 * triggerable by anyone who can add rows to the index. This writes the rows
 * that back the claim, trims long free text, and refuses to publish a file
 * that would break the reader.
 */
import { writeFile } from "node:fs/promises";
import { type Entry, fromMongo } from "./catalog.js";

/** GitHub's contents API refuses to serve a blob above this. */
const HARD_LIMIT = 1_000_000;
/** Leave room for the feed to grow between deploys. */
const WARN_AT = 700_000;

const all = await fromMongo();

// Long descriptions are the only unbounded field an endpoint controls.
const trim = (e: Entry): Entry => ({
	...e,
	title: e.title?.slice(0, 200) ?? e.title,
	description: e.description?.slice(0, 500) ?? e.description,
});

const live = all.filter((e) => e.acceptsStellar && e.lastStatus === "402");
// Dead rows carry the history that makes liveness meaningful, so keep the
// freshest of them — but never at the cost of the live ones.
const dead = all
	.filter((e) => !(e.acceptsStellar && e.lastStatus === "402"))
	.sort((a, b) => (b.lastCheckedAt ?? "").localeCompare(a.lastCheckedAt ?? ""));

let rows = [...live, ...dead].map(trim);
let json = JSON.stringify(rows);
let dropped = 0;
while (json.length > WARN_AT && rows.length > live.length) {
	// Shed the stalest dead rows first; the live set is the product.
	rows = rows.slice(0, rows.length - 1);
	dropped++;
	json = JSON.stringify(rows);
}

if (json.length > HARD_LIMIT) {
	console.error(
		`catalog.json is ${json.length} bytes — over GitHub's ${HARD_LIMIT} contents limit even after dropping every dead row. Refusing to publish a snapshot the client cannot read.`,
	);
	process.exit(1);
}

await writeFile("catalog.json", json);
console.log(
	`catalog.json: ${rows.length} rows (${live.length} live and Stellar-payable${
		dropped ? `, ${dropped} stale dead rows dropped for size` : ""
	}), ${(json.length / 1024).toFixed(0)} KB of a ${(HARD_LIMIT / 1024).toFixed(0)} KB ceiling`,
);
if (json.length > WARN_AT)
	console.warn(
		`WARNING: within ${((HARD_LIMIT - json.length) / 1024).toFixed(0)} KB of the limit that breaks the public feed`,
	);
