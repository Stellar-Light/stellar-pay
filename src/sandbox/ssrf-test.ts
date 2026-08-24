import { blockedTarget } from "../mcp.js";

const cases: [string, boolean][] = [
	["https://api.exa.ai/search", false], // public → allowed
	["http://169.254.169.254/latest/meta-data", true], // cloud metadata → blocked
	["http://localhost:8080/x", true],
	["http://127.0.0.1:3000", true],
	["http://10.1.2.3/internal", true],
	["http://192.168.1.1", true],
	["http://[::1]:9000", true],
	["file:///etc/passwd", true],
	["https://apiserver.mpprouter.dev/v1/services/exa/search", false],
	// IPv4-mapped IPv6 — URL canonicalizes to the hex form; both must block
	["http://[::ffff:127.0.0.1]/", true],
	["http://[::ffff:169.254.169.254]/latest/meta-data", true],
	["http://[::ffff:7f00:1]/", true],
	["http://[::]/x", true],
	// DNS rebinding: a public NAME resolving to loopback must block
	["http://localtest.me/", true], // wildcard DNS → 127.0.0.1
];
let ok = 0,
	bad = 0;
for (const [u, shouldBlock] of cases) {
	const blocked = (await blockedTarget(u)) !== null;
	const pass = blocked === shouldBlock;
	console.log(`  ${pass ? "✓" : "✗"} ${shouldBlock ? "BLOCK" : "allow"}  ${u}`);
	pass ? ok++ : bad++;
}
console.log(`\n${bad === 0 ? "ALL PASS" : `${bad} WRONG`} — ${ok}/${ok + bad}`);
process.exit(bad === 0 ? 0 : 1);
