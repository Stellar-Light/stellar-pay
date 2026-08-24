/**
 * The public Stellar sandbox seller — a real HTTP 402 on testnet that anyone
 * can pay with no real money.
 *
 * Why this exists: a buyer client is untryable without something to buy. Our
 * catalog indexes stellar:pubnet (real supply), so `--sandbox` used to hand
 * you a funded testnet wallet and an empty shelf. This is the shelf.
 *
 * Currency is NATIVE XLM via its Stellar Asset Contract, deliberately: friendbot
 * funds XLM, so a brand-new testnet wallet can pay immediately — no trustline,
 * no faucet, no token hunt. Fees are sponsored by the seller, so the buyer needs
 * nothing but the XLM friendbot already gave them.
 *
 *   SELLER_SECRET_KEY  S… of the account that receives payments and sponsors
 *                      fees (friendbot-funded testnet account).
 *   PRICE_XLM          per-call price, default 0.001.
 */
import * as stellarServer from "@stellar/mpp/charge/server";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import express from "express";
import { Mppx } from "mppx/express";
import { Store } from "mppx/server";

const NETWORK = "stellar:testnet";
// Native XLM's SAC — the one asset every friendbot-funded account already holds.
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const PRICE = process.env.PRICE_XLM ?? "0.001";

const secret = process.env.SELLER_SECRET_KEY;
if (!secret) {
	console.error(
		"SELLER_SECRET_KEY is required (a friendbot-funded testnet S… key)",
	);
	process.exit(1);
}
const seller = Keypair.fromSecret(secret);

const mppx = Mppx.create({
	secretKey: process.env.CREDENTIAL_SECRET ?? "stellar-pay-sandbox",
	methods: [
		stellarServer.stellar.charge({
			recipient: seller.publicKey(),
			currency: XLM_SAC,
			network: NETWORK,
			store: Store.memory(),
			// The seller pays the network fee, so a buyer needs only the payment
			// asset — the same shape mainnet sellers use.
			feePayer: { envelopeSigner: seller },
		}),
	],
});

const app = express();

/** Free: what this is and how to pay it. */
app.get("/", (_req, res) => {
	res.json({
		service: "stellar-pay sandbox",
		what: "a real HTTP 402 on Stellar testnet — pay it with play money",
		network: NETWORK,
		currency: { asset: "native XLM", sac: XLM_SAC },
		price_xlm: PRICE,
		fees: "sponsored by the seller — you need no XLM beyond the payment",
		recipient: seller.publicKey(),
		paid_endpoints: ["/data", "/quote"],
		try_it: [
			"npx stellar-pay setup --sandbox            # funded testnet wallet, one command",
			"npx stellar-pay offers <this-url>/data     # read the 402, pay nothing",
			"npx stellar-pay curl <this-url>/data --yes # pay it for real, on-chain",
		],
		explorer: `https://stellar.expert/explorer/testnet/account/${seller.publicKey()}`,
	});
});

/** Paid: the canonical demo endpoint. */
app.get(
	"/data",
	mppx.charge({ amount: PRICE, description: "stellar-pay sandbox paid call" }),
	(_req, res) => {
		res.json({
			ok: true,
			paid: true,
			message: "you just paid for this on Stellar testnet",
			at: new Date().toISOString(),
		});
	},
);

/** Paid: something with a shape worth parsing, so agents have a real payload. */
app.get(
	"/quote",
	mppx.charge({ amount: PRICE, description: "sandbox price quote" }),
	(_req, res) => {
		res.json({
			ok: true,
			paid: true,
			quote: { symbol: "XLM", price_usd: 0.11, source: "sandbox (not real)" },
			at: new Date().toISOString(),
		});
	},
);

/** Liveness, free. */
app.get("/health", (_req, res) => res.json({ ok: true, network: NETWORK }));

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
	console.log(`stellar-pay sandbox on :${port}`);
	console.log(`  seller    ${seller.publicKey()}`);
	console.log(`  currency  native XLM (${XLM_SAC})`);
	console.log(`  price     ${PRICE} XLM/call, fees sponsored`);
});
