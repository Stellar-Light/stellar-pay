#!/usr/bin/env node
/**
 * Working name: stellar-pay. Commands:
 *   curl <url> [-X M] [-H "K: V"]… [-d body] [--yes] [--max-usd N] [--x402|--mpp] [-i]
 *   offers <url> [-X M] [-H …] [-d body]     show what the 402 asks for; pay nothing
 *   verify <url> [-X M] [-d body]          seller check: is this a correct, Stellar-payable 402?
 *   balance | whoami
 *   setup [--trustline]                    new wallet (testnet: funded + trustline), or add trustline to STELLAR_SECRET_KEY
 *   send <G...address|name> --amount <USDC|max> [--yes]   send USDC
 *   history                                recent payments (any asset) to/from the wallet
 *   topup [--buy] [--amount N]             fund this wallet: --buy opens an on-ramp + waits; else QR + address + ramps
 *   account <list|import|default|remove|export> [--name N] [<file>]  manage saved wallets
 *   --account <name>                       run ONE command as that wallet
 *   setup --save <name> [--keychain]       new wallet sealed in the encrypted file, or (macOS) the Keychain
 *   run [--yes --max-usd N] -- <cmd>…      wrap ANY command behind a proxy that pays its 402s
 *   mcp                                    serve the MCP on stdio
 *   claude|codex [args…]                   launch the agent with the MCP mounted
 * Wallet: STELLAR_SECRET_KEY, network: STELLAR_NETWORK (default stellar:pubnet).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { daysAlive, loadCatalog, searchCatalog } from "./catalog.js";
import {
	assignBounty,
	type BountyDescriptor,
	bountyStatus,
	type EvidenceEntry,
	makeCommit,
	makeSubmission,
	type OpenCommit,
	type OpenSubmission,
	postBounty,
	postOpenBounty,
	resolveBounty,
	resolveOpenBounty,
	submitBounty,
} from "./pay/bounty.js";
import { payFetch } from "./pay/curl.js";
import { disputeJob } from "./pay/job.js";
import {
	accountPublicKey,
	addAccount,
	ensureSecretLoaded,
	exportSecret,
	keystorePath,
	listAccounts,
	removeAccount,
	setDefault,
} from "./pay/keystore.js";
import {
	describeOffer,
	isStellar,
	type Offer,
	offerUSD,
	readOffers,
} from "./pay/offers.js";
import {
	autoApprove,
	explorer,
	loadPolicy,
	policyPath,
	resolveHost,
} from "./pay/policy.js";
import {
	BRIDGES,
	CASHOUT_NOTE,
	EXCHANGES,
	onramps,
	partnerRamps,
} from "./pay/ramps.js";
import {
	checkLedger,
	list as listReceipts,
	record,
	verifyOnChain,
} from "./pay/receipts.js";
import {
	addTrustline,
	history,
	payUri,
	pollFunding,
	sendUSDC,
	setupWallet,
	topupInfo,
} from "./pay/send.js";
import {
	closeChannel,
	DEFAULT_DEPOSIT_XLM,
	hostOf,
	openChannel,
	sessionFetch,
} from "./pay/session.js";
import { getChannel, listChannels } from "./pay/session-store.js";
import { blockedTarget, payGuard } from "./pay/ssrf.js";
import {
	createVault,
	drawFromVault,
	topupVault,
	vaultStatus,
} from "./pay/vault.js";
import { verifyEndpoint } from "./pay/verify.js";
import { balances, loadWallet } from "./pay/wallet.js";
import {
	awaitPayout,
	buildFeed,
	fetchFeed,
	type OpenBountyListing,
	submitPacket,
	vetListing,
} from "./pay/worker.js";

type Args = {
	cmd: string;
	url?: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	yes: boolean;
	maxUsd: number;
	prefer?: "x402" | "mpp";
	include: boolean;
	sandbox: boolean;
	amount?: string;
	name?: string;
	trustline: boolean;
	buy: boolean;
	keychain: boolean;
	json: boolean;
	maxUsdSet: boolean;
	/** --account <name>: run this ONE command as a specific saved wallet */
	account?: string;
	/** every bare token, in order — subcommand, paths, etc. */
	positional: string[];
	/** --force: replace an existing account of the same name */
	force: boolean;
	limit?: number;
	/** receipts --verify <id>: prove one ledger row against the chain */
	verifyReceipt?: string;
	/** curl --session: pay via the host's registered one-way channel */
	session: boolean;
	/** session open --deposit <xlm>: channel deposit (default 5) */
	deposit?: number;
	/** bounty verbs */
	title?: string;
	items?: string[];
	instructions?: string;
	amountXlm?: number;
	resolverAddr?: string;
	provider?: string;
	contract?: string;
	capXlm?: number;
	evidenceFile?: string;
	submissionFiles?: string[];
	out?: string;
	token?: string;
	/** worker verbs: feed source, packet inbox, watch timeout */
	fromFeed?: string;
	toUrl?: string;
	submitUrl?: string;
	memo?: string;
	deadlineDays?: number;
	nonce?: string;
	commitFiles?: string[];
	send: boolean;
	timeoutSec?: number;
};

// Documented, stable exit codes so a wrapper script can branch without parsing
// text (gh/clig.dev convention). 0 ok · 2 usage · 3 payment refused/declined ·
// 4 no wallet · 1 generic runtime failure.
const EXIT = { ok: 0, runtime: 1, usage: 2, refused: 3, noWallet: 4 } as const;

/** Commands that forward their remaining argv to a child process, so an
 * unrecognised flag is the CHILD's business, not a usage error of ours. */
const PASSTHROUGH_CMDS = new Set(["claude", "codex", "goose", "mcp", "run"]);

/** Print a usage failure AND set a non-zero code. `return console.error(...)`
 * returns undefined and leaves the exit code at 0, so a scripted caller read a
 * usage error as success. */
function usageError(...msg: unknown[]): void {
	console.error(...(msg as string[]));
	process.exitCode = EXIT.usage;
}

function parse(argv: string[]): Args {
	const a: Args = {
		cmd: argv[0] ?? "help",
		method: "GET",
		headers: {},
		yes: false,
		// Same env var the MCP reads, so an operator's ceiling binds BOTH doors;
		// --max-usd still overrides per-invocation. Falls back to $0.10.
		maxUsd: envCeiling(),
		include: false,
		json: false,
		sandbox: false,
		trustline: false,
		buy: false,
		keychain: false,
		maxUsdSet: false,
		session: false,
		positional: [],
		force: false,
		send: false,
	};
	for (let i = 1; i < argv.length; i++) {
		const t = argv[i] ?? "";
		// Everything after `--` belongs to the wrapped command (`run -- tool
		// --yes` must not flip OUR approval flag).
		if (t === "--") break;
		const next = () => argv[++i] ?? "";
		if (t === "-X") a.method = next().toUpperCase();
		else if (t === "-H") {
			const [k, ...v] = next().split(":");
			if (k) a.headers[k.trim()] = v.join(":").trim();
		} else if (t === "-d" || t === "--data") {
			a.body = next();
			if (a.method === "GET") a.method = "POST";
		} else if (t === "--yes" || t === "-y") a.yes = true;
		else if (t === "--max-usd") {
			const n = Number(next());
			if (Number.isFinite(n) && n > 0) {
				a.maxUsd = n;
				a.maxUsdSet = true;
			} else {
				console.error("--max-usd must be a positive number");
				process.exit(1);
			}
		} else if (t === "--x402") a.prefer = "x402";
		else if (t === "--mpp") a.prefer = "mpp";
		else if (t === "-i" || t === "--include") a.include = true;
		else if (t === "--sandbox") a.sandbox = true;
		else if (t === "--amount") a.amount = next();
		else if (t === "--name" || t === "--save") a.name = next();
		else if (t === "--account") a.account = next();
		else if (t === "--trustline") a.trustline = true;
		else if (t === "--buy") a.buy = true;
		else if (t === "--keychain") a.keychain = true;
		else if (t === "--force") a.force = true;
		else if (t === "--json") a.json = true;
		else if (t === "--limit") {
			const n = Number(next());
			if (Number.isInteger(n) && n > 0) a.limit = n;
		} else if (t === "--verify") a.verifyReceipt = next();
		else if (t === "--session") a.session = true;
		else if (t === "--deposit") {
			const n = Number(next());
			if (Number.isFinite(n) && n > 0) a.deposit = n;
		} else if (t === "--title") a.title = next();
		else if (t === "--items")
			a.items = (next() ?? "").split(",").filter(Boolean);
		else if (t === "--instructions") a.instructions = next();
		else if (t === "--amount-xlm") {
			const n = Number(next());
			if (Number.isFinite(n) && n > 0) a.amountXlm = n;
		} else if (t === "--cap-xlm") {
			const n = Number(next());
			if (Number.isFinite(n) && n > 0) a.capXlm = n;
		} else if (t === "--resolver") a.resolverAddr = next();
		else if (t === "--provider") a.provider = next();
		else if (t === "--contract") a.contract = next();
		else if (t === "--evidence") a.evidenceFile = next();
		else if (t === "--submissions")
			a.submissionFiles = (next() ?? "").split(",").filter(Boolean);
		else if (t === "--out") a.out = next();
		else if (t === "--token") a.token = next();
		else if (t === "--from") a.fromFeed = next();
		else if (t === "--to") a.toUrl = next();
		else if (t === "--submit-url") a.submitUrl = next();
		else if (t === "--memo") a.memo = next();
		else if (t === "--nonce") a.nonce = next();
		else if (t === "--commits")
			a.commitFiles = (next() ?? "").split(",").filter(Boolean);
		else if (t === "--deadline-days") {
			const n = Number(next());
			if (Number.isFinite(n) && n > 0) a.deadlineDays = n;
		} else if (t === "--send") a.send = true;
		else if (t === "--timeout-sec") {
			const n = Number(next());
			if (Number.isFinite(n) && n > 0) a.timeoutSec = n;
		} else if (!t.startsWith("-")) {
			// Keep EVERY bare token in order: the first is the subcommand/url,
			// later ones are paths (`account export --name main backup.json`).
			if (!a.url) a.url = t;
			a.positional.push(t);
		} else if (t === "-h" || t === "--help") {
			// Handled after parse() by the help branch — must never be treated as
			// unknown, or `stellar-pay --help` exits 2 instead of printing help.
		} else if (PASSTHROUGH_CMDS.has(a.cmd)) {
			// The flags belong to the CHILD (`stellar-pay claude --model x`), so we
			// are not entitled to an opinion about them.
		} else {
			// An unrecognised flag is a USAGE ERROR, never something to skip.
			// Silently dropping them meant `--max-usd=0.05` (the = form) left the
			// ceiling at the $0.10 default — a 2x widening of the exact control
			// the user was trying to tighten — and a typo like `--sandox` ran the
			// command against MAINNET. Fail loudly instead, the way every serious
			// CLI parser does.
			const eq = t.indexOf("=");
			const hint =
				eq > 0
					? `did you mean "${t.slice(0, eq)} ${t.slice(eq + 1)}"? (this CLI takes space-separated values, not --flag=value)`
					: 'run "stellar-pay --help" for the flags this command accepts';
			console.error(`unknown option "${t}" — ${hint}`);
			process.exit(EXIT.usage);
		}
	}
	return a;
}

