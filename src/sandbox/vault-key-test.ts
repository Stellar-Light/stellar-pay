/**
 * The vault owner key does not sit in plaintext next to the agent key.
 *
 * It used to. `ownerPasskeyPem` lived in sessions.json in the clear, and the
 * owner sits on the smart account's Default rule — the one rule that cannot
 * carry a spending-limit policy. So read access to that file was the owner
 * role, uncapped, while the *wallet* secret beside it had been encrypted since
 * day one. Same file, same OS store available, opposite treatment.
 *
 * Offline: no network, no chain, no vault deployment. This checks the storage
 * contract only — where the key lives and what happens when it cannot be
 * stored safely.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STELLAR_PAY_SESSION_DIR = mkdtempSync(join(tmpdir(), "sp-vault-"));

const { putVault, getVault, sessionPaths } = await import(
	"../pay/session-store.js"
);
const { hasOsStore, getOsSecret, deleteOsSecret } = await import(
	"../pay/keystore.js"
);

let ok = 0;
let bad = 0;
const check = (pass: boolean, label: string) => {
	console.log(`  ${pass ? "✓" : "✗"} ${label}`);
	pass ? ok++ : bad++;
};

const FAKE_PEM =
	"-----BEGIN PRIVATE KEY-----\nFAKEKEYMATERIAL\n-----END PRIVATE KEY-----";
const SLOT = "vault-owner-passkey";
deleteOsSecret(SLOT);

// A legacy record: the owner key in the clear, exactly as vaults were written.
putVault({
	contractId: `C${"A".repeat(55)}`,
	network: "stellar:testnet",
	ownerPasskeyPem: FAKE_PEM,
	ownerCredentialId: "cred",
	agentPublicKey: `G${"B".repeat(55)}`,
	tokenContract: `C${"D".repeat(55)}`,
	capStroops: "10000000",
	periodLedgers: 17280,
	createdAt: new Date().toISOString(),
});
check(
	readFileSync(sessionPaths.file, "utf8").includes("FAKEKEYMATERIAL"),
	"setup: a legacy record really does hold the key in plaintext",
);

// Reading the owner key migrates it out — the only moment we know the machine
// can produce the value, so the only moment we can move it unattended.
const { __ownerKeyOfForTest } = await import("../pay/vault.js");
// A store can be present but not writable (locked keychain, headless keyring,
// restricted host). Both cases must behave identically: refuse, or accept an
// explicit opt-in. Probe by attempting the migration once.
let storeUsable = false;
try {
	__ownerKeyOfForTest(getVault() as never);
	storeUsable = getOsSecret(SLOT) !== null;
} catch {
	storeUsable = false;
}
if (!storeUsable) {
	console.log(
		"  · OS secret store unavailable or not writable here — asserting the REFUSAL path",
	);
	let threw = "";
	try {
		delete process.env.STELLAR_PAY_ALLOW_PLAINTEXT_VAULT;
		__ownerKeyOfForTest(getVault() as never);
	} catch (e) {
		threw = (e as Error).message;
	}
	check(
		/PLAINTEXT/i.test(threw),
		"with no OS store and no opt-in, operating the vault REFUSES rather than using the plaintext key",
	);
	process.env.STELLAR_PAY_ALLOW_PLAINTEXT_VAULT = "1";
	check(
		__ownerKeyOfForTest(getVault() as never) === FAKE_PEM,
		"an explicit opt-in still works (the operator accepted the risk, in writing)",
	);
} else {
	const got = __ownerKeyOfForTest(getVault() as never);
	check(got === FAKE_PEM, "the key still reads back correctly after migration");
	check(
		getOsSecret(SLOT) === FAKE_PEM,
		`the key now lives in the OS secret store`,
	);
	check(
		!readFileSync(sessionPaths.file, "utf8").includes("FAKEKEYMATERIAL"),
		"and it is GONE from sessions.json — migration is one-way",
	);
	check(
		__ownerKeyOfForTest(getVault() as never) === FAKE_PEM,
		"a second read works from the store alone (no legacy copy left to fall back on)",
	);
	deleteOsSecret(SLOT);
}

// ── THE CREATE PATH ────────────────────────────────────────────────────────
// The first version of this test only exercised MIGRATION (a legacy record
// with a plaintext key), so it stayed green while `createVault` stored the key
// NOWHERE — the record had dropped it and nothing wrote it to the store. A
// fresh vault was bricked on its first draw and every test passed. Storing the
// key is a claim; this checks the claim is true. Source-level because the
// create path deploys a smart account, which an offline test cannot do.
{
	const src = readFileSync(new URL("../pay/vault.ts", import.meta.url), "utf8");
	const start = src.indexOf("export async function createVault");
	const end = src.indexOf("export async function drawFromVault");
	const createBody = start >= 0 && end > start ? src.slice(start, end) : "";
	check(
		createBody.length > 0 && /putOsSecret\(\s*OWNER_SLOT/.test(createBody),
		"createVault writes the owner key to the OS store (not just a comment saying it does)",
	);
	check(
		/STELLAR_PAY_ALLOW_PLAINTEXT_VAULT/.test(createBody),
		"and when it cannot, creation refuses unless the operator opted in",
	);
	check(
		/ownerPasskeyPem: passkey\.privateKeyPem/.test(createBody),
		"the plaintext fallback survives for that explicit opt-in (not a dead end)",
	);
}

console.log(
	`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`} — ${ok}/${ok + bad}`,
);
process.exit(bad === 0 ? 0 : 1);
