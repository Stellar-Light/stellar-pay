/**
 * x402 v2 CONFORMANCE — an UNMODIFIED @x402/fetch client pays our sandbox.
 *
 * The point (same philosophy as test:parity, and the reason this endpoint
 * exists): a Bazaar listing is worthless if only our own client can pay it.
 * So the proof drives the STOCK client stack — @x402/fetch wrapFetchWithPayment
 * + @x402/core x402Client + @x402/stellar exact client scheme — against
 * /data-x402 with a fresh friendbot wallet, settles on testnet for real, and
 * verifies the seller was credited on Horizon.
 *
 * Research tie: the PAYMENT-RESPONSE header we decode at the end IS the
 * receipt — the settle object with the on-chain transaction hash. That
 * artifact (payment receipt as portable proof) is the PGTR-pattern substrate
 * the strategy builds on.
 *
 *   npm run test:x402
 */
import { spawn } from "node:child_process";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as X402ClientScheme } from "@x402/stellar/exact/client";

const HORIZON = "https://horizon-testnet.stellar.org";
const PORT = Number(process.env.X402_PORT ?? 8898);
const PRICE_XLM = "0.001";

function stroops(xlm: string): bigint {
	const [i = "0", f = ""] = xlm.split(".");
	return BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
}

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function xlmBalance(pub: string): Promise<bigint> {
	const r = await fetch(`${HORIZON}/accounts/${pub}`);
	if (!r.ok) throw new Error(`horizon ${r.status}`);
	const d = (await r.json()) as {
		balances: Array<{ asset_type: string; balance: string }>;
	};
	return stroops(
		d.balances.find((b) => b.asset_type === "native")?.balance ?? "0",
	);
}

async function main() {
	console.log("═══ x402 v2 conformance — stock client pays our sandbox ═══\n");
	const buyer = Keypair.random();
	const seller = Keypair.random();
	await Promise.all([
		friendbot(buyer.publicKey()),
		friendbot(seller.publicKey()),
	]);
	console.log(`buyer   ${buyer.publicKey()}`);
	console.log(`seller  ${seller.publicKey()}\n`);

	const child = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
		env: {
			...process.env,
			SELLER_SECRET_KEY: seller.secret(),
			PORT: String(PORT),
			PRICE_XLM,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log: string[] = [];
	child.stdout.on("data", (d) => log.push(String(d)));
	child.stderr.on("data", (d) => log.push(String(d)));
	const base = `http://127.0.0.1:${PORT}`;
	try {
		for (let i = 0; i < 40; i++) {
			try {
				if ((await fetch(`${base}/health`)).ok) break;
			} catch {}
			await new Promise((r) => setTimeout(r, 250));
		}

		// 1) Bare request must 402 with the canonical v2 header.
		const bare = await fetch(`${base}/data-x402`);
		const prHeader = bare.headers.get("PAYMENT-REQUIRED");
		console.log(
			`bare    ${bare.status} · PAYMENT-REQUIRED header: ${prHeader ? "present" : "MISSING"}`,
		);
		if (bare.status !== 402 || !prHeader) throw new Error("402 shape wrong");

		// 2) The STOCK client pays it. Nothing of ours in the loop.
		const sellerBefore = await xlmBalance(seller.publicKey());
		// Stock client, ONE knob: its spend controls default to USD-priced
		// default assets (USDC) — native XLM needs an explicit allow. This is
		// buyer-side configuration, not a modification of the client.
		const client = x402Client.fromConfig({
			schemes: [
				{
					network: "stellar:testnet",
					client: new X402ClientScheme(createEd25519Signer(buyer.secret())),
				},
			],
			spendControls: {
				allowedAssets: [
					{
						asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
						network: "stellar:testnet",
					},
				],
			},
		});
		const fetchWithPay = wrapFetchWithPayment(fetch, client);
		const t = Date.now();
		const paid = await fetchWithPay(`${base}/data-x402`);
		const ms = Date.now() - t;
		const body = (await paid.json()) as {
			mode?: string;
			transaction?: string;
		};
		console.log(
			`paid    ${paid.status} in ${ms} ms · mode=${body.mode} · tx=${(body.transaction ?? "").slice(0, 12)}…`,
		);
		if (paid.status !== 200) throw new Error(`paid call → ${paid.status}`);

		// 3) The receipt: PAYMENT-RESPONSE decodes to the settle object.
		const respHeader = paid.headers.get("PAYMENT-RESPONSE");
		if (!respHeader) throw new Error("PAYMENT-RESPONSE header missing");
		const receipt = decodePaymentResponseHeader(respHeader);
		console.log(
			`receipt success=${(receipt as { success?: boolean }).success} network=${(receipt as { network?: string }).network} tx=${((receipt as { transaction?: string }).transaction ?? "").slice(0, 12)}…`,
		);

		// 4) On-chain truth: the receipt's tx must carry the exact payment
		// effect (buyer → seller, PRICE). The seller's NET balance is the wrong
		// meter here: it sponsors the network fee, which at this demo price
		// EXCEEDS the payment (fee ≈ 0.002 XLM vs price 0.001) — economically
		// real, honestly noted, and irrelevant to whether the payment settled.
		await new Promise((r) => setTimeout(r, 4000));
		const txHash = (receipt as { transaction?: string }).transaction ?? "";
		const fx = await fetch(
			`${HORIZON}/transactions/${txHash}/effects?limit=20`,
		);
		const fxd = (await fx.json()) as {
			_embedded?: {
				records?: Array<{ type: string; account?: string; amount?: string }>;
			};
		};
		const credited = (fxd._embedded?.records ?? []).find(
			(e) =>
				e.type === "account_credited" &&
				e.account === seller.publicKey() &&
				stroops(e.amount ?? "0") === stroops(PRICE_XLM),
		);
		const sellerAfter = await xlmBalance(seller.publicKey());
		console.log(
			`horizon tx ${txHash.slice(0, 12)}… carries account_credited ${PRICE_XLM} XLM → seller: ${credited ? "YES ✓" : "NOT FOUND"}`,
		);
		console.log(
			`        seller NET delta ${sellerAfter - sellerBefore} stroops (payment ${stroops(PRICE_XLM)} minus the sponsored network fee — the demo price is below the soroban fee, deliberately)`,
		);
		console.log(`        https://stellar.expert/explorer/testnet/tx/${txHash}`);
		if (!credited)
			throw new Error("payment effect not found in the receipt's tx");
		console.log(
			"\nRESULT: PASS — unmodified @x402/fetch client paid our x402 v2 endpoint, settled on testnet, receipt decoded.",
		);
	} catch (err) {
		console.log("\n── sandbox log tail ──");
		console.log(log.join("").split("\n").slice(-12).join("\n"));
		throw err;
	} finally {
		child.kill();
	}
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
