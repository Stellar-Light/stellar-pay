/**
 * The paid fetch: plain request → if 402, read the offers → ask → pay → retry.
 *
 * Approval happens BEFORE anything is signed, on both protocols, with the
 * price read from the live challenge. x402 goes through @x402/core's client
 * (auth-entry signing, facilitator settles); MPP through @stellar/mpp's charge
 * client in pull mode (server assembles and submits, sponsoring fees when it
 * says so). The caller chooses the protocol order; both re-run the 402
 * handshake inside the library, which costs one extra request and buys
 * correctness we did not write.
 */

import { Mppx, charge as mppCharge } from "@stellar/mpp/charge/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { isStellar, type Offer, type Protocol, readOffers } from "./offers.js";
import type { Wallet } from "./wallet.js";

/** MPP `Payment-Receipt` (base64url or plain JSON): { method, reference, status, timestamp }. */
function receiptHash(res: Response): string | null {
	const h = res.headers.get("payment-receipt");
	if (!h) return null;
	for (const text of [
		h,
		Buffer.from(h.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
			"utf8",
		),
	]) {
		try {
			const j = JSON.parse(text) as { reference?: string; hash?: string };
			if (j.reference || j.hash) return j.reference ?? j.hash ?? null;
		} catch {
			// try the other encoding
		}
	}
	return null;
}

/** "0.0100000" → 100000n — the inverse of the MPP lib's fromBaseUnits(x, 7). */
function toBaseUnits7(human: string): bigint {
	const [whole = "0", frac = ""] = human.split(".");
	return BigInt(whole) * 10_000_000n + BigInt(frac.slice(0, 7).padEnd(7, "0"));
}

/**
 * The bait-and-switch pin, as one testable rule.
 *
 * payFetch approves what its OWN probe saw, but the payment libraries re-fetch
 * the 402 and sign THAT challenge. This compares the two. It lives here, alone
 * and exported, because an audit found the inline versions had no tests at all
 * — they could be deleted and the whole suite stayed green.
 *
 * Returns null when the live challenge matches the approved offer, or the
 * reason it does not.
 */
export function pinMismatch(
	offer: Offer,
	live: {
		amount?: string | null;
		currency?: string | null;
		recipient?: string | null;
		network?: string | null;
	},
): string | null {
	if (
		live.network != null &&
		offer.network !== "stellar" &&
		live.network !== offer.network
	)
		return `the endpoint switched network after approval (approved ${offer.network}, asked to sign ${live.network})`;
	if (
		offer.amount != null &&
		live.amount != null &&
		toBaseUnits7(live.amount) !== BigInt(offer.amount)
	)
		return "the endpoint's payment requirement changed after approval — refusing to sign a different amount";
	if (
		offer.asset != null &&
		live.currency != null &&
		live.currency !== offer.asset
	)
		return "the endpoint's payment requirement changed after approval — refusing to sign a different asset";
	if (
		offer.payTo != null &&
		live.recipient != null &&
		live.recipient !== offer.payTo
	)
		return "the endpoint's payment requirement changed after approval — refusing to sign to a different recipient";
	// ASYMMETRY IS A MISMATCH (audit finding 7). Every comparison above needs
	// BOTH sides, so an approved offer with null amount/asset/payTo — what an
	// unparseable MPP `request` produces — disabled the entire pin: the human
	// was shown "pay ? of ?", said yes to that, and the endpoint then named
	// whatever it liked. An approval that could not state a term cannot
	// authorise a concrete one.
	for (const [field, approved, now] of [
		["amount", offer.amount, live.amount],
		["asset", offer.asset, live.currency],
		["recipient", offer.payTo, live.recipient],
	] as const)
		if (approved == null && now != null)
			return `the offer you approved did not state its ${field}, and the endpoint is now asking to sign a specific one (${String(now).slice(0, 40)}) — refusing to sign terms that were not on screen`;
	return null;
}

const isRedirect = (n: number) =>
	n === 301 || n === 302 || n === 303 || n === 307 || n === 308;

/** Drop per-origin credentials from a request init (cross-origin redirect). */
function stripCredentials(init: RequestInit): RequestInit {
	const h = new Headers(init.headers ?? {});
	for (const k of ["authorization", "cookie", "proxy-authorization"])
		h.delete(k);
	return { ...init, headers: h };
}

