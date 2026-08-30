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
 * Two shapes ship here. A DIRECTED bounty: the escrow needs its provider role
 * at init, so the flow is post (descriptor, off-chain) → assign (claimer
 * chosen — escrow opens + funds) → submit (evidence on-chain) → resolve
 * (schema policy judges). And an OPEN-CLAIM bounty (anyone races), which
 * needed the different escrow shape it now has: `postOpenBounty` escrows the
 * pot up front with the BUYER in the receiver role as the no-winner fallback,
 * workers race with signed `makeSubmission` packets, `pickWinner` judges them
 * by the same evidence contract, and `resolveOpenBounty` pays the first valid
 * one through the dispute path (no valid submission → back to the buyer).
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
	/** ISO 8601 with an explicit offset. After it, a bounty with no evidence
	 * resolves to refund — the only exit that does not need a counterparty to
	 * still be alive. Optional: absent means the agreement's far-future
	 * default, i.e. no expiry. */
	deadline?: string;
	/** the resolver that will judge (G…) — declared up front */
	resolver: string;
	/** the buyer who will fund (G…) */
	buyer: string;
	/** Open-claim only: where signed submission packets POST (optional — absent
	 * means the transport is out of band).
	 *
	 * This should be the RESOLVER's inbox, not the buyer's. Evidence is stealable
	 * by whoever receives it first (see submissionDigest), and the buyer is the
	 * one party that profits from stealing it — re-sign a worker's evidence under
	 * a sock puppet, "win" your own bounty, and get the work for the 0.3% fee.
	 * The resolver is already trusted to adjudicate, so routing evidence there
	 * adds no new trust assumption. */
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
	/** days from now until the bounty expires (converted to an absolute,
	 * offset-explicit instant so every party reads the same moment) */
	deadlineDays?: number;
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
		...(o.deadlineDays
			? {
					deadline: new Date(
						Date.now() + o.deadlineDays * 86_400_000,
					).toISOString(),
				}
			: {}),
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
		...(d.deadline ? { deadline: d.deadline } : {}),
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
// (ed25519 over sha256(contractId | WORKER | evidence) — the worker address is
// inside the signed bytes, so a stolen evidence document cannot be re-signed
// and claimed by anyone else), and the resolver settles through the DISPUTE
// path, whose
// `distributions` can pay any address: first valid submission wins the pot.
// Settlement note, corrected on testnet: the 0.3% protocol fee applies on
// the dispute path too — a winner receives pot − 0.3% (the earlier "no
// skim" read was a coincidence: in refund cases the fee address WAS the
// buyer, so fee + principal summed to the full pot at one address).
// The submission TRANSPORT (how packets reach the resolver — a board, HTTP,
// a repo) is deliberately out of scope here; v1 hands packets in directly.

import { createHash as _ch, randomBytes as _rb } from "node:crypto";
import { Keypair as _KP } from "@stellar/stellar-sdk";

// PRIOR ART, checked before minting this format (2026-08-30), because the
// cheap mistake here is inventing a private shape by reflex:
//   - ERC-8195 (Task Market Protocol) defines five procurement modes —
//     Bounty, Claim, Pitch, Benchmark, Auction — with deterministic task ids
//     and on-chain deliverable hashes. It has NO commit-reveal step, so there
//     is no container to adopt for this.
//   - Ricardian practice (autocontracts, ClawBank) covers the AGREEMENT, not
//     submission ordering.
//   - pay.sh has no work layer at all.
// So this stays ours, by absence rather than by preference. If TMP or anyone
// else specifies commit-reveal, this is a serialization change and nothing
// more: the digest already commits to (format, contract, worker, evidence,
// nonce), which is the union of what such a spec would need.
const COMMIT_FORMAT = "stellar-pay/commit-v1" as const;

/** A COMMIT: "I already have evidence whose hash is X" — published BEFORE the
 * evidence itself is shown to anyone.
 *
 * This is the real fix for evidence theft. A signature can only prove who
 * authored a packet; it cannot stop someone who SEES the evidence from
 * re-signing the same content as their own, because that packet is valid by
 * construction. Ordering by commit does: a thief who first learns the evidence
 * at reveal time cannot produce a commit that predates the author's, and the
 * commit binds the hash so they cannot commit to something they do not have. */
export type OpenCommit = {
	format: typeof COMMIT_FORMAT;
	bountyContract: string;
	worker: string;
	/** sha256(format | contract | worker | sha256(evidence) | nonce) */
	commitHash: string;
	committedAt: string;
	/** base64 ed25519 signature by `worker` over commitHash */
	signature: string;
};

function commitHashOf(
	contractId: string,
	worker: string,
	evidence: EvidenceEntry[],
	nonce: string,
): string {
	const ev = _ch("sha256").update(JSON.stringify(evidence)).digest("hex");
	return _ch("sha256")
		.update(`${COMMIT_FORMAT}|${contractId}|${worker}|${ev}|${nonce}`)
		.digest("hex");
}