/** The per-call ceiling, from STELLAR_PAY_MAX_USD_PER_CALL (shared with the MCP)
 * or $0.10. A malformed value falls back rather than becoming NaN (fail-open). */
function envCeiling(): number {
	const n = Number(process.env.STELLAR_PAY_MAX_USD_PER_CALL);
	return Number.isFinite(n) && n > 0 ? n : 0.1;
}

/** Emit a result as JSON (agent mode) or hand off to a human-prose printer. */
function emit(a: Args, obj: unknown, human: () => void): void {
	if (a.json) console.log(JSON.stringify(obj, null, 1));
	else human();
}

/** process.env minus every secret, for ANY child we spawn. `ensureSecretLoaded`
 * writes the decrypted wallet secret into process.env, so an inherited
 * environment hands it to whatever we launch. */
function strippedEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) =>
				!/^(STELLAR_SECRET_KEY|STELLAR_PAY_PASSPHRASE|DATABASE_URI)$/i.test(k),
		),
	) as Record<string, string>;
}

function openBrowser(url: string): void {
	const cmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd"
				: "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(cmd, args, {
		stdio: "ignore",
		detached: true,
		env: strippedEnv(),
	}).unref();
}

async function ask(q: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	const ans = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
	rl.close();
	return ans === "y" || ans === "yes";
}

async function cmdMcp(): Promise<void> {
	const { serveStdio } = await import("./mcp.js");
	await serveStdio();
	return;
}

async function cmdRun(a: Args): Promise<void> {
	// Wrap ANY command: run it behind a local proxy that pays its 402s.
	// `stellar-pay run [--yes --max-usd N] -- <cmd> <args…>`
	// The command is everything after `--` (the documented form), or the
	// first bare token and the rest if `--` is omitted.
	const sep = process.argv.indexOf("--");
	let command: string | undefined;
	let cmdArgs: string[];
	if (sep >= 0) {
		[command, ...cmdArgs] = process.argv.slice(sep + 1);
	} else {
		const rest = process.argv.slice(2).filter((x) => x !== "run");
		const at = rest.findIndex((x) => !x.startsWith("-"));
		command = at >= 0 ? rest[at] : undefined;
		cmdArgs = at >= 0 ? rest.slice(at + 1) : [];
	}
	if (!command) {
		console.error(
			"usage: stellar-pay run [--yes --max-usd N] -- <command> [args…]",
		);
		process.exitCode = 1;
		return;
	}
	await ensureSecretLoaded(a.account);
	const wallet = loadWallet();
	const { startProxy, proxyEnv } = await import("./pay/proxy.js");
	const approve = async (o: Offer, url: string) => {
		const line = `pay ${describeOffer(o)} for ${url} (via \`${command}\`)`;
		// The per-host spend policy (deny / allowlist / host ceiling) applies to
		// every request the wrapped tool makes — each has its own URL.
		const gate = resolveHost(url, {
			requested: a.maxUsd,
			requestedExplicit: a.maxUsdSet,
		});
		if (gate.blocked) {
			console.error(`${line} (refused: ${gate.blocked})`);
			return false;
		}
		if (!a.yes && wallet.network !== "stellar:testnet") return ask(line);
		const v = autoApprove(o, { network: wallet.network, maxUsd: gate.maxUsd });
		console.error(`${line} ${v.ok ? "(approved)" : `(refused: ${v.reason})`}`);
		return v.ok;
	};
	const proxy = await startProxy({
		wallet,
		prefer: a.prefer,
		approve,
		// The wrapped child's 402s follow redirects too: re-run the per-host
		// spend policy on every hop, so a 302 cannot walk a payment onto a host
		// the operator denied (or one an allowlist never named).
		// The full gate on every hop — SSRF ∪ spend policy. Until 2026-09-01
		// this door ran only the policy half, so a 302 to 169.254.169.254 or
		// 127.0.0.1 walked through (audit F7).
		guard: (u) =>
			payGuard(u, { requested: a.maxUsd, requestedExplicit: a.maxUsdSet }),
		// Both hooks write to the ledger. `run` pays real money through the
		// proxy and, until 2026-09-01, recorded NOTHING — not the payments and
		// not the refusals — so `receipts --verify` could not prove a spend
		// this door made (audit finding 3).
		onPaid: (p) => {
			record({
				kind: "payment",
				network: wallet.network,
				protocol: p.protocol,
				url: p.url,
				payer: wallet.publicKey,
				tx: p.hash ?? null,
				detail: { surface: "run", ...(p.usd != null ? { usd: p.usd } : {}) },
			});
			console.error(
				`  ✓ paid ${p.usd != null ? `$${p.usd.toFixed(4)}` : "?"} via ${p.protocol.toUpperCase()} for ${p.url}${p.hash ? ` · ${explorer(wallet.network, p.hash)}` : ""}`,
			);
		},
		onRefused: (x) => {
			record({
				kind: "policy-decision",
				network: wallet.network,
				url: x.url,
				detail: { allowed: false, rule: x.reason, surface: "run" },
			});
			console.error(`  ✗ refused ${x.url}: ${x.reason}`);
		},
	});
	console.error(
		`stellar-pay: proxy on 127.0.0.1:${proxy.port}, wrapping \`${command}\` (Ctrl-C to stop)`,
	);
	// The wrapped command is untrusted — that's why it's behind the proxy.
	// The proxy (this parent) holds the wallet and does all signing, so the
	// child needs NO key material. Never inherit the decrypted secret or
	// the keystore passphrase into it.
	// Strip case-insensitively: on win32, process.env READS are case-insensitive
	// (a mis-cased var still satisfies loadWallet) but rest-spread keys are
	// literal, so an exact-case destructure would leak `Stellar_Secret_Key`.
	const childEnv = strippedEnv();
	const child = spawn(command, cmdArgs, {
		stdio: "inherit",
		env: { ...childEnv, ...proxyEnv(proxy.port, proxy.caPath, proxy.token) },
	});
	child.on("exit", async (code, signal) => {
		await proxy.close();
		process.exit(code ?? (signal ? 128 : EXIT.runtime));
	});
	return;
}

