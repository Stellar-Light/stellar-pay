/**
 * Scrimp wrapped around our paid client: the same 402 loop, now under
 * outcome-attributed spend control. Scrimp (kaankacar/scrimp, vendored) adds
 * three things a budget cap can't — it replays a purchase already made in this
 * task (duplicate) or one re-fetched inside its freshness window (fresh),
 * refuses a provider that just failed repeatedly (quarantined), and watches
 * whether the response body was ever read to label spend wasted.
 *
 * priceOf comes from the catalog: unlike a generic payer we know each url's
 * price before the call, so the budget rule is exact rather than a guess.
 *
 * Payment facts ride back on response HEADERS, not a WeakMap keyed on the
 * Response object — because Scrimp buffers the body and rebuilds the response
 * to make replay possible, so the object the caller sees is not the one the
 * payer returned. bufferResponse copies the headers, so x-stellar-pay-* survive
 * both a fresh purchase and a replay, and the settlement hash doubles as
 * Scrimp's own txHashOf source.
 */
import {
	MemoryStore,
	ScrimpClient,
	SUPPRESSION_HEADER,
} from "../../vendor/scrimp/index.js";
import type { Entry } from "../catalog.js";
import { payFetch } from "./curl.js";
import { type Offer, offerUSD, type Protocol } from "./offers.js";
import type { Wallet } from "./wallet.js";

export type Payment = {
	protocol: "x402" | "mpp";
	offer: string;
	usd: number | null;
	hash: string | null;
};

export type Governed = {
	client: ScrimpClient;
	/** the payment encoded on a response, if it carried one */
	paymentFor: (res: Response) => Payment | null;
	/** the approve-gate refusal encoded on a response, if any */
	refusalFor: (res: Response) => { reason: string } | null;
};

/** Per-call protocol preference rides ON the init (Scrimp forwards it to the
 * payer verbatim) — mutable client-level state would race between concurrently
 * dispatched tool calls. */
export type PreferInit = RequestInit & { stellarPayPrefer?: Protocol };

const HDR = {
	hash: "x-payment-tx-hash", // also what Scrimp's default txHashOf reads
	protocol: "x-stellar-pay-protocol",
	usd: "x-stellar-pay-usd",
	offer: "x-stellar-pay-offer",
	refused: "x-stellar-pay-refused",
} as const;

export function buildGoverned(o: {
	wallet: Wallet;
	catalog: Entry[];
	approve: (offer: Offer, url: string) => Promise<boolean>;
	refusalReason: (offer: Offer, url: string) => string;
	/** re-checked on each redirect hop (SSRF / per-host policy) */
	guard?: (url: string) => Promise<string | null> | string | null;
	prefer?: "x402" | "mpp";
	budgetPerCall: number;
}): Governed {
	const price = new Map(o.catalog.map((e) => [e.url, e.priceUSD] as const));

	const payer = async (url: string, init?: RequestInit): Promise<Response> => {
		const r = await payFetch(url, init ?? {}, {
			wallet: o.wallet,
			approve: o.approve,
			guard: o.guard,
			prefer: (init as PreferInit | undefined)?.stellarPayPrefer ?? o.prefer,
		});
		// Rebuild the response with the payment facts as headers. Reading the
		// body here is safe: payFetch hands back an unread body, and Scrimp
		// would buffer it a moment later anyway.
		// STRIP the governance namespace from the upstream response before we
		// write our own. These headers are how payment facts and suppression
		// reach the caller, so a seller that sets them on its OWN response could
		// otherwise forge a settlement hash, write the session budget (a negative
		// x-stellar-pay-usd un-caps it), or mark a real payment "suppressed" so it
		// never counts. Only this function may author them.
		const headers = new Headers(r.res.headers);
		for (const h of [...Object.values(HDR), SUPPRESSION_HEADER])
			headers.delete(h);
		if (r.paid) {
			const usd = offerUSD(r.paid.offer);
			if (r.paid.hash) headers.set(HDR.hash, r.paid.hash);
			headers.set(HDR.protocol, r.paid.protocol);
			if (usd != null) headers.set(HDR.usd, String(usd));
			headers.set(HDR.offer, describeSafe(r.paid.offer));
		} else if (r.blocked) {
			headers.set(HDR.refused, r.blocked.replace(/[^\x20-\x7e]/g, ""));
		} else if (r.declined && r.offers[0]) {
			// The reason embeds the challenge's asset string, which is
			// attacker-controlled — strip anything a header can't carry so a
			// crafted 402 can't make Headers.set throw and abort the request.
			headers.set(
				HDR.refused,
				o.refusalReason(r.offers[0], url).replace(/[^\x20-\x7e]/g, ""),
			);
		}
		const body = await r.res.arrayBuffer();
		return new Response(body.byteLength ? body : null, {
			status: r.res.status,
			statusText: r.res.statusText,
			headers,
		});
	};

	const client = new ScrimpClient({
		payer,
		store: new MemoryStore(),
		// Known from the catalog; fall back to the per-call ceiling so an
		// unpriced call is still bounded rather than treated as free.
		priceOf: (url) => price.get(url) ?? o.budgetPerCall,
		// default txHashOf reads x-payment-tx-hash, which the payer set above
	});

	return {
		client,
		paymentFor: (res) => {
			const protocol = res.headers.get(HDR.protocol) as
				| Payment["protocol"]
				| null;
			if (!protocol) return null;
			const usd = res.headers.get(HDR.usd);
			return {
				protocol,
				offer: res.headers.get(HDR.offer) ?? "",
				usd: usd == null ? null : Number(usd),
				hash: res.headers.get(HDR.hash),
			};
		},
		refusalFor: (res) => {
			const r = res.headers.get(HDR.refused);
			return r ? { reason: r } : null;
		},
	};
}

// Header values must be latin-1 and single-line; an offer string is neither
// guaranteed, so keep it printable and short.
function describeSafe(offer: Offer): string {
	const usd = offerUSD(offer);
	const price =
		usd != null
			? `$${usd.toFixed(4)} USDC`
			: `${offer.amount ?? "?"} ${offer.asset ?? "?"}`;
	return `${price} on ${offer.network} via ${offer.protocol}`.replace(
		/[^\x20-\x7e]/g,
		"",
	);
}
