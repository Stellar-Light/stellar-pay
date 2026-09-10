/**
 * Onboard a wallet that never holds XLM (the "skip the xlm deposit" ask,
 * Rozo 2026-09-09).
 *
 * A Stellar account costs reserves to exist: 1 XLM for the account (2× the
 * 0.5 base reserve) and 0.5 more per trustline, so a wallet that can hold
 * USDC normally starts by acquiring 1.5 XLM. For a first-time user arriving
 * at a 402 that is a second asset, a second on-ramp, and the most common
 * place to give up.
 *
 * CAP-33 sponsored reserves remove it. A sponsor brackets the account
 * creation and the trustline between beginSponsoring/endSponsoring, so the
 * RESERVES sit on the sponsor's balance while the ledger entries belong to
 * the new account — one transaction, and the new account's own XLM balance
 * is 0.00000. The sponsor is not spending: reserves are locked, not
 * transferred, and they come back when the account closes or transfers the
 * sponsorship elsewhere.
 *
 * The other half of "no XLM" is fees, and that half is already solved by the
 * seller: a 402 that declares `areFeesSponsored` (Rozo's router does) is
 * settled by the facilitator, so the payer signs and pays nothing in XLM.
 * `feeBump` here covers the remaining case — an ordinary payment the wallet
 * makes itself — so a zero-XLM wallet can also SEND, not just receive.
 *
 * We do not run a sponsor. This is the builder; who holds the reserves is a
 * business decision for whoever onboards the user.
 */
import {
	Asset,
	BASE_FEE,
	Horizon,
	type Keypair,
	Networks,
	Operation,
	type Transaction,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import { HORIZON, type Network, USDC_ISSUER } from "./wallet.js";

const passphrase = (n: Network) =>
	n === "stellar:pubnet" ? Networks.PUBLIC : Networks.TESTNET;

/** Reserves the sponsor locks up: 2 base for the account, 1 per trustline. */
export const SPONSORED_RESERVE_XLM = 1.5;

export type SponsoredOnboarding = {
	/** The account that now exists holding zero XLM. */
	publicKey: string;
	/** Who holds its reserves and can reclaim them. */
	sponsor: string;
	hash: string;
	asset: Asset;
};

/**
 * ONE transaction: create `newAccount` with a zero starting balance, add its
 * trustline, and leave both reserves sponsored by `sponsor`. Both keys must
 * sign — the new account authorises being sponsored.
 *
 * `asset` defaults to the network's Circle USDC. Any SEP-41-wrappable classic
 * asset works; the reserve mechanism does not care which.
 */
export async function onboardSponsored(o: {
	sponsor: Keypair;
	newAccount: Keypair;
	network: Network;
	asset?: Asset;
}): Promise<SponsoredOnboarding> {
	const asset = o.asset ?? new Asset("USDC", USDC_ISSUER[o.network]);
	const horizon = new Horizon.Server(HORIZON[o.network]);
	const source = await horizon.loadAccount(o.sponsor.publicKey());
	const tx = new TransactionBuilder(source, {
		fee: BASE_FEE,
		networkPassphrase: passphrase(o.network),
	})
		.addOperation(
			Operation.beginSponsoringFutureReserves({
				sponsoredId: o.newAccount.publicKey(),
			}),
		)
		// startingBalance "0": the sponsor's reserves make the account viable,
		// so the user is handed an account, not an XLM balance to look after.
		.addOperation(
			Operation.createAccount({
				destination: o.newAccount.publicKey(),
				startingBalance: "0",
			}),
		)
		.addOperation(
			Operation.changeTrust({ asset, source: o.newAccount.publicKey() }),
		)
		.addOperation(
			Operation.endSponsoringFutureReserves({
				source: o.newAccount.publicKey(),
			}),
		)
		.setTimeout(60)
		.build();
	tx.sign(o.sponsor, o.newAccount);
	try {
		const res = await horizon.submitTransaction(tx);
		return {
			publicKey: o.newAccount.publicKey(),
			sponsor: o.sponsor.publicKey(),
			hash: res.hash,
			asset,
		};
	} catch (e) {
		const codes = (
			e as { response?: { data?: { extras?: { result_codes?: unknown } } } }
		).response?.data?.extras?.result_codes;
		throw new Error(
			`sponsored onboarding failed: ${JSON.stringify(codes ?? (e as Error).message)}`,
		);
	}
}

/**
 * Submit `inner` with `feePayer` paying the fee, so a zero-XLM account can
 * send. The inner transaction is already signed by its own source; a fee bump
 * wraps it rather than rebuilding it, so nothing about the payment changes.
 */
export async function feeBump(o: {
	inner: Transaction;
	feePayer: Keypair;
	network: Network;
}): Promise<string> {
	const horizon = new Horizon.Server(HORIZON[o.network]);
	const bumped = TransactionBuilder.buildFeeBumpTransaction(
		o.feePayer,
		// The bump must bid at least the inner fee; BASE_FEE per operation is
		// the floor, and the inner tx has already reserved its own.
		String(Number(BASE_FEE) * 2),
		o.inner,
		passphrase(o.network),
	);
	bumped.sign(o.feePayer);
	try {
		const res = await horizon.submitTransaction(bumped);
		return res.hash;
	} catch (e) {
		const codes = (
			e as { response?: { data?: { extras?: { result_codes?: unknown } } } }
		).response?.data?.extras?.result_codes;
		throw new Error(
			`fee bump failed: ${JSON.stringify(codes ?? (e as Error).message)}`,
		);
	}
}
