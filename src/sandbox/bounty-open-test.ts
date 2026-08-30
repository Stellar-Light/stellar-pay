/**
 * Open-claim bounty e2e — anyone submits, first VALID evidence wins.
 *
 * Three properties proven on testnet:
 *   1. COMMITMENT: funds escrowed at post, winner unknown to the chain.
 *   2. RACING: worker1 submits invalid evidence (coverage violation);
 *      worker2 does the REAL work (live directory fetches) — worker2 wins
 *      and is paid the FULL pot despite never holding an escrow role
 *      (settled via the dispute path's arbitrary distributions).
 *   3. ANTI-REPLAY, and its honest limit: worker1 re-wraps worker2's evidence
 *      under their own address keeping worker2's signature — rejected. But a
 *      thief who re-SIGNS the same evidence with their own key produces a
 *      valid packet, and this test asserts that too, because pretending
 *      otherwise is how the first version shipped a false security claim.
 *
 *   npm run test:bounty-open
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";

const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-bounty-open-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
const AMOUNT = 10_000_000n;
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const ITEMS = ["usdt0", "stellarsight"];

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

async function doTheWork(items: string[]) {
	const out = [];
	for (const slug of items) {
		const url = `https://stellarlight.xyz/api/projects?where%5Bslug%5D%5Bequals%5D=${slug}&limit=1&depth=0`;
		const r = await fetch(url);
		const d = (await r.json()) as {
			docs?: Array<{ status?: string; shortDescription?: string }>;
		};
		const row = d.docs?.[0];
		out.push({
			item: slug,
			url,
			verdict: row ? `row present, status=${row.status}` : "row MISSING",
			checkedAt: new Date().toISOString(),
			excerpt: (row?.shortDescription ?? "(none)").slice(0, 140),
		});
	}
	return out;
}

async function main() {
	console.log(
		"═══ open-claim bounty e2e — anyone submits, first valid wins ═══\n",
	);
	const {
		makeSubmission,
		pickWinner,
		postBounty,
		postOpenBounty,
		resolveOpenBounty,
	} = await import("../pay/bounty.js");
	const { verificationEvidencePolicy } = await import("../pay/bounty.js");

	const buyer = Keypair.random();
	const worker1 = Keypair.random(); // sloppy + thief
	const worker2 = Keypair.random(); // does the real work
	const resolver = Keypair.random();
	await Promise.all(
		[buyer, worker1, worker2, resolver].map((k) => friendbot(k.publicKey())),
	);
	console.log(
		`buyer ${buyer.publicKey().slice(0, 8)} · w1 ${worker1.publicKey().slice(0, 8)} · w2 ${worker2.publicKey().slice(0, 8)} · resolver ${resolver.publicKey().slice(0, 8)}\n`,
	);

	const descriptor = postBounty({
		buyer: buyer.publicKey(),
		resolver: resolver.publicKey(),
		title: "open race: verify 2 directory rows",
		items: ITEMS,
		instructions:
			"Fetch each live directory row; report existence, status, and an excerpt.",
		amount: AMOUNT,
		tokenContract: XLM_SAC,
	});

	// 1. COMMITMENT: escrow funded, winner unknown.
	const posted = await postOpenBounty({ descriptor, buyer });
	console.log(
		`post     OPEN bounty escrowed ${posted.contractId.slice(0, 10)}… (fund ${posted.fundTx.slice(0, 10)}…) — no winner exists yet`,
	);

	// 2. The race: w1 submits sloppy (partial) work; w2 does it properly.
	const sloppy = (await doTheWork(ITEMS)).slice(0, 1);
	const sub1 = makeSubmission({
		worker: worker1,
		contractId: posted.contractId,
		evidence: sloppy,
	});
	const real = await doTheWork(ITEMS);
	const sub2 = makeSubmission({
		worker: worker2,
		contractId: posted.contractId,
		evidence: real,
	});
	// 3. The theft attempts. TWO shapes, because v1 only stopped the easy one:
	//   (a) REPLAY: re-wrap w2's evidence + w2's signature under w1's address.
	//   (b) RE-SIGN: w1 signs the SAME evidence with its OWN key — the real
	//       attack, and the one that used to win, because the digest did not
	//       cover the worker address. This is the regression guard.
	const stolenReplay = { ...sub2, worker: worker1.publicKey() };
	const stolenResigned = makeSubmission({
		worker: worker1,
		contractId: posted.contractId,
		evidence: real,
	});

	// Offline sanity of the selection BEFORE settling (order: sloppy, replay, real).
	const pol = verificationEvidencePolicy(descriptor);
	const sel = pickWinner(posted.contractId, [sub1, stolenReplay, sub2], pol);
	console.log(
		`judge    ${sel.judged.map((j) => `${j.worker.slice(0, 6)}:${j.reason}`).join(" · ")}`,
	);
	if (sel.winner?.worker !== worker2.publicKey())
		throw new Error("selection did not pick the real worker");
	if (sel.judged[1]?.reason !== "bad-signature")
		throw new Error("replayed signature was not rejected");

	// The HONEST limit of the scheme, asserted rather than claimed away: a thief
	// who OBTAINS the evidence can re-sign it under their own key and that packet
	// is valid by construction. Arrival order is the only thing protecting the
	// author, which is exactly why submitUrl must be the resolver's inbox and why
	// commit-reveal is on the roadmap. If this assertion ever starts failing,
	// someone built the real fix — update the docs with it.
	const resigned = pickWinner(posted.contractId, [stolenResigned, sub2], pol);
	if (resigned.winner?.worker !== worker1.publicKey())
		throw new Error(
			"re-signed theft no longer wins on arrival order — the fix landed; update bounty.ts's header, README's gap list and this test",
		);
	console.log(
		"limit    re-signed evidence arriving FIRST still wins (documented: single-round submission has no cryptographic author lock)",
	);

	// Settle on-chain: winner paid via the dispute path's distributions.
	const res = await resolveOpenBounty({
		descriptor,
		resolver,
		contractId: posted.contractId,
		submissions: [sub1, stolenReplay, sub2],
		disputeRaiser: buyer,
	});
	const got = await creditedSum(
		res.txs[res.txs.length - 1] ?? "",
		worker2.publicKey(),
	);
	const expectedPot = AMOUNT - (AMOUNT * 30n) / 10_000n; // 0.3% applies here too
	console.log(
		`settle   winner ${res.winner?.slice(0, 8)} paid ${got} stroops (pot ${AMOUNT} − 0.3% = ${expectedPot}): ${got === expectedPot ? "EXACT ✓" : "✗"}`,
	);
	if (res.winner !== worker2.publicKey() || got !== expectedPot)
		throw new Error("winner was not paid pot − fee");

	// Ledger: the open-post row + the judgment with every submission's verdict.
	const rows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(
			(l) =>
				JSON.parse(l) as {
					kind: string;
					detail?: { submissions?: unknown[]; winner?: string };
				},
		);
	const openRow = rows.find((r) => r.kind === "bounty-open-post");
	const resolvedRow = rows.find(
		(r) => r.kind === "job-resolved" && r.detail?.winner,
	);
	console.log(
		`ledger   open-post ✓ · resolution records ${resolvedRow?.detail?.submissions?.length} judged submissions, winner ${String(resolvedRow?.detail?.winner).slice(0, 8)}`,
	);
	if (!openRow || (resolvedRow?.detail?.submissions?.length ?? 0) !== 3)
		throw new Error("ledger incomplete");

	console.log(
		"\nRESULT: PASS — open race: sloppy work rejected, a REPLAYED signature rejected, the real worker paid the full escrowed pot without ever holding an escrow role. Documented limit: a re-signed copy of the evidence arriving first would win, so evidence goes to the resolver and commit-reveal is roadmapped.",
	);
}

main().catch((err) => {
	console.error("FATAL:", err?.message ?? err);
	process.exit(1);
});
