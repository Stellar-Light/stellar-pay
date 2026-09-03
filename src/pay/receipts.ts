/**
 * The receipts ledger — dated, content-addressed, attribution-ready.
 *
 * Three research-derived rules give this file its shape:
 *
 * 1. RECEIPT-AS-PROOF (the PGTR pattern, ERC-8194): a receipt is a portable
 *    artifact any third party can verify against the chain — so `verify`
 *    checks the row's transaction actually settled and actually credited the
 *    payee the stated amount. A receipt that verifies is an authorization-
 *    grade artifact, not a log line.
 * 2. ATTRIBUTION (CGI's "payment flows backward through contribution
 *    chains"): rows carry `refs` — ids of the receipts this one builds on.
 *    A payment references the policy decision that allowed it; a channel
 *    close references the open. Cheap now, impossible to retrofit later.
 * 3. POLICY-AS-ARTIFACT (ICME): every spend DECISION — allowed or refused —
 *    is a row naming the rule that fired, so governance is auditable after
 *    the fact, not just enforced in the moment.
 *
 * Storage: append-only JSONL next to the session state
 * (~/.config/stellar-pay/receipts.jsonl; STELLAR_PAY_SESSION_DIR overrides).
 * The id is the sha256 of the canonical content — stable, referenceable,
 * and tamper-evident: re-hash the row, and edits show.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Asset, MuxedAccount, Networks, StrKey } from "@stellar/stellar-sdk";
import { receipt as appendRaw, sessionPaths } from "./session-store.js";

export type ReceiptKind =
	| "payment"
	| "policy-decision"
	| "channel-open"
	| "channel-close"
	| "channel-drop"
	| "task-outcome"
	| "job-open"
	| "job-fund"
	| "job-deliver"
	| "job-approve"
	| "job-release"
	| "job-dispute"
	| "job-resolve-dispute"
	| "job-resolved"
	| "bounty-assign"
	| "bounty-open-post"
	| "bounty-work-submit"
	| "bounty-income"
	| "vault-create"
	| "vault-topup"
	| "vault-draw";

export type ReceiptRow = {
	id: string;
	at: string;
	kind: ReceiptKind;
	/** CAIP-2 network, e.g. stellar:testnet */
	network?: string;
	protocol?: "mpp" | "x402" | "channel";
	/** what was bought (the paid URL) */
	url?: string;
	/** base units, as the challenge stated them */
	amount?: string | null;
	asset?: string | null;
	payer?: string;
	payee?: string | null;
	/** on-chain transaction hash (or the protocol's reference) when known */
	tx?: string | null;
	/** attribution: ids of receipts this row builds on */
	refs?: string[];
	/**
	 * Ledger link: the id of the row that preceded this one when it was
	 * written. Distinct from `refs` (which is semantic attribution and may be
	 * empty): `prev` is structural, so a deleted, reordered, or spliced-out
	 * row leaves a dangling link that `checkLedger` reports. Absent only on
	 * the first row, and on rows written before 2026-09-01 when the ledger had
	 * no chain at all.
	 */
	prev?: string;
	detail?: Record<string, unknown>;
};

/**
 * The account a row's payment actually SETTLED into.
 *
 * A muxed (M…) payee is the address the payer was given; Horizon reports the
 * underlying G… on every effect and operation (the muxed id arrives beside it
 * in `to_muxed`/`to_muxed_id`, never in `account`). So comparing a stored M…
 * against Horizon with `===` never matches, and a payment that settled
 * exactly where it was sent reads back as unverified — or, in reconcile, as a
 * confirmed discrepancy. Resolve the row's payee to the settlement account
 * before any comparison against chain data.
 *
 * Kept here rather than in send.ts so verify, reconcile and the statement all
 * share one answer: the seam between those three is where this bug lived.
 */
export function settlementPayee(
	payee: string | null | undefined,
): string | null {
	if (!payee) return null;
	if (!StrKey.isValidMed25519PublicKey(payee)) return payee;
	return MuxedAccount.fromAddress(payee, "0").baseAccount().accountId();
}

