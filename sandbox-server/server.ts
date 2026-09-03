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
import * as stellarChannel from "@stellar/mpp/channel/server";
import * as stellarServer from "@stellar/mpp/charge/server";
import { randomBytes } from "node:crypto";
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import {
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
} from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as X402FacilitatorScheme } from "@x402/stellar/exact/facilitator";
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

// The HMAC key proving "this server issued that challenge". A literal default
// would be a PUBLIC signing key (it was, and an audit forged against it live),
// so there is no fallback: generate one per boot if the operator didn't set it.
// Per-boot rotation is fine here — challenges live 5 minutes.
const credentialSecret =
	process.env.CREDENTIAL_SECRET && process.env.CREDENTIAL_SECRET.length >= 16
		? process.env.CREDENTIAL_SECRET
		: randomBytes(32).toString("hex");
if (!process.env.CREDENTIAL_SECRET)
	console.warn(
		"CREDENTIAL_SECRET unset — using a random per-boot key (challenges won't survive a restart)",
	);

const mppx = Mppx.create({
	secretKey: credentialSecret,
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

// ── Channel mode (Track 1 slice, testnet-only) ──────────────────────────────
// A one-way payment channel turns N paid calls into ONE on-chain deposit and
// ONE on-chain close: between them, each request is a signed off-chain
// commitment for a strictly-increasing cumulative amount. Activated only when
// the operator supplies a deployed channel contract — the contract is
// deployed out-of-band (funder-authorized, deposit at deploy) because the
// UNAUDITED one-way-channel contract stays testnet-only by policy.
//   CHANNEL_CONTRACT   C… address of the deployed one-way-channel instance
//   COMMITMENT_PUBKEY  hex ed25519 public key the funder signs commitments with
const channelContract = process.env.CHANNEL_CONTRACT;
const commitmentPubkeyHex = process.env.COMMITMENT_PUBKEY;
const channelMppx =
	channelContract && commitmentPubkeyHex
		? Mppx.create({
				secretKey: credentialSecret,
				methods: [
					stellarChannel.stellar.channel({
						channel: channelContract,
						commitmentKey: StrKey.encodeEd25519PublicKey(
							Buffer.from(commitmentPubkeyHex, "hex"),
						),
						store: Store.memory(),
						network: NETWORK,
						// The seller sources and signs the on-chain close envelope, so
						// the funder needs nothing on-chain after the deposit.
						feePayer: { envelopeSigner: seller },
					}),
				],
			})
		: null;

const app = express();

// The challenge store is an unbounded Map upstream, and a rejected push-mode
// credential claims a slot without releasing it — so an unauthenticated caller
// could fill the machine's memory. Cap request rate per IP; cheap, and the
// sandbox has no legitimate high-volume caller.
const hits = new Map<string, { n: number; until: number }>();
app.use((req, res, next) => {
	const ip = req.ip ?? req.socket.remoteAddress ?? "?";
	const now = Date.now();
	const w = hits.get(ip);
	if (!w || w.until < now) hits.set(ip, { n: 1, until: now + 60_000 });
	else if (++w.n > 60) {
		res.setHeader("retry-after", "60");
		res.status(429).json({ error: "rate limited — this is a demo sandbox" });
		return;
	}
	// keep the limiter's own map from becoming the leak it prevents
	if (hits.size > 5_000)
		for (const [k, v] of hits) if (v.until < now) hits.delete(k);
	next();
});

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
		paid_endpoints: [
			"/data",
			"/quote",
			"/data-x402 (x402 v2)",
			...(channelMppx ? ["/data-session (channel mode)"] : []),
		],
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

// ── x402 v2 mode (the third protocol, same seller, same XLM) ────────────────
// The sandbox's MPP endpoints can't be listed in an x402 Bazaar (stellarsight
// runs conformance with unmodified @x402 clients), so /data-x402 serves the
// same paid call over x402 v2 `exact` with an IN-PROCESS facilitator — no
// external service, all crypto from @x402/stellar. Research tie: the settle
// response we return in PAYMENT-RESPONSE *is* a receipt — the PGTR-pattern
// artifact (payment receipt as proof-of-action) our strategy builds on.
// A contract (smart-account) payer's auth entry costs far more to verify
// on-chain than a classic keypair's — __check_auth fans out into a verifier
// contract and, for a capped agent key, a spending-limit policy contract on
// top of the SAC transfer itself. The library's own default fee ceiling
// (5e4 stroops) is sized for the classic case and rejects a contract payer's
// simulation-derived fee outright (invalid_exact_stellar_payload_fee_exceeds_maximum).
// MAX_FEE_STROOPS lets an operator raise it; unset, behavior is unchanged.
const maxFeeStroops = process.env.MAX_FEE_STROOPS
	? Number(process.env.MAX_FEE_STROOPS)
	: undefined;
const x402Fac = new x402Facilitator().register(
	"stellar:testnet",
	new X402FacilitatorScheme([createEd25519Signer(seller.secret())], {
		areFeesSponsored: true,
		...(maxFeeStroops ? { maxTransactionFeeStroops: maxFeeStroops } : {}),
	}),
);
const X402_PRICE_STROOPS = String(
	Math.round(Number(PRICE) * 10_000_000),
);
const x402Requirements = (url: string) => ({
	scheme: "exact" as const,
	network: "stellar:testnet" as const,
	asset: XLM_SAC,
	amount: X402_PRICE_STROOPS,
	payTo: seller.publicKey(),
	maxTimeoutSeconds: 120,
	extra: {
		assetCode: "XLM",
		humanAmount: `${PRICE} XLM`,
		areFeesSponsored: true,
	},
	// deliberately last: spread-safe if the type grows
	resource: url,
});
const x402PaymentRequired = (url: string, error?: string) => ({
	x402Version: 2,
	...(error ? { error } : {}),
	resource: {
		url,
		description: "stellar-pay sandbox paid call (x402 v2)",
		serviceName: "stellar-pay-sandbox",
		mimeType: "application/json",
	},
	accepts: [x402Requirements(url)],
});

app.get("/data-x402", async (req, res) => {
	const url = `https://${req.headers.host ?? "localhost"}/data-x402`;
	const send402 = (error?: string) => {
		const pr = x402PaymentRequired(url, error);
		res
			.status(402)
			.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(pr as never))
			// v1-compat JSON body; the header is the canonical v2 transport
			.json(pr);
	};
	const header =
		req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT") ?? undefined;
	if (!header) return send402();
	let payload: ReturnType<typeof decodePaymentSignatureHeader>;
	try {
		payload = decodePaymentSignatureHeader(header);
	} catch (e) {
		return send402(`invalid payment header: ${(e as Error).message}`);
	}
	// Never trust echoed money fields — verify against OUR requirements.
	const reqs = x402Requirements(url) as never;
	try {
		const v = await x402Fac.verify(payload as never, reqs);
		if (!(v as { isValid?: boolean }).isValid) {
			const vr = v as { invalidReason?: string; invalidMessage?: string };
			// The client only gets the terse reason code; the detail (e.g. the
			// actual simulated fee vs the ceiling) is only useful server-side.
			if (vr.invalidMessage)
				console.error(`x402 verify failed: ${vr.invalidMessage}`);
			return send402(`payment invalid: ${vr.invalidReason ?? "unspecified"}`);
		}
		const settle = await x402Fac.settle(payload as never, reqs);
		if (!(settle as { success?: boolean }).success) {
			const sr = settle as { errorReason?: string; errorMessage?: string };
			if (sr.errorMessage) console.error(`x402 settle failed: ${sr.errorMessage}`);
			return send402(
				`settlement failed: ${sr.errorReason ?? "unspecified"}`,
			);
		}
		res
			.setHeader(
				"PAYMENT-RESPONSE",
				encodePaymentResponseHeader(settle as never),
			)
			.json({
				ok: true,
				paid: true,
				mode: "x402",
				message: "you just paid for this on Stellar testnet via x402 v2",
				transaction: (settle as { transaction?: string }).transaction,
				at: new Date().toISOString(),
			});
	} catch (e) {
		return send402(`facilitator error: ${(e as Error).message}`);
	}
});

/** Paid via CHANNEL commitments — off-chain per call, on-chain only at
 * open (deposit) and close (settle). Testnet-only: the channel contract is
 * unaudited, so this route never appears unless the operator deployed one. */
if (channelMppx) {
	app.get(
		"/data-session",
		channelMppx.channel({
			amount: PRICE,
			description: "stellar-pay sandbox channel-gated call",
		}),
		(_req, res) => {
			res.json({
				ok: true,
				paid: true,
				mode: "channel",
				message:
					"paid via an off-chain channel commitment — no on-chain transaction for this call",
				at: new Date().toISOString(),
			});
		},
	);
}

/** Liveness, free. */
app.get("/health", (_req, res) =>
	res.json({ ok: true, network: NETWORK, channelMode: !!channelMppx }),
);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
	console.log(`stellar-pay sandbox on :${port}`);
	console.log(`  seller    ${seller.publicKey()}`);
	console.log(`  currency  native XLM (${XLM_SAC})`);
	console.log(`  price     ${PRICE} XLM/call, fees sponsored`);
});