async function cmdAgent(a: Args): Promise<void> {
	// Mount the MCP into the agent and hand over. The server runs from this
	// install with the environment it inherits, so the wallet key never
	// touches an agent config file. claude takes a --mcp-config file; codex
	// takes per-invocation `-c mcp_servers.<name>.…` overrides; goose takes
	// --with-extension (no global config is mutated in any case).
	//
	// The server command must work from BOTH a published install (this file is
	// compiled dist/cli.js — plain node runs it) and a source checkout (this
	// file is src/cli.ts — it needs the tsx loader).
	const self = fileURLToPath(import.meta.url);
	const server = self.endsWith(".ts")
		? [
				process.execPath,
				join(dirname(self), "..", "node_modules", "tsx", "dist", "cli.mjs"),
				self,
				"mcp",
			]
		: [process.execPath, self, "mcp"];
	const passthrough = process.argv.slice(3);
	let child: ReturnType<typeof spawn>;
	// The agent (and everything IT spawns) is untrusted the same way a wrapped
	// command is: the MCP server we mount holds the wallet and does the signing,
	// so the child needs no key material. `run` already stripped these; the
	// launchers did not.
	const childEnv = strippedEnv();
	if (a.cmd === "goose") {
		// goose mounts a stdio MCP per-invocation via --with-extension.
		const ext = server
			.map((x) => (x.includes(" ") ? JSON.stringify(x) : x))
			.join(" ");
		const sub =
			passthrough[0] === "run" || passthrough[0] === "session"
				? (passthrough.shift() as string)
				: "session";
		child = spawn("goose", [sub, "--with-extension", ext, ...passthrough], {
			stdio: "inherit",
			env: childEnv,
		});
	} else if (a.cmd === "claude") {
		const cfg = {
			mcpServers: {
				"stellar-pay": { command: server[0], args: server.slice(1) },
			},
		};
		const file = join(mkdtempSync(join(tmpdir(), "stellar-pay-")), "mcp.json");
		writeFileSync(file, JSON.stringify(cfg));
		child = spawn("claude", ["--mcp-config", file, ...passthrough], {
			stdio: "inherit",
			env: childEnv,
		});
	} else {
		child = spawn(
			"codex",
			[
				"-c",
				`mcp_servers.stellar-pay.command=${JSON.stringify(server[0])}`,
				"-c",
				`mcp_servers.stellar-pay.args=${JSON.stringify(server.slice(1))}`,
				...passthrough,
			],
			{ stdio: "inherit", env: childEnv },
		);
	}
	// A child killed by a signal has code === null; exiting 0 there would report
	// success for a crashed or cancelled agent.
	child.on("exit", (code, signal) =>
		process.exit(code ?? (signal ? 128 : EXIT.runtime)),
	);
	return;
}

async function cmdWhoami(a: Args): Promise<void> {
	await ensureSecretLoaded(a.account);
	const w = loadWallet();
	emit(a, { public_key: w.publicKey, network: w.network }, () =>
		console.log(`${w.publicKey}  ${w.network}`),
	);
}

async function cmdBalance(a: Args): Promise<void> {
	await ensureSecretLoaded(a.account);
	const w = loadWallet();
	const b = await balances(w.publicKey, w.network);
	emit(a, { public_key: w.publicKey, network: w.network, ...b }, () => {
		if (!b.funded)
			return console.log(`${w.publicKey} is not funded on ${w.network}`);
		console.log(
			`USDC ${b.usdc ?? "(no trustline)"}  XLM ${b.xlm}${b.others.length ? `  +${b.others.length} other asset(s)` : ""}`,
		);
	});
}

async function cmdSetup(a: Args): Promise<void> {
	const network = (process.env.STELLAR_NETWORK ?? "stellar:pubnet") as
		| "stellar:pubnet"
		| "stellar:testnet";
	// `setup --trustline` adds the USDC trustline to an existing wallet.
	if (a.trustline) {
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		const tx = await addTrustline(w);
		console.log(
			tx
				? `USDC trustline added — ${explorer(w.network, tx)}`
				: "USDC trustline already present",
		);
		return;
	}
	const r = await setupWallet(network);
	console.log(`address:  ${r.publicKey}`);
	console.log(`network:  ${r.network}`);
	if (r.trustlineTx)
		console.log(`trustline: ${explorer(r.network, r.trustlineTx)}`);
	// --save <name> seals the new secret in the encrypted keystore instead
	// of printing it; otherwise print once for the user to store.
	if (a.name) {
		const saved = await addAccount(a.name, r.secret, network, {
			makeDefault: true,
			backend: a.keychain ? "keychain" : "file",
			force: a.force,
		});
		console.log(
			`saved to keystore as "${saved.name}" (default) — ${keystorePath}`,
		);
	} else {
		console.error(`secret:   ${r.secret}`); // stderr so a pipe doesn't capture it
		console.error(
			"  ^ store this now — it is never shown again. Or re-run with --save <name> to seal it in the keystore.",
		);
	}
	console.log(r.note);
	return;
}

async function cmdAccount(a: Args): Promise<void> {
	const sub = a.url ?? "list"; // first positional is the subcommand
	const network = (process.env.STELLAR_NETWORK ?? "stellar:pubnet") as
		| "stellar:pubnet"
		| "stellar:testnet";
	if (sub === "list" || sub === "ls") {
		const { default: def, accounts } = listAccounts();
		if (!accounts.length)
			return console.log(
				"no saved accounts — `stellar-pay setup --save <name>` or `account import <name>`",
			);
		for (const acc of accounts)
			console.log(
				`${acc.name === def ? "*" : " "} ${acc.name.padEnd(16)} ${acc.publicKey}  ${acc.network}`,
			);
		return;
	}
	if (sub === "import") {
		if (!a.name)
			return usageError(
				"usage: STELLAR_SECRET_KEY=S… stellar-pay account import --name <name>",
			);
		// A file beats an env var for restore: an exported backup can be moved
		// between machines without the secret ever touching a shell history.
		// Second positional is the path: `account import --name main backup.json`
		let secret = process.env.STELLAR_SECRET_KEY ?? "";
		const from = a.positional[1];
		if (from) {
			try {
				const raw = readFileSync(from, "utf8").trim();
				secret = raw.startsWith("{")
					? ((JSON.parse(raw) as { secret?: string }).secret ?? "")
					: raw;
			} catch (e) {
				return usageError(`cannot read ${from}: ${(e as Error).message}`);
			}
			if (!/^S[A-Z2-7]{55}$/.test(secret))
				return usageError(`${from} does not contain a Stellar secret (S…)`);
		}
		if (!secret)
			return usageError(
				"give a backup file (`account import --name main backup.json`) or set STELLAR_SECRET_KEY, then re-run",
			);
		const r = await addAccount(a.name, secret, network, {
			makeDefault: true,
			backend: a.keychain ? "keychain" : "file",
			force: a.force,
		});
		console.log(`imported "${r.name}" — ${r.publicKey}`);
		return;
	}
	if (sub === "default") {
		if (!a.name)
			return usageError("usage: stellar-pay account default --name <name>");
		setDefault(a.name);
		console.log(`default is now "${a.name}"`);
		return;
	}
	if (sub === "remove" || sub === "rm") {
		if (!a.name)
			return usageError("usage: stellar-pay account remove --name <name>");
		removeAccount(a.name);
		console.log(`removed "${a.name}"`);
		return;
	}
	if (sub === "export") {
		const secret = await exportSecret(a.name);
		const out = a.positional[1];
		if (out) {
			// Written 0600 and as JSON so `account import` can read it straight
			// back. Printing a secret to a terminal is the thing that ends up in
			// scrollback and screen-shares.
			writeFileSync(
				out,
				`${JSON.stringify({ name: a.name ?? "(default)", secret }, null, 2)}\n`,
				{ mode: 0o600 },
			);
			console.log(`exported to ${out} (owner-only). Keep it offline.`);
			return;
		}
		console.error(secret); // stderr, and only after the passphrase check inside exportSecret
		return;
	}
	console.error(
		"account subcommands: list | import --name N | default --name N | remove --name N | export [--name N]",
	);
	process.exitCode = 1;
	return;
}

/** `cashout` — the exit an EARNING agent needs.
 *
 * The counterpart to `topup`, and the missing end of the loop this whole
 * project is about: if people pay agents for work, the agent has to be able to
 * realise it. We surface routes and hand over the numbers; the withdrawal
 * itself happens at an anchor, under their KYC. See CASHOUT_NOTE. */
async function cmdCashout(a: Args): Promise<void> {
	await ensureSecretLoaded(a.account);
	const w = loadWallet();
	const bal = await balances(w.publicKey, w.network);
	const anchors = await partnerRamps("off-ramp");
	const out = {
		address: w.publicKey,
		network: w.network,
		balances: bal,
		note: CASHOUT_NOTE,
		anchors: anchors.map((r) => ({
			name: r.name,
			url: r.url,
			regions: r.regions,
			usdc: r.usdc,
		})),
		exchanges: EXCHANGES.map((e) => ({
			...e,
			how: "deposit USDC over the Stellar network, then withdraw to a bank",
		})),
	};
	emit(a, out, () => {
		console.log(`address  ${w.publicKey}`);
		console.log(`holding  ${bal.usdc ?? "0"} USDC · ${bal.xlm ?? "0"} XLM`);
		if (w.network !== "stellar:pubnet")
			console.error(
				"\nNOTE: this is a TESTNET wallet — testnet assets have no value and cannot be cashed out. The routes below are the mainnet ones, listed so you know where the exit is.",
			);
		if (anchors.length) {
			console.log("\nfiat anchors (USDC on Stellar → your bank/cash):");
			for (const r of anchors)
				console.log(
					`  ${r.name}${r.usdc ? "" : " (check asset support)"} — ${r.url}${r.regions.length ? `  [${r.regions.join(", ")}]` : ""}`,
				);
		} else {
			console.log(
				"\nfiat anchors: none returned by the directory right now — try the exchange route below",
			);
		}
		console.log("\nexchange route:");
		for (const e of EXCHANGES)
			console.log(
				`  ${e.name} — deposit USDC on the STELLAR network, then withdraw to a bank · ${e.url}`,
			);
		console.log(`\n${CASHOUT_NOTE}`);
		console.error(
			"\ntip: send earnings to the deposit address an anchor or exchange gives you with:\n  stellar-pay send <their-G…-address> --amount <N>",
		);
	});
}

