/**
 * A local encrypted keystore so a wallet secret isn't pasted on every command.
 *
 * The secret is sealed with AES-256-GCM under a key derived from a passphrase
 * (scrypt) — Node built-ins only, no dependency, no plaintext key on disk. The
 * passphrase is the user's; this file never originates or logs it. `pay` uses
 * the OS keychain (Touch ID); an encrypted file is the cross-platform
 * equivalent that needs no native module.
 *
 * Resolution order for a wallet secret, so existing setups keep working:
 *   1. STELLAR_SECRET_KEY in the environment (unchanged)
 *   2. the default keystore account, unlocked with STELLAR_PAY_PASSPHRASE
 *      (env, for agents/MCP) or an interactive prompt (a TTY).
 */
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Keypair } from "@stellar/stellar-sdk";
import type { Network } from "./wallet.js";

type Sealed = { salt: string; iv: string; tag: string; ciphertext: string };
type Account = { publicKey: string; network: Network; sealed: Sealed };
type Store = {
	version: 1;
	default: string | null;
	accounts: Record<string, Account>;
};

const FILE =
	process.env.STELLAR_PAY_KEYSTORE ??
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"stellar-pay",
		"keystore.json",
	);

function read(): Store {
	try {
		return JSON.parse(readFileSync(FILE, "utf8")) as Store;
	} catch {
		return { version: 1, default: null, accounts: {} };
	}
}
function write(s: Store): void {
	mkdirSync(dirname(FILE), { recursive: true });
	writeFileSync(FILE, JSON.stringify(s, null, 2));
	chmodSync(FILE, 0o600); // owner-only, even though the secret is encrypted
}

function seal(secret: string, passphrase: string): Sealed {
	const salt = randomBytes(16);
	const key = scryptSync(passphrase, salt, 32);
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([c.update(secret, "utf8"), c.final()]);
	return {
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: c.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}
function unseal(s: Sealed, passphrase: string): string {
	const key = scryptSync(passphrase, Buffer.from(s.salt, "base64"), 32);
	const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
	d.setAuthTag(Buffer.from(s.tag, "base64"));
	try {
		return Buffer.concat([
			d.update(Buffer.from(s.ciphertext, "base64")),
			d.final(),
		]).toString("utf8");
	} catch {
		throw new Error("wrong passphrase (decryption failed)");
	}
}

async function prompt(q: string, hidden = false): Promise<string> {
	if (!process.stdin.isTTY)
		throw new Error(
			"no passphrase: set STELLAR_PAY_PASSPHRASE, or run this in a terminal",
		);
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	if (hidden) {
		// Mask keystrokes: readline calls _writeToOutput for every echo; while
		// answering, swallow everything except the prompt itself.
		let masking = false;
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
			(str: string) => {
				if (!masking || str === q) process.stderr.write(str);
			};
		masking = true;
		const a = await rl.question(q);
		process.stderr.write("\n");
		rl.close();
		return a;
	}
	const a = await rl.question(q);
	rl.close();
	return a;
}

async function passphrase(confirm = false): Promise<string> {
	const env = process.env.STELLAR_PAY_PASSPHRASE;
	if (env) return env;
	const p = await prompt("passphrase: ", true);
	if (confirm && (await prompt("confirm passphrase: ", true)) !== p)
		throw new Error("passphrases did not match");
	if (!p) throw new Error("passphrase must not be empty");
	return p;
}

export async function addAccount(
	name: string,
	secret: string,
	network: Network,
	makeDefault?: boolean,
): Promise<{ name: string; publicKey: string }> {
	const kp = Keypair.fromSecret(secret); // validates
	const s = read();
	if (s.accounts[name]) throw new Error(`account "${name}" already exists`);
	const pass = await passphrase(true);
	s.accounts[name] = {
		publicKey: kp.publicKey(),
		network,
		sealed: seal(secret, pass),
	};
	if (makeDefault || s.default === null) s.default = name;
	write(s);
	return { name, publicKey: kp.publicKey() };
}

export function listAccounts(): {
	default: string | null;
	accounts: Array<{ name: string; publicKey: string; network: Network }>;
} {
	const s = read();
	return {
		default: s.default,
		accounts: Object.entries(s.accounts).map(([name, a]) => ({
			name,
			publicKey: a.publicKey,
			network: a.network,
		})),
	};
}

export function setDefault(name: string): void {
	const s = read();
	if (!s.accounts[name]) throw new Error(`no account "${name}"`);
	s.default = name;
	write(s);
}

export function removeAccount(name: string): void {
	const s = read();
	if (!s.accounts[name]) throw new Error(`no account "${name}"`);
	delete s.accounts[name];
	if (s.default === name) s.default = Object.keys(s.accounts)[0] ?? null;
	write(s);
}

export async function exportSecret(name?: string): Promise<string> {
	const s = read();
	const key = name ?? s.default;
	if (!key || !s.accounts[key])
		throw new Error(`no account "${key ?? "(default)"}"`);
	return unseal(s.accounts[key].sealed, await passphrase());
}

/**
 * Ensure STELLAR_SECRET_KEY is set for the rest of the process: env wins; else
 * decrypt the default keystore account and export it into the environment for
 * this run only. Returns false if no wallet is available at all.
 */
export async function ensureSecretLoaded(): Promise<boolean> {
	if (process.env.STELLAR_SECRET_KEY) return true;
	const s = read();
	const acct = s.default ? s.accounts[s.default] : undefined;
	if (!acct) return false;
	process.env.STELLAR_SECRET_KEY = unseal(acct.sealed, await passphrase());
	if (!process.env.STELLAR_NETWORK) process.env.STELLAR_NETWORK = acct.network;
	return true;
}

export const keystorePath = FILE;
