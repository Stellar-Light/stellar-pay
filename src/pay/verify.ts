/**
 * Seller-side check: is this endpoint a correct, Stellar-payable 402?
 *
 * The neutral counterpart to hosting a gateway — a provider (whether they
 * self-host SDF's x402/MPP middleware or sit behind a router) points `verify`
 * at their URL and gets a checklist: does it answer 402, does it name a Stellar
 * network, is the asset the USDC SAC, is there a recipient, are fees sponsored,
 * is the challenge well-formed. Passing it means the probe will index them and
 * a stellar-pay client can pay them — so it's the seller's path into the
 * catalog without going through anyone's gateway.
 */
import { isStellar, type Offer, readOffers, USDC_SAC } from "./offers.js";

export type Check = { ok: boolean; label: string; detail: string };
export type VerifyResult = {
	url: string;
	status: number;
	payable: boolean;
	checks: Check[];
	offer: Offer | null;
};

const UA = "stellar-pay-verify/1.0";

export async function verifyEndpoint(
	url: string,
	method = "GET",
	body?: string,
): Promise<VerifyResult> {
	const attempt = async (m: string) => {
		const r = await fetch(url, {
			method: m,
			headers: {
				"user-agent": UA,
				accept: "application/json",
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: m === "GET" ? undefined : (body ?? "{}"),
			signal: AbortSignal.timeout(20_000),
		});
		return { status: r.status, headers: r.headers, text: await r.text() };
	};
	let res = await attempt(method);
	if (res.status !== 402 && method === "GET") {
		const post = await attempt("POST");
		if (post.status === 402) res = post;
	}

	const checks: Check[] = [];
	const add = (ok: boolean, label: string, detail: string) =>
		checks.push({ ok, label, detail });

	add(
		res.status === 402,
		"answers 402",
		res.status === 402
			? "returns 402 Payment Required"
			: `returns ${res.status}, not 402 — a paid endpoint must challenge with 402 (try a different method/body if this route isn't the paid one)`,
	);

	const offers = res.status === 402 ? readOffers(res.headers, res.text) : [];
	add(
		offers.length > 0,
		"challenge is readable",
		offers.length
			? `parsed ${offers.length} offer(s)`
			: res.status === 402
				? "402 but no readable challenge — expose x402 `accepts[]` (JSON body or the payment-required header) or an MPP `WWW-Authenticate: Payment` header"
				: "no challenge to read (the endpoint did not answer 402)",
	);

	const stellar = offers.find((o) => isStellar(o.network));
	add(
		!!stellar,
		"names a Stellar network",
		stellar
			? `network=${stellar.network}`
			: `no offer names stellar:pubnet/testnet${offers[0] ? ` (saw ${offers.map((o) => o.network).join(", ")})` : ""} — a Stellar wallet can only pay a challenge that names a Stellar CAIP-2 network`,
	);

	const o = stellar ?? null;
	if (o) {
		const sacSet = new Set(Object.values(USDC_SAC));
		add(
			!!o.asset && sacSet.has(o.asset),
			"asset is the USDC SAC",
			o.asset && sacSet.has(o.asset)
				? `asset=${o.asset.slice(0, 8)}… (USDC SAC)`
				: `asset=${o.asset ?? "none"} — for USDC name the Stellar Asset Contract (${(USDC_SAC["stellar:pubnet"] ?? "").slice(0, 10)}… on pubnet), not "USDC" or the classic issuer`,
		);
		add(
			!!o.payTo,
			"has a recipient",
			o.payTo
				? `payTo=${o.payTo.slice(0, 6)}…`
				: "no payTo/recipient in the challenge — name the account that receives the payment",
		);
		add(
			!!o.amount,
			"states an amount",
			o.amount ? `amount=${o.amount} base units` : "no amount in the challenge",
		);
		add(
			o.feesSponsored,
			"sponsors fees",
			o.feesSponsored
				? "fees sponsored — clients need no XLM"
				: "fees not sponsored — clients will need XLM; set feePayer/areFeesSponsored so a zero-XLM wallet can pay",
		);
	}

	// Required checks that gate payability (fee sponsorship is a strong-rec, not a gate).
	const required = checks.filter((c) => c.label !== "sponsors fees");
	return {
		url,
		status: res.status,
		payable: required.every((c) => c.ok),
		checks,
		offer: o,
	};
}
