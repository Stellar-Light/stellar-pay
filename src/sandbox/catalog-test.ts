/**
 * The catalog's claim, as executable checks.
 *
 * README: "an entry is in it because it answered a real 402 naming
 * stellar:pubnet within the last day". Nothing enforced the freshness half,
 * and `acceptsStellar` is a prefix match — so a testnet row, or a host that
 * died months ago, could publish as mainnet-payable.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sp-cat-"));
const file = join(dir, "catalog.json");
process.env.CATALOG_FILE = file;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600_000;

const row = (o: Record<string, unknown>) => ({
	url: "https://example.com/x",
	host: "example.com",
	title: "t",
	description: null,
	method: "GET",
	protocol: "mpp",
	acceptsStellar: true,
	networks: ["stellar:pubnet"],
	priceUSD: 0.01,
	source: "bazaar",
	lastStatus: "402",
	lastCheckedAt: iso(HOUR),
	lastPaidAt: null,
	consecutiveFailures: 0,
	createdAt: iso(100 * HOUR),
	...o,
});

writeFileSync(
	file,
	JSON.stringify([
		row({ url: "https://fresh-pubnet.example/a" }),
		row({ url: "https://stale.example/b", lastCheckedAt: iso(30 * 24 * HOUR) }),
		row({
			url: "https://testnet-only.example/c",
			networks: ["stellar:testnet"],
		}),
		row({
			url: "https://our-sandbox.example/d",
			networks: ["stellar:testnet"],
			source: "curated",
		}),
		row({ url: "https://dead.example/e", lastStatus: "404" }),
	]),
);

const { loadCatalog } = await import("../catalog.js");
const shown = (await loadCatalog()).map((e) => e.url);
const all = (await loadCatalog({ all: true })).map((e) => e.url);

let pass = 0,
	fail = 0;
const check = (n: string, c: boolean, d = "") => {
	if (c) {
		pass++;
		console.log(`  ✓ ${n}`);
	} else {
		fail++;
		console.log(`  ✗ ${n}  ${d}`);
	}
};

check(
	"a fresh pubnet 402 is shown",
	shown.includes("https://fresh-pubnet.example/a"),
);
check(
	"a 30-day-stale row is NOT advertised as payable",
	!shown.includes("https://stale.example/b"),
	shown.join(","),
);
check(
	"a testnet-only row does not publish as mainnet-payable",
	!shown.includes("https://testnet-only.example/c"),
);
check(
	"our deliberately-curated testnet sandbox IS still shown",
	shown.includes("https://our-sandbox.example/d"),
);
check("a non-402 row is not shown", !shown.includes("https://dead.example/e"));
check(
	"all:true still returns every row for auditing",
	all.length === 5,
	`${all.length}`,
);

// ── the scheme a 402 named must survive the trip to the snapshot ────────
// The probe read `scheme` off every accept from the start and toEntry dropped
// it, so 0 of the 1,272 published rows carried one: the first metered (`upto`)
// seller would have been probed correctly and published as if it were `exact`.
const { toEntry } = await import("../catalog.js");

check(
	"a scheme on the accepts reaches the row",
	JSON.stringify(
		toEntry({
			url: "https://x.example",
			accepts: [{ scheme: "upto", network: "stellar:pubnet" }],
		}).stellarSchemes,
	) === '["upto"]',
	JSON.stringify(
		toEntry({
			url: "https://x.example",
			accepts: [{ scheme: "upto", network: "stellar:pubnet" }],
		}).stellarSchemes,
	),
);
check(
	"several accepts collapse to the distinct set",
	JSON.stringify(
		toEntry({
			url: "https://x.example",
			accepts: [
				{ scheme: "exact", network: "stellar:pubnet" },
				{ scheme: "mpp", network: "stellar:testnet" },
				{ scheme: "exact", network: "stellar:pubnet" },
			],
		}).stellarSchemes,
	) === '["exact","mpp"]',
);
check(
	"an accept that names no network is not a Stellar accept",
	JSON.stringify(
		toEntry({ url: "https://x.example", accepts: [{ scheme: "exact" }] })
			.stellarSchemes,
	) === "[]",
	"an unnamed network is not evidence of Stellar — the same rule acceptsStellar follows",
);
check(
	"a denormalised schemes field is taken as-is",
	JSON.stringify(
		toEntry({ url: "https://x.example", stellarSchemes: ["upto"], accepts: [] })
			.stellarSchemes,
	) === '["upto"]',
);
check(
	"a row that never recorded one is null, NOT an empty list",
	toEntry({ url: "https://x.example" }).stellarSchemes === null,
	"[] would claim the 402 named no scheme; null admits we did not carry it",
);
// The false positive that reached the published snapshot on 2026-09-10:
// agent402.tools serves 13 accepts across 14 chains, `upto` on Base and
// `exact` on Stellar. Flattened, 540 rows advertised metered pricing that a
// Stellar wallet cannot buy. x402 is a shared standard, so this shape is the
// norm, not an edge case.
check(
	"an upto on ANOTHER chain is not a Stellar scheme",
	JSON.stringify(
		toEntry({
			url: "https://agent402.example/api/random",
			accepts: [
				{ scheme: "upto", network: "eip155:8453" },
				{ scheme: "exact", network: "solana:5eykt4Us" },
				{ scheme: "exact", network: "stellar:pubnet" },
			],
		}).stellarSchemes,
	) === '["exact"]',
	"a scheme joined across chains advertises what a Stellar wallet cannot pay",
);
check(
	"accepts present but none named a scheme IS an empty list",
	JSON.stringify(
		toEntry({
			url: "https://x.example",
			accepts: [{ network: "stellar:pubnet" }],
		}).stellarSchemes,
	) === "[]",
	"checked-and-none differs from never-checked",
);

console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} catalog-integrity checks`,
);
process.exit(fail === 0 ? 0 : 1);
