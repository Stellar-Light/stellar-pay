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
import { parseAgreement } from "./agreement.js";
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

/** Deterministic: yes iff the evidence carries the expected deliverable hash. */
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
	if (esc.released || esc.disputed)
		throw new Error(
			`escrow ${o.contractId} already settled (released=${esc.released} disputed=${esc.disputed})`,
		);
	const { reviewQuestion, resolutionEffects } = parseAgreement(esc.description);

	const answer = await o.policy({
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
			policy: o.policyLabel,
			evidence: esc.evidence,
			txs,
		},
	});
	return { answer, outcome, txs, receiptId };
}
