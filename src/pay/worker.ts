/**
 * The WORKER side of the marketplace — how an agent EARNS.
 *
 * Everything else in the work layer serves the buyer (fund, hire, verify,
 * pay). This module is the other half of the thesis: an agent that FINDS a
 * task posted by a stranger, decides it is safe to work on, does the work,
 * submits signed evidence, and confirms the payout landed — with no platform
 * and no trust in the feed.
 *
 * The trust problem, concretely: a feed row is a CLAIM ("this bounty pays 5
 * XLM"). Feeds can lie. Before spending any work, `vetListing` checks the
 * claim against the CHAIN:
 *   - the escrow exists and is readable;
 *   - its STRUCT fields (token, amount, resolver, buyer-as-fallback) match
 *     the descriptor — a tampered feed row fails here;
 *   - the agreement doc on the escrow hashes to its engagement_id, AND the
 *     terms re-derived from the descriptor alone (openBountyTerms) hash to
 *     the same id — so the chain pinned exactly these items/instructions;
 *   - the pot is actually FUNDED (balance ≥ amount — the terms amount alone
 *     proves nothing);
 *   - nobody has settled or disputed it yet.
 * A listing failing ANY check is refused with the reason. An agent must
 * never work an unfunded or tampered promise.
 *
 * Submission transport: packets are self-authenticating (ed25519 over
 * sha256(contractId | evidence)), so the transport needs no trust — v1 POSTs
 * to the descriptor's `submitUrl` (any inbox the buyer operates).
 */
import { readFileSync } from "node:fs";
import type { Keypair } from "@stellar/stellar-sdk";
import { agreementHash } from "./agreement.js";
import type { EvidenceEntry } from "./bounty.js";
import {
	type BountyDescriptor,
	makeSubmission,
	type OpenSubmission,
	openBountyTerms,
} from "./bounty.js";
import { readEscrowAs } from "./job.js";
import type { EscrowState } from "./rails.js";
import { record } from "./receipts.js";

const HORIZON = "https://horizon-testnet.stellar.org";

export type OpenBountyListing = {
	contractId: string;
	descriptor: BountyDescriptor;
};

export type VetCheck = { name: string; ok: boolean; note: string };

/** Fetch a bounty feed — a URL or a local file holding either a bare array
 * of listings or `{ bounties: [...] }`. Shape-filters rows (a malformed row
 * is dropped, never thrown on); vetting is separate and per-listing. */
export async function fetchFeed(from: string): Promise<OpenBountyListing[]> {
	let text: string;
	if (/^https?:\/\//.test(from)) {
		const r = await fetch(from, { signal: AbortSignal.timeout(10_000) });
		if (!r.ok) throw new Error(`feed ${from}: HTTP ${r.status}`);
		text = await r.text();
	} else {
		text = readFileSync(from, "utf8");
	}
	const parsed = JSON.parse(text) as unknown;
	const rows = Array.isArray(parsed)
		? parsed
		: ((parsed as { bounties?: unknown[] }).bounties ?? []);
	return rows.filter(
		(r): r is OpenBountyListing =>
			typeof r === "object" &&
			r !== null &&
			typeof (r as OpenBountyListing).contractId === "string" &&
			typeof (r as OpenBountyListing).descriptor === "object",
	);
}

/** The pure core of the vet: chain state vs the listing's claims. Exported
 * for offline unit checks; `vetListing` is the network wrapper. */
export function checkListing(
	state: EscrowState,
	l: OpenBountyListing,
): { ok: boolean; checks: VetCheck[] } {
	const d = l.descriptor;
	const checks: VetCheck[] = [];
	const push = (name: string, ok: boolean, note = "") =>
		checks.push({ name, ok, note });

	const shapeOk =
		d?.format === "stellar-pay/bounty-v1" &&
		d.kind === "verification" &&
		Array.isArray(d.items) &&
		d.items.length > 0 &&
		/^\d+$/.test(String(d.amount)) &&
		BigInt(d.amount) > 0n;
	push(
		"descriptor-shape",
		shapeOk,
		shapeOk ? "" : "not a bounty-v1 descriptor",
	);
	if (!shapeOk) return { ok: false, checks };

	// The chain's own binding: description hashes to the pinned engagement_id.
	push(
		"terms-pinned",
		agreementHash(state.description) === state.engagementId,
		"sha256(on-chain agreement) vs engagement_id",
	);
	// The descriptor's binding: re-derived terms hash to the SAME id — the
	// feed row cannot claim different items/instructions/amount than escrowed.
	push(
		"descriptor-matches-terms",
		openBountyTerms(d).hash === state.engagementId,
		"terms re-derived from the descriptor vs engagement_id",
	);
	// Struct fields the contract enforces, vs the descriptor's claims.
	push(
		"struct-matches",
		state.amount === BigInt(d.amount) &&
			state.tokenContract === d.tokenContract &&
			state.resolver === d.resolver &&
			state.provider === d.buyer,
		"token/amount/resolver/receiver-fallback on the escrow struct",
	);
	push(
		"funded",
		state.balance >= state.amount,
		`balance ${state.balance} vs amount ${state.amount}`,
	);
	push(
		"open",
		!state.released && !state.disputed,
		state.released ? "already settled" : state.disputed ? "in dispute" : "",
	);
	return { ok: checks.every((c) => c.ok), checks };
}

