/**
 * The one spend decision, shared by the CLI (`curl`, `run`) and the MCP so the
 * rule can't drift between them: testnet auto-approves (no value); mainnet
 * requires USDC and within the ceiling. Callers add their own UX — an
 * interactive prompt, an auto-approve log, or a tool refusal — around this.
 */
import { type Offer, offerUSD } from "./offers.js";

export type Verdict = { ok: boolean; reason: string };

export function autoApprove(
	offer: Offer,
	opts: { network: string; maxUsd: number },
): Verdict {
	if (opts.network === "stellar:testnet")
		return { ok: true, reason: "testnet — tokens have no value" };
	// A misconfigured ceiling (NaN from a typo'd env var, zero, negative) must
	// fail CLOSED: every `>` comparison against NaN is false, which would
	// otherwise approve any amount.
	if (!Number.isFinite(opts.maxUsd) || opts.maxUsd <= 0)
		return {
			ok: false,
			reason: "spend ceiling is not a positive number — refusing",
		};
	const usd = offerUSD(offer);
	if (usd == null)
		return {
			ok: false,
			reason: `not USDC (${offer.asset ?? "unknown asset"}); only USDC is auto-approved on mainnet`,
		};
	if (usd > opts.maxUsd)
		return {
			ok: false,
			reason: `$${usd.toFixed(4)} exceeds the ceiling of $${opts.maxUsd}`,
		};
	return { ok: true, reason: `$${usd.toFixed(4)} within $${opts.maxUsd}` };
}

/** stellar.expert transaction link for the network. */
export const explorer = (network: string, hash: string): string =>
	`https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/tx/${hash}`;
