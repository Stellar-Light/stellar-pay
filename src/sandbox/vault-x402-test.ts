/**
 * Vault × x402 e2e — the contract pays a 402 DIRECTLY, under the same cap the
 * draw path proves (docs/ECOSYSTEM-ASKS.md §2.3, closed on our side).
 *
 * The story, on testnet:
 *
 *   create   vault deployed, cap 5 XLM/day, THIS wallet = the capped agent
 *   topup    20 XLM wallet → vault (bulk funds behind the cap)
 *   draw 2   the EXISTING path: agent pulls float — cumulative 2/5
 *   pay 2    the NEW path: the VAULT CONTRACT pays directly (settled here,
 *            not through the sandbox's facilitator — see the note below) —
 *            cumulative 4/5, still under cap
 *   pay 2    same call again, over the CLI's --from-vault path — cumulative
 *            6 > 5 → REFUSED, during OUR OWN pre-flight simulate — the
 *            seller has been asked for its price by then (payFetch requests
 *            the resource to GET the 402), but no payment is submitted and
 *            no fee is paid
 *
 * KNOWN LIMITATION, documented rather than papered over: hitting the
 * sandbox's REAL /data-x402 endpoint — the real @x402/stellar/exact/facilitator
 * code, unmodified — with a capped vault payment currently fails with
 * invalid_exact_stellar_payload_event_not_transfer. Traced (see the PR
 * description): the facilitator's validateSimulationEvents() assumes the
 * ONLY "contract"-type event a settlement simulation emits is the SEP-41
 * transfer itself. A capped smart-account payer's authorization additionally
 * emits a `spending_limit_enforced` event from the policy contract, ahead of
 * the transfer event in the event list, and the facilitator's loop bails on
 * the FIRST non-transfer-shaped contract event rather than scanning for one
 * that matches. This is independent of, and in addition to, the client-side
 * gap ECOSYSTEM-ASKS.md §2.3 already names — a separate finding, on the
 * FACILITATOR side, not something this repo's client code can route around.
 * So "pay 2" above is settled directly (rebuild envelope, real fee-payer,
 * same auth entries — exactly what a facilitator without that bug would do),
 * and a LAST, clearly-separated step still exercises the real HTTP
 * facilitator so a future upstream fix shows up here as a pass rather than
 * silence.
 *
 *   npm run test:vault-x402
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

const PORT = Number(process.env.VAULT_X402_PORT ?? 8899);
const PRICE_XLM = "2"; // matches the CAP_XLM/UNDER/OVER arithmetic below
const CAP_XLM = 5;
const DRAW_XLM = 2;
const DIRECT_PAY_XLM = 2;
const FACILITATOR_CHECK_XLM = "0.5"; // small, so it fits under the cap regardless
const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-vault-x402-"));
process.env.STELLAR_PAY_SESSION_DIR = DIR;
process.env.STELLAR_PAY_KEYSTORE = join(DIR, "keystore.json");
process.env.STELLAR_PAY_PASSPHRASE = "vault-x402";
// A headless CI runner/sandbox may have no unlockable OS keychain (the exact
// case vault.ts's own comment names). This vault is thrown away with `DIR`
// when the test ends, so accepting the documented plaintext fallback here is
// the sanctioned escape hatch (see vault-key-test.ts), not a real risk.
process.env.STELLAR_PAY_ALLOW_PLAINTEXT_VAULT ??= "1";

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

function runCurl(url: string): { stdout: string; status: number | null } {
	try {
		const stdout = execFileSync(
			"npx",
			[
				"tsx",
				"src/cli.ts",
				"curl",
				url,
				"--sandbox",
				"--yes",
				"--from-vault",
				"--json",
			],
			{ env: process.env as Record<string, string>, encoding: "utf8" },
		);
		return { stdout, status: 0 };
	} catch (e) {
		const err = e as { stdout?: string; status?: number | null };
		return { stdout: err.stdout ?? "", status: err.status ?? 1 };
	}
}

/** The CLI's --json contract: ONE parseable (pretty-printed, so multi-line)
 * JSON object on stdout, success or failure alike (main().catch prints
 * {error} on a thrown exception; progress lines go to stderr, never stdout). */
