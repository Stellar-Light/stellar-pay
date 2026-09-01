/**
 * The vault — fund an agent safely (the "fund" beat of the loop; SPINE.md).
 *
 * Shape (the roadmap's own design, now product): a smart-account CONTRACT
 * holds the balance; the OWNER is a durable software passkey (persisted
 * locally); the AGENT is this install's wallet key, present ONLY on a
 * token-scoped rule carrying an on-chain spending-limit policy. The agent
 * draws float to its classic account and pays 402s/jobs from that float —
 * and the CHAIN, not our code, refuses any draw beyond the cap. Contrast,
 * plainly: custodial platforms enforce agent limits in their servers (a
 * policy promise by a company); here the limit is a property of the
 * contract, provable by the refusal transaction (test:vault).
 *
 * TESTNET ONLY — the smart-account contracts' audit posture gates mainnet,
 * same standard as everything else here.
 *
 * Persistence honesty: the owner-passkey PEM lives in sessions.json next to
 * the channel commitment seeds — PLAINTEXT on disk. The passkey only
 * administers THIS vault (it holds no funds directly and the wallet key
 * cannot be replaced by it silently), but moving it into the sealed
 * keystore is the right next hardening; noted in the roadmap.
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
	createCallContractContext,
	createEd25519Signer,
	createSpendingLimitParams,
	MemoryStorage,
	SmartAccountKit,
} from "smart-account-kit";
import {
	getOsSecret,
	hasOsStore,
	osStoreName,
	putOsSecret,
} from "./keystore.js";
import { softwarePasskey } from "./passkey.js";
import { record } from "./receipts.js";
import { getVault, putVault, updateVault } from "./session-store.js";
import type { Wallet } from "./wallet.js";

const CFG = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	networkPassphrase: "Test SDF Network ; September 2015",
	accountWasmHash:
		"1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a",
	webauthnVerifierAddress:
		"CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F",
	ed25519VerifierAddress:
		"CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4",
	spendingLimitPolicyAddress:
		"CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G",
};
export const XLM_SAC_TESTNET =
	"CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const DAY_LEDGERS = 17_280;

export type VaultRecord = {
	contractId: string;
	network: "stellar:testnet";
	/**
	 * LEGACY ONLY. The owner key used to live here in plaintext, which made
	 * read access to sessions.json equivalent to being the vault's owner — on
	 * a rule that cannot carry a spending limit, so the reader is uncapped.
	 * New vaults store it in the OS secret store and leave this undefined;
	 * `ownerKeyOf` migrates an existing one on first use.
	 */
	ownerPasskeyPem?: string;
	ownerCredentialId: string;
	agentPublicKey: string;
	tokenContract: string;
	capStroops: string;
	periodLedgers: number;
	createdAt: string;
};

type TxResult = {
	success: boolean;
	hash?: string;
	error?: { message?: string };
};

const OWNER_SLOT = "vault-owner-passkey";

/**
 * The vault owner's private key, from the OS secret store — migrating a
 * legacy plaintext copy out of sessions.json the first time we see one.
 *
 * Migration is deliberately one-way and eager: reading it is exactly when we
 * know the machine can produce the value, so it is the only moment we can
 * move it without asking the user to do anything. If there is no OS store we
 * do NOT silently keep the plaintext — the operator has to say so.
 */
function ownerKeyOf(v: VaultRecord): string {
	const stored = getOsSecret(OWNER_SLOT);
	if (stored) return stored;
	if (!v.ownerPasskeyPem)
		throw new Error(
			`the vault owner key is not in ${osStoreName()} and this record has no legacy copy — the vault cannot be operated from this machine`,
		);
	// A store being PRESENT is not a store being WRITABLE: a locked keychain,
	// a headless session with no keyring daemon, or a policy-restricted host
	// all throw here. That must not brick the vault — it means the key could
	// not be secured, which is the same situation as having no store at all.
	let migrated = false;
	if (hasOsStore()) {
		try {
			putOsSecret(OWNER_SLOT, v.ownerPasskeyPem);
			const { ownerPasskeyPem: _dropped, ...withoutKey } = v;
			updateVault(withoutKey);
			migrated = true;
			console.error(
				`stellar-pay: moved the vault owner key out of sessions.json into ${osStoreName()} (it was stored in plaintext).`,
			);
		} catch (e) {
			console.error(
				`stellar-pay: could not write the vault owner key to ${osStoreName()} (${(e as Error).message.split("\n")[0]}) — it stays in plaintext for now.`,
			);
		}
	}
	if (!migrated && process.env.STELLAR_PAY_ALLOW_PLAINTEXT_VAULT !== "1") {
		throw new Error(
			"the vault owner key is stored in PLAINTEXT in sessions.json and no OS secret store is available to move it into. Anyone who can read that file is the vault's owner. Install one (linux: `apt install libsecret-tools`) or set STELLAR_PAY_ALLOW_PLAINTEXT_VAULT=1 to accept the risk explicitly.",
		);
	}
	return v.ownerPasskeyPem;
}

