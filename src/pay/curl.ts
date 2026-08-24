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

const isRedirect = (n: number) =>
	n === 301 || n === 302 || n === 303 || n === 307 || n === 308;

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
	const order: Protocol[] =
		o.prefer === "x402" ? ["x402", "mpp"] : ["mpp", "x402"];
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
				const net = req?.methodDetails?.network;
				if (net != null && offer.network !== "stellar" && net !== offer.network)
					throw new Error(
						`the endpoint switched network after approval (approved ${offer.network}, asked to sign ${net}) — refusing`,
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
							const ok =
								(offer.amount == null ||
									toBaseUnits7(e.amount) === BigInt(offer.amount)) &&
								(offer.asset == null || e.currency === offer.asset) &&
								(offer.payTo == null || e.recipient === offer.payTo);
							if (!ok)
								throw new Error(
									"the endpoint's payment requirement changed after approval — refusing to sign a different amount",
								);
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
