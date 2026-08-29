/**
 * Jobs — escrow-backed work agreements on Trustless Work (testnet).
 *
 * The research corpus's core thesis, made runnable: one party hires another
 * it doesn't trust; funds sit in a Soroban escrow neither controls; release
 * happens on approval; a judge exists for the contested case. We author no
 * contract — Trustless Work's escrow is the rail (reuse-don't-build), their
 * REST API builds each transaction, OUR keystore signs it, their helper
 * submits it. Full lifecycle:
 *
 *   open    deploy + configure the escrow (roles, amount, spec) — the spec
 *           text rides `description`, its sha256 rides `engagementId`, so
 *           the agreement's terms are hash-pinned on-chain from birth
 *   fund    move the amount into the escrow
 *   deliver service provider marks the milestone done, evidence attached
 *   approve approver signs off
 *   release release signer pays out (minus TW's 0.3% protocol fee)
 *   dispute either side escalates to the dispute resolver
 *
 * Every step lands a receipt ref-chained to the job-open row — the
 * attribution chain IS the job's history.
 *
 * TESTNET (dev API). Auth: x-api-key from TW_API_KEY — requesting a key is
 * an account action the OWNER does once at trustlesswork.com; nothing here
 * creates accounts.
 */
import { createHash } from "node:crypto";
import {
	type Keypair,
	Networks,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import { record } from "./receipts.js";

const BASE = process.env.TW_API_BASE ?? "https://dev.api.trustlesswork.com";
/** Trustless Work's testnet USDC (their documented default asset). */
export const TW_TESTNET_USDC_ISSUER =
	"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function apiKey(): string {
	const k = process.env.TW_API_KEY;
	if (!k)
		throw new Error(
			"TW_API_KEY is not set. Request one at https://dapp.trustlesswork.com (a one-time account step), then export TW_API_KEY.",
		);
	return k;
}

async function tw<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey(),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`TW ${path} → ${res.status}: ${text.slice(0, 200)}`);
	}
	if (!res.ok)
		throw new Error(
			`TW ${path} → ${res.status}: ${(json.message as string) ?? text.slice(0, 200)}`,
		);
	return json as T;
}

/** Every mutating endpoint returns an unsigned XDR; we sign with OUR key and
 * their helper broadcasts. The signature never leaves this process. */
async function signAndSend(
	unsignedXdr: string,
	signer: Keypair,
): Promise<{ txHash: string | null; raw: Record<string, unknown> }> {
	const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
	tx.sign(signer);
	const raw = await tw<Record<string, unknown>>("/helper/send-transaction", {
		signedXdr: tx.toXDR(),
	});
	const txHash =
		(raw.txHash as string) ??
		((raw.data as Record<string, unknown>)?.txHash as string) ??
		null;
	return { txHash, raw };
}

function unsignedFrom(r: Record<string, unknown>): string {
	const x =
		(r.unsignedTransaction as string) ??
		(r.xdr as string) ??
		((r.data as Record<string, unknown>)?.unsignedTransaction as string);
	if (!x)
		throw new Error(
			`TW response carried no unsigned XDR: ${JSON.stringify(r).slice(0, 200)}`,
		);
	return x;
}

export type JobRoles = {
	/** pays, approves, and can release — the buyer */
	buyer: Keypair;
	/** does the work, receives the payout */
	provider: string;
	/** arbitrates the contested case; defaults to the buyer (declared, not hidden) */
	judge?: string;
};

export async function openJob(o: {
	roles: JobRoles;
	amountUsdc: number;
	title: string;
	/** the terms; sha256(spec) becomes the engagementId — hash-pinned from birth */
	spec: string;
}): Promise<{ contractId: string; engagementId: string; receiptId: string }> {
	const buyerPub = o.roles.buyer.publicKey();
	const specHash = createHash("sha256").update(o.spec).digest("hex");
	const engagementId = `job-${specHash.slice(0, 16)}`;
	const r = await tw<Record<string, unknown>>("/deployer/single-release", {
		signer: buyerPub,
		engagementId,
		title: o.title,
		description: o.spec,
		roles: {
			approver: buyerPub,
			serviceProvider: o.roles.provider,
			platformAddress: buyerPub,
			releaseSigner: buyerPub,
			disputeResolver: o.roles.judge ?? buyerPub,
			receiver: o.roles.provider,
		},
		amount: o.amountUsdc,
		platformFee: 0,
		milestones: [{ description: o.spec.slice(0, 500) }],
		trustline: {
			address: TW_TESTNET_USDC_ISSUER,
			decimals: 10_000_000,
		},
	});
	const { txHash, raw } = await signAndSend(unsignedFrom(r), o.roles.buyer);
	const contractId =
		(raw.contractId as string) ??
		((raw.data as Record<string, unknown>)?.contractId as string) ??
		(r.contractId as string) ??
		"";
	if (!contractId)
		throw new Error(
			`deploy sent but no contractId surfaced: ${JSON.stringify(raw).slice(0, 200)}`,
		);
	const receiptId = record({
		kind: "job-open",
		network: "stellar:testnet",
		amount: String(Math.round(o.amountUsdc * 10_000_000)),
		payer: buyerPub,
		payee: o.roles.provider,
		tx: txHash,
		detail: {
			contractId,
			engagementId,
			specSha256: specHash,
			judge: o.roles.judge ?? buyerPub,
			title: o.title,
		},
	});
	return { contractId, engagementId, receiptId };
}

