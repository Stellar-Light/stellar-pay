/**
 * Jobs — escrow-backed work agreements on Trustless Work's CONTRACT (testnet).
 *
 * DIRECT integration, no intermediary: we deploy escrow instances from TW's
 * live testnet wasm (content-addressed — deploying the hash IS their code),
 * invoke the lifecycle via Soroban RPC, sign with OUR keys, submit
 * ourselves. No API key, no account, no TW server in the loop — their
 * README's word for the infrastructure is "permissionless", and this module
 * takes it at its word. (v1 of this file used their REST API and inherited
 * its x-api-key gate; the owner's objection was correct — a neutral layer
 * cannot require every agent to open an account with an intermediary.)
 *
 * Lifecycle (single-release):
 *   open    deploy from wasm hash + initialize_escrow(Escrow) — the spec
 *           text rides `description`, sha256(spec) rides `engagement_id`:
 *           terms hash-pinned on-chain from birth
 *   fund    fund_escrow — the contract re-checks the EXPECTED escrow struct
 *           (their anti-TOCTOU design; we pass what we initialized)
 *   deliver change_milestone_status(evidence) by the service provider
 *   approve approve_milestone by the approver
 *   release release_funds — pays receiver minus platform fee (ours: 0) and
 *           TW's 0.3%, which goes to `twFeeAddress`
 *
 * TW FEE HONESTY: the contract sends 0.3% to a caller-supplied address and
 * does not validate it. Their API passes their own; direct callers must
 * too. TW_FEE_ADDRESS env or the explicit parameter — the e2e uses a
 * declared placeholder on testnet play money; REAL usage must set TW's
 * published fee address (asking them to publish it is on the outreach
 * list).
 *
 * Every step lands a receipt ref-chained to the job-open row: the
 * attribution chain IS the job's history.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	Address,
	BASE_FEE,
	Contract,
	type Keypair,
	Networks,
	nativeToScVal,
	Operation,
	rpc,
	TransactionBuilder,
	xdr,
} from "@stellar/stellar-sdk";
import {
	type AgreementInput,
	agreementHash,
	buildAgreement,
} from "./agreement.js";
import { record } from "./receipts.js";

const RPC_URL =
	process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
/** TW's live single-release escrow wasm on testnet — read off their own
 * deployed instances (CCVMTKXF…, CDY37HAA…) on 2026-08-29. Content-addressed:
 * deploying this hash deploys exactly their audited-or-not code, nothing else. */
export const TW_ESCROW_WASM_HASH =
	"7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b";

export type JobSpec = {
	/** pays, approves, releases — the buyer */
	buyer: Keypair;
	/** does the work, receives the payout (public key) */
	provider: string;
	/** arbitrates disputes; defaults to buyer — DECLARED in the receipt */
	judge?: string;
	/** SEP-41 token contract (SAC) the job pays in */
	tokenContract: string;
	/** amount in the token's base units (i128) */
	amount: bigint;
	title: string;
	/** the terms prose (becomes the AutoContracts `## Terms` section) */
	spec: string;
	/** TW's 0.3% fee recipient — REQUIRED to be TW's published address in
	 * real usage; testnet harnesses may pass a declared placeholder */
	twFeeAddress: string;
	/** AutoContracts alignment (all optional; defaults make a valid v1 doc):
	 * the bounded review question, the evidence classes the resolver may
	 * inspect, the answer=>outcome effects, an ISO-8601 deadline, and the
	 * resolver policy label. Defaults describe the buyer-as-approver case. */
	reviewQuestion?: string;
	allowedEvidence?: string[];
	resolutionEffects?: Array<[string, string]>;
	deadline?: string;
	resolverPolicy?: string;
};

/** Build the AutoContracts v1 agreement doc for a job + its keccak hash.
 * Exported so callers (and tests) can render/verify the same bytes the
 * chain commits to. Deterministic: no timestamps beyond the caller's
 * deadline, so the same JobSpec always yields the same hash. */
export function jobAgreement(o: JobSpec): { doc: string; hash: string } {
	const input: AgreementInput = {
		network: "stellar:testnet",
		buyer: o.buyer.publicKey(),
		provider: o.provider,
		resolver: o.judge ?? o.buyer.publicKey(),
		resolverPolicy:
			o.resolverPolicy ?? (o.judge ? "third-party-resolver" : "buyer-approves"),
		title: o.title,
		terms: o.spec,
		reviewQuestion:
			o.reviewQuestion ??
			"Did the provider deliver the work described in Terms?",
		allowedEvidence: o.allowedEvidence ?? [
			"the submission hash recorded on the milestone",
			"artifacts the provider links in the submission",
		],
		resolutionEffects: o.resolutionEffects ?? [
			["yes", "release"],
			["no", "refund"],
		],
		deadline: o.deadline ?? "2100-01-01T00:00:00Z",
		tokenContract: o.tokenContract,
		amount: o.amount,
	};
	const doc = buildAgreement(input);
	return { doc, hash: agreementHash(doc) };
}