function parseJsonOutput(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/**
 * Settle a vault x402 payload the way a facilitator WITHOUT the event-shape
 * bug documented above would: parse the client's transaction, re-simulate it
 * fresh (real resource footprint), rebuild the SAME invoke operation (auth
 * entries untouched — they are already fully signed) under a real funded fee
 * payer, sign the envelope, submit, and poll for the result. This is "driving
 * the SAC transfer the scheme would produce" — proving the payload itself is
 * valid and chain-accepted without depending on the buggy check.
 */
async function settleDirectly(
	transactionXdr: string,
	networkPassphrase: string,
	rpcUrl: string,
): Promise<string> {
	const {
		BASE_FEE,
		Keypair: KP,
		Operation,
		rpc,
		Transaction,
		TransactionBuilder,
	} = await import("@stellar/stellar-sdk");
	const feePayer = KP.random();
	await friendbot(feePayer.publicKey());
	const server = new rpc.Server(rpcUrl);
	const parsed = new Transaction(transactionXdr, networkPassphrase);
	const invokeOp = parsed.operations[0];
	const sim = await server.simulateTransaction(parsed);
	if (rpc.Api.isSimulationError(sim))
		throw new Error(`settle: re-simulation failed: ${sim.error}`);
	const account = await server.getAccount(feePayer.publicKey());
	const rebuilt = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase,
		sorobanData: sim.transactionData.build(),
	})
		.addOperation(
			Operation.invokeHostFunction(
				invokeOp as Parameters<typeof Operation.invokeHostFunction>[0],
			),
		)
		.setTimeout(60)
		.build();
	rebuilt.sign(feePayer);
	const sent = await server.sendTransaction(rebuilt);
	if (sent.status === "ERROR")
		throw new Error(
			`settle: submit rejected: ${JSON.stringify(sent.errorResult)}`,
		);
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		const st = await server.getTransaction(sent.hash);
		if (st.status === "SUCCESS") return sent.hash;
		if (st.status === "FAILED")
			throw new Error(`settle: tx failed: ${sent.hash}`);
	}
	throw new Error("settle: timed out waiting for confirmation");
}

