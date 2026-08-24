#!/usr/bin/env node
/**
 * Working name: stellar-pay. Commands:
 *   curl <url> [-X M] [-H "K: V"]… [-d body] [--yes] [--max-usd N] [--x402|--mpp] [-i]
 *   offers <url> [-X M] [-H …] [-d body]     show what the 402 asks for; pay nothing
 *   verify <url> [-X M] [-d body]          seller check: is this a correct, Stellar-payable 402?
 *   balance | whoami
 *   setup [--trustline]                    new wallet (testnet: funded + trustline), or add trustline to STELLAR_SECRET_KEY
 *   send <G...address> --amount <USDC> [--yes]   send USDC to an address
 *   history                                recent payments (any asset) to/from the wallet
 *   topup [--buy] [--amount N]             fund this wallet: --buy opens an on-ramp + waits; else QR + address + ramps
 *   account <list|import|default|remove|export> [--name N]   manage saved wallets (encrypted file or --keychain)
 *   setup --save <name> [--keychain]       new wallet sealed in the encrypted file, or (macOS) the Keychain
 *   run [--yes --max-usd N] -- <cmd>…      wrap ANY command behind a proxy that pays its 402s
 *   mcp                                    serve the MCP on stdio
 *   claude|codex [args…]                   launch the agent with the MCP mounted
 * Wallet: STELLAR_SECRET_KEY, network: STELLAR_NETWORK (default stellar:pubnet).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { payFetch } from "./pay/curl.js";
import {
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
	type Offer,
	offerUSD,
	readOffers,
} from "./pay/offers.js";
import { autoApprove, explorer } from "./pay/policy.js";
import { BRIDGES, EXCHANGES, onramps, partnerRamps } from "./pay/ramps.js";
import {
	addTrustline,
	history,
	payUri,
	pollFunding,
	sendUSDC,
	setupWallet,
	topupInfo,
} from "./pay/send.js";
import { verifyEndpoint } from "./pay/verify.js";
import { balances, loadWallet } from "./pay/wallet.js";

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
};

function parse(argv: string[]): Args {
	const a: Args = {
		cmd: argv[0] ?? "help",
		method: "GET",
		headers: {},
		yes: false,
		maxUsd: 0.1,
		include: false,
		sandbox: false,
		trustline: false,
		buy: false,
		keychain: false,
	};
	for (let i = 1; i < argv.length; i++) {
		const t = argv[i] ?? "";
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
			if (Number.isFinite(n) && n > 0) a.maxUsd = n;
			else {
				console.error("--max-usd must be a positive number");
				process.exit(1);
			}
		} else if (t === "--x402") a.prefer = "x402";
		else if (t === "--mpp") a.prefer = "mpp";
		else if (t === "-i" || t === "--include") a.include = true;
		else if (t === "--sandbox") a.sandbox = true;
		else if (t === "--amount") a.amount = next();
		else if (t === "--name" || t === "--save") a.name = next();
		else if (t === "--trustline") a.trustline = true;
		else if (t === "--buy") a.buy = true;
		else if (t === "--keychain") a.keychain = true;
		else if (!t.startsWith("-") && !a.url) a.url = t;
	}
	return a;
}

function openBrowser(url: string): void {
	const cmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd"
				: "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
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
	await ensureSecretLoaded();
	const wallet = loadWallet();
	const { startProxy, proxyEnv } = await import("./pay/proxy.js");
	const approve = async (o: Offer) => {
		const line = `pay ${describeOffer(o)} for a request from \`${command}\``;
		if (!a.yes && wallet.network !== "stellar:testnet") return ask(line);
		const v = autoApprove(o, { network: wallet.network, maxUsd: a.maxUsd });
		console.error(`${line} ${v.ok ? "(approved)" : `(refused: ${v.reason})`}`);
		return v.ok;
	};
	const proxy = await startProxy({
		wallet,
		prefer: a.prefer,
		approve,
		onPaid: (p) =>
			console.error(
				`  ✓ paid ${p.usd != null ? `$${p.usd.toFixed(4)}` : "?"} via ${p.protocol.toUpperCase()} for ${p.url}${p.hash ? ` · ${explorer(wallet.network, p.hash)}` : ""}`,
			),
	});
	console.error(
		`stellar-pay: proxy on 127.0.0.1:${proxy.port}, wrapping \`${command}\` (Ctrl-C to stop)`,
	);
	// The wrapped command is untrusted — that's why it's behind the proxy.
	// The proxy (this parent) holds the wallet and does all signing, so the
	// child needs NO key material. Never inherit the decrypted secret or
	// the keystore passphrase into it.
	const {
		STELLAR_SECRET_KEY: _sk,
		STELLAR_PAY_PASSPHRASE: _pp,
		...childEnv
	} = process.env;
	const child = spawn(command, cmdArgs, {
		stdio: "inherit",
		env: { ...childEnv, ...proxyEnv(proxy.port, proxy.caPath, proxy.token) },
	});
	child.on("exit", async (code) => {
		await proxy.close();
		process.exit(code ?? 0);
	});
	return;
}

async function cmdAgent(a: Args): Promise<void> {
	// Mount the MCP into the agent and hand over. The server runs from this
	// checkout with the environment it inherits, so the wallet key never
	// touches an agent config file. claude takes a --mcp-config file; codex
	// takes per-invocation `-c mcp_servers.<name>.…` overrides (no global
	// config is mutated either way).
	const here = fileURLToPath(new URL(".", import.meta.url));
	const tsx = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
	const server = [process.execPath, tsx, join(here, "cli.ts"), "mcp"];
	const passthrough = process.argv.slice(3);
	let child: ReturnType<typeof spawn>;
	if (a.cmd === "claude") {
		const cfg = {
			mcpServers: {
				"stellar-pay": { command: server[0], args: server.slice(1) },
			},
		};
		const file = join(mkdtempSync(join(tmpdir(), "stellar-pay-")), "mcp.json");
		writeFileSync(file, JSON.stringify(cfg));
		child = spawn("claude", ["--mcp-config", file, ...passthrough], {
			stdio: "inherit",
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
			{ stdio: "inherit" },
		);
	}
	child.on("exit", (code) => process.exit(code ?? 0));
	return;
}

async function cmdWhoami(): Promise<void> {
	await ensureSecretLoaded();
	const w = loadWallet();
	console.log(`${w.publicKey}  ${w.network}`);
	return;
}

async function cmdBalance(): Promise<void> {
	await ensureSecretLoaded();
	const w = loadWallet();
	const b = await balances(w.publicKey, w.network);
	if (!b.funded)
		return console.log(`${w.publicKey} is not funded on ${w.network}`);
	console.log(
		`USDC ${b.usdc ?? "(no trustline)"}  XLM ${b.xlm}${b.others.length ? `  +${b.others.length} other asset(s)` : ""}`,
	);
	return;
}

async function cmdSetup(a: Args): Promise<void> {
	const network = (process.env.STELLAR_NETWORK ?? "stellar:pubnet") as
		| "stellar:pubnet"
		| "stellar:testnet";
	// `setup --trustline` adds the USDC trustline to an existing wallet.
	if (a.trustline) {
		await ensureSecretLoaded();
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
			return console.error(
				"usage: STELLAR_SECRET_KEY=S… stellar-pay account import --name <name>",
			);
		const secret = process.env.STELLAR_SECRET_KEY;
		if (!secret)
			return console.error(
				"set STELLAR_SECRET_KEY to the S… secret you want to import, then re-run",
			);
		const r = await addAccount(a.name, secret, network, {
			makeDefault: true,
			backend: a.keychain ? "keychain" : "file",
		});
		console.log(`imported "${r.name}" — ${r.publicKey}`);
		return;
	}
	if (sub === "default") {
		if (!a.name)
			return console.error("usage: stellar-pay account default --name <name>");
		setDefault(a.name);
		console.log(`default is now "${a.name}"`);
		return;
	}
	if (sub === "remove" || sub === "rm") {
		if (!a.name)
			return console.error("usage: stellar-pay account remove --name <name>");
		removeAccount(a.name);
		console.log(`removed "${a.name}"`);
		return;
	}
	if (sub === "export") {
		const secret = await exportSecret(a.name);
		console.error(secret); // stderr, and only after the passphrase check inside exportSecret
		return;
	}
	console.error(
		"account subcommands: list | import --name N | default --name N | remove --name N | export [--name N]",
	);
	process.exitCode = 1;
	return;
}

async function cmdTopup(a: Args): Promise<void> {
	await ensureSecretLoaded();
	const w = loadWallet();
	const t = await topupInfo(w);
	const uri = payUri(t.address, t.network, a.amount);
	// `--buy`: open a hosted on-ramp in the browser and wait for the deposit,
	// the way `pay topup` does. The address is pre-filled where the provider
	// supports it; otherwise it's printed to paste.
	if (a.buy && t.network === "stellar:pubnet") {
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
			onTick: (ms) => process.stderr.write(`\r  ${Math.round(ms / 1000)}s…   `),
		});
		process.stderr.write("\r");
		console.log(
			got
				? `✓ received ${got.received} USDC — balance now ${got.balance}`
				: "▲ nothing arrived in 5m — re-run `stellar-pay topup --buy` to keep watching",
		);
		return;
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
	await ensureSecretLoaded();
	const w = loadWallet();
	const to = a.url ?? ""; // first positional
	const amount = a.amount ?? "";
	if (!to || !amount) {
		console.error(
			"usage: stellar-pay send <G...address> --amount <USDC>  [--yes]",
		);
		process.exitCode = 1;
		return;
	}
	const line = `send ${amount} USDC to ${to.slice(0, 6)}…${to.slice(-4)} on ${w.network}`;
	if (!a.yes && !(await ask(line))) {
		console.error("not sent");
		process.exitCode = 2;
		return;
	}
	const r = await sendUSDC(w, to, amount);
	console.log(`sent ${r.amount} USDC · ${explorer(w.network, r.hash)}`);
	return;
}

async function cmdHistory(): Promise<void> {
	await ensureSecretLoaded();
	const w = loadWallet();
	const rows = await history(w.publicKey, w.network, 20);
	if (!rows.length) return console.log("no payments yet");
	for (const h of rows)
		console.log(
			`${h.at.slice(0, 10)}  ${h.direction === "sent" ? "→" : "←"} ${h.amount.padStart(12)} ${h.asset.padEnd(5)} ${h.direction === "sent" ? "to" : "from"} ${h.counterparty.slice(0, 6)}…${h.counterparty.slice(-4)}`,
		);
	return;
}

async function cmdVerify(a: Args): Promise<void> {
	if (!a.url) {
		console.error("usage: stellar-pay verify <url> [-X METHOD] [-d body]");
		process.exitCode = 1;
		return;
	}
	if (!URL.canParse(a.url) || !/^https?:$/.test(new URL(a.url).protocol)) {
		console.error(`"${a.url}" is not a valid http(s) URL`);
		process.exitCode = 1;
		return;
	}
	const v = await verifyEndpoint(a.url, a.method, a.body);
	for (const c of v.checks)
		console.log(
			`  ${c.ok ? "\u2713" : "\u2717"} ${c.label.padEnd(24)} ${c.detail}`,
		);
	console.log(
		v.payable
			? "\n\u2713 PAYABLE — this endpoint answers a correct Stellar 402; the probe will index it and a stellar-pay client can pay it."
			: "\n\u2717 NOT PAYABLE from a Stellar wallet yet — fix the \u2717 items above.",
	);
	if (!v.payable) process.exitCode = 1;
	return;
}

async function cmdOffers(a: Args, init: RequestInit): Promise<void> {
	if (!a.url) throw new Error("offers <url>");
	const r = await fetch(a.url, init);
	if (r.status !== 402) return console.log(`${r.status} — no payment asked`);
	const offers = readOffers(r.headers, await r.text());
	if (!offers.length)
		return console.log(
			"402 but no readable offer (neither x402 accepts nor an MPP challenge)",
		);
	for (const o of offers)
		console.log(
			`${describeOffer(o)}${o.description ? ` — ${o.description}` : ""}`,
		);
	return;
}

async function cmdCurl(a: Args, init: RequestInit): Promise<void> {
	if (!a.url) throw new Error("curl <url>");
	await ensureSecretLoaded();
	const wallet = loadWallet();
	const approve = async (o: Offer) => {
		const line = `pay ${describeOffer(o)} for ${a.method} ${a.url}`;
		if (!a.yes && wallet.network !== "stellar:testnet") return ask(line);
		const v = autoApprove(o, { network: wallet.network, maxUsd: a.maxUsd });
		console.error(
			`${line}${v.ok ? " (approved)" : `\n  refused: ${v.reason}`}`,
		);
		return v.ok;
	};
	const r = await payFetch(a.url, init, {
		wallet,
		approve,
		prefer: a.prefer,
	});
	if (a.include) {
		console.log(`HTTP ${r.res.status}`);
		for (const [k, v] of r.res.headers) console.log(`${k}: ${v}`);
		console.log();
	}
	const bodyText = await r.res.text();
	process.stdout.write(bodyText.endsWith("\n") ? bodyText : `${bodyText}\n`);
	if (r.paid) {
		const usd = offerUSD(r.paid.offer);
		console.error(
			`\npaid ${usd != null ? `$${usd.toFixed(4)} USDC` : `${r.paid.offer.amount} base units`} via ${r.paid.protocol.toUpperCase()}${r.paid.hash ? ` · ${explorer(wallet.network, r.paid.hash)}` : ""}`,
		);
	} else if (r.declined) {
		console.error("\nnot paid (declined)");
		process.exitCode = 2;
	} else if (r.res.status === 402) {
		console.error(
			`\n402 not payable from a ${wallet.network} wallet; it accepts: ${r.offers.map((o) => o.network).join(", ") || "nothing readable"}`,
		);
		process.exitCode = 1;
	}
	if (!r.res.ok && !process.exitCode) process.exitCode = 1;
	return;
}

const commands: Record<string, (a: Args, init: RequestInit) => Promise<void>> =
	{
		mcp: cmdMcp,
		run: cmdRun,
		claude: cmdAgent,
		codex: cmdAgent,
		whoami: cmdWhoami,
		balance: cmdBalance,
		setup: cmdSetup,
		account: cmdAccount,
		accounts: cmdAccount,
		topup: cmdTopup,
		send: cmdSend,
		history: cmdHistory,
		verify: cmdVerify,
		offers: cmdOffers,
		curl: cmdCurl,
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

	const handler = commands[a.cmd];
	if (!handler) {
		console.log(
			"stellar-pay  curl <url> | offers <url> | balance | whoami   (--yes --max-usd N --x402|--mpp -i --sandbox)",
		);
		return;
	}
	await handler(a, init);
}

main().catch((e) => {
	console.error(`error: ${(e as Error).message}`);
	process.exit(1);
});
