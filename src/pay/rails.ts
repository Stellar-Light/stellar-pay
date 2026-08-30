/**
 * EscrowRails — the swappable escrow-provider seam.
 *
 * The moat is above the rails (agreements, the resolver, receipts,
 * reputation); the rails themselves — deploy an escrow, fund it, mark a
 * milestone, approve, release, dispute, resolve — are a commodity we RENT.
 * Today that's Trustless Work's Soroban contract (rails-trustless-work.ts).
 * If MPP or SDF ships a native escrow primitive, or Alkahest lands on
 * Stellar, adopting it is a NEW FILE implementing this interface plus one
 * setRails() call — never a rewrite of job.ts, the resolver, or the ledger.
 *
 * Rails do the raw on-chain ops and return transaction hashes / state. They
 * record NO receipts and know nothing of agreements — job.ts owns that.
 */
import type { Keypair } from "@stellar/stellar-sdk";

/** Normalized escrow identity — every rails impl serializes this however its
 * contract needs. `buyer`/`provider`/`resolver` are G-addresses; `signer` is
 * the keypair that authorizes open/fund. */
export type EscrowParams = {
	signer: Keypair;
	buyer: string;
	provider: string;
	/** when set, holds the decision roles (approver + release + resolver) */
	resolver?: string;
	/** dispute_resolver fallback when no automated resolver is set */
	judge?: string;
	tokenContract: string;
	amount: bigint;
	title: string;
	/** cross-ecosystem terms address (sha256 of the agreement doc) */
	engagementId: string;
	/** the full agreement document — a resolver reads this */
	description: string;
};

/** What a resolver — or a stranger vetting a listing — reads off an escrow.
 * `amount` is the TERMS amount (set at init); `balance` is what the escrow
 * actually HOLDS — "funded" means balance, never amount. */
export type EscrowState = {
	description: string;
	evidence: string;
	milestoneStatus: string;
	approved: boolean;
	released: boolean;
	disputed: boolean;
	amount: bigint;
	balance: bigint;
	buyer: string;
	provider: string;
	resolver: string;
	/** who may approve the milestone, and who may sign the release. A vetting
	 * stranger MUST see these: an escrow can name a neutral dispute_resolver
	 * while the BUYER quietly holds approve + release, which lets the buyer
	 * take the work and pay itself. Not visible in the roles the agreement
	 * renders, so it has to come off the struct. */
	approver: string;
	releaseSigner: string;
	tokenContract: string;
	/** the terms address: sha256 of the agreement doc, pinned at init */
	engagementId: string;
};

export interface EscrowRails {
	readonly name: string;
	deployAndInit(
		p: EscrowParams,
	): Promise<{ contractId: string; deployTx: string; initTx: string }>;
	fund(p: EscrowParams & { contractId: string }): Promise<{ tx: string }>;
	setMilestoneStatus(o: {
		contractId: string;
		index: number;
		status: string;
		evidence: string;
		provider: Keypair;
	}): Promise<{ tx: string }>;
	approveMilestone(o: {
		contractId: string;
		index: number;
		approver: Keypair;
	}): Promise<{ tx: string }>;
	releaseFunds(o: {
		contractId: string;
		releaseSigner: Keypair;
		feeAddress: string;
	}): Promise<{ tx: string }>;
	dispute(o: { contractId: string; signer: Keypair }): Promise<{ tx: string }>;
	resolveDispute(o: {
		contractId: string;
		disputeResolver: Keypair;
		feeAddress: string;
		distributions: Array<[string, bigint]>;
	}): Promise<{ tx: string }>;
	readEscrow(o: { contractId: string; source: Keypair }): Promise<EscrowState>;
}
