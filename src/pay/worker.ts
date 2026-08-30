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
 * Submission transport: packets are ed25519-signed over
 * sha256(contractId | worker | evidence), which stops a packet being re-wrapped
 * under someone else's payout address — it does NOT stop a party who SEES the
 * evidence from re-signing the same content as their own. So the transport is
 * NOT trustless: post to the descriptor's `submitUrl`, which should be the
 * RESOLVER's inbox (the declared neutral party), never the buyer's — the buyer
 * is the one party that profits from stealing the work. Commit-reveal is the
 * real fix and is not built; see README "Not built yet".
 */
import { readFileSync } from "node:fs";
import { Asset, type Keypair, Networks } from "@stellar/stellar-sdk";
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

/** A fetch that does NOT blindly follow redirects.
 *
 * Both feed reads and packet submissions take a URL from an untrusted feed, and
 * the default `redirect: "follow"` meant a caller's one-time SSRF check on the
 * initial URL was worth nothing: a 302 walked the request to a host nobody
 * vetted (and a 307/308 carries the POST body along with it). The guard
 * belongs HERE, once, so every caller inherits it. */
async function guardedFetch(
	url: string,
	init: RequestInit,
	guard?: (u: string) => Promise<string | null> | string | null,
): Promise<Response> {
	let current = url;
	for (let hop = 0; hop < 5; hop++) {
		const blocked = await guard?.(current);
		if (blocked) throw new Error(`refused ${current}: ${blocked}`);
		const res = await fetch(current, { ...init, redirect: "manual" });
		if (![301, 302, 303, 307, 308].includes(res.status)) return res;
		const loc = res.headers.get("location");
		if (!loc) return res;
		current = new URL(loc, current).toString();
	}
	throw new Error(`too many redirects from ${url}`);
}

export type OpenBountyListing = {
	contractId: string;
	descriptor: BountyDescriptor;
};

export type VetCheck = { name: string; ok: boolean; note: string };

/** Fetch a bounty feed — a URL or a local file holding either a bare array
 * of listings or `{ bounties: [...] }`. Shape-filters rows (a malformed row
 * is dropped, never thrown on); vetting is separate and per-listing. */
export async function fetchFeed(
	from: string,
	guard?: (u: string) => Promise<string | null> | string | null,
): Promise<OpenBountyListing[]> {
	let text: string;
	if (/^https?:\/\//.test(from)) {
		const r = await guardedFetch(
			from,
			{ signal: AbortSignal.timeout(10_000) },
			guard,
		);
		if (!r.ok) throw new Error(`feed ${from}: HTTP ${r.status}`);
		// A feed is a stranger's server, so bound the read AS IT ARRIVES.
		// Buffering first and checking length after is not a limit: a hostile
		// feed streaming gigabytes was bounded only by the abort timeout.
		const MAX = 2_000_000;
		const declared = Number(r.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > MAX)
			throw new Error(
				`feed ${from}: declares ${declared} bytes, over the 2MB cap`,
			);
		const reader = r.body?.getReader();
		if (!reader) throw new Error(`feed ${from}: no body`);
		const chunks: Uint8Array[] = [];
		let seen = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			seen += value.byteLength;
			if (seen > MAX) {
				await reader.cancel();
				throw new Error(`feed ${from}: exceeded the 2MB cap mid-stream`);
			}
			chunks.push(value);
		}
		text = Buffer.concat(chunks).toString("utf8");
	} else {
		text = readFileSync(from, "utf8");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(`feed ${from}: not JSON (${(e as Error).message})`);
	}
	// `null` is valid JSON and is NOT an object you can read `.bounties` off —
	// a stranger's feed answering `null` crashed with a raw TypeError.
	const rows = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" && parsed !== null
			? ((parsed as { bounties?: unknown[] }).bounties ?? [])
			: [];
	if (!Array.isArray(rows))
		throw new Error(`feed ${from}: "bounties" is not an array`);
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
	// The decision seats, not just the dispute seat. An escrow can name the
	// declared neutral resolver as dispute_resolver — passing every other check
	// — while the BUYER holds approver + release_signer, and then simply approve
	// and release the pot back to itself after a stranger has done the work.
	// The agreement doc cannot show this: it renders one "resolver" field.
	push(
		"decision-seats",
		state.approver === d.resolver && state.releaseSigner === d.resolver,
		`approver=${state.approver.slice(0, 8)}… release=${state.releaseSigner.slice(0, 8)}… must both be the declared resolver ${d.resolver.slice(0, 8)}…`,
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
	guard?: (u: string) => Promise<string | null> | string | null;
}): Promise<{ packet: OpenSubmission; status: number; receiptId: string }> {
	const packet = makeSubmission({
		worker: o.worker,
		contractId: o.contractId,
		evidence: o.evidence,
	});
	const r = await guardedFetch(
		o.url,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(packet),
			signal: AbortSignal.timeout(15_000),
		},
		o.guard,
	);
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
 * .find() (settlement can credit in several records and fee crumbs exist),
 * PAGED (a busy account can push the payout past the first page), and filtered
 * to the bounty's OWN asset: an unrelated payment landing during the watch
 * window would otherwise be booked as this bounty's income. */
