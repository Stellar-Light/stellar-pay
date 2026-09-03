/**
 * The vault as an x402 PAYER — the smart-account contract pays a 402 invoice
 * directly, so the payment sits behind the SAME on-chain spending cap
 * `drawFromVault` proves, instead of only the float drawn off of it
 * (docs/ECOSYSTEM-ASKS.md §2.3: "vault→float… works, and it is strictly
 * weaker: income credited directly to that classic key is spendable without
 * the cap ever being consulted").
 *
 * This mirrors @x402/stellar's own `ExactStellarScheme.createPaymentPayload`
 * (exact/client/scheme.ts) line for line: same SEP-41 `transfer` call on the
 * asset SAC, same build → simulate → sign → re-simulate shape, same
 * `{x402Version, payload:{transaction}}` return — so a facilitator that
 * accepts their payload accepts this one unchanged (verified against the
 * REAL upstream facilitator in src/sandbox/vault-x402-test.ts, not a
 * reimplementation of it). The one substitution is the payer: `from` is the
 * vault CONTRACT, and the auth entry is signed via vault.ts's
 * `vaultAgentAuthorizer` instead of a classic keypair's `signAuthEntry`.
 *
 * @x402/stellar's own client cannot do this itself: `ExactStellarScheme`
 * calls `tx.signAuthEntries({ signAuthEntry })` with no `authorizeEntry`
 * override exposed, so a `C…` payer has no way in through it — that is the
 * gap ECOSYSTEM-ASKS.md §2.3 names, and the reason this file exists instead
 * of just handing their class a different signer.
 *
 * TESTNET ONLY, same as the rest of the vault.
 */
import {
	getEstimatedLedgerCloseTimeSeconds,
	handleSimulationResult,
	isStellarNetwork,
	validateStellarAssetAddress,
	validateStellarDestinationAddress,
} from "@x402/stellar";
import { decodeContractError } from "smart-account-kit";
import { record } from "./receipts.js";
import { vaultAgentAuthorizer } from "./vault.js";
import type { Wallet } from "./wallet.js";

/** Same shape as @x402/core's PaymentRequirements — declared locally so this
 * file does not take a dependency on @x402/core's types just to name them. */
export type StellarPaymentRequirements = {
	scheme: string;
	/** CAIP-2, e.g. "stellar:testnet" — matches @x402/core's own Network type. */
	network: `${string}:${string}`;
	asset: string;
	amount: string;
	payTo: string;
	maxTimeoutSeconds: number;
	extra: Record<string, unknown>;
};

export type StellarExactSchemeLike = {
	scheme: "exact";
	createPaymentPayload: (
		x402Version: number,
		paymentRequirements: StellarPaymentRequirements,
	) => Promise<{ x402Version: number; payload: { transaction: string } }>;
};

/**
 * A drop-in x402 client scheme — same shape @x402/stellar's ExactStellarScheme
 * has (see curl.ts's existing `.register(network, new ExactStellarScheme(...))`)
 * — whose payer is the vault contract instead of `wallet`'s own classic key.
 *
 * Only a chain-level refusal (the spending-limit policy rejecting the signed
 * entry during re-simulation) is receipted as a policy decision. A build
 * error before any real signature exists — bad args, no on-chain rule for
 * this asset, an RPC hiccup — is not a policy decision and is thrown straight
 * through uncaptured, exactly like @x402/stellar's own client does for every
 * other failure (it records nothing either; curl.ts's callers record the
 * payment on success, never the client itself).
 */
