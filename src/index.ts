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

// ── The work layer (TESTNET-ONLY until the escrow/smart-account/channel
// contracts clear their audit posture): pay for WORK, not just requests. ──

// Hash-committed agreements (stellar-pay/agreement-v1, sha256-canonical).
export {
	type AgreementInput,
	agreementHash,
	buildAgreement,
	parseAgreement,
} from "./pay/agreement.js";
// Verification bounties: directed (post → assign → submit → resolve) and
// open-claim (escrow first, anyone submits, first VALID evidence wins).
export {
	assignBounty,
	type BountyDescriptor,
	bountyStatus,
	type EvidenceEntry,
	// SECOND-PARTY SURFACE (design audit): the functions someone writing an
	// independent worker or resolver needs were exactly the ones missing from
	// this file — you could consume the package, but you could not implement
	// against the formats it defines. A wire format nobody else can produce is
	// not a format.
	makeCommit,
	makeSubmission,
	type OpenCommit,
	type OpenSubmission,
	openBountyTerms,
	pickWinner,
	postBounty,
	postOpenBounty,
	resolveBounty,
	resolveOpenBounty,
	submissionDigest,
	submitBounty,
	verificationEvidencePolicy,
} from "./pay/bounty.js";
// Escrow-backed jobs on swappable rails (Trustless Work adapter today —
// keyless, straight at the contract).
export {
	approveJob,
	deliverJob,
	disputeJob,
	fundJob,
	getRails,
	type JobSpec,
	jobAgreement,
	openJob,
	readEscrow,
	releaseJob,
	resolveDisputeJob,
	setRails,
} from "./pay/job.js";
export type { EscrowRails, EscrowState } from "./pay/rails.js";
// The content-addressed local ledger + on-chain verification of a row.
export {
	checkLedger,
	list as listReceipts,
	type ReceiptRow,
	record as recordReceipt,
	verifyOnChain,
} from "./pay/receipts.js";
// Policy-driven dispute resolution (deterministic or delegated).
export {
	callbackPolicy,
	hashMatchPolicy,
	type ResolverPolicy,
	resolveJob,
} from "./pay/resolver.js";
// One-way payment channels: deposit once, pay per call off-chain.
export { closeChannel, openChannel, sessionFetch } from "./pay/session.js";
// The smart-account vault: fund an agent behind an ON-CHAIN spend cap.
export {
	createVault,
	drawFromVault,
	topupVault,
	type VaultRecord,
	vaultStatus,
} from "./pay/vault.js";
// The WORKER side — how an agent earns: discover listings, vet them against
// the chain (never trust the feed), submit signed evidence, collect.
export {
	awaitPayout,
	// A feed is a public format: publishing one must not require reading our
	// CLI's source. BOUNTY_FEED_FORMAT + buildFeed are the producer half that
	// `fetchFeed` (the consumer half) was already exported without.
	BOUNTY_FEED_FORMAT,
	type BountyFeed,
	buildFeed,
	checkListing,
	fetchFeed,
	type OpenBountyListing,
	type PayoutResult,
	submitPacket,
	type VetCheck,
	vetListing,
} from "./pay/worker.js";
