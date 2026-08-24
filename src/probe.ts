/**
 * Discover and re-probe the paid HTTP endpoints an agent can pay for on
 * Stellar.
 *
 *   npm run probe            # DRY RUN
 *   npm run probe:execute
 *
 * DISCOVER — candidate URLs from the registries: Coinbase's x402 Bazaar (the
 * cross-chain index; Stellar is 3 hosts of ~1,600) and mpp-router
 * (Rozo; the only Stellar-native router — ~670 upstream services behind one
 * host). Registries are DISCOVERY ONLY: every one lists endpoints that
 * stopped answering months ago.
 *
 * PROBE — request each URL and read the challenge it actually returns. That
 * is the only evidence an endpoint is payable, and the only way to know WHICH
 * networks it takes: x402 and MPP are shared standards, so "supports x402"
 * tells a Stellar wallet nothing. `accepts` is recorded verbatim.
 *
 * Never asserts a negative. No challenge read means we could not see the
 * terms — auth wall, wrong method, transport failure — not "unpaid". A row
 * that stops answering keeps its history and gains a failure streak.
 */
import type { AnyBulkWriteOperation } from "mongodb";
import { isStellar, USDC_SAC as USDC_SAC_MAP } from "./pay/offers.js";
import { type Accept, type EndpointRow, open } from "./store.js";

const EXECUTE = process.argv.includes("--execute");
const UA = "stellar-pay-probe/1.0";

type Candidate = {
	url: string;
	title?: string;
	description?: string;
	source: EndpointRow["source"];
	sourceUrl?: string;
};

/** RFC 2606 / RFC 6761 names can never resolve; registries seed demos with them. */
function isReservedDemo(url: string): boolean {
	try {
		const h = new URL(url).hostname.toLowerCase();
		return (
			/(^|\.)(example|test|invalid|localhost)$/.test(h) ||
			/(^|\.)example\.(com|net|org)$/.test(h)
		);
	} catch {
		return true;
	}
}

async function jsonOrNull<T>(
	url: string,
	timeoutMs: number,
): Promise<T | null> {
	try {
		const r = await fetch(url, {
			headers: { "User-Agent": UA, accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!r.ok) return null;
		return (await r.json()) as T;
	} catch {
		return null;
	}
}

/** Coinbase's Bazaar — every resource, kept when any accept names Stellar. */
async function fromBazaar(): Promise<Candidate[]> {
	const out: Candidate[] = [];
	for (let offset = 0; offset < 20_000; offset += 100) {
		const page = await jsonOrNull<{
			items?: Array<{
				resource?: string;
				accepts?: Accept[];
				metadata?: Record<string, unknown>;
			}>;
			pagination?: { total?: number };
		}>(
			`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=${offset}`,
			30_000,
		);
		const items = page?.items ?? [];
		if (!items.length) break;
		for (const it of items) {
			if (!it.resource?.startsWith("http")) continue;
			if (!(it.accepts ?? []).some((a) => isStellar(a.network))) continue;
			out.push({
				url: it.resource,
				title: String((it.metadata as { name?: string })?.name ?? ""),
				source: "bazaar",
				sourceUrl: "https://x402.org/bazaar",
			});
		}
		const total = page?.pagination?.total;
		if (total && offset + 100 >= total) break;
	}
	return out;
}

/**
 * mpp-router (Rozo) — every 402 answered with stellar:pubnet USDC, fees
 * sponsored, in both x402 and MPP. Its catalog is a LISTING; each entry still
 * goes through the probe. Templated paths ({id}) cannot be probed as-is.
 */
async function fromMppRouter(): Promise<Candidate[]> {
	const d = await jsonOrNull<{
		base_url?: string;
		services?: Array<Record<string, unknown>>;
	}>("https://apiserver.mpprouter.dev/v1/services/catalog", 20_000);
	const base = String(d?.base_url ?? "https://apiserver.mpprouter.dev").replace(
		/\/$/,
		"",
	);
	const out: Candidate[] = [];
	for (const svc of d?.services ?? []) {
		const path = String(svc.public_path ?? "");
		if (!path.startsWith("/") || path.includes("{")) continue;
		out.push({
			url: base + path,
			title: String(svc.name ?? ""),
			description: String(svc.description ?? ""),
			source: "mpp-router",
			sourceUrl: "https://apiserver.mpprouter.dev/v1/services/catalog",
		});
	}
	return out;
}

/** Read a payment challenge. GET first; a paywall commonly sits behind POST. */
async function probe(url: string): Promise<{
	status: string;
	method: "GET" | "POST";
	protocol: EndpointRow["protocol"];
	accepts: Accept[];
}> {
	const attempt = async (method: "GET" | "POST") => {
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
				status: `ERR ${(e as Error).name}`,
				body: "",
				headers: new Headers(),
			};
		}
	};
	let res = await attempt("GET");
	let method: "GET" | "POST" = "GET";
	if (res.status !== "402") {
		const post = await attempt("POST");
		if (post.status === "402") {
			res = post;
			method = "POST";
		}
	}
	const accepts: Accept[] = [];
	let x402 = false;
	let mpp = false;
	type Raw = {
		network?: string;
		asset?: string;
		amount?: string;
		maxAmountRequired?: string;
		scheme?: string;
	};
	// v1 says maxAmountRequired, v2 says amount
	const push = (a: Raw) =>
		accepts.push({
			network: a.network ?? null,
			asset: a.asset ?? null,
			amount: a.maxAmountRequired ?? a.amount ?? null,
			scheme: a.scheme ?? null,
		});
	try {
		const j = JSON.parse(res.body.slice(0, 20_000)) as {
			accepts?: Raw[];
			x402Version?: number;
		};
		for (const a of j.accepts ?? []) {
			push(a);
			x402 = true;
		}
		if (j.x402Version) x402 = true;
	} catch {
		// not JSON, or truncated — the header path below may still carry it
	}
	const hdr = res.headers.get("payment-required");
	if (hdr) {
		try {
			for (const a of (
				JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) as {
					accepts?: Raw[];
				}
			).accepts ?? [])
				push(a);
			x402 = true;
		} catch {
			// a malformed header is not evidence of an offer
		}
	}
	const wa = res.headers.get("www-authenticate") ?? "";
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
	return {
		status: res.status,
		method,
		protocol:
			x402 && mpp ? "x402+mpp" : x402 ? "x402" : mpp ? "mpp" : "unknown",
		accepts,
	};
}