async function cmdTopup(a: Args): Promise<void> {
	await ensureSecretLoaded(a.account);
	const w = loadWallet();
	const t = await topupInfo(w);
	const uri = payUri(t.address, t.network, a.amount);
	// `--buy`: open a hosted on-ramp in the browser and wait for the deposit,
	// the way `pay topup` does. The address is pre-filled where the provider
	// supports it; otherwise it's printed to paste.
	if (a.buy && t.network === "stellar:pubnet") {
		// Opens a browser and blocks up to 5 minutes — only sane on a TTY. In a
		// pipe (an agent), fall through to the printed address + ramp URLs.
		if (!process.stdout.isTTY) {
			console.error(
				"topup --buy opens a browser and waits; not available non-interactively. Showing the address and on-ramps instead.",
			);
		} else {
			const all = onramps(t.address, a.amount);
			const primary = all[0];
			if (!primary) {
				console.error("no on-ramp configured");
				process.exitCode = 1;
				return;
			}
			console.log(`address:   ${t.address}   (paste this if the page asks)`);
			console.log(
				`opening ${primary.name} on-ramp in your browser: ${primary.url}`,
			);
			openBrowser(primary.url);
			const others = all.slice(1);
			console.log(
				`other on-ramps: ${others.map((o) => `${o.name} ${o.url}`).join("  ·  ")}`,
			);
			if (!t.hasUsdcTrustline)
				console.log(
					"note: add a USDC trustline (`stellar-pay setup --trustline`) so the delivery can land",
				);
			console.error("\nwaiting for USDC to arrive (Ctrl-C to stop)…");
			const got = await pollFunding(t.address, t.network, {
				onTick: (ms) =>
					process.stderr.write(`\r  ${Math.round(ms / 1000)}s…   `),
			});
			process.stderr.write("\r");
			console.log(
				got
					? `✓ received ${got.received} USDC — balance now ${got.balance}`
					: "▲ nothing arrived in 5m — re-run `stellar-pay topup --buy` to keep watching",
			);
			return;
		}
	}
	console.log(`address:   ${t.address}`);
	console.log(`network:   ${t.network}`);
	console.log(`funded:    ${t.funded}   USDC trustline: ${t.hasUsdcTrustline}`);
	// A scannable SEP-7 QR — a mobile Stellar wallet (Lobstr, Freighter)
	// sends USDC to this address. Only on a TTY; otherwise the URI is enough.
	if (process.stdout.isTTY) {
		const QRCode = (await import("qrcode")).default;
		console.log(
			`\n${await QRCode.toString(uri, { type: "terminal", small: true })}`,
		);
	}
	console.log(`pay URI:   ${uri}`);
	console.log(t.guidance);
	// On mainnet, surface real ways to get USDC onto Stellar — our own
	// partner on-ramps (live), plus curated exchange and bridge paths.
	if (t.network === "stellar:pubnet") {
		const ramps = await partnerRamps();
		if (ramps.length) {
			console.log("\nfiat on-ramps (Stellar Light partners):");
			for (const r of ramps.slice(0, 5))
				console.log(
					`  ${r.name}${r.usdc ? " · USDC" : ""}${r.regions.length ? ` · ${r.regions.join("/")}` : ""}${r.tagline ? ` — ${r.tagline}` : ""}  ${r.url}`,
				);
		}
		console.log(
			`buy on an exchange, then withdraw USDC on the Stellar network: ${EXCHANGES.map((e) => `${e.name} ${e.url}`).join("  ·  ")}`,
		);
		for (const b of BRIDGES)
			console.log(
				`bridge (USDC from another chain): ${b.name} ${b.url} — ${b.note}`,
			);
	}
	// Wait for the deposit and confirm it, like `pay topup` — interactively
	// only, so an agent or a pipe never hangs.
	if (process.stdout.isTTY && !t.hasUsdcTrustline) {
		console.log(
			"\nadd a USDC trustline first (`stellar-pay setup --trustline`) so this wallet can receive USDC",
		);
	} else if (process.stdout.isTTY) {
		console.error("\nwaiting for USDC to arrive (Ctrl-C to stop)…");
		const got = await pollFunding(t.address, t.network, {
			onTick: (ms) => process.stderr.write(`\r  ${Math.round(ms / 1000)}s…   `),
		});
		process.stderr.write("\r");
		if (got)
			console.log(
				`✓ received ${got.received} USDC — balance now ${got.balance}`,
			);
		else
			console.log(
				"▲ nothing arrived in 5m — re-run `stellar-pay topup` to keep watching",
			);
	}
	return;
}

async function cmdSend(a: Args): Promise<void> {
	await ensureSecretLoaded(a.account);
	const w = loadWallet();
	const target = a.url ?? ""; // first positional: a G… address OR a saved name
	// Sending to a saved account by NAME beats copy-pasting a 56-character key,
	// which is exactly where people paste the wrong one.
	const named =
		target && !/^G[A-Z2-7]{55}$/.test(target) ? accountPublicKey(target) : null;
	const to = named ?? target;
	if (target && !named && !/^G[A-Z2-7]{55}$/.test(target)) {
		console.error(
			`"${target}" is neither a G… address nor a saved account name — \`stellar-pay account list\` shows the saved ones`,
		);
		process.exitCode = EXIT.usage;
		return;
	}
	// `--amount max` drains the spendable balance, minus what the account must
	// keep to stay alive.
	let amount = a.amount ?? "";
	if (amount === "max") {
		const b = await balances(w.publicKey, w.network);
		amount = b.usdc ?? "0";
		if (!(Number(amount) > 0)) {
			console.error("nothing to send: USDC balance is zero");
			process.exitCode = EXIT.runtime;
			return;
		}
	}
	if (!to || !amount) {
		console.error(
			"usage: stellar-pay send <G...address|account-name> --amount <USDC|max>  [--yes] [--account N]",
		);
		process.exitCode = EXIT.usage;
		return;
	}
	const line = `send ${amount} USDC to ${named ? `${target} (${to.slice(0, 6)}…${to.slice(-4)})` : `${to.slice(0, 6)}…${to.slice(-4)}`} on ${w.network}`;
	if (!a.yes && !(await ask(line))) {
		console.error("not sent");
		process.exitCode = EXIT.refused;
		return;
	}
	const r = await sendUSDC(w, to, amount, a.memo);
	if (a.json) {
		console.log(
			JSON.stringify({
				sent: {
					to,
					amount: r.amount,
					asset: r.asset,
					hash: r.hash,
					explorer: explorer(w.network, r.hash),
				},
			}),
		);
		return;
	}
	console.log(`sent ${r.amount} USDC · ${explorer(w.network, r.hash)}`);
	return;
}

async function cmdHistory(a: Args): Promise<void> {
	await ensureSecretLoaded(a.account);
	const w = loadWallet();
	const rows = await history(w.publicKey, w.network, a.limit ?? 20);
	emit(a, { network: w.network, payments: rows }, () => {
		if (!rows.length) return console.log("no payments yet");
		for (const h of rows)
			console.log(
				`${h.at.slice(0, 10)}  ${h.direction === "sent" ? "→" : "←"} ${h.amount.padStart(12)} ${h.asset.padEnd(5)} ${h.direction === "sent" ? "to" : "from"} ${h.counterparty.slice(0, 6)}…${h.counterparty.slice(-4)}`,
			);
	});
}

