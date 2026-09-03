/**
 * reconcile — the four buckets, plus the one that matters most: a Horizon
 * outage must report "could not check", never "missing" (a local file cannot
 * prove its OWN absence-of-evidence claims against a chain it failed to
 * read). A fixture Horizon (plain node:http) drives one wallet through five
 * ledger rows and one unrecorded on-chain payment:
 *
 *   AAA  matched            — ledger row + chain credit agree exactly
 *   BBB  ledger, not chain  — Horizon 404s the hash: never settled
 *   CCC  mismatch           — chain credited a different amount than logged
 *   DDD  COULD NOT CHECK    — Horizon 500s the hash: NOT reported as missing
 *   EEE  chain, not ledger  — a real payment with no ledger row at all
 *   FFF  off-chain channel row — excluded, not miscounted as "never settled"
 *
 * NEGATIVE CONTROL built in: DDD's assertion explicitly checks it is absent
 * from `ledgerNotOnChain` (not just present in `couldNotCheck`) — a version
 * of reconcile.ts that collapsed "Horizon 500" into "not found" (the exact
 * bug class this task exists to prevent) would fail that line specifically.
 *
 *   npm run test:reconcile
 */

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";

process.env.STELLAR_PAY_SESSION_DIR = mkdtempSync(
	join(tmpdir(), "stellar-pay-reconcile-"),
);

const { record } = await import("../pay/receipts.js");
const { reconcile } = await import("../pay/reconcile.js");

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

const wallet = Keypair.random().publicKey();
// MUX: a payee the payer was given as M…, credited on-chain to its underlying
// G… — exactly what Horizon reports. Before settlementPayee() existed, a
// payment that settled precisely where it was sent came back as a confirmed
// discrepancy, because the stored M… was compared to the chain's G… with ===.
const muxUnderlying = Keypair.random().publicKey();
const muxPayee = new MuxedAccount(
	new Account(muxUnderlying, "0"),
	"777",
).accountId();
const payee1 = Keypair.random().publicKey();
const payee2 = Keypair.random().publicKey();
const payee3 = Keypair.random().publicKey();
const payee4 = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const NETWORK = "stellar:testnet" as const;

// A fixture Horizon: only the routes reconcile.ts is expected to touch.
const routes: Record<string, { status: number; body: unknown }> = {
	"/transactions/AAA": { status: 200, body: { successful: true } },
	"/transactions/MUX": { status: 200, body: { successful: true } },
	"/transactions/MUX/effects": {
		status: 200,
		body: {
			_embedded: {
				records: [
					{
						type: "account_credited",
						// Horizon reports the UNDERLYING account, never the M….
						account: muxUnderlying,
						amount: "0.5000000",
						asset_type: "native",
					},
				],
			},
		},
	},
	"/transactions/AAA/effects": {
		status: 200,
		body: {
			_embedded: {
				records: [
					{
						type: "account_credited",
						account: payee1,
						amount: "1.0000000",
						asset_type: "native",
					},
				],
			},
		},
	},
	"/transactions/BBB": { status: 404, body: {} }, // never settled — a real absence
	"/transactions/CCC": { status: 200, body: { successful: true } },
	"/transactions/CCC/effects": {
		// The chain credited 0.5 XLM; the ledger row (below) claims 3 XLM.
		status: 200,
		body: {
			_embedded: {
				records: [
					{
						type: "account_credited",
						account: payee3,
						amount: "0.5000000",
						asset_type: "native",
					},
				],
			},
		},
	},
	"/transactions/DDD": {
		status: 500,
		body: { error: "simulated Horizon outage" },
	},
};

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://fixture");
	if (url.pathname === `/accounts/${wallet}/payments`) {
		// Real two-page walk: page 1 carries one on-chain payment the ledger
		// never recorded (EEE); page 2 is empty and ends the walk.
		const page2 = url.searchParams.get("cursor") === "2";
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify(
				page2
					? { _links: {}, _embedded: { records: [] } }
					: {
							_links: {
								// `base` is set right after `server.listen()` below, before any
								// request can arrive — the closure reads it at call time.
								next: { href: `${base}/accounts/${wallet}/payments?cursor=2` },
							},
							_embedded: {
								records: [
									{
										type: "payment",
										transaction_hash: "EEE",
										created_at: "2026-01-01T00:00:00Z",
										from: wallet,
										to: stranger,
										amount: "5.0000000",
										asset_type: "native",
									},
								],
							},
						},
			),
		);
		return;
	}
	const r = routes[url.pathname];
	res.writeHead(r?.status ?? 404, { "content-type": "application/json" });
	res.end(JSON.stringify(r?.body ?? {}));
});
let base = "";
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));

