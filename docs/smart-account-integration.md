# Smart-account vault — integration notes

**Framing (important): stellar-pay is a CLI + MCP that runs in the user's own
environment. We never deploy or custody anything. The user provisions their
own smart-account vault once — in their browser, with their own passkey, the
normal way anyone makes a wallet — and our tool *consumes* it: the agent signs
with the ed25519 key the user scoped to that vault, and every payment is capped
on-chain. So the two "caveats" split cleanly:**

| Caveat | Whose problem | Status |
|--------|---------------|--------|
| Headless deploy needs a browser passkey | **the user's**, once, at setup — not ours | not a blocker; it's normal wallet setup |
| The kit is unaudited | the user's risk call | a disclosure, not our bug |
| Pay a 402 *from* the vault (contract-account auth) | **ours** — the client fix | designed below; **not yet built** — needs a provisioned vault |

Everything below is the *ours* row: what stellar-pay builds so an agent can use
a vault the user already set up.

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

`@x402/stellar`'s `ExactStellarScheme` takes any `ClientStellarSigner`
(`{ address, signAuthEntry, signTransaction? }`), which *looks* like an exact
plug point. It is not, and this doc used to claim otherwise. `signAuthEntry`
(SEP-43) returns raw signature bytes that stellar-base's `authorizeEntry` then
re-wraps in the classic `{public_key, signature}` credential — after calling
`Keypair.fromPublicKey()` on the address, which rejects a `C…` account. A
smart-account payer needs to hand the scheme a *fully built* authorization
entry (or an `authorizeEntry` override), and `ExactStellarScheme` exposes no
such hook. So the adapter needs an upstream client change first; until it
lands, this path means patching the scheme, not plugging into it.

The facilitator, on the other hand, needs nothing: the reference
implementation already verifies and settles address-agnostically (any
non-void signature, enforcing re-simulation). It should still be *proved*
against a real `C…` payer before we rely on it — that is a conformance probe,
not a change request.

**Status:** designed, not yet built — it needs (a) the upstream client hook
above and (b) a deployed smart account to test end to end (see caveat 2).
We are asking `coinbase/x402` for (a); it cannot land before that.

## The setup step is the user's, in a browser (not a blocker for us)

`buildDeployTransaction(deps, credentialId, publicKey, policies)` hardcodes the
**WebAuthn verifier** and takes a passkey credential id + secp256r1 public key.
Every smart account is therefore born with a **passkey at its root**; ed25519
(agent) signers are strictly *secondary*, added later by a passkey-authorized
transaction. `createWallet` is passkey-first for the same reason (it takes
WebAuthn `authenticatorSelection` and calls `navigator.credentials`).

There is no headless creation path — the root of trust is always a WebAuthn
passkey, which needs a browser. That is exactly right for a wallet: the human
owner provisions it. **We don't deploy anything; we consume a vault the user
made.** So this never blocks stellar-pay — it's the user's one-time setup, the
same as creating any wallet.

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
