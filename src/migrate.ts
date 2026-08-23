/**
 * One-off: carry the 209 rows written while the index briefly lived inside
 * stellarlight into this repo's own collection.
 *
 *   npx tsx --env-file=.env src/migrate.ts           # dry run
 *   npx tsx --env-file=.env src/migrate.ts --write
 *
 * The point is the history. Those rows carry the first `firstSeen` and
 * `lastPaid` this index ever recorded, and re-probing from scratch would
 * silently reset every endpoint's clock to today — which is exactly the
 * signal the index exists to keep. Migrating is cheap; losing the start date
 * is not recoverable.
 *
 * Reads the Payload collection (`paid-endpoints`, hyphenated slug) and writes
 * this repo's (`paid_endpoints`). Never overwrites a row this repo already
 * probed: a fresh observation always beats an imported one.
 */

import { MongoClient } from "mongodb";
import { COLLECTION, open as openStore } from "./store.js";
import type { Endpoint, ProbeOutcome } from "./types.js";

const WRITE = process.argv.includes("--write");
const LEGACY = "paid-endpoints";

interface LegacyDoc {
	url: string;
	host?: string | null;
	title?: string | null;
	protocol?: string | null;
	acceptsStellar?: boolean | null;
	accepts?: Array<{
		network?: string | null;
		asset?: string | null;
		amount?: string | null;
		scheme?: string | null;
	}> | null;
	priceUSD?: number | null;
	source?: string | null;
	sourceUrl?: string | null;
	lastStatus?: string | null;
	lastCheckedAt?: string | null;
	lastPaidAt?: string | null;
	consecutiveFailures?: number | null;
	createdAt?: string | null;
}

function outcomeOf(status: string): ProbeOutcome {
	if (status === "402") return "paid";
	if (status.startsWith("2")) return "open";
	if (status === "401" || status === "403") return "walled";
	if (status === "404" || status === "410") return "absent";
	return "unreachable";
}

async function main() {
	const uri = process.env.DATABASE_URI?.trim();
	if (!uri) throw new Error("DATABASE_URI is not set.");
	const client = new MongoClient(uri);
	await client.connect();
	const legacy = await client
		.db()
		.collection<LegacyDoc>(LEGACY)
		.find({})
		.toArray();
	await client.close();
	console.log(`legacy collection "${LEGACY}": ${legacy.length} row(s)`);
	if (legacy.length === 0) {
		console.log("nothing to migrate.");
		return;
	}

	const { col, close } = await openStore();
	const mine = new Set(
		(await col.find({}, { projection: { url: 1 } }).toArray()).map(
			(d) => d.url,
		),
	);
	console.log(
		`this repo's "${COLLECTION}": ${mine.size} row(s) already probed`,
	);

	const now = new Date().toISOString();
	const rows: Endpoint[] = [];
	let skipped = 0;
	for (const d of legacy) {
		if (!d.url) continue;
		// A row this repo has already probed is fresher than any import.
		if (mine.has(d.url)) {
			skipped++;
			continue;
		}
		const status = d.lastStatus ?? "";
		const proto = d.protocol === "unknown" || !d.protocol ? "none" : d.protocol;
		rows.push({
			url: d.url,
			host:
				d.host ??
				(() => {
					try {
						return new URL(d.url).hostname;
					} catch {
						return "";
					}
				})(),
			title: d.title ?? null,
			protocol: proto as Endpoint["protocol"],
			acceptsStellar: !!d.acceptsStellar,
			accepts: (d.accepts ?? []).map((a) => ({
				network: a.network ?? null,
				asset: a.asset ?? null,
				amount: a.amount ?? null,
				scheme: a.scheme ?? null,
			})),
			priceUSD: d.priceUSD ?? null,
			source: (d.source as Endpoint["source"]) ?? "curated",
			sourceUrl: d.sourceUrl ?? null,
			outcome: outcomeOf(status),
			status,
			// The whole reason for migrating rather than re-probing.
			firstSeen: d.createdAt ?? d.lastCheckedAt ?? now,
			lastChecked: d.lastCheckedAt ?? now,
			lastPaid: d.lastPaidAt ?? null,
			consecutiveMisses: d.consecutiveFailures ?? 0,
		});
	}

	const paid = rows.filter((r) => r.outcome === "paid").length;
	const stellar = rows.filter((r) => r.acceptsStellar).length;
	const earliest = rows.map((r) => r.firstSeen).sort()[0];
	console.log(
		`\nto migrate: ${rows.length} (skipped ${skipped} already present) · paid ${paid} · stellar-payable ${stellar}`,
	);
	console.log(`earliest firstSeen carried over: ${earliest}`);

	if (!WRITE) {
		console.log("\nDry run — nothing written. Re-run with --write.");
		await close();
		return;
	}
	const res = await col.bulkWrite(
		rows.map((r) => ({
			updateOne: {
				filter: { url: r.url },
				update: { $setOnInsert: r },
				upsert: true,
			},
		})),
		{ ordered: false },
	);
	const total = await col.countDocuments();
	console.log(
		`\nmigrated ${res.upsertedCount} — ${total} endpoints in ${COLLECTION}`,
	);
	await close();
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