async function cmdSession(a: Args): Promise<void> {
	// positional[0] is the subcommand (`account export <path>` precedent).
	const sub = a.positional[0] ?? "";
	// `session open <url>`: the deposit IS the spend — approval before deploy.
	if (sub === "open") {
		const url = a.positional[1];
		if (!url || !URL.canParse(url))
			return usageError("usage: stellar-pay session open <url> [--deposit 5]");
		// The deposit IS the spend and the channel can pay it out without another
		// prompt, so both gates run BEFORE anything is deployed or fetched.
		// Neither ran here until 2026-09-01: a denied host could still be handed
		// a funded channel (audit finding 1).
		const ssrf = await blockedTarget(url);
		if (ssrf) {
			console.error(ssrf);
			process.exitCode = EXIT.refused;
			return;
		}
		// requested:0 — resolveHost only ever BLOCKS on deny/allowlist, so this
		// runs exactly those branches. The USD ceiling deliberately does NOT
		// apply: the deposit is denominated in XLM and pricing it would need an
		// oracle this path must not depend on. A per-host XLM deposit cap is a
		// separate knob, not an invented conversion.
		const gate = resolveHost(url, { requested: 0 });
		if (gate.blocked) {
			console.error(`refused: ${gate.blocked}`);
			process.exitCode = EXIT.refused;
			return;
		}
		await ensureSecretLoaded(a.account);
		const wallet = loadWallet();
		// The seller's receiving account comes from THEIR OWN 402 — never from
		// a catalog or a flag someone could spoof.
		const probe = await fetch(url, { redirect: "manual" });
		const offers = readOffers(probe.headers, await probe.text());
		const payTo = offers.find((o) => isStellar(o.network))?.payTo;
		if (probe.status !== 402 || !payTo)
			return usageError(
				`${url} did not answer a Stellar 402 (status ${probe.status}) — nothing to open a channel against`,
			);
		const depositXlm = a.deposit ?? DEFAULT_DEPOSIT_XLM;
		const line = `open a payment channel to ${hostOf(url)}: deposit ${depositXlm} XLM (max exposure), recipient ${payTo.slice(0, 6)}…`;
		if (!a.yes && wallet.network !== "stellar:testnet") {
			if (!(await ask(line))) {
				process.exitCode = EXIT.refused;
				return;
			}
		} else console.error(`${line} (approved)`);
		const r = await openChannel({ wallet, url, recipient: payTo, depositXlm });
		emit(
			a,
			{
				host: r.host,
				contract: r.contract,
				commitment_pubkey_hex: r.commitmentPubHex,
				deposit_xlm: depositXlm,
				tx: r.tx,
				explorer: `https://stellar.expert/explorer/testnet/tx/${r.tx}`,
			},
			() => {
				console.log(`channel  ${r.contract}`);
				console.log(
					`deposit  ${depositXlm} XLM (your max exposure to ${r.host})`,
				);
				console.log(
					`tx       https://stellar.expert/explorer/testnet/tx/${r.tx}`,
				);
				console.log(
					`\nGive the seller these (our sandbox takes them as env):\n  CHANNEL_CONTRACT=${r.contract}\n  COMMITMENT_PUBKEY=${r.commitmentPubHex}\n\nThen: stellar-pay curl <url> --session`,
				);
			},
		);
		return;
	}
	if (sub === "close") {
		const url = a.positional[1];
		if (!url || !URL.canParse(url))
			return usageError("usage: stellar-pay session close <url>");
		const c = getChannel(hostOf(url));
		if (!c) return usageError(`no channel for ${hostOf(url)}`);
		// Best-known cumulative: tracked by sessionFetch from the client's own
		// signed events (never adopted from the server). The close must cover
		// its own request, so read one price step from the live 402.
		const last = BigInt(c.lastCumulative ?? "0");
		const probe = await fetch(url, { redirect: "manual" });
		const priceStep = BigInt(
			readOffers(probe.headers, await probe.text()).find((o) =>
				isStellar(o.network),
			)?.amount ?? "1",
		);
		const r = await closeChannel({ url, lastCumulative: last, priceStep });
		const settled = (last + priceStep).toString();
		emit(a, { status: r.status, settled_cumulative: settled }, () => {
			console.log(
				r.status === 200
					? `closed — server settled on-chain (cumulative ${last} + one price step ${priceStep})`
					: `close returned ${r.status} — the channel may already be closed or the server refused`,
			);
		});
		if (r.status !== 200) process.exitCode = EXIT.runtime;
		return;
	}
	// default: status
	const channels = listChannels();
	emit(a, { channels }, () => {
		const hosts = Object.keys(channels);
		if (!hosts.length)
			return console.log(
				`no session channels — open one: stellar-pay session open <url> [--deposit ${DEFAULT_DEPOSIT_XLM}]`,
			);
		for (const [host, c] of Object.entries(channels))
			console.log(
				`${host}  ${c.contract.slice(0, 8)}…  deposit ${Number(BigInt(c.depositStroops)) / 1e7} XLM  opened ${c.openedAt.slice(0, 10)}`,
			);
	});
}

const XLM_SAC_TESTNET_CLI =
	"CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function readJsonFile<T>(path: string, what: string): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (e) {
		throw new Error(
			`could not read ${what} from ${path}: ${(e as Error).message}`,
		);
	}
}

async function cmdVault(a: Args): Promise<void> {
	const sub = a.positional[0] ?? "";
	const usage = () =>
		usageError(`usage:
  vault create --cap-xlm N     deploy the vault; THIS wallet becomes the capped agent (testnet)
  vault topup --amount-xlm N   move funds wallet → vault (behind the cap)
  vault draw --amount-xlm N    agent draws float to its own key — the CHAIN enforces the cap
  vault status                 config + on-chain balance`);
	await ensureSecretLoaded(a.account);
	const wallet = loadWallet();
	if (sub === "create") {
		if (!a.amountXlm && !a.capXlm) return usage();
		const rec = await createVault({
			wallet,
			capXlm: a.capXlm ?? a.amountXlm ?? 0,
		});
		emit(a, rec, () =>
			console.log(
				`vault ${rec.contractId}
cap ${Number(rec.capStroops) / 1e7} XLM per ~day · agent = this wallet
fund it: vault topup --amount-xlm N`,
			),
		);
		return;
	}
	if (sub === "topup") {
		if (!a.amountXlm) return usage();
		const r = await topupVault({ wallet, amountXlm: a.amountXlm });
		emit(a, r, () => console.log(`topped up: ${r.hash}`));
		return;
	}
	if (sub === "draw") {
		if (!a.amountXlm) return usage();
		const r = await drawFromVault({ wallet, amountXlm: a.amountXlm });
		emit(a, r, () =>
			console.log(
				r.ok
					? `drawn: ${r.hash}`
					: `REFUSED BY THE CHAIN: ${r.refusal} — the cap held`,
			),
		);
		if (!r.ok) process.exitCode = EXIT.refused;
		return;
	}
	if (sub === "status") {
		const st = await vaultStatus({ wallet });
		emit(a, st, () =>
			console.log(
				`vault ${st.vault}
balance ${Number(st.balanceStroops) / 1e7} XLM · cap ${Number(st.capStroops) / 1e7} XLM/~day · agent ${st.agent}`,
			),
		);
		return;
	}
	return usage();
}

