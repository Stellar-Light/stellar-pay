/**
 * The MCP server: the same loop for agents, under a spending policy instead
 * of a prompt. Tools mirror pay.sh's (search_catalog, get_catalog_entry,
 * list_catalog, curl, get_balance) plus spend_report.
 *
 * Policy (env): STELLAR_PAY_MAX_USD_PER_CALL (default 0.05) and
 * STELLAR_PAY_SESSION_BUDGET_USD (default 1.00). Only USDC is auto-approved
 * on mainnet — an unknown asset has no price the policy can reason about.
 * Testnet approves anything: testnet tokens have no value.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
	daysAlive,
	groupByHost,
	loadCatalog,
	searchCatalog,
} from "./catalog.js";
import { payFetch } from "./pay/curl.js";
import { describeOffer, type Offer, offerUSD } from "./pay/offers.js";
import { balances, loadWallet, type Wallet } from "./pay/wallet.js";

const MAX_PER_CALL = Number(process.env.STELLAR_PAY_MAX_USD_PER_CALL ?? 0.05);
const SESSION_BUDGET = Number(process.env.STELLAR_PAY_SESSION_BUDGET_USD ?? 1);
const spend: {
	payments: Array<{
		at: string;
		url: string;
		usd: number | null;
		protocol: string;
		hash: string | null;
	}>;
	usd: number;
} = { payments: [], usd: 0 };

const json = (v: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }],
});
const explorer = (network: string, hash: string) =>
	`https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/tx/${hash}`;

let wallet: Wallet | null = null;
const getWallet = () => {
	wallet ??= loadWallet();
	return wallet;
};

function policy(w: Wallet, url: string) {
	return async (o: Offer): Promise<boolean> => {
		if (w.network === "stellar:testnet") return true;
		const usd = offerUSD(o);
		if (usd == null) return false;
		if (usd > MAX_PER_CALL) return false;
		if (spend.usd + usd > SESSION_BUDGET) return false;
		return true;
	};
}

function refusal(w: Wallet, o: Offer) {
	const usd = offerUSD(o);
	if (w.network !== "stellar:testnet" && usd == null)
		return `the offer is not USDC (${o.asset ?? "unknown asset"}); only USDC is auto-approved`;
	if (usd != null && usd > MAX_PER_CALL)
		return `$${usd.toFixed(4)} exceeds the per-call ceiling of $${MAX_PER_CALL} (STELLAR_PAY_MAX_USD_PER_CALL)`;
	if (usd != null && spend.usd + usd > SESSION_BUDGET)
		return `$${usd.toFixed(4)} would exceed the session budget of $${SESSION_BUDGET} (spent $${spend.usd.toFixed(4)})`;
	return "refused by policy";
}

export function buildServer() {
	const server = new McpServer({ name: "stellar-pay", version: "0.1.0" });

	server.registerTool(
		"search_catalog",
		{
			description: `Search live, Stellar-payable paid APIs for a user task and return ranked candidates with price and protocol.
Every candidate answered a real HTTP 402 naming stellar:pubnet within the last day. Use this for any actionable task ("find X", "get current Y", "pay for Z"); use list_catalog for feasibility questions. Pass the user's real task as query, not a provider name. Copy the returned url exactly into curl. Prices shown are from the last probe; the live 402 is authoritative and curl re-reads it.`,
			inputSchema: {
				query: z.string().describe("the user's task in their words"),
				max_results: z.number().int().min(1).max(20).optional(),
			},
		},
		async ({ query, max_results }) => {
			const hits = searchCatalog(await loadCatalog(), query, max_results ?? 5);
			return json({
				query,
				candidates: hits.map((h) => ({
					url: h.url,
					method:
						h.method ??
						"GET or POST (try GET; POST with a JSON body if it 405s)",
					host: h.host,
					title: h.title,
					description: h.description,
					price_usd: h.priceUSD,
					protocol: h.protocol,
					last_verified: h.lastCheckedAt,
					alive_days: daysAlive(h),
					score: h.score,
					reasons: h.reasons,
				})),
				selection_guidance: [
					"Prefer a narrow provider built for the task over a broad one with a partial match.",
					"Make the smallest useful request first; paid calls are sequential.",
					"State endpoint, expected calls and estimated spend before the first paid curl.",
				],
				next_step: hits.length
					? "Call curl with the chosen url (and method/body); the 402 is paid within the configured ceiling."
					: "No live match. Call list_catalog to see every host before answering that it cannot be done.",
			});
		},
	);

	server.registerTool(
		"list_catalog",
		{
			description: `List every host in the catalog of live, Stellar-payable APIs, grouped, with endpoint counts and price ranges.
Use this first for feasibility questions ("can stellar-pay do X?", "what can it buy?"). Never answer "no" from memory or from a search_catalog miss alone; inspect the full catalog with this tool first.`,
			inputSchema: {
				include_endpoints: z
					.boolean()
					.optional()
					.describe("also list every endpoint per host (large)"),
			},
		},
		async ({ include_endpoints }) => {
			const entries = await loadCatalog();
			const hosts = groupByHost(entries);
			return json({
				total_live_endpoints: entries.length,
				hosts: include_endpoints
					? hosts.map((h) => ({
							...h,
							urls: entries
								.filter((e) => e.host === h.host)
								.map((e) => ({
									url: e.url,
									title: e.title,
									price_usd: e.priceUSD,
								})),
						}))
					: hosts,
			});
		},
	);

	server.registerTool(
		"get_catalog_entry",
		{
			description:
				"Full detail for one endpoint (by url) or every endpoint on a host: price, protocol, accepted networks, when it was last verified and how long it has been alive. Use after search_catalog when you need the method, the description, or the liveness history.",
			inputSchema: { url: z.string().optional(), host: z.string().optional() },
		},
		async ({ url, host }) => {
			const all = await loadCatalog({ all: true });
			const rows = url
				? all.filter((e) => e.url === url)
				: host
					? all.filter((e) => e.host === host)
					: [];
			if (!rows.length)
				return json({
					error: "no such endpoint or host in the catalog",
					hint: "use search_catalog or list_catalog to find a valid url/host",
				});
			return json(
				rows.map((e) => ({
					...e,
					alive_days: daysAlive(e),
					live: e.acceptsStellar && e.lastStatus === "402",
				})),
			);
		},
	);

	server.registerTool(
		"curl",
		{
			description: `Make an HTTP request with 402 Payment Required handling: if the endpoint asks for payment, the challenge is read, the offer is checked against the spending policy, paid in USDC from the active Stellar wallet (x402 or MPP, fees usually sponsored by the server — no XLM needed), and the request is retried with the proof.
Copy urls from search_catalog exactly; do not call upstream hosts directly. body may be a string or a JSON value; JSON gets Content-Type: application/json. Returns the response status and body plus the payment made (protocol, amount, settlement hash) or the reason a payment was refused.`,
			inputSchema: {
				url: z.string().url(),
				method: z.string().optional(),
				headers: z.record(z.string(), z.string()).optional(),
				body: z
					.union([
						z.string(),
						z.record(z.string(), z.unknown()),
						z.array(z.unknown()),
					])
					.optional(),
				prefer: z.enum(["x402", "mpp"]).optional(),
			},
		},
		async ({ url, method, headers, body, prefer }) => {
			const w = getWallet();
			const isJson = body != null && typeof body !== "string";
			const init: RequestInit = {
				method: (method ?? (body != null ? "POST" : "GET")).toUpperCase(),
				headers: {
					"user-agent": "stellar-pay-mcp/0.1",
					...(isJson ? { "content-type": "application/json" } : {}),
					...(headers ?? {}),
				},
				body: body == null ? undefined : isJson ? JSON.stringify(body) : body,
				signal: AbortSignal.timeout(60_000),
			};
			let refused: Offer | null = null;
			const approve = policy(w, url);
			const r = await payFetch(url, init, {
				wallet: w,
				prefer,
				approve: async (o) => {
					const ok = await approve(o);
					if (!ok) refused = o;
					return ok;
				},
			});
			const text = await r.res.text();
			const out: Record<string, unknown> = {
				status: r.res.status,
				content_type: r.res.headers.get("content-type"),
				body: text.slice(0, 20_000),
				truncated: text.length > 20_000,
			};
			if (r.paid) {
				const usd = offerUSD(r.paid.offer);
				spend.payments.push({
					at: new Date().toISOString(),
					url,
					usd,
					protocol: r.paid.protocol,
					hash: r.paid.hash,
				});
				if (usd != null) spend.usd += usd;
				out.paid = {
					protocol: r.paid.protocol,
					offer: describeOffer(r.paid.offer),
					usd,
					hash: r.paid.hash,
					explorer: r.paid.hash ? explorer(w.network, r.paid.hash) : null,
				};
			} else if (refused) {
				out.refused = {
					offer: describeOffer(refused),
					reason: refusal(w, refused),
				};
			} else if (r.res.status === 402) {
				out.not_payable = {
					accepts: r.offers.map((o) => o.network),
					reason: `no offer payable from a ${w.network} wallet`,
				};
			}
			return json(out);
		},
	);

	server.registerTool(
		"get_balance",
		{
			description:
				"USDC and XLM balances of the active Stellar wallet. Check before paid work or when asked. No XLM is needed when the server sponsors fees, which the catalog's hosts do.",
			inputSchema: {},
		},
		async () => {
			const w = getWallet();
			const b = await balances(w.publicKey, w.network);
			return json({ public_key: w.publicKey, network: w.network, ...b });
		},
	);

	server.registerTool(
		"spend_report",
		{
			description:
				"What this session has paid so far, and the remaining budget under the configured policy.",
			inputSchema: {},
		},
		async () =>
			json({
				payments: spend.payments,
				spent_usd: spend.usd,
				per_call_ceiling_usd: MAX_PER_CALL,
				session_budget_usd: SESSION_BUDGET,
				remaining_usd: Math.max(0, SESSION_BUDGET - spend.usd),
			}),
	);

	return server;
}

export async function serveStdio() {
	await buildServer().connect(new StdioServerTransport());
}
