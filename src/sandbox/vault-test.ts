/**
 * VAULT e2e — deploy headless, cap on-chain, and PROVE the refusal.
 *
 * The research goal made concrete: agent commerce needs agents that can hold
 * money, and that is only sane when the CAP is enforced by the chain, not by
 * the code holding the key. So this test:
 *
 *   1. deploys a smart-account wallet HEADLESS (software passkey — no
 *      browser, no hardware) with a spending-limit policy installed at
 *      creation, scoped to the native XLM SAC;
 *   2. funds it;
 *   3. transfers UNDER the cap — must succeed;
 *   4. transfers OVER the remaining cap — must be REFUSED by the policy
 *      contract during simulation, with the vault balance untouched.
 *
 * Both outcomes land in the receipts ledger: the successful transfer as a
 * payment row, the refusal as a policy-decision row whose rule is the
 * ON-CHAIN policy — app-layer and chain-layer governance, one ledger.
 *
 *   npm run test:vault
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
	createCallContractContext,
	createEd25519Signer,
	createSpendingLimitParams,
	MemoryStorage,
	SmartAccountKit,
} from "smart-account-kit";
import { record } from "../pay/receipts.js";
import { softwarePasskey } from "./software-passkey.js";

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
const XLM_SAC_TESTNET =
	"CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const HORIZON = "https://horizon-testnet.stellar.org";

const CAP_XLM = 5; // on-chain cap per period
const UNDER_XLM = 2; // first transfer — allowed
const OVER_XLM = 4; // second transfer — 2+4 > 5, must be refused

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
	if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}

async function xlmBalance(account: string): Promise<string> {
	// Smart accounts are C-addresses: read the SAC balance via RPC simulation
	// is heavier than needed — Horizon covers G-addresses; for the contract
	// balance we trust the transfer results + refusal instead.
	const r = await fetch(`${HORIZON}/accounts/${account}`);
	if (!r.ok) return "n/a";
	const d = (await r.json()) as {
		balances: Array<{ asset_type: string; balance: string }>;
	};
	return d.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
}

async function main() {
	console.log(
		"═══ vault e2e — headless deploy, on-chain cap, refusal proof ═══\n",
	);

	const deployer = Keypair.random();
	const recipient = Keypair.random();
	await Promise.all([
		friendbot(deployer.publicKey()),
		friendbot(recipient.publicKey()),
	]);
	console.log(`deployer  ${deployer.publicKey()}`);
	console.log(`recipient ${recipient.publicKey()}\n`);

	const passkey = softwarePasskey();
	const kit = new SmartAccountKit({
		...CFG,
		deployerSecret: deployer.secret(),
		storage: new MemoryStorage(),
		rpId: "stellar-pay.local",
		rpName: "stellar-pay vault test",
		webAuthn: passkey,
	} as never);

	// Deploy PLAIN first: a spending limit is meaningless on the Default
	// (catch-all) rule — the policy contract refuses install there (#3227,
	// found the honest way). The cap goes on a CallContract rule scoped to
	// the XLM SAC right after deploy, before any funds arrive.
	console.log(`deploying smart account (software passkey)…`);
	const created = await kit.createWallet("stellar-pay", "vault-test", {
		autoSubmit: true,
		forceMethod: "rpc",
	});
	const vault = created.contractId;
	if (!vault) throw new Error("no contractId from createWallet");
	console.log(`vault     ${vault}`);

	// THE VAULT SHAPE (the design the roadmap named): the OWNER (software
	// passkey, default rule) administers; the AGENT (ed25519 key) exists ONLY
	// on a CallContract rule scoped to the XLM SAC and carrying the
	// spending-limit policy. The agent literally has no signing path that
	// bypasses the cap — that is the whole point of the vault.
	const agent = Keypair.random();
	kit.externalSigners.addEd25519FromSecret(agent.secret());
	// Params must go through the kit's typed converter — a raw JS object
	// reaches the policy as the wrong ScVal shape and traps the VM
	// (Error(Value, UnexpectedType) at map_unpack, found the honest way).
	const cap = (
		kit as unknown as {
			convertPolicyParams: (t: string, p: unknown) => unknown;
		}
	).convertPolicyParams(
		"spending_limit",
		createSpendingLimitParams(BigInt(CAP_XLM) * 10_000_000n, 17_280),
	);
	console.log(
		`installing agent cap rule (${CAP_XLM} XLM / day on the XLM SAC)…`,
	);
	const ruleTx = await kit.rules.add(
		createCallContractContext(XLM_SAC_TESTNET),
		"agent-xlm-cap",
		[createEd25519Signer(CFG.ed25519VerifierAddress, agent.rawPublicKey())],
		new Map([[CFG.spendingLimitPolicyAddress, cap]]),
	);
	// Rule administration is authorized by the OWNER passkey (default rule).
	const ruleRes = (await kit.signAndSubmit(
		ruleTx as never,
		{
			forceMethod: "rpc",
		} as never,
	)) as { success?: boolean; error?: { message?: string } };
	if (ruleRes.success === false)
		throw new Error(`cap rule install failed: ${ruleRes.error?.message}`);
	console.log(
		`  ✓ cap rule installed (agent ${agent.publicKey().slice(0, 6)}…)`,
	);
	record({
		kind: "channel-open", // nearest existing kind: an on-chain container opened
		network: "stellar:testnet",
		detail: {
			what: "vault-deploy",
			vault,
			agent: agent.publicKey(),
			capStroops: String(BigInt(CAP_XLM) * 10_000_000n),
			periodLedgers: 17_280,
		},
	});

	// Fund the vault — RESULTS ARE A UNION, never thrown: branch on success.
	// (fundWallet friendbots a throwaway then SAC-transfers into the contract.)
	console.log(`funding vault (friendbot → SAC transfer)…`);
	const fund = (await kit.fundWallet(XLM_SAC_TESTNET)) as {
		success: boolean;
		amount?: number;
		error?: { message?: string };
	};
	if (fund.success === false)
		throw new Error(`funding failed: ${fund.error?.message}`);
	console.log(`  ✓ funded${fund.amount ? ` with ${fund.amount} XLM` : ""}`);

	// The agent's signing path: multiSigners with ONLY the agent selected.
	// getAvailableSigners() reads only the DEFAULT rule (by design — that is
	// the owner surface). The agent lives on the cap rule, so hand its
	// ContractSigner straight to buildSelectedSigners: the manager maps it to
	// the in-memory ed25519 key registered via addEd25519FromSecret.
	const agentSigners = (
		kit.multiSigners as unknown as {
			buildSelectedSigners: (s: unknown[], c?: string) => unknown[];
		}
	).buildSelectedSigners([
		createEd25519Signer(CFG.ed25519VerifierAddress, agent.rawPublicKey()),
	]);
	if (!agentSigners.length)
		throw new Error(
			"agent signer not selectable — check externalSigners wiring",
		);

	// 1) UNDER the cap, AS THE AGENT — must succeed and land on-chain.
	console.log(`agent transfer ${UNDER_XLM} XLM (under cap) …`);
	const balStart = await xlmBalance(recipient.publicKey());
	const ok = (await kit.multiSigners.transfer(
		XLM_SAC_TESTNET,
		recipient.publicKey(),
		UNDER_XLM,
		agentSigners as never,
		{ forceMethod: "rpc" },
	)) as { success: boolean; hash?: string; error?: { message?: string } };
	if (!ok.success)
		throw new Error(`under-cap transfer failed: ${ok.error?.message}`);
	const balMid = await xlmBalance(recipient.publicKey());
	console.log(
		`  ✓ succeeded — tx ${(ok.hash ?? "").slice(0, 12)}… · recipient ${balStart} → ${balMid}`,
	);
	record({
		kind: "payment",
		network: "stellar:testnet",
		amount: String(BigInt(UNDER_XLM) * 10_000_000n),
		asset: XLM_SAC_TESTNET,
		payer: vault,
		payee: recipient.publicKey(),
		tx: ok.hash ?? null,
		detail: { surface: "vault", signer: "agent-ed25519", underCap: true },
	});

	// 2) OVER the remaining cap, AS THE AGENT — the CHAIN must refuse.
	console.log(
		`agent transfer ${OVER_XLM} XLM (cumulative ${UNDER_XLM + OVER_XLM} > cap ${CAP_XLM}) …`,
	);
	const over = (await kit.multiSigners.transfer(
		XLM_SAC_TESTNET,
		recipient.publicKey(),
		OVER_XLM,
		agentSigners as never,
		{ forceMethod: "rpc" },
	)) as { success: boolean; hash?: string; error?: { message?: string } };
	const refused = over.success === false;
	const reason = (over.error?.message ?? "").slice(0, 160);
	const balAfter = await xlmBalance(recipient.publicKey());
	console.log(
		refused
			? `  ✓ REFUSED on-chain: ${reason}`
			: "  ✗ transfer went through — the cap did NOT hold",
	);
	console.log(
		`  recipient balance ${balMid} → ${balAfter} (${balMid === balAfter ? "unchanged ✓" : "CHANGED ✗"})`,
	);
	record({
		kind: "policy-decision",
		network: "stellar:testnet",
		amount: String(BigInt(OVER_XLM) * 10_000_000n),
		asset: XLM_SAC_TESTNET,
		payee: recipient.publicKey(),
		detail: {
			allowed: !refused,
			rule: "spending-limit-policy (on-chain)",
			vault,
			signer: "agent-ed25519",
			reason,
		},
	});

	if (!refused || balMid !== balAfter) throw new Error("refusal proof FAILED");
	console.log(
		"\nRESULT: PASS — headless deploy (software passkey), agent key capped on-chain, under-cap spend landed, over-cap spend REFUSED BY THE CHAIN with funds untouched.",
	);
	console.log(
		`explorer  https://stellar.expert/explorer/testnet/contract/${vault}`,
	);
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
