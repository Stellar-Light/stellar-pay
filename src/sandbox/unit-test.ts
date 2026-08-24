/**
 * Offline unit checks for the pure money-path functions — no network, no
 * wallet. These are the functions a wrong answer from which moves money:
 * the 402 parser (readOffers), the USD valuation (offerUSD), and the one
 * shared spend decision (autoApprove).
 */

import { offerUSD, readOffers } from "../pay/offers.js";
import { autoApprove } from "../pay/policy.js";

const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const b64url = (s: string) =>
	Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

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

// --- readOffers: x402 v2 (amount) ---
const v2 = readOffers(
	new Headers(),
	JSON.stringify({
		accepts: [
			{
				network: "stellar:pubnet",
				asset: PUBNET_USDC,
				amount: "100000",
				payTo: "GABC",
			},
		],
	}),
);
check("x402 v2: amount read", v2[0]?.amount === "100000", JSON.stringify(v2));
check(
	"x402 v2: network/asset/payTo",
	v2[0]?.network === "stellar:pubnet" &&
		v2[0]?.asset === PUBNET_USDC &&
		v2[0]?.payTo === "GABC",
);

// --- readOffers: x402 v1 (maxAmountRequired) ---
const v1 = readOffers(
	new Headers(),
	JSON.stringify({
		accepts: [{ network: "stellar:pubnet", maxAmountRequired: "250000" }],
	}),
);
check("x402 v1: maxAmountRequired fallback", v1[0]?.amount === "250000");

// --- readOffers: body + header carrying the SAME accept de-dupes to one ---
const dup = readOffers(
	new Headers({
		"payment-required": Buffer.from(
			JSON.stringify({
				accepts: [
					{ network: "stellar:pubnet", asset: PUBNET_USDC, amount: "5" },
				],
			}),
		).toString("base64"),
	}),
	JSON.stringify({
		accepts: [{ network: "stellar:pubnet", asset: PUBNET_USDC, amount: "5" }],
	}),
);
check(
	"dedupe: body+header same accept → 1 offer",
	dup.length === 1,
	`${dup.length}`,
);

// --- readOffers: malformed base64 header must not throw or produce an offer ---
const junk = readOffers(
	new Headers({ "payment-required": "%%%not-base64%%%" }),
	"not json either",
);
check(
	"malformed header+body: no crash, no offers",
	junk.length === 0,
	`${junk.length}`,
);

// --- readOffers: MPP challenge with base64url request ---
const mpp = readOffers(
	new Headers({
		"www-authenticate": `Payment id="1", method="stellar", request="${b64url(
			JSON.stringify({
				amount: "100000",
				currency: PUBNET_USDC,
				recipient: "GDEF",
				methodDetails: { network: "stellar:pubnet", feePayer: true },
			}),
		)}"`,
	}),
	"",
);
check(
	"mpp: challenge parsed (amount/currency/recipient/network/sponsored)",
	mpp[0]?.protocol === "mpp" &&
		mpp[0]?.amount === "100000" &&
		mpp[0]?.asset === PUBNET_USDC &&
		mpp[0]?.payTo === "GDEF" &&
		mpp[0]?.network === "stellar:pubnet" &&
		mpp[0]?.feesSponsored === true,
	JSON.stringify(mpp),
);

// --- offerUSD: 7-decimal USDC, network-paired ---
const usdcOffer = mpp[0];
if (!usdcOffer) throw new Error("mpp fixture missing");
check("offerUSD: 100000 base units → $0.01", offerUSD(usdcOffer) === 0.01);
check(
	"offerUSD: non-USDC asset → null",
	offerUSD({ ...usdcOffer, asset: "CXXXNOTUSDC" }) === null,
);
check(
	"offerUSD: pubnet SAC claimed on testnet → null (network-paired)",
	offerUSD({ ...usdcOffer, network: "stellar:testnet" }) === null,
);

// --- autoApprove: the one spend decision ---
const okUsdc = { ...usdcOffer }; // $0.01 USDC pubnet
check(
	"autoApprove: testnet approves anything",
	autoApprove(
		{ ...okUsdc, asset: "CXXXNOTUSDC" },
		{ network: "stellar:testnet", maxUsd: 0.05 },
	).ok,
);
check(
	"autoApprove: mainnet within ceiling → ok",
	autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: 0.05 }).ok,
);
check(
	"autoApprove: mainnet over ceiling → refused",
	!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: 0.005 }).ok,
);
check(
	"autoApprove: mainnet non-USDC → refused",
	!autoApprove(
		{ ...okUsdc, asset: "CXXXNOTUSDC" },
		{ network: "stellar:pubnet", maxUsd: 1 },
	).ok,
);
check(
	"autoApprove: NaN ceiling FAILS CLOSED",
	!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: Number.NaN }).ok,
);
check(
	"autoApprove: zero/negative ceiling FAILS CLOSED",
	!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: 0 }).ok &&
		!autoApprove(okUsdc, { network: "stellar:pubnet", maxUsd: -1 }).ok,
);

console.log(
	`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} — ${pass}/${pass + fail} unit checks on the money-path functions`,
);
process.exit(fail === 0 ? 0 : 1);
