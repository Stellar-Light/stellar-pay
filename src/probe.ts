/**
 * Probe every candidate endpoint and write the index.
 *
 *   pnpm probe          # dry run — prints the table, writes nothing
 *   pnpm probe:write    # updates data/endpoints.json
 *
 * The probe IS the product. Registries list endpoints that stopped answering
 * months ago; the only evidence that something is payable is that we asked it
 * and it answered. And the only way to know a Stellar wallet can pay is to
 * read the challenge, because x402 and MPP are shared standards — "supports
 * x402" tells a Stellar holder nothing.
 *
 * Never asserts a negative. No challenge read means we could not see the
 * terms (auth wall, wrong method, transport failure), not "unpaid". An
 * endpoint that stops answering keeps its history and gains a miss streak,
 * because going dark is the most useful thing this index can report.
 */

import {
	type Candidate,
	fromBazaar,
	fromSextant,
	isReservedDemo,
} from "./discover.js";
import { open as openStore } from "./store.js";
import type { Accept, Endpoint, ProbeOutcome } from "./types.js";

const WRITE = process.argv.includes("--write");
const UA =
	"stellar-x402-index/0.1 (+https://github.com/theboycoder/stellar-x402-index)";

const isStellar = (n?: string | null) =>
	!!n && n.toLowerCase().startsWith("stellar");

function classify(status: string): ProbeOutcome {
	if (status === "402") return "paid";
	if (status.startsWith("2")) return "open";
	if (status === "401" || status === "403") return "walled";
	if (status === "404" || status === "410") return "absent";
	return "unreachable";
}

async function request(url: string, method: "GET" | "POST") {
	try {
		const r = await fetch(url, {
			method,
			headers: {
				"User-Agent": UA,
				accept: "application/json",
				...(method === "POST" ? { "content-type": "application/json" } : {}),
			},
			body: method === "POST" ? "{}" : undefined,
			signal: AbortSignal.timeout(20_000),
		});
		return {
			status: String(r.status),
			body: await r.text(),
			headers: r.headers,
		};
	} catch (e) {
		return {
			status: `ERR_${(e as Error).name}`,
			body: "",
			headers: new Headers(),
		};
	}
}

function readChallenge(body: string, headers: Headers) {
	const accepts: Accept[] = [];
	let x402 = false;
	let mpp = false;
	const push = (a: {
		network?: string;
		asset?: string;
		maxAmountRequired?: string;
		amount?: string;
		scheme?: string;
	}) =>
		accepts.push({
			network: a.network ?? null,
			asset: a.asset ?? null,
			amount: a.maxAmountRequired ?? a.amount ?? null,
			scheme: a.scheme ?? null,
		});

	try {
		const j = JSON.parse(body.slice(0, 40_000)) as {
			accepts?: Parameters<typeof push>[0][];
			x402Version?: number;
		};
		for (const a of j.accepts ?? []) {
			push(a);
			x402 = true;
		}
		if (j.x402Version) x402 = true;
	} catch {
		// Not JSON, or truncated — the header path below may still carry it.
	}

	// x402 also base64s the challenge into a header.
	const hdr = headers.get("payment-required");
	if (hdr) {
		try {
			const j = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) as {
				accepts?: Parameters<typeof push>[0][];
			};
			for (const a of j.accepts ?? []) {
				push(a);
				x402 = true;
			}
		} catch {
			// A malformed header is not evidence of anything.
		}
	}

	// MPP announces itself in WWW-Authenticate and names its method.
	const wa = headers.get("www-authenticate") ?? "";
	if (/payment/i.test(wa)) {
		mpp = true;
		for (const m of wa.matchAll(/method="?([A-Za-z0-9_:-]+)"?/g))
			accepts.push({
				network: m[1] ?? null,
				asset: null,
				amount: null,
				scheme: "mpp",
			});
	}

	const protocol: Endpoint["protocol"] =
		x402 && mpp ? "x402+mpp" : x402 ? "x402" : mpp ? "mpp" : "none";
	return { accepts, protocol };
}

async function probe(url: string) {
	let res = await request(url, "GET");
	// A paywall commonly sits behind POST on write-shaped routes.
	if (res.status !== "402") {
		const post = await request(url, "POST");
		if (post.status === "402") res = post;
	}
	const { accepts, protocol } = readChallenge(res.body, res.headers);
	return { status: res.status, accepts, protocol };
}