async function cmdBounty(a: Args): Promise<void> {
	const sub = a.positional[0] ?? "";
	const usage = () =>
		usageError(`usage:
  bounty post --title T --items a,b --instructions "…" --amount-xlm N [--resolver G…] [--token C…] [--deadline-days N] [--out bounty.json]
  bounty assign <bounty.json> --provider G…        (buyer wallet: escrow + fund, directed)
  bounty open <bounty.json>                        (buyer wallet: escrow + fund, open race)
  bounty submit --contract C… --evidence ev.json   (worker wallet: directed evidence on-chain)
  bounty feed <bounty.json> --contract C… [--out feed.json]   (buyer: publish a versioned feed workers can discover)
  bounty commit --contract C… --evidence ev.json [--out commit.json]   (worker: publish the HASH first — beats evidence theft)
  bounty pack --contract C… --evidence ev.json [--nonce N] [--out sub.json] [--send --to URL]   (worker: reveal)
  bounty list --from <url|file>                    (worker: fetch a feed, VET each listing against the chain)
  bounty watch --contract C… [--timeout-sec N]     (worker: wait for settlement; did WE get paid?)
  bounty dispute --contract C…                     (buyer wallet: unlock refund/open settlement)
  bounty resolve <bounty.json> --contract C… [--submissions s1.json,s2.json] [--commits c1.json,c2.json]   (resolver wallet)
  bounty status --contract C…`);

	if (sub === "list") {
		if (!a.fromFeed) return usage();
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		const listings = await fetchFeed(a.fromFeed);
		const rows: Array<{
			contractId: string;
			title?: string;
			amount?: string;
			token?: string;
			submitUrl: string | null;
			valid: boolean;
			failed: string[];
		}> = [];
		for (const listing of listings) {
			const vet = await vetListing({ listing, source: w.keypair });
			rows.push({
				contractId: listing.contractId,
				title: listing.descriptor?.title,
				amount: listing.descriptor?.amount,
				token: listing.descriptor?.tokenContract,
				submitUrl: listing.descriptor?.submitUrl ?? null,
				valid: vet.ok,
				failed: vet.checks.filter((c) => !c.ok).map((c) => c.name),
			});
		}
		emit(a, { feed: a.fromFeed, listings: rows }, () => {
			if (rows.length === 0) return console.log("feed is empty");
			for (const r of rows)
				console.log(
					`${r.valid ? "VALID  " : "REFUSED"} ${r.contractId.slice(0, 10)}… "${r.title ?? "(untitled)"}" pays ${r.amount ?? "?"}${
						r.valid
							? r.submitUrl
								? `\n        submit to ${r.submitUrl}`
								: ""
							: `  (${r.failed.join(", ")})`
					}`,
				);
			console.error(
				"\nVALID = the CHAIN backs the claim (terms pinned, pot funded, still open). Never work a REFUSED row.",
			);
		});
		return;
	}

	if (sub === "watch") {
		if (!a.contract) return usage();
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		const r = await awaitPayout({
			contractId: a.contract,
			worker: w.keypair,
			timeoutMs: (a.timeoutSec ?? 300) * 1000,
		});
		emit(
			a,
			r.paid ? { ...r, amountStroops: r.amountStroops.toString() } : r,
			() =>
				console.log(
					r.paid
						? `PAID ${Number(r.amountStroops) / 1e7} XLM-units (tx ${r.tx ?? "n/a"}) — receipted as bounty-income`
						: r.reason === "timeout"
							? "not settled within the timeout"
							: "settled, but not to us — lost the race or refunded",
				),
		);
		if (!r.paid)
			process.exitCode = r.reason === "timeout" ? EXIT.runtime : EXIT.refused;
		return;
	}

	if (sub === "post") {
		if (!a.title || !a.items?.length || !a.instructions || !a.amountXlm)
			return usage();
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		const d = postBounty({
			buyer: w.publicKey,
			resolver: a.resolverAddr ?? w.publicKey,
			title: a.title,
			items: a.items,
			instructions: a.instructions,
			amount: BigInt(Math.round(a.amountXlm * 10_000_000)),
			tokenContract: a.token ?? XLM_SAC_TESTNET_CLI,
			submitUrl: a.submitUrl,
			deadlineDays: a.deadlineDays,
		});
		if (a.out) writeFileSync(a.out, JSON.stringify(d, null, 1));
		emit(a, d, () => {
			console.log(JSON.stringify(d, null, 1));
			if (a.out) console.error(`written to ${a.out}`);
			if (!a.resolverAddr)
				console.error(
					"note: resolver defaults to YOU — you will not be able to refund via dispute (the resolver cannot dispute its own escrow); pass --resolver for a neutral judge",
				);
		});
		return;
	}

	if (sub === "assign" || sub === "open") {
		const file = a.positional[1];
		if (!file) return usage();
		const d = readJsonFile<BountyDescriptor>(file, "bounty descriptor");
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		if (w.network !== "stellar:testnet")
			return usageError(
				"bounties are testnet-only (the escrow contract is unaudited; mainnet is gated on that audit)",
			);
		if (sub === "assign") {
			if (!a.provider) return usage();
			const r = await assignBounty({
				descriptor: d,
				buyer: w.keypair,
				provider: a.provider,
			});
			emit(a, r, () =>
				console.log(
					`escrowed ${d.amount} to ${r.contractId}
fund tx ${r.fundTx}
worker submits with: bounty submit --contract ${r.contractId} --evidence ev.json`,
				),
			);
			return;
		}
		const r = await postOpenBounty({ descriptor: d, buyer: w.keypair });
		emit(a, r, () =>
			console.log(
				`OPEN bounty escrowed ${d.amount} at ${r.contractId}
workers race with: bounty pack --contract ${r.contractId} --evidence ev.json`,
			),
		);
		return;
	}

	if (sub === "feed") {
		// Publish a feed: append a posted bounty to one, or create it. A buyer
		// serves the file at any URL; workers vet every row against the chain,
		// so a feed needs no trust and no permission from us.
		const file = a.positional[1];
		if (!file || !a.contract) return usage();
		const d = readJsonFile<BountyDescriptor>(file, "bounty descriptor");
		const outPath = a.out ?? "feed.json";
		let existing: OpenBountyListing[] = [];
		try {
			const prior = JSON.parse(readFileSync(outPath, "utf8")) as
				| { bounties?: OpenBountyListing[] }
				| OpenBountyListing[];
			existing = Array.isArray(prior) ? prior : (prior.bounties ?? []);
		} catch {
			// no feed there yet — this call creates it
		}
		const bounties = [
			...existing.filter((b) => b.contractId !== a.contract),
			{ contractId: a.contract, descriptor: d },
		];
		const feed = buildFeed(bounties);
		writeFileSync(outPath, JSON.stringify(feed, null, 1));
		emit(a, feed, () =>
			console.log(
				`${outPath}: ${feed.bounties.length} bounty(s), ${feed.format} schema ${feed.schema_version}\nserve it at any URL; workers read it with: bounty list --from <url>`,
			),
		);
		return;
	}

	if (sub === "commit") {
		if (!a.contract || !a.evidenceFile) return usage();
		const evidence = readJsonFile<EvidenceEntry[]>(a.evidenceFile, "evidence");
		if (!Array.isArray(evidence))
			return usageError("evidence must be a JSON array");
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		const { commit, nonce } = makeCommit({
			worker: w.keypair,
			contractId: a.contract,
			evidence,
		});
		if (a.out) writeFileSync(a.out, JSON.stringify(commit, null, 1));
		emit(a, { commit, nonce }, () => {
			console.log(JSON.stringify(commit, null, 1));
			console.error(
				`\nKEEP THIS NONCE — it opens your commit and is what proves the work was yours:\n  ${nonce}\n\nreveal later with: bounty pack --contract ${a.contract} --evidence ${a.evidenceFile} --nonce ${nonce}`,
			);
			if (a.out) console.error(`commit written to ${a.out}`);
		});
		return;
	}

	if (sub === "submit" || sub === "pack") {
		if (!a.contract || !a.evidenceFile) return usage();
		const evidence = readJsonFile<EvidenceEntry[]>(a.evidenceFile, "evidence");
		if (!Array.isArray(evidence))
			return usageError("evidence must be a JSON array");
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		if (sub === "pack") {
			if (a.send) {
				if (!a.toUrl)
					return usageError(
						"--send needs --to <url> (the bounty's submitUrl — see `bounty list`)",
					);
				const r = await submitPacket({
					worker: w.keypair,
					contractId: a.contract,
					evidence,
					url: a.toUrl,
					nonce: a.nonce,
				});
				emit(a, { status: r.status, worker: r.packet.worker }, () =>
					console.log(
						`packet submitted to ${a.toUrl} (HTTP ${r.status}) — now: bounty watch --contract ${a.contract}`,
					),
				);
				return;
			}
			const packet = makeSubmission({
				worker: w.keypair,
				contractId: a.contract,
				evidence,
				nonce: a.nonce,
			});
			if (a.out) writeFileSync(a.out, JSON.stringify(packet, null, 1));
			emit(a, packet, () => {
				console.log(JSON.stringify(packet, null, 1));
				if (a.out)
					console.error(
						`written to ${a.out} — hand it to the bounty's resolver`,
					);
			});
			return;
		}
		const r = await submitBounty({
			provider: w.keypair,
			contractId: a.contract,
			evidence,
			prevReceiptId: "",
		});
		emit(a, r, () => console.log(`evidence on-chain: ${r.tx}`));
		return;
	}

	if (sub === "dispute") {
		if (!a.contract) return usage();
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		const r = await disputeJob({ signer: w.keypair, contractId: a.contract });
		emit(a, r, () => console.log(`disputed: ${r.tx}`));
		return;
	}

	if (sub === "resolve") {
		const file = a.positional[1];
		if (!file || !a.contract) return usage();
		const d = readJsonFile<BountyDescriptor>(file, "bounty descriptor");
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		if (a.submissionFiles?.length) {
			const submissions = a.submissionFiles.map((f) =>
				readJsonFile<OpenSubmission>(f, "submission packet"),
			);
			const commits = a.commitFiles?.length
				? a.commitFiles.map((f) => readJsonFile<OpenCommit>(f, "commit"))
				: undefined;
			const r = await resolveOpenBounty({
				descriptor: d,
				resolver: w.keypair,
				contractId: a.contract,
				submissions,
				// [] rather than undefined: "nobody committed" is a real answer and
				// resolves to no winner. It is no longer a way to opt out of the race.
				commits: commits ?? [],
			});
			emit(a, r, () =>
				console.log(
					r.winner
						? `winner ${r.winner} paid (txs: ${r.txs.join(", ")})`
						: `no valid submission — pot returned to the buyer (txs: ${r.txs.join(", ")})`,
				),
			);
			return;
		}
		const r = await resolveBounty({
			descriptor: d,
			resolver: w.keypair,
			contractId: a.contract,
		});
		emit(a, r, () =>
			console.log(
				`answered "${r.answer}" → ${r.outcome} (txs: ${r.txs.join(", ")})`,
			),
		);
		return;
	}

	if (sub === "status") {
		if (!a.contract) return usage();
		await ensureSecretLoaded(a.account);
		const w = loadWallet();
		const st = await bountyStatus({
			contractId: a.contract,
			source: w.keypair,
		});
		emit(a, st, () =>
			console.log(
				`funded=${st.funded} submitted=${st.submitted} released=${st.released} disputed=${st.disputed} evidence=${st.evidence?.length ?? 0} entries`,
			),
		);
		return;
	}
	return usage();
}

async function cmdReceipts(a: Args): Promise<void> {
	if (a.positional[0] === "check") {
		const r = checkLedger();
		emit(a, r, () => {
			if (r.ok) {
				console.log(
					`ledger intact: ${r.rows} row(s) — every id re-derives from its content and every link resolves`,
				);
				console.log(
					"  (a local file cannot prove itself against its own owner: verify a payment with `receipts --verify <id>`, which checks the chain)",
				);
				return;
			}
			const parts = [
				r.bad.length && `${r.bad.length} edited`,
				r.unlinked.length &&
					`${r.unlinked.length} unlinked (deleted or reordered)`,
				r.unreadable.length && `${r.unreadable.length} unreadable`,
			].filter(Boolean);
			console.log(`TAMPERED: ${parts.join(", ")}`);
			for (const b of r.bad)
				console.log(`  edited      ${b.id} ≠ ${b.expected}`);
			for (const u of r.unlinked)
				console.log(
					`  unlinked    ${u.id} → prev ${u.prev} is not an earlier row`,
				);
			for (const u of r.unreadable)
				console.log(`  unreadable  line ${u.line}: ${u.text}`);
		});
		if (!r.ok) process.exitCode = EXIT.runtime;
		return;
	}
	// --verify <id>: the PGTR half — prove a row against the CHAIN, so the
	// receipt is a portable authorization artifact, not a log line.
	const verifyId = a.verifyReceipt;
	if (verifyId) {
		const row = listReceipts({ limit: 10_000 }).find((r) =>
			r.id.startsWith(verifyId),
		);
		if (!row) {
			console.error(`no receipt with id ${verifyId}`);
			process.exitCode = EXIT.usage;
			return;
		}
		const v = await verifyOnChain(row);
		emit(a, { receipt: row, ...v }, () => {
			for (const c of v.checks)
				console.log(
					`  ${c.ok ? "✓" : "✗"} ${c.name}${c.note ? ` — ${c.note}` : ""}`,
				);
			console.log(v.ok ? "VERIFIED on-chain" : "NOT verified");
		});
		if (!v.ok) process.exitCode = EXIT.runtime;
		return;
	}
	const rows = listReceipts({ limit: a.limit ?? 20 });
	emit(a, { receipts: rows }, () => {
		if (!rows.length) return console.log("no receipts yet");
		for (const r of rows)
			console.log(
				`${r.at.slice(0, 19)}  ${r.id}  ${r.kind.padEnd(15)} ${r.amount ?? ""} ${r.url ?? r.detail?.rule ?? ""}${r.refs?.length ? `  ⤴ ${r.refs.join(",")}` : ""}`,
			);
	});
}