async function mapLimited<T, R>(
	items: T[],
	limit: number,
	fn: (t: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = [];
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
	console.log(
		`paid-endpoint index — ${EXECUTE ? "EXECUTE" : "DRY RUN (no writes)"}\n`,
	);
	const { col, close } = await open();
	try {
		const [bazaar, mppRouter] = await Promise.all([
			fromBazaar(),
			fromMppRouter(),
		]);
		console.log(
			`discovered — bazaar (stellar-accepting): ${bazaar.length} · mpp-router: ${mppRouter.length}`,
		);

		// Anything already indexed is re-probed too: liveness is the product.
		const known = await col
			.find(
				{},
				{
					projection: {
						url: 1,
						source: 1,
						sourceUrl: 1,
						consecutiveFailures: 1,
					},
				},
			)
			.toArray();
		const byUrl = new Map(known.map((d) => [d.url, d]));

		const seen = new Map<string, Candidate>();
		let demoSkipped = 0;
		for (const c of [...bazaar, ...mppRouter]) {
			if (isReservedDemo(c.url)) {
				demoSkipped++;
				continue;
			}
			if (!seen.has(c.url)) seen.set(c.url, c);
		}
		if (demoSkipped)
			console.log(
				`skipped ${demoSkipped} reserved/demo host(s) (RFC 2606 — can never resolve)`,
			);
		for (const d of known)
			if (!seen.has(d.url))
				seen.set(d.url, {
					url: d.url,
					source: d.source ?? "curated",
					sourceUrl: d.sourceUrl ?? undefined,
				});
		const candidates = [...seen.values()];
		console.log(`probing ${candidates.length} endpoint(s)…\n`);

		const results = await mapLimited(candidates, 8, async (c) => ({
			c,
			r: await probe(c.url),
		}));
		const now = new Date();
		let paid = 0;
		let stellarPayable = 0;
		const ops: AnyBulkWriteOperation<EndpointRow>[] = [];
		for (const { c, r } of results) {
			const acceptsStellar = r.accepts.some(
				(a) => isStellar(a.network) || a.network === "stellar",
			);
			if (r.status === "402") paid++;
			if (acceptsStellar) stellarPayable++;
			const prev = byUrl.get(c.url);
			// Price from the STELLAR USDC accept specifically: on Stellar the
			// asset is the USDC SAC contract id (not the string "USDC"), and a
			// multi-network endpoint may also list a Base/Solana accept whose
			// amount/decimals differ — pricing off the first "usd*"-ish match
			// (which also caught USDT) gave the wrong number. USDC is 7 decimals
			// on the Stellar SAC.
			const usd = r.accepts.find(
				(a) =>
					a.network != null && USDC_SAC_MAP[a.network] === a.asset && a.amount,
			);
			const parsed = usd?.amount ? Number(usd.amount) / 10_000_000 : null;
			// A malformed amount string parses to NaN, which typeof==="number"
			// checks downstream would happily pass through to ranking.
			const priceUSD =
				parsed != null && Number.isFinite(parsed) ? parsed : null;
			const host = (() => {
				try {
					return new URL(c.url).host;
				} catch {
					return null;
				}
			})();
			const set: Partial<EndpointRow> = {
				host,
				protocol: r.protocol,
				method: r.method,
				acceptsStellar,
				accepts: r.accepts,
				priceUSD,
				source: c.source,
				sourceUrl: c.sourceUrl ?? null,
				lastStatus: r.status,
				lastCheckedAt: now,
				updatedAt: now,
				...(c.title ? { title: c.title } : {}),
				...(c.description ? { description: c.description } : {}),
				// Only advance on a real challenge; a silent endpoint keeps the
				// date it last proved itself.
				...(r.status === "402"
					? { lastPaidAt: now, consecutiveFailures: 0 }
					: { consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1 }),
			};
			ops.push({
				updateOne: {
					filter: { url: c.url },
					update: { $set: set, $setOnInsert: { url: c.url, createdAt: now } },
					upsert: true,
				},
			});
			console.log(
				`  ${r.status.padEnd(5)} ${r.protocol.padEnd(9)} ${acceptsStellar ? "STELLAR" : "       "} ${priceUSD != null ? `$${priceUSD.toFixed(4)}` : "        "} ${c.url.slice(0, 60)}`,
			);
		}
		console.log(
			`\nprobed ${results.length} · answered 402: ${paid} · payable on Stellar: ${stellarPayable}`,
		);
		if (!EXECUTE) {
			console.log("\nDRY RUN — nothing written. Re-run with --execute.");
			return;
		}
		const w = await col.bulkWrite(ops, { ordered: false });
		console.log(
			`wrote ${w.upsertedCount} new, ${w.modifiedCount} updated — ${await col.countDocuments()} endpoints indexed`,
		);
	} finally {
		await close();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
