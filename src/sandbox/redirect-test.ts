/**
 * A 302 must not walk a payment past the gates. Every guard (SSRF, per-host
 * policy) used to be evaluated on the URL the caller asked for, while fetch
 * silently followed the redirect and took the 402 — and its payTo — from
 * wherever it landed.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { payFetch } from "../pay/curl.js";

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

const hits = { internal: 0 };
// The "internal" host a redirect tries to smuggle us into.
const internal = createServer((_q, r) => {
	hits.internal++;
	r.writeHead(200, { "content-type": "application/json" });
	r.end('{"secret":"internal data"}');
});
await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
const internalUrl = `http://127.0.0.1:${(internal.address() as AddressInfo).port}/private`;

// A public-looking host that bounces you there.
const bouncer = createServer((_q, r) => {
	r.writeHead(302, { location: internalUrl });
	r.end();
});
await new Promise<void>((r) => bouncer.listen(0, "127.0.0.1", () => r()));
const bounceUrl = `http://127.0.0.1:${(bouncer.address() as AddressInfo).port}/go`;

const wallet = {
	keypair: { secret: () => "S".repeat(56) } as never,
	publicKey: "G".repeat(56),
	network: "stellar:testnet" as const,
};

// Guard that denies the internal host, exactly like a deny rule or the SSRF check.
const seen: string[] = [];
const r = await payFetch(
	bounceUrl,
	{},
	{
		wallet,
		approve: async () => false,
		guard: (u) => {
			seen.push(u);
			return u.includes("/private") ? "denied by guard" : null;
		},
	},
);

check(
	"the guard was consulted on the redirect target",
	seen.some((u) => u.includes("/private")),
	JSON.stringify(seen),
);
check(
	"the blocked hop is reported",
	r.blocked === "denied by guard",
	String(r.blocked),
);
check("the guarded host was NEVER reached", hits.internal === 0);

// Control: an allowed redirect still works, so we didn't just break redirects.
hits.internal = 0;
const ok = await payFetch(
	bounceUrl,
	{},
	{ wallet, approve: async () => false, guard: () => null },
);
check(
	"an ALLOWED redirect is still followed",
	hits.internal === 1 && ok.res.status === 200,
	String(ok.res.status),
);

// Close DETERMINISTICALLY before exiting. `server.close()` only stops new
// connections — it stays pending while keep-alive sockets drain, and calling
// process.exit() in that window tore down handles mid-close: on Windows CI
// every run of this file passed 4/4 and then died with
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) … src\win\async.c`,
// which reads like a test failure and is really an unclean exit.
for (const s of [internal, bouncer]) {
	s.closeAllConnections?.(); // drop keep-alive sockets so close() can finish
	await new Promise<void>((r) => s.close(() => r()));
}
console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} redirect-gate checks`,
);

// Do NOT call process.exit() here. This file makes real HTTP requests, so
// undici holds keep-alive sockets open, and forcing an exit while libuv is
// still closing those handles aborted the process on Windows CI —
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) … src\win\async.c`
// AFTER printing ALL PASS. A clean run was reported as a failed job.
//
// Set the code and let the loop drain on its own. The unref'd timer is the
// safety net: an unref'd timer cannot keep the process alive, so it only ever
// fires if something ELSE is still holding the loop open — in which case a
// forced exit is the right answer, and by then the handles have had time to
// finish closing.
process.exitCode = fail === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