async function creditedSince(
	account: string,
	cursor: string,
	wantNative: boolean,
): Promise<{ stroops: bigint; opHref: string | null }> {
	let stroops = 0n;
	let opHref: string | null = null;
	let next = cursor;
	for (let page = 0; page < 10; page++) {
		const q = next ? `&cursor=${encodeURIComponent(next)}` : "";
		const r = await fetch(
			`${HORIZON}/accounts/${account}/effects?order=asc&limit=100${q}`,
			{ signal: AbortSignal.timeout(10_000) },
		);
		if (!r.ok) break;
		const d = (await r.json()) as {
			_embedded?: {
				records?: Array<{
					type: string;
					amount?: string;
					asset_type?: string;
					asset_code?: string;
					asset_issuer?: string;
					paging_token?: string;
					_links?: { operation?: { href?: string } };
				}>;
			};
		};
		const records = d._embedded?.records ?? [];
		for (const rec of records) {
			if (rec.paging_token) next = rec.paging_token;
			if (rec.type !== "account_credited") continue;
			if ((rec.asset_type === "native") !== wantNative) continue;
			const [i = "0", f = ""] = (rec.amount ?? "0").split(".");
			stroops += BigInt(i) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
			opHref = rec._links?.operation?.href ?? opHref;
		}
		if (records.length < 100) break;
	}
	return { stroops, opHref };
}

/** The baseline cursor, or null if Horizon would not tell us.
 *
 * MUST distinguish "no effects yet" from "the call failed". Returning "" for
 * both meant a routine 429 made creditedSince page the account's ENTIRE
 * history and report a lifetime balance as this bounty's income — a false
 * paid:true, and a forged row in the ledger a reputation story rests on. */
async function latestEffectCursor(account: string): Promise<string | null> {
	const r = await fetch(
		`${HORIZON}/accounts/${account}/effects?order=desc&limit=1`,
		{ signal: AbortSignal.timeout(10_000) },
	);
	if (!r.ok) return null;
	const d = (await r.json()) as {
		_embedded?: { records?: Array<{ paging_token?: string }> };
	};
	return d._embedded?.records?.[0]?.paging_token ?? "";
}

/** Is the escrow's token the native XLM SAC? Credits are then filtered to
 * matching effects, so an unrelated payment arriving during the watch window
 * is not booked as this bounty's income. Mapping a non-native SAC to its
 * (code, issuer) needs a contract read we deliberately skip: matching
 * "non-native credits" is coarser but still a real filter, and erring toward
 * counting less income is the safe direction for a ledger. */
function isNativeSac(tokenContract: string): boolean {
	return (
		tokenContract === Asset.native().contractId(Networks.TESTNET) ||
		tokenContract === Asset.native().contractId(Networks.PUBLIC)
	);
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
	if (cursor === null)
		throw new Error(
			"cannot establish an effects baseline from Horizon (rate-limited or down) — refusing to watch, because without a baseline a settlement would credit this bounty with the account's entire history",
		);
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
			const { stroops, opHref } = await creditedSince(
				me,
				cursor,
				isNativeSac(state.tokenContract),
			);
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
