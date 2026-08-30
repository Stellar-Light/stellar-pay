/**
 * The catalog an agent searches: every endpoint that answered a live 402
 * naming Stellar, with price, protocol, and how long it has been alive.
 *
 * Three sources, first that works: the shared Mongo when DATABASE_URI is set
 * (CI, or a developer who has it), else the `catalog` branch of this repo
 * over plain HTTPS from the public catalog branch (no auth, no tooling),
 * falling back to the user's own `gh` if that fails, else a file.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Entry = {
	url: string;
	host: string | null;
	title: string | null;
	description: string | null;
	method: "GET" | "POST" | null;
	protocol: string;
	acceptsStellar: boolean;
	/** every network the 402 actually named (empty on older rows) */
	networks: string[];
	priceUSD: number | null;
	source: string;
	lastStatus: string;
	lastCheckedAt: string | null;
	/** last time a real 402 was read from it */
	lastPaidAt: string | null;
	consecutiveFailures: number;
	createdAt: string | null;
};

const CATALOG_BRANCH = "catalog";
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
		networks: Array.isArray(r.networks) ? (r.networks as string[]) : [],
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
	// Only the probe/export jobs may talk to a database. A library consumer can
	// easily have their OWN DATABASE_URI in the environment, and this used to
	// connect to it and run createIndex on someone else's database. Require an
	// explicit opt-in.
	if (process.env.STELLAR_PAY_ALLOW_DB !== "1")
		throw new Error(
			"fromMongo() is for the probe/export jobs only — set STELLAR_PAY_ALLOW_DB=1 to permit a database connection",
		);
	// Imported lazily: the Mongo driver is only needed by the probe/export jobs,
	// so a library consumer or a CLI user reading the catalog snapshot never
	// loads it (and need not install it).
	const { open } = await import("./store.js");
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
	// Plain HTTPS first: the repo is public, so the snapshot is a public feed
	// that needs no auth and no tooling. The README says exactly that; it used
	// to shell out to an AUTHENTICATED `gh` instead, which meant the claim was
	// false for anyone without the CLI logged in.
	const raw = `https://raw.githubusercontent.com/${CATALOG_REPO}/${CATALOG_BRANCH}/catalog.json`;
	try {
		const r = await fetch(raw, { signal: AbortSignal.timeout(30_000) });
		if (r.ok)
			return ((await r.json()) as Record<string, unknown>[]).map(toEntry);
	} catch {
		// fall through to gh — useful if the repo is ever private again
	}
	// Fallback for a private repo or a rate-limited network: the user's own
	// gh auth, no secret of ours involved.
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

/** A row is only "payable right now" if it is live, FRESH, and names a network
 * this catalog actually claims. The README promises "answered a real 402 …
 * within the last day"; nothing enforced the freshness half, so a host that
 * died months ago stayed in the default view forever. 48h, not 24, so one
 * missed daily probe is not an outage. */
const FRESH_MS = 48 * 60 * 60 * 1000;

const isFresh = (x: Entry) => {
	if (!x.lastCheckedAt) return false;
	const t = Date.parse(x.lastCheckedAt);
	return Number.isFinite(t) && Date.now() - t <= FRESH_MS;
};

/** Mainnet, or a row we curated deliberately (the testnet sandbox). */
const claimedNetwork = (x: Entry) =>
	x.networks.length === 0 // older rows predate the field
		? x.acceptsStellar
		: x.networks.some((n) => n === "stellar:pubnet" || n === "stellar") ||
			x.source === "curated";

/** How stale the newest row is, in hours — null when the snapshot is empty. */
export function catalogAgeHours(entries: Entry[]): number | null {
	const newest = entries
		.map((x) => Date.parse(x.lastCheckedAt ?? ""))
		.filter((t) => Number.isFinite(t))
		.reduce((a, b) => Math.max(a, b), 0);
	return newest > 0 ? (Date.now() - newest) / 3_600_000 : null;
}

const filter = (e: Entry[], o: { all?: boolean }) => {
	if (o.all) return e;
	const live = e.filter(
		(x) =>
			x.acceptsStellar &&
			x.lastStatus === "402" &&
			isFresh(x) &&
			claimedNetwork(x),
	);
	// A BLACKOUT MUST ANNOUNCE ITSELF. When the snapshot has rows but every one
	// is stale, the publish job is broken — and the symptom users saw was
	// "no live match", which blames their phrasing for our outage. (That is
	// exactly what happened: a missing env var killed the publish for six days
	// and nothing said so.) Failing closed is right; failing SILENTLY is not.
	if (e.length > 0 && live.length === 0) {
		const age = catalogAgeHours(e);
		console.error(
			`stellar-pay: the catalog snapshot is ${age == null ? "undated" : `${Math.floor(age)}h stale`} — every row is outside the ${FRESH_MS / 3_600_000}h freshness window, so nothing is being offered. This is a publish outage on our side, not your query.`,
		);
	}
	return live;
};

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
const stem = (w: string) =>
	w
		.replace(/ies$/, "y")
		.replace(/(sses|xes|ches|shes)$/, (m) => m.slice(0, -2))
		.replace(/([^s])s$/, "$1");

/** Keyword rank — the catalog is hundreds of rows, not millions. */
export function searchCatalog(
	entries: Entry[],
	query: string,
	max = 5,
): Array<Entry & { score: number; reasons: string[] }> {
	const q = tokens(query);
	if (!q.length) return [];
	const scored = entries.map((e) => {
		// Whole words only — "web" must not hit "webhook" — with plurals folded.
		const titleWords = new Set(tokens(e.title ?? "").map(stem));
		const descWords = new Set(tokens(e.description ?? "").map(stem));
		// URL words match whole: "web" must not hit "webhook". Titles and
		// descriptions are prose, so substring is fine there.
		const pathWords = new Set(
			tokens(e.url.replace(/^https?:\/\/[^/]+/, "")).map(stem),
		);
		let score = 0;
		const reasons: string[] = [];
		for (const raw of q) {
			const t = stem(raw);
			if (titleWords.has(t)) {
				score += 3;
				reasons.push(`title:${raw}`);
			} else if (descWords.has(t)) {
				score += 2;
				reasons.push(`description:${raw}`);
			} else if (pathWords.has(t)) {
				score += 1;
				reasons.push(`url:${raw}`);
			}
		}
		if (reasons.length > 1) score += reasons.length; // several terms agreeing beats one strong hit
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
