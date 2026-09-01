/** Generate the canonical test vectors from the implementation itself, so the
 *  published bytes are the bytes we actually produce. Deterministic inputs
 *  only: fixed seeds, fixed nonce, fixed timestamps. */
import { writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
	BOUNTY_FEED_FORMAT,
	buildFeed,
	openBountyTerms,
	postBounty,
	submissionDigest,
	__commitHashForVectors,
} from "./src/pay/bounty.js";

process.env.STELLAR_NETWORK = "stellar:testnet";
const buyer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const worker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const resolver = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAV";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const descriptor = postBounty({
	buyer: buyer.publicKey(),
	resolver: resolver.publicKey(),
	title: "Verify two directory rows",
	items: ["row-alpha", "row-beta"],
	instructions: "Confirm each row resolves and record a short excerpt.",
	amount: 25_000_000n,
	tokenContract: TOKEN,
	maxEvidenceAgeDays: 7,
	submitUrl: "https://resolver.example/inbox",
});

const evidence = [
	{ item: "row-alpha", url: "https://alpha.example", verdict: "live", checkedAt: "2026-09-01T00:00:00.000Z", excerpt: "alpha ok" },
	{ item: "row-beta", url: "https://beta.example", verdict: "live", checkedAt: "2026-09-01T00:00:00.000Z", excerpt: "beta ok" },
];
const NONCE = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const COMMITTED_AT = "2026-09-01T12:00:00.000Z";

const terms = openBountyTerms(descriptor);
writeFileSync("specs/vectors/agreement-v1.json", `${JSON.stringify({
	note: "descriptor → agreement document → engagement_id. The hash the escrow pins.",
	descriptor,
	agreementDoc: terms.doc,
	agreementHash: terms.hash,
}, null, 2)}\n`);

writeFileSync("specs/vectors/commit-v2.json", `${JSON.stringify({
	note: "commitHash preimage is `format|contractId|worker|sha256(JSON.stringify(evidence))|nonce|committedAt`, sha256, hex.",
	contractId: CONTRACT,
	worker: worker.publicKey(),
	evidence,
	nonce: NONCE,
	committedAt: COMMITTED_AT,
	commitHash: __commitHashForVectors(CONTRACT, worker.publicKey(), evidence, NONCE, COMMITTED_AT),
}, null, 2)}\n`);

writeFileSync("specs/vectors/submission-v1.json", `${JSON.stringify({
	note: "The bytes a worker signs. Without a nonce it is a plain submission; with one it is a reveal.",
	contractId: CONTRACT,
	worker: worker.publicKey(),
	evidence,
	digestNoNonce: Buffer.from(submissionDigest(CONTRACT, worker.publicKey(), evidence)).toString("hex"),
	nonce: NONCE,
	digestWithNonce: Buffer.from(submissionDigest(CONTRACT, worker.publicKey(), evidence, NONCE)).toString("hex"),
}, null, 2)}\n`);

const feed = buildFeed([{ contractId: CONTRACT, descriptor }]);
writeFileSync("specs/vectors/bounty-feed-v1.json", `${JSON.stringify({
	note: "The envelope a publisher serves. generatedAt is per-publish and excluded from the fixture.",
	format: BOUNTY_FEED_FORMAT,
	feedWithoutTimestamp: { ...feed, generatedAt: "<per-publish ISO 8601>" },
}, null, 2)}\n`);

console.log("vectors written");