/** Test seam: the migration is the security property, so it needs to be
 *  assertable without deploying a smart account. */
export const __ownerKeyOfForTest = ownerKeyOf;

function kitFor(v: {
	ownerPasskeyPem?: string;
	ownerCredentialId?: string;
	deployerSecret: string;
}): { kit: SmartAccountKit; passkey: ReturnType<typeof softwarePasskey> } {
	const passkey = softwarePasskey(
		"stellar-pay.local",
		v.ownerPasskeyPem && v.ownerCredentialId
			? {
					privateKeyPem: v.ownerPasskeyPem,
					credentialIdB64url: v.ownerCredentialId,
				}
			: undefined,
	);
	const kit = new SmartAccountKit({
		...CFG,
		deployerSecret: v.deployerSecret,
		storage: new MemoryStorage(),
		rpId: "stellar-pay.local",
		rpName: "stellar-pay vault",
		webAuthn: passkey,
	} as never);
	return { kit, passkey };
}

/** Create the vault: deploy the smart account (owner = fresh durable
 * passkey), install the cap rule for THIS WALLET's key on the token, and
 * persist the record. One vault per install (v1). */
export async function createVault(o: {
	wallet: Wallet;
	capXlm: number;
	tokenContract?: string;
}): Promise<VaultRecord & { deployTx?: string }> {
	if (o.wallet.network !== "stellar:testnet")
		throw new Error(
			"vaults are testnet-only: mainnet is gated on the smart-account contracts' audit posture",
		);
	if (getVault())
		throw new Error("a vault already exists for this install (v1: one vault)");
	const token = o.tokenContract ?? XLM_SAC_TESTNET;
	const { kit, passkey } = kitFor({
		deployerSecret: o.wallet.keypair.secret(),
	});

	const created = await kit.createWallet("stellar-pay", "vault", {
		autoSubmit: true,
		forceMethod: "rpc",
	});
	const contractId = created.contractId;
	if (!contractId) throw new Error("vault deploy returned no contract id");

	// The agent (this wallet) goes on a token-scoped rule with the cap —
	// params through the kit's typed converter (raw JS traps the VM).
	kit.externalSigners.addEd25519FromSecret(o.wallet.keypair.secret());
	const cap = (
		kit as unknown as {
			convertPolicyParams: (t: string, p: unknown) => unknown;
		}
	).convertPolicyParams(
		"spending_limit",
		createSpendingLimitParams(
			BigInt(Math.round(o.capXlm * 10_000_000)),
			DAY_LEDGERS,
		),
	);
	const ruleTx = await kit.rules.add(
		createCallContractContext(token),
		"agent-cap",
		[
			createEd25519Signer(
				CFG.ed25519VerifierAddress,
				o.wallet.keypair.rawPublicKey(),
			),
		],
		new Map([[CFG.spendingLimitPolicyAddress, cap]]),
	);
	const ruleRes = (await kit.signAndSubmit(
		ruleTx as never,
		{
			forceMethod: "rpc",
		} as never,
	)) as TxResult;
	if (ruleRes.success === false)
		throw new Error(`cap rule install failed: ${ruleRes.error?.message}`);

	// PUT THE KEY SOMEWHERE BEFORE CLAIMING IT IS SOMEWHERE. The previous
	// change removed `ownerPasskeyPem` from this record with a comment saying
	// the key "goes to the OS store" and never wrote it there — so a freshly
	// created vault had its owner key in neither place and threw on the first
	// draw. The comment was the whole implementation. Storing it is now the
	// statement, and the fallback is explicit rather than assumed.
	let sealedOwnerKey = false;
	if (hasOsStore()) {
		try {
			putOsSecret(OWNER_SLOT, passkey.privateKeyPem);
			sealedOwnerKey = true;
		} catch (e) {
			console.error(
				`stellar-pay: could not write the vault owner key to ${osStoreName()} (${(e as Error).message.split("\n")[0]})`,
			);
		}
	}
	if (!sealedOwnerKey && process.env.STELLAR_PAY_ALLOW_PLAINTEXT_VAULT !== "1")
		throw new Error(
			`the vault owner key cannot be stored safely on this machine (${osStoreName()} unavailable or not writable). It authenticates as the vault's OWNER on a rule that carries no spending limit, so writing it in plaintext is not something to do by default. Install an OS secret store (linux: \`apt install libsecret-tools\`) or set STELLAR_PAY_ALLOW_PLAINTEXT_VAULT=1 to accept the risk explicitly.`,
		);

	const rec: VaultRecord = {
		contractId,
		network: "stellar:testnet",
		// Present ONLY when the operator explicitly accepted plaintext above.
		...(sealedOwnerKey ? {} : { ownerPasskeyPem: passkey.privateKeyPem }),
		ownerCredentialId: passkey.credentialId,
		agentPublicKey: o.wallet.publicKey,
		tokenContract: token,
		capStroops: String(Math.round(o.capXlm * 10_000_000)),
		periodLedgers: DAY_LEDGERS,
		createdAt: new Date().toISOString(),
	};
	putVault(rec);
	record({
		kind: "vault-create",
		network: "stellar:testnet",
		payer: o.wallet.publicKey,
		detail: {
			vault: contractId,
			capStroops: rec.capStroops,
			periodLedgers: DAY_LEDGERS,
			token,
		},
	});
	return rec;
}

