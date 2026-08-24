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
];
let ok = 0,
	bad = 0;
for (const [u, shouldBlock] of cases) {
	const blocked = blockedTarget(u) !== null;
	const pass = blocked === shouldBlock;
	console.log(`  ${pass ? "✓" : "✗"} ${shouldBlock ? "BLOCK" : "allow"}  ${u}`);
	pass ? ok++ : bad++;
}
console.log(`\n${bad === 0 ? "ALL PASS" : bad + " WRONG"} — ${ok}/${ok + bad}`);
process.exit(bad === 0 ? 0 : 1);