/** Canonical content = the row minus its own id, keys sorted. */
function contentId(row: Omit<ReceiptRow, "id">): string {
	const sorted = Object.fromEntries(
		Object.entries(row)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	return createHash("sha256")
		.update(JSON.stringify(sorted))
		.digest("hex")
		.slice(0, 16);
}

/** Append a row; returns its id so later rows can reference it. */
export function record(row: Omit<ReceiptRow, "id" | "at">): string {
	// A ref must name a receipt that EXISTS. Call sites pass `prev ?? ""` in
	// places where there is no predecessor, which wrote refs:[""] — a link to
	// nothing, in the one structure whose whole job is provenance. Drop blanks
	// here, at the single door every row goes through, rather than trusting
	// ~20 call sites to remember.
	if (row.refs) {
		const refs = row.refs.filter((r) => typeof r === "string" && r.trim());
		row = refs.length ? { ...row, refs } : { ...row, refs: undefined };
	}
	const at = new Date().toISOString();
	// Link to the current tail BEFORE hashing, so the link is part of the
	// content and cannot be rewritten without breaking the row's own id.
	const prev = lastId() ?? undefined;
	const id = contentId({ ...row, at, prev });
	// The at that was HASHED must be the at that is STORED — the first
	// version let the store stamp its own (milliseconds-later) timestamp and
	// no id could ever re-derive. The tamper check caught its own author.
	appendRaw({ id, at, prev, ...row });
	return id;
}

/** Every line, with unparseable ones KEPT as errors rather than dropped —
 *  silently skipping a corrupt line removed it from both `list` and the
 *  tamper check, so damaging one byte of a refusal row erased it from the
 *  record entirely (audit finding 3). */
function readLines(): Array<
	{ ok: true; row: ReceiptRow } | { ok: false; line: number; text: string }
> {
	if (!existsSync(sessionPaths.receipts)) return [];
	return readFileSync(sessionPaths.receipts, "utf8")
		.split("\n")
		.map((text, i) => ({ text, line: i + 1 }))
		.filter((l) => l.text.trim())
		.map((l) => {
			try {
				return { ok: true as const, row: JSON.parse(l.text) as ReceiptRow };
			} catch {
				return { ok: false as const, line: l.line, text: l.text.slice(0, 80) };
			}
		});
}

/** Id of the newest well-formed row — the link target for the next append. */
function lastId(): string | null {
	const lines = readLines();
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i];
		if (l?.ok && l.row.id) return l.row.id;
	}
	return null;
}

export function list(opts?: {
	kind?: ReceiptKind;
	limit?: number;
}): ReceiptRow[] {
	const rows = readLines()
		.flatMap((l) => (l.ok ? [l.row] : []))
		.filter((r) => !opts?.kind || r.kind === opts.kind);
	return rows.slice(-(opts?.limit ?? 50));
}

const HORIZON: Record<string, string> = {
	"stellar:testnet": "https://horizon-testnet.stellar.org",
	"stellar:pubnet": "https://horizon.stellar.org",
};

/** The most recent receipt of a kind for a contract — how a LATER command
 * finds the row it continues. `bounty watch` runs in its own process, minutes
 * after `bounty pack`, so the chain cannot be threaded through memory: the
 * ledger has to be able to answer "what came before this". */
export function lastFor(
	kind: ReceiptKind,
	contractId: string,
): ReceiptRow | null {
	const rows = list({ kind });
	for (let i = rows.length - 1; i >= 0; i--) {
		const r = rows[i];
		if (
			r &&
			(r.detail as { contractId?: string } | undefined)?.contractId ===
				contractId
		)
			return r;
	}
	return null;
}

export type VerifyResult = {
	ok: boolean;
	checks: Array<{ name: string; ok: boolean; note?: string }>;
};

/**
 * Integrity check over the whole ledger. Three failure classes, because the
 * first one alone was not enough (audit finding 3):
 *
 *   edited     a row's id no longer re-derives from its content;
 *   unlinked   a row's `prev` names an id that is not an earlier row — what a
 *              DELETED, reordered, or spliced-out row leaves behind;
 *   unreadable a line that is not JSON. These used to be dropped on read, so
 *              corrupting one byte of a refusal removed it from the listing
 *              AND from this check — the one edit nothing could see.
 *
 * WHAT THIS DOES NOT PROVE. Anyone who can write this file can rewrite it
 * whole and recompute every id and link consistently; a local file cannot
 * defend against its own owner. This detects corruption and partial edits,
 * not a determined forger. The real anchor for a PAYMENT row is
 * `verifyOnChain` — the chain is the witness, this ledger is the index.
 */
