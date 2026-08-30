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
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
	// mode ON THE WRITE, not a chmod after it: writeFileSync creates the file at
	// the process umask first, so a group/world-readable window existed between
	// the two calls on every save. (The contents are encrypted; the window is
	// still free to close.)
	writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
	chmodSync(FILE, 0o600); // idempotent: an EXISTING file keeps its old mode
}

// --- OS keychain backend (macOS `security`; no native dependency) --------------
// pay.sh's "gated payments" goal: the secret lives in the OS keychain, which
// the OS guards, instead of a passphrase-encrypted file. A per-signature Touch
// ID prompt needs a native Security-framework binding (roadmap); this gives
// keychain storage and its access controls today, with no plaintext on disk.

const KC_ACCOUNT = "stellar-pay";
const kcService = (name: string) => `stellar-pay:${name}`;

/**
 * Which OS secret store this machine can use.
 *
 *  - darwin  : Keychain via `security`, written with NO pre-trusted app, so
 *              every read demands Touch ID / the login password.
 *  - linux   : libsecret via `secret-tool` (GNOME Keyring, KWallet via the
 *              Secret Service API) — unlocked with the login keyring.
 *  - win32   : DPAPI via PowerShell. The ciphertext is bound to this Windows
 *              user account and machine, so the stored blob is useless if the
 *              file is copied elsewhere. (Credential Manager cannot read a
 *              secret back out from the CLI, so DPAPI is the usable primitive.)
 */
function osStore(): "security" | "secret-tool" | "dpapi" | null {
	if (process.platform === "darwin") return "security";
	if (process.platform === "win32") return "dpapi";
	if (process.platform === "linux") {
		try {
			execFileSync("secret-tool", ["--version"], { stdio: "ignore" });
			return "secret-tool";
		} catch {
			return null; // libsecret not installed
		}
	}
	return null;
}

const keychainAvailable = osStore() !== null;

/** Human name for the backend, for errors and `account list`. */
export function osStoreName(): string {
	switch (osStore()) {
		case "security":
			return "macOS Keychain";
		case "secret-tool":
			return "libsecret (GNOME Keyring / KWallet)";
		case "dpapi":
			return "Windows DPAPI";
		default:
			return "none";
	}
}

/** PowerShell one-liner runner for the Windows path. */
function pwsh(script: string, input?: string): string {
	const exe = process.env.SystemRoot
		? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
		: "powershell.exe";
	return execFileSync(
		exe,
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ input, encoding: "utf8" },
	).trim();
}

/** Where the DPAPI ciphertext lives (the secret itself never lands here). */
const dpapiFile = (name: string) =>
	join(dirname(FILE), `dpapi-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`);

