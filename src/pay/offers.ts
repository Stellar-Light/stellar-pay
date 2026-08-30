/**
 * Read what a 402 is asking for, in both protocols, into one shape.
 *
 * x402 puts `accepts[]` in the JSON body and/or a base64 `payment-required`
 * header; MPP puts a `Payment` challenge in `WWW-Authenticate` whose `request`
 * param is base64url JSON (draft-stellar-charge-00 §4). The 402 is the
 * authority on price, asset, network and recipient — never a catalog.
 */
export type Protocol = "x402" | "mpp";

export type Offer = {
	protocol: Protocol;
	/** CAIP-2, e.g. stellar:pubnet */
	network: string;
	/** Token contract (SAC) address on Stellar; chain-specific elsewhere */
	asset: string | null;
	/** Base units, as the challenge states them */
	amount: string | null;
	payTo: string | null;
	feesSponsored: boolean;
	expires: string | null;
	description: string | null;
};

/** USDC Stellar Asset Contract ids (from @x402/stellar). */
export const USDC_SAC: Record<string, string> = {
	"stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
	"stellar:testnet": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
};

export const isStellar = (n: string | null | undefined) =>
	!!n && n.toLowerCase().startsWith("stellar");

const b64 = (s: string) =>
	Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
		"utf8",
	);

type X402Accept = {
	network?: string;
	asset?: string;
	amount?: string;
	maxAmountRequired?: string;
	payTo?: string;
	maxTimeoutSeconds?: number;
	description?: string;
	extra?: { areFeesSponsored?: boolean; feesSponsored?: boolean };
};

function x402Offers(j: unknown, out: Offer[]) {
	const d = j as {
		accepts?: X402Accept[];
		resource?: { description?: string };
	};
	for (const a of d?.accepts ?? []) {
		if (!a?.network) continue;
		out.push({
			protocol: "x402",
			network: a.network,
			asset: a.asset ?? null,
			// v2 says amount, v1 said maxAmountRequired
			amount: a.amount ?? a.maxAmountRequired ?? null,
			payTo: a.payTo ?? null,
			feesSponsored: !!(a.extra?.areFeesSponsored ?? a.extra?.feesSponsored),
			expires: null,
			description: a.description ?? d.resource?.description ?? null,
		});
	}
}

/** `Payment id="…", realm="…", method="stellar", …` → one object per challenge. */
function parsePaymentChallenges(
	wwwAuthenticate: string,
): Record<string, string>[] {
	const out: Record<string, string>[] = [];
	for (const part of wwwAuthenticate.split(/,\s*(?=Payment\s)/i)) {
		if (!/^\s*Payment\s/i.test(part)) continue;
		const params: Record<string, string> = {};
		for (const m of part
			.replace(/^\s*Payment\s+/i, "")
			.matchAll(/([A-Za-z_-]+)=("([^"]*)"|([^,\s]+))/g)) {
			const k = m[1];
			if (k) params[k] = m[3] ?? m[4] ?? "";
		}
		out.push(params);
	}
	return out;
}

export function readOffers(headers: Headers, body: string): Offer[] {
	const out: Offer[] = [];
	try {
		x402Offers(JSON.parse(body.slice(0, 40_000)), out);
	} catch {
		// not JSON — the header path below may still carry it
	}
	for (const name of ["payment-required", "x-payment-required"]) {
		const h = headers.get(name);
		if (!h) continue;
		try {
			x402Offers(JSON.parse(b64(h)), out);
		} catch {
			// a malformed header is not an offer
		}
	}
	for (const c of parsePaymentChallenges(
		headers.get("www-authenticate") ?? "",
	)) {
		if (!c.method) continue;
		let req: {
			amount?: string;
			currency?: string;
			recipient?: string;
			description?: string;
			methodDetails?: { network?: string; feePayer?: boolean };
		} = {};
		try {
			req = JSON.parse(b64(c.request ?? ""));
		} catch {
			// challenge without a readable request: still an offer, just opaque
		}
		out.push({
			protocol: "mpp",
			network: req.methodDetails?.network ?? c.method,
			asset: req.currency ?? null,
			amount: req.amount ?? null,
			payTo: req.recipient ?? null,
			feesSponsored: !!req.methodDetails?.feePayer,
			expires: c.expires ?? null,
			description: req.description ?? null,
		});
	}
	// A server commonly sends the same accept in both the body and the
	// payment-required header — de-dupe so one offer isn't counted twice.
	const seen = new Set<string>();
	return out.filter((o) => {
		const k = `${o.protocol}|${o.network}|${o.asset}|${o.amount}|${o.payTo}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/** USD value when the asset is USDC on Stellar (7 decimals); null otherwise.
 *
 * A non-numeric amount MUST come back null, never NaN. `amount` is a string a
 * hostile seller controls ("abc", "1,000000000"), and NaN passes every `>`
 * ceiling test — it was approved by autoApprove AND it poisoned the MCP's
 * session budget permanently once added to the running total. null routes to
 * the "unpriceable, refuse" path instead. */
export function offerUSD(o: Offer): number | null {
	if (!o.amount || !o.asset) return null;
	if (USDC_SAC[o.network] !== o.asset) return null;
	const usd = Number(o.amount) / 10_000_000;
	// NEGATIVE is as dangerous as NaN and less obvious: -$100 satisfies every
	// `usd > ceiling` test, so the gate approves it, and adding it to a running
	// session total RAISES the remaining budget. A price is a non-negative
	// number or it is not a price.
	return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

export function describeOffer(o: Offer): string {
	const usd = offerUSD(o);
	const price =
		usd != null
			? `$${usd.toFixed(4)} USDC`
			: `${o.amount ?? "?"} base units of ${o.asset ?? "?"}`;
	const to = o.payTo ? `${o.payTo.slice(0, 4)}…${o.payTo.slice(-4)}` : "?";
	return `${price} on ${o.network} to ${to} via ${o.protocol.toUpperCase()}${o.feesSponsored ? ", fees sponsored" : ""}`;
}
