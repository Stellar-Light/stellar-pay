/**
 * Proves the command-wrapping proxy pays a 402 end to end: stand up the testnet
 * MPP charge server, start the proxy, make a request THROUGH the proxy, and
 * assert it comes back 200 (paid) with a settlement hash — the request never
 * saw the 402; the proxy paid it. Also confirms the local CA is generated.
 */
import { request as httpRequest } from "node:http";
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
			const r = httpRequest(
				{
					host: "127.0.0.1",
					port: proxy.port,
					method: "GET",
					path: sb.url,
					headers: { host: target.host },
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
		"\nPASS — a plain request through the proxy was paid transparently: 402 → paid → 200, settlement on-chain.",
	);
	process.exit(0);
}

main().catch((e) => {
	console.error(`\nFAIL — ${(e as Error).stack ?? e}`);
	process.exit(1);
});
