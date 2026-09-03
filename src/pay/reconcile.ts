/**
 * Reconciliation — the OTHER direction from `receipts.verifyOnChain`, and the
 * whole-set version.
 *
 * A competing case for agent payments derives history from network state
 * (Horizon/RPC) instead of the app's own log, and it has a point: a local
 * file cannot prove itself against its own owner. `verifyOnChain` already
 * proves ONE receipt against the chain. This proves the WHOLE local ledger
 * against the chain's own payment history for the wallet in use — four
 * buckets: matched, on-chain-but-not-logged, logged-but-never-settled, and
 * amount/payee mismatches on rows that pair up.
 *
 * Scope (read this before trusting a clean run):
 *   - OUTBOUND classic Horizon payments only (native XLM + USDC), i.e. the
 *     `payment`-kind rows this ledger actually writes (payer = this wallet —
 *     every call site in cli.ts/mcp.ts/governed.ts/send.ts sets it that way).
 *     Inbound receipts are not a thing the ledger claims to track, so they
 *     are not reconciled — including them would make every earning wallet
 *     "fail" permanently and defeat the point of a CI/cron check.
 *   - Soroban SAC invoke_contract transfers are NOT read separately. Nothing
 *     in this ledger records a `payment` row that settles as a bare SAC
 *     transfer instead of a classic Horizon payment op — vault draws and
 *     bounty escrow move through Soroban contracts under their OWN receipt
 *     kinds (vault-draw, bounty-*), each with its own on-chain surface
 *     (contract state), not this one.
 *     ponytail: add an RPC getEvents path the day a `payment` row settles as
 *     a raw SAC transfer instead of a classic op — nothing does today.
 *   - Off-chain payment-channel legs (`--session`, protocol "channel", each
 *     row written with `detail.offChain: true` and `tx: null`) are BY DESIGN
 *     never individually on-chain — only the channel's close transaction
 *     settles. Counting them as "logged but never settled" would be a false
 *     accusation against a working design, so they are excluded up front and
 *     reported as a count, not silently dropped.
 *
 * On "could not check" vs "is not there" (the point of this whole file): a
 * ledger row that names a tx hash is checked with a DIRECT per-hash lookup
 * (same two Horizon calls verifyOnChain makes — tx, then its effects) rather
 * than by searching the bulk history page-walk. That makes "logged but never
 * settled" true regardless of whether the bulk walk below finished, and it
 * means a Horizon hiccup on ONE row's lookup never taints any other row.
 *
 * This intentionally does NOT call `receipts.verifyOnChain` directly: that
 * function does not wrap its `fetch` calls (an outage throws, uncaught) and
 * folds "tx not found" and "Horizon 500" into the same `ok:false` — exactly
 * the conflation this task must not repeat at whole-ledger scale. Studied its
 * shape (same endpoints, same base-unit conversion, same native/classic
 * asset test) and reused that; fixed the one thing it does not do.
 */
import { Asset, Networks } from "@stellar/stellar-sdk";
import {
	list as listReceipts,
	type ReceiptRow,
	settlementPayee,
} from "./receipts.js";
import { HORIZON, type Network } from "./wallet.js";

const TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 200; // Horizon's max page size
const DEFAULT_MAX_PAGES = 100; // 20,000 payment ops before we call it a truncation

const NATIVE_SAC_IDS = new Set([
	Asset.native().contractId(Networks.PUBLIC),
	Asset.native().contractId(Networks.TESTNET),
]);

/** Human "123.4500000" (7dp) → base units, matching receipts.ts's own
 * conversion (duplicated locally — that tiny helper already lives
 * independently in receipts.ts, curl.ts and worker.ts; that's this repo's
 * established shape, not a gap to centralize). */
function toBase(human: string): bigint {
	const [i = "0", f = ""] = human.split(".");
	return BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
}

/** Only native or non-native matters for matching (see the module doc): the
 * ledger's `asset` field is a SAC contract id on x402/MPP-paid rows but a
 * bare code string ("USDC") on `send`-written rows, so an exact-id compare
 * would miss half the ledger. USDC is the only classic asset this codebase
 * ever pays in — ponytail: extend if a third classic asset shows up. */
function isNativeRow(row: ReceiptRow): boolean {
	return !row.asset || NATIVE_SAC_IDS.has(row.asset);
}

type ChainPayment = {
	tx: string;
	at: string;
	from: string;
	to: string;
	amountBase: string;
	/** "native" or the classic asset code, exactly as Horizon reports it —
	 * never normalized away, so an unexpected asset stays visible. */
	assetLabel: string;
};

