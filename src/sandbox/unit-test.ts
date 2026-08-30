/**
 * Offline unit checks for the pure money-path functions — no network, no
 * wallet. These are the functions a wrong answer from which moves money:
 * the 402 parser (readOffers), the USD valuation (offerUSD), and the one
 * shared spend decision (autoApprove).
 */

import { Keypair } from "@stellar/stellar-sdk";
import { agreementHash, buildAgreement } from "../pay/agreement.js";
import {
	bountyJobSpec,
	openBountyTerms,
	postBounty,
	verificationEvidencePolicy,
} from "../pay/bounty.js";
import { jobAgreement } from "../pay/job.js";
import { offerUSD, readOffers } from "../pay/offers.js";
import { autoApprove } from "../pay/policy.js";
import type { EscrowState } from "../pay/rails.js";
import { checkListing } from "../pay/worker.js";

const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const b64url = (s: string) =>
	Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

let pass = 0,
	fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}  ${detail}`);
	}
};

// --- readOffers: x402 v2 (amount) ---
const v2 = readOffers(
	new Headers(),
	JSON.stringify({
		accepts: [
			{
				network: "stellar:pubnet",
				asset: PUBNET_USDC,
				amount: "100000",
				payTo: "GABC",
			},
		],
	}),
);
check("x402 v2: amount read", v2[0]?.amount === "100000", JSON.stringify(v2));
check(
	"x402 v2: network/asset/payTo",
	v2[0]?.network === "stellar:pubnet" &&
		v2[0]?.asset === PUBNET_USDC &&
		v2[0]?.payTo === "GABC",
);

// --- readOffers: x402 v1 (maxAmountRequired) ---
const v1 = readOffers(
	new Headers(),
	JSON.stringify({
		accepts: [{ network: "stellar:pubnet", maxAmountRequired: "250000" }],
	}),
);
check("x402 v1: maxAmountRequired fallback", v1[0]?.amount === "250000");

// --- readOffers: body + header carrying the SAME accept de-dupes to one ---
const dup = readOffers(
	new Headers({
		"payment-required": Buffer.from(
			JSON.stringify({
				accepts: [
					{ network: "stellar:pubnet", asset: PUBNET_USDC, amount: "5" },
				],
			}),
		).toString("base64"),
	}),
	JSON.stringify({
		accepts: [{ network: "stellar:pubnet", asset: PUBNET_USDC, amount: "5" }],
	}),
);
check(
	"dedupe: body+header same accept → 1 offer",
	dup.length === 1,
	`${dup.length}`,
);

// --- readOffers: malformed base64 header must not throw or produce an offer ---
const junk = readOffers(
	new Headers({ "payment-required": "%%%not-base64%%%" }),
	"not json either",
);
check(
	"malformed header+body: no crash, no offers",
	junk.length === 0,
	`${junk.length}`,
);

// --- readOffers: MPP challenge with base64url request ---
const mpp = readOffers(
	new Headers({
		"www-authenticate": `Payment id="1", method="stellar", request="${b64url(
			JSON.stringify({
				amount: "100000",
				currency: PUBNET_USDC,
				recipient: "GDEF",
				methodDetails: { network: "stellar:pubnet", feePayer: true },
			}),
		)}"`,
	}),
	"",
);
check(
	"mpp: challenge parsed (amount/currency/recipient/network/sponsored)",
	mpp[0]?.protocol === "mpp" &&
		mpp[0]?.amount === "100000" &&
		mpp[0]?.asset === PUBNET_USDC &&
		mpp[0]?.payTo === "GDEF" &&
		mpp[0]?.network === "stellar:pubnet" &&
		mpp[0]?.feesSponsored === true,
	JSON.stringify(mpp),
);

// --- offerUSD: 7-decimal USDC, network-paired ---
const usdcOffer = mpp[0];
if (!usdcOffer) throw new Error("mpp fixture missing");
check("offerUSD: 100000 base units → $0.01", offerUSD(usdcOffer) === 0.01);
check(
	"offerUSD: non-USDC asset → null",
	offerUSD({ ...usdcOffer, asset: "CXXXNOTUSDC" }) === null,
);
check(
	"offerUSD: pubnet SAC claimed on testnet → null (network-paired)",
	offerUSD({ ...usdcOffer, network: "stellar:testnet" }) === null,
);

