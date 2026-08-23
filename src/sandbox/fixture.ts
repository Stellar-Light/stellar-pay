/** The testnet fixture both proofs share: own SEP-41 asset, its SAC, a local MPP charge server. */

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

export const HORIZON = "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(HORIZON);
const soroban = new rpc.Server("https://soroban-testnet.stellar.org");

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
) {
	const acct = await horizon.loadAccount(source.publicKey());
	const tx = new TransactionBuilder(acct, {
		fee: "10000",
		networkPassphrase: Networks.TESTNET,
	}).setTimeout(60);
	for (const op of ops) tx.addOperation(op);
	const built = tx.build();
	built.sign(source);
	try {
		return (await horizon.submitTransaction(built)).hash;
	} catch (e) {
		const ex = (
			e as { response?: { data?: { extras?: { result_codes?: unknown } } } }
		).response?.data?.extras;
		throw new Error(
			`submit failed: ${JSON.stringify(ex?.result_codes ?? (e as Error).message)}`,
		);
	}
}

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

export async function setupSandbox(log: (m: string) => void = () => {}) {
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
	return {
		url,
		payer,
		sac,
		payerBalance: async () => {
			const b = (await horizon.loadAccount(payer.publicKey())).balances.find(
				(x) => "asset_code" in x && x.asset_code === "SPAY",
			);
			return b && "balance" in b ? b.balance : "?";
		},
		close: () => server.close(),
	};
}
