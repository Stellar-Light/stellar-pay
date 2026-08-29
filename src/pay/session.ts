/**
 * Session mode — one-way payment channels behind a per-host registry.
 *
 * The economics: charge mode settles on-chain PER CALL (~5s, a fee each
 * time); a session deposits ONCE into a channel contract and then signs
 * off-chain cumulative commitments per call (~0.5s, no fee), settling when
 * the channel closes. Deposit default: 5 XLM per host (owner decision,
 * 2026-08-29) — that is the maximum exposure to a given seller, ever,
 * because the channel contract can pay the recipient at most the deposit.
 *
 * TESTNET ONLY: the one-way-channel contract is unaudited by its own
 * README. `openChannel` refuses any non-testnet wallet.
 *
 * The seller must know the channel: `session open` prints the contract id
 * and commitment public key for the operator (our sandbox takes them as
 * CHANNEL_CONTRACT / COMMITMENT_PUBKEY env). A registration handshake in
 * the MPP spec is the missing upstream piece — noted in the roadmap.
 */
import crypto from "node:crypto";
import { stellar as channelClient } from "@stellar/mpp/channel/client";
import {
	Address,
	Asset,
	BASE_FEE,
	Keypair,
	Networks,
	nativeToScVal,
	Operation,
	rpc,
	TransactionBuilder,
	xdr,
} from "@stellar/stellar-sdk";
import { Mppx } from "mppx/client";
import { record } from "./receipts.js";
import {
	fileStore,
	getChannel,
	putChannel,
	updateChannel,
} from "./session-store.js";
import type { Wallet } from "./wallet.js";

/** The one-way-channel wasm already on testnet, content-addressed (uploaded
 * by the stellar-mpp-sdk demo; deploying from the hash IS that code). */
const WASM_HASH =
	"f9b7fdf860ce427097226f45f72b336763ca55d46c967076a94eb9682d8c484b";
const RPC_URL = "https://soroban-testnet.stellar.org";
export const DEFAULT_DEPOSIT_XLM = 5;
const REFUND_WAIT_LEDGERS = 100;

export const hostOf = (url: string) => new URL(url).host;

export function stroopsFromXlm(xlm: number): bigint {
	return BigInt(Math.round(xlm * 10_000_000));
}

/** Deploy a one-way channel from the on-chain wasm hash: ONE transaction
 * (create + __constructor moves the deposit, funder-authorized). */
