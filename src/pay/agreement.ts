/**
 * Job agreements — a Stellar-native, resolver-readable terms document.
 *
 * Prior art, credited: AutoContracts (autocontracts.org) pairs an escrow with
 * a markdown agreement — a bounded review question, allowed evidence, and
 * answer=>outcome effects — resolved by a third-party resolver agent. That
 * STRUCTURE is good agreement design and we keep it. Their WIRE FORMAT is
 * EVM (keccak hashes, EVM chain_id, a Solidity interface) and does not touch
 * Stellar, so we do NOT emit it: no Stellar resolver would read an
 * auto.contracts/v1 document, and pinning an EVM keccak on a Soroban contract
 * was cargo-cult. This is our own format, hashed with sha256 like everything
 * else in stellar-pay and on Stellar.
 *
 * The document lives on-chain as the escrow's `description`; its sha256 is
 * the escrow's `engagement_id`. A resolver (human, or the automated resolver
 * in resolver.ts) reads the doc, inspects the allowed evidence, answers the
 * review question, and maps the answer through the resolution effects to
 * release or refund.
 *
 * Canonical bytes: LF line endings, exactly one trailing newline, no BOM —
 * plain hygiene so the hash is stable across whoever renders it.
 */
import { createHash } from "node:crypto";

export type AgreementInput = {
	/** stellar:testnet | stellar:pubnet */
	network: string;
	/** buyer / approver / release-signer address (G…) */
	buyer: string;
	/** service provider / receiver address (G…) */
	provider: string;
	/** the party that answers the review question (G…) — TW dispute_resolver
	 * (and, for the automated case, approver + release_signer) */
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

/** LF endings, exactly one trailing newline, no BOM — a stable hash preimage. */
function canonicalize(doc: string): string {
	return `${doc.replace(/\r\n/g, "\n").replace(/﻿/g, "").replace(/\n+$/, "")}\n`;
}

/** Neutralise section headings inside free-form prose a COUNTERPARTY wrote.
 *
 * The document is parsed by section heading and `parseAgreement` takes the
 * FIRST match, so terms prose containing its own "## Resolution Effects" block
 * silently overrode the real one — a buyer could write `yes => refund`, let a
 * worker complete the job, and have the automated resolver hand the pot back.
 *
 * Markdown-escaping the marker is only half the fix: it must be paired with
 * LINE-ANCHORED parsing in parseAgreement, because a `\## X` line still
 * contains the substring `## X` that an unanchored regex would happily find. */
function demoteHeadings(prose: string): string {
	return prose.replace(/^(#{1,6}\s)/gm, "\\$1");
}

/** Build the agreement document (frontmatter + the four resolver sections). */
export function buildAgreement(a: AgreementInput): string {
	const parties = [
		`  - address: "${a.buyer}"\n    role: buyer`,
		`  - address: "${a.provider}"\n    role: provider`,
	].join("\n");
	// EVERY free-text field a counterparty controls gets escaped, not just
	// `terms`. Escaping one field and interpolating four others is the same bug
	// with a smaller blast radius: title, the review question, each allowed-
	// evidence line and the policy label all land in the parsed document too.
	const evidence = a.allowedEvidence
		.map((e) => `- ${demoteHeadings(e)}`)
		.join("\n");
	const effects = a.resolutionEffects
		.map(([ans, out]) => `- ${ans} => ${out}`)
		.join("\n");
	const doc = `---
format: stellar-pay/agreement-v1
network: ${a.network}
contract_type: trustless-work-single-release
parties:
${parties}
resolver: "${a.resolver}"
resolver_policy: ${demoteHeadings(a.resolverPolicy)}
deadline: "${a.deadline}"
---

# Agreement

${demoteHeadings(a.title)}

## Terms

${demoteHeadings(a.terms)}

Settlement rails: Trustless Work single-release escrow on ${a.network}. Payment: ${a.amount.toString()} base units of token ${a.tokenContract}, released to the provider on an approving resolution, refunded to the buyer otherwise. Platform fee: 0. Trustless Work protocol fee: 0.3%.

## Review Question

${demoteHeadings(a.reviewQuestion)}

## Allowed Evidence

${evidence}

## Resolution Effects

${effects}
`;
	return canonicalize(doc);
}

/** termsHash = sha256(document_bytes), 0x-hex — the agreement's address,
 * Stellar-native (sha256 is what Soroban, SEP-10, and the rest of stellar-pay
 * already use). */
export function agreementHash(doc: string): string {
	return `0x${createHash("sha256").update(Buffer.from(doc, "utf8")).digest("hex")}`;
}

/** Parse the resolver-relevant fields back out of a document — what an
 * automated resolver reads off-chain from the escrow's description. */
export function parseAgreement(doc: string): {
	reviewQuestion: string;
	resolutionEffects: Array<[string, string]>;
	/** the frontmatter deadline (ISO 8601) — a resolver MUST be able to act on
	 * time passing, or a vanished counterparty freezes the escrow forever */
	deadline: string | null;
} {
	// A LINE SCANNER, not a regex. The regex that lived here needed `^` anchored
	// to line starts to stop counterparty prose from opening a section — but the
	// `m` flag that gives you `^` also turns `$` into end-of-LINE, which made the
	// lazy body match terminate on the first newline. Every field came back
	// empty, silently, and the resolver's yes=>release/no=>refund FALLBACK
	// happened to match the standard case, so the tests still passed while
	// on-chain receipts recorded reviewQuestion: "". Scanning lines cannot fail
	// that way and reads like what it does.
	//
	// FIRST occurrence wins, and headings in counterparty text are escaped at
	// build time (demoteHeadings), so a document contains only the headings
	// buildAgreement emitted.
	const sections = new Map<string, string>();
	{
		let current: string | null = null;
		let buf: string[] = [];
		const flush = () => {
			if (current !== null && !sections.has(current))
				sections.set(current, buf.join("\n").trim());
		};
		for (const line of doc.split("\n")) {
			const h = /^## (.+)$/.exec(line);
			if (h) {
				flush();
				current = (h[1] ?? "").trim();
				buf = [];
			} else if (current !== null) {
				buf.push(line);
			}
		}
		flush();
	}
	const section = (name: string) => sections.get(name) ?? "";
	const effects: Array<[string, string]> = section("Resolution Effects")
		.split("\n")
		.map((l) =>
			l
				.replace(/^-\s*/, "")
				.split("=>")
				.map((x) => x.trim()),
		)
		.filter((p) => p.length === 2)
		.map((p) => [p[0] as string, p[1] as string]);
	// Frontmatter only — the block between the first two `---` fences, so prose
	// further down cannot forge a later deadline.
	const front = doc.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
	const deadline = front.match(/^deadline:\s*"?([^"\n]+)"?/m)?.[1]?.trim();

	// A deadline decides money, so it must name ONE instant for everybody. A
	// date-only value parses as UTC midnight and an offset-less datetime parses
	// as the READER's local time — the same document would expire at different
	// moments for buyer, provider and resolver. Require an explicit Z/±HH:MM.
	const explicitOffset =
		!!deadline && /(?:Z|[+-]\d{2}:?\d{2})$/.test(deadline.trim());
	return {
		reviewQuestion: section("Review Question"),
		resolutionEffects: effects,
		deadline:
			deadline && explicitOffset && !Number.isNaN(Date.parse(deadline))
				? deadline
				: null,
	};
}