export type PayResult = {
	res: Response;
	/** every offer the 402 carried, payable from this wallet or not */
	offers: Offer[];
	paid: { protocol: Protocol; offer: Offer; hash: string | null } | null;
	declined: boolean;
	/** set when a redirect hop was refused by the caller's guard */
	blocked?: string;
};

export async function payFetch(
	url: string,
	init: RequestInit,
	o: {
		wallet: Wallet;
		approve: (offer: Offer, url: string) => Promise<boolean>;
		/** re-checked on every redirect hop (SSRF / per-host policy) */
		guard?: (url: string) => Promise<string | null> | string | null;
		prefer?: Protocol;
		fetch?: typeof globalThis.fetch;
	},
): Promise<PayResult> {
	const f = o.fetch ?? globalThis.fetch;
	// Do NOT let fetch silently follow redirects: every gate (SSRF guard,
	// per-host spend policy, approval) is evaluated against the URL the caller
	// asked for, so a 302 would move the actual 402 — and its payTo — to a host
	// that was never checked. Follow them ourselves, re-running the caller's
	// guard on each hop.
	let current = url;
	let first = await f(current, { ...init, redirect: "manual" });
	for (let hop = 0; hop < 5 && isRedirect(first.status); hop++) {
		const loc = first.headers.get("location");
		if (!loc) break;
		const next = new URL(loc, current).toString();
		const blocked = await o.guard?.(next);
		if (blocked)
			return {
				res: first,
				offers: [],
				paid: null,
				declined: true,
				blocked,
			};
		// Credentials the caller set for THIS origin must not travel to another
		// one: a 302 to an attacker's host would otherwise hand it the user's
		// API key or session cookie verbatim. Browsers strip these on a
		// cross-origin redirect; so do we.
		if (new URL(next).origin !== new URL(current).origin)
			init = stripCredentials(init);
		current = next;
		first = await f(current, { ...init, redirect: "manual" });
	}
	url = current;
	if (first.status !== 402)
		return { res: first, offers: [], paid: null, declined: false };

	const offers = readOffers(first.headers, await first.clone().text());
	const payable = offers.filter(
		(x) =>
			isStellar(x.network) &&
			(x.network === o.wallet.network || x.network === "stellar"),
	);
	// An EXPLICIT --x402/--mpp is a constraint, not a preference: falling back
	// to the other protocol silently paid over the top of the user's choice.
	// With no flag, the old ordering stands (MPP first, x402 second).
	const order: Protocol[] = o.prefer
		? [o.prefer]
		: (["mpp", "x402"] as Protocol[]);
	const offer = order
		.map((p) => payable.find((x) => x.protocol === p))
		.find(Boolean);
	if (!offer) return { res: first, offers, paid: null, declined: false };
	if (!(await o.approve(offer, url)))
		return { res: first, offers, paid: null, declined: true };

	// Approval may have waited on a human prompt; give the paying fetch a fresh
	// timeout so the caller's original (now-aged) signal can't abort a payment
	// mid-settlement — an ambiguous abort there risks a double-pay on retry.
	init = { ...init, signal: AbortSignal.timeout(120_000) };

	if (offer.protocol === "mpp") {
		let hash: string | null = null;
		const mppx = Mppx.create({
			fetch: f,
			// NEVER polyfill globalThis.fetch: the library defaults to replacing it
			// with an auto-paying wrapper, which in a long-lived process (the MCP,
			// the run proxy) would pay every later 402 BEFORE the approval gate.
			polyfill: false,
			// The library re-fetches the 402 and signs THAT challenge. onProgress
			// cannot see the network — and the network decides the RPC and the
			// signing passphrase — so a server could show stellar:testnet to the
			// approval probe and stellar:pubnet to this one, keeping amount/asset/
			// recipient identical, and get a real mainnet transfer signed under a
			// "testnet, no value" approval. Gate the raw challenge here, where the
			// network IS visible, before any credential is created.
			async onChallenge(challenge, helpers) {
				const req = (
					challenge as unknown as {
						request?: { methodDetails?: { network?: string } };
					}
				).request;
				const liveNet = req?.methodDetails?.network;
				const bad = pinMismatch(offer, { network: liveNet });
				if (bad) throw new Error(`${bad} — refusing`);
				// pinMismatch exempts offers that advertised the BARE network
				// "stellar" (nothing to compare against). For those, pin the live
				// challenge to the WALLET's network — the same ed25519 key signs on
				// both networks, so a bare-network offer approved as testnet must
				// not settle as pubnet.
				if (
					offer.network === "stellar" &&
					liveNet &&
					isStellar(liveNet) &&
					liveNet !== o.wallet.network
				)
					throw new Error(
						`the endpoint advertised network "stellar" but asks to settle on ${liveNet}, not this wallet's ${o.wallet.network} — refusing`,
					);
				return helpers.createCredential();
			},
			methods: [
				mppCharge({
					secretKey: o.wallet.keypair.secret(),
					mode: "pull",
					onProgress(e) {
						// The library re-fetches the 402 and signs THAT challenge. This
						// event carries exactly what is about to be signed — pin it to
						// the approved offer (amount, currency, recipient) and abort by
						// throwing on any mismatch, mirroring the x402 selector below.
						if (e.type === "challenge") {
							const bad = pinMismatch(offer, {
								amount: e.amount,
								currency: e.currency,
								recipient: e.recipient,
							});
							if (bad) throw new Error(bad);
						}
						if (e.type === "paid") hash = e.hash;
					},
				}),
			],
		});
		const res = await mppx.fetch(url, init);
		// In pull mode the server submits, so the client never sees the hash
		// itself; the spec's receipt (§10.4) comes back as Payment-Receipt.
		return {
			res,
			offers,
			paid: { protocol: "mpp", offer, hash: hash ?? receiptHash(res) },
			declined: false,
		};
	}

	// The library re-fetches the 402 and would sign whatever THAT challenge
	// states. Pin it to the exact offer the caller approved — same network,
	// asset, and amount — so a server can't show a small price to the approval
	// probe and a large one to the paying fetch. If the live requirement no
	// longer matches what was approved, refuse rather than pay something else.
	const client = new x402Client((_v, reqs) => {
		const pick = reqs.find((r) => {
			const rr = r as {
				amount?: string;
				maxAmountRequired?: string;
				payTo?: string;
			};
			// The v2 signer signs r.amount (v1: maxAmountRequired). Require EVERY
			// amount field the challenge carries to equal the approved amount, so a
			// challenge with maxAmountRequired=approved but amount=higher can't
			// satisfy the pin while the signer signs the higher value.
			const amounts = [rr.amount, rr.maxAmountRequired].filter(
				(x): x is string => x != null,
			);
			return (
				r.network === o.wallet.network &&
				(offer.asset == null || r.asset === offer.asset) &&
				(offer.payTo == null || rr.payTo === offer.payTo) &&
				amounts.length > 0 &&
				amounts.every((x) => String(x) === (offer.amount ?? ""))
			);
		});
		if (!pick)
			throw new Error(
				"the endpoint's payment requirement changed after approval — refusing to sign a different amount",
			);
		return pick;
	}).register(
		o.wallet.network,
		new ExactStellarScheme(
			createEd25519Signer(o.wallet.keypair.secret(), o.wallet.network),
			// @x402/stellar REFUSES to build a mainnet client without an explicit
			// RPC url (testnet has a default), so every pubnet x402 payment threw
			// before this. Overridable for operators who run their own node.
			o.wallet.network === "stellar:pubnet"
				? {
						url:
							process.env.STELLAR_RPC_URL ?? "https://mainnet.sorobanrpc.com",
					}
				: undefined,
		),
	);
	const res = await wrapFetchWithPayment(f, client)(url, init);
	let hash: string | null = null;
	const receipt = res.headers.get("payment-response");
	if (receipt) {
		try {
			const j = JSON.parse(Buffer.from(receipt, "base64").toString("utf8")) as {
				transaction?: string;
			};
			hash = j.transaction ?? null;
		} catch {
			// no receipt is not a failed payment; the 200 is
		}
	}
	return {
		res,
		offers,
		paid: { protocol: "x402", offer, hash },
		declined: false,
	};
}
