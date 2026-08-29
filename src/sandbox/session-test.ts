/**
 * MPP SESSION MODE — end-to-end on Stellar TESTNET, both sides ours.
 *
 *   deploy channel (1 on-chain tx) → N paid calls, all OFF-chain →
 *   close via MPP credential (1 on-chain tx) → verify balances on Horizon
 *
 * Why this exists (Track 1 slice): charge mode settles on-chain per request —
 * right for one-offs, wrong for a busy agent loop. A one-way channel is
 * deposit-once, sign-cumulative-commitments, settle-once. pay.sh ships this
 * for Solana; this is the Stellar client+server loop, run entirely against
 * our own sandbox so no external channel-mode server needs to exist yet.
 *
 * TESTNET ONLY by policy: the one-way-channel contract states it is
 * unaudited. Mainnet is gated on that audit (see the roadmap).
 *
 * The channel wasm is NOT built here (no rust in the loop): the contract's
 * code is already on testnet, content-addressed by the wasm hash the
 * stellar-mpp-sdk demo uploaded. We deploy an instance from the hash with
 * constructor args (token, funder, commitment_key, recipient, deposit,
 * refund_waiting_period) — the exact __constructor of one-way-channel.
 *
 *   npm run test:session          # N=8 session calls + 2 charge calls, full close
 *   SESSION_CALLS=20 npm run test:session
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
	Asset,
	BASE_FEE,
	Keypair,
	Networks,
	Operation,
	rpc,
	StrKey,
	TransactionBuilder,
	xdr,
	Address,
	nativeToScVal,
} from "@stellar/stellar-sdk";
import { Mppx } from "mppx/client";
import { stellar as stellarChannelClient } from "@stellar/mpp/channel/client";

const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
// The one-way-channel wasm already on testnet (uploaded by the SDK's own e2e
// demo; content-addressed, so deploying from the hash IS deploying that code).
const WASM_HASH =
	"f9b7fdf860ce427097226f45f72b336763ca55d46c967076a94eb9682d8c484b";
const PORT = Number(process.env.SESSION_PORT ?? 8899);
const N = Number(process.env.SESSION_CALLS ?? 8);
const PRICE_XLM = "0.001"; // per call, matches the sandbox default
const DEPOSIT_STROOPS = 10_000_000n; // 1 XLM — covers hundreds of calls
const CHARGE_CALLS = 2;

const server = new rpc.Server(RPC_URL);
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

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
	if (!r.ok) throw new Error(`horizon ${r.status} for ${pub}`);
	const d = (await r.json()) as {
		balances: Array<{ asset_type: string; balance: string }>;
	};
	const nat = d.balances.find((b) => b.asset_type === "native");
	return stroops(nat?.balance ?? "0");
}

async function txCount(pub: string): Promise<number> {
	const r = await fetch(
		`${HORIZON}/accounts/${pub}/transactions?limit=200&order=desc`,
	);
	if (!r.ok) return -1;
	const d = (await r.json()) as { _embedded?: { records?: unknown[] } };
	return (d._embedded?.records ?? []).length;
}

/** Deploy a one-way-channel instance from the on-chain wasm hash. ONE tx:
 * create + __constructor (deposit moves inside it, funder-authorized). */