async function mapLimited<T, R>(
	items: T[],
	limit: number,
	fn: (t: T) => Promise<R>,
) {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (i < items.length) {
				const idx = i++;
				out[idx] = await fn(items[idx] as T);
			}
		}),
	);
	return out;
}

async function main() {
	const now = new Date().toISOString();
	const { col, close } = await openStore();
	const [bazaar, sextant] = await Promise.all([fromBazaar(), fromSextant()]);
	const existing = new Map(
		(await col.find({}).toArray()).map((d) => [d.url, d as Endpoint]),
	);
	console.log(
		`discovered — bazaar (stellar-accepting) ${bazaar.length} · sextant ${sextant.length} · already indexed ${existing.size}`,
	);

	const seen = new Map<string, Candidate>();
	let demoSkipped = 0;
	for (const c of [...bazaar, ...sextant]) {
		if (isReservedDemo(c.url)) {
			demoSkipped++;
			continue;
		}
		if (!seen.has(c.url)) seen.set(c.url, c);
	}
	if (demoSkipped)
		console.log(
			`skipped ${demoSkipped} reserved demo host(s) — RFC 2606, can never resolve`,
		);
	// Everything already indexed is re-probed: liveness is the product, and a
	// row nobody re-checks is a dead link waiting to be served.
	for (const [url, e] of existing)
		if (!seen.has(url))
			seen.set(url, {
				url,
				title: e.title,
				source: e.source,
				sourceUrl: e.sourceUrl,
			});

	const candidates = [...seen.values()];
	console.log(`probing ${candidates.length}…\n`);
	const results = await mapLimited(candidates, 8, async (c) => ({
		c,
		r: await probe(c.url),
	}));

	const endpoints: Endpoint[] = results.map(({ c, r }) => {
		const prev = existing.get(c.url);
		const acceptsStellar = r.accepts.some(
			(a) => isStellar(a.network) || a.network === "stellar",
		);
		const outcome = classify(r.status);
		const usd = r.accepts.find((a) => /usd/i.test(a.asset ?? "") && a.amount);
		return {
			url: c.url,
			host: (() => {
				try {
					return new URL(c.url).hostname;
				} catch {
					return "";
				}
			})(),
			title: c.title,
			protocol: r.protocol,
			acceptsStellar,
			accepts: r.accepts,
			priceUSD: usd?.amount ? Number(usd.amount) / 1_000_000 : null,
			source: c.source,
			sourceUrl: c.sourceUrl,
			outcome,
			status: r.status,
			firstSeen: prev?.firstSeen ?? now,
			lastChecked: now,
			lastPaid: outcome === "paid" ? now : (prev?.lastPaid ?? null),
			consecutiveMisses:
				outcome === "paid" ? 0 : (prev?.consecutiveMisses ?? 0) + 1,
		};
	});
	endpoints.sort((a, b) => a.url.localeCompare(b.url));

	const paid = endpoints.filter((e) => e.outcome === "paid").length;
	const stellar = endpoints.filter((e) => e.acceptsStellar).length;
	const hosts = new Set(endpoints.map((e) => e.host));

	const byHost = new Map<string, { n: number; paid: number }>();
	for (const e of endpoints) {
		const r = byHost.get(e.host) ?? { n: 0, paid: 0 };
		r.n++;
		if (e.outcome === "paid") r.paid++;
		byHost.set(e.host, r);
	}
	console.log(
		`${"host".padEnd(34)} ${"urls".padStart(5)} ${"paid".padStart(5)}`,
	);
	for (const [h, r] of [...byHost].sort((a, b) => b[1].paid - a[1].paid))
		console.log(
			`${h.slice(0, 34).padEnd(34)} ${String(r.n).padStart(5)} ${String(r.paid).padStart(5)}`,
		);
	console.log(
		`\nprobed ${endpoints.length} · answering a challenge ${paid} · payable on Stellar ${stellar} · hosts ${hosts.size}`,
	);

	if (!WRITE) {
		console.log("\nDry run — nothing written. Re-run with --write.");
		await close();
		return;
	}
	// Upsert on url. The stored firstSeen/lastPaid are preserved above, so a
	// re-run never resets an endpoint's history.
	const ops = endpoints.map((e) => ({
		updateOne: {
			filter: { url: e.url },
			update: { $set: e },
			upsert: true,
		},
	}));
	const res = await col.bulkWrite(ops, { ordered: false });
	const total = await col.countDocuments();
	console.log(
		`\nupserted ${res.upsertedCount} new, ${res.modifiedCount} updated — ${total} endpoints indexed`,
	);
	await close();
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
