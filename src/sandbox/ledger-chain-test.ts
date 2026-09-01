/**
 * The ledger detects DELETION, not just editing — audit finding 3.
 *
 * `receipts check` used to re-derive each row's id from its own content and
 * stop there, so deleting a whole line (say, every refusal) left a file that
 * passed cleanly. Each row now links to the row before it, and an unreadable
 * line is reported rather than silently skipped on read — the earlier
 * behaviour meant corrupting one byte of a refusal erased it from the listing
 * AND from the check.
 *
 * What this deliberately does NOT claim: that a determined forger with write
 * access is stopped. They can rewrite the file whole and recompute every id
 * and link. The chain catches corruption and partial edits; `verifyOnChain`
 * is the real anchor for a payment.
 */
// NEGATIVE CONTROL: 4 checks fail against the pre-fix ledger (2026-09-01) — a test that cannot fail is not evidence.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STELLAR_PAY_SESSION_DIR = mkdtempSync(join(tmpdir(), "sp-ledger-"));

const { record, checkLedger, list } = await import("../pay/receipts.js");
const { sessionPaths } = await import("../pay/session-store.js");

let ok = 0;
let bad = 0;
const check = (pass: boolean, label: string) => {
	console.log(`  ${pass ? "✓" : "✗"} ${label}`);
	pass ? ok++ : bad++;
};

const ids = [
	record({
		kind: "policy-decision",
		url: "https://a.example",
		detail: { allowed: true },
	}),
	record({
		kind: "policy-decision",
		url: "https://b.example",
		detail: { allowed: false, rule: "denied" },
	}),
	record({
		kind: "payment",
		url: "https://c.example",
		amount: "1",
		asset: "USDC",
	}),
];
check(new Set(ids).size === 3, "three rows written with distinct ids");

const clean = checkLedger();
check(
	clean.ok && clean.rows === 3,
	`intact ledger passes (${clean.rows} rows)`,
);

const rows = list({ limit: 100 });
check(rows[0]?.prev === undefined, "the first row has no prev (genesis)");
check(rows[1]?.prev === ids[0], "row 2 links to row 1");
check(rows[2]?.prev === ids[1], "row 3 links to row 2");

const file = sessionPaths.receipts;
const original = readFileSync(file, "utf8");
const lines = original.split("\n").filter(Boolean);

// THE ATTACK: delete the refusal. Content hashes of the survivors are all
// still valid — only the link betrays it.
writeFileSync(file, `${[lines[0], lines[2]].join("\n")}\n`);
const deleted = checkLedger();
// Tolerate a ledger that has no chain at all (the pre-fix shape) so this
// reports a verdict instead of crashing — a test that dies is not evidence.
const delUnlinked = deleted.unlinked ?? [];
check(
	!deleted.ok && delUnlinked.length === 1,
	`deleting the refusal row is caught (${delUnlinked.length} unlinked, ${deleted.bad.length} edited)`,
);
check(
	deleted.bad.length === 0,
	"and it is caught by the LINK, not the content hash — which is why this needed fixing",
);

// Corrupting a line must be reported, not silently dropped on read.
writeFileSync(file, `${[lines[0], "{not json", lines[2]].join("\n")}\n`);
const corrupt = checkLedger();
const corrUnreadable = corrupt.unreadable ?? [];
check(
	!corrupt.ok && corrUnreadable.length === 1,
	`an unreadable line is reported, not skipped (${corrUnreadable.length})`,
);

// Restore and confirm the check is not simply always-red.
writeFileSync(file, original);
check(checkLedger().ok, "restored ledger passes again (the check can pass)");

console.log(
	`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`} — ${ok}/${ok + bad}`,
);
process.exit(bad === 0 ? 0 : 1);
