/**
 * Verification-bounty e2e — the first product on the layer, doing REAL work.
 *
 * This is the dogfood moment: the bounty asks a worker agent to verify two
 * LIVE stellarlight directory rows. The worker actually fetches the live
 * API, builds genuine evidence (status + excerpt + timestamp per row),
 * submits it on-chain, and the deterministic evidence policy judges it —
 * release on complete coverage, refund on incomplete. Real work, real
 * escrow, real judgment, receipts throughout.
 *
 *   Case A: complete evidence for both items → resolver releases to worker.
 *   Case B: evidence missing one item → resolver refunds the buyer.
 *
 *   npm run test:bounty
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";

const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-bounty-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
const AMOUNT = 10_000_000n; // 1 XLM per bounty
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const ITEMS = ["usdt0", "stellarsight"]; // real, recently-verified rows

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}
async function creditedSum(txHash: string, who: string): Promise<bigint> {
	await new Promise((r) => setTimeout(r, 4000));
	const fx = await fetch(
		`https://horizon-testnet.stellar.org/transactions/${txHash}/effects?limit=30`,
	);
	const d = (await fx.json()) as {
		_embedded?: {
			records?: Array<{ type: string; account?: string; amount?: string }>;
		};
	};
	return (d._embedded?.records ?? [])
		.filter((x) => x.type === "account_credited" && x.account === who)
		.reduce((acc, x) => {
			const [i = "0", f = ""] = (x.amount ?? "0").split(".");
			return (
				acc + BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7))
			);
		}, 0n);
}

/** The worker's ACTUAL work: verify each directory row against the live API. */
async function doTheWork(items: string[]) {
	const out = [];
	for (const slug of items) {
		const url = `https://stellarlight.xyz/api/projects?where%5Bslug%5D%5Bequals%5D=${slug}&limit=1&depth=0`;
		const r = await fetch(url);
		const d = (await r.json()) as {
			docs?: Array<{
				slug?: string;
				status?: string;
				shortDescription?: string;
			}>;
		};
		const row = d.docs?.[0];
		out.push({
			item: slug,
			url,
			verdict: row
				? `row present, status=${row.status}`
				: "row MISSING from the live API",
			checkedAt: new Date().toISOString(),
			excerpt: (row?.shortDescription ?? "(no description)").slice(0, 140),
		});
	}
	return out;
}

async function main() {
	console.log(
		"═══ verification bounty e2e — REAL work, escrowed, auto-judged ═══\n",
	);
	const {
		assignBounty,
		bountyStatus,
		postBounty,
		resolveBounty,
		submitBounty,
	} = await import("../pay/bounty.js");

	const buyer = Keypair.random();
	const worker = Keypair.random();
	const resolver = Keypair.random();
	await Promise.all([
		friendbot(buyer.publicKey()),
		friendbot(worker.publicKey()),
		friendbot(resolver.publicKey()),
	]);
	console.log(
		`buyer ${buyer.publicKey().slice(0, 8)} · worker ${worker.publicKey().slice(0, 8)} · resolver ${resolver.publicKey().slice(0, 8)}\n`,
	);

	const descriptor = postBounty({
		buyer: buyer.publicKey(),
		resolver: resolver.publicKey(),
		title: "verify 2 stellarlight directory rows",
		items: ITEMS,
		instructions:
			"For each item, fetch the live stellarlight directory row and report whether it exists, its status, and a description excerpt as proof of reading.",
		amount: AMOUNT,
		tokenContract: XLM_SAC,
	});
	console.log(
		`post     bounty "${descriptor.title}" · ${descriptor.items.join(", ")} · 1 XLM`,
	);

	// ── Case A: the worker does the REAL work → release ──
	const a = await assignBounty({
		descriptor,
		buyer,
		provider: worker.publicKey(),
	});
	console.log(
		`assign   escrow ${a.contractId.slice(0, 10)}… funded (${a.fundTx.slice(0, 10)}…)`,
	);

	const evidence = await doTheWork(ITEMS);
	console.log(
		`work     verified ${evidence.length} live rows: ${evidence.map((e) => `${e.item}→"${e.verdict}"`).join(" · ")}`,
	);
	const sub = await submitBounty({
		provider: worker,
		contractId: a.contractId,
		evidence,
		prevReceiptId: a.openReceiptId,
	});
	console.log(`submit   evidence on-chain (${sub.tx.slice(0, 10)}…)`);

	const resA = await resolveBounty({
		descriptor,
		resolver,
		contractId: a.contractId,
	});
	const workerGot = await creditedSum(
		resA.txs[resA.txs.length - 1] ?? "",
		worker.publicKey(),
	);
	const expected = AMOUNT - (AMOUNT * 30n) / 10_000n;
	console.log(
		`resolve  "${resA.answer}" → ${resA.outcome} · worker credited ${workerGot} (expected ${expected}): ${workerGot === expected ? "✓" : "✗"}`,
	);
	if (resA.answer !== "yes" || workerGot !== expected)
		throw new Error("Case A: valid evidence was not released correctly");

	const statusA = await bountyStatus({
		contractId: a.contractId,
		source: resolver,
	});
	console.log(
		`status   released=${statusA.released} · evidence entries=${statusA.evidence?.length}`,
	);

	// ── Case B: incomplete evidence (one item missing) → refund ──
	console.log("\n── Case B: incomplete evidence (coverage violation) ──");
	const b = await assignBounty({
		descriptor,
		buyer,
		provider: worker.publicKey(),
	});
	const partial = (await doTheWork(ITEMS)).slice(0, 1); // drops one item
	await submitBounty({
		provider: worker,
		contractId: b.contractId,
		evidence: partial,
		prevReceiptId: b.openReceiptId,
	});
	const resB = await resolveBounty({
		descriptor,
		resolver,
		contractId: b.contractId,
		disputeRaiser: buyer,
	});
	const buyerBack = await creditedSum(
		resB.txs[resB.txs.length - 1] ?? "",
		buyer.publicKey(),
	);
	const minRefund = (AMOUNT * 9n) / 10n;
	console.log(
		`resolve  "${resB.answer}" → ${resB.outcome} · buyer refunded ${buyerBack} (≥ ${minRefund} required): ${buyerBack >= minRefund ? "✓" : "✗"}`,
	);
	if (resB.answer !== "no" || buyerBack < minRefund)
		throw new Error("Case B: incomplete evidence was not refunded correctly");

	// The ledger: assignments + judgments recorded.
	const rows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { kind: string });
	const kinds = rows.reduce<Record<string, number>>((acc, r) => {
		acc[r.kind] = (acc[r.kind] ?? 0) + 1;
		return acc;
	}, {});
	console.log(`\nledger   ${JSON.stringify(kinds)}`);
	if ((kinds["bounty-assign"] ?? 0) !== 2 || (kinds["job-resolved"] ?? 0) !== 2)
		throw new Error("ledger missing bounty rows");

	console.log(
		"\nRESULT: PASS — a bounty verified LIVE directory rows: real work escrowed, evidence on-chain, deterministically judged both ways, everything receipted.",
	);
}

main().catch((err) => {
	console.error("FATAL:", err?.message ?? err);
	process.exit(1);
});
