/**
 * Verification bounties — the first PRODUCT on the layer (SPINE.md §products).
 *
 * The shape: a buyer posts a bounty to verify things (directory rows, links,
 * claims — anything a worker can check and evidence), a claimer is assigned,
 * the bounty becomes an escrowed JOB whose agreement demands a structured
 * evidence document, the worker submits that document on-chain, and the
 * automated resolver validates it DETERMINISTICALLY against the bounty's own
 * requirements — release on valid, refund on not. No human adjudication in
 * the happy path; the dispute path stays for the contested one.
 *
 * The general shape any buyer of verified work needs — an individual, an
 * agent, a program operator, or a bounty platform (e.g. grant/bounty sites
 * that pay for validation work with unspecified verification mechanics;
 * hackathons paying winners off spreadsheets): escrow at post, an evidence
 * contract, and an automatic judge — adoptable as a neutral layer.
 *
 * v1 is a DIRECTED bounty: the escrow needs its provider role at init, so
 * the flow is post (descriptor, off-chain) → assign (claimer chosen —
 * escrow opens + funds) → submit (evidence on-chain) → resolve (schema
 * policy judges). Open-claim bounties (anyone races) need a different
 * escrow shape — a later iteration, noted honestly.
 *
 * Evidence contract (deterministic, declared in the agreement itself):
 * a JSON array with EXACTLY one entry per requested item:
 *   { "item": "<requested id>", "url": "https://…", "verdict": "<non-empty>",
 *     "checkedAt": "<ISO 8601>", "excerpt": "<non-empty proof text>" }
 */
import type { Keypair } from "@stellar/stellar-sdk";
import {
	deliverJob,
	disputeJob,
	fundJob,
	type JobSpec,
	jobAgreement,
	openJob,
	readEscrowAs,
	resolveDisputeJob,
} from "./job.js";
import { record } from "./receipts.js";
import { type ResolverPolicy, resolveJob } from "./resolver.js";

export type BountyDescriptor = {
	format: "stellar-pay/bounty-v1";
	kind: "verification";
	title: string;
	/** the ids to verify (e.g. directory slugs, URLs, claim ids) */
	items: string[];
	/** what "verify" means for these items, in prose */
	instructions: string;
	/** total payout, base units of tokenContract */
	amount: string;
	tokenContract: string;
	/** evidence freshness bound (ISO duration in days) */
	maxEvidenceAgeDays: number;
	/** the resolver that will judge (G…) — declared up front */
	resolver: string;
	/** the buyer who will fund (G…) */
	buyer: string;
	/** open-claim only: where signed submission packets POST (optional —
	 * absent means the transport is out of band) */
	submitUrl?: string;
};

/** Post = author the descriptor (off-chain, shareable). The bounty's terms
 * are final here — assign/submit/resolve all derive from this object. */
export function postBounty(o: {
	buyer: string;
	resolver: string;
	title: string;
	items: string[];
	instructions: string;
	amount: bigint;
	tokenContract: string;
	maxEvidenceAgeDays?: number;
	submitUrl?: string;
}): BountyDescriptor {
	if (o.items.length === 0) throw new Error("a bounty needs at least one item");
	return {
		format: "stellar-pay/bounty-v1",
		kind: "verification",
		title: o.title,
		items: [...o.items],
		instructions: o.instructions,
		amount: o.amount.toString(),
		tokenContract: o.tokenContract,
		maxEvidenceAgeDays: o.maxEvidenceAgeDays ?? 7,
		resolver: o.resolver,
		buyer: o.buyer,
		...(o.submitUrl ? { submitUrl: o.submitUrl } : {}),
	};
}

/** The bounty's job spec — one canonical derivation used by assign AND by
 * anyone re-checking what was escrowed. */
export function bountyJobSpec(
	d: BountyDescriptor,
	buyer: Keypair,
	provider: string,
): JobSpec {
	return {
		buyer,
		provider,
		resolver: d.resolver,
		tokenContract: d.tokenContract,
		amount: BigInt(d.amount),
		title: d.title,
		spec: `${d.instructions}

Items to verify (evidence must cover EVERY item, exactly once):
${d.items.map((i) => `- ${i}`).join("\n")}`,
		reviewQuestion:
			"Is the submitted evidence a valid JSON array with exactly one entry per requested item, each carrying item, url (http/https), non-empty verdict, checkedAt (ISO 8601, within the freshness bound), and a non-empty excerpt?",
		allowedEvidence: [
			"the milestone evidence string (the evidence JSON document itself)",
		],
		resolutionEffects: [
			["yes", "release"],
			["no", "refund"],
		],
		resolverPolicy: "evidence-schema:verification-v1",
		twFeeAddress: buyer.publicKey(),
	};
}

