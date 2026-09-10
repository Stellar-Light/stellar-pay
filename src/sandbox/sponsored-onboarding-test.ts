/**
 * A wallet that never holds XLM — receive AND send (Rozo's question,
 * 2026-09-09: "for the first time user, can it skip the xlm deposit, and
 * start working with one tx with usdc transfer").
 *
 * Proven on testnet, in order:
 *   1. ONE transaction creates the account and its trustline with the
 *      reserves sponsored. The new account's XLM balance is exactly 0.
 *   2. It RECEIVES the asset at 0 XLM.
 *   3. It SENDS the asset at 0 XLM, via a fee bump — so a zero-XLM wallet is
 *      not merely a mailbox, it can pay.
 *   4. The reserves are the sponsor's and are accounted: numSponsoring = 3
 *      base-reserve UNITS (2 for the account entry, 1 for the trustline), and
 *      each sponsored entry names the sponsor.
 *   5. The sponsor CANNOT take it back: revoking either sponsorship makes the
 *      0-XLM account absorb the reserve, which it cannot, so both revokes
 *      fail op_low_reserve. This is the claim src/pay/sponsor.ts makes to
 *      anyone considering running a sponsor, so it is asserted, not assumed.
 *   6. The reserve floor the guard enforces is real in both directions: an
 *      account one stroop under it is refused, an account exactly on it
 *      succeeds.
 *
 * The asset is issued by a throwaway account rather than Circle's testnet
 * USDC, because a faucet is not needed to prove this: a reserve is charged
 * per trustline regardless of issuer, so the mechanism is identical for USDC.
 * What changes on mainnet is only who the sponsor is.
 *
 *   npm run test:sponsored
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
import { addTrustline, TRUSTLINE_MIN_XLM } from "../pay/send.js";
import {
	bumpFeeFor,
	feeBump,
	onboardSponsored,
	SPONSORED_RESERVE_XLM,
} from "../pay/sponsor.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(HORIZON_URL);
const NETWORK = "stellar:testnet" as const;

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
	console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(42)} ${detail}`);
	if (!ok) failures++;
}

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

/** Native balance as a string, exactly as Horizon reports it. */
async function xlm(pub: string): Promise<string> {
	const a = await horizon.loadAccount(pub);
	return (
		a.balances.find((b) => b.asset_type === "native")?.balance ?? "missing"
	);
}

async function assetBalance(pub: string, asset: Asset): Promise<string> {
	const a = await horizon.loadAccount(pub);
	return (
		a.balances.find(
			(b) =>
				"asset_code" in b &&
				b.asset_code === asset.getCode() &&
				b.asset_issuer === asset.getIssuer(),
		)?.balance ?? "none"
	);
}

