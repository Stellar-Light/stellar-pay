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
| Pay a 402 *from* the vault (contract-account auth) | **ours** — the client fix | **built** — `curl --from-vault` / MCP `curl{from_vault:true}`; proven on testnet with real tx hashes (`test:vault-x402`). One remaining gap, and it is upstream, not ours: the reference facilitator's own event validation, see below |

Everything below is the *ours* row: what stellar-pay builds so an agent can use
a vault the user already set up.

## Caveat 1 — paying a 402 *from* a smart account. **Built.**

`@x402/stellar`'s `ExactStellarScheme` takes any `ClientStellarSigner`
(`{ address, signAuthEntry, signTransaction? }`), which *looks* like the plug
point. It is not, and this doc used to say the fix needed an upstream client
change before it could land. It doesn't: `signAuthEntry` (SEP-43) returns raw
signature bytes that stellar-base's `authorizeEntry` then re-wraps in the
classic `{public_key, signature}` credential — after calling
`Keypair.fromPublicKey()` on the address, which rejects a `C…` account. No
`ClientStellarSigner` can route around that; the wrapping happens
unconditionally, regardless of what the callback returns.

The actual plug point is one level down, and it was already there:
`@stellar/stellar-sdk`'s own `AssembledTransaction#signAuthEntries` accepts an
`authorizeEntry` **override** — a full replacement of the signing algorithm,
not the `signAuthEntry` callback. So the fix wasn't an upstream `@x402/stellar`
change; it was a from-scratch reimplementation of
`ExactStellarScheme.createPaymentPayload` (mirroring it line for line — same
SEP-41 `transfer` call, same build → simulate → sign → re-simulate shape,
same `{x402Version, payload:{transaction}}` return) that calls
`signAuthEntries({ authorizeEntry })` instead of `{ signAuthEntry }`:

```
our scheme (src/pay/vault-x402.ts)
  → SAC transfer, from = smart account (C…)
  → tx.signAuthEntries({ authorizeEntry: ourOverride }):
        ourOverride delegates to the SDK's OWN authorizeEntry, supplying only
        the signature:
          digest = computeEntryAuthDigest(entry, contextRuleId)  // kit, public
          sig    = agentEd25519.signAuthDigest(digest)           // the agent's key
          return { signatureScVal: <OZ AuthPayload ScVal> }      // skips the
                                                                  // classic path entirely
  → facilitator submits
  → on settle: __check_auth runs → spending-limit policy checks the amount
```

`kit.signAuthEntry` (the kit's own single-entry signer) is deliberately not
used for this — it is passkey/WebAuthn-only, i.e. it signs as the OWNER,
whose rule carries no spending limit. The agent's capped ed25519 path instead
goes through the kit's public `Ed25519Signer` + `computeEntryAuthDigest` +
`signerToScVal` directly (see `vaultAgentAuthorizer` in `src/pay/vault.ts`).

The facilitator needed nothing on the address-agnosticism front — confirmed:
the reference implementation verifies and settles address-agnostically (any
non-void signature, enforcing re-simulation) — but proving this end to end
(`test:vault-x402`) surfaced a **separate, independent** facilitator-side
limitation: its `validateSimulationEvents()` assumes a settlement simulation
emits exactly one "contract"-type event (the transfer) and rejects on the
first contract event that doesn't match that shape. A capped smart-account
payer's authorization emits its own `spending_limit_enforced` event from the
policy contract ahead of the transfer event, so the reference facilitator,
unmodified, currently cannot settle a capped vault payment — see
`docs/ECOSYSTEM-ASKS.md` §2.3 for the full writeup and the upstream ask.
`test:vault-x402` settles the identical payload directly (rebuild envelope,
real fee-payer, same auth entries) to prove the payload itself is valid and
chain-accepted independent of that bug.

**Status:** built and proven on testnet with real transaction hashes
(`curl --from-vault`, MCP `curl{from_vault:true}`, `test:vault-x402`). No
upstream `@x402/stellar` client change was needed. What remains is upstream,
on the facilitator side (previous paragraph) — not a blocker for us, since we
settle directly, but real for anyone relying on the reference facilitator
unmodified.

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
3. **Paying 402s:** the agent can pay an x402 402 directly from the vault
   (caveat 1 — `curl --from-vault`), same on-chain cap either way; or draw a
   small float to its own classic key first and pay from that (`vault draw`).
   MPP has no equivalent yet — the vault has no MPP signer, so an MPP 402
   still goes through the classic key.

This is a sound model — the owner provisions the vault and its limits once,
the agent operates within them forever — but it means the on-chain
over-cap-refusal proof requires that one browser step; it cannot be produced
headlessly in CI/Node.

### Worth raising with SDF / OZ

A headless-friendly path — deploy with an **ed25519 initial signer** (an
Ed25519-verifier root instead of WebAuthn) — would let an agent provision its
own capped vault with no browser. That is the single change that would make
agent vaults fully self-serve. Good SCF / ecosystem-feedback item.
