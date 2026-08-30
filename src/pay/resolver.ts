/**
 * The automated resolver — the "auto service" that fills TW's empty
 * dispute_resolver role.
 *
 * Trustless Work gives an escrow a resolver ROLE but no resolver SERVICE:
 * some party still has to read the terms, judge the work, and call approve/
 * release or dispute/resolve. This is that party, as an agent. A job opened
 * with `resolver` set (job.ts) puts this agent in the approver +
 * release_signer + dispute_resolver seats; here it:
 *
 *   1. reads the on-chain escrow — the agreement doc (description) and the
 *      provider's submitted evidence (milestone[0]);
 *   2. parses the agreement's Review Question + Resolution Effects;
 *   3. answers the question via a POLICY (below);
 *   4. maps the answer through the effects to an outcome, and executes it:
 *      release  → approve_milestone + release_funds  (funds to provider)
 *      refund   → dispute_escrow + resolve_dispute    (funds to buyer);
 *   5. records a job-resolved receipt with the answer, the policy, and the
 *      evidence it saw — an auditable judgment, not a black box.
 *
 * POLICIES, honest about their strength (the tiering from the research):
 *   - hashMatchPolicy: deterministic. Answers yes iff the evidence contains
 *     the expected deliverable hash named in the terms. The only tier that
 *     is objectively verifiable; use it whenever the deliverable has a hash.
 *   - callbackPolicy: delegates to a caller-supplied judge (an LLM agent, a
 *     human, an external check). Honest about being only as good as the
 *     judge. The default for subjective work — but the resolver records
 *     WHICH policy ran, so the judgment's basis is never hidden.
 */
import type { Keypair } from "@stellar/stellar-sdk";
import { agreementHash, parseAgreement } from "./agreement.js";
import {
	approveJob,
	disputeJob,
	readEscrowAs,
	releaseJob,
	resolveDisputeJob,
} from "./job.js";
import { record } from "./receipts.js";

export type ResolverContext = {
	reviewQuestion: string;
	evidence: string;
	description: string;
	amount: bigint;
};
/** Answers the review question: "yes" (approve) or "no" (refund). */
export type ResolverPolicy = (
	ctx: ResolverContext,
) => "yes" | "no" | Promise<"yes" | "no">;

/** Deterministic: yes iff the evidence carries the expected deliverable hash.
 *
 * SOUNDNESS CONDITION (be honest about what this proves): it proves the
 * worker KNOWS the hash, not that they HAVE the deliverable. It is only
 * meaningful when the expected hash is NOT derivable from the public
 * agreement (e.g. the buyer computes it over a deliverable that travels out
 * of band, and hands it to the resolver privately). If the hash is printed
 * in the terms, any worker can echo it — use verificationEvidencePolicy or
 * a callbackPolicy that re-hashes the actual artifact instead. */
export function hashMatchPolicy(expectedHash: string): ResolverPolicy {
	return ({ evidence }) =>
		evidence.toLowerCase().includes(expectedHash.toLowerCase()) ? "yes" : "no";
}

/** Delegate to a caller-supplied judge (LLM agent / human / external check). */
export function callbackPolicy(
	judge: (ctx: ResolverContext) => "yes" | "no" | Promise<"yes" | "no">,
): ResolverPolicy {
	return judge;
}

/**
 * Run the resolver against one escrow. The resolver keypair must hold the
 * decision roles (open the job with `resolver: <its pubkey>`).
 */
