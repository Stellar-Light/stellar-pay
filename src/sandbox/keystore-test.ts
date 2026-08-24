/**
 * Keystore round-trip without a TTY: seal a secret under a passphrase, list it
 * (never the secret), export it back, and prove a wrong passphrase fails and
 * ensureSecretLoaded populates the environment. Uses a temp keystore file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

process.env.STELLAR_PAY_KEYSTORE = join(
	mkdtempSync(join(tmpdir(), "sp-ks-")),
	"keystore.json",
);
process.env.STELLAR_PAY_PASSPHRASE = "correct horse battery staple";
delete process.env.STELLAR_SECRET_KEY;

const {
	addAccount,
	listAccounts,
	exportSecret,
	setDefault,
	removeAccount,
	ensureSecretLoaded,
	keystorePath,
} = await import("../pay/keystore.js");

const log = (m: string) => console.log(`  ${m}`);

async function main() {
	console.log(
		"keystore-test — seal, list, export, wrong-pass, ensureSecretLoaded\n",
	);
	const a = Keypair.random();
	const b = Keypair.random();
	await addAccount("main", a.secret(), "stellar:pubnet", { makeDefault: true });
	await addAccount("alt", b.secret(), "stellar:testnet");
	const list = listAccounts();
	log(
		`accounts: ${list.accounts.map((x) => `${x.name}=${x.publicKey.slice(0, 6)}…`).join(", ")}  default=${list.default}`,
	);
	if (list.default !== "main" || list.accounts.length !== 2)
		throw new Error("list/default wrong");
	if (JSON.stringify(list).includes(a.secret()))
		throw new Error("secret leaked into the listing!");

	const got = await exportSecret("main");
	log(`export main → ${got.slice(0, 4)}… matches: ${got === a.secret()}`);
	if (got !== a.secret()) throw new Error("export did not round-trip");

	process.env.STELLAR_PAY_PASSPHRASE = "wrong";
	let failed = "";
	try {
		await exportSecret("main");
	} catch (e) {
		failed = (e as Error).message;
	}
	log(`wrong passphrase → "${failed}"`);
	if (!/wrong passphrase/.test(failed))
		throw new Error("wrong passphrase should fail");
	process.env.STELLAR_PAY_PASSPHRASE = "correct horse battery staple";

	setDefault("alt");
	delete process.env.STELLAR_SECRET_KEY;
	await ensureSecretLoaded();
	log(
		`ensureSecretLoaded → STELLAR_SECRET_KEY set: ${!!process.env.STELLAR_SECRET_KEY}, network: ${process.env.STELLAR_NETWORK}`,
	);
	if (process.env.STELLAR_SECRET_KEY !== b.secret())
		throw new Error("ensureSecretLoaded loaded the wrong account");
	if (process.env.STELLAR_NETWORK !== "stellar:testnet")
		throw new Error("network not applied from account");

	removeAccount("alt");
	const after = listAccounts();
	log(
		`removed alt → remaining ${after.accounts.length}, default=${after.default}`,
	);
	if (after.accounts.length !== 1 || after.default !== "main")
		throw new Error("remove/default-reassign wrong");

	// The listing hiding the secret proves nothing about the FILE. Plaintext on
	// disk at mode 0644 used to still print "PASS — no secret in listings".
	{
		const { readFileSync, statSync } = await import("node:fs");
		const raw = readFileSync(keystorePath, "utf8");
		const leaked = raw.includes(a.secret()) || raw.includes(b.secret());
		console.log(
			leaked
				? "  ✗ THE SECRET IS IN PLAINTEXT ON DISK"
				: "  ✓ the secret is not present in the keystore file",
		);
		const mode = statSync(keystorePath).mode & 0o777;
		console.log(
			mode === 0o600
				? "  ✓ keystore file is owner-only (0600)"
				: `  ✗ keystore file mode is ${mode.toString(8)}, expected 600`,
		);
		if (leaked || mode !== 0o600) process.exit(1);
	}

	console.log(
		"\nPASS — encrypted round-trip, secret absent from the listing AND from the file on disk (0600), wrong-pass rejected, env populated, default reassigned.",
	);
	process.exit(0);
}
main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
