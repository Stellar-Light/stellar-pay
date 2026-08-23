/** One payment option, exactly as the challenge stated it. */
export interface Accept {
	/** CAIP-2 network id, e.g. `stellar:pubnet`, `solana:5eyk…`, `eip155:8453`. */
	network: string | null;
	/** Asset the payment must be made in — a contract id, mint, or code. */
	asset: string | null;
	/** Amount in the asset's smallest unit, verbatim from the challenge. */
	amount: string | null;
	scheme: string | null;
}

/** What a probe observed. Never an inference. */
export type ProbeOutcome =
	/** Answered a payment challenge — paid and alive. */
	| "paid"
	/** Answered 200: free, open, or the paywall is elsewhere. */
	| "open"
	/** 401/403: auth-walled, so the terms are invisible to us. */
	| "walled"
	/** 404/410: gone. */
	| "absent"
	/** 5xx, timeout, DNS — we could not look. Never "not paid". */
	| "unreachable";

export interface Endpoint {
	/** The resource URL that answers the challenge — the natural key. */
	url: string;
	host: string;
	title: string | null;
	/** Which challenge came back. `none` = we never read one. */
	protocol: "x402" | "mpp" | "x402+mpp" | "none";
	/**
	 * TRUE only when a challenge WE READ listed a Stellar network. The whole
	 * point of this index: x402 and MPP are shared standards, so supporting
	 * x402 says nothing about whether a Stellar wallet can pay.
	 */
	acceptsStellar: boolean;
	/** The challenge verbatim. Empty = none read, NEVER "accepts nothing". */
	accepts: Accept[];
	/** Per-call price when the challenge names one in a USD stablecoin. */
	priceUSD: number | null;
	/** Where we learned of it. Discovery only — never evidence of liveness. */
	source: "bazaar" | "sextant" | "curated";
	sourceUrl: string | null;
	outcome: ProbeOutcome;
	/** Raw HTTP status or transport error, so a reader can audit the verdict. */
	status: string;
	firstSeen: string;
	lastChecked: string;
	/** Last time this URL actually answered a challenge. */
	lastPaid: string | null;
	/** Probes in a row with no challenge. A streak is the going-dark signal. */
	consecutiveMisses: number;
}

/** The stored shape — Endpoint plus whatever Mongo adds. */
export type EndpointDoc = Endpoint & { _id?: unknown };
