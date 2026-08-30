/**
 * `--session` UX e2e — the REAL CLI drives the whole channel lifecycle.
 *
 *   session open <url>      deploys + deposits 5 XLM (default), prints the
 *                           contract + commitment pubkey for the seller
 *   curl <url> --session    pays off-chain (×3)
 *   session status          shows the channel
 *   session close <url>     settles on-chain via the MPP credential path
 *
 * Verifies at the end: the funder's refund on Horizon equals
 * deposit − (cumulative + 1 stroop close margin) EXACTLY, and the receipts
 * ledger holds the attribution chain open ← payments ← close.
 *
 *   npm run test:session-ux
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

const PORT = Number(process.env.SESSION_UX_PORT ?? 8896);
const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-session-ux-"));
const ENV = {
	...process.env,
	STELLAR_PAY_SESSION_DIR: DIR,
	STELLAR_PAY_KEYSTORE: join(DIR, "keystore.json"),
	STELLAR_PAY_PASSPHRASE: "session-ux-test",
};
const HORIZON = "https://horizon-testnet.stellar.org";
const CALLS = 3;
const PRICE_STROOPS = 10_000n; // sandbox default 0.001 XLM

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

function stroops(xlm: string): bigint {
	const [i = "0", f = ""] = xlm.split(".");
	return BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
}

async function main() {
	console.log("═══ --session UX e2e — CLI lifecycle on testnet ═══\n");
	console.log(
		cli(["setup", "--sandbox", "--save", "main", "--json"]).split("\n")[0],
	);

	const seller = Keypair.random();
	await friendbot(seller.publicKey());
	const base = `http://127.0.0.1:${PORT}`;

	// Boot WITHOUT channel mode first: `session open` must read the seller's
	// payTo from the live 402 (charge challenge carries it too).
	let child = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
		env: {
			...process.env,
			SELLER_SECRET_KEY: seller.secret(),
			PORT: String(PORT),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const wait = async () => {
		for (let i = 0; i < 40; i++) {
			try {
				if ((await fetch(`${base}/health`)).ok) return;
			} catch {}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error("sandbox not healthy");
	};
	try {
		await wait();

		// 1. OPEN — the CLI deploys + deposits (5 XLM default).
		const open = JSON.parse(
			cli(["session", "open", `${base}/data`, "--json"]),
		) as {
			host: string;
			contract: string;
			commitment_pubkey_hex: string;
			deposit_xlm: number;
			tx: string;
		};
		console.log(
			`open     channel ${open.contract.slice(0, 10)}… deposit ${open.deposit_xlm} XLM · tx ${open.tx.slice(0, 10)}…`,
		);
		if (open.deposit_xlm !== 5) throw new Error("default deposit is not 5 XLM");

		// 2. Restart the sandbox WITH channel mode (the operator's step).
		child.kill();
		// Wait for the port to actually free — SIGTERM is async and a respawn
		// into EADDRINUSE dies silently under piped stdio.
		for (let i = 0; i < 40; i++) {
			try {
				await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) });
				await new Promise((r) => setTimeout(r, 250));
			} catch {
				break;
			}
		}
		child = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
			env: {
				...process.env,
				SELLER_SECRET_KEY: seller.secret(),
				PORT: String(PORT),
				CHANNEL_CONTRACT: open.contract,
				COMMITMENT_PUBKEY: open.commitment_pubkey_hex,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		await wait();

		// 3. PAY — three off-chain session calls through the real CLI.
		for (let i = 1; i <= CALLS; i++) {
			const r = JSON.parse(
				cli(["curl", `${base}/data-session`, "--session", "--json"]),
			) as { status: number; session?: { ms: number; offChain: boolean } };
			if (r.status !== 200) throw new Error(`session call ${i} → ${r.status}`);
			console.log(
				`pay #${i}   ${r.session?.ms} ms · off-chain=${r.session?.offChain}`,
			);
		}

		// 4. STATUS — the registry knows the channel.
		const status = JSON.parse(cli(["session", "--json"])) as {
			channels: Record<string, { contract: string; lastCumulative?: string }>;
		};
		const chan = status.channels[open.host];
		console.log(
			`status   ${open.host} → ${chan?.contract.slice(0, 10)}… cumulative ${chan?.lastCumulative}`,
		);
		const expectedCumulative = PRICE_STROOPS * BigInt(CALLS);
		if (BigInt(chan?.lastCumulative ?? "0") !== expectedCumulative)
			throw new Error(
				`cumulative ${chan?.lastCumulative} ≠ expected ${expectedCumulative}`,
			);

		// 5. CLOSE — settles on-chain; funder refunded deposit − (cumulative+1).
		const funderBefore = (
			status.channels[open.host] as unknown as { funder: string }
		).funder;
		const close = JSON.parse(
			cli(["session", "close", `${base}/data-session`, "--json"]),
		) as { status: number; settled_cumulative: string };
		console.log(
			`close    status ${close.status} · settled ${close.settled_cumulative} stroops`,
		);
		if (close.status !== 200) throw new Error("close failed");

		// Verify the exact refund effect on Horizon (fee-free signal).
		await new Promise((r) => setTimeout(r, 6000));
		const expectedRefund = stroops("5") - (expectedCumulative + PRICE_STROOPS);
		const fx = await fetch(
			`${HORIZON}/accounts/${funderBefore}/effects?limit=10&order=desc`,
		);
		const fxd = (await fx.json()) as {
			_embedded?: { records?: Array<{ type: string; amount?: string }> };
		};
		const refunded = (fxd._embedded?.records ?? []).some(
			(e) =>
				e.type === "account_credited" &&
				stroops(e.amount ?? "0") === expectedRefund,
		);
		console.log(
			`verify   funder refunded exactly ${expectedRefund} stroops: ${refunded ? "YES ✓" : "NOT FOUND"}`,
		);
		if (!refunded) throw new Error("refund not observed");

		// 6. The attribution chain in the ledger.
		const ledger = JSON.parse(cli(["receipts", "--limit", "50", "--json"])) as {
			receipts: Array<{ kind: string; refs?: string[]; id: string }>;
		};
		const openRow = ledger.receipts.find((r) => r.kind === "channel-open");
		const payRows = ledger.receipts.filter(
			(r) => r.kind === "payment" && r.refs?.includes(openRow?.id ?? ""),
		) as Array<{ id: string; amount?: string }>;
		const closeRow = ledger.receipts.find((r) => r.kind === "channel-close");
		console.log(
			`ledger   open ${openRow?.id} ← ${payRows.length} payment(s) · close ${closeRow?.id}`,
		);
		if (!openRow || payRows.length !== CALLS || !closeRow)
			throw new Error("attribution chain incomplete");
		// Per-call amounts: each session receipt carries its cumulative delta.
		if (!payRows.every((r) => r.amount === PRICE_STROOPS.toString()))
			throw new Error(
				`session receipts missing per-call amounts: ${payRows.map((r) => r.amount).join(",")}`,
			);
		// Tamper check: ids re-derive; then corrupt a copy mentally — the check
		// is exercised for real in test:receipts.
		const check = JSON.parse(cli(["receipts", "check", "--json"])) as {
			ok: boolean;
			rows: number;
		};
		console.log(`check    ledger intact: ${check.ok} (${check.rows} rows)`);
		if (!check.ok) throw new Error("ledger tamper check failed");

		console.log(
			"\nRESULT: PASS — open (5 XLM default) → 3 off-chain payments → status → close with exact refund, full receipt chain.",
		);
	} finally {
		child.kill();
	}
}

main().catch((err) => {
	const detail = err?.stderr?.toString?.() || err?.stdout?.toString?.() || "";
	console.error("FATAL:", err?.message ?? err);
	if (detail) console.error("── child output ──\n" + detail.slice(-1200));
	process.exit(1);
});