/** Assign the claimer: the descriptor becomes an escrowed job (open + fund). */
export async function assignBounty(o: {
	descriptor: BountyDescriptor;
	buyer: Keypair;
	provider: string;
}): Promise<{ contractId: string; openReceiptId: string; fundTx: string }> {
	if (o.buyer.publicKey() !== o.descriptor.buyer)
		throw new Error("assigning key is not the descriptor's buyer");
	const spec = bountyJobSpec(o.descriptor, o.buyer, o.provider);
	const open = await openJob(spec);
	const fund = await fundJob({
		...spec,
		contractId: open.contractId,
		engagementId: open.engagementId,
		openReceiptId: open.receiptId,
	});
	record({
		kind: "bounty-assign",
		network: "stellar:testnet",
		amount: o.descriptor.amount,
		asset: o.descriptor.tokenContract,
		payer: o.buyer.publicKey(),
		payee: o.provider,
		refs: [open.receiptId],
		detail: {
			contractId: open.contractId,
			items: o.descriptor.items,
			title: o.descriptor.title,
		},
	});
	return {
		contractId: open.contractId,
		openReceiptId: open.receiptId,
		fundTx: fund.tx,
	};
}

export type EvidenceEntry = {
	item: string;
	url: string;
	verdict: string;
	checkedAt: string;
	excerpt: string;
};

/** Submit = the worker's evidence document goes on-chain as the milestone
 * evidence. Kept as plain JSON (a few KB is fine in a Soroban string). */
export async function submitBounty(o: {
	provider: Keypair;
	contractId: string;
	evidence: EvidenceEntry[];
	prevReceiptId: string;
}): Promise<{ tx: string; receiptId: string }> {
	return deliverJob({
		provider: o.provider,
		contractId: o.contractId,
		evidence: JSON.stringify(o.evidence),
		prevReceiptId: o.prevReceiptId,
	});
}

/** The deterministic judge: valid JSON, exact item coverage (each requested
 * item exactly once, nothing extra), http(s) urls, non-empty verdicts and
 * excerpts, fresh ISO timestamps. No opinions — schema and coverage only. */
export function verificationEvidencePolicy(
	d: Pick<BountyDescriptor, "items" | "maxEvidenceAgeDays">,
	now: () => number = Date.now,
): ResolverPolicy {
	return ({ evidence }) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(evidence);
		} catch {
			return "no";
		}
		if (!Array.isArray(parsed)) return "no";
		const entries = parsed as Array<Partial<EvidenceEntry>>;
		const wanted = new Set(d.items);
		const seen = new Set<string>();
		for (const e of entries) {
			if (typeof e.item !== "string" || !wanted.has(e.item)) return "no";
			if (seen.has(e.item)) return "no"; // duplicates are not coverage
			seen.add(e.item);
			if (typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) return "no";
			if (typeof e.verdict !== "string" || e.verdict.trim() === "") return "no";
			if (typeof e.excerpt !== "string" || e.excerpt.trim() === "") return "no";
			if (typeof e.checkedAt !== "string") return "no";
			const t = Date.parse(e.checkedAt);
			if (Number.isNaN(t)) return "no";
			const ageDays = (now() - t) / 86_400_000;
			if (ageDays < -0.5 || ageDays > d.maxEvidenceAgeDays) return "no";
		}
		return seen.size === wanted.size ? "yes" : "no";
	};
}

/** Resolve the bounty with the deterministic evidence policy. */
export async function resolveBounty(o: {
	descriptor: BountyDescriptor;
	resolver: Keypair;
	contractId: string;
	/** a party with standing to raise the dispute on a refund (usually buyer) */
	disputeRaiser?: Keypair;
}): Promise<Awaited<ReturnType<typeof resolveJob>>> {
	if (o.resolver.publicKey() !== o.descriptor.resolver)
		throw new Error("resolving key is not the descriptor's resolver");
	return resolveJob({
		resolver: o.resolver,
		contractId: o.contractId,
		twFeeAddress: o.descriptor.buyer,
		policy: verificationEvidencePolicy(o.descriptor),
		policyLabel: "evidence-schema:verification-v1",
		disputeRaiser: o.disputeRaiser,
	});
}