/**
 * Close the fixture server and WAIT for it, then let the loop drain on its
 * own rather than calling process.exit().
 *
 * Windows CI caught this: all 15 checks passed and the run still failed with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`.
 * `server.close()` immediately followed by `process.exit()` tears the process
 * down while libuv is still closing the handle, which aborts on Windows and
 * is merely invisible on macOS and Linux. Keep-alive sockets are dropped
 * first, since close() waits for live connections and would otherwise hang.
 */
async function shutdown(): Promise<void> {
	server.closeAllConnections?.();
	await new Promise<void>((r) => server.close(() => r()));
}
base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function main() {
	console.log(
		"═══ reconcile — four buckets + the outage negative control ═══\n",
	);
	console.log(`wallet ${wallet.slice(0, 10)}…  fixture Horizon ${base}`);

	record({
		kind: "payment",
		network: NETWORK,
		payer: wallet,
		payee: payee1,
		amount: "10000000", // 1 XLM — matches the AAA effect exactly
		tx: "AAA",
	});
	record({
		kind: "payment",
		network: NETWORK,
		payer: wallet,
		payee: muxPayee, // stored as the payer saw it: M…
		amount: "5000000", // 0.5 XLM — matches the MUX effect exactly
		tx: "MUX",
	});
	record({
		kind: "payment",
		network: NETWORK,
		payer: wallet,
		payee: payee2,
		amount: "20000000",
		tx: "BBB", // Horizon 404s this hash
	});
	record({
		kind: "payment",
		network: NETWORK,
		payer: wallet,
		payee: payee3,
		amount: "30000000", // ledger says 3 XLM; chain will say 0.5 XLM
		tx: "CCC",
	});
	record({
		kind: "payment",
		network: NETWORK,
		payer: wallet,
		payee: payee4,
		amount: "40000000",
		tx: "DDD", // Horizon 500s this hash
	});
	record({
		kind: "payment",
		network: NETWORK,
		protocol: "channel",
		payer: wallet,
		payee: Keypair.random().publicKey(),
		amount: "999",
		tx: null,
		detail: { offChain: true, session: true }, // settles only at channel close
	});

	// A row from a DIFFERENT network must never leak into this reconciliation.
	record({
		kind: "payment",
		network: "stellar:pubnet",
		payer: wallet,
		payee: payee1,
		amount: "10000000",
		tx: "AAA-pubnet-should-be-ignored",
	});

	// Point reconcile at the fixture instead of real Horizon — the one
	// dependency-injection seam reconcile() exposes for exactly this.
	const r = await reconcile({
		publicKey: wallet,
		network: NETWORK,
		horizonUrl: base,
	});

	console.log(
		`\n${r.complete ? "complete" : "partial"} read · ${r.pagesRead} page(s) · excluded off-chain ${r.excludedOffChainRows}`,
	);
	console.log(
		`matched ${r.matched.length} · onChainNotLedger ${r.onChainNotLedger.length} · ledgerNotOnChain ${r.ledgerNotOnChain.length} · mismatched ${r.mismatched.length} · couldNotCheck ${r.couldNotCheck.length}`,
	);

	// --- bucket 1: matched -------------------------------------------------
	check(
		"AAA matched",
		r.matched.some(
			(m) => m.tx === "AAA" && m.amount === "10000000" && m.payee === payee1,
		),
	);
	// The seam finding: a muxed payee must MATCH, not read as a discrepancy.
	check(
		"MUX matched — a muxed payee resolves to the account Horizon credited",
		r.matched.some((m) => m.tx === "MUX" && m.amount === "5000000"),
	);
	check(
		"MUX is NOT reported as a mismatch (the regression this guards)",
		!r.mismatched.some((m) => m.tx === "MUX"),
	);
	check(
		"MUX is NOT reported as ledger-not-on-chain either",
		!r.ledgerNotOnChain.some((m) => m.tx === "MUX"),
	);

	// --- bucket 2: in the ledger, never settled -----------------------------
	check(
		"BBB (404) lands in ledgerNotOnChain",
		r.ledgerNotOnChain.some((m) => m.tx === "BBB"),
	);
	check(
		"BBB is NOT reported as a mismatch or could-not-check (a 404 is a real absence)",
		!r.mismatched.some((m) => m.tx === "BBB") &&
			!r.couldNotCheck.some((c) => c.tx === "BBB"),
	);

	// --- bucket 3: amount mismatch ------------------------------------------
	const ccc = r.mismatched.find((m) => m.tx === "CCC");
	check(
		"CCC reported as a mismatch with BOTH the ledger's and the chain's numbers",
		!!ccc && ccc.ledger.amount === "30000000" && ccc.chain.amount === "5000000",
	);

	// --- bucket 4: on-chain, never logged ------------------------------------
	check(
		"EEE (paged from a real 2-page walk) lands in onChainNotLedger",
		r.onChainNotLedger.some(
			(p) =>
				p.tx === "EEE" &&
				p.amount === "50000000" &&
				p.counterparty === stranger,
		),
	);
	check(
		"the account-history walk actually paged (2 pages read)",
		r.pagesRead === 2,
	);

	// --- the outage: THE central requirement of this task -------------------
	check(
		"DDD (Horizon 500) lands in couldNotCheck",
		r.couldNotCheck.some((c) => c.tx === "DDD"),
	);
	check(
		"DDD is NOT reported as ledgerNotOnChain — an outage must never read as “missing”",
		!r.ledgerNotOnChain.some((m) => m.tx === "DDD"),
	);
	check(
		"DDD is NOT reported as matched or mismatched either — unknown stays unknown",
		!r.matched.some((m) => m.tx === "DDD") &&
			!r.mismatched.some((m) => m.tx === "DDD"),
	);

	// --- the off-chain channel row: excluded, not falsely flagged -----------
	check(
		"the off-chain channel row is counted as excluded, not flagged",
		r.excludedOffChainRows === 1,
	);
	check(
		'the off-chain channel row (its distinctive amount "999") appears in NO bucket',
		!r.matched.some((m) => m.amount === "999") &&
			!r.ledgerNotOnChain.some((m) => m.amount === "999") &&
			!r.mismatched.some((m) => m.ledger.amount === "999"),
	);

	// --- cross-network isolation ---------------------------------------------
	check(
		"the pubnet row never entered a testnet reconciliation",
		!r.matched.some((m) => m.tx.includes("pubnet")) &&
			!r.ledgerNotOnChain.some((m) => (m.tx ?? "").includes("pubnet")),
	);

	// --- whole-result honesty -------------------------------------------------
	check("a run with real findings never reports ok:true", r.ok === false);
	check(
		"scope names the wallet and network being read",
		r.scope.includes(wallet) && r.scope.includes(NETWORK),
	);
	check(
		"complete:true — the bulk walk itself finished (DDD's failure was a per-row lookup, not a paging failure)",
		r.complete === true,
	);

	console.log(
		`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} reconcile checks`,
	);
	await shutdown();
	process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(async (e) => {
	console.error("FATAL:", e);
	await shutdown();
	process.exitCode = 1;
});
