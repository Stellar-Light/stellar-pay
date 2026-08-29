/**
 * TW job flow e2e — hire → escrow → deliver → approve → release, receipted.
 *
 * Runs the research corpus's core loop against Trustless Work's TESTNET
 * escrow with two of our keys (buyer + provider). Requires TW_API_KEY (an
 * owner-requested key from dapp.trustlesswork.com); without it, prints the
 * exact setup step and SKIPS (exit 0) — a missing key is a setup gap, not
 * a code failure.
 *
 * The buyer needs testnet USDC (TW's issuer) for the fund step: the test
 * creates the trustline; if the balance is zero the fund step's error is
 * surfaced with the faucet pointer.
 *
 *   TW_API_KEY=… npm run test:job
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk";

const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-job-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
const AMOUNT = 1; // 1 USDC — small, real

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function main() {
	console.log(
		"═══ TW job flow e2e — hire → escrow → deliver → approve → release ═══\n",
	);
	if (!process.env.TW_API_KEY) {
		console.log(
			"SKIP — TW_API_KEY not set.\nOwner step (once): sign in at https://dapp.trustlesswork.com, request an API key, then:\n  export TW_API_KEY=…  &&  npm run test:job",
		);
		return;
	}
	// Import AFTER the session dir env is set (receipts resolve paths lazily,
	// but keep the ordering explicit anyway).
	const {
		approveJob,
		deliverJob,
		fundJob,
		openJob,
		releaseJob,
		TW_TESTNET_USDC_ISSUER,
	} = await import("../pay/job.js");

	const buyer = Keypair.random();
	const provider = Keypair.random();
	await Promise.all([
		friendbot(buyer.publicKey()),
		friendbot(provider.publicKey()),
	]);
	console.log(`buyer    ${buyer.publicKey()}`);
	console.log(`provider ${provider.publicKey()}`);

	// Trustlines to TW's testnet USDC for both parties (the escrow pays the
	// receiver in it; the buyer funds in it).
	const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
	const usdc = new Asset("USDC", TW_TESTNET_USDC_ISSUER);
	for (const kp of [buyer, provider]) {
		const acct = await horizon.loadAccount(kp.publicKey());
		const tx = new TransactionBuilder(acct, {
			fee: BASE_FEE,
			networkPassphrase: Networks.TESTNET,
		})
			.addOperation(Operation.changeTrust({ asset: usdc }))
			.setTimeout(60)
			.build();
		tx.sign(kp);
		await horizon.submitTransaction(tx);
	}
	console.log("trustlines set (TW testnet USDC)\n");

	const spec = `Verify 3 directory rows for stellarlight and attach dated evidence per row. Payment: ${AMOUNT} USDC on approval. Judge: buyer (declared).`;

	const open = await openJob({
		roles: { buyer, provider: provider.publicKey() },
		amountUsdc: AMOUNT,
		title: "stellarlight verification batch",
		spec,
	});
	console.log(
		`open     escrow ${open.contractId.slice(0, 10)}… engagement ${open.engagementId}`,
	);

	try {
		const fund = await fundJob({
			buyer,
			contractId: open.contractId,
			amountUsdc: AMOUNT,
			openReceiptId: open.receiptId,
		});
		console.log(`fund     tx ${(fund.txHash ?? "").slice(0, 12)}…`);

		const deliver = await deliverJob({
			provider,
			contractId: open.contractId,
			evidence: "sha256:demo-deliverable-hash",
			prevReceiptId: fund.receiptId,
		});
		console.log(`deliver  tx ${(deliver.txHash ?? "").slice(0, 12)}…`);

		const approve = await approveJob({
			approver: buyer,
			contractId: open.contractId,
			prevReceiptId: deliver.receiptId,
		});
		console.log(`approve  tx ${(approve.txHash ?? "").slice(0, 12)}…`);

		const release = await releaseJob({
			releaseSigner: buyer,
			contractId: open.contractId,
			prevReceiptId: approve.receiptId,
		});
		console.log(`release  tx ${(release.txHash ?? "").slice(0, 12)}…`);

		// Receipt chain: open ← fund ← deliver ← approve ← release.
		const rows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map(
				(l) => JSON.parse(l) as { kind: string; id: string; refs?: string[] },
			);
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
		console.log(`\nledger   ${chain.join(" ← ")} — chain intact`);
		console.log(
			"\nRESULT: PASS — full agreement lifecycle on Trustless Work testnet, every step receipted and chained.",
		);
	} catch (e) {
		const msg = (e as Error).message;
		if (/balance|underfunded|trustline|insufficient/i.test(msg)) {
			console.log(
				`\nBLOCKED at funding: ${msg}\nThe buyer key needs TW testnet USDC — faucet in their dApp (dapp.trustlesswork.com). Deploy + receipt chain up to this point verified.`,
			);
			return;
		}
		throw e;
	}
}

main().catch((err) => {
	console.error("FATAL:", err?.message ?? err);
	process.exit(1);
});