async function cmdVerify(a: Args): Promise<void> {
	if (!a.url) {
		console.error(
			"usage: stellar-pay verify <url> [-X METHOD] [-d body] [--json]",
		);
		process.exitCode = EXIT.usage;
		return;
	}
	if (!URL.canParse(a.url) || !/^https?:$/.test(new URL(a.url).protocol)) {
		console.error(`"${a.url}" is not a valid http(s) URL`);
		process.exitCode = EXIT.usage;
		return;
	}
	const v = await verifyEndpoint(a.url, a.method, a.body);
	emit(a, v, () => {
		for (const c of v.checks)
			console.log(
				`  ${c.ok ? "\u2713" : "\u2717"} ${c.label.padEnd(24)} ${c.detail}`,
			);
		console.log(
			v.payable
				? "\n\u2713 PAYABLE — this endpoint answers a correct Stellar 402; the probe will index it and a stellar-pay client can pay it."
				: "\n\u2717 NOT PAYABLE from a Stellar wallet yet — fix the \u2717 items above.",
		);
	});
	// A failed check is a legitimate result, not a usage error — distinct code.
	if (!v.payable) process.exitCode = EXIT.refused;
}

async function cmdOffers(a: Args, init: RequestInit): Promise<void> {
	if (!a.url) {
		console.error(
			"usage: stellar-pay offers <url> [-X METHOD] [-d body] [--json]",
		);
		process.exitCode = EXIT.usage;
		return;
	}
	const r = await fetch(a.url, init);
	const offers = r.status === 402 ? readOffers(r.headers, await r.text()) : [];
	emit(
		a,
		{ status: r.status, payment_required: r.status === 402, offers },
		() => {
			if (r.status !== 402)
				return console.log(`${r.status} — no payment asked`);
			if (!offers.length)
				return console.log(
					"402 but no readable offer (neither x402 accepts nor an MPP challenge)",
				);
			for (const o of offers)
				console.log(
					`${describeOffer(o)}${o.description ? ` — ${o.description}` : ""}`,
				);
		},
	);
}

async function cmdCurl(a: Args, init: RequestInit): Promise<void> {
	if (!a.url) throw new Error("curl <url>");
	// --session: pay through the host's registered one-way channel — every
	// call is an OFF-CHAIN signed commitment (deposit already capped exposure
	// at `session open`, which is where approval happened). No per-call
	// prompt: the channel cannot pay the seller more than the deposit.
	if (a.session) {
		// A channel opened yesterday must not outlive a deny rule written today:
		// re-run the host gate on every session call, not just at open.
		const sessGate = resolveHost(a.url, { requested: 0 });
		if (sessGate.blocked) {
			console.error(`refused: ${sessGate.blocked}`);
			process.exitCode = EXIT.refused;
			return;
		}
		const host = hostOf(a.url);
		const { fetch: sf, channel } = sessionFetch(host);
		const cumBefore = BigInt(channel.lastCumulative ?? "0");
		const t0 = Date.now();
		const res = await sf(a.url, init);
		const ms = Date.now() - t0;
		const bodyText = await res.text();
		const priced = res.headers.get("payment-receipt") != null;
		if (priced) {
			// One receipt per paid call, chained to the channel-open receipt —
			// the attribution chain: open ← call ← call ← … ← close. The amount
			// is the cumulative DELTA this call signed (from our own store,
			// never the server's word).
			const cumAfter = BigInt(getChannel(host)?.lastCumulative ?? "0");
			const openRow = listReceipts({ kind: "channel-open", limit: 10_000 })
				.reverse()
				.find((r) => r.detail?.host === host);
			record({
				kind: "payment",
				network: channel.network,
				protocol: "channel",
				url: a.url,
				amount: (cumAfter - cumBefore).toString(),
				payer: channel.funder,
				payee: channel.recipient,
				tx: null,
				refs: openRow ? [openRow.id] : undefined,
				detail: { session: true, offChain: true },
			});
		}
		if (!res.ok && res.status !== 402) process.exitCode = EXIT.runtime;
		if (res.status === 402) process.exitCode = EXIT.refused;
		if (a.json) {
			console.log(
				JSON.stringify(
					{
						status: res.status,
						content_type: res.headers.get("content-type"),
						body: bodyText,
						session: { host, contract: channel.contract, ms, offChain: true },
					},
					null,
					1,
				),
			);
			return;
		}
		console.error(
			`session ${host} · ${ms} ms · off-chain commitment (channel ${channel.contract.slice(0, 8)}…)`,
		);
		console.log(bodyText);
		return;
	}
	await ensureSecretLoaded(a.account);
	const wallet = loadWallet();
	// Every spend DECISION becomes a receipt row naming the rule that fired
	// (policy-as-artifact); the payment row that may follow references it.
	let decisionId: string | undefined;
	const logDecision = (o: Offer, allowed: boolean, rule: string) => {
		decisionId = record({
			kind: "policy-decision",
			network: wallet.network,
			url: a.url,
			amount: o.amount,
			asset: o.asset,
			payee: o.payTo,
			detail: { allowed, rule },
		});
	};
	const approve = async (o: Offer, url: string) => {
		const line = `pay ${describeOffer(o)} for ${a.method} ${a.url}`;
		// The per-host policy (deny / allowlist / host ceiling) applies on EVERY
		// path — a human prompt can't override a host the operator denied.
		const gate = resolveHost(url, {
			requested: a.maxUsd,
			requestedExplicit: a.maxUsdSet,
		});
		if (gate.blocked) {
			console.error(`${line}\n  refused: ${gate.blocked}`);
			logDecision(o, false, `host-policy: ${gate.blocked}`);
			return false;
		}
		if (!a.yes && wallet.network !== "stellar:testnet") {
			const human = await ask(line);
			logDecision(o, human, human ? "human-approved" : "human-declined");
			return human;
		}
		const v = autoApprove(o, { network: wallet.network, maxUsd: gate.maxUsd });
		console.error(
			`${line}${v.ok ? " (approved)" : `\n  refused: ${v.reason}`}`,
		);
		logDecision(o, v.ok, v.ok ? "auto-approve" : v.reason);
		return v.ok;
	};
	const r = await payFetch(a.url, init, {
		wallet,
		approve,
		// A deny/allowlist rule is worthless if a 302 moves the payment to an
		// unchecked host — re-run the host gate on every hop.
		// The full gate on every hop — SSRF ∪ spend policy. Until 2026-09-01
		// this door ran only the policy half, so a 302 to 169.254.169.254 or
		// 127.0.0.1 walked through (audit F7).
		guard: (u) =>
			payGuard(u, { requested: a.maxUsd, requestedExplicit: a.maxUsdSet }),
		prefer: a.prefer,
	});
	const bodyText = await r.res.text();
	if (r.paid) {
		record({
			kind: "payment",
			network: wallet.network,
			protocol: r.paid.protocol,
			url: a.url,
			amount: r.paid.offer.amount,
			asset: r.paid.offer.asset,
			payer: wallet.publicKey,
			payee: r.paid.offer.payTo,
			tx: r.paid.hash,
			refs: decisionId ? [decisionId] : undefined,
		});
	}
	const usd = r.paid ? offerUSD(r.paid.offer) : null;
	const paid = r.paid
		? {
				protocol: r.paid.protocol,
				usd,
				amount: r.paid.offer.amount,
				asset: r.paid.offer.asset,
				hash: r.paid.hash,
				explorer: r.paid.hash ? explorer(wallet.network, r.paid.hash) : null,
			}
		: null;

	if (r.declined) process.exitCode = EXIT.refused;
	else if (r.res.status === 402 && !r.paid) process.exitCode = EXIT.refused;
	else if (!r.res.ok) process.exitCode = EXIT.runtime;

	// --json: ONE machine object carries body + payment trailer. Without it the
	// body stays raw on stdout (pipe into jq) and payment facts go to stderr.
	if (a.json) {
		console.log(
			JSON.stringify(
				{
					status: r.res.status,
					content_type: r.res.headers.get("content-type"),
					body: bodyText,
					paid,
					declined: r.declined,
					not_payable:
						r.res.status === 402 && !r.paid
							? r.offers.map((o) => o.network)
							: null,
				},
				null,
				1,
			),
		);
		return;
	}

	if (a.include) {
		console.log(`HTTP ${r.res.status}`);
		for (const [k, v] of r.res.headers) console.log(`${k}: ${v}`);
		console.log();
	}
	process.stdout.write(bodyText.endsWith("\n") ? bodyText : `${bodyText}\n`);
	if (paid) {
		console.error(
			`\npaid ${usd != null ? `$${usd.toFixed(4)} USDC` : `${r.paid?.offer.amount} base units`} via ${paid.protocol.toUpperCase()}${paid.hash ? ` · ${paid.explorer}` : ""}`,
		);
	} else if (r.declined) {
		console.error(
			"\nnot paid (declined) — pass --yes --max-usd N to authorize",
		);
	} else if (r.res.status === 402) {
		console.error(
			`\n402 not payable from a ${wallet.network} wallet; it accepts: ${r.offers.map((o) => o.network).join(", ") || "nothing readable"}`,
		);
	}
}

