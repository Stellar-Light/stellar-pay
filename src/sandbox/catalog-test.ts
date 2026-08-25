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

console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} catalog-integrity checks`,
);
process.exit(fail === 0 ? 0 : 1);
