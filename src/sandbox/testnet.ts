/**
 * End-to-end proof on testnet, fully automated: mint our own SEP-41 asset
 * (Circle's USDC faucet is captcha-only, so USDC cannot be scripted), deploy
 * its Stellar Asset Contract, run SDF's MPP charge server locally priced in
 * that asset with fees sponsored, and pay it through payFetch. Passes when the
 * server answers 200 and the settlement transaction is on-chain.
 *
 * Exercises MPP pull mode end to end. x402 needs a facilitator on the server
 * side (OZ Channels, API key), so its client path is proven on mainnet only.
 */

import * as stellarServer from "@stellar/mpp/charge/server";
import {
	Asset,
	Horizon,
	Keypair,
	Networks,
	Operation,
	rpc,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import express from "express";
import { Mppx } from "mppx/express";
import { Store } from "mppx/server";
import { payFetch } from "../pay/curl.js";
import { describeOffer } from "../pay/offers.js";
import type { Wallet } from "../pay/wallet.js";

const HORIZON = "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(HORIZON);
const soroban = new rpc.Server("https://soroban-testnet.stellar.org");

/** Soroban txs carry exactly one op and must be simulation-prepared. */
async function submitSoroban(
	source: Keypair,
	op: ReturnType<typeof Operation.createStellarAssetContract>,
) {
	const acct = await soroban.getAccount(source.publicKey());
	const tx = new TransactionBuilder(acct, {
		fee: "100000",
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(op)
		.setTimeout(60)
		.build();
	const prepared = await soroban.prepareTransaction(tx);
	prepared.sign(source);
	const sent = await soroban.sendTransaction(prepared);
	if (sent.status === "ERROR")
		throw new Error(
			`soroban send failed: ${JSON.stringify(sent.errorResult ?? sent)}`,
		);
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 2000));
		const got = await soroban.getTransaction(sent.hash);
		if (got.status === "SUCCESS") return sent.hash;
		if (got.status === "FAILED")
			throw new Error(`soroban tx failed: ${sent.hash}`);
	}
	throw new Error(`soroban tx ${sent.hash} not confirmed in 60s`);
}
const log = (m: string) => console.log(`  ${m}`);

async function fund(kp: Keypair) {
	const r = await fetch(
		`https://friendbot.stellar.org?addr=${kp.publicKey()}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function submit(
	source: Keypair,
	ops: ReturnType<typeof Operation.payment>[],
	signers: Keypair[] = [source],
) {
	const acct = await horizon.loadAccount(source.publicKey());
	const tx = new TransactionBuilder(acct, {
		fee: "10000",
		networkPassphrase: Networks.TESTNET,
	}).setTimeout(60);
	for (const op of ops) tx.addOperation(op);
	const built = tx.build();
	for (const s of signers) built.sign(s);
	try {
		const res = await horizon.submitTransaction(built);
		return res.hash;
	} catch (e) {
		const ex = (
			e as { response?: { data?: { extras?: { result_codes?: unknown } } } }
		).response?.data?.extras;
		throw new Error(
			`submit failed: ${JSON.stringify(ex?.result_codes ?? (e as Error).message)} ops=${built.operations.length} source=${source.publicKey().slice(0, 6)} xdr=${built.toXDR().slice(0, 40)}`,
		);
	}
}

async function main() {
	console.log(
		"sandbox — MPP charge, pull mode, sponsored fees, own SEP-41 asset on testnet\n",
	);
	const issuer = Keypair.random();
	const payer = Keypair.random();
	const recipient = Keypair.random(); // also the fee payer: friendbot gives it XLM
	await Promise.all([issuer, payer, recipient].map(fund));
	log(
		`funded issuer ${issuer.publicKey().slice(0, 6)}… payer ${payer.publicKey().slice(0, 6)}… recipient ${recipient.publicKey().slice(0, 6)}…`,
	);

	const asset = new Asset("SPAY", issuer.publicKey());
	await submit(payer, [Operation.changeTrust({ asset })]);
	await submit(recipient, [Operation.changeTrust({ asset })]);
	await submit(issuer, [
		Operation.payment({ destination: payer.publicKey(), asset, amount: "100" }),
	]);
	await submitSoroban(issuer, Operation.createStellarAssetContract({ asset }));
	const sac = asset.contractId(Networks.TESTNET);
	log(`issued 100 SPAY to payer; SAC deployed ${sac.slice(0, 6)}…`);

	const mppx = Mppx.create({
		secretKey: "sandbox-credential-secret",
		methods: [
			stellarServer.stellar.charge({
				recipient: recipient.publicKey(),
				currency: sac,
				network: "stellar:testnet",
				store: Store.memory(),
				feePayer: { envelopeSigner: recipient },
			}),
		],
	});
	const app = express();
	app.get(
		"/data",
		mppx.charge({ amount: "0.001", description: "sandbox paid call" }),
		(_req, res) => {
			res.json({ ok: true, paid: true, at: new Date().toISOString() });
		},
	);
	const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
		const s = app.listen(0, () => resolve(s));
	});
	const addr = server.address();
	const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/data`;
	log(
		`MPP charge server on ${url}, price 0.001 SPAY, fees sponsored by recipient`,
	);

	const wallet: Wallet = {
		keypair: payer,
		publicKey: payer.publicKey(),
		network: "stellar:testnet",
	};
	const r = await payFetch(
		url,
		{ method: "GET" },
		{
			wallet,
			approve: async (o) => {
				log(`402 asks: ${describeOffer(o)} → approving`);
				return true;
			},
		},
	);
	const body = await r.res.text();
	log(`response ${r.res.status}: ${body.slice(0, 80)}`);
	server.close();

	if (r.res.status !== 200 || !r.paid)
		throw new Error(
			`expected a paid 200, got ${r.res.status} (paid=${JSON.stringify(r.paid)})`,
		);
	if (!r.paid.hash) throw new Error("paid but no settlement hash surfaced");
	const tx = (await (
		await fetch(`${HORIZON}/transactions/${r.paid.hash}`)
	).json()) as { successful?: boolean; source_account?: string };
	if (!tx.successful)
		throw new Error(`settlement ${r.paid.hash} not successful on-chain`);
	log(
		`settled on-chain: ${r.paid.hash} (source ${tx.source_account?.slice(0, 6)}… = fee payer, not the payer)`,
	);
	const bal = (await horizon.loadAccount(payer.publicKey())).balances.find(
		(b) => "asset_code" in b && b.asset_code === "SPAY",
	);
	log(
		`payer SPAY balance now ${bal && "balance" in bal ? bal.balance : "?"} (was 100)`,
	);
	console.log(
		"\nPASS — paid a live 402 with a Stellar wallet, fees sponsored, settlement on-chain.",
	);
}

main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