async function main() {
	console.log(
		"═══ vault × x402 e2e — the contract pays a 402 directly, same on-chain cap ═══\n",
	);
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

	const {
		createVault,
		topupVault,
		drawFromVault,
		vaultAgentAuthorizer,
		vaultStatus,
		XLM_SAC_TESTNET,
	} = await import("../pay/vault.js");
	const { createVaultExactStellarScheme } = await import(
		"../pay/vault-x402.js"
	);

	// 1. CREATE (cap 5 XLM/day)
	const rec = await createVault({ wallet, capXlm: CAP_XLM });
	console.log(
		`create   vault ${rec.contractId.slice(0, 10)}… cap ${CAP_XLM} XLM/day, agent = wallet`,
	);

	// 2. TOPUP 20 XLM
	const top = await topupVault({ wallet, amountXlm: 20 });
	console.log(`topup    20 XLM → vault (${top.hash.slice(0, 10)}…)`);

	// 3. DRAW 2 (the EXISTING path) — cumulative 2/5.
	const d1 = await drawFromVault({ wallet, amountXlm: DRAW_XLM });
	if (!d1.ok) throw new Error(`under-cap draw refused: ${d1.refusal}`);
	console.log(
		`draw ${DRAW_XLM}   ✓ landed (${d1.hash?.slice(0, 10)}…) — the pre-existing float path`,
	);

	// 4. PAY 2 XLM — the VAULT itself as payer, x402 shape — cumulative 4/5.
	// Settled directly (see the file header) rather than through the sandbox's
	// facilitator, which currently rejects a capped payer's own policy event.
	const balBeforePay = (await vaultStatus({ wallet })).balanceStroops;
	const recipient = Keypair.random();
	await friendbot(recipient.publicKey());
	const scheme = createVaultExactStellarScheme(wallet);
	const payload = await scheme.createPaymentPayload(2, {
		scheme: "exact",
		network: "stellar:testnet",
		asset: XLM_SAC_TESTNET,
		amount: String(DIRECT_PAY_XLM * 10_000_000),
		payTo: recipient.publicKey(),
		maxTimeoutSeconds: 60,
		extra: { areFeesSponsored: true },
	});
	const { networkPassphrase, rpcUrl } = await vaultAgentAuthorizer(
		wallet,
		XLM_SAC_TESTNET,
	);
	const payHash = await settleDirectly(
		payload.payload.transaction,
		networkPassphrase,
		rpcUrl,
	);
	const balAfterPay = (await vaultStatus({ wallet })).balanceStroops;
	console.log(
		`pay ${DIRECT_PAY_XLM}    ✓ VAULT paid directly (x402 exact payload, settled) · tx ${payHash.slice(0, 12)}… · vault balance ${balBeforePay} → ${balAfterPay} stroops`,
	);
	if (BigInt(balAfterPay) >= BigInt(balBeforePay))
		throw new Error(
			"vault balance did not decrease — the contract was not actually debited",
		);

	// Spin up a sandbox seller at a given price, wait for it, run `fn`, always
	// kill it after — used once for the over-cap check (at PRICE_XLM, matching
	// the cap arithmetic) and once more for the informational facilitator
	// check (at a small price, so it fits under the cap regardless of which
	// way that check goes).
	async function withSandbox<T>(
		priceXlm: string,
		fn: (base: string) => Promise<T>,
	): Promise<T> {
		const seller = Keypair.random();
		await friendbot(seller.publicKey());
		const log: string[] = [];
		const sandbox = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
			env: {
				...process.env,
				SELLER_SECRET_KEY: seller.secret(),
				PORT: String(PORT),
				PRICE_XLM: priceXlm,
				// A contract payer's auth entry costs far more to verify than a
				// classic keypair's — see server.ts's own comment.
				MAX_FEE_STROOPS: "2000000",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		sandbox.stdout.on("data", (d) => log.push(String(d)));
		sandbox.stderr.on("data", (d) => log.push(String(d)));
		try {
			const base = `http://127.0.0.1:${PORT}`;
			for (let i = 0; i < 40; i++) {
				try {
					if ((await fetch(`${base}/health`)).ok) break;
				} catch {}
				await new Promise((r) => setTimeout(r, 250));
			}
			return await fn(base);
		} finally {
			if (log.length && process.env.DEBUG)
				console.error("--- sandbox server log ---\n", log.join(""));
			sandbox.kill();
			// Wait for the port to actually free — a second withSandbox() call
			// reuses the SAME PORT, and kill() only sends the signal.
			await new Promise<void>((resolve) => {
				if (sandbox.exitCode !== null) return resolve();
				sandbox.once("exit", () => resolve());
				setTimeout(resolve, 3000);
			});
		}
	}

	// 5. Same call again via the CLI's --from-vault path — cumulative would be
	// 6 > 5. Refused during OUR OWN pre-flight simulate (createPaymentPayload's
	// second tx.simulate()), after the seller has been asked for its price, but before any payment is submitted — unaffected by
	// the facilitator-side limitation above.
	await withSandbox(PRICE_XLM, async (base) => {
		const over = runCurl(`${base}/data-x402`);
		const balAfterRefusal = (await vaultStatus({ wallet })).balanceStroops;
		const refused = over.status !== 0;
		const overOut = parseJsonOutput(over.stdout) as { error?: string };
		const refusalMsg = (overOut.error ?? "").slice(0, 200);
		console.log(
			refused
				? `pay ${PRICE_XLM}    ✓ REFUSED: ${refusalMsg}`
				: `pay ${PRICE_XLM}    ✗ WENT THROUGH — the cap did not hold`,
		);
		console.log(
			`  vault balance ${balAfterPay} → ${balAfterRefusal} (${balAfterPay === balAfterRefusal ? "unchanged ✓" : "CHANGED ✗"})`,
		);
		if (!refused || balAfterPay !== balAfterRefusal)
			throw new Error("over-cap x402 payment was not refused — cap FAILED");
		if (!/spending limit|exceed/i.test(refusalMsg))
			console.log(
				"  (note: refusal text didn't match /spending limit|exceed/i — check the receipt classification below)",
			);
	});

	// Ledger: only a real chain refusal may be receipted as a policy
	// decision — same distinction drawFromVault draws (see vault-x402.ts).
	const { readFileSync } = await import("node:fs");
	const rows = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(
			(l) =>
				JSON.parse(l) as {
					kind: string;
					detail?: { rule?: string; allowed?: boolean };
				},
		);
	const refusalRow = rows.find(
		(r) =>
			r.kind === "policy-decision" &&
			r.detail?.allowed === false &&
			r.detail?.rule === "vault spending-limit (on-chain)",
	);
	console.log(
		`ledger   over-cap x402 payment receipted as an on-chain policy decision (${refusalRow ? "✓" : "✗"})`,
	);
	if (!refusalRow)
		throw new Error("the refusal was not receipted as a policy decision");

	// 6. INFORMATIONAL, does not gate pass/fail on which OUTCOME it hits, only
	// on whether it's an outcome we recognize: a fresh, small-priced sandbox
	// (well under whatever cap headroom remains) hitting the REAL facilitator.
	// Today this documents the known limitation above; if it ever starts
	// succeeding, that is upstream progress worth noticing here, not silence.
	await withSandbox(FACILITATOR_CHECK_XLM, async (base) => {
		const check = runCurl(`${base}/data-x402`);
		if (check.status === 0) {
			console.log(
				"facilitator-check ✓ the REAL /data-x402 facilitator settled a capped vault payment — the event-validation limitation above appears FIXED upstream.",
			);
			return;
		}
		// Two distinct failure shapes reach stdout here: a client-side throw
		// (main().catch's {error: msg}) if createPaymentPayload itself failed,
		// or a normal 402 response (cmdCurl's own {status, body, paid: null,
		// declined, not_payable}, with the facilitator's own error nested as a
		// JSON STRING inside `body`) if the facilitator declined a payload we
		// successfully built and sent. A raw substring match on the whole
		// output is robust to either shape, and to the field only existing
		// nested inside `body`.
		const known = check.stdout.includes(
			"invalid_exact_stellar_payload_event_not_transfer",
		);
		console.log(
			known
				? "facilitator-check — reproduced the known limitation (invalid_exact_stellar_payload_event_not_transfer), as documented above."
				: `facilitator-check — refused for an UNEXPECTED reason:\n${check.stdout.slice(0, 500)}`,
		);
		if (!known)
			throw new Error(
				"facilitator-check hit an unexpected error, not the documented event-shape limitation",
			);
	});

	console.log(
		"\nRESULT: PASS — the vault contract paid directly (x402 exact payload, settled on-chain with a real tx hash), sharing the SAME on-chain cap as drawFromVault: under-cap succeeded, cumulative over-cap was refused BY THE CHAIN before any payment transaction, refusal receipted. The sandbox's real facilitator round-trip reproduced (or, if fixed upstream, cleared) the documented event-validation limitation.",
	);
	console.log(
		`explorer  https://stellar.expert/explorer/testnet/contract/${rec.contractId}`,
	);
	console.log(`direct-settle tx hash  ${payHash}`);
}

main().catch((err) => {
	console.error("FATAL:", err?.stderr?.toString?.() ?? err?.message ?? err);
	process.exit(1);
});
