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
 * is 0.00000.
 *
 * WHAT THE SPONSOR CAN AND CANNOT DO AFTERWARDS, measured on testnet
 * 2026-09-10 rather than assumed, because whoever runs a sponsor is taking
 * this trade deliberately:
 *
 *   - It CANNOT take the account back. RevokeSponsorship makes the sponsored
 *     account absorb the reserve itself, and an account holding 0 XLM cannot:
 *     both revokeAccountSponsorship and revokeTrustlineSponsorship fail
 *     `op_low_reserve`. The user is safe from their sponsor.
 *   - It CANNOT freeze the account, spend its USDC, or sign for it. The
 *     sponsor is not a signer and not the asset issuer.
 *   - Which means it also cannot get its 1.5 XLM back on its own. A user who
 *     walks away leaves those reserves locked with no timeout. That is the
 *     griefing side of the trade and it is the sponsor's cost of onboarding
 *     someone: reserves return only when the user cooperates — merging the
 *     account, dropping the trustline, or funding themselves enough to absorb
 *     the reserve so a revoke can land.
 *   - It CAN stop paying fees. A zero-XLM wallet can always receive; it can
 *     only SEND while someone fee-bumps for it (`feeBump` below) or the
 *     seller's 402 declares sponsored fees.
 *
 * Reserves are locked, not transferred — the sponsor's balance is unchanged
 * beyond the transaction fee itself.
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
	/** Who currently pays its reserves. NOT a signer, and NOT able to revoke
	 *  while the account holds 0 XLM — see the header. */
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
	if (o.sponsor.publicKey() === o.newAccount.publicKey())
		throw new Error(
			"sponsor and newAccount are the same key — an account cannot sponsor its own creation",
		);
	const horizon = new Horizon.Server(HORIZON[o.network]);
	// Inside the try with the submit: a missing or unfunded sponsor account
	// throws here, and the caller deserves the same named failure either way.
	try {
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
		const raw = JSON.stringify(codes ?? (e as Error).message);
		// The two failures a caller will actually hit, named rather than left
		// as protocol codes: the account is already there, or the sponsor is
		// not funded enough to lock the reserves.
		if (raw.includes("op_already_exists"))
			throw new Error(
				`sponsored onboarding failed: ${o.newAccount.publicKey().slice(0, 8)}… already exists on ${o.network} — it needs no onboarding, and nothing was changed`,
			);
		if (
			raw.includes("op_low_reserve") ||
			raw.includes("tx_insufficient_balance")
		)
			throw new Error(
				`sponsored onboarding failed: the sponsor cannot cover ${SPONSORED_RESERVE_XLM} XLM of reserves plus the fee (${raw})`,
			);
		throw new Error(`sponsored onboarding failed: ${raw}`);
	}
}

/**
 * The per-operation fee a bump of `inner` must bid.
 *
 * `buildFeeBumpTransaction`'s second argument is a PER-OPERATION fee, not a
 * total, and the SDK refuses a bid below the inner transaction's own per-op
 * fee. Measured 2026-09-10: a 3-operation inner at BASE_FEE bumps fine at a
 * flat 200, while a 1-operation inner built at fee 1000 throws "Invalid
 * baseFee, it should be at least 1000 stroops". So a constant bid silently
 * caps what this helper can send — and it caps it exactly when it matters,
 * since an inner priced above base fee is one built for a congested ledger.
 */
export function bumpFeeFor(inner: Transaction): string {
	const ops = Math.max(1, inner.operations.length);
	const perOp = Math.ceil(Number(inner.fee) / ops);
	return String(Math.max(Number(BASE_FEE), perOp));
}

/**
 * Submit `inner` with `feePayer` paying the fee, so a zero-XLM account can
 * send. The inner transaction is already signed by its own source; a fee bump
 * wraps it rather than rebuilding it, so nothing about the payment changes —
 * and the fee bump REPLACES the inner fee, so the inner source is not charged.
 *
 * `fee` overrides the bid (a per-operation figure) for a congested ledger;
 * omitted, it matches whatever the inner transaction priced itself at.
 */
export async function feeBump(o: {
	inner: Transaction;
	feePayer: Keypair;
	network: Network;
	fee?: string;
}): Promise<string> {
	const horizon = new Horizon.Server(HORIZON[o.network]);
	const bumped = TransactionBuilder.buildFeeBumpTransaction(
		o.feePayer,
		o.fee ?? bumpFeeFor(o.inner),
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