export async function resolveJob(o: {
	resolver: Keypair;
	contractId: string;
	twFeeAddress: string;
	policy: ResolverPolicy;
	policyLabel: string;
	/** buyer address to refund on a "no" — read from the escrow if omitted */
	buyerAddress?: string;
	/** a party with standing (buyer/provider) to RAISE the dispute on a "no":
	 * the contract forbids the dispute_resolver from disputing its own escrow
	 * (sound — the adjudicator cannot also be the contester), so a refund needs
	 * a non-resolver party to set the disputed flag first. Omit only if the
	 * escrow is already disputed. */
	disputeRaiser?: Keypair;
	prevReceiptId?: string;
}): Promise<{
	answer: "yes" | "no";
	outcome: string;
	txs: string[];
	receiptId: string;
}> {
	const esc = await readEscrowAs(o.contractId, o.resolver);
	// RELEASED is terminal; DISPUTED is not — a disputed escrow is exactly the
	// state the refund path needs (the buyer raises the dispute, the resolver
	// resolves it). Throwing on `disputed` deadlocked our own documented flow:
	// `bounty dispute` then `bounty resolve` could never complete.
	// A drained escrow is settled even when the flags say otherwise: after a
	// dispute-refund, testnet reports released=false disputed=false balance=0.
	// Without the balance test a second call re-disputes an empty escrow and
	// fails deep in the contract with an opaque error instead of saying so.
	if (esc.released || esc.balance === 0n)
		throw new Error(
			`escrow ${o.contractId} is already settled (released=${esc.released}, balance=${esc.balance})`,
		);

	// The description is what the policy reads and what decides the money, so
	// bind it to what the chain pinned before trusting a byte of it.
	if (agreementHash(esc.description) !== esc.engagementId)
		throw new Error(
			`escrow ${o.contractId}: the on-chain agreement does not hash to its engagement_id — refusing to resolve terms the chain did not pin`,
		);
	const { reviewQuestion, resolutionEffects, deadline } = parseAgreement(
		esc.description,
	);

	// A deadline nobody enforces is decoration. Past it with no evidence, the
	// job is over: refund, so a vanished worker cannot freeze the buyer's funds
	// (and a vanished BUYER cannot freeze a worker's payout, since the answer
	// no longer waits on anyone showing up).
	const expired = deadline != null && Date.parse(deadline) < Date.now();
	const answer =
		expired && esc.evidence.trim() === ""
			? "no"
			: await o.policy({
					reviewQuestion,
					evidence: esc.evidence,
					description: esc.description,
					amount: esc.amount,
				});
	const outcome =
		resolutionEffects.find(([ans]) => ans === answer)?.[1] ??
		(answer === "yes" ? "release" : "refund");

	const txs: string[] = [];
	if (outcome === "release") {
		const a = await approveJob({
			approver: o.resolver,
			contractId: o.contractId,
			prevReceiptId: o.prevReceiptId ?? "",
		});
		txs.push(a.tx);
		const r = await releaseJob({
			releaseSigner: o.resolver,
			contractId: o.contractId,
			twFeeAddress: o.twFeeAddress,
			prevReceiptId: a.receiptId,
		});
		txs.push(r.tx);
	} else {
		// refund: a party with standing raises the dispute (the resolver may
		// NOT — contract error #40), then the resolver resolves it to the buyer.
		let disputeReceiptId = o.prevReceiptId;
		if (!esc.disputed) {
			if (!o.disputeRaiser)
				throw new Error(
					"refund needs the disputed flag set, but the resolver cannot dispute its own escrow — pass disputeRaiser (buyer/provider) or dispute first",
				);
			const d = await disputeJob({
				signer: o.disputeRaiser,
				contractId: o.contractId,
				prevReceiptId: o.prevReceiptId,
			});
			txs.push(d.tx);
			disputeReceiptId = d.receiptId;
		}
		const buyer = o.buyerAddress ?? esc.buyer;
		const rd = await resolveDisputeJob({
			disputeResolver: o.resolver,
			contractId: o.contractId,
			twFeeAddress: o.twFeeAddress,
			distributions: [[buyer, esc.amount]],
			prevReceiptId: disputeReceiptId,
		});
		txs.push(rd.tx);
	}

	const receiptId = record({
		kind: "job-resolved",
		network: "stellar:testnet",
		payer: o.resolver.publicKey(),
		detail: {
			contractId: o.contractId,
			reviewQuestion,
			answer,
			outcome,
			policy:
				expired && esc.evidence.trim() === ""
					? "deadline-expired"
					: o.policyLabel,
			deadline,
			evidence: esc.evidence,
			txs,
		},
	});
	return { answer, outcome, txs, receiptId };
}