function keychainSet(name: string, secret: string): void {
	const store = osStore();
	if (!store)
		throw new Error(
			process.platform === "linux"
				? "no OS secret store found: install libsecret (`apt install libsecret-tools`) or use the encrypted file (STELLAR_PAY_PASSPHRASE)"
				: "no OS secret store on this platform; use the encrypted file (STELLAR_PAY_PASSPHRASE)",
		);
	if (store === "secret-tool") {
		// Password on STDIN, never argv.
		execFileSync(
			"secret-tool",
			[
				"store",
				"--label",
				`stellar-pay ${name}`,
				"service",
				kcService(name),
				"account",
				KC_ACCOUNT,
			],
			{ input: secret, stdio: ["pipe", "ignore", "ignore"] },
		);
		return;
	}
	if (store === "dpapi") {
		// DPAPI-encrypt under THIS user; only the ciphertext touches disk.
		mkdirSync(dirname(FILE), { recursive: true });
		const out = dpapiFile(name).replace(/\\/g, "\\\\");
		pwsh(
			`$s = [Console]::In.ReadToEnd().Trim(); ` +
				`$sec = ConvertTo-SecureString $s -AsPlainText -Force; ` +
				`ConvertFrom-SecureString $sec | Set-Content -Path "${out}" -Encoding ascii`,
			secret,
		);
		return;
	}
	// The secret goes in on STDIN, never as an argument: an argv value is
	// visible in the process table to everything on the machine and can surface
	// in error text. `security` prompts twice ("password data" / "retype"), so
	// send it twice. -U updates an existing item.
	execFileSync(
		"security",
		[
			"add-generic-password",
			"-a",
			KC_ACCOUNT,
			"-s",
			kcService(name),
			// -T "" means NO application is pre-trusted to read this item, so
			// macOS demands user authorization on every read — Touch ID where the
			// machine has it, the login password otherwise. That is the
			// per-signature presence gate; without it the keychain is only
			// storage, and any process running as this user could read the seed
			// silently.
			"-T",
			"",
			// -U MUST precede -w: `-w` consumes the NEXT argv token as the
			// password, so ["-w","-U"] silently stored the literal string "-U".
			"-U",
			"-w",
		],
		{ input: `${secret}\n${secret}\n`, stdio: ["pipe", "ignore", "ignore"] },
	);
}
function keychainGet(name: string): string {
	const store = osStore();
	if (store === "secret-tool")
		return execFileSync(
			"secret-tool",
			["lookup", "service", kcService(name), "account", KC_ACCOUNT],
			{ encoding: "utf8" },
		).trim();
	if (store === "dpapi") {
		const f = dpapiFile(name).replace(/\\/g, "\\\\");
		return pwsh(
			`$e = Get-Content -Path "${f}" -Raw; ` +
				`$sec = ConvertTo-SecureString $e; ` +
				`[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))`,
		);
	}
	return execFileSync(
		"security",
		["find-generic-password", "-a", KC_ACCOUNT, "-s", kcService(name), "-w"],
		{ encoding: "utf8" },
	).trim();
}
function keychainDelete(name: string): void {
	const store = osStore();
	if (store === "secret-tool") {
		try {
			execFileSync(
				"secret-tool",
				["clear", "service", kcService(name), "account", KC_ACCOUNT],
				{ stdio: "ignore" },
			);
		} catch {
			// already gone
		}
		return;
	}
	if (store === "dpapi") {
		try {
			rmSync(dpapiFile(name), { force: true });
		} catch {
			// already gone
		}
		return;
	}
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
	opts: {
		makeDefault?: boolean;
		backend?: "file" | "keychain";
		force?: boolean;
	} = {},
): Promise<{ name: string; publicKey: string; backend: "file" | "keychain" }> {
	const kp = Keypair.fromSecret(secret); // validates
	const st = read();
	if (st.accounts[name] && !opts.force)
		throw new Error(
			`account "${name}" already exists — pass --force to replace it (the old secret is unrecoverable afterwards)`,
		);
	// Replacing a keychain-backed account must clear the OS item too, or the
	// old secret lingers under the same service name.
	if (st.accounts[name]?.backend === "keychain") keychainDelete(name);
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

// The keychain item is keyed on the account NAME, so read it by name — not by
// re-deriving the name from the public key (two accounts can share a secret and
// resolve to the wrong keychain entry).
async function readSecret(name: string, acct: Account): Promise<string> {
	if (acct.backend === "keychain") return keychainGet(name);
	if (!acct.sealed) throw new Error("account has no stored secret");
	return unseal(acct.sealed, await passphrase());
}

export async function exportSecret(name?: string): Promise<string> {
	const st = read();
	const key = name ?? st.default;
	const acct = key ? st.accounts[key] : undefined;
	if (!key || !acct) throw new Error(`no account "${key ?? "(default)"}"`);
	return readSecret(key, acct);
}

/**
 * Ensure STELLAR_SECRET_KEY is set for the rest of the process: env wins; else
 * decrypt the default keystore account and export it into the environment for
 * this run only. Returns false if no wallet is available at all.
 */
export async function ensureSecretLoaded(name?: string): Promise<boolean> {
	// An explicitly named account beats everything, including a secret already
	// in the environment: `--account work` must mean work, not "whatever the
	// shell happens to export".
	if (name) {
		const s = read();
		const acct = s.accounts[name];
		if (!acct)
			throw new Error(
				`no account "${name}" — \`stellar-pay account list\` shows the saved ones`,
			);
		process.env.STELLAR_SECRET_KEY = await readSecret(name, acct);
		// The account's own network wins for that account, unless the caller
		// asked for one explicitly (--sandbox sets this before we run).
		if (!process.env.STELLAR_NETWORK)
			process.env.STELLAR_NETWORK = acct.network;
		return true;
	}
	if (process.env.STELLAR_SECRET_KEY) return true;
	const s = read();
	const acct = s.default ? s.accounts[s.default] : undefined;
	if (!s.default || !acct) return false;
	process.env.STELLAR_SECRET_KEY = await readSecret(s.default, acct);
	if (!process.env.STELLAR_NETWORK) process.env.STELLAR_NETWORK = acct.network;
	return true;
}

/** Public key of a saved account, without unlocking it. */
export function accountPublicKey(name: string): string | null {
	return read().accounts[name]?.publicKey ?? null;
}

export const keystorePath = FILE;
