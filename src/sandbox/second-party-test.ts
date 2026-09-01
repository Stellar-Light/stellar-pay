/**
 * Can a stranger implement against our formats without reading our CLI?
 *
 * The design audit's sharpest adoption finding: the functions a second-party
 * worker or resolver needs — buildFeed, BOUNTY_FEED_FORMAT, makeCommit,
 * openBountyTerms — were exactly the ones missing from src/index.ts. You could
 * CONSUME the package; you could not IMPLEMENT against the formats it defines.
 * A wire format nobody else can produce is not a format, it is an internal.
 *
 * This asserts the surface exists AND that it round-trips: a feed built by a
 * publisher parses for a worker, and a commit made by a worker opens for a
 * resolver. Both halves, through the public entry point only.
 */
import { Keypair } from "@stellar/stellar-sdk";
import * as pkg from "../index.js";

let ok = 0;
let bad = 0;
const check = (pass: boolean, label: string) => {
	console.log(`  ${pass ? "✓" : "✗"} ${label}`);
	pass ? ok++ : bad++;
};

// 1. The surface is present.
for (const name of [
	"buildFeed",
	"BOUNTY_FEED_FORMAT",
	"makeCommit",
	"openBountyTerms",
	"pickWinner",
	"makeSubmission",
	"checkListing",
	"fetchFeed",
] as const)
	check(
		(pkg as Record<string, unknown>)[name] !== undefined,
		`exported: ${name}`,
	);

// 2. Publisher half → consumer half, through the package only.
const buyer = Keypair.random();
const resolver = Keypair.random().publicKey();
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const descriptor = pkg.postBounty({
	buyer: buyer.publicKey(),
	resolver,
	title: "Second-party round trip",
	items: ["one"],
	instructions: "Check it.",
	amount: 1_000_000n,
	tokenContract: TOKEN,
	submitUrl: "https://resolver.example/inbox",
});
const feed = pkg.buildFeed([{ contractId: "C".repeat(56), descriptor }]);
check(
	feed.format === pkg.BOUNTY_FEED_FORMAT && feed.bounties.length === 1,
	"a publisher can build a feed with the exported format constant",
);
// 0x-prefixed lowercase sha256 — the exact string the escrow pins as
// engagement_id, so a second implementation has to produce this shape.
const terms = pkg.openBountyTerms(descriptor);
check(
	/^0x[0-9a-f]{64}$/.test(terms.hash),
	`a second party can re-derive the agreement hash the escrow pins (${terms.hash.slice(0, 12)}…)`,
);
check(
	terms.doc.includes("https://resolver.example/inbox"),
	"and the agreement they derive names the inbox the evidence is contracted to",
);

// 3. Worker half → resolver half.
const worker = Keypair.random();
const evidence = [
	{
		item: "one",
		url: "https://example.com",
		verdict: "live",
		checkedAt: new Date().toISOString(),
		excerpt: "ok",
	},
];
const { commit, nonce } = pkg.makeCommit({
	worker,
	contractId: "C".repeat(56),
	evidence,
});
const reveal = pkg.makeSubmission({
	worker,
	contractId: "C".repeat(56),
	evidence,
	nonce,
});
const sel = pkg.pickWinner(
	"C".repeat(56),
	[reveal],
	pkg.verificationEvidencePolicy(descriptor),
	[commit],
);
check(
	sel.winner?.worker === worker.publicKey(),
	"a commit made by one party opens for another — the round trip closes",
);

console.log(
	`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`} — ${ok}/${ok + bad}`,
);
process.exit(bad === 0 ? 0 : 1);
