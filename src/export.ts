/**
 * Mongo → catalog.json, the trimmed snapshot the MCP and CLI read through
 * `gh` so nobody needs the connection string to USE the catalog.
 *   npm run export            # writes ./catalog.json
 */
import { writeFile } from "node:fs/promises";
import { fromMongo } from "./catalog.js";

const entries = await fromMongo();
await writeFile("catalog.json", JSON.stringify(entries));
console.log(
	`catalog.json: ${entries.length} rows, ${entries.filter((e) => e.acceptsStellar && e.lastStatus === "402").length} live and Stellar-payable`,
);
