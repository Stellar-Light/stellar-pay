/**
 * The wallet basics a payment layer needs beyond paying 402s: create an
 * account that can hold USDC (a trustline is mandatory — a fresh Stellar
 * account cannot receive USDC without one), send USDC to an address, and read
 * what this wallet has paid.
 *
 * These are plain classic-asset operations the sender submits itself, so —
 * unlike the sponsored x402/MPP flows — the sender needs a little XLM for the
 * network fee (~0.00001 XLM). That is the one place a stellar-pay wallet needs
 * XLM at all.
 */
import {
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
	balances,
	HORIZON,
	type Network,
	USDC_ISSUER,
	type Wallet,
} from "./wallet.js";

const passphrase = (n: Network) =>
	n === "stellar:pubnet" ? Networks.PUBLIC : Networks.TESTNET;
const usdc = (n: Network) => new Asset("USDC", USDC_ISSUER[n]);

function server(n: Network) {
	return new Horizon.Server(HORIZON[n]);
}

async function submit(
	wallet: Wallet,
	buildOps: (b: TransactionBuilder) => void,
) {
	const horizon = server(wallet.network);
	const account = await horizon.loadAccount(wallet.publicKey);
	const builder = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: passphrase(wallet.network),
	}).setTimeout(60);
	buildOps(builder);
	const tx = builder.build();
	tx.sign(wallet.keypair);
	try {
		const res = await horizon.submitTransaction(tx);
		return res.hash;
	} catch (e) {
		const codes = (
			e as { response?: { data?: { extras?: { result_codes?: unknown } } } }
		).response?.data?.extras?.result_codes;
		throw new Error(
			`submit failed: ${JSON.stringify(codes ?? (e as Error).message)}`,
		);
	}
}

/** True once the account holds a USDC trustline (so it can receive USDC). */
export async function hasTrustline(
	publicKey: string,
	network: Network,
): Promise<boolean> {
	const b = await balances(publicKey, network);
	return b.funded && b.usdc !== null;
}

/** Add the USDC trustline to this wallet. No-op (returns null) if already present. */
export async function addTrustline(wallet: Wallet): Promise<string | null> {
	if (await hasTrustline(wallet.publicKey, wallet.network)) return null;
	return submit(wallet, (b) =>
		b.addOperation(Operation.changeTrust({ asset: usdc(wallet.network) })),
	);
}

