/**
 * A local encrypted keystore so a wallet secret isn't pasted on every command.
 *
 * Two backends, same goal as pay.sh's gated payments — the key is never pasted
 * per command and never sits in plaintext:
 *   - file: sealed with AES-256-GCM under a scrypt-derived passphrase key (Node
 *     built-ins, cross-platform, no dependency).
 *   - keychain: the secret lives in the macOS Keychain, guarded by the OS, no
 *     passphrase. (`--keychain`; a per-signature Touch ID prompt is the native
 *     Security-framework upgrade.)
 *
 * Resolution order for a wallet secret, so existing setups keep working:
 *   1. STELLAR_SECRET_KEY in the environment (unchanged)
 *   2. the default keystore account, unlocked with STELLAR_PAY_PASSPHRASE
 *      (env, for agents/MCP) or an interactive prompt (a TTY).
 */
import { execFileSync } from "node:child_process";
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
// A file account seals the secret under a passphrase; a keychain account keeps
// the secret in the OS keychain (macOS Keychain today) and stores no ciphertext.
type Account = {
	publicKey: string;
	network: Network;
	backend?: "file" | "keychain";
	sealed?: Sealed;
};
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

// --- OS keychain backend (macOS `security`; no native dependency) --------------
// pay.sh's "gated payments" goal: the secret lives in the OS keychain, which
// the OS guards, instead of a passphrase-encrypted file. A per-signature Touch
// ID prompt needs a native Security-framework binding (roadmap); this gives
// keychain storage and its access controls today, with no plaintext on disk.

const keychainAvailable = process.platform === "darwin";
const KC_ACCOUNT = "stellar-pay";
const kcService = (name: string) => `stellar-pay:${name}`;

function keychainSet(name: string, secret: string): void {
	if (!keychainAvailable)
		throw new Error(
			"the keychain backend is macOS-only; use the encrypted file (STELLAR_PAY_PASSPHRASE)",
		);
	// -U updates an existing item; the secret is passed as an argument, briefly
	// visible to `ps` — acceptable for an alpha, and the native binding removes it.
	execFileSync(
		"security",
		[
			"add-generic-password",
			"-a",
			KC_ACCOUNT,
			"-s",
			kcService(name),
			"-w",
			secret,
			"-U",
		],
		{ stdio: "ignore" },
	);
}
function keychainGet(name: string): string {
	return execFileSync(
		"security",
		["find-generic-password", "-a", KC_ACCOUNT, "-s", kcService(name), "-w"],
		{ encoding: "utf8" },
	).trim();
}
function keychainDelete(name: string): void {
	try {
		execFileSync(
			"security",
			["delete-generic-password", "-a", KC_ACCOUNT, "-s", kcService(name)],
			{ stdio: "ignore" },
		);
	} catch {
		// already gone
	}
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
	opts: { makeDefault?: boolean; backend?: "file" | "keychain" } = {},
): Promise<{ name: string; publicKey: string; backend: "file" | "keychain" }> {
	const kp = Keypair.fromSecret(secret); // validates
	const st = read();
	if (st.accounts[name]) throw new Error(`account "${name}" already exists`);
	const backend = opts.backend ?? "file";
	if (backend === "keychain") {
		keychainSet(name, secret); // OS keychain holds the secret; no ciphertext on disk
		st.accounts[name] = { publicKey: kp.publicKey(), network, backend };
	} else {
		st.accounts[name] = {
			publicKey: kp.publicKey(),
			network,
			backend,
			sealed: seal(secret, await passphrase(true)),
		};
	}
	if (opts.makeDefault || st.default === null) st.default = name;
	write(st);
	return { name, publicKey: kp.publicKey(), backend };
}

export function listAccounts(): {
	default: string | null;
	accounts: Array<{
		name: string;
		publicKey: string;
		network: Network;
		backend: "file" | "keychain";
	}>;
} {
	const st = read();
	return {
		default: st.default,
		accounts: Object.entries(st.accounts).map(([name, a]) => ({
			name,
			publicKey: a.publicKey,
			network: a.network,
			backend: a.backend ?? "file",
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
	const st = read();
	const acct = st.accounts[name];
	if (!acct) throw new Error(`no account "${name}"`);
	if (acct.backend === "keychain") keychainDelete(name);
	delete st.accounts[name];
	if (st.default === name) st.default = Object.keys(st.accounts)[0] ?? null;
	write(st);
}

async function readSecret(acct: Account): Promise<string> {
	if (acct.backend === "keychain") return keychainGet(nameOf(acct));
	if (!acct.sealed) throw new Error("account has no stored secret");
	return unseal(acct.sealed, await passphrase());
}

// keychain items key on the account name; recover it from the store.
function nameOf(acct: Account): string {
	const st = read();
	const entry = Object.entries(st.accounts).find(
		([, a]) => a === acct || a.publicKey === acct.publicKey,
	);
	if (!entry) throw new Error("account not found in keystore");
	return entry[0];
}

export async function exportSecret(name?: string): Promise<string> {
	const st = read();
	const key = name ?? st.default;
	const acct = key ? st.accounts[key] : undefined;
	if (!acct) throw new Error(`no account "${key ?? "(default)"}"`);
	return readSecret(acct);
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
	process.env.STELLAR_SECRET_KEY = await readSecret(acct);
	if (!process.env.STELLAR_NETWORK) process.env.STELLAR_NETWORK = acct.network;
	return true;
}

export const keystorePath = FILE;