export function createVaultExactStellarScheme(
	wallet: Wallet,
): StellarExactSchemeLike {
	return {
		scheme: "exact",
		async createPaymentPayload(x402Version, pr) {
			if (pr.scheme !== "exact")
				throw new Error(`Unsupported scheme: ${pr.scheme}`);
			if (!isStellarNetwork(pr.network))
				throw new Error(`Unsupported Stellar network: ${pr.network}`);
			if (
				typeof pr.amount !== "string" ||
				!Number.isInteger(Number(pr.amount)) ||
				Number(pr.amount) <= 0
			)
				throw new Error(
					`Invalid amount: ${pr.amount}. Amount must be a positive integer.`,
				);
			if (!validateStellarDestinationAddress(pr.payTo))
				throw new Error(`Invalid Stellar destination address: ${pr.payTo}`);
			if (!validateStellarAssetAddress(pr.asset))
				throw new Error(`Invalid Stellar asset address: ${pr.asset}`);
			if (!pr.extra?.areFeesSponsored)
				throw new Error("Exact scheme requires areFeesSponsored to be true");

			// Resolves the on-chain context rule for THIS asset and builds the
			// authorizeEntry override — throws if this vault was never given a
			// cap on `pr.asset` (see vaultAgentAuthorizer's own error).
			const agent = await vaultAgentAuthorizer(wallet, pr.asset);
			const { contract, nativeToScVal, rpc } = await import(
				"@stellar/stellar-sdk"
			);
			const rpcServer = new rpc.Server(agent.rpcUrl);
			const latestLedger = await rpcServer.getLatestLedger();
			const estimatedLedgerSeconds = await getEstimatedLedgerCloseTimeSeconds(
				pr.network,
			);
			const maxLedger =
				latestLedger.sequence +
				Math.ceil(pr.maxTimeoutSeconds / estimatedLedgerSeconds);

			const tx = await contract.AssembledTransaction.build({
				contractId: pr.asset,
				method: "transfer",
				args: [
					// SEP-41: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md#interface
					nativeToScVal(agent.vault, { type: "address" }), // from — the VAULT
					nativeToScVal(pr.payTo, { type: "address" }), // to
					nativeToScVal(BigInt(pr.amount), { type: "i128" }), // amount
				],
				networkPassphrase: agent.networkPassphrase,
				rpcUrl: agent.rpcUrl,
				parseResultXdr: (result: unknown) => result,
			});
			handleSimulationResult(tx.simulation);

			let missingSigners = tx.needsNonInvokerSigningBy();
			if (!missingSigners.includes(agent.vault) || missingSigners.length > 1)
				throw new Error(
					`Expected to sign with [${agent.vault}], but got [${missingSigners.join(", ")}]`,
				);

			await tx.signAuthEntries({
				address: agent.vault,
				authorizeEntry: agent.authorizeEntry,
				expiration: maxLedger,
			});

			try {
				await tx.simulate();
				handleSimulationResult(tx.simulation);
			} catch (e) {
				// Only a real cap refusal is a POLICY decision; a network/RPC
				// failure receipted as "spending-limit" would be the ledger lying
				// about what the chain decided (same rule as vault.ts's
				// drawFromVault — see its own comment on this exact distinction).
				//
				// @x402/stellar's own handleSimulationResult throws the RAW
				// simulation diagnostic (a multi-line HostError event dump), not
				// the friendly decoded string kit.multiSigners produces — a plain
				// /spending limit|exceed/i match on that raw text misses it
				// (verified: it reads "Error(Auth, InvalidAction)" at the top,
				// with the actual "Error(Contract, #3221)" buried in the trace).
				// decodeContractError scans for that marker specifically and maps
				// it through the SAME registry drawFromVault's path benefits from,
				// so classification is reliable regardless of which shape the
				// error arrives in.
				const msg = (e as Error).message ?? String(e);
				const decoded = decodeContractError(e);
				const isCapRefusal =
					decoded?.family === "SpendingLimit" ||
					/spending limit|exceed/i.test(msg);
				record({
					kind: "policy-decision",
					network: "stellar:testnet",
					amount: pr.amount,
					asset: pr.asset,
					payee: pr.payTo,
					detail: {
						allowed: false,
						rule: isCapRefusal
							? "vault spending-limit (on-chain)"
							: "vault payment build failed (unclassified — not a chain refusal)",
						vault: agent.vault,
						reason: (decoded?.message ?? msg).slice(0, 200),
					},
				});
				throw e;
			}

			missingSigners = tx.needsNonInvokerSigningBy();
			if (missingSigners.length > 0)
				throw new Error(
					`unexpected signer(s) required: [${missingSigners.join(", ")}]`,
				);
			if (!tx.built)
				throw new Error("vault payment: transaction was not built");

			return { x402Version, payload: { transaction: tx.built.toXDR() } };
		},
	};
}
