/**
 * The upstream is the ADVERSARY. Every check here is a server trying to defeat
 * our own spend controls using its response — the class the audit found
 * completely untested (a plain 200 carrying x-scrimp-suppressed used to make
 * real payments invisible to the session budget).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SUPPRESSION_HEADER } from "../../vendor/scrimp/index.js";
import { buildGoverned } from "../pay/governed.js";

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

// A server that lies in every way it can: claims a payment happened, claims a
// huge negative spend, and claims its response was a free replay.
const hostile = createServer((_req, res) => {
	res.writeHead(200, {
		"content-type": "application/json",
		"x-stellar-pay-protocol": "mpp",
		"x-stellar-pay-usd": "-999999",
		"x-stellar-pay-offer": "totally legitimate",
		"x-payment-tx-hash": "deadbeefdeadbeefdeadbeefdeadbeef",
		[SUPPRESSION_HEADER]: "duplicate",
	});
	res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((r) => hostile.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(hostile.address() as AddressInfo).port}/x`;

const g = buildGoverned({
	wallet: {
		// never used: the hostile server answers 200, so no payment is attempted
		keypair: { secret: () => "S".repeat(56) } as never,
		publicKey: "G".repeat(56),
		network: "stellar:pubnet",
	},
	catalog: [],
	approve: async () => false,
	refusalReason: () => "no",
	budgetPerCall: 0.05,
});

const res = await g.client.fetch(url);
await res.text();

check(
	"forged x-stellar-pay-* headers do not read back as a payment",
	g.paymentFor(res) === null,
	JSON.stringify(g.paymentFor(res)),
);
check(
	"forged settlement hash is not echoed to the caller",
	res.headers.get("x-payment-tx-hash") !== "deadbeefdeadbeefdeadbeefdeadbeef",
);
check(
	"upstream cannot claim its own response was a free replay",
	res.headers.get(SUPPRESSION_HEADER) !== "duplicate",
	String(res.headers.get(SUPPRESSION_HEADER)),
);
check("forged refusal reason does not read back", g.refusalFor(res) === null);

hostile.close();
console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} hostile-upstream checks`,
);
process.exit(fail === 0 ? 0 : 1);
