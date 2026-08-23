/**
 * The catalog an agent searches: every endpoint that answered a live 402
 * naming Stellar, with price, protocol, and how long it has been alive.
 *
 * Three sources, first that works: the shared Mongo when DATABASE_URI is set
 * (CI, or a developer who has it), else the `catalog` branch of this repo
 * through the user's own `gh` auth (no local secret at all), else a file.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { open } from "./store.js";

const run = promisify(execFile);

export type Entry = {
	url: string;
	host: string | null;
	title: string | null;
	description: string | null;
	method: "GET" | "POST" | null;
	protocol: string;
	acceptsStellar: boolean;
	priceUSD: number | null;
	source: string;
	lastStatus: string;
	lastCheckedAt: string | null;
	/** last time a real 402 was read from it */
	lastPaidAt: string | null;
	consecutiveFailures: number;
	createdAt: string | null;
};

export const CATALOG_BRANCH = "catalog";
export const CATALOG_REPO = "Stellar-Light/stellar-pay";

const iso = (d: unknown) =>
	d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null;

export function toEntry(r: Record<string, unknown>): Entry {
	return {
		url: String(r.url),
		host: (r.host as string) ?? null,
		title: (r.title as string) ?? null,
		description: (r.description as string) ?? null,
		method: (r.method as Entry["method"]) ?? null,
		protocol: String(r.protocol ?? "unknown"),
		acceptsStellar: !!r.acceptsStellar,
		priceUSD: typeof r.priceUSD === "number" ? r.priceUSD : null,
		source: String(r.source ?? "curated"),
		lastStatus: String(r.lastStatus ?? ""),
		lastCheckedAt: iso(r.lastCheckedAt),
		lastPaidAt: iso(r.lastPaidAt),
		consecutiveFailures: Number(r.consecutiveFailures ?? 0),
		createdAt: iso(r.createdAt),
	};
}

export async function fromMongo(): Promise<Entry[]> {
	const { col, close } = await open();
	try {
		return (await col.find({}).toArray()).map((r) =>
			toEntry(r as unknown as Record<string, unknown>),
		);
	} finally {
		await close();
	}
}

export async function fromCatalogBranch(): Promise<Entry[]> {
	const { stdout } = await run(
		"gh",
		[
			"api",
			`repos/${CATALOG_REPO}/contents/catalog.json?ref=${CATALOG_BRANCH}`,
			"--jq",
			".content",
		],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	return (
		JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8")) as Record<
			string,
			unknown
		>[]
	).map(toEntry);
}

let cache: { at: number; entries: Entry[] } | null = null;

/** Live, Stellar-payable entries only — the catalog never shows a dead link. */
export async function loadCatalog(
	opts: { all?: boolean } = {},
): Promise<Entry[]> {
	if (cache && Date.now() - cache.at < 10 * 60_000)
		return filter(cache.entries, opts);
	let entries: Entry[] | null = null;
	const file = process.env.CATALOG_FILE;
	if (file)
		entries = (
			JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[]
		).map(toEntry);
	else if (process.env.DATABASE_URI) entries = await fromMongo();
	else entries = await fromCatalogBranch();
	cache = { at: Date.now(), entries };
	return filter(entries, opts);
}

const filter = (e: Entry[], o: { all?: boolean }) =>
	o.all ? e : e.filter((x) => x.acceptsStellar && x.lastStatus === "402");

const STOP = new Set(
	"a an the to for of in on with and or is are do does can i my me get find search api".split(
		" ",
	),
);
const tokens = (s: string) =>
	s
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1 && !STOP.has(t));

/** Keyword rank — the catalog is hundreds of rows, not millions. */
export function searchCatalog(
	entries: Entry[],
	query: string,
	max = 5,
): Array<Entry & { score: number; reasons: string[] }> {
	const q = tokens(query);
	if (!q.length) return [];
	const scored = entries.map((e) => {
		const title = (e.title ?? "").toLowerCase();
		const desc = (e.description ?? "").toLowerCase();
		const path = e.url.toLowerCase();
		let score = 0;
		const reasons: string[] = [];
		for (const t of q) {
			if (title.includes(t)) {
				score += 3;
				reasons.push(`title:${t}`);
			} else if (desc.includes(t)) {
				score += 2;
				reasons.push(`description:${t}`);
			} else if (path.includes(t)) {
				score += 1;
				reasons.push(`url:${t}`);
			}
		}
		if (score && e.priceUSD != null) score += Math.max(0, 0.5 - e.priceUSD); // cheaper wins ties
		return { ...e, score, reasons };
	});
	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || (a.priceUSD ?? 1) - (b.priceUSD ?? 1))
		.slice(0, max);
}

export function groupByHost(entries: Entry[]) {
	const m = new Map<string, Entry[]>();
	for (const e of entries) {
		const h = e.host ?? "?";
		m.set(h, [...(m.get(h) ?? []), e]);
	}
	return [...m.entries()]
		.map(([host, rows]) => {
			const prices = rows
				.map((r) => r.priceUSD)
				.filter((p): p is number => p != null);
			return {
				host,
				endpoints: rows.length,
				protocols: [...new Set(rows.map((r) => r.protocol))],
				min_price_usd: prices.length ? Math.min(...prices) : null,
				max_price_usd: prices.length ? Math.max(...prices) : null,
				sample: rows.slice(0, 3).map((r) => r.title || r.url),
			};
		})
		.sort((a, b) => b.endpoints - a.endpoints);
}

export const daysAlive = (e: Entry) =>
	e.createdAt
		? Math.max(
				0,
				Math.round((Date.now() - Date.parse(e.createdAt)) / 86_400_000),
			)
		: null;
