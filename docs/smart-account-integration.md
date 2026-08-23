# Smart-account vault — integration notes

Findings from reading `@x402/stellar` and `stellar/smart-account-kit`, and how
to close the two caveats.

## Caveat 1 — paying a 402 *from* a smart account. **Fixable, client-side.**

`@x402/stellar` doesn't hardcode a classic key. Its client is built on the
Stellar SDK's standard **`SignAuthEntry`** hook
(`@stellar/stellar-sdk/contract`) — a pluggable callback that signs a Soroban
authorization entry. `createEd25519Signer` is just the built-in implementation
for a classic key.

So the fix is an **adapter**, not a fork: implement `SignAuthEntry` so that,
for a transfer whose `from` is the smart account (C-address), it produces the
smart-account authorization instead of a classic ed25519 signature.

```
x402 client
  → SAC transfer, from = smart account (C…)
  → SignAuthEntry(entry):
        digest = computeEntryAuthDigest(entry)          // exported by the kit
        sig    = agentEd25519.sign(digest)              // the agent's key
        assemble the SorobanAuthorizationEntry the OZ __check_auth expects
  → facilitator submits
  → on settle: __check_auth runs → spending-limit policy checks the amount
```

`computeEntryAuthDigest` and `Ed25519Signer` are both exported from
`smart-account-kit`, so the adapter is a small bridge we own. The facilitator
only has to submit the transaction as-is (it already does verify+settle
address-agnostically); a facilitator that assumes classic G-address payers is
the one external dependency, and mpp-router / a self-hosted OZ Channels
facilitator can be checked against a real C-address payer.

**Status:** designed, not yet built — it needs a deployed smart account to
test end to end (see caveat 2), so it lands with the vault, not before.

## Caveat 2 — headless deploy. **Blocked by the kit's trust model, by design.**

`buildDeployTransaction(deps, credentialId, publicKey, policies)` hardcodes the
**WebAuthn verifier** and takes a passkey credential id + secp256r1 public key.
Every smart account is therefore born with a **passkey at its root**; ed25519
(agent) signers are strictly *secondary*, added later by a passkey-authorized
transaction. `createWallet` is passkey-first for the same reason (it takes
WebAuthn `authenticatorSelection` and calls `navigator.credentials`).

There is **no headless creation path** — the root of trust is always a
WebAuthn passkey, which needs a browser. This is a deliberate security choice,
not a missing feature.

### The vault flow that actually works

Creation is a one-time human step; the agent then runs headless:

1. **Owner, in a browser (once):** create the smart account with their passkey;
   add the agent's **ed25519 signer** under a context rule scoped to the USDC
   SAC (`createCallContractContext`) with a **daily spending-limit policy**
   (`createSpendingLimitParams`). Fund the account with USDC.
2. **Agent, headless (ongoing):** signs with its ed25519 key. Every payment
   flows through `__check_auth` → the spending-limit policy caps it on-chain. A
   compromised agent key still cannot exceed the daily cap or touch a
   non-USDC contract.
3. **Paying 402s:** the SignAuthEntry adapter (caveat 1) lets the agent pay
   x402/MPP 402s directly from the vault; or, until a facilitator is confirmed
   to accept a C-address payer, the vault tops up a small **hot classic key**
   the client uses for 402s (bulk funds stay capped on-chain).

This is a sound model — the owner provisions the vault and its limits once,
the agent operates within them forever — but it means the on-chain
over-cap-refusal proof requires that one browser step; it cannot be produced
headlessly in CI/Node.

### Worth raising with SDF / OZ

A headless-friendly path — deploy with an **ed25519 initial signer** (an
Ed25519-verifier root instead of WebAuthn) — would let an agent provision its
own capped vault with no browser. That is the single change that would make
agent vaults fully self-serve. Good SCF / ecosystem-feedback item.
