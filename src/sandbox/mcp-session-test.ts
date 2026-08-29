/**
 * MCP session tools e2e — an AGENT (MCP client) drives the channel lifecycle.
 *
 * The point: session mode is only real for agent commerce when agents can
 * use it. This drives the MCP over stdio: session_open → (operator step:
 * sandbox reboots in channel mode) → curl{session:true} ×2 → session_status
 * → session_close, on testnet, with the receipt chain checked at the end.
 *
 *   npm run test:mcp-session
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@stellar/stellar-sdk";

const PORT = Number(process.env.MCP_SESSION_PORT ?? 8895);
const DIR = mkdtempSync(join(tmpdir(), "stellar-pay-mcp-session-"));
const CALLS = 2;

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

const text = (r: unknown) =>
	JSON.parse(
		(r as { content: Array<{ type: string; text: string }> }).content.find(
			(c) => c.type === "text",
		)?.text ?? "{}",
	);

async function main() {
	console.log("═══ MCP session tools e2e — agent-driven lifecycle ═══\n");
	const buyer = Keypair.random();
	const seller = Keypair.random();
	await Promise.all([
		friendbot(buyer.publicKey()),
		friendbot(seller.publicKey()),
	]);
	const base = `http://127.0.0.1:${PORT}`;

	let sandbox = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
		env: {
			...process.env,
			SELLER_SECRET_KEY: seller.secret(),
			PORT: String(PORT),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const wait = async () => {
		for (let i = 0; i < 40; i++) {
			try {
				if ((await fetch(`${base}/health`)).ok) return;
			} catch {}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error("sandbox not healthy");
	};

	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", "src/cli.ts", "mcp"],
		env: {
			...process.env,
			STELLAR_SECRET_KEY: buyer.secret(),
			STELLAR_NETWORK: "stellar:testnet",
			STELLAR_PAY_SESSION_DIR: DIR,
			STELLAR_PAY_ALLOW_PRIVATE: "1",
			CATALOG_FILE: ".local/catalog.json",
		} as Record<string, string>,
		stderr: "pipe",
	});
	const client = new Client({ name: "mcp-session-test", version: "0.0.0" });

	try {
		await wait();
		await client.connect(transport);
		const tools = (await client.listTools()).tools.map((t) => t.name);
		for (const t of ["session_open", "session_status", "session_close"])
			if (!tools.includes(t)) throw new Error(`tool ${t} missing`);
		console.log(
			"tools    session_open / session_status / session_close present",
		);

		// 1. OPEN through the agent tool (default 5 XLM deposit).
		const open = text(
			await client.callTool({
				name: "session_open",
				arguments: { url: `${base}/data` },
			}),
		) as {
			channel_contract?: string;
			commitment_pubkey_hex?: string;
			deposit_xlm?: number;
			error?: string;
		};
		if (!open.channel_contract) throw new Error(`open failed: ${open.error}`);
		console.log(
			`open     ${open.channel_contract.slice(0, 10)}… deposit ${open.deposit_xlm} XLM`,
		);

		// 2. Operator step: reboot sandbox in channel mode.
		sandbox.kill();
		for (let i = 0; i < 40; i++) {
			try {
				await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) });
				await new Promise((r) => setTimeout(r, 250));
			} catch {
				break;
			}
		}
		sandbox = spawn("npx", ["tsx", "sandbox-server/server.ts"], {
			env: {
				...process.env,
				SELLER_SECRET_KEY: seller.secret(),
				PORT: String(PORT),
				CHANNEL_CONTRACT: open.channel_contract,
				COMMITMENT_PUBKEY: open.commitment_pubkey_hex,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		await wait();

		// 3. PAY off-chain through the curl tool with session:true.
		for (let i = 1; i <= CALLS; i++) {
			const r = text(
				await client.callTool({
					name: "curl",
					arguments: { url: `${base}/data-session`, session: true },
				}),
			) as { status?: number; session?: { ms: number }; error?: string };
			if (r.status !== 200) throw new Error(`session call ${i}: ${r.error}`);
			console.log(`pay #${i}   ${r.session?.ms} ms off-chain`);
		}

		// 4. STATUS shows the cumulative.
		const status = text(
			await client.callTool({ name: "session_status", arguments: {} }),
		) as { channels: Record<string, { last_cumulative: string }> };
		const cum = Object.values(status.channels)[0]?.last_cumulative;
		console.log(`status   cumulative ${cum}`);
		if (cum !== String(10_000 * CALLS))
			throw new Error(`cumulative ${cum} wrong`);

		// 5. CLOSE settles.
		const close = text(
			await client.callTool({
				name: "session_close",
				arguments: { url: `${base}/data-session` },
			}),
		) as { closed?: boolean; settled_cumulative?: string; error?: string };
		if (!close.closed) throw new Error(`close failed: ${close.error}`);
		console.log(`close    settled ${close.settled_cumulative} stroops`);

		// 6. Receipts: open ← payments chain, written by the MCP surface.
		const ledger = readFileSync(join(DIR, "receipts.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map(
				(l) =>
					JSON.parse(l) as {
						kind: string;
						refs?: string[];
						id: string;
						detail?: { surface?: string };
					},
			);
		const openRow = ledger.find((r) => r.kind === "channel-open");
		const pays = ledger.filter(
			(r) =>
				r.kind === "payment" &&
				r.refs?.includes(openRow?.id ?? "") &&
				r.detail?.surface === "mcp",
		);
		console.log(`ledger   open ${openRow?.id} ← ${pays.length} mcp payment(s)`);
		if (!openRow || pays.length !== CALLS)
			throw new Error("receipt chain incomplete");

		console.log(
			"\nRESULT: PASS — an MCP agent opened the channel, paid off-chain, read status, closed, and every step is receipted.",
		);
	} finally {
		sandbox.kill();
		await client.close().catch(() => {});
	}
}

main().catch((err) => {
	console.error("FATAL:", err?.message ?? err);
	process.exit(1);
});
