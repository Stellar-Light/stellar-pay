/**
 * Ways to get USDC onto Stellar, for `topup` on mainnet. Three paths:
 *
 *  1. Fiat on-ramps — pulled live from Stellar Light's partner directory
 *     (our own data), filtered to on-ramp anchors. MoneyGram and FinClusive
 *     deliver USDC directly and globally; the regional anchors on-ramp local
 *     currency you can then swap to USDC.
 *  2. Exchange withdrawal — major exchanges that support the Stellar network
 *     for USDC withdrawals. Curated, few, and worth re-checking at use time.
 *  3. Bridge from another chain — if you already hold USDC elsewhere.
 *
 * The partner fetch is best-effort: if the directory is unreachable, topup
 * still shows the exchange and bridge paths.
 */
export type Ramp = {
	name: string;
	tagline: string | null;
	url: string;
	regions: string[];
	assets: string[];
	usdc: boolean;
};

const DIRECTORY =
	process.env.STELLAR_PAY_DIRECTORY ?? "https://www.stellarlight.xyz";

let cache: { at: number; ramps: Ramp[] } | null = null;

/** On-ramp anchors from the partner directory, USDC + global first. */
export async function partnerRamps(): Promise<Ramp[]> {
	if (cache && Date.now() - cache.at < 60 * 60_000) return cache.ramps;
	let out: Ramp[] = [];
	try {
		const r = await fetch(
			`${DIRECTORY}/api/partners?q=${encodeURIComponent("USDC fiat on-ramp buy crypto")}&limit=40`,
			{
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (r.ok) {
			const d = (await r.json()) as {
				partners?: Array<{
					name?: string;
					tagline?: string;
					websiteUrl?: string;
					url?: string;
					regions?: string[];
					assets?: string[];
					rampTypes?: string[];
				}>;
			};
			out = (d.partners ?? [])
				.filter((p) => (p.rampTypes ?? []).includes("on-ramp"))
				.map((p) => {
					const assets = p.assets ?? [];
					return {
						name: p.name ?? "?",
						tagline: p.tagline ?? null,
						url: p.websiteUrl ?? p.url ?? "",
						regions: p.regions ?? [],
						assets,
						usdc: assets.some((a) => a.toUpperCase() === "USDC"),
					};
				})
				.sort((a, b) => {
					// USDC-capable first, then global reach, then name
					const score = (x: Ramp) =>
						(x.usdc ? 2 : 0) + (x.regions.includes("global") ? 1 : 0);
					return score(b) - score(a) || a.name.localeCompare(b.name);
				});
		}
	} catch {
		// directory unreachable — fall through to the curated paths only
	}
	cache = { at: Date.now(), ramps: out };
	return out;
}

/**
 * Exchanges that support USDC withdrawal on the Stellar network. Coinbase's
 * embedded Onramp does NOT deliver to Stellar (EVM + Solana only), so the path
 * is: buy USDC, then withdraw on the Stellar network to this address.
 */
export const EXCHANGES: Array<{ name: string; url: string }> = [
	{ name: "Coinbase", url: "https://www.coinbase.com" },
	{ name: "Kraken", url: "https://www.kraken.com" },
];

/** Cross-chain routes for USDC you already hold elsewhere. */
export const BRIDGES: Array<{ name: string; url: string; note: string }> = [
	{
		name: "Rozo Intent Bridge",
		url: "https://rozo.ai",
		note: "pay from USDC/USDT on Base, Solana, Ethereum… and settle to Stellar",
	},
];

/**
 * Hosted card/PayPal on-ramps that deliver USDC to a Stellar address, for
 * `topup --buy` — the browser flow pay.sh's topup uses. Where the provider
 * accepts a wallet address in the URL it's pre-filled; otherwise the user
 * pastes the address the command prints. Override the default with
 * STELLAR_PAY_ONRAMP_URL (an `{ADDRESS}` / `{AMOUNT}` placeholder is filled).
 */
export function onramps(
	address: string,
	amount?: string,
): Array<{ name: string; url: string }> {
	const amt = amount && Number(amount) > 0 ? amount : "";
	const list: Array<{ name: string; url: string }> = [];
	const override = process.env.STELLAR_PAY_ONRAMP_URL;
	if (override)
		list.push({
			name: "configured",
			url: override.replace("{ADDRESS}", address).replace("{AMOUNT}", amt),
		});
	list.push(
		// MoonPay — the same provider pay.sh uses; USDC, wallet address pre-filled.
		{
			name: "MoonPay",
			url: `https://buy.moonpay.com?currencyCode=usdc&walletAddress=${address}${amt ? `&baseCurrencyAmount=${amt}` : ""}`,
		},
		// Lobstr — Stellar-native card on-ramp for USDC on Stellar.
		{ name: "Lobstr", url: "https://lobstr.co/buy-usd-coin-stellar/" },
		// Rozo — pay/checkout that can settle USDC on Stellar.
		{ name: "Rozo", url: "https://rozo.ai" },
	);
	return list;
}
