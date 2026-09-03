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
	Memo,
	MuxedAccount,
	Networks,
	Operation,
	StrKey,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import { record } from "./receipts.js";
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
async function hasTrustline(
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
	/** the memo attached, when one was — an exchange deposit is not creditable
	 * without it, so the receipt has to be able to prove it went */
	memo?: string;
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
 * Muxed (M…) address helpers — SEP-23.
 *
 * An M… address is an ed25519 account plus a 64-bit id, encoded together. It
 * is the protocol's own answer to per-customer attribution: one real account
 * receives everything, while each payer is given a distinct address whose id
 * says who the payment is for. No memo, no sweep, no per-customer account to
 * fund. Tempo shipped the same idea as "virtual addresses" and Stellar has
 * had it since SEP-23; `@x402/stellar` already accepts M… as a destination.
 */
export function isMuxed(address: string): boolean {
	return StrKey.isValidMed25519PublicKey(address);
}

/** The underlying G… account an M… settles into. Throws on a non-muxed input,
 *  so a caller cannot quietly get its argument back and check the wrong
 *  account for funding or trustlines. */
export function underlyingAccount(muxedAddress: string): string {
	if (!isMuxed(muxedAddress))
		throw new Error(`"${muxedAddress}" is not a muxed (M…) address`);
	return MuxedAccount.fromAddress(muxedAddress, "0").baseAccount().accountId();
}

/** The routing id encoded in an M… address — the attribution a memo would
 *  otherwise have carried. */
export function muxedId(muxedAddress: string): string {
	if (!isMuxed(muxedAddress))
		throw new Error(`"${muxedAddress}" is not a muxed (M…) address`);
	return MuxedAccount.fromAddress(muxedAddress, "0").id();
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
	/** MEMO — required by most exchanges and anchors to credit a deposit.
	 *
	 * This became load-bearing the moment `cashout` started pointing people at
	 * exchange deposit addresses: a deposit sent without the memo the exchange
	 * asked for is, in practice, lost. Supporting it is not a nicety. */
	memo?: string,
): Promise<SendResult> {
	// A muxed address (M…) carries its routing id INSIDE the address, which is
	// what makes it the right primitive for per-customer attribution: the
	// sender needs no memo and the operator receives into one account.
	// Supported now, with the two things that make it safe rather than the
	// footgun this guard used to refuse outright:
	//
	//  1. A memo alongside a muxed destination is REFUSED, not merged. The id
	//     in the address IS the attribution; accepting both would leave two
	//     competing answers to "who is this for", which is exactly how a
	//     deposit gets misrouted. The ambiguity was real — the blanket refusal
	//     was just not the only way to resolve it.
	//  2. Every pre-flight check below runs against the UNDERLYING G…
	//     account. Horizon holds no record of an M… address, so asking it
	//     whether "M…" is funded or trusts an asset would fail, or worse
	//     answer about nothing.
	const muxed = isMuxed(to);
	if (muxed && memo)
		throw new Error(
			`"${to.slice(0, 8)}…" is a muxed (M…) address, which already carries its routing id — passing a memo too gives two conflicting answers. Send to the M… address with no memo, or to the underlying G… address with one.`,
		);
	if (!muxed && !/^G[A-Z2-7]{55}$/.test(to))
		throw new Error(`"${to}" is not a Stellar account address (G… or M…)`);
	// Funding and trustlines belong to the underlying account, never the M….
	const settlesTo = muxed ? underlyingAccount(to) : to;
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
	const recipient = await holds(settlesTo, wallet.network, code, issuer);
	if (!recipient.funded)
		throw new Error(
			`recipient ${settlesTo.slice(0, 6)}… is not funded (send it some XLM first)`,
		);
	if (!recipient.trusts)
		throw new Error(
			`recipient ${settlesTo.slice(0, 6)}… has no ${code} trustline and cannot receive ${code}`,
		);
	const hash = await submit(wallet, (b) => {
		b.addOperation(Operation.payment({ destination: to, asset, amount }));
		if (memo) b.addMemo(buildMemo(memo));
		return b;
	});
	// Every outbound transfer is a receipt, written HERE rather than at the two
	// call sites — `send` and MCP `send_usdc` both funnel through this
	// function, and until 2026-09-01 neither wrote a row at all, so real USDC
	// left the wallet with nothing in the ledger to verify later (audit
	// finding 3). One door, one receipt: a future caller cannot forget.
	record({
		kind: "payment",
		network: wallet.network,
		url: `stellar:${to}`,
		amount,
		asset: code,
		payer: wallet.publicKey,
		payee: to,
		tx: hash,
		detail: { surface: "send", ...(memo ? { memo } : {}) },
	});
	return { hash, to, amount, asset: code, memo };
}

/** Send USDC to a Stellar account. Thin wrapper over sendAsset. */
export async function sendUSDC(
	wallet: Wallet,
	to: string,
	amount: string,
	memo?: string,
): Promise<SendResult> {
	return sendAsset(wallet, to, usdc(wallet.network), amount, memo);
}

/** Build the right memo type from a string.
 *
 * Exchanges hand out either a numeric id or a short text tag, and picking the
 * wrong TYPE fails the same way as omitting it — the deposit is not credited.
 * A digits-only value is sent as MEMO_ID (what most exchanges issue), anything
 * else as MEMO_TEXT, and an over-long text memo is refused here rather than by
 * the network after the funds have moved. */
function buildMemo(memo: string): Memo {
	if (/^\d+$/.test(memo)) return Memo.id(memo);
	if (Buffer.byteLength(memo, "utf8") > 28)
		throw new Error(
			`memo "${memo.slice(0, 12)}…" is ${Buffer.byteLength(memo, "utf8")} bytes; a text memo is limited to 28`,
		);
	return Memo.text(memo);
}

export type HistoryEntry = {
	at: string;
	direction: "sent" | "received";
	counterparty: string;
	amount: string;
	asset: string;
	hash: string;
};

/** Recent payments (any asset, each labelled) to or from this wallet, newest first. */
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
		// Every asset, each row labelled with its code — "USDC" alone would be a
		// lie for a wallet that also moves XLM, and the asset is shown anyway.
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
/** SEP-7 pay URI a mobile Stellar wallet (Lobstr, Freighter) can scan to send USDC here. */
export function payUri(
	address: string,
	network: Network,
	amount?: string,
): string {
	const issuer = USDC_ISSUER[network];
	const q = new URLSearchParams({
		destination: address,
		asset_code: "USDC",
		asset_issuer: issuer,
	});
	if (amount && Number(amount) > 0) q.set("amount", amount);
	return `web+stellar:pay?${q.toString()}`;
}

/**
 * Watch for USDC to arrive: poll the balance until it rises above the starting
 * amount (or the account gets funded + a trustline appears), and return what
 * landed. Resolves null on timeout so the caller can offer a refresh.
 */
export async function pollFunding(
	publicKey: string,
	network: Network,
	opts: {
		timeoutMs?: number;
		intervalMs?: number;
		onTick?: (elapsedMs: number) => void;
	} = {},
): Promise<{ received: string; balance: string } | null> {
	const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
	const interval = opts.intervalMs ?? 2_000;
	const start = await balances(publicKey, network);
	const base = start.funded && start.usdc !== null ? Number(start.usdc) : 0;
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		await new Promise((r) => setTimeout(r, interval));
		opts.onTick?.(Date.now() - t0);
		let now: Awaited<ReturnType<typeof balances>>;
		try {
			now = await balances(publicKey, network);
		} catch {
			continue; // transient horizon error — keep polling
		}
		const cur = now.funded && now.usdc !== null ? Number(now.usdc) : 0;
		if (cur > base)
			return { received: (cur - base).toFixed(7), balance: cur.toFixed(7) };
	}
	return null;
}

export async function topupInfo(wallet: Wallet): Promise<TopupInfo> {
	const b = await balances(wallet.publicKey, wallet.network);
	// SEP-7: a URI a sending wallet can act on to pay USDC to this address.
	const uri = payUri(wallet.publicKey, wallet.network);
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
