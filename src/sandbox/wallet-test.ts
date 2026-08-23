/**
 * Proves the wallet basics on testnet with a self-minted asset (Circle's USDC
 * faucet is captcha-only, so we mint a stand-in "PAYUSD" to exercise the real
 * transfer path): setup funds + trustlines, a real send moves balance A→B, and
 * the guards refuse an over-spend and a recipient with no trustline.
 */
import {
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import { history, holds, sendAsset, setupWallet } from "../pay/send.js";
import { loadWallet } from "../pay/wallet.js";

const H = "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(H);
const log = (m: string) => console.log(`  ${m}`);

async function fund(kp: Keypair) {
	const r = await fetch(
		`https://friendbot.stellar.org?addr=${kp.publicKey()}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}
async function submit(
	source: Keypair,
	ops: ReturnType<typeof Operation.payment>[],
) {
	const acct = await horizon.loadAccount(source.publicKey());
	const b = new TransactionBuilder(acct, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	}).setTimeout(60);
	for (const op of ops) b.addOperation(op);
	const tx = b.build();
	tx.sign(source);
	return (await horizon.submitTransaction(tx)).hash;
}

async function main() {
	console.log(
		"wallet-test — setup, trustline, real send, guards (self-minted asset on testnet)\n",
	);
	const issuer = Keypair.random();
	await fund(issuer);
	const asset = new Asset("PAYUSD", issuer.publicKey());

	// A and B: setup funds + adds a USDC trustline (the product asset). We also
	// give them a PAYUSD trustline to exercise a real transfer end to end.
	const a = await setupWallet("stellar:testnet");
	const b = await setupWallet("stellar:testnet");
	if (!a.trustlineTx || !b.trustlineTx)
		throw new Error("setup should fund + add the USDC trustline on testnet");
	log(
		`A ${a.publicKey.slice(0, 6)}… and B ${b.publicKey.slice(0, 6)}… funded, USDC trustlines added`,
	);
	const wA = loadWallet({ secret: a.secret, network: "stellar:testnet" });
	const kpA = Keypair.fromSecret(a.secret);
	const kpB = Keypair.fromSecret(b.secret);
	await submit(kpA, [Operation.changeTrust({ asset })]);
	await submit(kpB, [Operation.changeTrust({ asset })]);
	await submit(issuer, [
		Operation.payment({ destination: kpA.publicKey(), asset, amount: "50" }),
	]);
	log("A trusts + holds 50 PAYUSD; B trusts PAYUSD");

	// Real send A → B.
	const r = await sendAsset(wA, kpB.publicKey(), asset, "12.5");
	log(`sent 12.5 PAYUSD A→B · hash ${r.hash.slice(0, 10)}…`);
	const balB = await holds(
		kpB.publicKey(),
		"stellar:testnet",
		"PAYUSD",
		issuer.publicKey(),
	);
	const balA = await holds(
		kpA.publicKey(),
		"stellar:testnet",
		"PAYUSD",
		issuer.publicKey(),
	);
	log(`after: A=${balA.balance} PAYUSD  B=${balB.balance} PAYUSD`);
	if (Number(balB.balance) !== 12.5 || Number(balA.balance) !== 37.5)
		throw new Error(
			`balances wrong after send: A=${balA.balance} B=${balB.balance}`,
		);

	// Guard: over-spend.
	let e1 = "";
	try {
		await sendAsset(wA, kpB.publicKey(), asset, "1000");
	} catch (e) {
		e1 = (e as Error).message;
	}
	log(`over-spend refused: "${e1}"`);
	if (!/insufficient PAYUSD/.test(e1))
		throw new Error(`expected insufficient, got "${e1}"`);

	// Guard: recipient with no trustline.
	const c = Keypair.random();
	await fund(c); // funded but does NOT trust PAYUSD
	let e2 = "";
	try {
		await sendAsset(wA, c.publicKey(), asset, "1");
	} catch (e) {
		e2 = (e as Error).message;
	}
	log(`send to no-trustline recipient refused: "${e2}"`);
	if (!/no PAYUSD trustline/.test(e2))
		throw new Error(`expected trustline refusal, got "${e2}"`);

	const h = await history(kpB.publicKey(), "stellar:testnet", 5);
	log(
		`B history: ${h.length} payment(s); newest ${h[0]?.direction} ${h[0]?.amount} ${h[0]?.asset}`,
	);
	if (!(h.length >= 1 && h[0]?.direction === "received"))
		throw new Error("history should show the received payment");

	console.log(
		"\nPASS — setup + trustline live; a real send moved balance A→B; over-spend and no-trustline recipient refused; history reads the transfer.",
	);
	process.exit(0);
}

main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