/** Testnet only: create + fund a fresh account via friendbot. */
async function friendbot(publicKey: string): Promise<void> {
	const r = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

export type SetupResult = {
	publicKey: string;
	secret: string;
	network: Network;
	funded: boolean;
	trustlineTx: string | null;
	note: string;
};

/**
 * Create a new wallet keypair. On testnet, fund it and add the USDC trustline
 * so it is immediately usable. On mainnet we cannot fund an account, so we
 * return the address to fund and the caller adds the trustline after funding.
 * The secret is returned once, for the caller to store — never persisted here.
 */
export async function setupWallet(network: Network): Promise<SetupResult> {
	const kp = Keypair.random();
	const wallet: Wallet = { keypair: kp, publicKey: kp.publicKey(), network };
	if (network === "stellar:testnet") {
		await friendbot(kp.publicKey());
		const trustlineTx = await addTrustline(wallet);
		return {
			publicKey: kp.publicKey(),
			secret: kp.secret(),
			network,
			funded: true,
			trustlineTx,
			note: "funded on testnet and USDC trustline added — ready to receive and send USDC",
		};
	}
	return {
		publicKey: kp.publicKey(),
		secret: kp.secret(),
		network,
		funded: false,
		trustlineTx: null,
		note: "send at least ~1 XLM to this address to activate it, then run `stellar-pay setup --trustline` (with STELLAR_SECRET_KEY set to this secret) to add the USDC trustline",
	};
}

export type SendResult = {
	hash: string;
	to: string;
	amount: string;
	asset: string;
};

/** What an account holds of one asset: whether it trusts it, and the balance. */
export async function holds(
	publicKey: string,
	network: Network,
	code: string,
	issuer: string,
): Promise<{ funded: boolean; trusts: boolean; balance: string }> {
	const r = await fetch(`${HORIZON[network]}/accounts/${publicKey}`, {
		signal: AbortSignal.timeout(15_000),
	});
	if (r.status === 404) return { funded: false, trusts: false, balance: "0" };
	if (!r.ok) throw new Error(`horizon ${r.status}`);
	const d = (await r.json()) as {
		balances: Array<{
			asset_code?: string;
			asset_issuer?: string;
			balance: string;
		}>;
	};
	const line = d.balances.find(
		(b) => b.asset_code === code && b.asset_issuer === issuer,
	);
	return { funded: true, trusts: !!line, balance: line?.balance ?? "0" };
}

/**
 * Send any classic asset. Refuses before submission if the sender lacks the
 * balance or the recipient lacks a trustline (op_no_trust) — a payment to an
 * account that cannot hold the asset is a mistake worth catching early.
 */
export async function sendAsset(
	wallet: Wallet,
	to: string,
	asset: Asset,
	amount: string,
): Promise<SendResult> {
	if (!/^G[A-Z2-7]{55}$/.test(to))
		throw new Error(`"${to}" is not a Stellar account address (G…)`);
	if (!(Number(amount) > 0))
		throw new Error(`amount must be positive, got "${amount}"`);
	const code = asset.getCode();
	const issuer = asset.getIssuer();
	if (!issuer)
		throw new Error("cannot send the native asset here; use a classic asset");
	const me = await holds(wallet.publicKey, wallet.network, code, issuer);
	if (!me.funded) throw new Error("this wallet is not funded");
	if (!me.trusts) throw new Error(`this wallet has no ${code} trustline`);
	if (Number(me.balance) < Number(amount))
		throw new Error(`insufficient ${code}: have ${me.balance}, need ${amount}`);
	const recipient = await holds(to, wallet.network, code, issuer);
	if (!recipient.funded)
		throw new Error(
			`recipient ${to.slice(0, 6)}… is not funded (send it some XLM first)`,
		);
	if (!recipient.trusts)
		throw new Error(
			`recipient ${to.slice(0, 6)}… has no ${code} trustline and cannot receive ${code}`,
		);
	const hash = await submit(wallet, (b) =>
		b.addOperation(Operation.payment({ destination: to, asset, amount })),
	);
	return { hash, to, amount, asset: code };
}

/** Send USDC to a Stellar account. Thin wrapper over sendAsset. */
export async function sendUSDC(
	wallet: Wallet,
	to: string,
	amount: string,
): Promise<SendResult> {
	return sendAsset(wallet, to, usdc(wallet.network), amount);
}

export type HistoryEntry = {
	at: string;
	direction: "sent" | "received";
	counterparty: string;
	amount: string;
	asset: string;
	hash: string;
};

/** Recent USDC payments to or from this wallet, newest first. */
export async function history(
	publicKey: string,
	network: Network,
	limit = 20,
): Promise<HistoryEntry[]> {
	const r = await fetch(
		`${HORIZON[network]}/accounts/${publicKey}/payments?order=desc&limit=${limit}&include_failed=false`,
		{ signal: AbortSignal.timeout(15_000) },
	);
	if (r.status === 404) return [];
	if (!r.ok) throw new Error(`horizon ${r.status}`);
	const d = (await r.json()) as {
		_embedded?: {
			records?: Array<{
				type: string;
				created_at: string;
				from?: string;
				to?: string;
				amount?: string;
				asset_code?: string;
				asset_issuer?: string;
				transaction_hash: string;
			}>;
		};
	};
	const out: HistoryEntry[] = [];
	for (const p of d._embedded?.records ?? []) {
		if (p.type !== "payment") continue;
		const asset = p.asset_code ?? "XLM";
		const sent = p.from === publicKey;
		out.push({
			at: p.created_at,
			direction: sent ? "sent" : "received",
			counterparty: (sent ? p.to : p.from) ?? "?",
			amount: p.amount ?? "0",
			asset,
			hash: p.transaction_hash,
		});
	}
	return out;
}

export type TopupInfo = {
	address: string;
	network: Network;
	funded: boolean;
	hasUsdcTrustline: boolean;
	fundedTx: string | null;
	uri: string;
	guidance: string;
};

/**
 * What a wallet needs to receive USDC. On testnet, fund via friendbot and add
 * the trustline so it is immediately ready. On mainnet we cannot fund an
 * account, so we return the address, a SEP-7 pay URI a funding wallet can
 * scan, and clear guidance.
 */
export async function topupInfo(wallet: Wallet): Promise<TopupInfo> {
	const b = await balances(wallet.publicKey, wallet.network);
	const issuer = USDC_ISSUER[wallet.network];
	// SEP-7: a URI a sending wallet can act on to pay USDC to this address.
	const uri = `web+stellar:pay?destination=${wallet.publicKey}&asset_code=USDC&asset_issuer=${issuer}`;
	if (wallet.network === "stellar:testnet") {
		let fundedTx: string | null = null;
		if (!b.funded) {
			const r = await fetch(
				`https://friendbot.stellar.org?addr=${wallet.publicKey}`,
				{
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
			fundedTx = "friendbot";
		}
		const tl = await addTrustline(wallet);
		return {
			address: wallet.publicKey,
			network: wallet.network,
			funded: true,
			hasUsdcTrustline: true,
			fundedTx: tl ?? fundedTx,
			uri,
			guidance:
				"funded on testnet with a USDC trustline — get testnet USDC from the Circle faucet (web, captcha) at https://faucet.circle.com",
		};
	}
	const parts: string[] = [];
	if (!b.funded)
		parts.push(
			"account not yet activated — send it at least ~1 XLM first (an exchange withdrawal in XLM, or a friend)",
		);
	if (b.funded && b.usdc === null)
		parts.push(
			"no USDC trustline yet — run `stellar-pay setup --trustline` before receiving USDC",
		);
	parts.push(
		"then fund USDC by withdrawing from an exchange (Coinbase, Kraken, …) or an on-ramp to this address on the Stellar network, or receive from any Stellar wallet",
	);
	return {
		address: wallet.publicKey,
		network: wallet.network,
		funded: b.funded,
		hasUsdcTrustline: b.funded && b.usdc !== null,
		fundedTx: null,
		uri,
		guidance: parts.join("; "),
	};
}
