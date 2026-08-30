# The spine — what stellar-pay is, and what every piece is for

Companion to [ROADMAP.md](./ROADMAP.md) (what's next) and [PARITY.md](../PARITY.md)
(how we compare to pay.sh). This is the one document that says what the whole
thing IS, so a new build either serves the loop below or it doesn't ship.

## One sentence

**stellar-pay is the neutral, self-custody toolkit for human-to-agent work on
Stellar** — one CLI/MCP where you fund an agent safely, hire it for real work
under an escrowed agreement, get that work verified and paid automatically,
and carry provable reputation from what it completed.

## The thesis (why this and not "a payments CLI")

Before agent-to-agent commerce goes mainstream, **human-to-agent commerce is
the wedge**: people will pay agents to do real work. The layer that decides
whether that works is not payment alone — it is **payments + reputation +
task-verification-tied-to-agreements + fulfillment**. Payment is table stakes
(Circle, Merit, pay.sh all have it). The differentiated, defensible layer — the
one nobody else has on Stellar — is the **work layer**: escrow + agreement +
automated resolution + portable work-reputation.

We build that layer **neutrally and self-custody**: the agent holds its own
keys, we take no fee, we consume every rails provider. That is the deliberate
opposite of the platform pole (Circle Agents is custodial + hosted; we are the
client + the coordination layer they explicitly refuse to build — "ranking is
not adjudication; a discovery layer never holds funds").

## The loop (every feature is one beat of this)

```
   fund ───────► hire ───────► verify ───────► pay ───────► reputation
  (vault)       (job open      (resolver       (release/     (receipts →
                 + escrow +     reads terms     refund on-     per-agent
                 agreement)     + evidence,     chain)         work record)
                                judges)                            │
                                                                   ▼
                                                        who to hire next time
```

A human (or an agent) funds a capped vault, hires an agent under an escrowed
agreement whose terms live on-chain, the resolver verifies the delivered work
against those terms and releases or refunds automatically, and the outcome
becomes a costly-to-fake reputation signal that informs the next hire.

## What each piece is FOR (flagship vs supporting cast)

**Flagship — the work layer (ours alone on Stellar):**

| piece | file(s) | role in the loop |
|---|---|---|
| **Agreement** | `pay/agreement.ts` | the terms: a resolver-readable doc (Terms / Review Question / Allowed Evidence / Resolution Effects), sha256-addressed, pinned on-chain. Stellar-native; AutoContracts is credited prior art, not a standard we emit. |
| **Escrow rails** | `pay/rails.ts` + `pay/rails-trustless-work.ts` | hold-verify-release mechanics. A **swappable adapter** — Trustless Work today; MPP-native or Alkahest-on-Stellar tomorrow is a new file + `setRails()`, never a rewrite. |
| **Job lifecycle** | `pay/job.ts` | open → fund → deliver → approve → release / dispute → resolve, each step a ref-chained receipt. |
| **Resolver** | `pay/resolver.ts` | the "auto service" that fills the escrow's resolver *role*: reads terms + evidence, answers the review question via a policy (hash-match = deterministic; callback = delegated judge, honest about its strength), executes the outcome. |
| **Reputation** *(next)* | `pay/reputation.ts` | aggregates work-outcomes into a per-agent record — release/refund rates, each claim backed by an on-chain tx. Costly-to-fake because the evidence is escrow-judged money movement, not self-declared feedback. Nulucre (wallet creditworthiness) composes as one *sidecar* signal, never the spine. |

**Supporting cast — table stakes that make the flagship usable:**

| piece | file(s) | why it's here |
|---|---|---|
| Pay a 402 | `pay/curl.ts`, `pay/offers.ts` | the agent pays for its own inputs (APIs, data, inference). x402 + MPP. |
| Session mode | `pay/session.ts` | high-frequency paying via one-way channels — a busy agent loop. |
| Vault | `sandbox/vault-*`, smart-account-kit | fund an agent **safely**: on-chain spend caps a compromised key can't exceed. This is "fund" in the loop. |
| Wallet / keystore | `pay/wallet.ts`, `pay/keystore.ts` | self-custody keys, OS-keychain sealed. |
| Governance | `pay/policy.ts`, `pay/governed.ts` + vendored Scrimp | per-host spend rules + outcome-attributed budget. |
| Receipts | `pay/receipts.ts` | the substrate under BOTH pay and work: content-addressed, tamper-checked, on-chain-verifiable. Reputation reads these. |
| MCP | `mcp.ts` | every verb as an agent tool — the primary consumer is an agent, not a human at a shell. |

## The quality bar (Circle + Merit, made concrete)

1. **Costly-to-fake, and describe ≠ adjudicate.** Reputation is grounded in
   escrow-judged outcomes (real money moved through a resolver's decision),
   never self-declared feedback or raw payment volume. The resolver
   *adjudicates and holds funds*; reputation only *describes*. Keep them
   separate layers.
2. **One sharp, adoptable primitive over a sprawling toolkit.** Merit's `echo`
   is one thing people install. The work layer is our `echo`: package it so a
   builder drops it in (CLI verbs + MCP tools + a clean SDK surface), not a
   pile of features.
3. **Neutral and self-custody, always.** No fee, no custody, every rails
   provider consumable. The moment we take a cut or hold keys we are just a
   smaller Circle.
4. **Every non-trivial step proven on testnet, end to end, with an on-chain
   check.** Not "it compiles" — a receipt whose tx a stranger can verify.

## What this doc forbids

- Building payment features as if payments were the product. They're the floor.
- Reputation from self-declared or volume signals (Circle's explicit trap).
- Coupling to one rails provider. The adapter boundary is load-bearing.
- Taking a fee or custody. That trades the whole position away.

## Status (2026-08-30)

Flagship: agreement ✓, escrow rails ✓ (TW adapter, testnet), job lifecycle ✓,
resolver ✓ (both outcomes proven on testnet). **Reputation: not yet** — the
last flagship pillar. Supporting cast: pay/session/vault/receipts/MCP all
built and testnet-proven. Mainnet gated on the escrow contract's audit
(the standing SDF ask). Nothing published; all local until the owner ships.
