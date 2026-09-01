/**
 * Offline checks for the per-host spend policy. This is a security control, so
 * it's exercised directly: a temp policy file is pointed at via env, then
 * resolveHost/decide are checked against it — no network, no wallet.
 *
 * The env var must be set BEFORE ./pay/policy.js is imported (policyPath is
 * read once at module load), so the import is dynamic and comes after.
 */
// NEGATIVE CONTROL: the suite fails against the pre-fix policy.ts (2026-09-01) — a test that cannot fail is not evidence.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Offer } from "../pay/offers.js";

const dir = mkdtempSync(join(tmpdir(), "sp-policy-"));
const file = join(dir, "policy.json");
process.env.STELLAR_PAY_POLICY = file;
const { resolveHost, decide, hostRuleCeiling } = await import(
	"../pay/policy.js"
);

const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const usdc = (amount: string): Offer => ({
	protocol: "x402",
	network: "stellar:pubnet",
	asset: PUBNET_USDC,
	amount, // base units (7dp): "100000" = $0.01
	payTo: "GABC",
	feesSponsored: true,
	expires: null,
	description: null,
});
const write = (p: unknown) => writeFileSync(file, JSON.stringify(p));

let pass = 0,
	fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}  ${detail}`);
	}
};

// A policy file that EXISTS but is unreadable must fail CLOSED. Silently
// treating it as "no policy" used to delete allowlist containment without a
// word — this test previously asserted that vulnerable behaviour.
writeFileSync(file, "not json");
{
	let threw = false;
	try {
		resolveHost("https://api.exa.ai/x", { requested: 0.1 });
	} catch (e) {
		threw = /not valid JSON/.test((e as Error).message);
	}
	check("malformed policy file → refuses, does not silently pass", threw);
}
// An unrecognised mode must also refuse rather than quietly degrade to denylist.
writeFileSync(file, JSON.stringify({ mode: "AllowList", hosts: {} }));
{
	let threw = false;
	try {
		resolveHost("https://api.exa.ai/x", { requested: 0.1 });
	} catch (e) {
		threw = /not "allowlist" or "denylist"/.test((e as Error).message);
	}
	check("misspelled mode → refuses, does not degrade to denylist", threw);
}
// A trailing dot is the same server to DNS; it must not escape a deny rule.
writeFileSync(
	file,
	JSON.stringify({ hosts: { "blocked.example.com": { deny: true } } }),
);
{
	const g = resolveHost("https://blocked.example.com./x", { requested: 0.1 });
	check(
		"trailing-dot hostname cannot escape a deny rule",
		g.blocked !== null,
		JSON.stringify(g),
	);
}

// denylist (default): a host ceiling LOWER than requested wins
write({
	version: 1,
	default: { maxUsdPerCall: 0.05 },
	hosts: {
		"api.exa.ai": { maxUsdPerCall: 0.01 },
		"*.mpprouter.dev": { maxUsdPerCall: 0.2 },
		"sketchy.example.net": { deny: true },
	},
});
{
	const g = resolveHost("https://api.exa.ai/search", { requested: 0.1 });
	check(
		"host ceiling lower than requested wins",
		g.maxUsd === 0.01 && !g.blocked,
	);
}
// a host ceiling HIGHER than the caller default raises it (operator's call)
{
	const g = resolveHost("https://apiserver.mpprouter.dev/x", {
		requested: 0.05,
	});
	check(
		"wildcard *.mpprouter.dev raises ceiling to 0.2",
		g.maxUsd === 0.2 && !g.blocked,
		JSON.stringify(g),
	);
}
// Audit finding 5: the SAME tightening rule must hold for the MCP door, which
// passes requestedExplicit only when the operator actually set
// STELLAR_PAY_MAX_USD_PER_CALL. Unset (our default) → a host rule may raise,
// which keeps the README's *.trusted-provider.com example working. Set → the
// operator's number is a ceiling the policy file cannot lift.
{
	const raised = resolveHost("https://apiserver.mpprouter.dev/x", {
		requested: 0.05,
	});
	const pinned = resolveHost("https://apiserver.mpprouter.dev/x", {
		requested: 0.05,
		requestedExplicit: true,
	});
	check(
		"an operator-set per-call cap cannot be raised by a host rule",
		raised.maxUsd === 0.2 && pinned.maxUsd === 0.05,
		JSON.stringify({ raised: raised.maxUsd, pinned: pinned.maxUsd }),
	);
}
// hostRuleCeiling reports only what the operator WROTE for a host — the input
// to "was this an advance decision?", which is what stops an in-the-moment
// prompt from re-litigating a limit its author meant to be final.
{
	check(
		"hostRuleCeiling names an explicit host ceiling and nothing else",
		hostRuleCeiling("https://apiserver.mpprouter.dev/x") === 0.2 &&
			hostRuleCeiling("https://nobody-wrote-a-rule.example/x") === null,
	);
}
// an EXPLICIT --max-usd can only tighten, never be raised by the policy
{
	const g = resolveHost("https://apiserver.mpprouter.dev/x", {
		requested: 0.03,
		requestedExplicit: true,
	});
	check(
		"explicit --max-usd tightens below the host ceiling",
		g.maxUsd === 0.03 && !g.blocked,
		JSON.stringify(g),
	);
}
// unknown host in denylist mode → payable under the policy default
{
	const g = resolveHost("https://new.host.com/x", { requested: 0.1 });
	check(
		"denylist: unknown host uses policy default",
		g.maxUsd === 0.05 && !g.blocked,
		JSON.stringify(g),
	);
}
// deny wins outright
{
	const g = resolveHost("https://sketchy.example.net/x", { requested: 0.1 });
	check(
		"deny:true host is blocked",
		g.blocked?.includes("denied") === true && g.maxUsd === 0,
		JSON.stringify(g),
	);
}

// allowlist mode: only listed hosts are payable
write({
	version: 1,
	mode: "allowlist",
	hosts: { "api.exa.ai": { maxUsdPerCall: 0.02 } },
});
{
	const listed = resolveHost("https://api.exa.ai/x", { requested: 0.1 });
	const other = resolveHost("https://api.other.com/x", { requested: 0.1 });
	check(
		"allowlist: listed host payable",
		listed.maxUsd === 0.02 && !listed.blocked,
		JSON.stringify(listed),
	);
	check(
		"allowlist: unlisted host blocked",
		other.blocked?.includes("allowlist") === true,
		JSON.stringify(other),
	);
}

// decide(): folds the host gate into the USDC+ceiling rule
write({
	version: 1,
	default: { maxUsdPerCall: 0.05 },
	hosts: {
		"cheap.example.com": { maxUsdPerCall: 0.005 },
		"no.example.com": { deny: true },
	},
});
{
	const ok = decide(usdc("100000"), {
		network: "stellar:pubnet",
		url: "https://any.example.org/x",
		requested: 0.1,
	});
	check("decide: $0.01 USDC under default 0.05 → ok", ok.ok, ok.reason);
	const overHost = decide(usdc("100000"), {
		network: "stellar:pubnet",
		url: "https://cheap.example.com/x",
		requested: 0.1,
	});
	check(
		"decide: $0.01 over the host's $0.005 ceiling → refused",
		!overHost.ok,
		overHost.reason,
	);
	const denied = decide(usdc("100000"), {
		network: "stellar:pubnet",
		url: "https://no.example.com/x",
		requested: 0.1,
	});
	check(
		"decide: denied host → refused before ceiling",
		!denied.ok && denied.reason.includes("denied"),
		denied.reason,
	);
	const notUsdc = decide(
		{ ...usdc("100000"), asset: "CXNOT" },
		{
			network: "stellar:pubnet",
			url: "https://any.example.org/x",
			requested: 0.1,
		},
	);
	check(
		"decide: non-USDC on an allowed host → still refused",
		!notUsdc.ok,
		notUsdc.reason,
	);
}

console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} per-host policy checks`,
);
process.exit(fail === 0 ? 0 : 1);