export async function openChannel(o: {
	wallet: Wallet;
	url: string;
	/** the seller's receiving account — read from their own 402 challenge */
	recipient: string;
	depositXlm?: number;
}): Promise<{
	contract: string;
	tx: string;
	commitmentPubHex: string;
	host: string;
	receiptId: string;
}> {
	if (o.wallet.network !== "stellar:testnet")
		throw new Error(
			"session mode is testnet-only: the one-way-channel contract is unaudited (its own README says so); mainnet is gated on that audit",
		);
	const host = hostOf(o.url);
	const existing = getChannel(host);
	if (existing)
		throw new Error(
			`a channel for ${host} already exists (${existing.contract}) — close it first or reuse it with curl --session`,
		);
	const deposit = stroopsFromXlm(o.depositXlm ?? DEFAULT_DEPOSIT_XLM);
	const commitSeed = crypto.randomBytes(32);
	const commitKp = Keypair.fromRawEd25519Seed(commitSeed);
	const server = new rpc.Server(RPC_URL);
	const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

	const acct = await server.getAccount(o.wallet.publicKey);
	const op = Operation.createCustomContract({
		address: Address.fromString(o.wallet.publicKey),
		wasmHash: Buffer.from(WASM_HASH, "hex"),
		salt: crypto.randomBytes(32),
		constructorArgs: [
			Address.fromString(XLM_SAC).toScVal(),
			Address.fromString(o.wallet.publicKey).toScVal(),
			xdr.ScVal.scvBytes(Buffer.from(commitKp.rawPublicKey())),
			Address.fromString(o.recipient).toScVal(),
			nativeToScVal(deposit, { type: "i128" }),
			nativeToScVal(REFUND_WAIT_LEDGERS, { type: "u32" }),
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
	prepared.sign(o.wallet.keypair);
	const sent = await server.sendTransaction(prepared);
	if (sent.status === "ERROR")
		throw new Error(
			`channel deploy rejected: ${JSON.stringify(sent.errorResult)}`,
		);
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		const res = await server.getTransaction(sent.hash);
		if (res.status === "SUCCESS") {
			const contract = Address.fromScVal(res.returnValue!).toString();
			putChannel(host, {
				contract,
				commitmentSeedHex: commitSeed.toString("hex"),
				funder: o.wallet.publicKey,
				recipient: o.recipient,
				depositStroops: deposit.toString(),
				network: o.wallet.network,
				openedAt: new Date().toISOString(),
				openTx: sent.hash,
			});
			const receiptId = record({
				kind: "channel-open",
				network: o.wallet.network,
				url: o.url,
				amount: deposit.toString(),
				payer: o.wallet.publicKey,
				payee: o.recipient,
				tx: sent.hash,
				detail: { host, contract },
			});
			return {
				contract,
				tx: sent.hash,
				commitmentPubHex: Buffer.from(commitKp.rawPublicKey()).toString("hex"),
				host,
				receiptId,
			};
		}
		if (res.status === "FAILED")
			throw new Error(`channel deploy failed: ${sent.hash}`);
	}
	throw new Error("channel deploy timed out");
}

/** A payment-aware fetch bound to the host's registered channel: pays 402s
 * with off-chain commitments, persisting the cumulative baseline.
 * (Return type is annotated because declaration emit cannot name mppx's
 * internal Fetch type — TS2742; `npm run build` catches what --noEmit
 * doesn't.) */
export function sessionFetch(host: string): {
	fetch: typeof globalThis.fetch;
	channel: NonNullable<ReturnType<typeof getChannel>>;
} {
	const c = getChannel(host);
	if (!c)
		throw new Error(
			`no session channel for ${host} — open one first: stellar-pay session open <url> [--deposit ${DEFAULT_DEPOSIT_XLM}]`,
		);
	const mppx = Mppx.create({
		polyfill: false,
		methods: [
			channelClient.channel({
				commitmentKey: Keypair.fromRawEd25519Seed(
					Buffer.from(c.commitmentSeedHex, "hex"),
				),
				allowedChannels: [c.contract],
				store: fileStore(),
				onProgress(e: { type: string; cumulativeAmount?: string }) {
					// The signed event carries the cumulative the client just
					// committed to — the registry keeps the latest so `close`
					// knows where the channel stands without trusting the server.
					if (e.type === "signed" && e.cumulativeAmount)
						updateChannel(host, { lastCumulative: e.cumulativeAmount });
				},
			}),
		],
	});
	return { fetch: mppx.fetch as typeof globalThis.fetch, channel: c };
}

/** Close via the MPP credential path: the client signs an action:'close'
 * commitment for last-cumulative PLUS ONE PRICE STEP — the close rides a
 * paid request, so it must cover itself (the server enforces strictly
 * increasing by at least the challenge amount). The SERVER broadcasts the
 * on-chain close with its feePayer. */
export async function closeChannel(o: {
	url: string;
	lastCumulative: bigint;
	/** one price step (stroops) — read from the live 402 by the caller */
	priceStep: bigint;
}): Promise<{ status: number; receiptId: string }> {
	const host = hostOf(o.url);
	const { fetch: f, channel } = sessionFetch(host);
	const closeCumulative = o.lastCumulative + o.priceStep;
	const res = await f(o.url, {
		context: {
			action: "close",
			cumulativeAmount: closeCumulative.toString(),
		},
	} as RequestInit);
	const receiptId = record({
		kind: "channel-close",
		network: channel.network,
		url: o.url,
		amount: closeCumulative.toString(),
		payer: channel.funder,
		payee: channel.recipient,
		detail: { host, contract: channel.contract, status: res.status },
	});
	return { status: res.status, receiptId };
}