/** Status: read the escrow the way any party would. */
export async function bountyStatus(o: {
	contractId: string;
	source: Keypair;
}): Promise<{
	funded: boolean;
	submitted: boolean;
	released: boolean;
	disputed: boolean;
	evidence: EvidenceEntry[] | null;
}> {
	const esc = await readEscrowAs(o.contractId, o.source);
	let evidence: EvidenceEntry[] | null = null;
	try {
		const parsed = JSON.parse(esc.evidence);
		if (Array.isArray(parsed)) evidence = parsed as EvidenceEntry[];
	} catch {
		// not submitted yet, or not JSON — reported as null, never a throw
	}
	return {
		// balance, not amount: the terms amount is set at init whether or not
		// the pot was ever funded (a settled escrow also reads unfunded here).
		funded: esc.balance > 0n,
		submitted: esc.evidence.trim() !== "",
		released: esc.released,
		disputed: esc.disputed,
		evidence,
	};
}

// ─── Open-claim bounties: anyone submits, first VALID evidence wins ─────────
//
// The escrow contract fixes payout roles at init, so open racing cannot ride
// the milestone path (evidence writes are provider-role-gated). Instead:
// funds are escrowed at POST (commitment is visible on-chain, receiver
// fallback = the buyer), submissions travel as SIGNED PACKETS off-chain
// (ed25519 over sha256(contractId | evidence) — the signature binds the
// evidence to the payout address, so nobody can resubmit someone else's work
// as their own), and the resolver settles through the DISPUTE path, whose
// `distributions` can pay any address: first valid submission wins the pot.
// Settlement note, corrected on testnet: the 0.3% protocol fee applies on
// the dispute path too — a winner receives pot − 0.3% (the earlier "no
// skim" read was a coincidence: in refund cases the fee address WAS the
// buyer, so fee + principal summed to the full pot at one address).
// The submission TRANSPORT (how packets reach the resolver — a board, HTTP,
// a repo) is deliberately out of scope here; v1 hands packets in directly.

import { createHash as _ch } from "node:crypto";
import { Keypair as _KP } from "@stellar/stellar-sdk";

export type OpenSubmission = {
	bountyContract: string;
	worker: string;
	evidence: EvidenceEntry[];
	signedAt: string;
	/** base64 ed25519 signature by `worker` over the digest below */
	signature: string;
};

/** The signed digest: sha256(contractId | canonical evidence JSON). */
function submissionDigest(
	contractId: string,
	evidence: EvidenceEntry[],
): Buffer {
	return _ch("sha256")
		.update(`${contractId}|${JSON.stringify(evidence)}`)
		.digest();
}

/** Post an OPEN bounty: funds escrowed now, winner unknown. The provider/
 * receiver role is the BUYER (the no-winner fallback); the resolver holds
 * the decision roles and will pay the winner via the dispute path. */
export async function postOpenBounty(o: {
	descriptor: BountyDescriptor;
	buyer: Keypair;
}): Promise<{ contractId: string; openReceiptId: string; fundTx: string }> {
	if (o.buyer.publicKey() !== o.descriptor.buyer)
		throw new Error("posting key is not the descriptor's buyer");
	const spec = bountyJobSpec(o.descriptor, o.buyer, o.buyer.publicKey());
	const open = await openJob(spec);
	const fund = await fundJob({
		...spec,
		contractId: open.contractId,
		engagementId: open.engagementId,
		openReceiptId: open.receiptId,
	});
	record({
		kind: "bounty-open-post",
		network: "stellar:testnet",
		amount: o.descriptor.amount,
		asset: o.descriptor.tokenContract,
		payer: o.buyer.publicKey(),
		refs: [open.receiptId],
		detail: {
			contractId: open.contractId,
			items: o.descriptor.items,
			title: o.descriptor.title,
			mode: "open-claim",
		},
	});
	return {
		contractId: open.contractId,
		openReceiptId: open.receiptId,
		fundTx: fund.tx,
	};
}

/** Re-derive an open bounty's agreement terms from PUBLIC info only — the
 * descriptor. Same code path postOpenBounty runs (jobAgreement never signs,
 * it only reads public keys), so `openBountyTerms(d).hash` equalling the
 * escrow's on-chain engagement_id proves the chain pinned EXACTLY these
 * terms — a stranger's tamper check before spending any work. */
export function openBountyTerms(d: BountyDescriptor): {
	doc: string;
	hash: string;
} {
	return jobAgreement(bountyJobSpec(d, _KP.fromPublicKey(d.buyer), d.buyer));
}

