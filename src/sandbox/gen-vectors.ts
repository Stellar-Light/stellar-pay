/**
 * Generate specs/vectors/*.json FROM the implementation, through the PUBLIC
 * entry point only.
 *
 * Two properties matter. The published bytes are the bytes we actually
 * produce — a hand-written fixture drifts silently and then the spec is
 * fiction. And importing from "../index.js" rather than the internals means
 * this generator is itself a proof that the formats are reachable by a second
 * party: if a vector needs something we do not export, generating it fails.
 *
 *   npm run vectors        # regenerate (commit the result)
 *   npm run test:vectors   # assert the implementation still matches them
 */
import { writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
	BOUNTY_FEED_FORMAT,
	buildFeed,
	makeCommit,
	makeSubmission,
	openBountyTerms,
	postBounty,
	submissionDigest,
} from "../index.js";

// Fixed seeds, fixed nonce, fixed timestamps: a vector that moves is not a
// vector. STELLAR_NETWORK is pinned because the TW fee rule reads it.
process.env.STELLAR_NETWORK = "stellar:testnet";
const buyer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const worker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const resolver = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAV";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NONCE =
	"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const COMMITTED_AT = "2026-09-01T12:00:00.000Z";

export const descriptor = postBounty({
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

export const evidence = [
	{
		item: "row-alpha",
		url: "https://alpha.example",
		verdict: "live",
		checkedAt: "2026-09-01T00:00:00.000Z",
		excerpt: "alpha ok",
	},
	{
		item: "row-beta",
		url: "https://beta.example",
		verdict: "live",
		checkedAt: "2026-09-01T00:00:00.000Z",
		excerpt: "beta ok",
	},
];

export function vectors() {
	const terms = openBountyTerms(descriptor);
	const { commit } = makeCommit({
		worker,
		contractId: CONTRACT,
		evidence,
		nonce: NONCE,
		committedAt: COMMITTED_AT,
	});
	const reveal = makeSubmission({
		worker,
		contractId: CONTRACT,
		evidence,
		nonce: NONCE,
	});
	const feed = buildFeed([{ contractId: CONTRACT, descriptor }]);
	// Per-publish / per-signing stamps are normalised to a placeholder. Both
	// are OUTSIDE every signed preimage — `signedAt` is not in the submission
	// digest and `generated_at` is not in any hash — so a second implementation
	// must NOT treat either as authenticated. Pinning them here would also make
	// the fixture non-reproducible, which is how a vector quietly rots.
	const VOLATILE = "<per-instance, NOT signed>";
	const feedFixture = { ...feed, generated_at: VOLATILE };
	const revealFixture = { ...reveal, signedAt: VOLATILE };
	return {
		"agreement-v1": {
			$note:
				"descriptor → agreement document → engagement_id. agreementHash is the value the escrow pins on chain; a worker recomputes it from the feed row and refuses if it differs.",
			descriptor,
			agreementDoc: terms.doc,
			agreementHash: terms.hash,
		},
		"commit-v2": {
			$note:
				"commitHash = sha256(`${format}|${contractId}|${worker}|${sha256(JSON.stringify(evidence))}|${nonce}|${committedAt}`), hex. committedAt is INSIDE the preimage — v1 left it outside the signature, where a relay could rewrite it.",
			contractId: CONTRACT,
			worker: worker.publicKey(),
			evidence,
			nonce: NONCE,
			committedAt: COMMITTED_AT,
			commit,
		},
		"submission-v1": {
			$note:
				"The bytes a worker signs. Without a nonce it is a plain submission; with one it is the reveal that opens a commit. signature is base64 ed25519 over the digest.",
			contractId: CONTRACT,
			worker: worker.publicKey(),
			evidence,
			digestNoNonce: Buffer.from(
				submissionDigest(CONTRACT, worker.publicKey(), evidence),
			).toString("hex"),
			nonce: NONCE,
			digestWithNonce: Buffer.from(
				submissionDigest(CONTRACT, worker.publicKey(), evidence, NONCE),
			).toString("hex"),
			$volatile: ["signedAt"],
			reveal: revealFixture,
		},
		"bounty-feed-v1": {
			$note:
				"The envelope a publisher serves. generatedAt is per-publish and therefore excluded from the fixture — everything else is stable.",
			format: BOUNTY_FEED_FORMAT,
			$volatile: ["generated_at"],
			feed: feedFixture,
		},
	} as const;
}

if (process.argv[1]?.endsWith("gen-vectors.ts")) {
	for (const [name, body] of Object.entries(vectors()))
		writeFileSync(
			new URL(`../../specs/vectors/${name}.json`, import.meta.url),
			`${JSON.stringify(body, null, 2)}\n`,
		);
	console.log(`wrote ${Object.keys(vectors()).length} vector files`);
}
