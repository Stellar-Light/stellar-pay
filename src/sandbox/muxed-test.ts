/**
 * Muxed (M…) destinations — SEP-23.
 *
 * The point of the primitive is attribution without a memo: one real account
 * receives everything, and each payer gets a distinct address whose embedded
 * id says who the payment is for. The risks are equally specific, so this
 * checks the three things that would make it unsafe rather than merely
 * unimplemented: a memo alongside a muxed address (two competing answers to
 * "who is this for"), a pre-flight check run against the M… instead of the
 * account that actually holds the balance, and a malformed address slipping
 * through a length-only test.
 *
 * Offline: no network, no wallet, no funded account.
 */
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { isMuxed, muxedId, sendAsset, underlyingAccount } from "../pay/send.js";

const log = (m: string) => console.log(`  ${m}`);
let failed = 0;
const check = (ok: boolean, what: string) => {
	log(`${ok ? "✓" : "✗"} ${what}`);
	if (!ok) failed++;
};

async function throws(fn: () => Promise<unknown>, match: RegExp, what: string) {
	try {
		await fn();
		check(false, `${what} (no error thrown)`);
	} catch (e) {
		const msg = (e as Error).message;
		check(
			match.test(msg),
			`${what}${match.test(msg) ? "" : ` — got: ${msg.slice(0, 90)}`}`,
		);
	}
}

async function main() {
	console.log("muxed-test — M… destinations, SEP-23\n");

	const g = Keypair.random().publicKey();
	const m = new MuxedAccount(new Account(g, "0"), "424242").accountId();

	check(isMuxed(m), "an M… address is recognised as muxed");
	check(!isMuxed(g), "a G… address is not");
	check(
		!isMuxed(`${m.slice(0, -1)}X`),
		"a corrupted M… fails the checksum, not just the length",
	);
	check(
		underlyingAccount(m) === g,
		"the underlying account is recovered exactly",
	);
	check(
		muxedId(m) === "424242",
		"the routing id is recovered from the address",
	);

	// The helpers must refuse a non-muxed input rather than hand back the
	// argument — a caller that got its G… back would check the right account
	// by accident here and the wrong one the moment the input changed.
	await throws(
		async () => underlyingAccount(g),
		/not a muxed/i,
		"underlyingAccount refuses a G… address",
	);
	await throws(
		async () => muxedId(g),
		/not a muxed/i,
		"muxedId refuses a G… address",
	);

	// A memo alongside a muxed destination is the misrouting case: refuse
	// before touching the network, so the check cannot be mistaken for a
	// network failure.
	const wallet = {
		keypair: Keypair.random(),
		publicKey: Keypair.random().publicKey(),
		network: "stellar:testnet" as const,
	};
	const { Asset } = await import("@stellar/stellar-sdk");
	const usdc = new Asset("USDC", Keypair.random().publicKey());
	await throws(
		() => sendAsset(wallet as never, m, usdc, "1", "12345"),
		/already carries its routing id/i,
		"a memo alongside an M… destination is refused, not merged",
	);
	await throws(
		() => sendAsset(wallet as never, "NOTANADDRESS", usdc, "1"),
		/not a Stellar account address/i,
		"a non-address is still rejected",
	);

	console.log(
		failed === 0
			? "\nmuxed-test PASSED"
			: `\nmuxed-test FAILED: ${failed} check(s)`,
	);
	if (failed) process.exit(1);
}

main().catch((e) => {
	console.error(`\nmuxed-test FAILED: ${(e as Error).message}`);
	process.exit(1);
});
