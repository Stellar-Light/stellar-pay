/**
 * Jobs — escrow-backed work agreements (the flagship work layer; see
 * docs/SPINE.md).
 *
 * This module owns the JOB semantics: the agreement document (terms a
 * resolver can read), the lifecycle (open → fund → deliver → approve →
 * release / dispute → resolve), and the receipt chain that makes a job's
 * history auditable. The raw on-chain escrow mechanics live behind the
 * EscrowRails seam (rails.ts) — Trustless Work's contract today
 * (rails-trustless-work.ts, direct + keyless: their wasm, our deploy, our
 * keys, no API key, no TW server in the loop). If MPP or SDF ships a native
 * escrow primitive, adopting it is a new rails file + setRails(), never a
 * rewrite here.
 *
 * TW FEE HONESTY (rails-specific, surfaced here because callers pass it):
 * release/resolve send TW's 0.3% to a caller-supplied address the contract
 * does not validate. Their API injects theirs; direct callers must too
 * (TW_FEE_ADDRESS). The e2e uses a declared placeholder on testnet play
 * money; real usage must set TW's published fee address.
 */
import { createHash } from "node:crypto";
import type { Keypair } from "@stellar/stellar-sdk";
import {
	type AgreementInput,
	agreementHash,
	buildAgreement,
} from "./agreement.js";
import type { EscrowParams, EscrowRails, EscrowState } from "./rails.js";
import { trustlessWorkRails } from "./rails-trustless-work.js";
import { record } from "./receipts.js";

/** Kept for compat: the TW wasm hash previously exported from this module. */
export { TW_ESCROW_WASM_HASH } from "./rails-trustless-work.js";

// ── The rails seam ──────────────────────────────────────────────────────────
let rails: EscrowRails = trustlessWorkRails;
/** Swap the escrow provider (tests, future MPP-native/Alkahest adapters). */
export function setRails(r: EscrowRails): void {
	rails = r;
}
export function getRails(): EscrowRails {
	return rails;
}

export type JobSpec = {
	/** pays and (when no resolver is set) approves + releases — the buyer */
	buyer: Keypair;
	/** does the work, receives the payout (public key) */
	provider: string;
	/** arbitrates disputes; defaults to buyer — DECLARED in the receipt */
	judge?: string;
	/** the AUTOMATED resolver (G…): when set, it holds approver +
	 * release_signer + dispute_resolver, so a neutral third agent decides the
	 * outcome from terms + evidence (see resolver.ts). Unset = buyer decides. */
	resolver?: string;
	/** SEP-41 token contract (SAC) the job pays in */
	tokenContract: string;
	/** amount in the token's base units (i128) */
	amount: bigint;
	title: string;
	/** the terms prose (becomes the agreement's `## Terms` section) */
	spec: string;
	/** TW's 0.3% fee recipient — see the header note */
	twFeeAddress: string;
	/** Agreement fields (all optional; defaults make a valid doc): the bounded
	 * review question, the evidence classes the resolver may inspect, the
	 * answer=>outcome effects, an ISO-8601 deadline, the resolver policy
	 * label. Defaults describe the buyer-as-approver case. */
	reviewQuestion?: string;
	allowedEvidence?: string[];
	resolutionEffects?: Array<[string, string]>;
	deadline?: string;
	resolverPolicy?: string;
};

/** Build the agreement doc for a job + its sha256 hash. Deterministic: the
 * same JobSpec always yields the same bytes and hash, which is what lets
 * fund re-derive the exact struct open initialized (the rails re-validate
 * it — anti-TOCTOU). */
export function jobAgreement(o: JobSpec): { doc: string; hash: string } {
	const input: AgreementInput = {
		network: "stellar:testnet",
		buyer: o.buyer.publicKey(),
		provider: o.provider,
		resolver: o.resolver ?? o.judge ?? o.buyer.publicKey(),
		resolverPolicy:
			o.resolverPolicy ??
			(o.resolver
				? "automated-resolver"
				: o.judge
					? "third-party-resolver"
					: "buyer-approves"),
		title: o.title,
		terms: o.spec,
		reviewQuestion:
			o.reviewQuestion ??
			"Did the provider deliver the work described in Terms?",
		allowedEvidence: o.allowedEvidence ?? [
			"the submission hash recorded on the milestone",
			"artifacts the provider links in the submission",
		],
		resolutionEffects: o.resolutionEffects ?? [
			["yes", "release"],
			["no", "refund"],
		],
		deadline: o.deadline ?? "2100-01-01T00:00:00Z",
		tokenContract: o.tokenContract,
		amount: o.amount,
	};
	const doc = buildAgreement(input);
	return { doc, hash: agreementHash(doc) };
}

function escrowParams(
	o: JobSpec,
): Omit<EscrowParams, "engagementId" | "description"> {
	return {
		signer: o.buyer,
		buyer: o.buyer.publicKey(),
		provider: o.provider,
		resolver: o.resolver,
		judge: o.judge,
		tokenContract: o.tokenContract,
		amount: o.amount,
		title: o.title,
	};
}

