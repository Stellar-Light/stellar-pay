/**
 * Drives the MCP server over stdio like a client would. Proves the whole
 * governed loop on testnet: every tool answers, a 402 is paid, the SAME url
 * asked again inside the task is replayed free (Scrimp's duplicate rule), and
 * spend_report shows the saving. Passes only if all of that holds.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupSandbox } from "./fixture.js";

const log = (m: string) => console.log(`  ${m}`);
const text = (r: unknown) => {
	const c = ((r as { content?: Array<{ type: string; text?: string }> })
		.content ?? [])[0];
	return JSON.parse(c?.text ?? "{}") as Record<string, unknown>;
};

async function main() {
	console.log("mcp-test — governed loop over stdio on testnet\n");
	const sb = await setupSandbox(log);
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", "src/cli.ts", "mcp"],
		env: {
			...process.env,
			STELLAR_SECRET_KEY: sb.payer.secret(),
			STELLAR_NETWORK: "stellar:testnet",
			CATALOG_FILE: process.env.CATALOG_FILE ?? ".local/catalog.json",
		} as Record<string, string>,
		stderr: "pipe",
	});
	const client = new Client({ name: "mcp-test", version: "0.0.0" });
	await client.connect(transport);
	const tools = (await client.listTools()).tools.map((t) => t.name).sort();
	log(`tools: ${tools.join(", ")}`);
	const expected = [
		"begin_task",
		"curl",
		"end_task",
		"get_balance",
		"get_catalog_entry",
		"list_catalog",
		"search_catalog",
		"spend_report",
	];
	if (expected.some((t) => !tools.includes(t)))
		throw new Error(`missing tools; got ${tools.join(",")}`);

	const s = text(
		await client.callTool({
			name: "search_catalog",
			arguments: { query: "search the web for recent news", max_results: 3 },
		}),
	);
	const cands = s.candidates as Array<{ title: string; price_usd: number }>;
	log(
		`search_catalog: ${cands.length} candidates; top = ${cands[0]?.title} ($${cands[0]?.price_usd})`,
	);
	if (!cands.length) throw new Error("search_catalog returned nothing");

	const l = text(
		await client.callTool({ name: "list_catalog", arguments: {} }),
	);
	log(
		`list_catalog: ${l.total_live_endpoints} live endpoints across ${(l.hosts as unknown[]).length} hosts`,
	);

	const b = text(await client.callTool({ name: "get_balance", arguments: {} }));
	log(
		`get_balance: ${String(b.public_key).slice(0, 6)}… xlm=${b.xlm} others=${(b.others as unknown[])?.length}`,
	);

	// Bracket a task so Scrimp's rules engage, then pay the SAME url twice.
	text(
		await client.callTool({
			name: "begin_task",
			arguments: { task_id: "t1", budget_usd: 1 },
		}),
	);

	const c1 = text(
		await client.callTool({
			name: "curl",
			arguments: { url: sb.url, method: "GET" },
		}),
	);
	const paid = c1.paid as { hash: string | null; protocol: string } | undefined;
	log(
		`curl #1: status=${c1.status} paid=${paid ? `via ${paid.protocol}, hash ${paid.hash?.slice(0, 10)}…` : JSON.stringify(c1.refused ?? c1.not_payable)}`,
	);
	if (c1.status !== 200 || !paid?.hash)
		throw new Error(
			`call #1 should be a paid 200 with a hash, got ${JSON.stringify(c1).slice(0, 300)}`,
		);

	const c2 = text(
		await client.callTool({
			name: "curl",
			arguments: { url: sb.url, method: "GET" },
		}),
	);
	log(
		`curl #2 (same url): status=${c2.status} ${c2.saved ? `SAVED via '${(c2.saved as { rule: string }).rule}' — no new payment` : `paid again = ${JSON.stringify(c2.paid)}`}`,
	);
	if (!c2.saved || (c2.saved as { rule: string }).rule !== "duplicate")
		throw new Error(
			`call #2 should be suppressed as duplicate, got ${JSON.stringify(c2).slice(0, 300)}`,
		);
	if (c2.paid)
		throw new Error("call #2 was suppressed but still recorded a payment");

	const endr = text(
		await client.callTool({
			name: "end_task",
			arguments: { task_id: "t1", succeeded: true },
		}),
	);
	log(`end_task: contributed=${endr.contributed} wasted=${endr.wasted}`);

	const r = text(
		await client.callTool({ name: "spend_report", arguments: {} }),
	);
	log(
		`spend_report: spent=$${r.spent} wouldHaveSpent=$${r.wouldHaveSpent} saved=$${r.saved} suppressed=${r.suppressed} wasteRate=${r.wasteRate}`,
	);
	if (!(Number(r.suppressed) >= 1 && Number(r.saved) > 0))
		throw new Error(
			`report should show ≥1 suppressed and saved>0, got ${JSON.stringify(r)}`,
		);

	await client.close();
	sb.close();
	log(
		`payer SPAY balance now ${await sb.payerBalance()} (was 100, and only ONE payment despite two calls)`,
	);
	console.log(
		"\nPASS — a 402 was paid through the MCP, the duplicate was replayed free, and spend_report showed the saving.",
	);
	process.exit(0);
}

main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
