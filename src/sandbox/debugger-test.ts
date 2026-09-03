/**
 * The payment debugger — proved against a ledger this test writes.
 *
 * What matters is not that a page renders, but that it renders the LEDGER
 * honestly: refusals present and marked, an absent amount never shown as
 * zero, tamper state surfaced rather than assumed, and nothing claiming a
 * row was verified when no check has run.
 *
 * Offline: no network beyond loopback, no wallet, no funded account.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STELLAR_PAY_SESSION_DIR = mkdtempSync(
	join(tmpdir(), "debugger-test-"),
);

const { record } = await import("../pay/receipts.js");
const { snapshot, startDebugger } = await import("../pay/debugger.js");

let failed = 0;
const check = (ok: boolean, what: string) => {
	console.log(`  ${ok ? "✓" : "✗"} ${what}`);
	if (!ok) failed++;
};

async function main() {
	console.log("debugger-test — the local payment debugger\n");

	const decision = record({
		kind: "policy-decision",
		network: "stellar:testnet",
		url: "https://api.example.com/ok",
		amount: "2000000",
		asset: "USDC",
		payee: "GDEST",
		detail: { allowed: true, rule: "per-host cap" },
	});
	record({
		kind: "payment",
		network: "stellar:testnet",
		protocol: "x402",
		url: "https://api.example.com/ok",
		amount: "2000000",
		asset: "USDC",
		payee: "GDEST",
		tx: "abc123",
		refs: [decision],
	});
	// A refusal: the question a debugger exists to answer is "why did nothing
	// happen", so this must be present and marked, not filtered away.
	record({
		kind: "policy-decision",
		network: "stellar:testnet",
		url: "https://evil.example/x",
		detail: { allowed: false, rule: "host not on the allowlist" },
	});

	const snap = snapshot();
	const paid = snap.entries.find((e) => e.tx === "abc123");
	const refused = snap.entries.find((e) => e.allowed === false);

	check(snap.entries.length === 3, "every ledger row reaches the view");
	const newest = snap.entries.at(0)?.at ?? "";
	const oldest = snap.entries.at(-1)?.at ?? "";
	check(
		newest >= oldest && newest !== "",
		"newest first — the order you read a debugger in",
	);
	check(
		paid?.rule === "per-host cap",
		"a payment shows the rule it was allowed under, followed from refs",
	);
	check(!!refused, "a refusal appears, it is not filtered out");
	check(
		refused?.rule === "host not on the allowlist",
		"the refusal names the rule that fired",
	);
	check(
		refused?.amount === null,
		"a row with no amount reports null, so the view can show an em dash rather than 0",
	);
	check(
		paid?.checkable === true,
		"a row carrying tx+amount+payee+network is marked checkable",
	);
	check(
		refused?.checkable === false,
		"a refusal is NOT marked checkable — nothing settled to check",
	);
	check(snap.ledger.ok === true, "an untampered ledger reports ok");
	check(snap.ledger.rows === 3, "the integrity check counts every row");

	// The served surface.
	const { server, url } = await startDebugger(0);
	const api = await fetch(new URL("/api/receipts", url));
	const body = (await api.json()) as typeof snap;
	check(api.status === 200, "the API serves");
	check(body.entries.length === 3, "the API serves the same rows");
	const page = await fetch(url);
	const html = await page.text();
	check(
		page.status === 200 && html.includes("stellar-pay debugger"),
		"the page serves",
	);
	check(
		!html.includes("verified"),
		"the page never uses the word 'verified' — it shows what a row carries, it does not prove it",
	);
	const bound = new URL(url).hostname;
	check(bound === "127.0.0.1", "it binds to loopback, not to every interface");

	server.closeAllConnections?.();
	await new Promise<void>((r) => server.close(() => r()));

	console.log(
		failed === 0
			? "\ndebugger-test PASSED"
			: `\ndebugger-test FAILED: ${failed}`,
	);
	process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (e) => {
	console.error(`\ndebugger-test FAILED: ${(e as Error).message}`);
	process.exitCode = 1;
});
