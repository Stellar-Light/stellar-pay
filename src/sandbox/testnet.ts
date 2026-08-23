/**
 * End-to-end proof on testnet, fully automated — see fixture.ts. Passes when
 * the server answers 200 and the settlement transaction is on-chain.
 * Exercises MPP pull mode; x402 needs a facilitator on the server side, so
 * its client path is proven on mainnet only.
 */
import { payFetch } from "../pay/curl.js";
import { describeOffer } from "../pay/offers.js";
import type { Wallet } from "../pay/wallet.js";
import { HORIZON, setupSandbox } from "./fixture.js";

const log = (m: string) => console.log(`  ${m}`);

async function main() {
	console.log(
		"sandbox — MPP charge, pull mode, sponsored fees, own SEP-41 asset on testnet\n",
	);
	const sb = await setupSandbox(log);
	const wallet: Wallet = {
		keypair: sb.payer,
		publicKey: sb.payer.publicKey(),
		network: "stellar:testnet",
	};
	const r = await payFetch(
		sb.url,
		{ method: "GET" },
		{
			wallet,
			approve: async (o) => {
				log(`402 asks: ${describeOffer(o)} → approving`);
				return true;
			},
		},
	);
	const body = await r.res.text();
	log(`response ${r.res.status}: ${body.slice(0, 80)}`);
	sb.close();
	if (r.res.status !== 200 || !r.paid)
		throw new Error(
			`expected a paid 200, got ${r.res.status} (paid=${JSON.stringify(r.paid)})`,
		);
	if (!r.paid.hash) throw new Error("paid but no settlement hash surfaced");
	const tx = (await (
		await fetch(`${HORIZON}/transactions/${r.paid.hash}`)
	).json()) as { successful?: boolean; source_account?: string };
	if (!tx.successful)
		throw new Error(`settlement ${r.paid.hash} not successful on-chain`);
	log(
		`settled on-chain: ${r.paid.hash} (source ${tx.source_account?.slice(0, 6)}… = fee payer, not the payer)`,
	);
	log(`payer SPAY balance now ${await sb.payerBalance()} (was 100)`);
	console.log(
		"\nPASS — paid a live 402 with a Stellar wallet, fees sponsored, settlement on-chain.",
	);
}

main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