// --- autoApprove: the one spend decision ---
const okUsdc = { ...usdcOffer }; // $0.01 USDC pubnet
check(
	"autoApprove: testnet approves any asset — ON A TESTNET OFFER",
	autoApprove(
		{ ...okUsdc, network: "stellar:testnet", asset: "CXXXNOTUSDC" },
		{ network: "stellar:testnet", maxUsd: 0.05 },
	).ok,
);
check(
	"autoApprove: mainnet within ceiling → ok",
	autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: 0.05 }).ok,
);
check(
	"autoApprove: mainnet over ceiling → refused",
	!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: 0.005 }).ok,
);
check(
	"autoApprove: mainnet non-USDC → refused",
	!autoApprove(
		{ ...okUsdc, asset: "CXXXNOTUSDC" },
		{ network: "stellar:pubnet", maxUsd: 1 },
	).ok,
);
check(
	"autoApprove: NaN ceiling FAILS CLOSED",
	!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: Number.NaN }).ok,
);
check(
	"autoApprove: zero/negative ceiling FAILS CLOSED",
	!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: 0 }).ok &&
		!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: -1 }).ok,
);

// --- network confusion: a testnet-looking offer must not pass a testnet wallet
// gate if it is actually for another network, and vice versa (audit PC-01) ---
check(
	"network pin: pubnet offer refused by a testnet wallet",
	!autoApprove(
		{ ...usdcOffer, network: "stellar:pubnet" },
		{ network: "stellar:testnet", maxUsd: 0.05 },
	).ok,
);
check(
	"network pin: testnet offer refused by a mainnet wallet",
	!autoApprove(
		{ ...usdcOffer, network: "stellar:testnet" },
		{ network: "stellar:pubnet", maxUsd: 1 },
	).ok,
);
check(
	"network pin: matching networks still approve",
	autoApprove(usdcOffer, { network: "stellar:pubnet", maxUsd: 0.05 }).ok,
);

// --- AutoContracts v1 agreement: format conformance + hash determinism ---
const AG = {
	network: "stellar:testnet",
	buyer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
	provider: "GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5",
	resolver: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
	resolverPolicy: "buyer-approves",
	title: "test job",
	terms: "do the thing",
	reviewQuestion: "Did the provider deliver?",
	allowedEvidence: ["the submission hash"],
	resolutionEffects: [
		["yes", "release"],
		["no", "refund"],
	] as Array<[string, string]>,
	deadline: "2100-01-01T00:00:00Z",
	tokenContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
	amount: 10_000_000n,
};
const agDoc = buildAgreement(AG);
check(
	"agreement: required v1 sections present, in order",
	[
		"format: stellar-pay/agreement-v1",
		"\n# Agreement\n",
		"\n## Terms\n",
		"\n## Review Question\n",
		"\n## Allowed Evidence\n",
		"\n## Resolution Effects\n",
	].every((m) => agDoc.includes(m)) &&
		agDoc.indexOf("## Terms") < agDoc.indexOf("## Review Question") &&
		agDoc.indexOf("## Review Question") <
			agDoc.indexOf("## Allowed Evidence") &&
		agDoc.indexOf("## Allowed Evidence") <
			agDoc.indexOf("## Resolution Effects"),
);
check(
	"agreement: canonical bytes (LF, single trailing newline, no CR/BOM)",
	agDoc.endsWith("\n") &&
		!agDoc.endsWith("\n\n") &&
		!agDoc.includes("\r") &&
		!agDoc.includes("\uFEFF"),
);
check(
	"agreement: keccak hash is deterministic + 0x-32-byte",
	agreementHash(agDoc) === agreementHash(buildAgreement(AG)) &&
		/^0x[0-9a-f]{64}$/.test(agreementHash(agDoc)),
);
check(
	"agreement: a changed term changes the hash",
	agreementHash(agDoc) !==
		agreementHash(buildAgreement({ ...AG, terms: "do a different thing" })),
);

