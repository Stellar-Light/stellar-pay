/**
 * AutoContracts v1 agreement documents for stellar-pay jobs.
 *
 * AutoContracts (autocontracts.org/llms.txt, auto.contracts/v1) is the
 * terms-and-judgment STANDARD that sits above escrow rails: a markdown
 * agreement with YAML frontmatter, one bounded review question, allowed
 * evidence, and answer=>outcome effects, resolved by a third-party resolver
 * agent. Trustless Work is the RAILS (roles, milestones, fund/release);
 * this file makes a job's terms speak AutoContracts, so any conforming
 * resolver can evaluate a Stellar job unchanged.
 *
 * The integration point is the hash. TW pins engagement_id (our spec hash)
 * on-chain; AutoContracts pins termsHash = keccak256(document_bytes). We
 * build the document HERE, take its keccak256, and that becomes the job's
 * terms hash — so the on-chain escrow and the off-chain agreement are the
 * same object, addressable by either ecosystem's convention.
 *
 * Hash rules are theirs, exactly: LF line endings, a single trailing
 * newline, no BOM. Deviating breaks cross-verification, so canonicalize.
 */
import { keccak256, toBytes } from "viem";

export type AgreementInput = {
	/** stellar:testnet | stellar:pubnet — recorded as chain_id 0 (Stellar is
	 * not an EVM chain; the CAIP-2 id rides contract_type instead, and the
	 * network is named in Terms). AutoContracts' chain_id is EVM-shaped; we
	 * declare 0 and carry the real network in `network` + the body. */
	network: string;
	/** buyer / approver / release-signer address (G…) */
	buyer: string;
	/** service provider / receiver address (G…) */
	provider: string;
	/** resolver = TW dispute_resolver address (G…) */
	resolver: string;
	/** human-readable resolver policy label */
	resolverPolicy: string;
	title: string;
	/** the obligations prose */
	terms: string;
	/** exactly one bounded question for the resolver */
	reviewQuestion: string;
	/** evidence classes the resolver may inspect */
	allowedEvidence: string[];
	/** answer => outcome pairs, e.g. [["yes","release"],["no","refund"]] */
	resolutionEffects: Array<[string, string]>;
	/** ISO 8601 deadline */
	deadline: string;
	/** token contract + amount, surfaced in Terms for the resolver */
	tokenContract: string;
	amount: bigint;
};

/** Canonicalize to AutoContracts' hash rules: LF endings, exactly one
 * trailing newline, no BOM. Applied to the whole document before hashing
 * AND before emit, so what we hash is byte-for-byte what we hand out. */
function canonicalize(doc: string): string {
	return `${doc.replace(/\r\n/g, "\n").replace(/﻿/g, "").replace(/\n+$/, "")}\n`;
}

/** Build the AutoContracts v1 agreement document (frontmatter + required
 * sections, in the required order). */
export function buildAgreement(a: AgreementInput): string {
	const parties = [
		`  - address: "${a.buyer}"\n    role: buyer`,
		`  - address: "${a.provider}"\n    role: provider`,
	].join("\n");
	const evidence = a.allowedEvidence.map((e) => `- ${e}`).join("\n");
	const effects = a.resolutionEffects
		.map(([ans, out]) => `- ${ans} => ${out}`)
		.join("\n");
	const doc = `---
standard: auto.contracts/v1
version: 1
chain_id: 0
contract_type: stellar-trustless-work-single-release
network: ${a.network}
parties:
${parties}
resolver: "${a.resolver}"
resolver_policy: ${a.resolverPolicy}
deadline: "${a.deadline}"
---

# Agreement

${a.title}

## Terms

${a.terms}

Settlement rails: Trustless Work single-release escrow on ${a.network}. Payment: ${a.amount.toString()} base units of token ${a.tokenContract}, released to the provider on an approving resolution, refunded to the buyer otherwise. Platform fee: 0. Trustless Work protocol fee: 0.3%.

## Review Question

${a.reviewQuestion}

## Allowed Evidence

${evidence}

## Resolution Effects

${effects}
`;
	return canonicalize(doc);
}

/** termsHash = keccak256(document_bytes), AutoContracts' convention — 0x-hex.
 * This is the cross-ecosystem address of the agreement. */
export function agreementHash(doc: string): string {
	return keccak256(toBytes(doc));
}