type HorizonPaymentsPage = {
	_links?: { next?: { href?: string } };
	_embedded?: {
		records?: Array<{
			type?: string;
			transaction_hash?: string;
			created_at?: string;
			from?: string;
			to?: string;
			amount?: string;
			asset_type?: string;
			asset_code?: string;
		}>;
	};
};

function assetLabel(e: { asset_type?: string; asset_code?: string }): string {
	return e.asset_type === "native" ? "native" : (e.asset_code ?? "unknown");
}

type ChainReadOutcome = {
	payments: ChainPayment[];
	complete: boolean;
	pagesRead: number;
	stoppedReason?: string;
};

/** Page through the account's FULL payment history. Paging is real: it
 * follows `_links.next.href` until Horizon returns an empty page, and any
 * failure along the way — network error, non-2xx, unparseable body, or the
 * page-count safety cap — stops the walk and comes back `complete: false`
 * with whatever was read so far. A partial read is reported as partial,
 * never silently treated as the whole history. */
async function readChainPayments(
	publicKey: string,
	horizonUrl: string,
	maxPages: number,
): Promise<ChainReadOutcome> {
	const payments: ChainPayment[] = [];
	let url = `${horizonUrl}/accounts/${publicKey}/payments?order=asc&limit=${PAGE_LIMIT}&include_failed=false`;
	let pagesRead = 0;
	for (;;) {
		let res: Response;
		try {
			res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (e) {
			return {
				payments,
				complete: false,
				pagesRead,
				stoppedReason: `network error reading page ${pagesRead + 1} of ${publicKey}'s payment history: ${(e as Error).message}`,
			};
		}
		// A never-funded account (or the wrong network) has no history —
		// complete and empty, not a failure.
		if (res.status === 404) return { payments, complete: true, pagesRead };
		if (!res.ok) {
			return {
				payments,
				complete: false,
				pagesRead,
				stoppedReason: `Horizon ${res.status} reading page ${pagesRead + 1} of the payment history`,
			};
		}
		pagesRead++;
		let page: HorizonPaymentsPage;
		try {
			page = (await res.json()) as HorizonPaymentsPage;
		} catch (e) {
			return {
				payments,
				complete: false,
				pagesRead,
				stoppedReason: `unparseable Horizon response on page ${pagesRead}: ${(e as Error).message}`,
			};
		}
		const records = page._embedded?.records ?? [];
		for (const r of records) {
			if (r.type !== "payment") continue;
			payments.push({
				tx: r.transaction_hash ?? "",
				at: r.created_at ?? "",
				from: r.from ?? "",
				to: r.to ?? "",
				amountBase: toBase(r.amount ?? "0").toString(),
				assetLabel: assetLabel(r),
			});
		}
		if (records.length === 0) return { payments, complete: true, pagesRead }; // exhausted
		if (pagesRead >= maxPages) {
			return {
				payments,
				complete: false,
				pagesRead,
				stoppedReason: `stopped after the ${maxPages}-page safety cap (${payments.length} payment op(s) read) — the account's history continues beyond this point`,
			};
		}
		const next = page._links?.next?.href;
		if (!next) return { payments, complete: true, pagesRead }; // defensive: Horizon always sends one
		url = next;
	}
}

type TxCredit = { payee: string; amountBase: string; assetLabel: string };
type TxLookup =
	| { state: "error"; reason: string }
	| { state: "not-found" }
	| { state: "failed" }
	| { state: "found"; credits: TxCredit[] };

/** Direct per-hash proof — the same two Horizon calls verifyOnChain makes,
 * but returning the actual on-chain values (needed to REPORT a mismatch, not
 * just flag one) and, unlike verifyOnChain, never letting a thrown fetch
 * error escape uncaught or collapsing "doesn't exist" and "Horizon is down"
 * into the same outcome. */
async function lookupTx(tx: string, horizonUrl: string): Promise<TxLookup> {
	let txRes: Response;
	try {
		txRes = await fetch(`${horizonUrl}/transactions/${tx}`, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		return {
			state: "error",
			reason: `network error reading tx ${tx}: ${(e as Error).message}`,
		};
	}
	if (txRes.status === 404) return { state: "not-found" };
	if (!txRes.ok)
		return {
			state: "error",
			reason: `Horizon ${txRes.status} reading tx ${tx}`,
		};
	let txJson: { successful?: boolean };
	try {
		txJson = (await txRes.json()) as { successful?: boolean };
	} catch (e) {
		return {
			state: "error",
			reason: `unparseable Horizon response for tx ${tx}: ${(e as Error).message}`,
		};
	}
	if (!txJson.successful) return { state: "failed" };

	let fxRes: Response;
	try {
		fxRes = await fetch(`${horizonUrl}/transactions/${tx}/effects?limit=200`, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		return {
			state: "error",
			reason: `network error reading effects for tx ${tx}: ${(e as Error).message}`,
		};
	}
	if (!fxRes.ok)
		return {
			state: "error",
			reason: `Horizon ${fxRes.status} reading effects for tx ${tx}`,
		};
	let fx: {
		_embedded?: {
			records?: Array<{
				type: string;
				account?: string;
				amount?: string;
				asset_type?: string;
				asset_code?: string;
			}>;
		};
	};
	try {
		fx = (await fxRes.json()) as typeof fx;
	} catch (e) {
		return {
			state: "error",
			reason: `unparseable effects response for tx ${tx}: ${(e as Error).message}`,
		};
	}
	const credits = (fx._embedded?.records ?? [])
		.filter((e) => e.type === "account_credited")
		.map((e) => ({
			payee: e.account ?? "",
			amountBase: toBase(e.amount ?? "0").toString(),
			assetLabel: assetLabel(e),
		}));
	if (!credits.length)
		return {
			state: "error",
			reason: `tx ${tx} settled but no account_credited effect was found (unexpected operation shape)`,
		};
	return { state: "found", credits };
}

export type ReconcileMatch = {
	id: string;
	tx: string;
	amount: string;
	asset: string;
	payee: string;
};
export type ReconcileOnChainOnly = {
	tx: string;
	at: string;
	counterparty: string;
	amount: string;
	asset: string;
};
export type ReconcileLedgerOnly = {
	id: string;
	tx: string | null;
	/** As the ledger stated it — absent stays absent, never coerced to "0". */
	amount: string | null;
	asset: string | null;
	payee: string | null;
	note: string;
};
export type ReconcileMismatch = {
	id: string;
	tx: string;
	ledger: { amount: string | null; payee: string | null; asset: string | null };
	chain: { amount: string; payee: string; asset: string };
};
export type ReconcileUnchecked = { id?: string; tx?: string; reason: string };

export type ReconcileResult = {
	network: Network;
	publicKey: string;
	/** What this run actually covered — read this before trusting `ok`. */
	scope: string;
	/** false if the on-chain history walk stopped before exhausting the
	 * account (error or the page cap) — `onChainNotLedger` may be incomplete. */
	complete: boolean;
	pagesRead: number;
	/** off-chain channel-payment rows, correctly excluded rather than
	 * miscounted as "logged but never settled" — see the module doc. */
	excludedOffChainRows: number;
	matched: ReconcileMatch[];
	onChainNotLedger: ReconcileOnChainOnly[];
	ledgerNotOnChain: ReconcileLedgerOnly[];
	mismatched: ReconcileMismatch[];
	/** Horizon trouble, not a finding — kept out of the four buckets above so
	 * an outage can never read as "money went unrecorded". */
	couldNotCheck: ReconcileUnchecked[];
	ok: boolean;
};

/**
 * Read-only. Never writes to the ledger, never submits a transaction. Reads
 * the wallet's on-chain payment history from Horizon and diffs it against
 * the local receipts ledger — see the module doc for exactly what that does
 * and does not cover.
 */
export async function reconcile(opts: {
	publicKey: string;
	network: Network;
	/** override for tests; defaults to the real Horizon for `network`. */
	horizonUrl?: string;
	maxPages?: number;
}): Promise<ReconcileResult> {
	const horizonUrl = opts.horizonUrl ?? HORIZON[opts.network];
	const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

	const ledgerRows = listReceipts({ kind: "payment", limit: 10_000 }).filter(
		(r) => r.network === opts.network && r.payer === opts.publicKey,
	);
	const offChainRows = ledgerRows.filter((r) => r.detail?.offChain === true);
	const local = ledgerRows.filter((r) => !(r.detail?.offChain === true));

	const chainRead = await readChainPayments(
		opts.publicKey,
		horizonUrl,
		maxPages,
	);
	const sent = chainRead.payments.filter((p) => p.from === opts.publicKey);

	const couldNotCheck: ReconcileUnchecked[] = [];
	if (!chainRead.complete) {
		couldNotCheck.push({
			reason: `on-chain history walk did not finish: ${chainRead.stoppedReason ?? "stopped early"} — on-chain-not-ledger below may be incomplete`,
		});
	}

	const matched: ReconcileMatch[] = [];
	const mismatched: ReconcileMismatch[] = [];
	const ledgerNotOnChain: ReconcileLedgerOnly[] = [];
	// tx hashes "claimed" by a matched/mismatched ledger row, so the SAME
	// on-chain payment is not also reported as on-chain-but-not-in-ledger.
	const claimed = new Set<string>();

	for (const row of local) {
		if (!row.tx) {
			// No hash on the row: the only way to find it is the bulk-listed
			// set, so its absence is only as trustworthy as that read was.
			const hit = sent.find(
				(p) =>
					!claimed.has(p.tx) &&
					(!row.payee || p.to === settlementPayee(row.payee)) &&
					(row.amount == null || p.amountBase === row.amount) &&
					isNativeRow(row) === (p.assetLabel === "native"),
			);
			if (hit) {
				claimed.add(hit.tx);
				matched.push({
					id: row.id,
					tx: hit.tx,
					amount: hit.amountBase,
					asset: hit.assetLabel,
					payee: hit.to,
				});
			} else if (!chainRead.complete) {
				couldNotCheck.push({
					id: row.id,
					reason:
						"row carries no tx hash and the on-chain history walk was incomplete, so its absence cannot be confirmed",
				});
			} else {
				ledgerNotOnChain.push({
					id: row.id,
					tx: null,
					amount: row.amount ?? null,
					asset: row.asset ?? null,
					payee: row.payee ?? null,
					note: "row carries no tx hash; no matching on-chain payment (same payee + amount) found in the full payment history",
				});
			}
			continue;
		}

		// Row names a hash: a direct per-tx lookup proves it regardless of
		// whether the bulk walk above finished.
		const direct = await lookupTx(row.tx, horizonUrl);
		if (direct.state === "error") {
			couldNotCheck.push({ id: row.id, tx: row.tx, reason: direct.reason });
			continue;
		}
		if (direct.state === "not-found") {
			ledgerNotOnChain.push({
				id: row.id,
				tx: row.tx,
				amount: row.amount ?? null,
				asset: row.asset ?? null,
				payee: row.payee ?? null,
				note: `no transaction with this hash exists on ${opts.network}'s Horizon`,
			});
			continue;
		}
		if (direct.state === "failed") {
			ledgerNotOnChain.push({
				id: row.id,
				tx: row.tx,
				amount: row.amount ?? null,
				asset: row.asset ?? null,
				payee: row.payee ?? null,
				note: "the transaction exists on-chain but FAILED — it never settled",
			});
			continue;
		}
		claimed.add(row.tx);
		const wantNative = isNativeRow(row);
		const hit = direct.credits.find(
			(c) =>
				(!row.payee || c.payee === settlementPayee(row.payee)) &&
				(row.amount == null || c.amountBase === row.amount) &&
				wantNative === (c.assetLabel === "native"),
		);
		if (hit) {
			matched.push({
				id: row.id,
				tx: row.tx,
				amount: hit.amountBase,
				asset: hit.assetLabel,
				payee: hit.payee,
			});
			continue;
		}
		const shown =
			direct.credits.find(
				(c) => !row.payee || c.payee === settlementPayee(row.payee),
			) ?? direct.credits[0];
		if (!shown) continue; // unreachable: lookupTx never returns "found" with an empty list
		mismatched.push({
			id: row.id,
			tx: row.tx,
			ledger: {
				amount: row.amount ?? null,
				payee: row.payee ?? null,
				asset: row.asset ?? null,
			},
			chain: {
				amount: shown.amountBase,
				payee: shown.payee,
				asset: shown.assetLabel,
			},
		});
	}

	const onChainNotLedger: ReconcileOnChainOnly[] = sent
		.filter((p) => !claimed.has(p.tx))
		.map((p) => ({
			tx: p.tx,
			at: p.at,
			counterparty: p.to,
			amount: p.amountBase,
			asset: p.assetLabel,
		}));

	const ok =
		chainRead.complete &&
		couldNotCheck.length === 0 &&
		onChainNotLedger.length === 0 &&
		ledgerNotOnChain.length === 0 &&
		mismatched.length === 0;

	return {
		network: opts.network,
		publicKey: opts.publicKey,
		scope: `outbound Horizon payments (classic ops, every asset as seen on-chain) FROM ${opts.publicKey} on ${opts.network}. Ledger-side matching recognizes native XLM and USDC — the only assets this ledger's payment rows record. Inbound receipts, Soroban SAC-transfer events, and off-chain payment-channel legs (settled only at channel close) are out of scope.`,
		complete: chainRead.complete,
		pagesRead: chainRead.pagesRead,
		excludedOffChainRows: offChainRows.length,
		matched,
		onChainNotLedger,
		ledgerNotOnChain,
		mismatched,
		couldNotCheck,
		ok,
	};
}