// --- bounty evidence policy: deterministic coverage/schema judge ---
const NOW = Date.parse("2026-08-30T00:00:00Z");
const pol = verificationEvidencePolicy(
	{ items: ["a", "b"], maxEvidenceAgeDays: 7 },
	() => NOW,
);
const entry = (item: string, over: Record<string, unknown> = {}) => ({
	item,
	url: "https://example.com/x",
	verdict: "row present",
	checkedAt: "2026-08-29T12:00:00Z",
	excerpt: "proof text",
	...over,
});
const judge = (ev: unknown) =>
	pol({
		evidence: JSON.stringify(ev),
		reviewQuestion: "",
		description: "",
		amount: 0n,
	});
check(
	"bounty policy: complete valid evidence → yes",
	judge([entry("a"), entry("b")]) === "yes",
);
check("bounty policy: missing item → no", judge([entry("a")]) === "no");
check(
	"bounty policy: duplicate instead of coverage → no",
	judge([entry("a"), entry("a")]) === "no",
);
check(
	"bounty policy: unknown extra item → no",
	judge([entry("a"), entry("b"), entry("c")]) === "no",
);
check(
	"bounty policy: stale evidence (8 days) → no",
	judge([entry("a"), entry("b", { checkedAt: "2026-08-22T00:00:00Z" })]) ===
		"no",
);
check(
	"bounty policy: non-http url → no",
	judge([entry("a"), entry("b", { url: "ftp://x" })]) === "no",
);
check(
	"bounty policy: empty verdict/excerpt → no",
	judge([entry("a"), entry("b", { verdict: " " })]) === "no" &&
		judge([entry("a"), entry("b", { excerpt: "" })]) === "no",
);
check(
	"bounty policy: non-JSON → no",
	pol({
		evidence: "not json",
		reviewQuestion: "",
		description: "",
		amount: 0n,
	}) === "no",
);

// --- worker vet: the stranger's trust check (checkListing, pure) ---
{
	const buyerKP = Keypair.random();
	const resolverKP = Keypair.random();
	const d = postBounty({
		buyer: buyerKP.publicKey(),
		resolver: resolverKP.publicKey(),
		title: "vet unit",
		items: ["a", "b"],
		instructions: "check them",
		amount: 10_000_000n,
		tokenContract: "CTOKEN",
		submitUrl: "http://127.0.0.1:1/submit",
	});
	// Drift guard: the public re-derivation must equal what postOpenBounty
	// actually escrows (the Keypair-based path) — forever.
	const viaKeypair = jobAgreement(
		bountyJobSpec(d, buyerKP, buyerKP.publicKey()),
	);
	check(
		"worker vet: openBountyTerms re-derives the escrowed terms exactly",
		openBountyTerms(d).hash === viaKeypair.hash,
	);

	const honest: EscrowState = {
		description: viaKeypair.doc,
		evidence: "",
		milestoneStatus: "",
		approved: false,
		released: false,
		disputed: false,
		amount: 10_000_000n,
		balance: 10_000_000n,
		buyer: buyerKP.publicKey(),
		provider: buyerKP.publicKey(),
		resolver: resolverKP.publicKey(),
		tokenContract: "CTOKEN",
		engagementId: viaKeypair.hash,
	};
	const listing = { contractId: "CESCROW", descriptor: d };
	check(
		"worker vet: consistent chain state → all checks pass",
		checkListing(honest, listing).ok,
	);
	const failed = (s: EscrowState, l = listing) =>
		checkListing(s, l)
			.checks.filter((c) => !c.ok)
			.map((c) => c.name)
			.join(",");
	check(
		"worker vet: tampered feed amount → descriptor/struct checks fail",
		failed(honest, {
			contractId: "CESCROW",
			descriptor: { ...d, amount: "100000000" },
		}) === "descriptor-matches-terms,struct-matches",
	);
	check(
		"worker vet: unfunded pot → funded fails",
		failed({ ...honest, balance: 0n }) === "funded",
	);
	check(
		"worker vet: settled escrow → open fails",
		failed({ ...honest, balance: 0n, released: true }) === "funded,open",
	);
	check(
		"worker vet: description not matching engagement_id → terms-pinned fails",
		failed({ ...honest, description: `${viaKeypair.doc} ` }) === "terms-pinned",
	);
}

console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} unit checks on the money-path functions`,
);
process.exit(fail === 0 ? 0 : 1);
