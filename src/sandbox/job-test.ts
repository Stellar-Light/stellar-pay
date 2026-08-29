/**
 * TW job flow e2e — DIRECT contract integration, keyless, fully self-contained.
 *
 * hire → escrow → deliver → approve → release against Trustless Work's live
 * testnet wasm, two friendbot keys, native XLM as the job token (any SEP-41
 * token works; XLM means no faucet dependency). No API key, no account, no
 * TW server anywhere in the loop — the contract is the counterparty.
 *
 * Verifies on Horizon at the end: the provider actually received the payout
 * (amount minus TW's 0.3%), and the receipts chain
 * open ← fund ← deliver ← approve ← release is intact.
 *
 *   npm run test:job
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";

const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-job-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
const AMOUNT = 10_000_000n; // 1 XLM in stroops — small, real

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function xlm(pub: string): Promise<bigint> {
	const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${pub}`);
	const d = (await r.json()) as {
		balances: Array<{ asset_type: string; balance: string }>;
	};
	const b = d.balances.find((x) => x.asset_type === "native")?.balance ?? "0";
	const [i = "0", f = ""] = b.split(".");
	return BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
}

async function main() {
	console.log(
		"═══ TW job flow e2e — DIRECT contract, keyless: hire → escrow → deliver → approve → release ═══\n",
	);
	const { approveJob, deliverJob, fundJob, openJob, releaseJob } = await import(
		"../pay/job.js"
	);

	const buyer = Keypair.random();
	const provider = Keypair.random();
	await Promise.all([
		friendbot(buyer.publicKey()),
		friendbot(provider.publicKey()),
	]);
	console.log(`buyer    ${buyer.publicKey()}`);
	console.log(`provider ${provider.publicKey()}\n`);

	const spec = `Verify 3 directory rows for stellarlight and attach dated evidence per row. Payment: 1 XLM on approval. Judge: buyer (declared).`;
	const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

	const job = {
		buyer,
		provider: provider.publicKey(),
		tokenContract: XLM_SAC,
		amount: AMOUNT,
		title: "stellarlight verification batch",
		spec,
		// Testnet play money; REAL usage must set TW's published fee address.
		// Declared, not hidden: the 0.3% here goes back to the buyer.
		twFeeAddress: buyer.publicKey(),
	};

	const open = await openJob(job);
	console.log(
		`open     escrow ${open.contractId.slice(0, 10)}… termsHash ${open.termsHash.slice(0, 14)}…`,
	);

	// AutoContracts cross-verification — the WHOLE POINT of the alignment:
	// a conforming resolver reads the on-chain agreement doc, computes
	// keccak256, and it must equal the engagement_id. Prove it here the way
	// a resolver would, reading the doc back off the contract.
	const { jobAgreement } = await import("../pay/job.js");
	const { keccak256, toBytes } = await import("viem");
	const rebuilt = jobAgreement(job);
	const resolverHash = keccak256(toBytes(open.agreementDoc));
	console.log(
		`agree    doc ${open.agreementDoc.length}B · resolver keccak ${resolverHash.slice(0, 14)}… == engagement_id: ${resolverHash === open.engagementId && rebuilt.hash === open.termsHash ? "YES ✓" : "NO ✗"}`,
	);
	if (resolverHash !== open.engagementId || rebuilt.hash !== open.termsHash)
		throw new Error("AutoContracts termsHash cross-verification failed");
	// The doc must carry the required AutoContracts v1 sections.
	for (const marker of [
		"standard: auto.contracts/v1",
		"# Agreement",
		"## Terms",
		"## Review Question",
		"## Allowed Evidence",
		"## Resolution Effects",
	])
		if (!open.agreementDoc.includes(marker))
			throw new Error(`agreement doc missing "${marker}"`);
	console.log(
		`         deploy ${open.deployTx.slice(0, 10)}… init ${open.initTx.slice(0, 10)}… (TW wasm, our deploy)`,
	);

	const fund = await fundJob({
		...job,
		contractId: open.contractId,
		engagementId: open.engagementId,
		openReceiptId: open.receiptId,
	});
	console.log(`fund     tx ${fund.tx.slice(0, 12)}… (1 XLM into escrow)`);

	const provBefore = await xlm(provider.publicKey());
	const deliver = await deliverJob({
		provider,
		contractId: open.contractId,
		evidence: "sha256:demo-deliverable-hash",
		prevReceiptId: fund.receiptId,
	});
	console.log(`deliver  tx ${deliver.tx.slice(0, 12)}… (evidence on-chain)`);

	const approve = await approveJob({
		approver: buyer,
		contractId: open.contractId,
		prevReceiptId: deliver.receiptId,
	});
	console.log(`approve  tx ${approve.tx.slice(0, 12)}…`);

	const release = await releaseJob({
		releaseSigner: buyer,
		contractId: open.contractId,
		twFeeAddress: job.twFeeAddress,
		prevReceiptId: approve.receiptId,
	});
	console.log(`release  tx ${release.tx.slice(0, 12)}…`);

	// On-chain truth: the RELEASE TX must carry the exact payout effect.
	// (The provider's raw balance delta is the wrong meter — it includes the
	// network fee they paid on their own deliver tx.)
	await new Promise((r) => setTimeout(r, 4000));
	const expected = AMOUNT - (AMOUNT * 30n) / 10_000n; // minus TW's 0.3%
	const fx = await fetch(
		`https://horizon-testnet.stellar.org/transactions/${release.tx}/effects?limit=20`,
	);
	const fxd = (await fx.json()) as {
		_embedded?: {
			records?: Array<{ type: string; account?: string; amount?: string }>;
		};
	};
	const credited = (fxd._embedded?.records ?? []).find(
		(e) => e.type === "account_credited" && e.account === provider.publicKey(),
	);
	const gotStr = credited?.amount ?? "0";
	const [gi = "0", gf = ""] = gotStr.split(".");
	const got = BigInt(gi) * 10_000_000n + BigInt((gf + "0000000").slice(0, 7));
	console.log(
		`\nhorizon  release tx credited provider ${got} stroops (expected ${expected} = 1 XLM − 0.3% TW fee): ${got === expected ? "EXACT ✓" : "MISMATCH ✗"}`,
	);
	if (got !== expected) throw new Error("payout amount wrong");
	void provBefore;

	// The receipts chain.
	const rows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { kind: string; id: string; refs?: string[] });
	const chain = [
		"job-open",
		"job-fund",
		"job-deliver",
		"job-approve",
		"job-release",
	];
	let prev: string | undefined;
	for (const kind of chain) {
		const row = rows.find((r) => r.kind === kind);
		if (!row) throw new Error(`missing ${kind} receipt`);
		if (prev && !row.refs?.includes(prev))
			throw new Error(`${kind} does not reference its predecessor`);
		prev = row.id;
	}
	console.log(`ledger   ${chain.join(" ← ")} — chain intact`);
	console.log(
		`\nexplorer https://stellar.expert/explorer/testnet/contract/${open.contractId}`,
	);
	console.log(
		"\nRESULT: PASS — full agreement lifecycle, direct against TW's contract, keyless, payout exact, receipts chained.",
	);
}

main().catch((err) => {
	console.error("FATAL:", err?.message ?? err);
	process.exit(1);
});
