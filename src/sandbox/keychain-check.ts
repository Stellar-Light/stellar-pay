/** macOS Keychain backend round-trip — proves the secret still stores and
 * reads back now that it goes in on stdin instead of argv. macOS only. */
import { Keypair } from "@stellar/stellar-sdk";

if (process.platform !== "darwin") {
	console.log("SKIP — keychain backend is macOS-only");
	process.exit(0);
}
process.env.STELLAR_PAY_KEYSTORE = `/tmp/kc-${process.pid}.json`;
const { addAccount, exportSecret, removeAccount } = await import(
	"../pay/keystore.js"
);
const kp = Keypair.random();
await addAccount("kctest", kp.secret(), "stellar:testnet", {
	backend: "keychain",
});
const got = await exportSecret("kctest");
const ok = got === kp.secret();
if (!ok) {
	console.log(
		`    sent : ${kp.secret().slice(0, 8)}… len ${kp.secret().length}`,
	);
	console.log(
		`    got  : ${String(got).slice(0, 8)}… len ${String(got).length}`,
	);
}
console.log(`  keychain round-trip: ${ok ? "OK" : "MISMATCH"}`);
removeAccount("kctest");
console.log("  removed from keychain");
console.log(
	ok
		? "\nPASS — keychain stores and returns the secret with stdin input"
		: "\nFAIL",
);
process.exit(ok ? 0 : 1);
