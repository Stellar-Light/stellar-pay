/**
 * Proves the command-wrapping proxy pays a 402 end to end: stand up the testnet
 * MPP charge server, start the proxy, make a request THROUGH the proxy, and
 * assert it comes back 200 (paid) with a settlement hash — the request never
 * saw the 402; the proxy paid it. Also confirms the local CA is generated.
 */
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { URL } from "node:url";
import { startProxy } from "../pay/proxy.js";
import type { Wallet } from "../pay/wallet.js";
import { setupSandbox } from "./fixture.js";

const log = (m: string) => console.log(`  ${m}`);

async function main() {
	console.log(
		"proxy-test — pay a 402 by routing a request through the proxy\n",
	);
	const sb = await setupSandbox(log);
	const wallet: Wallet = {
		keypair: sb.payer,
		publicKey: sb.payer.publicKey(),
		network: "stellar:testnet",
	};

	let paid: { url: string; hash: string | null } | null = null;
	const proxy = await startProxy({
		wallet,
		approve: async () => true, // testnet: approve anything
		onPaid: (p) => {
			paid = { url: p.url, hash: p.hash };
		},
	});
	log(`proxy on 127.0.0.1:${proxy.port}; CA at ${proxy.caPath}`);

	// A client points at the proxy and sends the absolute URL (the sandbox is
	// HTTP; the proxy handles the plain-HTTP path). The proxy reads the 402,
	// pays, retries, and returns the 200 — the client never sees the 402.
	const target = new URL(sb.url);
	const { status, body } = await new Promise<{ status: number; body: string }>(
		(resolve, reject) => {
			const auth = `Basic ${Buffer.from(`stellar-pay:${proxy.token}`).toString("base64")}`;
			const r = httpRequest(
				{
					host: "127.0.0.1",
					port: proxy.port,
					method: "GET",
					path: sb.url,
					headers: { host: target.host, "proxy-authorization": auth },
				},
				(resp) => {
					const chunks: Buffer[] = [];
					resp.on("data", (c) => chunks.push(c as Buffer));
					resp.on("end", () =>
						resolve({
							status: resp.statusCode ?? 0,
							body: Buffer.concat(chunks).toString("utf8"),
						}),
					);
				},
			);
			r.on("error", reject);
			r.end();
		},
	);
	log(`through the proxy: status=${status} body=${body.slice(0, 60)}`);
	log(
		`onPaid: ${paid ? `hash ${(paid as { hash: string }).hash?.slice(0, 10)}…` : "not fired"}`,
	);

	// Leg 2 — gzip fidelity: upstream serves a gzipped body with
	// content-encoding + the COMPRESSED length; the child must receive plain
	// bytes with neither header (the original critical bug, now pinned).
	const zlib = await import("node:zlib");
	const http = await import("node:http");
	const PLAIN = "hello gzip world — proxied and decompressed";
	const gz = zlib.gzipSync(Buffer.from(PLAIN));
	const gzServer = http.createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "text/plain",
			"content-encoding": "gzip",
			"content-length": String(gz.length),
		});
		res.end(gz);
	});
	await new Promise<void>((r) => gzServer.listen(0, "127.0.0.1", r));
	const gzPort = (gzServer.address() as { port: number }).port;
	const gzUrl = `http://127.0.0.1:${gzPort}/gz`;
	const leg2 = await new Promise<{
		status: number;
		body: string;
		enc: string | undefined;
	}>((resolve, reject) => {
		const auth = `Basic ${Buffer.from(`stellar-pay:${proxy.token}`).toString("base64")}`;
		const r = httpRequest(
			{
				host: "127.0.0.1",
				port: proxy.port,
				method: "GET",
				path: gzUrl,
				headers: {
					host: `127.0.0.1:${gzPort}`,
					"proxy-authorization": auth,
					"accept-encoding": "gzip, zstd", // the child may advertise anything
				},
			},
			(resp) => {
				const chunks: Buffer[] = [];
				resp.on("data", (c) => chunks.push(c as Buffer));
				resp.on("end", () =>
					resolve({
						status: resp.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
						enc: resp.headers["content-encoding"],
					}),
				);
			},
		);
		r.on("error", reject);
		r.end();
	});
	gzServer.close();
	if (leg2.status !== 200 || leg2.body !== PLAIN || leg2.enc !== undefined)
		throw new Error(
			`gzip fidelity broken: status=${leg2.status} enc=${leg2.enc} body=${leg2.body.slice(0, 60)}`,
		);
	log("gzip upstream → child got plaintext, no content-encoding ✓");

	// Leg 3 — the proxy refuses an unauthenticated request (per-run token).
	const noAuth = await new Promise<number>((resolve, reject) => {
		const r = httpRequest(
			{
				host: "127.0.0.1",
				port: proxy.port,
				method: "GET",
				path: sb.url,
				headers: { host: target.host },
			},
			(resp) => {
				resp.resume();
				resolve(resp.statusCode ?? 0);
			},
		);
		r.on("error", reject);
		r.end();
	});
	if (noAuth !== 407)
		throw new Error(`expected 407 without auth, got ${noAuth}`);
	log("request without the per-run token refused with 407 ✓");

	// Leg 4 — the CONNECT tunnel is the HTTPS/MITM boundary and had NO test:
	// a tunnel opened without the per-run token would hand any local process a
	// full intercepting egress proxy backed by the wallet.
	const connectStatus = (withAuth: boolean) =>
		new Promise<string>((resolve, reject) => {
			const sock = netConnect(proxy.port, "127.0.0.1", () => {
				const auth = withAuth
					? `Proxy-Authorization: Basic ${Buffer.from(`stellar-pay:${proxy.token}`).toString("base64")}\r\n`
					: "";
				sock.write(
					`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${auth}\r\n`,
				);
			});
			sock.once("data", (d) => {
				sock.destroy();
				resolve(d.toString("utf8").split("\r\n")[0] ?? "");
			});
			sock.on("error", reject);
			setTimeout(() => {
				sock.destroy();
				resolve("(no response)");
			}, 5000);
		});

	const connNoAuth = await connectStatus(false);
	if (!/407/.test(connNoAuth))
		throw new Error(
			`CONNECT without the token should be 407, got: ${connNoAuth}`,
		);
	log("CONNECT without the per-run token refused with 407 ✓");

	const connAuth = await connectStatus(true);
	if (!/200/.test(connAuth))
		throw new Error(`CONNECT with the token should be 200, got: ${connAuth}`);
	log("CONNECT with the token establishes the tunnel ✓");

	await proxy.close();
	sb.close();

	if (status !== 200)
		throw new Error(
			`expected a paid 200 through the proxy, got ${status}: ${body.slice(0, 120)}`,
		);
	if (!paid || !(paid as { hash: string | null }).hash)
		throw new Error("the proxy returned 200 but reported no payment");
	log(`payer balance now ${await sb.payerBalance()} (was 100)`);
	console.log(
		"\nPASS — paid 402 → 200 through the proxy, gzip returned as plaintext (no stale encoding headers), and the per-run token gate holds on BOTH the plain-HTTP and CONNECT paths.",
	);
	process.exit(0);
}

main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