/** Build a commit (and the nonce that opens it). Publish the COMMIT first;
 * keep the nonce and the evidence private until you reveal. */
export function makeCommit(o: {
	worker: Keypair;
	contractId: string;
	evidence: EvidenceEntry[];
	nonce?: string;
}): { commit: OpenCommit; nonce: string } {
	const nonce = o.nonce ?? _rb(32).toString("hex");
	const commitHash = commitHashOf(
		o.contractId,
		o.worker.publicKey(),
		o.evidence,
		nonce,
	);
	const sig = o.worker.sign(Buffer.from(commitHash, "hex"));
	return {
		nonce,
		commit: {
			format: COMMIT_FORMAT,
			bountyContract: o.contractId,
			worker: o.worker.publicKey(),
			commitHash,
			committedAt: new Date().toISOString(),
			signature: Buffer.from(sig).toString("base64"),
		},
	};
}

/** Does this commit verify, and is it for this bounty? */
function commitIsValid(contractId: string, c: OpenCommit): boolean {
	if (c?.format !== COMMIT_FORMAT || c.bountyContract !== contractId)
		return false;
	try {
		return _KP
			.fromPublicKey(c.worker)
			.verify(
				Buffer.from(c.commitHash, "hex"),
				Buffer.from(c.signature, "base64"),
			);
	} catch {
		return false;
	}
}

export type OpenSubmission = {
	/** wire-format marker. Two independent installs must agree on this packet,
	 * so it carries its version and the version is INSIDE the signed digest.
	 * Without it, a packet signed by an older build fails verification as
	 * "bad-signature" — indistinguishable from a forgery. */
	format: "stellar-pay/submission-v1";
	bountyContract: string;
	worker: string;
	evidence: EvidenceEntry[];
	signedAt: string;
	/** base64 ed25519 signature by `worker` over the digest below */
	signature: string;
	/** commit-reveal only: the nonce that opens this worker's commit */
	nonce?: string;
};

/** The signed digest: sha256(contractId | worker | canonical evidence JSON).
 *
 * The worker address is in the preimage so the signature is an AUTHORSHIP
 * statement ("I, W, submit this evidence for escrow C") rather than a floating
 * endorsement of some bytes. v1 signed only (contractId | evidence).
 *
 * BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT BUY. It stops signature REPLAY:
 * you cannot take my packet, swap in your address, and keep my signature. On
 * its own it does NOT stop evidence THEFT — anyone who sees my evidence can
 * re-sign the same content under their own key, and that packet is valid by
 * construction. No signature scheme fixes that in a single round.
 *
 * COMMIT-REVEAL (makeCommit + pickWinner's `commits`) is what fixes it, and it
 * is built: publish a hash first, reveal the evidence later, and the earliest
 * COMMITTER wins. A thief who first sees the evidence at reveal time has no
 * commit that predates the author's, so racing is pointless. Use it whenever
 * submissions pass through a party you do not control; without it the
 * fallbacks are sending evidence to the RESOLVER rather than the buyer (the
 * one party that profits from stealing it) and plain arrival order. */
// Maps to ERC-8195's claim/submission step by rename; the delta is that our
// evidence is a JSON document rather than a write-once `bytes32` deliverable
// hash — richer, and therefore not drop-in compatible. Keep the field names
// close enough that an exporter is mechanical.
const SUBMISSION_FORMAT = "stellar-pay/submission-v1" as const;

function submissionDigest(
	contractId: string,
	worker: string,
	evidence: EvidenceEntry[],
	nonce?: string,
): Buffer {
	// The nonce is appended only when present, so a plain (non-commit-reveal)
	// packet hashes exactly as before and stays verifiable.
	const base = `${SUBMISSION_FORMAT}|${contractId}|${worker}|${JSON.stringify(evidence)}`;
	return _ch("sha256")
		.update(nonce ? `${base}|${nonce}` : base)
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
	/** the nonce from makeCommit — turns this packet into a REVEAL */
	nonce?: string;
}): OpenSubmission {
	const sig = o.worker.sign(
		submissionDigest(o.contractId, o.worker.publicKey(), o.evidence, o.nonce),
	);
	return {
		format: SUBMISSION_FORMAT,
		bountyContract: o.contractId,
		worker: o.worker.publicKey(),
		evidence: o.evidence,
		signedAt: new Date().toISOString(),
		signature: Buffer.from(sig).toString("base64"),
		...(o.nonce ? { nonce: o.nonce } : {}),
	};
}

/** Pure selection: first submission whose signature verifies AND whose
 * evidence passes the policy. Exported for offline unit checks. */
