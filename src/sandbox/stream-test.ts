/**
 * `run`'s proxy must STREAM, not buffer.
 *
 * The proxy used to call `arrayBuffer()` on the upstream response, which waits
 * for the response to finish. For JSON that is invisible; for an SSE stream or
 * a token-by-token LLM reply it is fatal — the wrapped tool sees nothing until
 * the stream ends, which for a long-lived stream is never.
 *
 * This asserts the property directly: an upstream that emits an event, waits,
 * then emits more, must reach the client through the proxy IN PIECES, with the
 * first piece arriving well before the last one. A buffering proxy fails the
 * timing assertion, not just a style check.
 *
 *   npm run test:stream
 */
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { startProxy } from "../pay/proxy.js";

let pass = 0,
	fail = 0;
const check = (n: string, c: boolean, d = "") => {
	if (c) {
		pass++;
		console.log(`  ✓ ${n}`);
	} else {
		fail++;
		console.log(`  ✗ ${n}  ${d}`);
	}
};

const GAP_MS = 400;

// An upstream that streams three SSE events with a real gap between them.
const upstream = createServer(async (_req, res) => {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	for (let i = 1; i <= 3; i++) {
		res.write(`data: chunk-${i}\n\n`);
		await new Promise((r) => setTimeout(r, GAP_MS));
	}
	res.end();
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upstreamPort = (upstream.address() as AddressInfo).port;

const proxy = await startProxy({
	wallet: {
		keypair: Keypair.random(),
		publicKey: "G".repeat(56),
		network: "stellar:testnet",
	} as never,
	approve: async () => false,
	guard: () => null,
});

const t0 = Date.now();
const arrivals: number[] = [];
const seen: string[] = [];

const status = await new Promise<number>((resolve, reject) => {
	// A plain-HTTP proxy request: absolute-URI request line + Proxy-Authorization,
	// which is exactly what `run` points a wrapped child at.
	const rq = httpRequest(
		{
			host: "127.0.0.1",
			port: proxy.port,
			method: "GET",
			path: `http://127.0.0.1:${upstreamPort}/sse`,
			headers: {
				host: `127.0.0.1:${upstreamPort}`,
				"proxy-authorization": `Basic ${Buffer.from(`stellar-pay:${proxy.token}`).toString("base64")}`,
			},
		},
		(resp) => {
			resp.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8").trim();
				if (text) {
					arrivals.push(Date.now() - t0);
					seen.push(text);
				}
			});
			resp.on("end", () => resolve(resp.statusCode ?? 0));
			resp.on("error", reject);
		},
	);
	rq.on("error", reject);
	rq.end();
});
check(
	"upstream answered 200 through the proxy",
	status === 200,
	String(status),
);

const first = arrivals[0] ?? Number.POSITIVE_INFINITY;
const last = arrivals[arrivals.length - 1] ?? 0;

check(
	"all three events arrived",
	seen.join(" ").includes("chunk-1") &&
		seen.join(" ").includes("chunk-3") &&
		arrivals.length >= 2,
	`${arrivals.length} arrivals: ${seen.join(" | ")}`,
);
// The load-bearing assertion: the FIRST byte must beat the LAST by roughly the
// upstream's own gap. A buffering proxy delivers everything at once, so first
// and last land within milliseconds of each other.
check(
	"the first event arrived BEFORE the stream finished (not buffered)",
	last - first >= GAP_MS,
	`first=${first}ms last=${last}ms spread=${last - first}ms (want >= ${GAP_MS}ms)`,
);
check(
	"the first event did not wait for the whole stream",
	first < GAP_MS * 2.5,
	`first=${first}ms`,
);

await proxy.close();
upstream.closeAllConnections?.();
await new Promise<void>((r) => upstream.close(() => r()));

console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} streaming checks (spread ${last - first}ms)`,
);
process.exit(fail === 0 ? 0 : 1);
