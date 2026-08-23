import type { Endpoint } from "./types.js";

const UA =
	"stellar-x402-index/0.1 (+https://github.com/theboycoder/stellar-x402-index)";

export interface Candidate {
	url: string;
	title: string | null;
	source: Endpoint["source"];
	sourceUrl: string | null;
}

/**
 * RFC 2606 / RFC 6761 reserve these for documentation and testing, so they
 * are guaranteed never to resolve. Sextant's catalog is 20 rows of
 * `api.fxrates.example` and friends — its own /health reports 27 seeded and
 * 0 live — and indexing them would add permanently dark entries. A demo
 * listing is not supply.
 */
const RESERVED =
	/(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|net|org)$/i;

export function isReservedDemo(url: string): boolean {
	try {
		return RESERVED.test(new URL(url).hostname);
	} catch {
		return true;
	}
}

async function json<T>(url: string, timeoutMs = 30_000): Promise<T | null> {
	try {
		const r = await fetch(url, {
			headers: { "User-Agent": UA, accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		return r.ok ? ((await r.json()) as T) : null;
	} catch {
		return null;
	}
}

const asUrl = (v: unknown): string =>
	typeof v === "string"
		? v
		: typeof v === "object" && v !== null
			? String(
					(v as { url?: string; resource?: string }).url ??
						(v as { resource?: string }).resource ??
						"",
				)
			: "";

/**
 * Coinbase's x402 Bazaar — the only cross-chain index. We keep a resource
 * when ANY of its accepts names Stellar; the probe then decides whether that
 * listing is still true.
 */
export async function fromBazaar(): Promise<Candidate[]> {
	const out: Candidate[] = [];
	for (let offset = 0; offset < 40_000; offset += 100) {
		const page = await json<{
			items?: Array<{
				resource?: unknown;
				accepts?: Array<{ network?: string }>;
				metadata?: { name?: string };
			}>;
			pagination?: { total?: number };
		}>(
			`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=${offset}`,
			40_000,
		);
		const items = page?.items ?? [];
		if (items.length === 0) break;
		for (const it of items) {
			const url = asUrl(it.resource);
			if (!url.startsWith("http")) continue;
			if (!(it.accepts ?? []).some((a) => a.network?.startsWith("stellar")))
				continue;
			out.push({
				url,
				title: it.metadata?.name ?? null,
				source: "bazaar",
				sourceUrl: "https://x402.org/bazaar",
			});
		}
		const total = page?.pagination?.total;
		if (total && offset + 100 >= total) break;
	}
	return out;
}

/** Sextant — a Stellar-native discovery layer (currently seeded demo data). */
export async function fromSextant(): Promise<Candidate[]> {
	const d = await json<{ resources?: unknown[]; items?: unknown[] }>(
		"https://sextants.dev/discovery/resources",
	);
	const rows = (d?.resources ?? d?.items ?? []) as Array<
		Record<string, unknown>
	>;
	const out: Candidate[] = [];
	for (const r of rows) {
		const url = asUrl(r.resource ?? r.url);
		if (!url.startsWith("http")) continue;
		out.push({
			url,
			title: (r.title ?? r.name ?? null) as string | null,
			source: "sextant",
			sourceUrl: "https://sextants.dev",
		});
	}
	return out;
}
