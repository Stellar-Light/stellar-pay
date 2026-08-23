/**
 * Drives the MCP server over stdio like a client would, ending with a PAID
 * curl against the testnet sandbox. Passes when every tool answers and the
 * paid call returns 200 with a settlement hash.
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
	console.log(
		"mcp-test — every tool over stdio, then a paid curl on testnet\n",
	);
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
		"curl",
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
	const cands = s.candidates as Array<{
		url: string;
		title: string;
		price_usd: number;
	}>;
	log(
		`search_catalog: ${cands.length} candidates; top = ${cands[0]?.title ?? cands[0]?.url} ($${cands[0]?.price_usd})`,
	);
	if (!cands.length) throw new Error("search_catalog returned nothing");

	const l = text(
		await client.callTool({ name: "list_catalog", arguments: {} }),
	);
	log(
		`list_catalog: ${l.total_live_endpoints} live endpoints across ${(l.hosts as unknown[]).length} hosts`,
	);

	const g = text(
		await client.callTool({
			name: "get_catalog_entry",
			arguments: { url: cands[0]?.url },
		}),
	) as unknown as Array<{ url: string; live: boolean }>;
	log(
		`get_catalog_entry: ${Array.isArray(g) ? `${g.length} row(s), live=${g[0]?.live}` : JSON.stringify(g).slice(0, 80)}`,
	);

	const b = text(await client.callTool({ name: "get_balance", arguments: {} }));
	log(
		`get_balance: ${b.public_key?.toString().slice(0, 6)}… xlm=${b.xlm} usdc=${b.usdc} others=${(b.others as unknown[])?.length}`,
	);

	const c = text(
		await client.callTool({
			name: "curl",
			arguments: { url: sb.url, method: "GET" },
		}),
	);
	log(
		`curl (paid): status=${c.status} paid=${JSON.stringify(c.paid ?? c.refused ?? c.not_payable)}`,
	);
	const paid = c.paid as { hash: string | null } | undefined;
	if (c.status !== 200 || !paid?.hash)
		throw new Error(
			`expected a paid 200 with a hash, got ${JSON.stringify(c).slice(0, 300)}`,
		);

	const r = text(
		await client.callTool({ name: "spend_report", arguments: {} }),
	);
	log(
		`spend_report: ${(r.payments as unknown[]).length} payment(s), spent_usd=${r.spent_usd}`,
	);

	await client.close();
	sb.close();
	log(`payer SPAY balance now ${await sb.payerBalance()} (was 100)`);
	console.log(
		"\nPASS — six tools answered over stdio and a 402 was paid through the MCP.",
	);
	process.exit(0);
}

main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
