/**
 * Vault × payments e2e — the "fund" beat wired to the "pay" beat.
 *
 * The full human-funds-agent story on testnet:
 *   create   vault deployed, owner = durable passkey, THIS wallet = the
 *            capped agent (5 XLM/day on the XLM SAC)
 *   topup    20 XLM wallet → vault (bulk funds now behind the cap)
 *   draw 2   agent pulls float to its classic account (under cap → lands)
 *   PAY      the agent pays a REAL 402 from that float (our sandbox) —
 *            vault → float → payment, the integrated loop
 *   draw 4   cumulative 6 > 5 → REFUSED BY THE CHAIN, receipted
 *   reopen   a FRESH process reopens the vault from the persisted passkey
 *            (status reads balance) — durability, not memory
 *
 *   npm run test:vault-flow
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

const PORT = Number(process.env.VAULT_FLOW_PORT ?? 8894);
const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-vault-flow-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
process.env.STELLAR_PAY_KEYSTORE = join(DIR, "keystore.json");
process.env.STELLAR_PAY_PASSPHRASE = "vault-flow";

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function main() {
	console.log("═══ vault × payments e2e — fund → draw → PAY → cap holds ═══\n");
	// The CLI's own wallet is the agent: create it the product way.
	execFileSync(
		"npx",
		["tsx", "src/cli.ts", "setup", "--sandbox", "--save", "main"],
		{
			env: process.env as Record<string, string>,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const { loadWallet } = await import("../pay/wallet.js");
	const { ensureSecretLoaded } = await import("../pay/keystore.js");
	await ensureSecretLoaded();
	const wallet = loadWallet();
	console.log(`agent wallet ${wallet.publicKey.slice(0, 10)}…`);

	const { createVault, topupVault, drawFromVault, vaultStatus } = await import(
		"../pay/vault.js"
	);

	// 1. CREATE (cap 5 XLM/day)
	const rec = await createVault({ wallet, capXlm: 5 });
	console.log(
		`create   vault ${rec.contractId.slice(0, 10)}… cap 5 XLM/day, agent = wallet`,
	);

	// 2. TOPUP 20 XLM
	const top = await topupVault({ wallet, amountXlm: 20 });
	console.log(`topup    20 XLM → vault (${top.hash.slice(0, 10)}…)`);

	// 3. DRAW 2 (under cap)
	const d1 = await drawFromVault({ wallet, amountXlm: 2 });
	if (!d1.ok) throw new Error(`under-cap draw refused: ${d1.refusal}`);
	console.log(
		`draw 2   ✓ landed (${d1.hash?.slice(0, 10)}…) — float on the agent key`,
	);

	// 4. PAY a real 402 from the float (our sandbox seller).
	const seller = Keypair.random();
	await friendbot(seller.publicKey());
	const sandbox = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
		env: {
			...process.env,
			SELLER_SECRET_KEY: seller.secret(),
			PORT: String(PORT),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		const base = `http://127.0.0.1:${PORT}`;
		for (let i = 0; i < 40; i++) {
			try {
				if ((await fetch(`${base}/health`)).ok) break;
			} catch {}
			await new Promise((r) => setTimeout(r, 250));
		}
		const paid = JSON.parse(
			execFileSync(
				"npx",
				[
					"tsx",
					"src/cli.ts",
					"curl",
					`${base}/data`,
					"--sandbox",
					"--yes",
					"--json",
				],
				{ env: process.env as Record<string, string>, encoding: "utf8" },
			),
		) as { status: number; paid: { hash: string | null } | null };
		console.log(
			`pay      402 paid from the drawn float · status ${paid.status} · tx ${(paid.paid?.hash ?? "").slice(0, 10)}…`,
		);
		if (paid.status !== 200 || !paid.paid)
			throw new Error("402 payment failed");
	} finally {
		sandbox.kill();
	}

	// 5. DRAW 4 → cumulative 6 > 5 → the CHAIN refuses.
	const d2 = await drawFromVault({ wallet, amountXlm: 4 });
	console.log(
		d2.ok
			? "draw 4   ✗ WENT THROUGH — cap did not hold"
			: `draw 4   ✓ REFUSED BY THE CHAIN: ${(d2.refusal ?? "").slice(0, 80)}…`,
	);
	if (d2.ok) throw new Error("over-cap draw was not refused");

	// 6. REOPEN in a fresh process: durability of the persisted passkey.
	const probePath = join(DIR, "reopen-probe.mts");
	const { writeFileSync } = await import("node:fs");
	writeFileSync(
		probePath,
		`const { vaultStatus } = await import("${process.cwd()}/src/pay/vault.js");
const { loadWallet } = await import("${process.cwd()}/src/pay/wallet.js");
const { ensureSecretLoaded } = await import("${process.cwd()}/src/pay/keystore.js");
await ensureSecretLoaded();
console.log(JSON.stringify(await vaultStatus({ wallet: loadWallet() })));
`,
	);
	const status = JSON.parse(
		execFileSync("npx", ["tsx", probePath], {
			env: process.env as Record<string, string>,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.at(-1) as string,
	) as { vault: string; balanceStroops: string };
	console.log(
		`reopen   fresh process read vault ${status.vault.slice(0, 10)}… balance ${status.balanceStroops} stroops`,
	);
	if (status.vault !== rec.contractId || BigInt(status.balanceStroops) <= 0n)
		throw new Error("reopen failed");

	// Ledger: create/topup/draw + the on-chain refusal as a policy decision.
	const rows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { kind: string; detail?: { rule?: string } });
	const kinds = rows.map((r) => r.kind);
	for (const k of [
		"vault-create",
		"vault-topup",
		"vault-draw",
		"policy-decision",
	])
		if (!kinds.includes(k)) throw new Error(`missing ${k} receipt`);
	const refusal = rows.find(
		(r) => r.kind === "policy-decision" && r.detail?.rule?.includes("vault"),
	);
	console.log(
		`ledger   vault-create/topup/draw + on-chain refusal receipted (${refusal ? "✓" : "✗"})`,
	);

	console.log(
		"\nRESULT: PASS — human funded the vault, the agent drew float under an on-chain cap, paid a real 402 from it, the over-cap draw was refused by the chain, and the vault reopened from persistence.",
	);
}

main().catch((err) => {
	console.error("FATAL:", err?.stderr?.toString?.() ?? err?.message ?? err);
	process.exit(1);
});
