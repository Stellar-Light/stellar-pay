import {
	MemoryStore,
	ScrimpClient,
	SUPPRESSION_HEADER,
} from "../../vendor/scrimp/index.js";

let clock = 1_000_000;
const now = () => clock;
let failNext = 0; // make the payer throw the next N times
let calls = 0;
const payer = async (url: string) => {
	calls++;
	if (failNext > 0) {
		failNext--;
		throw new Error("upstream 500");
	}
	return new Response(JSON.stringify({ url, at: clock }), {
		headers: {
			"content-type": "application/json",
			"x-payment-tx-hash": "hash" + calls,
		},
	});
};
const c = new ScrimpClient({
	payer,
	store: new MemoryStore(),
	priceOf: () => 0.01,
	now,
});
const S = (r: Response) => r.headers.get(SUPPRESSION_HEADER);
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

// 1. DUPLICATE — same request twice in a task → 2nd replayed free
c.beginTask("t1", { budget: 1 });
const a1 = await c.fetch("https://api.x.com/quote/AAPL");
await a1.json();
const callsBefore = calls;
const a2 = await c.fetch("https://api.x.com/quote/AAPL");
check(
	"duplicate: 2nd identical call suppressed",
	S(a2) === "duplicate",
	`got ${S(a2)}`,
);
check(
	"duplicate: payer NOT called again",
	calls === callsBefore,
	`calls went ${callsBefore}→${calls}`,
);
c.endTask("t1", { succeeded: true });

// 2. FRESH — same request in a LATER task, within 60s TTL → replayed
c.beginTask("t2", { budget: 1 });
clock += 10_000; // 10s later, < 60s TTL
const b1 = await c.fetch("https://api.x.com/quote/AAPL");
check(
	"fresh: repeat across tasks within TTL suppressed",
	S(b1) === "fresh",
	`got ${S(b1)}`,
);
// past TTL → NOT fresh, pays again
clock += 60_001;
const b2 = await c.fetch("https://api.x.com/quote/AAPL");
check(
	"fresh: past TTL pays again (not suppressed)",
	S(b2) === null,
	`got ${S(b2)}`,
);
c.endTask("t2", { succeeded: true });

// 3. QUARANTINED — a provider that fails 3× → next call refused
c.beginTask("t3", { budget: 1 });
failNext = 3;
// quarantine keys on the EXACT request, so the same url must fail 3× to trip it
for (let i = 0; i < 3; i++) {
	try {
		await c.fetch("https://dead.com/same");
	} catch {}
}
const q = await c.fetch("https://dead.com/same");
check(
	"quarantined: same request failing 3× is then refused",
	S(q) === "quarantined",
	`got ${S(q)}`,
);
c.endTask("t3", { succeeded: false });

// 4. BUDGET — exceed the task budget → refused
c.beginTask("t4", { budget: 0.015 }); // priceOf=0.01, so 2nd call would hit 0.02 > 0.015
const d1 = await c.fetch("https://api.x.com/a");
const d2 = await c.fetch("https://api.x.com/b");
check(
	"budget: call that would exceed the task budget refused",
	S(d2) === "budget",
	`got ${S(d2)}`,
);
check(
	"budget: first call under budget went through",
	S(d1) === null,
	`got ${S(d1)}`,
);
c.endTask("t4", { succeeded: true });

// 5. CONSUMPTION + ATTRIBUTION — read body → consumed; task fails → wasted
c.beginTask("t5", { budget: 1 });
const e1 = await c.fetch("https://api.x.com/used");
await e1.json(); // consumed
await c.fetch("https://api.x.com/unused"); // never read → wasted
c.endTask("t5", { succeeded: true });
const rep = c.report();
console.log(
	`\n  report: spent=$${rep.spent} wouldHaveSpent=$${rep.wouldHaveSpent} saved=$${rep.saved} savedPct=${rep.savedPct}% wasteRate=${rep.wasteRate} suppressed=${rep.suppressed}`,
);
check(
	"report: saved > 0 (suppressions avoided real spend)",
	rep.saved > 0,
	JSON.stringify(rep),
);
check(
	"report: wasteRate tracked (0..1)",
	typeof rep.wasteRate === "number" && rep.wasteRate >= 0,
	`${rep.wasteRate}`,
);

// 6. IDENTITY — the dedupe key must not confuse DIFFERENT requests. A key
// regression would silently serve the answer you paid for on url A when you
// asked for url B: not just a lost payment, the WRONG DATA. The audit found
// no negative case for this at all.
c.beginTask("t6", { budget: 1 });
const r1 = await c.fetch("https://api.x.com/quote/AAPL");
const a1body = (await r1.json()) as { url: string };
const r2 = await c.fetch("https://api.x.com/quote/TSLA"); // different resource
const b1body = (await r2.json()) as { url: string };
check(
	"a DIFFERENT url is not served from the first one's purchase",
	S(r2) === null && b1body.url.endsWith("TSLA"),
	`suppression=${S(r2)} body=${JSON.stringify(b1body)}`,
);
check(
	"the first response still carried its own url",
	a1body.url.endsWith("AAPL"),
	JSON.stringify(a1body),
);
// method must be part of identity too — a POST is not the GET you paid for
const g = await c.fetch("https://api.x.com/thing");
await g.json();
const p2 = await c.fetch("https://api.x.com/thing", { method: "POST" });
check(
	"a POST is not served from a GET's purchase",
	S(p2) === null,
	`suppression=${S(p2)}`,
);
c.endTask("t6", { succeeded: true });

console.log(
	`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"} — ${pass}/${pass + fail} scrimp behaviors verified`,
);
process.exit(fail === 0 ? 0 : 1);
