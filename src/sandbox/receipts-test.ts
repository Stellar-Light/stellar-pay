/**
 * Receipts ledger e2e — decision → payment → attribution ref → ON-CHAIN verify.
 *
 * Drives the REAL CLI (not the library) against our local sandbox on testnet:
 *
 *   1. `curl` pays a 402 → the ledger gains a policy-decision row AND a
 *      payment row whose `refs` names the decision (the attribution chain).
 *   2. `receipts --verify <payment>` re-proves the payment against Horizon —
 *      tx found, successful, payee credited the exact amount. The PGTR test:
 *      the receipt alone is enough for a third party to check.
 *
 *   npm run test:receipts
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

const PORT = Number(process.env.RECEIPTS_PORT ?? 8897);
const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-receipts-"));
const ENV = {
	...process.env,
	STELLAR_PAY_SESSION_DIR: DIR,
	STELLAR_PAY_KEYSTORE: join(DIR, "keystore.json"),
	STELLAR_PAY_PASSPHRASE: "receipts-test",
};

const cli = (args: string[]) =>
	execFileSync("npx", ["tsx", "src/cli.ts", ...args], {
		env: ENV,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function main() {
	console.log("═══ receipts ledger e2e — CLI → ledger → on-chain verify ═══\n");
	console.log(`ledger dir ${DIR}`);

	// Wallet: the CLI's own sandbox setup (friendbot-funded, sealed locally).
	console.log(
		cli(["setup", "--sandbox", "--save", "main", "--json"]).split("\n")[0] ??
			"",
	);

	// Seller + local sandbox.
	const seller = Keypair.random();
	await friendbot(seller.publicKey());
	const child = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
		env: {
			...process.env,
			SELLER_SECRET_KEY: seller.secret(),
			PORT: String(PORT),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const base = `http://127.0.0.1:${PORT}`;
	try {
		for (let i = 0; i < 40; i++) {
			try {
				if ((await fetch(`${base}/health`)).ok) break;
			} catch {}
			await new Promise((r) => setTimeout(r, 250));
		}

		// 1. Pay through the real CLI.
		const paidOut = cli([
			"curl",
			`${base}/data`,
			"--sandbox",
			"--yes",
			"--json",
		]);
		const paid = JSON.parse(paidOut) as {
			status: number;
			paid: { hash: string | null } | null;
		};
		console.log(
			`curl    status ${paid.status} · paid tx ${(paid.paid?.hash ?? "none").slice(0, 12)}…`,
		);
		if (paid.status !== 200 || !paid.paid) throw new Error("payment failed");

		// 2. The ledger must hold decision + payment, chained.
		const ledger = JSON.parse(cli(["receipts", "--json"])) as {
			receipts: Array<{
				id: string;
				kind: string;
				refs?: string[];
				tx?: string | null;
			}>;
		};
		const decision = ledger.receipts.find((r) => r.kind === "policy-decision");
		const payment = ledger.receipts.find((r) => r.kind === "payment");
		console.log(
			`ledger  ${ledger.receipts.length} row(s) · decision ${decision?.id} · payment ${payment?.id} refs=[${payment?.refs?.join(",") ?? ""}]`,
		);
		if (!decision || !payment) throw new Error("ledger rows missing");
		if (!payment.refs?.includes(decision.id))
			throw new Error(
				"payment does not reference its decision — attribution broken",
			);

		// 3. PGTR: verify the payment receipt against the chain.
		const v = JSON.parse(
			cli(["receipts", "--verify", payment.id, "--json"]),
		) as {
			ok: boolean;
			checks: Array<{ name: string; ok: boolean; note?: string }>;
		};
		for (const c of v.checks)
			console.log(
				`  ${c.ok ? "✓" : "✗"} ${c.name}${c.note ? ` — ${c.note}` : ""}`,
			);
		if (!v.ok) throw new Error("on-chain verification failed");

		console.log(
			"\nRESULT: PASS — decision → payment (ref-chained) → verified on-chain from the receipt alone.",
		);
		console.log(readFileSync(join(DIR, "receipts.jsonl"), "utf8").trim());
	} finally {
		child.kill();
	}
}

main().catch((err) => {
	console.error("FATAL:", err?.stderr?.toString?.() ?? err);
	process.exit(1);
});
