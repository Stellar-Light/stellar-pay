/**
 * The stellar-pay library surface.
 *
 * Everything here is the same code the CLI and the MCP run — importing it puts
 * the 402 loop inside your own tool instead of shelling out:
 *
 *   import { payFetch, loadWallet } from "stellar-pay";
 *   const r = await payFetch(url, {}, { wallet: loadWallet(), approve });
 *
 * Nothing in this module touches the Mongo indexer, so a consumer installs the
 * payment path and not the probe's dependencies.
 */

// The probed catalog of live, Stellar-payable endpoints.
export {
	daysAlive,
	type Entry,
	groupByHost,
	loadCatalog,
	searchCatalog,
} from "./catalog.js";
// The MCP server, for embedding in your own host.
export { buildServer, serveStdio } from "./mcp.js";
// The paid fetch: request → 402 → read offers → approve → pay → retry.
// pinMismatch is the bait-and-switch rule — exported so a consumer building
// its own flow gets the same protection instead of reimplementing it.
export { type PayResult, payFetch, pinMismatch } from "./pay/curl.js";
// Spend governance (dedupe / freshness / quarantine / budget + attribution).
export {
	buildGoverned,
	type Governed,
	type Payment,
	type PreferInit,
} from "./pay/governed.js";
export { ensureSecretLoaded } from "./pay/keystore.js";
// Reading a 402: what it asks, in USD, and how to describe it.
export {
	describeOffer,
	isStellar,
	type Offer,
	offerUSD,
	type Protocol,
	readOffers,
	USDC_SAC,
} from "./pay/offers.js";
// The spend decision — the same one the CLI and MCP gate on, including the
// per-host policy file (ceilings, deny, allowlist).
export {
	autoApprove,
	decide,
	explorer,
	type HostGate,
	type HostRule,
	loadPolicy,
	type Policy,
	policyPath,
	resolveHost,
	type Verdict,
} from "./pay/policy.js";
// The command-wrapping proxy: pay 402s made by a tool you didn't write.
export {
	type ProxyOptions,
	proxyEnv,
	startProxy,
} from "./pay/proxy.js";
// Seller-side: is this endpoint a correct, Stellar-payable 402?
export { verifyEndpoint } from "./pay/verify.js";
// Wallet + balances (STELLAR_SECRET_KEY or the encrypted keystore).
export {
	balances,
	loadWallet,
	type Network,
	type Wallet,
} from "./pay/wallet.js";
