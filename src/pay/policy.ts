/**
 * The one spend decision, shared by the CLI (`curl`, `run`) and the MCP so the
 * rule can't drift between them: testnet auto-approves (no value); mainnet
 * requires USDC and within the ceiling. Callers add their own UX — an
 * interactive prompt, an auto-approve log, or a tool refusal — around this.
 *
 * On top of the flat ceiling sits an optional PER-HOST policy file (a thing
 * pay.sh does not have — its only knob is one global cap): an operator can set
 * a different ceiling per host, deny hosts outright, or flip to allowlist mode
 * where only listed hosts are payable. `resolveHost` merges that with the
 * caller's requested ceiling; `decide` is the full auto-path decision.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Offer, offerUSD } from "./offers.js";

export type Verdict = { ok: boolean; reason: string };

export function autoApprove(
	offer: Offer,
	opts: { network: string; maxUsd: number },
): Verdict {
	// The offer must be on the SAME network the wallet is configured for. A
	// server that shows a testnet offer to this gate and a mainnet one to the
	// paying fetch would otherwise get real value signed under a "no value"
	// approval — the testnet branch below never checks asset or amount.
	if (offer.network !== opts.network && offer.network !== "stellar")
		return {
			ok: false,
			reason: `offer is on ${offer.network}, wallet is on ${opts.network} — refusing`,
		};
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

// --- per-host spend policy ---------------------------------------------------

/** One host's rule: its own per-call ceiling, or an outright deny. */
export type HostRule = {
	maxUsdPerCall?: number;
	deny?: boolean;
	note?: string;
};
export type Policy = {
	version?: number;
	/** denylist (default): every host payable except denied ones. allowlist:
	 * only hosts with a rule are payable — strong containment for autonomous
	 * agents, which pay.sh has no equivalent of. */
	mode?: "allowlist" | "denylist";
	default?: { maxUsdPerCall?: number };
	/** keyed by exact host, or a `*.parent` subdomain wildcard. */
	hosts?: Record<string, HostRule>;
};

export const policyPath =
	process.env.STELLAR_PAY_POLICY ??
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"stellar-pay",
		"policy.json",
	);

/** Read the policy file fresh each time (it's tiny, and a security control
 * should honor an edit on the next payment rather than cache a stale rule).
 * Absent or malformed → no policy (the flat ceiling still applies). */
export function loadPolicy(): Policy | null {
	let raw: string;
	try {
		raw = readFileSync(policyPath, "utf8");
	} catch {
		return null; // genuinely absent — the flat ceiling still applies
	}
	// A file that EXISTS but cannot be parsed must never silently disappear:
	// that would delete allowlist containment without a word. Fail closed.
	let p: Policy;
	try {
		p = JSON.parse(raw) as Policy;
	} catch (e) {
		throw new Error(
			`spend policy at ${policyPath} is not valid JSON (${(e as Error).message}) — refusing to pay with an unreadable policy`,
		);
	}
	const mode = p.mode ?? "denylist";
	if (mode !== "allowlist" && mode !== "denylist")
		throw new Error(
			`spend policy mode "${p.mode}" is not "allowlist" or "denylist" — refusing rather than silently falling back`,
		);
	return p;
}

function hostOf(url: string): string | null {
	try {
		// A trailing dot is the SAME server to DNS ("example.com." === "example.com")
		// but a different string to a deny rule, so strip it. URL already lowercases
		// and punycodes the hostname and strips the port.
		return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
	} catch {
		return null;
	}
}

/** Most-specific rule for a host: exact match, then `*.parent` walking up. */
function ruleFor(policy: Policy, host: string): HostRule | null {
	const hosts = policy.hosts ?? {};
	if (hosts[host]) return hosts[host];
	const labels = host.split(".");
	for (let i = 1; i < labels.length; i++) {
		const wild = `*.${labels.slice(i).join(".")}`;
		if (hosts[wild]) return hosts[wild];
	}
	return null;
}

export type HostGate = { maxUsd: number; blocked: string | null };

/**
 * The effective ceiling for a URL under the policy file (if any). Precedence,
 * most specific first: matching host rule → policy default → the caller's
 * requested ceiling (--max-usd / env). An EXPLICIT --max-usd can only tighten
 * the result, never raise it above what the caller asked for.
 */
export function resolveHost(
	url: string,
	o: { requested: number; requestedExplicit?: boolean; policy?: Policy | null },
): HostGate {
	const policy = o.policy ?? loadPolicy();
	if (!policy) return { maxUsd: o.requested, blocked: null };
	const host = hostOf(url);
	const rule = host ? ruleFor(policy, host) : null;
	if (rule?.deny)
		return {
			maxUsd: 0,
			blocked: `${host} is denied by the spend policy (${policyPath})`,
		};
	if ((policy.mode ?? "denylist") === "allowlist" && !rule)
		return {
			maxUsd: 0,
			blocked: `${host ?? "this host"} is not in the allowlist (${policyPath})`,
		};
	let maxUsd =
		rule?.maxUsdPerCall ?? policy.default?.maxUsdPerCall ?? o.requested;
	if (o.requestedExplicit) maxUsd = Math.min(maxUsd, o.requested);
	return { maxUsd, blocked: null };
}

/** Full auto-path decision: per-host block/ceiling, then the USDC+ceiling rule. */
export function decide(
	offer: Offer,
	o: {
		network: string;
		url: string;
		requested: number;
		requestedExplicit?: boolean;
		policy?: Policy | null;
	},
): Verdict {
	const gate = resolveHost(o.url, o);
	if (gate.blocked) return { ok: false, reason: gate.blocked };
	return autoApprove(offer, { network: o.network, maxUsd: gate.maxUsd });
}
