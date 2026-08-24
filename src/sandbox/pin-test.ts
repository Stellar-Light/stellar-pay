/**
 * The bait-and-switch pin — the only thing between "you approved $0.01" and
 * "the server got $500 signed". The audit found it had NO tests: both inline
 * copies could be deleted and the whole suite stayed green. It is now one
 * exported rule, and these checks fail if any clause is weakened or removed.
 */
import { pinMismatch } from "../pay/curl.js";
import type { Offer } from "../pay/offers.js";

const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYEE = "GBBD47IFQTLAKDVWDCKFZFHNJ5FLBQGLM5S4KMFGZ2XSWEZ2GLQFLA5";

const approved: Offer = {
	protocol: "mpp",
	network: "stellar:testnet",
	asset: SAC,
	amount: "100000", // 0.01 USDC in 7-decimal base units
	payTo: PAYEE,
	feesSponsored: true,
	expires: null,
	description: null,
};
/** what the paying library reports it is about to sign, told honestly */
const honest = {
	amount: "0.0100000",
	currency: SAC,
	recipient: PAYEE,
	network: "stellar:testnet",
};

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

check("honest challenge passes", pinMismatch(approved, honest) === null);

check(
	"AMOUNT raised after approval is caught",
	/different amount/.test(
		pinMismatch(approved, { ...honest, amount: "5.0000000" }) ?? "",
	),
);
check(
	"amount lowered is also caught (any change, not just increases)",
	pinMismatch(approved, { ...honest, amount: "0.0000001" }) !== null,
);
check(
	"NETWORK switched testnet→mainnet is caught",
	/switched network/.test(
		pinMismatch(approved, { ...honest, network: "stellar:pubnet" }) ?? "",
	),
);
check(
	"ASSET swapped is caught",
	/different asset/.test(
		pinMismatch(approved, { ...honest, currency: `C${"Z".repeat(55)}` }) ?? "",
	),
);
check(
	"RECIPIENT swapped is caught",
	/different recipient/.test(
		pinMismatch(approved, { ...honest, recipient: `G${"Z".repeat(55)}` }) ?? "",
	),
);
check(
	"a field the live challenge omits cannot be used to slip past",
	pinMismatch(approved, { network: "stellar:pubnet" }) !== null,
);
check(
	"an offer pinned to the generic 'stellar' still accepts either network",
	pinMismatch(
		{ ...approved, network: "stellar" },
		{ ...honest, network: "stellar:pubnet" },
	) === null,
);

console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} bait-and-switch pin checks`,
);
process.exit(fail === 0 ? 0 : 1);
