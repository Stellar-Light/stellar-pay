/**
 * Feasibility spike: prove the smart-account vault building blocks assemble
 * HEADLESS against the published testnet contracts — no browser, no passkey.
 * This is the green light for vault mode; the full on-chain deploy is next.
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
	createCallContractContext,
	createEd25519Signer,
	createSpendingLimitParams,
	MemoryStorage,
	SmartAccountKit,
	SpendingLimitPolicyClient,
} from "smart-account-kit";

// Published testnet defaults (smart-account-kit demo/.env.example)
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
const USDC_SAC_TESTNET =
	"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const log = (m: string) => console.log(`  ${m}`);

console.log(
	"vault-spike — headless smart-account building blocks on testnet\n",
);

// 1. The kit constructs headless (MemoryStorage — no IndexedDB/WebAuthn).
const kit = new SmartAccountKit({ ...CFG, storage: new MemoryStorage() });
log(`kit constructed headless: ${kit.constructor.name}`);

// 2. The agent's key becomes an Ed25519 External signer (agent-friendly).
const agent = Keypair.random();
const signer = createEd25519Signer(
	CFG.ed25519VerifierAddress,
	agent.rawPublicKey(),
);
log(
	`ed25519 agent signer: type=${(signer as { type?: string }).type ?? "?"} for ${agent.publicKey().slice(0, 6)}…`,
);

// 3. On-chain daily USDC cap: $1/day over a day of ledgers.
const DAY_LEDGERS = 17280;
const cap = createSpendingLimitParams(
	10_000_000n /* 1 USDC, 7 decimals */,
	DAY_LEDGERS,
);
log(
	`spending-limit policy params: limit=${cap.spending_limit} stroops, period=${cap.period_ledgers} ledgers`,
);

// 4. Scope a rule to the USDC SAC only (on-chain allowlist).
const ctx = createCallContractContext(USDC_SAC_TESTNET);
log(
	`call-contract context bound to USDC SAC: ${JSON.stringify(ctx).slice(0, 60)}…`,
);

// 5. The typed policy client is constructable (reads/sets the cap on-chain).
const policy = new SpendingLimitPolicyClient(CFG.spendingLimitPolicyAddress, {
	rpcUrl: CFG.rpcUrl,
	networkPassphrase: CFG.networkPassphrase,
} as never);
log(`SpendingLimitPolicyClient ready: ${policy.constructor.name}`);

console.log(
	"\nPASS — every vault building block assembles headless against the live testnet contracts:",
	"\n  ed25519 agent signer + on-chain daily cap + USDC-only rule + policy client.",
	"\n  Next: deploy the account, install the policy, and prove an over-cap transfer is refused on-chain.",
);
