/**
 * The seller-side verifier, checked both ways: a real Stellar 402 passes, and
 * pay.sh's Solana reference is correctly reported unpayable (with the reason).
 */
import { verifyEndpoint } from "../pay/verify.js";

const log = (m: string) => console.log(`  ${m}`);

async function main() {
	console.log("verify-test — seller-side 402 validator\n");
	const stellar = await verifyEndpoint(
		"https://apiserver.mpprouter.dev/v1/services/exa/search",
		"POST",
		"{}",
	);
	log(
		`mpp-router (real Stellar 402): ${stellar.checks.filter((c) => c.ok).length}/${stellar.checks.length} checks, payable=${stellar.payable}`,
	);
	if (!stellar.payable)
		throw new Error(
			`a correct Stellar 402 must verify payable; failed: ${stellar.checks
				.filter((c) => !c.ok)
				.map((c) => c.label)
				.join(", ")}`,
		);

	const solana = await verifyEndpoint("https://debugger.pay.sh/mpp/quote/AAPL");
	const netCheck = solana.checks.find(
		(c) => c.label === "names a Stellar network",
	);
	log(
		`pay.sh reference (Solana 402): payable=${solana.payable}, network-check ok=${netCheck?.ok}`,
	);
	if (solana.payable)
		throw new Error("a Solana challenge must NOT verify as Stellar-payable");
	if (netCheck?.ok !== false)
		throw new Error(
			"expected the Stellar-network check to fail on a Solana challenge",
		);

	console.log(
		"\nPASS — verify approves a real Stellar 402 and rejects a non-Stellar one with the reason.",
	);
	process.exit(0);
}
main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).message}`);
	process.exit(1);
});