/** Vet a listing against the chain. A read failure is itself a failed check
 * (an unreadable escrow is not a workable bounty), never a throw. */
export async function vetListing(o: {
	listing: OpenBountyListing;
	source: Keypair;
}): Promise<{ ok: boolean; checks: VetCheck[] }> {
	let state: EscrowState;
	try {
		state = await readEscrowAs(o.listing.contractId, o.source);
	} catch (e) {
		return {
			ok: false,
			checks: [
				{
					name: "escrow-readable",
					ok: false,
					note: (e as Error).message.slice(0, 120),
				},
			],
		};
	}
	return checkListing(state, o.listing);
}

/** Sign evidence and POST the packet to the bounty's inbox. The packet holds
 * no secrets — only evidence, the payout address, and the signature binding
 * them. Receipted as bounty-work-submit. */
export async function submitPacket(o: {
	worker: Keypair;
	contractId: string;
	evidence: EvidenceEntry[];
	url: string;
}): Promise<{ packet: OpenSubmission; status: number; receiptId: string }> {
	const packet = makeSubmission({
		worker: o.worker,
		contractId: o.contractId,
		evidence: o.evidence,
	});
	const r = await fetch(o.url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(packet),
		signal: AbortSignal.timeout(15_000),
	});
	if (!r.ok) throw new Error(`submit to ${o.url}: HTTP ${r.status}`);
	const receiptId = record({
		kind: "bounty-work-submit",
		network: "stellar:testnet",
		payer: o.worker.publicKey(),
		detail: {
			contractId: o.contractId,
			submitUrl: o.url,
			items: o.evidence.map((e) => e.item),
		},
	});
	return { packet, status: r.status, receiptId };
}

/** Everything credited to `account` in effects AFTER `cursor` — SUMMED, never
 * .find(): settlement can credit in several records and fee crumbs exist. */
async function creditedSince(
	account: string,
	cursor: string,
): Promise<{ stroops: bigint; opHref: string | null }> {
	const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
	const r = await fetch(
		`${HORIZON}/accounts/${account}/effects?order=asc&limit=100${q}`,
		{ signal: AbortSignal.timeout(10_000) },
	);
	if (!r.ok) return { stroops: 0n, opHref: null };
	const d = (await r.json()) as {
		_embedded?: {
			records?: Array<{
				type: string;
				amount?: string;
				_links?: { operation?: { href?: string } };
			}>;
		};
	};
	let stroops = 0n;
	let opHref: string | null = null;
	for (const rec of d._embedded?.records ?? []) {
		if (rec.type !== "account_credited") continue;
		const [i = "0", f = ""] = (rec.amount ?? "0").split(".");
		stroops += BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
		opHref = rec._links?.operation?.href ?? opHref;
	}
	return { stroops, opHref };
}

async function latestEffectCursor(account: string): Promise<string> {
	const r = await fetch(
		`${HORIZON}/accounts/${account}/effects?order=desc&limit=1`,
		{ signal: AbortSignal.timeout(10_000) },
	);
	if (!r.ok) return "";
	const d = (await r.json()) as {
		_embedded?: { records?: Array<{ paging_token?: string }> };
	};
	return d._embedded?.records?.[0]?.paging_token ?? "";
}

export type PayoutResult =
	| { paid: true; amountStroops: bigint; tx: string | null; receiptId: string }
	| { paid: false; reason: "lost-or-refunded" | "timeout" };

/** Watch the escrow until it settles, then check whether WE were the one
 * paid. `paid: false, reason: "lost-or-refunded"` is an honest outcome —
 * in an open race someone else's evidence may win. On payout, the income is
 * receipted (bounty-income) with the on-chain tx — the row a reputation
 * story is built from. */
export async function awaitPayout(o: {
	contractId: string;
	worker: Keypair;
	timeoutMs?: number;
	pollMs?: number;
}): Promise<PayoutResult> {
	const timeoutMs = o.timeoutMs ?? 300_000;
	const pollMs = o.pollMs ?? 5_000;
	const me = o.worker.publicKey();
	const cursor = await latestEffectCursor(me);
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		let state: EscrowState | null = null;
		try {
			state = await readEscrowAs(o.contractId, o.worker);
		} catch {
			// transient RPC hiccup — keep polling
		}
		if (state && (state.balance === 0n || state.released)) {
			// Settled. Give Horizon a beat to index the effects, then check us.
			await new Promise((r) => setTimeout(r, 4_000));
			const { stroops, opHref } = await creditedSince(me, cursor);
			if (stroops > 0n) {
				let tx: string | null = null;
				if (opHref) {
					try {
						const op = (await (
							await fetch(opHref, { signal: AbortSignal.timeout(10_000) })
						).json()) as { transaction_hash?: string };
						tx = op.transaction_hash ?? null;
					} catch {
						// income is proven by the credit; the tx hash is best-effort
					}
				}
				const receiptId = record({
					kind: "bounty-income",
					network: "stellar:testnet",
					amount: stroops.toString(),
					payee: me,
					tx: tx ?? undefined,
					detail: { contractId: o.contractId },
				});
				return { paid: true, amountStroops: stroops, tx, receiptId };
			}
			return { paid: false, reason: "lost-or-refunded" };
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return { paid: false, reason: "timeout" };
}
