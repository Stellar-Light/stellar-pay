import { Keypair } from "@stellar/stellar-sdk";

export type Network = "stellar:pubnet" | "stellar:testnet";

export type Wallet = { keypair: Keypair; publicKey: string; network: Network };

export const HORIZON: Record<Network, string> = {
	"stellar:pubnet": "https://horizon.stellar.org",
	"stellar:testnet": "https://horizon-testnet.stellar.org",
};

/** Circle's classic USDC issuers — balances live on the classic asset. */
export const USDC_ISSUER: Record<Network, string> = {
	"stellar:pubnet": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
	"stellar:testnet": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

export function loadWallet(
	opts: { secret?: string; network?: string } = {},
): Wallet {
	const secret = opts.secret ?? process.env.STELLAR_SECRET_KEY;
	if (!secret)
		throw new Error(
			"no wallet: set STELLAR_SECRET_KEY (an S… secret whose account holds USDC)",
		);
	const network = (opts.network ??
		process.env.STELLAR_NETWORK ??
		"stellar:pubnet") as Network;
	if (!(network in HORIZON))
		throw new Error(
			`unknown network ${network}; use stellar:pubnet or stellar:testnet`,
		);
	const keypair = Keypair.fromSecret(secret);
	return { keypair, publicKey: keypair.publicKey(), network };
}

export async function balances(publicKey: string, network: Network) {
	const r = await fetch(`${HORIZON[network]}/accounts/${publicKey}`, {
		signal: AbortSignal.timeout(15_000),
	});
	if (r.status === 404)
		return { funded: false as const, xlm: "0", usdc: null, others: [] };
	if (!r.ok) throw new Error(`horizon ${r.status}`);
	const d = (await r.json()) as {
		balances: Array<{
			asset_type: string;
			asset_code?: string;
			asset_issuer?: string;
			balance: string;
		}>;
	};
	let xlm = "0";
	let usdc: string | null = null;
	const others: Array<{ code: string; issuer: string; balance: string }> = [];
	for (const b of d.balances) {
		if (b.asset_type === "native") xlm = b.balance;
		else if (b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER[network])
			usdc = b.balance;
		else if (b.asset_code && b.asset_issuer)
			others.push({
				code: b.asset_code,
				issuer: b.asset_issuer,
				balance: b.balance,
			});
	}
	return { funded: true as const, xlm, usdc, others };
}
