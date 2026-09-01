/**
 * The published vectors are what we actually produce.
 *
 * A spec whose fixtures are hand-written drifts the first time the code
 * changes, and then it is worse than no spec: a second implementer matches
 * bytes we no longer emit and blames themselves. This regenerates from the
 * implementation and compares to the committed files, so `specs/vectors/`
 * cannot silently rot. If it fails, either the change was unintended or the
 * wire format moved — and a wire format moving is a version bump, not a
 * regeneration.
 */
import { readFileSync } from "node:fs";
import { vectors } from "./gen-vectors.js";

let ok = 0;
let bad = 0;
const check = (pass: boolean, label: string) => {
	console.log(`  ${pass ? "✓" : "✗"} ${label}`);
	pass ? ok++ : bad++;
};

for (const [name, produced] of Object.entries(vectors())) {
	let committed = "";
	try {
		committed = readFileSync(
			new URL(`../../specs/vectors/${name}.json`, import.meta.url),
			"utf8",
		);
	} catch {
		check(false, `${name}.json is missing — run \`npm run vectors\``);
		continue;
	}
	const now = `${JSON.stringify(produced, null, 2)}\n`;
	check(
		committed === now,
		committed === now
			? `${name}.json matches the implementation`
			: `${name}.json DIFFERS from the implementation — run \`npm run vectors\` and review the diff (a wire-format change is a version bump)`,
	);
}

// The vectors are only credible if the hashes in them are reproducible from
// their own stated preimage, not just equal to whatever we emitted.
const commit = JSON.parse(
	readFileSync(
		new URL("../../specs/vectors/commit-v2.json", import.meta.url),
		"utf8",
	),
);
const { createHash } = await import("node:crypto");
const evHash = createHash("sha256")
	.update(JSON.stringify(commit.evidence))
	.digest("hex");
const recomputed = createHash("sha256")
	.update(
		`stellar-pay/commit-v2|${commit.contractId}|${commit.worker}|${evHash}|${commit.nonce}|${commit.committedAt}`,
	)
	.digest("hex");
check(
	recomputed === commit.commit.commitHash,
	"commit-v2: the documented preimage recomputes the published commitHash (a stranger can verify it with sha256 alone)",
);

console.log(
	`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`} — ${ok}/${ok + bad}`,
);
process.exit(bad === 0 ? 0 : 1);
