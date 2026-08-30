/**
 * Trustless Work escrow rails (testnet) — one implementation of EscrowRails.
 *
 * DIRECT to the contract, keyless: deploy instances from TW's live testnet
 * wasm (content-addressed — deploying the hash IS their code), invoke the
 * lifecycle via Soroban RPC, sign with the caller's keys. No API key, no
 * account, no TW server in the loop. To adopt a different escrow provider,
 * write another file like this one and pass it to setRails().
 */
import {
	Address,
	BASE_FEE,
	Contract,
	type Keypair,
	Networks,
	nativeToScVal,
	Operation,
	rpc,
	scValToNative,
	type Transaction,
	TransactionBuilder,
	xdr,
} from "@stellar/stellar-sdk";
import type { EscrowParams, EscrowRails, EscrowState } from "./rails.js";

const RPC_URL =
	process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
/** TW's live single-release escrow wasm on testnet — read off their own
 * deployed instances (CCVMTKXF…, CDY37HAA…) on 2026-08-29. */
export const TW_ESCROW_WASM_HASH =
	"7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b";

const server = () => new rpc.Server(RPC_URL);

async function submit(built: Transaction, signer: Keypair): Promise<string> {
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

/** The contract's Escrow struct as an ScVal — field names + types must match
 * storage/types.rs exactly; the contract re-validates it on fund (anti-TOCTOU),
 * so one builder serves both open and fund. */
function escrowScVal(p: EscrowParams): xdr.ScVal {
	const addr = (a: string) => Address.fromString(a).toScVal();
	const str = (v: string) => xdr.ScVal.scvString(v);
	const sym = (v: string) => xdr.ScVal.scvSymbol(v);
	const map = (entries: Array<[string, xdr.ScVal]>) =>
		xdr.ScVal.scvMap(
			entries
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })),
		);
	const decision = p.resolver ?? p.buyer;
	return map([
		["engagement_id", str(p.engagementId)],
		["title", str(p.title)],
		[
			"roles",
			map([
				["approver", addr(decision)],
				["service_provider", addr(p.provider)],
				["platform", addr(p.buyer)],
				["release_signer", addr(decision)],
				["dispute_resolver", addr(p.resolver ?? p.judge ?? p.buyer)],
				["receiver", addr(p.provider)],
			]),
		],
		["description", str(p.description)],
		["amount", nativeToScVal(p.amount, { type: "i128" })],
		["platform_fee", nativeToScVal(0, { type: "u32" })],
		[
			"milestones",
			xdr.ScVal.scvVec([
				map([
					["description", str(p.title)],
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
		["trustline", map([["address", addr(p.tokenContract)]])],
		["receiver_memo", nativeToScVal(0, { type: "u32" })],
	]);
}

export const trustlessWorkRails: EscrowRails = {
	name: "trustless-work",

	async deployAndInit(p) {
		const s = server();
		const acct = await s.getAccount(p.signer.publicKey());
		const deployTxB = new TransactionBuilder(acct, {
			fee: (Number(BASE_FEE) * 1000).toString(),
			networkPassphrase: Networks.TESTNET,
		})
			.addOperation(
				Operation.createCustomContract({
					address: Address.fromString(p.signer.publicKey()),
					wasmHash: Buffer.from(TW_ESCROW_WASM_HASH, "hex"),
					salt: (await import("node:crypto")).randomBytes(32),
				}),
			)
			.setTimeout(60)
			.build();
		const prepared = await s.prepareTransaction(deployTxB);
		prepared.sign(p.signer);
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
			if (res.status === "FAILED")
				throw new Error(`deploy failed: ${sent.hash}`);
		}
		if (!contractId) throw new Error("deploy timed out");
		const initTx = await invoke(
			contractId,
			"initialize_escrow",
			[escrowScVal(p)],
			p.signer,
		);
		return { contractId, deployTx: sent.hash, initTx };
	},

	async fund(p) {
		const tx = await invoke(
			p.contractId,
			"fund_escrow",
			[
				Address.fromString(p.signer.publicKey()).toScVal(),
				escrowScVal(p),
				nativeToScVal(p.amount, { type: "i128" }),
			],
			p.signer,
		);
		return { tx };
	},

	async setMilestoneStatus(o) {
		const tx = await invoke(
			o.contractId,
			"change_milestone_status",
			[
				nativeToScVal(o.index, { type: "u32" }),
				xdr.ScVal.scvString(o.status),
				xdr.ScVal.scvString(o.evidence), // Option<String>: Some = the value
				Address.fromString(o.provider.publicKey()).toScVal(),
			],
			o.provider,
		);
		return { tx };
	},

	async approveMilestone(o) {
		const tx = await invoke(
			o.contractId,
			"approve_milestone",
			[
				nativeToScVal(o.index, { type: "u32" }),
				Address.fromString(o.approver.publicKey()).toScVal(),
			],
			o.approver,
		);
		return { tx };
	},

	async releaseFunds(o) {
		const tx = await invoke(
			o.contractId,
			"release_funds",
			[
				Address.fromString(o.releaseSigner.publicKey()).toScVal(),
				Address.fromString(o.feeAddress).toScVal(),
			],
			o.releaseSigner,
		);
		return { tx };
	},

	async dispute(o) {
		const tx = await invoke(
			o.contractId,
			"dispute_escrow",
			[Address.fromString(o.signer.publicKey()).toScVal()],
			o.signer,
		);
		return { tx };
	},

	async resolveDispute(o) {
		const distMap = xdr.ScVal.scvMap(
			o.distributions
				.slice()
				.sort(([a], [b]) => a.localeCompare(b))
				.map(
					([to, amt]) =>
						new xdr.ScMapEntry({
							key: Address.fromString(to).toScVal(),
							val: nativeToScVal(amt, { type: "i128" }),
						}),
				),
		);
		const tx = await invoke(
			o.contractId,
			"resolve_dispute",
			[
				Address.fromString(o.disputeResolver.publicKey()).toScVal(),
				Address.fromString(o.feeAddress).toScVal(),
				distMap,
			],
			o.disputeResolver,
		);
		return { tx };
	},

	async readEscrow(o): Promise<EscrowState> {
		const s = server();
		const acct = await s.getAccount(o.source.publicKey());
		const tx = new TransactionBuilder(acct, {
			fee: BASE_FEE,
			networkPassphrase: Networks.TESTNET,
		})
			.addOperation(new Contract(o.contractId).call("get_escrow"))
			.setTimeout(30)
			.build();
		const sim = await s.simulateTransaction(tx);
		if (rpc.Api.isSimulationError(sim))
			throw new Error(`get_escrow simulation failed: ${sim.error}`);
		const retval = sim.result?.retval;
		if (!retval) throw new Error("get_escrow returned no value");
		// biome-ignore lint/suspicious/noExplicitAny: decoded contract struct
		const e = scValToNative(retval) as any;
		const m0 = e.milestones?.[0] ?? {};
		return {
			description: String(e.description ?? ""),
			evidence: String(m0.evidence ?? ""),
			milestoneStatus: String(m0.status ?? ""),
			approved: Boolean(m0.approved),
			released: Boolean(e.flags?.released),
			disputed: Boolean(e.flags?.disputed),
			amount: BigInt(e.amount ?? 0),
			buyer: String(e.roles?.platform ?? e.roles?.approver ?? ""),
			provider: String(e.roles?.receiver ?? ""),
		};
	},
};