export async function openJob(o: JobSpec): Promise<{
	contractId: string;
	engagementId: string;
	receiptId: string;
	deployTx: string;
	initTx: string;
	agreementDoc: string;
	termsHash: string;
}> {
	// The agreement IS the terms; its sha256 is the engagement_id. The raw
	// spec's sha256 rides the receipt too, for our own provenance chain.
	const specHash = createHash("sha256").update(o.spec).digest("hex");
	const { doc: agreementDoc, hash: termsHash } = jobAgreement(o);
	const engagementId = termsHash;

	const { contractId, deployTx, initTx } = await rails.deployAndInit({
		...escrowParams(o),
		engagementId,
		description: agreementDoc,
	});

	const receiptId = record({
		kind: "job-open",
		network: "stellar:testnet",
		amount: o.amount.toString(),
		asset: o.tokenContract,
		payer: o.buyer.publicKey(),
		payee: o.provider,
		tx: initTx,
		detail: {
			contractId,
			engagementId,
			format: "stellar-pay/agreement-v1",
			termsHash,
			specSha256: specHash,
			resolver: o.resolver ?? o.judge ?? o.buyer.publicKey(),
			resolverPolicy:
				o.resolverPolicy ??
				(o.resolver
					? "automated-resolver"
					: o.judge
						? "third-party-resolver"
						: "buyer-approves"),
			deployTx,
			rails: rails.name,
			title: o.title,
		},
	});
	return {
		contractId,
		engagementId,
		receiptId,
		deployTx,
		initTx,
		agreementDoc,
		termsHash,
	};
}

export async function fundJob(
	o: JobSpec & {
		contractId: string;
		engagementId: string;
		openReceiptId: string;
	},
): Promise<{ tx: string; receiptId: string }> {
	// The rails re-validate the EXPECTED escrow struct on fund, so this must
	// re-derive byte-identical terms — same doc, same engagement_id.
	const { doc } = jobAgreement(o);
	const { tx } = await rails.fund({
		...escrowParams(o),
		engagementId: o.engagementId,
		description: doc,
		contractId: o.contractId,
	});
	const receiptId = record({
		kind: "job-fund",
		network: "stellar:testnet",
		amount: o.amount.toString(),
		asset: o.tokenContract,
		payer: o.buyer.publicKey(),
		tx,
		refs: [o.openReceiptId],
		detail: { contractId: o.contractId, rails: rails.name },
	});
	return { tx, receiptId };
}

export async function deliverJob(o: {
	provider: Keypair;
	contractId: string;
	evidence: string;
	prevReceiptId: string;
}): Promise<{ tx: string; receiptId: string }> {
	const { tx } = await rails.setMilestoneStatus({
		contractId: o.contractId,
		index: 0,
		status: "completed",
		evidence: o.evidence,
		provider: o.provider,
	});
	const receiptId = record({
		kind: "job-deliver",
		network: "stellar:testnet",
		payer: o.provider.publicKey(),
		tx,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId, evidence: o.evidence },
	});
	return { tx, receiptId };
}

export async function approveJob(o: {
	approver: Keypair;
	contractId: string;
	prevReceiptId: string;
}): Promise<{ tx: string; receiptId: string }> {
	const { tx } = await rails.approveMilestone({
		contractId: o.contractId,
		index: 0,
		approver: o.approver,
	});
	const receiptId = record({
		kind: "job-approve",
		network: "stellar:testnet",
		payer: o.approver.publicKey(),
		tx,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId },
	});
	return { tx, receiptId };
}

export async function releaseJob(o: {
	releaseSigner: Keypair;
	contractId: string;
	twFeeAddress: string;
	prevReceiptId: string;
}): Promise<{ tx: string; receiptId: string }> {
	const { tx } = await rails.releaseFunds({
		contractId: o.contractId,
		releaseSigner: o.releaseSigner,
		feeAddress: o.twFeeAddress,
	});
	const receiptId = record({
		kind: "job-release",
		network: "stellar:testnet",
		payer: o.releaseSigner.publicKey(),
		tx,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId, twFeeAddress: o.twFeeAddress },
	});
	return { tx, receiptId };
}

export async function disputeJob(o: {
	signer: Keypair;
	contractId: string;
	prevReceiptId?: string;
}): Promise<{ tx: string; receiptId: string }> {
	const { tx } = await rails.dispute({
		contractId: o.contractId,
		signer: o.signer,
	});
	const receiptId = record({
		kind: "job-dispute",
		network: "stellar:testnet",
		payer: o.signer.publicKey(),
		tx,
		refs: o.prevReceiptId ? [o.prevReceiptId] : undefined,
		detail: { contractId: o.contractId },
	});
	return { tx, receiptId };
}

export async function resolveDisputeJob(o: {
	disputeResolver: Keypair;
	contractId: string;
	twFeeAddress: string;
	distributions: Array<[string, bigint]>;
	prevReceiptId?: string;
}): Promise<{ tx: string; receiptId: string }> {
	const { tx } = await rails.resolveDispute({
		contractId: o.contractId,
		disputeResolver: o.disputeResolver,
		feeAddress: o.twFeeAddress,
		distributions: o.distributions,
	});
	const receiptId = record({
		kind: "job-resolve-dispute",
		network: "stellar:testnet",
		payer: o.disputeResolver.publicKey(),
		tx,
		refs: o.prevReceiptId ? [o.prevReceiptId] : undefined,
		detail: {
			contractId: o.contractId,
			distributions: o.distributions.map(([a, v]) => [a, v.toString()]),
		},
	});
	return { tx, receiptId };
}

/** Read the escrow using an explicit funded source key (the usual path —
 * the resolver already holds one). */
export async function readEscrowAs(
	contractId: string,
	source: Keypair,
): Promise<EscrowState> {
	return rails.readEscrow({ contractId, source });
}

/** Env-configured read: STELLAR_ESCROW_READER_SECRET names a funded key. */
export async function readEscrow(contractId: string): Promise<EscrowState> {
	const readerSecret = process.env.STELLAR_ESCROW_READER_SECRET;
	if (!readerSecret)
		throw new Error(
			"readEscrow needs a funded source: set STELLAR_ESCROW_READER_SECRET or use readEscrowAs(contractId, keypair)",
		);
	const { Keypair: KP } = await import("@stellar/stellar-sdk");
	return rails.readEscrow({
		contractId,
		source: KP.fromSecret(readerSecret),
	});
}