export function checkLedger(): {
	ok: boolean;
	rows: number;
	bad: Array<{ id: string; expected: string }>;
	unlinked: Array<{ id: string; prev: string }>;
	unreadable: Array<{ line: number; text: string }>;
} {
	const lines = readLines();
	const bad: Array<{ id: string; expected: string }> = [];
	const unlinked: Array<{ id: string; prev: string }> = [];
	const unreadable = lines.flatMap((l) =>
		l.ok ? [] : [{ line: l.line, text: l.text }],
	);
	const seen = new Set<string>();
	for (const l of lines) {
		if (!l.ok) continue;
		const { id, ...rest } = l.row;
		const expected = contentId(rest);
		if (expected !== id) bad.push({ id, expected });
		// A link must name a row that came BEFORE this one. Rows written before
		// the chain existed carry no prev and are checked by content only —
		// legacy rows are not evidence of tampering.
		if (l.row.prev && !seen.has(l.row.prev))
			unlinked.push({ id, prev: l.row.prev });
		seen.add(id);
	}
	return {
		ok: bad.length === 0 && unlinked.length === 0 && unreadable.length === 0,
		rows: lines.filter((l) => l.ok).length,
		bad,
		unlinked,
		unreadable,
	};
}

/**
 * The PGTR half: prove the receipt against the CHAIN, not our own ledger.
 * Anyone holding this row (and nothing else of ours) can run the same checks.
 */
export async function verifyOnChain(row: ReceiptRow): Promise<VerifyResult> {
	const checks: VerifyResult["checks"] = [];
	const fail = (name: string, note: string) => {
		checks.push({ name, ok: false, note });
		return { ok: false, checks };
	};
	if (!row.tx) return fail("tx-present", "receipt carries no transaction hash");
	const horizon = HORIZON[row.network ?? ""];
	if (!horizon)
		return fail("network-known", `no Horizon for "${row.network ?? "?"}"`);

	const txRes = await fetch(`${horizon}/transactions/${row.tx}`);
	if (!txRes.ok)
		return fail("tx-found", `Horizon ${txRes.status} for ${row.tx}`);
	const tx = (await txRes.json()) as { successful?: boolean };
	checks.push({ name: "tx-found", ok: true });
	if (!tx.successful) return fail("tx-successful", "transaction failed");
	checks.push({ name: "tx-successful", ok: true });

	// Amount + payee: the tx's effects must credit the payee. Native amounts
	// arrive as "0.0010000" — normalize to base units before comparing.
	if (row.payee && row.amount) {
		const fx = await fetch(
			`${horizon}/transactions/${row.tx}/effects?limit=50`,
		);
		if (!fx.ok) return fail("effects-read", `Horizon ${fx.status}`);
		const d = (await fx.json()) as {
			_embedded?: {
				records?: Array<{
					type: string;
					account?: string;
					amount?: string;
					asset_type?: string;
					asset_code?: string;
					asset_issuer?: string;
				}>;
			};
		};
		const toBase = (human: string) => {
			const [i = "0", f = ""] = human.split(".");
			return BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
		};
		// The ASSET has to match too. Without it, "1.5 of some worthless token
		// credited to the payee" proved "1.5 USDC was paid" — a receipt is only
		// evidence if it checks what a forger would change. `asset` on a row is
		// the SAC contract id; Horizon reports classic code+issuer, so match the
		// native case exactly and require a code match otherwise.
		const wantNative =
			!row.asset ||
			row.asset === Asset.native().contractId(Networks.PUBLIC) ||
			row.asset === Asset.native().contractId(Networks.TESTNET);
		const assetMatches = (e: { asset_type?: string }) =>
			wantNative ? e.asset_type === "native" : e.asset_type !== "native";
		const hit = (d._embedded?.records ?? []).some(
			(e) =>
				e.type === "account_credited" &&
				e.account === settlementPayee(row.payee) &&
				assetMatches(e) &&
				toBase(e.amount ?? "0") === BigInt(row.amount ?? "0"),
		);
		checks.push({
			name: "payee-credited-amount",
			ok: hit,
			note: hit
				? undefined
				: `no account_credited of ${row.amount} to ${row.payee} in ${row.tx}`,
		});
		if (!hit) return { ok: false, checks };
	}
	return { ok: true, checks };
}