const server = () => new rpc.Server(RPC_URL);

async function submit(
	built: import("@stellar/stellar-sdk").Transaction,
	signer: Keypair,
): Promise<string> {
	const s = server();
	const prepared = await s.prepareTransaction(built);
	prepared.sign(signer);
	const sent = await s.sendTransaction(prepared);
	if (sent.status === "ERROR")
		throw new Error(`tx rejected: ${JSON.stringify(sent.errorResult)}`);
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		const res = await s.getTransaction(sent.hash);
		if (res.status === "SUCCESS") return sent.hash;
		if (res.status === "FAILED")
			throw new Error(`tx failed on-chain: ${sent.hash}`);
	}
	throw new Error(`tx timed out: ${sent.hash}`);
}

async function invoke(
	contractId: string,
	method: string,
	args: xdr.ScVal[],
	signer: Keypair,
): Promise<string> {
	const s = server();
	const acct = await s.getAccount(signer.publicKey());
	const tx = new TransactionBuilder(acct, {
		fee: (Number(BASE_FEE) * 1000).toString(),
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(new Contract(contractId).call(method, ...args))
		.setTimeout(60)
		.build();
	return submit(tx, signer);
}

/** The contract's Escrow struct as an ScVal — field names and types must
 * match storage/types.rs exactly; the contract re-validates this struct on
 * fund (their anti-TOCTOU), so one canonical builder serves both calls. */
function escrowScVal(
	o: JobSpec,
	engagementId: string,
	description: string,
): xdr.ScVal {
	const addr = (a: string) => Address.fromString(a).toScVal();
	const str = (v: string) => xdr.ScVal.scvString(v);
	const sym = (v: string) => xdr.ScVal.scvSymbol(v);
	const map = (entries: Array<[string, xdr.ScVal]>) =>
		xdr.ScVal.scvMap(
			entries
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })),
		);
	return map([
		// engagement_id carries the AutoContracts termsHash (keccak of the
		// agreement doc that lives in `description`) — a resolver reads the
		// doc, hashes it, and it equals this.
		["engagement_id", str(engagementId)],
		["title", str(o.title)],
		[
			"roles",
			map([
				["approver", addr(o.buyer.publicKey())],
				["service_provider", addr(o.provider)],
				["platform", addr(o.buyer.publicKey())],
				["release_signer", addr(o.buyer.publicKey())],
				["dispute_resolver", addr(o.judge ?? o.buyer.publicKey())],
				["receiver", addr(o.provider)],
			]),
		],
		// The FULL AutoContracts v1 agreement doc — this is what a conforming
		// resolver ingests to answer the Review Question.
		["description", str(description)],
		["amount", nativeToScVal(o.amount, { type: "i128" })],
		["platform_fee", nativeToScVal(0, { type: "u32" })],
		[
			"milestones",
			xdr.ScVal.scvVec([
				map([
					["description", str(o.title)],
					["status", str("pending")],
					["evidence", str("")],
					["approved", xdr.ScVal.scvBool(false)],
				]),
			]),
		],
		[
			"flags",
			map([
				["disputed", xdr.ScVal.scvBool(false)],
				["released", xdr.ScVal.scvBool(false)],
				["resolved", xdr.ScVal.scvBool(false)],
			]),
		],
		["trustline", map([["address", addr(o.tokenContract)]])],
		["receiver_memo", nativeToScVal(0, { type: "u32" })],
	]);
}