export async function fundJob(o: {
	buyer: Keypair;
	contractId: string;
	amountUsdc: number;
	openReceiptId: string;
}): Promise<{ txHash: string | null; receiptId: string }> {
	const r = await tw<Record<string, unknown>>(
		"/escrow/single-release/fund-escrow",
		{
			contractId: o.contractId,
			signer: o.buyer.publicKey(),
			amount: o.amountUsdc,
		},
	);
	const { txHash } = await signAndSend(unsignedFrom(r), o.buyer);
	const receiptId = record({
		kind: "job-fund",
		network: "stellar:testnet",
		amount: String(Math.round(o.amountUsdc * 10_000_000)),
		payer: o.buyer.publicKey(),
		tx: txHash,
		refs: [o.openReceiptId],
		detail: { contractId: o.contractId },
	});
	return { txHash, receiptId };
}

export async function deliverJob(o: {
	provider: Keypair;
	contractId: string;
	/** evidence — a URL or a sha256 of the deliverable; goes on-chain */
	evidence: string;
	prevReceiptId: string;
}): Promise<{ txHash: string | null; receiptId: string }> {
	const r = await tw<Record<string, unknown>>(
		"/escrow/single-release/change-milestone-status",
		{
			contractId: o.contractId,
			milestoneIndex: "0",
			newStatus: "completed",
			newEvidence: o.evidence,
			serviceProvider: o.provider.publicKey(),
		},
	);
	const { txHash } = await signAndSend(unsignedFrom(r), o.provider);
	const receiptId = record({
		kind: "job-deliver",
		network: "stellar:testnet",
		payer: o.provider.publicKey(),
		tx: txHash,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId, evidence: o.evidence },
	});
	return { txHash, receiptId };
}

export async function approveJob(o: {
	approver: Keypair;
	contractId: string;
	prevReceiptId: string;
}): Promise<{ txHash: string | null; receiptId: string }> {
	const r = await tw<Record<string, unknown>>(
		"/escrow/single-release/approve-milestone",
		{
			contractId: o.contractId,
			milestoneIndex: "0",
			approver: o.approver.publicKey(),
		},
	);
	const { txHash } = await signAndSend(unsignedFrom(r), o.approver);
	const receiptId = record({
		kind: "job-approve",
		network: "stellar:testnet",
		payer: o.approver.publicKey(),
		tx: txHash,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId },
	});
	return { txHash, receiptId };
}

export async function releaseJob(o: {
	releaseSigner: Keypair;
	contractId: string;
	prevReceiptId: string;
}): Promise<{ txHash: string | null; receiptId: string }> {
	const r = await tw<Record<string, unknown>>(
		"/escrow/single-release/release-funds",
		{
			contractId: o.contractId,
			releaseSigner: o.releaseSigner.publicKey(),
		},
	);
	const { txHash } = await signAndSend(unsignedFrom(r), o.releaseSigner);
	const receiptId = record({
		kind: "job-release",
		network: "stellar:testnet",
		payer: o.releaseSigner.publicKey(),
		tx: txHash,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId },
	});
	return { txHash, receiptId };
}

export async function jobStatus(contractId: string): Promise<unknown> {
	const res = await fetch(
		`${BASE}/helper/get-escrow-by-contract-ids?contractIds=${encodeURIComponent(contractId)}`,
		{ headers: { "x-api-key": apiKey() }, signal: AbortSignal.timeout(30_000) },
	);
	return res.json();
}
