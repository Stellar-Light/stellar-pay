/**
 * The command-wrapping proxy — pay.sh's headline: run ANY tool behind a local
 * proxy that intercepts its HTTP 402s, pays, and retries, so a tool we didn't
 * write pays for Stellar-gated APIs transparently.
 *
 * HTTPS 402s can't be read without terminating TLS, so the proxy is a MITM: it
 * generates a local root CA once, mints a leaf cert per host on the fly, and
 * the wrapped child trusts that CA (via env — never installed system-wide).
 * Every decrypted request is run through payFetch, which already does the
 * 402 → read offers → pay → retry loop, so all the payment logic is reused;
 * the proxy only decrypts and hands off.
 *
 * Scope: localhost-only, alive only while the wrapped command runs, CA trusted
 * by the child alone. A per-request approve gate bounds spend the same way the
 * CLI/MCP do.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import forge from "node-forge";
import { payFetch } from "./curl.js";
import { type Offer, offerUSD } from "./offers.js";
import type { Wallet } from "./wallet.js";

const CONFIG_DIR =
	process.env.STELLAR_PAY_HOME ??
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"stellar-pay",
	);

type CA = {
	certPem: string;
	keyPem: string;
	cert: forge.pki.Certificate;
	key: forge.pki.PrivateKey;
};

/** Generate (once) and cache a local root CA. Its cert path is what the child trusts. */
export function ensureCA(): { caPath: string; ca: CA } {
	mkdirSync(CONFIG_DIR, { recursive: true });
	const caPath = join(CONFIG_DIR, "proxy-ca.pem");
	const keyPath = join(CONFIG_DIR, "proxy-ca-key.pem");
	try {
		const certPem = readFileSync(caPath, "utf8");
		const keyPem = readFileSync(keyPath, "utf8");
		return {
			caPath,
			ca: {
				certPem,
				keyPem,
				cert: forge.pki.certificateFromPem(certPem),
				key: forge.pki.privateKeyFromPem(keyPem),
			},
		};
	} catch {
		// mint a fresh CA
	}
	const keys = forge.pki.rsa.generateKeyPair(2048);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = "01";
	cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
	cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000);
	const attrs = [
		{ name: "commonName", value: "stellar-pay local proxy CA" },
		{ name: "organizationName", value: "stellar-pay" },
	];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);
	cert.setExtensions([
		{ name: "basicConstraints", cA: true },
		{ name: "keyUsage", keyCertSign: true, cRLSign: true },
	]);
	cert.sign(keys.privateKey, forge.md.sha256.create());
	const certPem = forge.pki.certificateToPem(cert);
	const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
	writeFileSync(caPath, certPem);
	writeFileSync(keyPath, keyPem, { mode: 0o600 });
	return { caPath, ca: { certPem, keyPem, cert, key: keys.privateKey } };
}

/** Mint a leaf cert for one host, signed by the CA. Cached per host. */
function leafFactory(ca: CA) {
	const cache = new Map<string, tls.SecureContext>();
	return (host: string): tls.SecureContext => {
		const hit = cache.get(host);
		if (hit) return hit;
		const keys = forge.pki.rsa.generateKeyPair(2048);
		const cert = forge.pki.createCertificate();
		cert.publicKey = keys.publicKey;
		cert.serialNumber =
			Date.now().toString(16) + Math.floor(performance.now()).toString(16);
		cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
		cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000);
		cert.setSubject([{ name: "commonName", value: host }]);
		cert.setIssuer(ca.cert.subject.attributes);
		cert.setExtensions([
			{ name: "basicConstraints", cA: false },
			{ name: "subjectAltName", altNames: [{ type: 2, value: host }] },
		]);
		cert.sign(ca.key as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
		const ctx = tls.createSecureContext({
			key: forge.pki.privateKeyToPem(keys.privateKey),
			cert: forge.pki.certificateToPem(cert),
		});
		cache.set(host, ctx);
		return ctx;
	};
}

