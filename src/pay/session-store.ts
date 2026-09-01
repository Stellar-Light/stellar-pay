/**
 * Persistent session state for MPP channel mode.
 *
 * Two things live here, both file-backed under the same config dir as the
 * keystore (~/.config/stellar-pay/sessions.json):
 *
 * 1. A `Store` (mppx contract: get/put/delete) the channel CLIENT uses to
 *    persist its last-signed cumulative per channel. The SDK's warning is
 *    load-bearing: without persistence, a restarted client re-baselines from
 *    the server's reported cumulative — a malicious server could then walk
 *    the cumulative backward or forward between restarts. With it, "the value
 *    the client signs always derives from what it has already signed."
 *
 * 2. A channel REGISTRY per (host → channel): contract address, commitment
 *    seed, funder, recipient, deposit — what `--session` needs to reuse a
 *    channel instead of opening a new one per process.
 *
 * Receipts note (the research goal): every registry mutation is appended to
 * receipts.jsonl alongside — open/reuse/settle events with dated hashes —
 * the attribution-ready ledger's first rows. Append-only, one JSON per line.
 */
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Resolved lazily so tests can point STELLAR_PAY_SESSION_DIR at an isolated
// dir before first use (imports hoist; a module-load const would bind early).
const dir = () =>
	process.env.STELLAR_PAY_SESSION_DIR ??
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"stellar-pay",
	);
const file = () => join(dir(), "sessions.json");
const receiptsFile = () => join(dir(), "receipts.jsonl");

type SessionFile = {
	/** mppx client store keys (cumulative baselines etc.) */
	store: Record<string, unknown>;
	/** the install's vault (v1: one) — see pay/vault.ts for the honesty note
	 * about the owner-passkey PEM living here in plaintext */
	vault?: Record<string, unknown>;
	/** host → channel registry */
	channels: Record<
		string,
		{
			contract: string;
			/** hex ed25519 seed for the commitment key — session-scoped, NOT the
			 * wallet key; compromise loses at most the channel's remaining
			 * deposit, and only to the channel's own recipient. */
			commitmentSeedHex: string;
			funder: string;
			recipient: string;
			depositStroops: string;
			network: string;
			openedAt: string;
			openTx?: string;
			/** last signed cumulative (stroops, string) — kept by sessionFetch */
			lastCumulative?: string;
		}
	>;
};

function read(): SessionFile {
	try {
		return JSON.parse(readFileSync(file(), "utf8")) as SessionFile;
	} catch {
		return { store: {}, channels: {} };
	}
}

/** Atomic-enough for a single-user CLI: write temp, rename over. */
function write(data: SessionFile) {
	mkdirSync(dirname(file()), { recursive: true, mode: 0o700 });
	const tmp = `${file()}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
	renameSync(tmp, file());
}

/** mppx Store contract, file-backed. */
export function fileStore() {
	return {
		async get(key: string) {
			return read().store[key] ?? null;
		},
		async put(key: string, value: unknown) {
			const d = read();
			d.store[key] = value;
			write(d);
		},
		async delete(key: string) {
			const d = read();
			delete d.store[key];
			write(d);
		},
	};
}

export function getChannel(host: string) {
	return read().channels[host] ?? null;
}

export function listChannels() {
	return read().channels;
}

export function getVault(): import("./vault.js").VaultRecord | null {
	return (read().vault as import("./vault.js").VaultRecord | undefined) ?? null;
}

/** Overwrite the stored vault record. Distinct from putVault, which refuses
 *  to replace an existing vault — this is for in-place edits to the one that
 *  is already there (migrating the owner key out of plaintext). */
export function updateVault(v: Record<string, unknown>) {
	const d = read();
	d.vault = v;
	write(d);
}

export function putVault(v: Record<string, unknown>) {
	const d = read();
	if (d.vault) throw new Error("vault already exists");
	d.vault = v;
	write(d);
}

/** Silent field update — no receipt row (receipts mark EVENTS, not bookkeeping). */
export function updateChannel(
	host: string,
	patch: Partial<SessionFile["channels"][string]>,
) {
	const d = read();
	const c = d.channels[host];
	if (!c) return;
	d.channels[host] = { ...c, ...patch };
	write(d);
}

export function putChannel(
	host: string,
	channel: SessionFile["channels"][string],
) {
	const d = read();
	d.channels[host] = channel;
	write(d);
	// No raw ledger write here: openChannel records the proper content-
	// addressed channel-open receipt — a second id-less event row was a
	// duplicate the tamper check rightly flagged.
}

export function dropChannel(host: string, reason: string) {
	const d = read();
	const c = d.channels[host];
	delete d.channels[host];
	write(d);
	if (c) void reason; // callers record the drop via receipts.record with an id
}

/** Append-only dated receipt rows — the ledger's first substrate. */
export function receipt(row: Record<string, unknown>) {
	mkdirSync(dir(), { recursive: true, mode: 0o700 });
	appendFileSync(
		receiptsFile(),
		`${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`,
		{ mode: 0o600 },
	);
}

export const sessionPaths = {
	get file() {
		return file();
	},
	get receipts() {
		return receiptsFile();
	},
};