export function pickWinner(
	contractId: string,
	submissions: OpenSubmission[],
	policy: ResolverPolicy,
	/** COMMIT-REVEAL: the commits the resolver received, in arrival order. When
	 * supplied, a submission must open one of them and the winner is the valid
	 * reveal whose COMMIT came first — so a thief who only sees the evidence at
	 * reveal time cannot win by submitting faster. Omit for the plain
	 * first-valid-wins race. */
	commits?: OpenCommit[],
): {
	winner: OpenSubmission | null;
	judged: Array<{ worker: string; valid: boolean; reason: string }>;
} {
	const judged: Array<{ worker: string; valid: boolean; reason: string }> = [];
	let winner: OpenSubmission | null = null;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const s of submissions) {
		if (s.format !== SUBMISSION_FORMAT) {
			// Say what is actually wrong. Reporting a version mismatch as
			// "bad-signature" tells a worker they cheated when they merely used a
			// different build.
			judged.push({
				worker: s.worker,
				valid: false,
				reason: `unsupported-format:${String(s.format ?? "none")}`,
			});
			continue;
		}
		if (s.bountyContract !== contractId) {
			judged.push({ worker: s.worker, valid: false, reason: "wrong-bounty" });
			continue;
		}
		let sigOk = false;
		try {
			sigOk = _KP
				.fromPublicKey(s.worker)
				.verify(
					submissionDigest(contractId, s.worker, s.evidence, s.nonce),
					Buffer.from(s.signature, "base64"),
				);
		} catch {
			sigOk = false;
		}
		if (!sigOk) {
			judged.push({ worker: s.worker, valid: false, reason: "bad-signature" });
			continue;
		}
		// COMMIT-REVEAL: the reveal must open a commit this worker made earlier.
		let commitRank: number | null = null;
		if (commits) {
			if (!s.nonce) {
				judged.push({ worker: s.worker, valid: false, reason: "no-nonce" });
				continue;
			}
			const want = commitHashOf(contractId, s.worker, s.evidence, s.nonce);
			const idx = commits.findIndex(
				(c) =>
					commitIsValid(contractId, c) &&
					c.worker === s.worker &&
					c.commitHash === want,
			);
			if (idx < 0) {
				// Either no commit exists for this exact evidence+worker, or the
				// nonce does not open it. A thief who re-signed someone else's
				// evidence lands here: they never committed to it.
				judged.push({
					worker: s.worker,
					valid: false,
					reason: "no-matching-commit",
				});
				continue;
			}
			commitRank = idx;
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
			reason: valid
				? commitRank != null
					? `valid (commit #${commitRank})`
					: "valid"
				: "evidence-rejected",
		});
		if (!valid) continue;
		if (commits) {
			// EARLIEST COMMIT wins, regardless of who revealed first.
			if (winner == null || (commitRank ?? 0) < bestRank) {
				winner = s;
				bestRank = commitRank ?? 0;
			}
		} else if (!winner) {
			winner = s; // plain race: first valid wins; keep judging for the record
		}
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
	/** commits in ARRIVAL ORDER; when given, the earliest committer wins */
	commits?: OpenCommit[];
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
	const { winner, judged } = pickWinner(
		o.contractId,
		o.submissions,
		policy,
		o.commits,
	);

	const txs: string[] = [];
	let disputeReceiptId: string | undefined;
	const state = await readEscrowAs(o.contractId, o.resolver);
	// Judge by the terms the CHAIN pinned, not by whatever descriptor was
	// handed to us: items and freshness come from this object and they decide
	// who gets paid. Same assertion resolveJob makes on the directed path.
	if (openBountyTerms(o.descriptor).hash !== state.engagementId)
		throw new Error(
			`descriptor does not match escrow ${o.contractId}: re-derived terms hash ${openBountyTerms(o.descriptor).hash} vs on-chain engagement_id ${state.engagementId}`,
		);
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

	// The chain takes the 0.3% protocol fee on the dispute path too, so the
	// winner is credited pot − fee. Receipting the full pot overstated income
	// in the exact ledger a reputation story will be read from.
	const pot = BigInt(o.descriptor.amount);
	const credited = pot - (pot * 30n) / 10_000n;
	const receiptId = record({
		kind: "job-resolved",
		network: "stellar:testnet",
		payer: o.resolver.publicKey(),
		payee,
		amount: credited.toString(),
		detail: {
			contractId: o.contractId,
			mode: o.commits ? "open-claim/commit-reveal" : "open-claim",
			policy: "evidence-schema:verification-v1",
			pot: o.descriptor.amount,
			protocolFeeBps: 30,
			submissions: judged,
			winner: winner?.worker ?? null,
			outcome: winner ? "paid-winner" : "returned-to-buyer",
			txs,
		},
	});
	return { winner: winner?.worker ?? null, txs, receiptId };
}