const HOP = new Set([
	"proxy-connection",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
]);

export type ProxyOptions = {
	wallet: Wallet;
	approve: (offer: Offer) => Promise<boolean>;
	prefer?: "x402" | "mpp";
	onPaid?: (info: {
		url: string;
		usd: number | null;
		protocol: string;
		hash: string | null;
	}) => void;
	onRefused?: (info: { url: string; reason: string }) => void;
};

/** Start the wrapping proxy. Returns its port, the CA path, and a close(). */
export async function startProxy(
	o: ProxyOptions,
): Promise<{ port: number; caPath: string; close: () => Promise<void> }> {
	const { caPath, ca } = ensureCA();
	const leaf = leafFactory(ca);

	// Every decrypted request runs through payFetch and its result is written back.
	const handle = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		scheme: string,
	) => {
		const host = req.headers.host ?? "";
		const url = /^https?:\/\//.test(req.url ?? "")
			? (req.url as string)
			: `${scheme}://${host}${req.url ?? ""}`;
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const body = chunks.length ? Buffer.concat(chunks) : undefined;
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers))
			if (!HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
		try {
			const r = await payFetch(
				url,
				{
					method: req.method,
					headers,
					body,
					signal: AbortSignal.timeout(120_000),
				},
				{ wallet: o.wallet, approve: o.approve, prefer: o.prefer },
			);
			if (r.paid)
				o.onPaid?.({
					url,
					usd: offerUSD(r.paid.offer),
					protocol: r.paid.protocol,
					hash: r.paid.hash,
				});
			if (r.declined && r.offers[0])
				o.onRefused?.({
					url,
					reason: `payment declined for ${r.offers[0].network}`,
				});
			const out: Record<string, string> = {};
			r.res.headers.forEach((v, k) => {
				if (!HOP.has(k.toLowerCase())) out[k] = v;
			});
			res.writeHead(r.res.status, out);
			const buf = Buffer.from(await r.res.arrayBuffer());
			res.end(buf);
		} catch (e) {
			res.writeHead(502, { "content-type": "text/plain" });
			res.end(`stellar-pay proxy error: ${(e as Error).message}`);
		}
	};

	// TLS terminator for intercepted HTTPS (leaf cert chosen by SNI).
	const tlsServer = https.createServer(
		{ SNICallback: (name, cb) => cb(null, leaf(name)) },
		(req, res) => handle(req, res, "https"),
	);
	await new Promise<void>((resolve) =>
		tlsServer.listen(0, "127.0.0.1", resolve),
	);
	const tlsPort = (tlsServer.address() as AddressInfo).port;

	// The proxy the child points at: plain-HTTP requests handled directly;
	// CONNECT tunnels are redirected into our own TLS terminator above.
	const proxy = http.createServer((req, res) => handle(req, res, "http"));
	proxy.on("connect", (_req, clientSocket, head) => {
		const upstream = netConnect(tlsPort, "127.0.0.1", () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head?.length) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on("error", () => clientSocket.destroy());
		clientSocket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const port = (proxy.address() as AddressInfo).port;

	return {
		port,
		caPath,
		close: () =>
			new Promise<void>((resolve) => {
				tlsServer.close(() => proxy.close(() => resolve()));
			}),
	};
}

/** Env that makes a child route through the proxy and trust its CA (Node, curl, python, etc.). */
export function proxyEnv(port: number, caPath: string): Record<string, string> {
	const url = `http://127.0.0.1:${port}`;
	return {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		http_proxy: url,
		https_proxy: url,
		ALL_PROXY: url,
		all_proxy: url,
		NODE_EXTRA_CA_CERTS: caPath, // Node tools
		SSL_CERT_FILE: caPath, // OpenSSL / curl
		CURL_CA_BUNDLE: caPath, // curl
		REQUESTS_CA_BUNDLE: caPath, // python requests
		GIT_SSL_CAINFO: caPath, // git
	};
}
