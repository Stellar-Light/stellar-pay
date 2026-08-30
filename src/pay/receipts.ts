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
	const at = new Date().toISOString();
	const id = contentId({ ...row, at });
	// The at that was HASHED must be the at that is STORED — the first
	// version let the store stamp its own (milliseconds-later) timestamp and
	// no id could ever re-derive. The tamper check caught its own author.
	appendRaw({ id, at, ...row });
	return id;
}

export function list(opts?: {
	kind?: ReceiptKind;
	limit?: number;
}): ReceiptRow[] {
	if (!existsSync(sessionPaths.receipts)) return [];
	const rows = readFileSync(sessionPaths.receipts, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l) as ReceiptRow;
			} catch {
				return null;
			}
		})
		.filter((r): r is ReceiptRow => r !== null)
		.filter((r) => !opts?.kind || r.kind === opts.kind);
	return rows.slice(-(opts?.limit ?? 50));
}

const HORIZON: Record<string, string> = {
	"stellar:testnet": "https://horizon-testnet.stellar.org",
	"stellar:pubnet": "https://horizon.stellar.org",
};

export type VerifyResult = {
	ok: boolean;
	checks: Array<{ name: string; ok: boolean; note?: string }>;
};

/**
 * Tamper check: every row's id must re-derive from its own content. The
 * ledger is append-only JSONL, so an edited row's hash stops matching —
 * content-addressing only means something if somebody actually re-checks.
 */
export function checkLedger(): {
	ok: boolean;
	rows: number;
	bad: Array<{ id: string; expected: string }>;
} {
	const rows = list({ limit: 1_000_000 });
	const bad: Array<{ id: string; expected: string }> = [];
	for (const r of rows) {
		const { id, ...rest } = r;
		const expected = contentId(rest);
		if (expected !== id) bad.push({ id, expected });
	}
	return { ok: bad.length === 0, rows: rows.length, bad };
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
				records?: Array<{ type: string; account?: string; amount?: string }>;
			};
		};
		const toBase = (human: string) => {
			const [i = "0", f = ""] = human.split(".");
			return BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
		};
		const hit = (d._embedded?.records ?? []).some(
			(e) =>
				e.type === "account_credited" &&
				e.account === row.payee &&
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