async function main() {
	const sponsor = Keypair.random();
	const issuer = Keypair.random();
	const user = Keypair.random();
	const seller = Keypair.random();

	console.log("\nsponsored onboarding — a wallet that never holds XLM\n");
	await Promise.all([
		friendbot(sponsor.publicKey()),
		friendbot(issuer.publicKey()),
		friendbot(seller.publicKey()),
	]);
	const asset = new Asset("USDC", issuer.publicKey());

	// ── 1. one transaction, zero starting balance ──────────────────────────
	const onboarded = await onboardSponsored({
		sponsor,
		newAccount: user,
		network: NETWORK,
		asset,
	});
	const userXlm = await xlm(user.publicKey());
	// Ask the LEDGER what that transaction was, rather than asserting a
	// literal true: one transaction, successful, carrying the four operations
	// the module claims (beginSponsoring, createAccount, changeTrust,
	// endSponsoring). The old version of this check passed on any object with
	// a .hash on it.
	const txr = (await (
		await fetch(`${HORIZON_URL}/transactions/${onboarded.hash}`)
	).json()) as { successful?: boolean; operation_count?: number };
	check(
		"ONE tx, successful, 4 operations",
		txr.successful === true && txr.operation_count === 4,
		`${onboarded.hash.slice(0, 12)}… successful=${txr.successful} ops=${txr.operation_count}`,
	);
	check("its XLM balance is zero", Number(userXlm) === 0, `${userXlm} XLM`);
	check(
		"it holds the trustline anyway",
		(await assetBalance(user.publicKey(), asset)) === "0.0000000",
		`${asset.getCode()} trustline present, balance 0`,
	);

	// ── 4 (measured here, reported below): who owns the reserves ───────────
	const sponsorAcct = (await horizon
		.accounts()
		.accountId(sponsor.publicKey())
		.call()) as unknown as {
		num_sponsoring: number;
		balances: Array<{ asset_type: string; balance: string }>;
	};
	const userAcct = (await horizon
		.accounts()
		.accountId(user.publicKey())
		.call()) as unknown as {
		sponsor?: string;
		balances: Array<{ sponsor?: string; asset_code?: string }>;
	};
	// numSponsoring counts BASE-RESERVE UNITS, not entries: an account entry
	// costs 2 and a trustline 1. So 3 units × the 0.5 XLM base reserve is
	// exactly the 1.5 XLM SPONSORED_RESERVE_XLM claims — the count and the
	// figure check each other.
	// Derived from the chain, not from two constants: the old form asserted
	// 3 * 0.5 === SPONSORED_RESERVE_XLM, which is true whatever the ledger did.
	check(
		"sponsor holds all 3 reserve units",
		sponsorAcct.num_sponsoring * 0.5 === SPONSORED_RESERVE_XLM,
		`numSponsoring=${sponsorAcct.num_sponsoring} × 0.5 = ${SPONSORED_RESERVE_XLM} XLM (2 account + 1 trustline)`,
	);
	check(
		"the ledger names the sponsor",
		userAcct.sponsor === sponsor.publicKey() &&
			userAcct.balances.some(
				(b) =>
					b.asset_code === asset.getCode() && b.sponsor === sponsor.publicKey(),
			),
		`account.sponsor + trustline.sponsor = ${sponsor.publicKey().slice(0, 8)}…`,
	);

	// ── 2. receive at zero XLM ─────────────────────────────────────────────
	const issuerAcct = await horizon.loadAccount(issuer.publicKey());
	const fund = new TransactionBuilder(issuerAcct, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			Operation.payment({
				destination: user.publicKey(),
				asset,
				amount: "10",
			}),
		)
		.setTimeout(60)
		.build();
	fund.sign(issuer);
	await horizon.submitTransaction(fund);
	check(
		"receives USDC holding no XLM",
		(await assetBalance(user.publicKey(), asset)) === "10.0000000" &&
			Number(await xlm(user.publicKey())) === 0,
		`10 ${asset.getCode()} in, still ${await xlm(user.publicKey())} XLM`,
	);

	// ── 3. send at zero XLM, fee paid by the sponsor ───────────────────────
	// The seller needs somewhere to receive it; that account is ordinary.
	const sellerAcct = await horizon.loadAccount(seller.publicKey());
	const trust = new TransactionBuilder(sellerAcct, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(Operation.changeTrust({ asset }))
		.setTimeout(60)
		.build();
	trust.sign(seller);
	await horizon.submitTransaction(trust);

	const payerAcct = await horizon.loadAccount(user.publicKey());
	const inner = new TransactionBuilder(payerAcct, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			Operation.payment({
				destination: seller.publicKey(),
				asset,
				amount: "2.5",
			}),
		)
		.setTimeout(60)
		.build();
	inner.sign(user);

	// Without the bump this fails txINSUFFICIENT_BALANCE: the payer has no
	// XLM for its own fee. Proving that refusal is the point of the bump.
	let unbumped = "submitted";
	try {
		await horizon.submitTransaction(inner);
	} catch (e) {
		const codes = (
			e as {
				response?: {
					data?: { extras?: { result_codes?: { transaction?: string } } };
				};
			}
		).response?.data?.extras?.result_codes;
		unbumped = codes?.transaction ?? "rejected";
	}
	check(
		"unbumped send is refused (no XLM for the fee)",
		unbumped === "tx_insufficient_balance",
		unbumped,
	);

	const bumpHash = await feeBump({
		inner,
		feePayer: sponsor,
		network: NETWORK,
	});
	check(
		"fee-bumped send succeeds",
		(await assetBalance(seller.publicKey(), asset)) === "2.5000000",
		`${bumpHash.slice(0, 12)}… seller holds 2.5`,
	);
	check(
		"payer STILL holds zero XLM",
		Number(await xlm(user.publicKey())) === 0,
		`${await xlm(user.publicKey())} XLM after receiving and sending`,
	);

	// ── 5. the UNSPONSORED path refuses with a reason ──────────────────────
	// The contrast that makes the sponsored path worth having. Until today our
	// own mainnet note said "send at least ~1 XLM, then add the trustline";
	// that sequence cannot work, and it failed with a bare Horizon code.
	const poor = Keypair.random();
	const sp = await horizon.loadAccount(sponsor.publicKey());
	const makePoor = new TransactionBuilder(sp, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			Operation.createAccount({
				destination: poor.publicKey(),
				startingBalance: "1",
			}),
		)
		.setTimeout(60)
		.build();
	makePoor.sign(sponsor);
	await horizon.submitTransaction(makePoor);
	let refusal = "allowed";
	try {
		await addTrustline({
			keypair: poor,
			publicKey: poor.publicKey(),
			network: NETWORK,
		});
	} catch (e) {
		refusal = (e as Error).message;
	}
	check(
		"1 XLM unsponsored: refused with a REASON",
		refusal.includes(String(TRUSTLINE_MIN_XLM)) &&
			refusal.includes("1.0000000") &&
			refusal.includes("sponsor"),
		refusal === "allowed"
			? "it was allowed"
			: "names the shortfall + the sponsored way out",
	);

	// ── 6. a differently-priced inner still bumps ─────────────────────────
	// The bid used to be a constant BASE_FEE*2, which the SDK rejects for any
	// inner priced above 200/op — i.e. exactly a congested ledger.
	const congested = new TransactionBuilder(
		await horizon.loadAccount(user.publicKey()),
		{ fee: "1000", networkPassphrase: Networks.TESTNET },
	)
		.addOperation(
			Operation.payment({
				destination: seller.publicKey(),
				asset,
				amount: "0.5",
			}),
		)
		.setTimeout(60)
		.build();
	congested.sign(user);
	let congestedResult = "";
	try {
		await feeBump({ inner: congested, feePayer: sponsor, network: NETWORK });
		congestedResult = "bumped";
	} catch (e) {
		congestedResult = (e as Error).message.slice(0, 60);
	}
	check(
		"an inner priced for congestion still bumps",
		congestedResult === "bumped",
		`inner fee=1000/op, bid=${bumpFeeFor(congested)} → ${congestedResult}`,
	);

	// ── 7. the sponsor cannot take it back ────────────────────────────────
	// The property src/pay/sponsor.ts states to anyone running a sponsor.
	const revokes: string[] = [];
	for (const op of [
		Operation.revokeAccountSponsorship({ account: user.publicKey() }),
		Operation.revokeTrustlineSponsorship({ account: user.publicKey(), asset }),
	]) {
		const rev = new TransactionBuilder(
			await horizon.loadAccount(sponsor.publicKey()),
			{ fee: BASE_FEE, networkPassphrase: Networks.TESTNET },
		)
			.addOperation(op)
			.setTimeout(60)
			.build();
		rev.sign(sponsor);
		try {
			await horizon.submitTransaction(rev);
			revokes.push("SUCCEEDED");
		} catch (e) {
			const codes = (
				e as {
					response?: {
						data?: { extras?: { result_codes?: { operations?: string[] } } };
					};
				}
			).response?.data?.extras?.result_codes;
			revokes.push(codes?.operations?.[0] ?? "rejected");
		}
	}
	check(
		"sponsor CANNOT revoke either reserve",
		revokes.every((r) => r === "op_low_reserve"),
		`account: ${revokes[0]}, trustline: ${revokes[1]} — the user is safe from their sponsor, and the sponsor's 1.5 XLM is locked until the user cooperates`,
	);

	// ── 8. the unsponsored floor is real in BOTH directions ───────────────
	// TRUSTLINE_MIN_XLM is now computed from the base reserve rather than
	// rounded up from one observation, so a wrong assumption would show here.
	const boundary: string[] = [];
	for (const amount of [
		(TRUSTLINE_MIN_XLM - 0.0000001).toFixed(7),
		TRUSTLINE_MIN_XLM.toFixed(7),
	]) {
		const acct = Keypair.random();
		const mk = new TransactionBuilder(
			await horizon.loadAccount(sponsor.publicKey()),
			{ fee: BASE_FEE, networkPassphrase: Networks.TESTNET },
		)
			.addOperation(
				Operation.createAccount({
					destination: acct.publicKey(),
					startingBalance: amount,
				}),
			)
			.setTimeout(60)
			.build();
		mk.sign(sponsor);
		await horizon.submitTransaction(mk);
		const tl = new TransactionBuilder(
			await horizon.loadAccount(acct.publicKey()),
			{ fee: BASE_FEE, networkPassphrase: Networks.TESTNET },
		)
			.addOperation(Operation.changeTrust({ asset }))
			.setTimeout(60)
			.build();
		tl.sign(acct);
		try {
			await horizon.submitTransaction(tl);
			boundary.push("ok");
		} catch {
			boundary.push("refused");
		}
	}
	check(
		"the floor is exact: one stroop under fails, on it succeeds",
		boundary[0] === "refused" && boundary[1] === "ok",
		`${TRUSTLINE_MIN_XLM.toFixed(7)} XLM — under: ${boundary[0]}, on: ${boundary[1]}`,
	);

	const sponsorXlm = await xlm(sponsor.publicKey());
	console.log(
		`\n  sponsor ${sponsor.publicKey().slice(0, 8)}… holds ${sponsorXlm} XLM; its ` +
			`${SPONSORED_RESERVE_XLM} XLM of reserves are LOCKED, not spent — and as the revoke\n  ` +
			"checks above just showed, NOT reclaimable on the sponsor's own say-so while the\n  " +
			"account holds 0 XLM. They come back when the user cooperates: merging the account,\n  " +
			"dropping the trustline, or funding themselves enough to absorb the reserve.",
	);
	console.log(
		failures === 0
			? "\nPASS — a wallet onboarded in one transaction, never held XLM, and both received and sent.\n"
			: `\nFAIL — ${failures} check(s) failed.\n`,
	);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