/** Move funds INTO the vault from the wallet (a plain SAC transfer — anyone
 * may fund a contract address). */
export async function topupVault(o: {
	wallet: Wallet;
	amountXlm: number;
}): Promise<{ hash: string }> {
	const v = getVault();
	if (!v)
		throw new Error("no vault — create one first: vault create --cap-xlm N");
	// A topup is a plain SAC transfer wallet → vault contract; no kit needed
	// (the kit's fundWallet friendbots a throwaway — not what a topup means).
	const {
		Address,
		BASE_FEE,
		Contract,
		Networks,
		nativeToScVal,
		rpc,
		TransactionBuilder,
	} = await import("@stellar/stellar-sdk");
	const s = new rpc.Server(CFG.rpcUrl);
	const acct = await s.getAccount(o.wallet.publicKey);
	const tx = new TransactionBuilder(acct, {
		fee: (Number(BASE_FEE) * 1000).toString(),
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			new Contract(v.tokenContract).call(
				"transfer",
				Address.fromString(o.wallet.publicKey).toScVal(),
				Address.fromString(v.contractId).toScVal(),
				nativeToScVal(BigInt(Math.round(o.amountXlm * 10_000_000)), {
					type: "i128",
				}),
			),
		)
		.setTimeout(60)
		.build();
	const prepared = await s.prepareTransaction(tx);
	prepared.sign(o.wallet.keypair);
	const sent = await s.sendTransaction(prepared);
	if (sent.status === "ERROR")
		throw new Error(`topup rejected: ${JSON.stringify(sent.errorResult)}`);
	let confirmed = false;
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		const st = await s.getTransaction(sent.hash);
		if (st.status === "SUCCESS") {
			confirmed = true;
			break;
		}
		if (st.status === "FAILED") throw new Error(`topup failed: ${sent.hash}`);
	}
	if (!confirmed) throw new Error("topup timed out");
	const res: TxResult = { success: true, hash: sent.hash };
	record({
		kind: "vault-topup",
		network: "stellar:testnet",
		amount: String(Math.round(o.amountXlm * 10_000_000)),
		asset: v.tokenContract,
		payer: o.wallet.publicKey,
		payee: v.contractId,
		tx: res.hash ?? null,
		detail: { vault: v.contractId },
	});
	return { hash: res.hash ?? "" };
}

