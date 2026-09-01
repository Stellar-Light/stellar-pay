/** macOS Keychain backend round-trip — proves the secret still stores and
 * reads back now that it goes in on stdin instead of argv. macOS only.
 *
 * WHY THERE IS A CI MODE (2026-09-01). The production item is stored with
 * `-T ""` (no pre-trusted app), so every read raises macOS's "allow access?"
 * dialog. That is the per-signature presence gate and it is correct — on a
 * person's machine. On a headless runner nobody can click it: this test
 * blocked forever on the read, the job had no timeout, and five such hangs
 * consumed the org's entire macOS concurrency allowance, so every later macOS
 * job sat on "Waiting for a runner" behind our own stuck jobs. Two days of
 * "Queued" badges were this file.
 *
 * On GitHub Actions only, the test: (1) creates a throwaway keychain it knows
 * the password to and makes it the default, so the real addAccount() path
 * writes there, and (2) opts into the keystore's headless flag so the item
 * pre-trusts the `security` tool and the real exportSecret() path reads back
 * without a dialog. Run locally, none of that happens and the prompt fires —
 * which is the manual verification that the gate still exists.
 */
import { execFileSync } from "node:child_process";
import { Keypair } from "@stellar/stellar-sdk";

if (process.platform !== "darwin") {
	console.log("SKIP — keychain backend is macOS-only");
	process.exit(0);
}

const CI = process.env.GITHUB_ACTIONS === "true";
const KC = `${process.env.RUNNER_TEMP ?? "/tmp"}/stellar-pay-ci-${process.pid}.keychain-db`;
const KC_PW = "throwaway-ci-keychain";
const sec = (...args: string[]) =>
	execFileSync("security", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

if (CI) {
	process.env.STELLAR_PAY_KEYCHAIN_HEADLESS = "1";
	sec("create-keychain", "-p", KC_PW, KC);
	sec("set-keychain-settings", KC); // no auto-lock, no lock-on-sleep
	sec("unlock-keychain", "-p", KC_PW, KC);
	// Prepend to the search list (keep whatever was there) and make it default,
	// so add-generic-password writes here and find-generic-password looks here.
	const existing = sec("list-keychains", "-d", "user")
		.split("\n")
		.map((l) => l.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);
	sec("list-keychains", "-d", "user", "-s", KC, ...existing);
	sec("default-keychain", "-s", KC);
	console.log(`  CI mode: throwaway keychain ${KC}`);
}

process.env.STELLAR_PAY_KEYSTORE = `/tmp/kc-${process.pid}.json`;
const { addAccount, exportSecret, removeAccount } = await import(
	"../pay/keystore.js"
);
const kp = Keypair.random();
let ok = false;
try {
	await addAccount("kctest", kp.secret(), "stellar:testnet", {
		backend: "keychain",
	});
	const got = await exportSecret("kctest");
	ok = got === kp.secret();
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
} finally {
	if (CI) {
		try {
			sec("delete-keychain", KC);
		} catch {
			/* runner is ephemeral anyway */
		}
	}
}
console.log(
	ok
		? "\nPASS — keychain stores and returns the secret with stdin input"
		: "\nFAIL",
);
process.exit(ok ? 0 : 1);