async function deployChannel(
	funder: Keypair,
	commitmentPub: Buffer,
	recipient: string,
): Promise<{ contract: string; hash: string }> {
	const acct = await server.getAccount(funder.publicKey());
	const op = Operation.createCustomContract({
		address: Address.fromString(funder.publicKey()),
		wasmHash: Buffer.from(WASM_HASH, "hex"),
		salt: crypto.randomBytes(32),
		constructorArgs: [
			Address.fromString(XLM_SAC).toScVal(),
			Address.fromString(funder.publicKey()).toScVal(),
			xdr.ScVal.scvBytes(commitmentPub),
			Address.fromString(recipient).toScVal(),
			nativeToScVal(DEPOSIT_STROOPS, { type: "i128" }),
			nativeToScVal(100, { type: "u32" }),
		],
	});
	const tx = new TransactionBuilder(acct, {
		fee: (Number(BASE_FEE) * 1000).toString(),
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(op)
		.setTimeout(60)
		.build();
	const prepared = await server.prepareTransaction(tx);
	prepared.sign(funder);
	const sent = await server.sendTransaction(prepared);
	if (sent.status === "ERROR")
		throw new Error(`deploy send failed: ${JSON.stringify(sent.errorResult)}`);
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		const res = await server.getTransaction(sent.hash);
		if (res.status === "SUCCESS")
			return {
				contract: Address.fromScVal(res.returnValue!).toString(),
				hash: sent.hash,
			};
		if (res.status === "FAILED")
			throw new Error(`deploy failed: ${sent.hash}`);
	}
	throw new Error("deploy timed out");
}

async function waitHealthy(url: string) {
	for (let i = 0; i < 40; i++) {
		try {
			const r = await fetch(`${url}/health`);
			if (r.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("sandbox never became healthy");
}

async function main() {
	console.log("═══ MPP session mode — testnet e2e (both sides ours) ═══\n");

	// ── Accounts ──────────────────────────────────────────────────────────
	const funder = Keypair.random(); // the buyer/agent side
	const seller = Keypair.random(); // the sandbox operator side
	await Promise.all([
		friendbot(funder.publicKey()),
		friendbot(seller.publicKey()),
	]);
	const commitSeed = crypto.randomBytes(32);
	const commitKp = Keypair.fromRawEd25519Seed(commitSeed);
	console.log(`funder    ${funder.publicKey()}`);
	console.log(`seller    ${seller.publicKey()}`);
	console.log(`commit    ${commitKp.publicKey()} (ed25519, off-chain only)\n`);

	// ── Open: ONE on-chain tx (deploy + deposit) ──────────────────────────
	const t0 = Date.now();
	const { contract, hash: openHash } = await deployChannel(
		funder,
		Buffer.from(commitKp.rawPublicKey()),
		seller.publicKey(),
	);
	const openMs = Date.now() - t0;
	console.log(`channel   ${contract}`);
	console.log(
		`open      1 on-chain tx, ${openMs} ms, deposit 1 XLM → https://stellar.expert/explorer/testnet/tx/${openHash}\n`,
	);

	// ── Spawn OUR sandbox in channel mode ─────────────────────────────────
	const child = spawn(
		"npx",
		["tsx", "sandbox-server/server.ts"],
		{
			env: {
				...process.env,
				SELLER_SECRET_KEY: seller.secret(),
				CHANNEL_CONTRACT: contract,
				COMMITMENT_PUBKEY: Buffer.from(commitKp.rawPublicKey()).toString(
					"hex",
				),
				PORT: String(PORT),
				PRICE_XLM,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const serverLog: string[] = [];
	child.stdout.on("data", (d) => serverLog.push(String(d)));
	child.stderr.on("data", (d) => serverLog.push(String(d)));
	const base = `http://127.0.0.1:${PORT}`;
	try {
		await waitHealthy(base);
		const health = (await (await fetch(`${base}/health`)).json()) as {
			channelMode?: boolean;
		};
		if (!health.channelMode) throw new Error("sandbox did not enable channel mode");
		console.log(`sandbox   ${base} (channel mode on)\n`);

		const sellerTxBefore = await txCount(seller.publicKey());
		const sellerBalBefore = await xlmBalance(seller.publicKey());

		// ── Session client: N calls, zero on-chain txs ──────────────────────
		const mppx = Mppx.create({
			methods: [
				stellarChannelClient.channel({
					commitmentKey: commitKp,
					allowedChannels: [contract],
				}),
			],
		});
		const sessionFetch = mppx.fetch;

		const times: number[] = [];
		let lastBody: { mode?: string } = {};
		for (let i = 0; i < N; i++) {
			const s = Date.now();
			const r = await sessionFetch(`${base}/data-session`);
			times.push(Date.now() - s);
			if (r.status !== 200)
				throw new Error(`session call ${i + 1} → ${r.status}: ${await r.text()}`);
			lastBody = (await r.json()) as { mode?: string };
		}
		const cumulative = stroops(PRICE_XLM) * BigInt(N);
		console.log(
			`session   ${N} paid calls, all off-chain (mode=${lastBody.mode}), cumulative ${cumulative} stroops`,
		);
		console.log(
			`          per-call ms: [${times.join(", ")}] · mean ${(times.reduce((a, b) => a + b, 0) / N).toFixed(0)} ms`,
		);
		const sellerTxDuring = await txCount(seller.publicKey());
		console.log(
			`          seller on-chain txs during session: ${sellerTxDuring - sellerTxBefore} (expected 0)\n`,
		);

		// ── Charge mode on the same server, for the honest comparison ──────
		const chargeTimes: number[] = [];
		{
			const { Mppx: ChargeMppx } = await import("mppx/client");
			const { stellar: chargeClient } = await import(
				"@stellar/mpp/charge/client"
			);
			const chargeMppx = ChargeMppx.create({
				methods: [chargeClient.charge({ keypair: funder })],
			});
			const chargeFetch = chargeMppx.fetch;
			for (let i = 0; i < CHARGE_CALLS; i++) {
				const s = Date.now();
				const r = await chargeFetch(`${base}/data`);
				chargeTimes.push(Date.now() - s);
				if (r.status !== 200)
					throw new Error(`charge call ${i + 1} → ${r.status}`);
			}
			console.log(
				`charge    ${CHARGE_CALLS} paid calls, EACH one on-chain settle · per-call ms: [${chargeTimes.join(", ")}]\n`,
			);
		}

		// ── Close via the MPP credential path: ONE on-chain tx ─────────────
		// The client signs an action:'close' commitment ABOVE the last voucher
		// cumulative; the server validates and broadcasts with its feePayer.
		const closeCumulative = cumulative + stroops(PRICE_XLM);
		const s = Date.now();
		// The polyfill-aware fetch accepts a `context` carrying the channel
		// action; the server validates the close credential and broadcasts
		// the on-chain close with its feePayer (the seller).
		const closeRes = await sessionFetch(`${base}/data-session`, {
			context: {
				action: "close",
				cumulativeAmount: closeCumulative.toString(),
			},
		} as RequestInit);
		if (closeRes.status !== 200)
			console.log(`close     response ${closeRes.status}: ${await closeRes.text()}`);
		const closeMs = Date.now() - s;
		console.log(
			`close     requested via MPP credential (${closeMs} ms) — waiting for on-chain settle…`,
		);
		// Verify on Horizon via the EXACT, fee-free signal: the contract's close
		// pays the recipient the cumulative and auto-refunds the funder the
		// remainder IN THE SAME TX — so the funder must be credited exactly
		// deposit − closeCumulative. (The seller's raw balance delta is the
		// wrong meter: as feePayer it also pays broadcast fees.)
		await new Promise((r) => setTimeout(r, 6000));
		const expectedRefund = DEPOSIT_STROOPS - closeCumulative;
		let refunded = false;
		for (let i = 0; i < 10 && !refunded; i++) {
			const r = await fetch(
				`${HORIZON}/accounts/${funder.publicKey()}/effects?limit=10&order=desc`,
			);
			const d = (await r.json()) as {
				_embedded?: { records?: Array<{ type: string; amount?: string }> };
			};
			refunded = (d._embedded?.records ?? []).some(
				(e) =>
					e.type === "account_credited" &&
					stroops(e.amount ?? "0") === expectedRefund,
			);
			if (!refunded) await new Promise((r2) => setTimeout(r2, 2000));
		}
		const sellerBalAfter = await xlmBalance(seller.publicKey());
		const delta = sellerBalAfter - sellerBalBefore;
		console.log(
			`verify    funder refunded exactly ${expectedRefund} stroops (deposit − close cumulative): ${refunded ? "YES ✓" : "NOT FOUND"}`,
		);
		console.log(
			`          seller raw delta ${delta} stroops = ${cumulative + stroops(PRICE_XLM)} close payout + ${stroops(PRICE_XLM) * BigInt(CHARGE_CALLS)} charge income − broadcast fees (seller is feePayer)`,
		);
		console.log(
			`          funder https://stellar.expert/explorer/testnet/account/${funder.publicKey()}`,
		);
		console.log(
			`          seller https://stellar.expert/explorer/testnet/account/${seller.publicKey()}`,
		);

		// ── Benchmark summary ───────────────────────────────────────────────
		const sMean = times.reduce((a, b) => a + b, 0) / times.length;
		const cMean =
			chargeTimes.reduce((a, b) => a + b, 0) / (chargeTimes.length || 1);
		console.log(`\n═══ Session vs charge (same server, same testnet) ═══`);
		console.log(
			`  charge : ${cMean.toFixed(0)} ms/call · 1 on-chain tx PER CALL`,
		);
		console.log(
			`  session: ${sMean.toFixed(0)} ms/call · ${(openMs / N).toFixed(0)} ms/call amortized open · on-chain txs total: 2 (open+close) for ${N} calls`,
		);
		console.log(
			`  speedup: ${(cMean / sMean).toFixed(1)}× per call · on-chain load: ${N}→2 txs`,
		);
		if (!refunded) {
			console.log(
				"\nRESULT: PARTIAL — off-chain session path PASSED; close refund not observed on Horizon.",
			);
			process.exitCode = 1;
		} else {
			console.log(
				"\nRESULT: PASS — full lifecycle (open → off-chain session → close + exact refund) verified on testnet.",
			);
		}
	} finally {
		child.kill();
		if (process.exitCode) {
			console.log("\n── sandbox log tail ──");
			console.log(serverLog.join("").split("\n").slice(-15).join("\n"));
		}
	}
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
