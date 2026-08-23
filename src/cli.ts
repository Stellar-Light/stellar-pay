#!/usr/bin/env node
/**
 * Working name: stellar-pay. Commands:
 *   curl <url> [-X M] [-H "K: V"]… [-d body] [--yes] [--max-usd N] [--x402|--mpp] [-i]
 *   offers <url> [-X M] [-H …] [-d body]     show what the 402 asks for; pay nothing
 *   balance | whoami
 *   setup [--trustline]                    new wallet (testnet: funded + trustline), or add trustline to STELLAR_SECRET_KEY
 *   send <G...address> --amount <USDC> [--yes]   send USDC to an address
 *   history                                recent USDC payments to/from the wallet
 *   mcp                                    serve the MCP on stdio
 *   claude [args…]                         launch Claude Code with the MCP mounted (like `pay claude`)
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
	describeOffer,
	type Offer,
	offerUSD,
	readOffers,
} from "./pay/offers.js";
import { addTrustline, history, sendUSDC, setupWallet } from "./pay/send.js";
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
	trustline: boolean;
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
		else if (t === "--max-usd") a.maxUsd = Number(next());
		else if (t === "--x402") a.prefer = "x402";
		else if (t === "--mpp") a.prefer = "mpp";
		else if (t === "-i" || t === "--include") a.include = true;
		else if (t === "--sandbox") a.sandbox = true;
		else if (t === "--amount") a.amount = next();
		else if (t === "--trustline") a.trustline = true;
		else if (!t.startsWith("-") && !a.url) a.url = t;
	}
	return a;
}

const explorer = (network: string, hash: string) =>
	`https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/tx/${hash}`;

async function ask(q: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	const ans = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
	rl.close();
	return ans === "y" || ans === "yes";
}

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

	if (a.cmd === "mcp") {
		const { serveStdio } = await import("./mcp.js");
		await serveStdio();
		return;
	}
	if (a.cmd === "claude") {
		// What `pay claude` does: mount the MCP and hand over. The server runs
		// from this checkout with the environment it inherits — the wallet key
		// never touches the config file.
		const here = fileURLToPath(new URL(".", import.meta.url));
		const tsx = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
		const cfg = {
			mcpServers: {
				"stellar-pay": {
					command: process.execPath,
					args: [tsx, join(here, "cli.ts"), "mcp"],
				},
			},
		};
		const file = join(mkdtempSync(join(tmpdir(), "stellar-pay-")), "mcp.json");
		writeFileSync(file, JSON.stringify(cfg));
		const child = spawn(
			"claude",
			["--mcp-config", file, ...process.argv.slice(3)],
			{ stdio: "inherit" },
		);
		child.on("exit", (code) => process.exit(code ?? 0));
		return;
	}
	if (a.cmd === "whoami") {
		const w = loadWallet();
		console.log(`${w.publicKey}  ${w.network}`);
		return;
	}
	if (a.cmd === "balance") {
		const w = loadWallet();
		const b = await balances(w.publicKey, w.network);
		if (!b.funded)
			return console.log(`${w.publicKey} is not funded on ${w.network}`);
		console.log(
			`USDC ${b.usdc ?? "(no trustline)"}  XLM ${b.xlm}${b.others.length ? `  +${b.others.length} other asset(s)` : ""}`,
		);
		return;
	}
	if (a.cmd === "setup") {
		const network = (process.env.STELLAR_NETWORK ?? "stellar:pubnet") as
			| "stellar:pubnet"
			| "stellar:testnet";
		// `setup --trustline` adds the USDC trustline to an existing wallet.
		if (a.trustline) {
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
		console.error(`secret:   ${r.secret}`); // to stderr so it isn't captured by a pipe
		console.error(
			"  ^ store this now — it is never shown again, and stellar-pay does not save it",
		);
		console.log(`network:  ${r.network}`);
		if (r.trustlineTx)
			console.log(`trustline: ${explorer(r.network, r.trustlineTx)}`);
		console.log(r.note);
		return;
	}
	if (a.cmd === "send") {
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
	if (a.cmd === "history") {
		const w = loadWallet();
		const rows = await history(w.publicKey, w.network, 20);
		if (!rows.length) return console.log("no payments yet");
		for (const h of rows)
			console.log(
				`${h.at.slice(0, 10)}  ${h.direction === "sent" ? "→" : "←"} ${h.amount.padStart(12)} ${h.asset.padEnd(5)} ${h.direction === "sent" ? "to" : "from"} ${h.counterparty.slice(0, 6)}…${h.counterparty.slice(-4)}`,
			);
		return;
	}
	if (a.cmd === "offers") {
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
	if (a.cmd === "curl") {
		if (!a.url) throw new Error("curl <url>");
		const wallet = loadWallet();
		const approve = async (o: Offer) => {
			const usd = offerUSD(o);
			const line = `pay ${describeOffer(o)} for ${a.method} ${a.url}`;
			if (a.yes) {
				if (usd == null) {
					console.error(
						`${line}\n  refused: --yes only auto-approves USDC; this asks for another asset`,
					);
					return false;
				}
				if (usd > a.maxUsd) {
					console.error(
						`${line}\n  refused: $${usd.toFixed(4)} exceeds --max-usd ${a.maxUsd}`,
					);
					return false;
				}
				console.error(`${line} (auto-approved under $${a.maxUsd})`);
				return true;
			}
			return ask(line);
		};
		const r = await payFetch(a.url, init, {
			wallet,
			approve,
			prefer: a.prefer,
		});
		if (a.include) {
			console.log(`HTTP ${r.res.status}`);
			r.res.headers.forEach((v, k) => console.log(`${k}: ${v}`));
			console.log();
		}
		process.stdout.write(await r.res.text());
		if (!process.stdout.write("")) process.stdout.write("\n");
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
	console.log(
		"stellar-pay  curl <url> | offers <url> | balance | whoami   (--yes --max-usd N --x402|--mpp -i --sandbox)",
	);
}

main().catch((e) => {
	console.error(`error: ${(e as Error).message}`);
	process.exit(1);
});
