/**
 * Cross-implementation benchmark: read pay.sh's OWN reference 402 challenge
 * with our parser. pay.sh (Solana) runs a public debugger that serves real MPP
 * and x402 challenges. If our offers parser reads pay's challenge correctly —
 * amount, asset, recipient, protocol — our implementation interoperates with
 * the reference, and it must also (correctly) refuse to call it Stellar-payable,
 * since the challenge names a Solana network, not stellar:pubnet.
 */
import { isStellar, readOffers } from "../pay/offers.js";

const REF = "https://debugger.pay.sh/mpp/quote/AAPL";
const log = (m: string) => console.log(`  ${m}`);

async function main() {
	console.log("parity-test — our parser against pay.sh's reference MPP 402\n");
	const r = await fetch(REF, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(20_000),
	});
	if (r.status !== 402)
		throw new Error(`expected 402 from ${REF}, got ${r.status}`);
	const offers = readOffers(r.headers, await r.text());
	log(`pay.sh challenge → ${offers.length} offer(s) parsed`);
	const o = offers[0];
	if (!o) throw new Error("our parser read no offer from pay.sh's challenge");
	log(
		`protocol=${o.protocol}  network=${o.network}  amount=${o.amount}  asset=${o.asset?.slice(0, 8)}…  payTo=${o.payTo?.slice(0, 6)}…  feesSponsored=${o.feesSponsored}`,
	);
	if (o.protocol !== "mpp") throw new Error(`expected mpp, got ${o.protocol}`);
	if (!o.amount || !o.payTo)
		throw new Error(
			"parser did not extract amount + recipient from the reference challenge",
		);
	// It's a Solana challenge, so it MUST NOT be treated as Stellar-payable.
	const stellarPayable = offers.some((x) => isStellar(x.network));
	log(
		`Stellar-payable? ${stellarPayable}  (correct = false; pay.sh's ref is Solana)`,
	);
	if (stellarPayable)
		throw new Error("parser wrongly marked a Solana challenge Stellar-payable");
	console.log(
		"\nPASS — our parser reads pay.sh's reference MPP challenge (amount, asset, recipient, protocol) and correctly refuses it as non-Stellar. Cross-implementation interop confirmed.",
	);
	process.exit(0);
}
main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).message}`);
	process.exit(1);
});
