/**
 * The statement — the fiat-line ⇄ Stellar-tx join, checked on a ledger this
 * test writes itself.
 *
 * What matters here is not that rows come back, but WHICH rows and with what
 * attached: only value-moving kinds, the rule followed from the payment's
 * refs rather than duplicated onto it, and `verifiable` reflecting what the
 * row actually carries — never a claim that a chain check was run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A ledger of our own, before importing the module that reads it.
process.env.STELLAR_PAY_SESSION_DIR = mkdtempSync(
	join(tmpdir(), "statement-test-"),
);

const { record, statement, statementCsv } = await import("../pay/receipts.js");

const log = (m: string) => console.log(`  ${m}`);
const eq = (got: unknown, want: unknown, what: string) => {
	if (got !== want)
		throw new Error(`${what}: expected ${String(want)}, got ${String(got)}`);
	log(`✓ ${what}`);
};

async function main() {
	console.log("statement-test — the fiat-line ⇄ Stellar-tx join\n");

	const decision = record({
		kind: "policy-decision",
		network: "stellar:testnet",
		url: "https://api.example.com/search",
		amount: "2000000",
		asset: "USDC",
		payee: "GDEST",
		detail: { allowed: true, rule: "per-host cap" },
	});
	record({
		kind: "payment",
		network: "stellar:testnet",
		protocol: "x402",
		url: "https://api.example.com/search",
		amount: "2000000",
		asset: "USDC",
		payee: "GDEST",
		tx: "abc123def456",
		refs: [decision],
	});
	// A bookkeeping row: must NOT appear on a statement about money.
	record({ kind: "job-open", network: "stellar:testnet" });
	// A payment with no settlement hash yet: appears, but not as verifiable.
	record({
		kind: "payment",
		network: "stellar:testnet",
		protocol: "mpp",
		url: "https://other.example/quote",
		amount: "500000",
		asset: "USDC",
		payee: "GOTHER",
	});

	// The three an audit found missing: money moved, the row proved it, and
	// the statement hid it. A settled payout absent from the audit export is
	// the worst failure this file can have.
	record({
		kind: "channel-open",
		network: "stellar:testnet",
		url: "https://api.example.com/stream",
		amount: "50000000",
		payer: "GPAYER",
		payee: "GSELLER",
		tx: "chanopen1",
	});
	record({
		kind: "job-resolved",
		network: "stellar:testnet",
		payer: "GRESOLVER",
		payee: "GWINNER",
		amount: "9000000",
		detail: { contractId: "CJOB", mode: "open-claim" },
	});
	record({
		kind: "job-resolve-dispute",
		network: "stellar:testnet",
		payer: "GRESOLVER",
		tx: "dispute1",
		detail: {
			contractId: "CJOB",
			distributions: [
				["GA", "6000000"],
				["GB", "3000000"],
			],
		},
	});

	const st = statement();
	eq(st.length, 5, "only value-moving rows appear (job-open excluded)");
	eq(
		st.some((r) => r.kind === "channel-open" && r.tx === "chanopen1"),
		true,
		"a channel deposit is on the statement — it moves real funds",
	);
	eq(
		st.some((r) => r.kind === "job-resolved" && r.amount === "9000000"),
		true,
		"a resolved job's payout is on the statement",
	);
	const dispute = st.find((r) => r.kind === "job-resolve-dispute");
	eq(!!dispute, true, "a disputed distribution is NOT hidden");
	eq(
		dispute?.amount,
		null,
		"a multi-way distribution shows no single amount rather than inventing one",
	);
	eq(
		dispute?.verifiable,
		false,
		"and it is not claimed checkable — one row cannot prove several splits",
	);
	eq(
		st[0]?.rule,
		"per-host cap",
		"the rule is followed from the payment's refs",
	);
	eq(
		st[0]?.url,
		"https://api.example.com/search",
		"the causing request is on the row",
	);
	eq(st[0]?.tx, "abc123def456", "the settling transaction is on the same row");
	eq(
		st[0]?.verifiable,
		true,
		"a row with tx+amount+payee+network is verifiable",
	);
	eq(
		st[1]?.verifiable,
		false,
		"a row missing its tx is NOT reported verifiable",
	);
	eq(st[1]?.rule, null, "no rule is invented when no decision is referenced");
	eq(
		new Date(st[0]?.at ?? 0) <= new Date(st[1]?.at ?? 0),
		true,
		"oldest first — the order a statement is read in",
	);

	// CSV: RFC 4180 quoting, header plus one line per row.
	const csv = statementCsv(st).split("\n");
	eq(csv.length, st.length + 1, "CSV is a header plus one line per row");
	eq(
		csv[0],
		"at,receipt,kind,network,protocol,url,amount,asset,payee,tx,rule,verifiable",
		"CSV header names both halves of the join",
	);
	eq(
		csv[1]?.includes('"abc123def456"') &&
			csv[1]?.includes('"https://api.example.com/search"'),
		true,
		"one CSV line carries the request AND the transaction",
	);

	// A quote inside a field must not break the row.
	record({
		kind: "payment",
		network: "stellar:testnet",
		url: 'https://x.example/a"b',
		amount: "1",
		asset: "USDC",
		payee: "GQ",
		tx: "q1",
	});
	const quoted = statementCsv(statement()).split("\n").at(-1) ?? "";
	eq(
		quoted.includes('"https://x.example/a""b"'),
		true,
		"an embedded quote is doubled, not left to break the field",
	);

	console.log("\nstatement-test PASSED");
}

main().catch((e) => {
	console.error(`\nstatement-test FAILED: ${(e as Error).message}`);
	process.exit(1);
});
