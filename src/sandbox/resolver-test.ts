/**
 * Automated-resolver e2e — the "auto service" judging jobs BOTH ways.
 *
 * A neutral resolver agent holds the decision roles. Two jobs on testnet:
 *   A. provider delivers the AGREED deliverable hash → resolver reads terms +
 *      evidence, answers "yes", releases funds to the provider.
 *   B. provider delivers the WRONG hash → resolver answers "no", disputes and
 *      refunds the buyer.
 * Both use the deterministic hashMatchPolicy — the objectively-verifiable tier.
 * Horizon confirms who got paid each time; the job-resolved receipt records
 * the answer, the policy, and the evidence the resolver saw.
 *
 *   npm run test:resolver
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";

const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-resolver-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
const AMOUNT = 10_000_000n; // 1 XLM
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const GOOD_HASH = "sha256:agreed-deliverable-abc123";

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}
async function credited(txHash: string, who: string): Promise<bigint> {
	await new Promise((r) => setTimeout(r, 4000));
	const fx = await fetch(
		`https://horizon-testnet.stellar.org/transactions/${txHash}/effects?limit=30`,
	);
	const d = (await fx.json()) as {
		_embedded?: {
			records?: Array<{ type: string; account?: string; amount?: string }>;
		};
	};
	// SUM every credit to `who` in the tx — .find() once grabbed the 30,000-
	// stroop fee record and masked where the PRINCIPAL went.
	return (d._embedded?.records ?? [])
		.filter((x) => x.type === "account_credited" && x.account === who)
		.reduce((acc, x) => {
			const [i = "0", f = ""] = (x.amount ?? "0").split(".");
			return acc + BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
		}, 0n);
}

async function main() {
	console.log("═══ automated resolver e2e — judges both ways on testnet ═══\n");
	const { openJob, fundJob, deliverJob } = await import("../pay/job.js");
	const { resolveJob, hashMatchPolicy } = await import("../pay/resolver.js");

	const buyer = Keypair.random();
	const provider = Keypair.random();
	const resolver = Keypair.random(); // the neutral auto-resolver agent
	await Promise.all([
		friendbot(buyer.publicKey()),
		friendbot(provider.publicKey()),
		friendbot(resolver.publicKey()),
	]);
	console.log(
		`buyer ${buyer.publicKey().slice(0, 8)} · provider ${provider.publicKey().slice(0, 8)} · resolver ${resolver.publicKey().slice(0, 8)}\n`,
	);

	const baseJob = {
		buyer,
		provider: provider.publicKey(),
		resolver: resolver.publicKey(), // resolver holds the decision roles
		tokenContract: XLM_SAC,
		amount: AMOUNT,
		twFeeAddress: buyer.publicKey(),
		reviewQuestion: `Does the submitted evidence contain the agreed deliverable hash ${GOOD_HASH}?`,
		allowedEvidence: ["the milestone evidence string"],
		resolutionEffects: [
			["yes", "release"],
			["no", "refund"],
		] as Array<[string, string]>,
	};

	// ── Case A: correct deliverable → resolver releases to provider ──
	console.log("── Case A: provider delivers the AGREED hash ──");
	const jobA = {
		...baseJob,
		title: "job A (good delivery)",
		spec: `Produce the artifact hashing to ${GOOD_HASH}.`,
	};
	const openA = await openJob(jobA);
	await fundJob({
		...jobA,
		contractId: openA.contractId,
		engagementId: openA.engagementId,
		openReceiptId: openA.receiptId,
	});
	await deliverJob({
		provider,
		contractId: openA.contractId,
		evidence: `delivered ${GOOD_HASH}`,
		prevReceiptId: openA.receiptId,
	});
	console.log(`  escrow ${openA.contractId.slice(0, 10)}… funded + delivered`);
	const resA = await resolveJob({
		resolver,
		contractId: openA.contractId,
		twFeeAddress: buyer.publicKey(),
		policy: hashMatchPolicy(GOOD_HASH),
		policyLabel: `hash-match:${GOOD_HASH}`,
	});
	console.log(
		`  resolver answered "${resA.answer}" → ${resA.outcome} (${resA.txs.length} txs)`,
	);
	const provGot = await credited(
		resA.txs[resA.txs.length - 1] ?? "",
		provider.publicKey(),
	);
	const expectRelease = AMOUNT - (AMOUNT * 30n) / 10_000n;
	console.log(
		`  provider credited ${provGot} (expected ${expectRelease} = amount − 0.3%): ${provGot === expectRelease ? "✓" : "✗"}`,
	);
	if (
		resA.answer !== "yes" ||
		resA.outcome !== "release" ||
		provGot !== expectRelease
	)
		throw new Error("Case A: resolver did not release correctly");

	// ── Case B: wrong deliverable → resolver refunds the buyer ──
	console.log("\n── Case B: provider delivers the WRONG hash ──");
	const jobB = {
		...baseJob,
		title: "job B (bad delivery)",
		spec: `Produce the artifact hashing to ${GOOD_HASH}.`,
	};
	const openB = await openJob(jobB);
	await fundJob({
		...jobB,
		contractId: openB.contractId,
		engagementId: openB.engagementId,
		openReceiptId: openB.receiptId,
	});
	await deliverJob({
		provider,
		contractId: openB.contractId,
		evidence: "delivered sha256:something-else-999",
		prevReceiptId: openB.receiptId,
	});
	console.log(
		`  escrow ${openB.contractId.slice(0, 10)}… funded + delivered (wrong hash)`,
	);
	const resB = await resolveJob({
		resolver,
		contractId: openB.contractId,
		twFeeAddress: buyer.publicKey(),
		policy: hashMatchPolicy(GOOD_HASH),
		policyLabel: `hash-match:${GOOD_HASH}`,
		// the buyer (platform role) raises the dispute; the resolver adjudicates.
		disputeRaiser: buyer,
	});
	console.log(
		`  resolver answered "${resB.answer}" → ${resB.outcome} (${resB.txs.length} txs)`,
	);
	const buyerGot = await credited(
		resB.txs[resB.txs.length - 1] ?? "",
		buyer.publicKey(),
	);
	// STRENGTHENED: >0 once passed on the 0.3% fee crumb while the question
	// of where the PRINCIPAL went stayed untested. The refund must return
	// (at least) the escrowed principal to the buyer.
	const minRefund = (AMOUNT * 9n) / 10n;
	console.log(
		`  buyer refunded ${buyerGot} stroops (must be ≥ ${minRefund}, the principal — not fee crumbs): ${buyerGot >= minRefund ? "✓" : "✗"}`,
	);
	if (resB.answer !== "no" || resB.outcome !== "refund" || buyerGot < minRefund)
		throw new Error("Case B: resolver did not refund the PRINCIPAL to the buyer");

	// Receipts: both judgments recorded with answer + policy + evidence.
	const rows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(
			(l) =>
				JSON.parse(l) as {
					kind: string;
					detail?: { answer?: string; policy?: string };
				},
		);
	const resolved = rows.filter((r) => r.kind === "job-resolved");
	console.log(
		`\nledger   ${resolved.length} job-resolved receipts: ${resolved.map((r) => `${r.detail?.answer}(${r.detail?.policy?.slice(0, 10)}…)`).join(", ")}`,
	);
	if (resolved.length !== 2) throw new Error("expected 2 resolution receipts");

	console.log(
		"\nRESULT: PASS — the automated resolver read terms + evidence and settled BOTH ways on-chain (release on match, refund on mismatch), each judgment receipted.",
	);
}

main().catch((err) => {
	console.error("FATAL:", err?.message ?? err);
	process.exit(1);
});
