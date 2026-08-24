/**
 * The command-wrapping proxy — pay.sh's headline: run ANY tool behind a local
 * proxy that intercepts its HTTP 402s, pays, and retries, so a tool we didn't
 * write pays for Stellar-gated APIs transparently.
 *
 * HTTPS 402s can't be read without terminating TLS, so the proxy is a MITM: it
 * mints a fresh ephemeral root CA per run (signing key in memory only, never on
 * disk), a leaf cert per host on the fly, and the wrapped child trusts that CA
 * via env — never installed system-wide. Every decrypted request runs through
 * payFetch, which already does the 402 → read offers → pay → retry loop, so all
 * the payment logic is reused; the proxy only decrypts and hands off.
 *
 * Scope: loopback-only, alive only while the wrapped command runs, gated by a
 * per-run bearer token so other local processes can't spend or MITM through it,
 * CA trusted by the child alone. A per-request approve gate bounds spend the
 * same way the CLI/MCP do.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import forge from "node-forge";
import { payFetch } from "./curl.js";
import { type Offer, offerUSD } from "./offers.js";
import type { Wallet } from "./wallet.js";

type CA = {
	certPem: string;
	keyPem: string;
	cert: forge.pki.Certificate;
	key: forge.pki.PrivateKey;
};

/**
 * Mint a fresh, EPHEMERAL root CA for one `run`. The signing key lives only in
 * this process's memory and is never written to disk — so it can't be read by
 * another same-user process to MITM future runs. Only the public cert is
 * written, to a per-run temp file (the child's trust env needs a path), and
 * that file is removed on close.
 */
function makeEphemeralCA(): {
	caPath: string;
	dir: string;
	ca: CA;
	cleanup: () => void;
} {
	const keys = forge.pki.rsa.generateKeyPair(2048);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = randomBytes(8).toString("hex");
	cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
	cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000); // one day is plenty
	const attrs = [
		{ name: "commonName", value: "stellar-pay run proxy CA (ephemeral)" },
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
	const dir = mkdtempSync(join(tmpdir(), "stellar-pay-ca-"));
	const caPath = join(dir, "proxy-ca.pem");
	writeFileSync(caPath, certPem, { mode: 0o600 });
	return {
		caPath,
		dir,
		ca: { certPem, keyPem: "", cert, key: keys.privateKey },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
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
	// Not hop-by-hop, but must not reach upstream: undici decodes only
	// gzip/deflate/br. If the child advertises a coding undici can't decode
	// (zstd), the upstream body would come back still compressed while the
	// write-back below strips content-encoding — corrupting it. Let undici
	// negotiate its own codings instead.
	"accept-encoding",
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
	approve: (offer: Offer, url: string) => Promise<boolean>;
	prefer?: "x402" | "mpp";
	onPaid?: (info: {
		url: string;
		usd: number | null;
		protocol: string;
		hash: string | null;
	}) => void;
	onRefused?: (info: { url: string; reason: string }) => void;
};

/** Start the wrapping proxy. Returns its port, a per-run token, the CA path, and close(). */
export async function startProxy(o: ProxyOptions): Promise<{
	port: number;
	token: string;
	caPath: string;
	close: () => Promise<void>;
}> {
	const { caPath, dir, ca, cleanup } = makeEphemeralCA();
	const leaf = leafFactory(ca);
	// The proxy binds loopback, but loopback is shared by every process on the
	// host — without auth any of them could spend the wallet or route egress
	// through the MITM. Require this per-run secret (carried in the proxy URL,
	// so tools send it as Proxy-Authorization automatically).
	const token = randomBytes(24).toString("hex");
	const expected = `Basic ${Buffer.from(`stellar-pay:${token}`).toString("base64")}`;
	const authed = (req: http.IncomingMessage): boolean =>
		req.headers["proxy-authorization"] === expected;

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
			else if (r.res.status === 402 && !r.paid)
				// A 402 came back unpaid and wasn't declined: no offer this wallet
				// can pay (e.g. a mainnet endpoint, a testnet wallet). Say so,
				// rather than silently handing the tool a bare 402.
				o.onRefused?.({
					url,
					reason: r.offers.length
						? `402 not payable from a ${o.wallet.network} wallet; it accepts: ${r.offers.map((x) => x.network).join(", ")}`
						: "402 with no readable payment offer",
				});
			const buf = Buffer.from(await r.res.arrayBuffer());
			const out: Record<string, string | string[]> = {};
			r.res.headers.forEach((v, k) => {
				const lk = k.toLowerCase();
				// undici already decompressed the body, so the upstream
				// content-encoding/-length now describe bytes that no longer
				// exist — forwarding them makes the child try to gunzip
				// plaintext or truncate on a wrong length. Drop both; Node
				// sets the real length from what we write.
				if (HOP.has(lk) || lk === "content-encoding" || lk === "content-length")
					return;
				out[k] = v;
			});
			// Headers.forEach folds multiple Set-Cookie into one comma-joined
			// value; re-split them into distinct header lines.
			const cookies = r.res.headers.getSetCookie?.() ?? [];
			if (cookies.length) out["set-cookie"] = cookies;
			res.writeHead(r.res.status, out);
			res.end(buf);
		} catch (e) {
			res.writeHead(502, { "content-type": "text/plain" });
			res.end(`stellar-pay proxy error: ${(e as Error).message}`);
		}
	};

	// TLS terminator for intercepted HTTPS (leaf cert chosen by SNI). It
	// listens on a unix socket inside the run's 0700 temp dir — NOT a loopback
	// TCP port — so no other local process can reach it and spend through the
	// wallet by skipping the token-checked CONNECT handler below.
	const tlsServer = https.createServer(
		{ SNICallback: (name, cb) => cb(null, leaf(name)) },
		(req, res) => handle(req, res, "https"),
	);
	const tlsSock = join(dir, "tls.sock");
	await new Promise<void>((resolve) => tlsServer.listen(tlsSock, resolve));

	// The proxy the child points at: plain-HTTP requests handled directly;
	// CONNECT tunnels are redirected into our own TLS terminator above. Both
	// are gated by the per-run token (the tunnelled HTTPS requests are already
	// behind an authenticated CONNECT, so they aren't re-checked).
	const proxy = http.createServer((req, res) => {
		if (!authed(req)) {
			res.writeHead(407, {
				"proxy-authenticate": 'Basic realm="stellar-pay"',
			});
			res.end("stellar-pay proxy: authentication required");
			return;
		}
		handle(req, res, "http");
	});
	proxy.on("connect", (req, clientSocket, head) => {
		if (!authed(req)) {
			clientSocket.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="stellar-pay"\r\n\r\n',
			);
			return;
		}
		const upstream = netConnect(tlsSock, () => {
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
		token,
		caPath,
		close: () =>
			new Promise<void>((resolve) => {
				tlsServer.close(() =>
					proxy.close(() => {
						cleanup();
						resolve();
					}),
				);
			}),
	};
}

/** Env that makes a child route through the proxy and trust its CA (Node, curl, python, etc.). */
export function proxyEnv(
	port: number,
	caPath: string,
	token: string,
): Record<string, string> {
	// Credentials in the proxy URL → tools send Proxy-Authorization automatically.
	const url = `http://stellar-pay:${token}@127.0.0.1:${port}`;
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