export async function openJob(o: JobSpec): Promise<{
	contractId: string;
	engagementId: string;
	receiptId: string;
	deployTx: string;
	initTx: string;
	agreementDoc: string;
	termsHash: string;
}> {
	const s = server();
	// The AutoContracts v1 agreement IS the terms; its keccak is the
	// engagement_id (cross-ecosystem address). The sha256 of the raw spec is
	// kept in the receipt too, for our own provenance chain.
	const specHash = createHash("sha256").update(o.spec).digest("hex");
	const { doc: agreementDoc, hash: termsHash } = jobAgreement(o);
	const engagementId = termsHash;

	// 1. Deploy an instance of THEIR wasm (empty __constructor).
	const acct = await s.getAccount(o.buyer.publicKey());
	const deployTxB = new TransactionBuilder(acct, {
		fee: (Number(BASE_FEE) * 1000).toString(),
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			Operation.createCustomContract({
				address: Address.fromString(o.buyer.publicKey()),
				wasmHash: Buffer.from(TW_ESCROW_WASM_HASH, "hex"),
				salt: randomBytes(32),
			}),
		)
		.setTimeout(60)
		.build();
	const prepared = await s.prepareTransaction(deployTxB);
	prepared.sign(o.buyer);
	const sent = await s.sendTransaction(prepared);
	if (sent.status === "ERROR")
		throw new Error(`deploy rejected: ${JSON.stringify(sent.errorResult)}`);
	let contractId = "";
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		const res = await s.getTransaction(sent.hash);
		if (res.status === "SUCCESS") {
			contractId = Address.fromScVal(res.returnValue!).toString();
			break;
		}
		if (res.status === "FAILED") throw new Error(`deploy failed: ${sent.hash}`);
	}
	if (!contractId) throw new Error("deploy timed out");

	// 2. Initialize with the escrow struct — terms live on-chain from here.
	const initTx = await invoke(
		contractId,
		"initialize_escrow",
		[escrowScVal(o, engagementId, agreementDoc)],
		o.buyer,
	);

	const receiptId = record({
		kind: "job-open",
		network: "stellar:testnet",
		amount: o.amount.toString(),
		asset: o.tokenContract,
		payer: o.buyer.publicKey(),
		payee: o.provider,
		tx: initTx,
		detail: {
			contractId,
			engagementId,
			standard: "auto.contracts/v1",
			termsHash,
			specSha256: specHash,
			resolver: o.judge ?? o.buyer.publicKey(),
			resolverPolicy:
				o.resolverPolicy ??
				(o.judge ? "third-party-resolver" : "buyer-approves"),
			deployTx: sent.hash,
			wasmHash: TW_ESCROW_WASM_HASH,
			title: o.title,
		},
	});
	return {
		contractId,
		engagementId,
		receiptId,
		deployTx: sent.hash,
		initTx,
		agreementDoc,
		termsHash,
	};
}

export async function fundJob(
	o: JobSpec & {
		contractId: string;
		engagementId: string;
		openReceiptId: string;
	},
): Promise<{ tx: string; receiptId: string }> {
	// The contract re-validates the EXPECTED escrow struct on fund, so this
	// must be byte-identical to what openJob initialized — same agreement doc,
	// same engagement_id (the termsHash openJob returned).
	const { doc } = jobAgreement(o);
	const tx = await invoke(
		o.contractId,
		"fund_escrow",
		[
			Address.fromString(o.buyer.publicKey()).toScVal(),
			escrowScVal(o, o.engagementId, doc),
			nativeToScVal(o.amount, { type: "i128" }),
		],
		o.buyer,
	);
	const receiptId = record({
		kind: "job-fund",
		network: "stellar:testnet",
		amount: o.amount.toString(),
		asset: o.tokenContract,
		payer: o.buyer.publicKey(),
		tx,
		refs: [o.openReceiptId],
		detail: { contractId: o.contractId },
	});
	return { tx, receiptId };
}

export async function deliverJob(o: {
	provider: Keypair;
	contractId: string;
	evidence: string;
	prevReceiptId: string;
}): Promise<{ tx: string; receiptId: string }> {
	const tx = await invoke(
		o.contractId,
		"change_milestone_status",
		[
			nativeToScVal(0, { type: "u32" }),
			xdr.ScVal.scvString("completed"),
			xdr.ScVal.scvString(o.evidence), // Option<String>: Some = the value
			Address.fromString(o.provider.publicKey()).toScVal(),
		],
		o.provider,
	);
	const receiptId = record({
		kind: "job-deliver",
		network: "stellar:testnet",
		payer: o.provider.publicKey(),
		tx,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId, evidence: o.evidence },
	});
	return { tx, receiptId };
}

export async function approveJob(o: {
	approver: Keypair;
	contractId: string;
	prevReceiptId: string;
}): Promise<{ tx: string; receiptId: string }> {
	const tx = await invoke(
		o.contractId,
		"approve_milestone",
		[
			nativeToScVal(0, { type: "u32" }),
			Address.fromString(o.approver.publicKey()).toScVal(),
		],
		o.approver,
	);
	const receiptId = record({
		kind: "job-approve",
		network: "stellar:testnet",
		payer: o.approver.publicKey(),
		tx,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId },
	});
	return { tx, receiptId };
}

export async function releaseJob(o: {
	releaseSigner: Keypair;
	contractId: string;
	twFeeAddress: string;
	prevReceiptId: string;
}): Promise<{ tx: string; receiptId: string }> {
	const tx = await invoke(
		o.contractId,
		"release_funds",
		[
			Address.fromString(o.releaseSigner.publicKey()).toScVal(),
			Address.fromString(o.twFeeAddress).toScVal(),
		],
		o.releaseSigner,
	);
	const receiptId = record({
		kind: "job-release",
		network: "stellar:testnet",
		payer: o.releaseSigner.publicKey(),
		tx,
		refs: [o.prevReceiptId],
		detail: { contractId: o.contractId, twFeeAddress: o.twFeeAddress },
	});
	return { tx, receiptId };
}
