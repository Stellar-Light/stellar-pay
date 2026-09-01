/**
 * Every paying door runs the SAME gate — the 2026-09-01 audit's finding 6.
 *
 * The MCP door composed SSRF ∪ spend-policy inline; CLI `curl` and `run` ran
 * only the policy half, which has no concept of an IP literal, so a 302 to
 * 169.254.169.254 walked through the two doors humans use most. The fix is
 * one named `payGuard`, so this asserts the GATE, and that every door that
 * follows redirects is wired to it (a door running half the union is the bug
 * class, and it is invisible to a test that only checks the halves).
 */
import { readFileSync } from "node:fs";
import { payGuard } from "../pay/ssrf.js";

const POLICY = { hosts: { "denied.example": { deny: true } } } as const;

// [url, mustRefuse, why]
const cases: [string, boolean, string][] = [
	["https://api.exa.ai/search", false, "public host, no rule → allowed"],
	// SSRF half — these are exactly what the CLI doors let through before.
	["http://169.254.169.254/latest/meta-data", true, "cloud metadata"],
	["http://127.0.0.1:3000/admin", true, "loopback"],
	["http://10.1.2.3/internal", true, "private range"],
	["http://[::ffff:127.0.0.1]/", true, "IPv4-mapped loopback"],
	["file:///etc/passwd", true, "non-http scheme"],
	["http://localtest.me/", true, "public name resolving to loopback"],
];

let ok = 0;
let bad = 0;
const check = (pass: boolean, label: string) => {
	console.log(`  ${pass ? "✓" : "✗"} ${label}`);
	pass ? ok++ : bad++;
};

for (const [url, mustRefuse, why] of cases) {
	const refused = (await payGuard(url, { requested: 1 })) !== null;
	check(
		refused === mustRefuse,
		`${mustRefuse ? "REFUSE" : "allow "}  ${url}  (${why})`,
	);
}

// Policy half still fires through the same call.
const denied = await payGuard("https://denied.example/x", {
	requested: 1,
	// biome-ignore lint/suspicious/noExplicitAny: test-local policy injection
	...({ policy: POLICY } as any),
});
check(
	denied === null || /denied|allowlist/i.test(denied),
	"policy half reachable through payGuard (deny rule or no policy file present)",
);

// The wiring itself: any door that follows redirects must hand payFetch/startProxy
// a guard, and it must be payGuard — not a hand-rolled half of the union.
const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
const guardSites = [...cli.matchAll(/^\t*guard:/gm)].length;
const payGuardSites = [...cli.matchAll(/payGuard\(/g)].length;
check(
	guardSites > 0 && payGuardSites >= guardSites,
	`every CLI guard uses payGuard (${payGuardSites} payGuard calls for ${guardSites} guard sites)`,
);
check(
	!/guard:\s*\(u\)\s*=>\s*\n?\s*resolveHost\(/.test(cli),
	"no CLI guard runs resolveHost alone (the half-gate that shipped)",
);

// session open / --session are spend doors too: both must consult the policy.
const opensGated =
	/session open[\s\S]{0,1200}?resolveHost\(/.test(cli) ||
	/const gate = resolveHost\(url, \{ requested: 0 \}\)/.test(cli);
check(opensGated, "session open runs the host gate before deploying a channel");
check(
	/const sessGate = resolveHost\(/.test(cli),
	"curl --session re-runs the host gate per call (a deny rule written after open still bites)",
);

console.log(
	`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`} — ${ok}/${ok + bad}`,
);
process.exit(bad === 0 ? 0 : 1);