/**
 * A statement row — the join a finance team actually needs.
 *
 * Every payment already carries both halves: `url` (the HTTP request that
 * caused the spend) and `tx` (the settlement on Stellar). What was missing
 * was one artifact that puts them on the same line, in both directions, so
 * a spend can be traced from an invoice line to a request and back.
 *
 * `rule` comes from the policy-decision receipt this payment references
 * (`refs`), so the statement also answers WHY the spend was allowed — not
 * just that it happened. `verifiable` says whether the row carries what
 * `verifyOnChain` needs; it is a property of the row, never a claim that
 * verification was run.
 */
export type StatementRow = {
	at: string;
	receipt: string;
	kind: ReceiptKind;
	network: string | null;
	protocol: string | null;
	/** the HTTP request that caused the spend */
	url: string | null;
	amount: string | null;
	asset: string | null;
	payee: string | null;
	/** the settlement on Stellar */
	tx: string | null;
	/** the policy rule that allowed it, from the referenced decision */
	rule: string | null;
	verifiable: boolean;
};

/**
 * Kinds that MOVE VALUE — a statement is about money, not bookkeeping.
 * Both directions: `bounty-income` is money in, the rest is money out, and
 * the `kind` column is what distinguishes them. Deliberately excludes rows
 * that only record a decision or a state change (`policy-decision`,
 * `job-open`, `job-deliver`, `vault-create`, `channel-open`, …) — those are
 * reachable from a payment's `refs`, which is how `rule` below is resolved.
 */
const VALUE_KINDS = new Set<ReceiptKind>([
	"payment",
	"channel-close",
	"job-fund",
	"job-release",
	"vault-topup",
	"vault-draw",
	"bounty-income",
]);

/**
 * Build the statement from the ledger. Rows are returned oldest-first, the
 * order a statement is read in. `list` returns oldest-first already, so no
 * reversal is needed here.
 */
export function statement(opts?: { limit?: number }): StatementRow[] {
	const all = list({ limit: opts?.limit ?? 10_000 });
	const byId = new Map(all.map((r) => [r.id, r]));
	const rows: StatementRow[] = [];
	for (const r of all) {
		if (!VALUE_KINDS.has(r.kind)) continue;
		// The rule lives on the decision this payment references, not on the
		// payment itself — follow refs rather than duplicating it at write time.
		let rule: string | null =
			typeof r.detail?.rule === "string" ? r.detail.rule : null;
		for (const ref of r.refs ?? []) {
			const d = byId.get(ref);
			if (d?.kind === "policy-decision" && typeof d.detail?.rule === "string") {
				rule = d.detail.rule;
				break;
			}
		}
		rows.push({
			at: r.at,
			receipt: r.id,
			kind: r.kind,
			network: r.network ?? null,
			protocol: r.protocol ?? null,
			url: r.url ?? null,
			amount: r.amount ?? null,
			asset: r.asset ?? null,
			payee: r.payee ?? null,
			tx: r.tx ?? null,
			rule,
			// Presence only — never a claim that verification RAN. A muxed payee
			// resolves to its settlement account first, so this cannot report
			// verifiable on a row verifyOnChain would refuse for that reason.
			verifiable: Boolean(
				r.tx && r.amount && settlementPayee(r.payee) && r.network,
			),
		});
	}
	return rows;
}

/** CSV, for the spreadsheet a finance team already lives in. RFC 4180
 *  quoting: wrap every field, double any embedded quote. */
export function statementCsv(rows: StatementRow[]): string {
	const cols: (keyof StatementRow)[] = [
		"at",
		"receipt",
		"kind",
		"network",
		"protocol",
		"url",
		"amount",
		"asset",
		"payee",
		"tx",
		"rule",
		"verifiable",
	];
	const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
	return [
		cols.join(","),
		...rows.map((r) => cols.map((c) => cell(r[c])).join(",")),
	].join("\n");
}