/** The agent draws float from the vault to its own classic account — UNDER
 * THE ON-CHAIN CAP. An over-cap draw is refused by the chain, and that
 * refusal lands in the ledger as an on-chain policy decision. */
export async function drawFromVault(o: {
	wallet: Wallet;
	amountXlm: number;
}): Promise<{ ok: boolean; hash?: string; refusal?: string }> {
	const v = getVault();
	if (!v)
		throw new Error("no vault — create one first: vault create --cap-xlm N");
	if (o.wallet.publicKey !== v.agentPublicKey)
		throw new Error(
			`this wallet (${o.wallet.publicKey.slice(0, 8)}…) is not the vault's agent (${v.agentPublicKey.slice(0, 8)}…)`,
		);
	const { kit } = kitFor({
		ownerPasskeyPem: ownerKeyOf(v),
		ownerCredentialId: v.ownerCredentialId,
		deployerSecret: o.wallet.keypair.secret(),
	});
	await kit.connectWallet({
		contractId: v.contractId,
		credentialId: v.ownerCredentialId,
	});
	kit.externalSigners.addEd25519FromSecret(o.wallet.keypair.secret());
	const signers = (
		kit.multiSigners as unknown as {
			buildSelectedSigners: (s: unknown[], c?: string) => unknown[];
		}
	).buildSelectedSigners([
		createEd25519Signer(
			CFG.ed25519VerifierAddress,
			o.wallet.keypair.rawPublicKey(),
		),
	]);
	const res = (await kit.multiSigners.transfer(
		v.tokenContract,
		o.wallet.publicKey,
		o.amountXlm,
		signers as never,
		{ forceMethod: "rpc" },
	)) as TxResult;
	if (res.success === false) {
		const refusal = res.error?.message ?? "refused";
		// Only a real cap refusal is a POLICY decision; a network/RPC failure
		// receipted as "spending-limit" would be the ledger lying about what
		// the chain decided.
		const isCapRefusal = /spending limit|exceed/i.test(refusal);
		record({
			kind: "policy-decision",
			network: "stellar:testnet",
			amount: String(Math.round(o.amountXlm * 10_000_000)),
			asset: v.tokenContract,
			payee: o.wallet.publicKey,
			detail: {
				allowed: false,
				rule: isCapRefusal
					? "vault spending-limit (on-chain)"
					: "vault draw failed (unclassified — not a chain refusal)",
				vault: v.contractId,
				reason: refusal.slice(0, 200),
			},
		});
		return { ok: false, refusal };
	}
	record({
		kind: "vault-draw",
		network: "stellar:testnet",
		amount: String(Math.round(o.amountXlm * 10_000_000)),
		asset: v.tokenContract,
		payer: v.contractId,
		payee: o.wallet.publicKey,
		tx: res.hash ?? null,
		detail: { vault: v.contractId },
	});
	return { ok: true, hash: res.hash };
}

/** Vault state: config + the contract's token balance (RPC read). */
export async function vaultStatus(o: { wallet: Wallet }): Promise<{
	vault: string;
	capStroops: string;
	periodLedgers: number;
	agent: string;
	balanceStroops: string;
}> {
	const v = getVault();
	if (!v)
		throw new Error("no vault — create one first: vault create --cap-xlm N");
	const {
		rpc,
		TransactionBuilder,
		BASE_FEE,
		Networks,
		Contract,
		Address,
		scValToNative,
	} = await import("@stellar/stellar-sdk");
	const s = new rpc.Server(CFG.rpcUrl);
	const acct = await s.getAccount(o.wallet.publicKey);
	const tx = new TransactionBuilder(acct, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			new Contract(v.tokenContract).call(
				"balance",
				Address.fromString(v.contractId).toScVal(),
			),
		)
		.setTimeout(30)
		.build();
	const sim = await s.simulateTransaction(tx);
	let balance = 0n;
	if (!rpc.Api.isSimulationError(sim) && sim.result?.retval)
		balance = BigInt(scValToNative(sim.result.retval) as bigint);
	return {
		vault: v.contractId,
		capStroops: v.capStroops,
		periodLedgers: v.periodLedgers,
		agent: v.agentPublicKey,
		balanceStroops: balance.toString(),
	};
}

export { getVault } from "./session-store.js";
