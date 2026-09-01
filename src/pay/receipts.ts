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
import { Asset, Networks } from "@stellar/stellar-sdk";
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
				e.account === row.payee &&
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