async function cmdSearch(a: Args): Promise<void> {
	const query = a.url; // first positional is the query
	if (!query) {
		console.error('usage: stellar-pay search "<task>" [--limit N] [--json]');
		process.exitCode = EXIT.usage;
		return;
	}
	const hits = searchCatalog(await loadCatalog(), query, a.limit ?? 5);
	const rows = hits.map((h) => ({
		url: h.url,
		host: h.host,
		title: h.title,
		price_usd: h.priceUSD,
		protocol: h.protocol,
		method: h.method ?? "GET or POST",
		alive_days: daysAlive(h),
		last_verified: h.lastCheckedAt,
	}));
	emit(a, { query, candidates: rows }, () => {
		if (!rows.length)
			return console.log(
				`no live match for "${query}" — try \`stellar-pay search\` with broader words, or a different task`,
			);
		for (const r of rows)
			console.log(
				`${r.price_usd != null ? `$${r.price_usd.toFixed(4)}`.padStart(9) : "     ?  "}  ${r.protocol.padEnd(5)} ${r.url}${r.title ? `  — ${r.title}` : ""}`,
			);
		console.log(
			`\npay one:  stellar-pay curl <url> --yes --max-usd ${a.maxUsd}`,
		);
	});
}

async function cmdPolicy(a: Args): Promise<void> {
	const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	if (a.url === "init") {
		if (existsSync(policyPath)) {
			console.error(
				`policy already exists at ${policyPath} — edit it directly`,
			);
			process.exitCode = EXIT.usage;
			return;
		}
		const example = {
			version: 1,
			mode: "denylist",
			default: { maxUsdPerCall: 0.05 },
			hosts: {
				"apiserver.mpprouter.dev": { maxUsdPerCall: 0.1 },
				"*.example.com": { maxUsdPerCall: 0.01, note: "subdomain wildcard" },
				"sketchy.example.net": { deny: true },
			},
		};
		mkdirSync(dirname(policyPath), { recursive: true });
		writeFileSync(policyPath, `${JSON.stringify(example, null, 2)}\n`, {
			mode: 0o600,
		});
		console.log(`wrote an example spend policy to ${policyPath}`);
		console.log(
			'edit it: set a per-host maxUsdPerCall, deny hosts, or switch mode to "allowlist" to pay only listed hosts.',
		);
		return;
	}
	const policy = loadPolicy();
	emit(a, { path: policyPath, active: !!policy, policy }, () => {
		if (!policy) {
			console.log(
				`no spend policy — every host is payable under the built-in ceiling.\ncreate one:  stellar-pay policy init   (${policyPath})`,
			);
			return;
		}
		console.log(`policy:  ${policyPath}`);
		console.log(`mode:    ${policy.mode ?? "denylist"}`);
		console.log(
			`default: $${policy.default?.maxUsdPerCall ?? "(built-in ceiling)"} per call`,
		);
		const hosts = Object.entries(policy.hosts ?? {});
		if (!hosts.length) console.log("hosts:   (none)");
		else
			for (const [h, r] of hosts)
				console.log(
					`  ${h.padEnd(32)} ${r.deny ? "DENY" : `$${r.maxUsdPerCall ?? "(default)"}`}`,
				);
	});
}

const HELP = `stellar-pay — pay HTTP 402s in USDC from a Stellar wallet

PAY
  curl <url> [-X M] [-H "K: V"] [-d body] [--yes] [--max-usd N] [--x402|--mpp] [-i] [--json]
                                 make a request; if it 402s, read the offer, pay, retry
  offers <url> [-X M] [-d body] [--json]     what a 402 asks — pays nothing
  verify <url> [-X M] [-d body] [--json]     seller check: is this a correct, Stellar-payable 402?
  search "<task>" [--limit N] [--json]       find live, Stellar-payable APIs for a task
  run [--yes --max-usd N] -- <cmd> …         wrap ANY command behind a proxy that pays its 402s
  policy [init] [--json]                     show or scaffold the per-host spend policy

WALLET
  whoami | balance [--json]
  setup [--save <name>] [--keychain] [--trustline]
  account list
  account import --name N [<file>]           restore from a backup file, or STELLAR_SECRET_KEY
  account export [--name N] [<file>]         back up (to a 0600 file, or stderr)
  account default --name N | remove --name N
  topup [--buy] [--amount N]                 fund the wallet (QR + on-ramps; --buy opens a card ramp)
  cashout [--json]                          the EXIT: where USDC on Stellar converts to fiat
  send <G…address|account-name> --amount <USDC|max> [--yes]
                                             send USDC; 'max' drains the balance
  history [--limit N] [--json]
  receipts [--limit N] [--verify ID] [--json]  the local ledger; --verify proves a row on-chain
  receipts check                         tamper check: every row id must re-derive from its content
  session open <url> [--deposit 5] | status | close <url>   one-way payment channels (testnet)
  bounty post|assign|open|submit|pack|dispute|resolve|status   escrowed verification bounties (testnet)
  bounty list --from <feed>   |   bounty watch --contract C…   earn: vet listings against the CHAIN, get paid
  vault create|topup|draw|status         fund an agent behind an ON-CHAIN spend cap (testnet)
  curl <url> --session                   pay via the host's channel — off-chain per call

AGENTS
  mcp                                        serve the MCP on stdio
  claude | codex [args…]                     launch the agent with the MCP mounted

GLOBAL   --sandbox (testnet)   --json (machine output)   -h/--help
         --account <name>   run one command as a specific saved wallet
         --force            replace an existing account on import/setup
ENV      STELLAR_SECRET_KEY, STELLAR_NETWORK, STELLAR_PAY_PASSPHRASE, STELLAR_PAY_MAX_USD_PER_CALL
EXIT     0 ok · 2 usage · 3 payment refused/declined · 4 no wallet · 1 runtime error`;

const commands: Record<string, (a: Args, init: RequestInit) => Promise<void>> =
	{
		mcp: cmdMcp,
		run: cmdRun,
		claude: cmdAgent,
		codex: cmdAgent,
		goose: cmdAgent,
		whoami: cmdWhoami,
		balance: cmdBalance,
		setup: cmdSetup,
		account: cmdAccount,
		accounts: cmdAccount,
		topup: cmdTopup,
		cashout: cmdCashout,
		send: cmdSend,
		history: cmdHistory,
		receipts: cmdReceipts,
		session: cmdSession,
		bounty: cmdBounty,
		vault: cmdVault,
		verify: cmdVerify,
		offers: cmdOffers,
		curl: cmdCurl,
		search: cmdSearch,
		policy: cmdPolicy,
	};

async function main() {
	const a = parse(process.argv.slice(2));
	if (a.sandbox) process.env.STELLAR_NETWORK = "stellar:testnet";
	const init: RequestInit = {
		method: a.method,
		headers: {
			"user-agent": "stellar-pay/0.1",
			...(a.body ? { "content-type": "application/json" } : {}),
			...a.headers,
		},
		body: a.body,
		signal: AbortSignal.timeout(60_000),
	};

	// `--help`/`-h` anywhere, `help`, or no command → the full reference on
	// stdout, exit 0. An UNKNOWN command → error on stderr, exit 2 (so a typo in
	// a scripted pipeline fails loudly instead of silently succeeding).
	// EXCEPT the launchers (`claude`/`codex`) and `run`: everything after the
	// command belongs to the child, so `stellar-pay claude --help` must reach
	// the agent, not print OUR help.
	const passthrough =
		a.cmd === "claude" ||
		a.cmd === "codex" ||
		a.cmd === "goose" ||
		a.cmd === "run";
	if (
		a.cmd === "help" ||
		(!passthrough &&
			process.argv.slice(2).some((t) => t === "-h" || t === "--help"))
	) {
		console.log(HELP);
		return;
	}
	const handler = commands[a.cmd];
	if (!handler) {
		console.error(`unknown command "${a.cmd}"\n`);
		console.error(HELP);
		process.exitCode = EXIT.usage;
		return;
	}
	await handler(a, init);
}

main().catch((e) => {
	const msg = (e as Error).message ?? String(e);
	// --json is a CONTRACT: a caller that asked for machine output must get
	// parseable JSON on failure too, not an empty stdout and a prose line on
	// stderr. (Caught by the meta-audit on `bounty watch --json`, whose new
	// refuse-without-a-baseline throw unwound to here.)
	if (process.argv.slice(2).includes("--json"))
		console.log(JSON.stringify({ error: msg }, null, 1));
	console.error(`error: ${msg}`);
	// A missing wallet is a distinct, recoverable condition (set a key), not a
	// generic crash — give agents a code they can branch on.
	process.exit(
		/no wallet|STELLAR_SECRET_KEY/i.test(msg) ? EXIT.noWallet : EXIT.runtime,
	);
});