/** A worker builds a signed submission packet (no chain interaction). */
export function makeSubmission(o: {
	worker: Keypair;
	contractId: string;
	evidence: EvidenceEntry[];
}): OpenSubmission {
	const sig = o.worker.sign(submissionDigest(o.contractId, o.evidence));
	return {
		bountyContract: o.contractId,
		worker: o.worker.publicKey(),
		evidence: o.evidence,
		signedAt: new Date().toISOString(),
		signature: Buffer.from(sig).toString("base64"),
	};
}

/** Pure selection: first submission whose signature verifies AND whose
 * evidence passes the policy. Exported for offline unit checks. */
export function pickWinner(
	contractId: string,
	submissions: OpenSubmission[],
	policy: ResolverPolicy,
): {
	winner: OpenSubmission | null;
	judged: Array<{ worker: string; valid: boolean; reason: string }>;
} {
	const judged: Array<{ worker: string; valid: boolean; reason: string }> = [];
	let winner: OpenSubmission | null = null;
	for (const s of submissions) {
		if (s.bountyContract !== contractId) {
			judged.push({ worker: s.worker, valid: false, reason: "wrong-bounty" });
			continue;
		}
		let sigOk = false;
		try {
			sigOk = _KP
				.fromPublicKey(s.worker)
				.verify(
					submissionDigest(contractId, s.evidence),
					Buffer.from(s.signature, "base64"),
				);
		} catch {
			sigOk = false;
		}
		if (!sigOk) {
			judged.push({ worker: s.worker, valid: false, reason: "bad-signature" });
			continue;
		}
		const answer = policy({
			evidence: JSON.stringify(s.evidence),
			reviewQuestion: "",
			description: "",
			amount: 0n,
		});
		const valid = answer === "yes";
		judged.push({
			worker: s.worker,
			valid,
			reason: valid ? "valid" : "evidence-rejected",
		});
		if (valid && !winner) winner = s; // first valid wins; keep judging for the record
	}
	return { winner, judged };
}

/** Resolve an open bounty: judge submissions in arrival order, pay the first
 * valid one through the dispute path; no valid submission → funds return to
 * the buyer the same way. Every judgment lands in the receipt. */
export async function resolveOpenBounty(o: {
	descriptor: BountyDescriptor;
	resolver: Keypair;
	contractId: string;
	submissions: OpenSubmission[];
	/** a party with standing (the buyer) to raise the dispute that unlocks
	 * distribution-based settlement. Optional when the escrow is ALREADY
	 * disputed (CLI flows: the buyer runs `bounty dispute` in its own call —
	 * the resolver cannot raise a dispute on its own escrow, contract #40). */
	disputeRaiser?: Keypair;
}): Promise<{
	winner: string | null;
	txs: string[];
	receiptId: string;
}> {
	if (o.resolver.publicKey() !== o.descriptor.resolver)
		throw new Error("resolving key is not the descriptor's resolver");
	const policy = verificationEvidencePolicy(o.descriptor);
	const { winner, judged } = pickWinner(o.contractId, o.submissions, policy);

	const txs: string[] = [];
	let disputeReceiptId: string | undefined;
	const state = await readEscrowAs(o.contractId, o.resolver);
	if (state.released) throw new Error("bounty already settled");
	if (!state.disputed) {
		if (!o.disputeRaiser)
			throw new Error(
				"escrow is not disputed and no disputeRaiser given — the buyer must run the dispute first (the resolver cannot dispute its own escrow)",
			);
		const d = await disputeJob({
			signer: o.disputeRaiser,
			contractId: o.contractId,
		});
		txs.push(d.tx);
		disputeReceiptId = d.receiptId;
	}
	const payee = winner?.worker ?? o.descriptor.buyer;
	const rd = await resolveDisputeJob({
		disputeResolver: o.resolver,
		contractId: o.contractId,
		twFeeAddress: o.descriptor.buyer,
		distributions: [[payee, BigInt(o.descriptor.amount)]],
		prevReceiptId: disputeReceiptId,
	});
	txs.push(rd.tx);

	const receiptId = record({
		kind: "job-resolved",
		network: "stellar:testnet",
		payer: o.resolver.publicKey(),
		payee,
		amount: o.descriptor.amount,
		detail: {
			contractId: o.contractId,
			mode: "open-claim",
			policy: "evidence-schema:verification-v1",
			submissions: judged,
			winner: winner?.worker ?? null,
			outcome: winner ? "paid-winner" : "returned-to-buyer",
			txs,
		},
	});
	return { winner: winner?.worker ?? null, txs, receiptId };
}
