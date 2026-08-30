# What we cannot build, why, and what would unblock it

Most of stellar-pay's remaining gaps are ours to fix. This document is about
the ones that **are not** — where the blocker sits in a contract we did not
write, a spec that does not exist yet, or a capability the rails do not
expose. It exists because "not built" and "cannot be built here" are very
different statements, and only the second one is an ask.

Every entry says: what a user cannot do → the exact blocker → who owns it →
what specifically unblocks it → **what we shipped instead**, so this reads as
a work log with open dependencies rather than a wish list.

Two constraints that generate most of this list, both deliberate:

1. **We author no Soroban contracts.** We rent rails (Trustless Work escrow,
   the one-way-channel wasm, OpenZeppelin smart accounts via SDF's
   smart-account-kit). That keeps us neutral and swappable — and it means a
   missing on-chain capability is always an upstream conversation.
2. **We take no custody and no fee.** Anything that would be solved by
   holding user funds or running the only index is off the table by design.

---

## 1. Blocked on audits — mainnet dates we do not control

The entire work layer is hardcoded to testnet. Not caution theatre: each
piece reuses a contract whose own README says it is unaudited. **Our mainnet
date is their audit date.**

| What is blocked | The contract | Owner | What unblocks it |
|---|---|---|---|
| Payment channels on mainnet (deposit once, pay per call off-chain — measured ~10× per call) | the one-way-channel wasm, deployed by hash, uploaded by the stellar-mpp-sdk demo | SDF | An audit, or a maintained SDF-published build with a support commitment |
| The vault on mainnet (human funds an agent behind an on-chain spending cap) | OZ smart-account + spending-limit policy contracts via smart-account-kit | SDF / OpenZeppelin | A stated audit posture for the deployed testnet contract set, and mainnet addresses |
| Escrowed jobs and bounties on mainnet | Trustless Work single-release escrow | Trustless Work | Their audit, plus clarity on the 0.3% protocol fee recipient for third-party integrators |

**What we shipped instead:** every one of these is proven end to end on
testnet with on-chain checks, so the audit is the only remaining variable —
`test:session`, `test:vault-flow`, `test:job`, `test:bounty-open`,
`test:marketplace`. When the audits land we flip a network constant, not a
design.

---

## 2. Blocked on protocol and spec gaps

### 2.1 An agent cannot EARN through a payment channel
The shipped channel surface is payer-only: open, pay, close. There is no
receiving side, no registration handshake for a seller to accept channel
payments, and no operator settle loop (settle-without-close, batch settle).
So an agent can be a channel *customer* but never a channel *peer* — which
is precisely the shape agent-to-agent commerce needs.

- **Owner:** SDF (MPP spec + `@stellar/mpp`), partly us.
- **Unblocks it:** a specified seller-side registration + settle flow in MPP,
  and any public channel-mode seller that is not our own sandbox.
- **We shipped instead:** the sandbox serves channel mode, so the loop is
  provable today with both sides ours — which is also the problem.

### 2.2 There is no `upto` scheme on Stellar, so metered pricing is impossible
x402's `exact` scheme is all that exists here. A seller who wants "up to
$0.05, settle the actual usage" — the natural shape for inference, streaming
and per-token work — has no scheme to express it, so every price is fixed in
advance.

- **Owner:** upstream x402 + whoever authors `scheme_upto_stellar.md`; the
  SCF facilitator RFP already asks for it.
- **Unblocks it:** the spec landing in `@x402/stellar`. We inherit it by
  bumping a dependency — our catalog already records `scheme` per endpoint,
  so no data-model change is needed on our side.

### 2.3 A smart account cannot pay a 402 directly
`@x402/stellar` signs with a classic ed25519 key. A contract account
authorizes differently, and the facilitator would have to accept that. So
the vault cannot pay for anything itself.

- **Owner:** SDF (the Stellar x402 scheme + facilitator).
- **Unblocks it:** contract-account authorization accepted in the scheme and
  by facilitators.
- **We shipped instead:** the vault→float pattern — bulk funds stay behind
  the on-chain cap, and the agent draws a small float to the classic key it
  pays 402s with. It works, and it is strictly weaker: income credited
  directly to that classic key is spendable without the cap ever being
  consulted.

### 2.4 Deploying a smart account still needs a WebAuthn dance
`smart-account-kit` wants a passkey as the initial signer. For a headless
agent we implement a software authenticator (P-256 in process) purely to
satisfy that path.

- **Owner:** SDF (smart-account-kit).
- **Unblocks it:** an ed25519-initial-signer deploy path. Not a blocker any
  more — we work around it — but it would delete a whole class of
  server-side weirdness for everyone.

---

## 3. Blocked on rails capabilities (the escrow)

These are the ones that most limit what the work layer can express. All sit
with the escrow contract, and all are the reason the `EscrowRails` seam
exists at all.

### 3.1 A funded escrow has no exit that does not need the resolver
Release and refund both require the resolver's signature, and the contract
(correctly) forbids the dispute_resolver from disputing its own escrow. We
made the agreement's deadline terminate a job, so a vanished *worker* can no
longer freeze a buyer's funds. But if the **resolver** vanishes, the money
stays put with no path out.

- **Unblocks it:** a unilateral after-deadline reclaim — buyer recovers if
  nothing was delivered by the deadline, independent of any dispute.
  ERC-8195's instinct is the right one: fund recovery must never depend on
  the dispute machinery working or a counterparty being alive.

### 3.2 No back-to-back escrow, so agents cannot subcontract
Escrow roles are frozen at init and a payout cannot be conditioned on, or
assigned into, another escrow. So "agent A hires agent B with money it is
earning from human C" is two unlinked escrows: A must fund the second from
its own balance before the first releases, and eats the full risk if B fails.
This is the single most A2A-shaped missing capability.

- **Unblocks it:** payout assignment, or a release that funds another escrow
  atomically.

### 3.3 Evidence writes are role-gated, so open races cannot settle on-chain
Only the assigned provider can write milestone evidence, which is why
open-claim submissions travel out of band as signed packets — and why
evidence theft is possible at all (whoever receives the evidence first can
re-sign it; see the README gap list). An on-chain submission mailbox would
fix it structurally and would need a contract we will not author.

### 3.4 The deliverable hash is not provably write-once
Nothing on our side, and nothing we have verified in the wasm, prevents a
provider from overwriting evidence after a resolver has read it and before
approval. ERC-8195 makes write-once explicit. We assert nothing here and say
so rather than assuming.

---

## 4. Missing ecosystem standards (nobody's bug, everybody's gap)

These are not blockers on a specific counterparty — they are things Stellar
does not have yet, which a foundation is uniquely placed to convene.

**Agent identity.** The subject of every agreement, receipt, descriptor and
submission we produce is a raw `G…` address. There is no portable identity
container on Stellar — no agent card, no `.well-known` endpoint, no
equivalent of the ERC-8004 identity registry. Without one, reputation cannot
be portable *even in principle*, because there is nothing stable to attach it
to. **A SEP for agent identity is the highest-leverage thing the foundation
could do for this whole category**, and it is upstream of our own reputation
work, not a substitute for it.

**Validation / attestation.** Every verdict in our system comes from one
resolver instance. There is no way to record a second opinion, so there is no
way to build the challenge markets the research argues are what make
verification credible. A shared attestation registry would let competing
resolvers disagree in public.

**Receipt portability.** Our receipts ledger is a per-install local file. It
is tamper-evident to whoever holds it and invisible to everyone else, which
means the "the record accrues while the score waits" story is weaker than we
have been writing it. Anchoring receipts (or a light standard for publishing
them) is cheap now and impossible to retrofit once ledgers have history.

**A work-discovery format.** We define a bounty feed and we only *consume*
it; nothing in the ecosystem publishes one. Every buyer must operate a server
to be hireable. A versioned, boring feed format — plus anyone at all running
an aggregator — would make the market findable without any single party
becoming the platform. We will publish a versioned envelope and an aggregator
that unions other people's feeds, precisely so that we are not the front
door.

**Confidentiality.** Agreements, review questions and evidence are all public
on-chain. Anyone paying an agent to work on a private document, customer list
or internal URL cannot use this, and no amount of local cleverness fixes it.
This is a research-grade ask, not a ticket.

---

## 5. The ask list, ranked by what it unlocks

For a conversation with SDF, in the order we would argue for them:

1. **An audit (or a supported build) of the one-way-channel contract.** It is
   the smallest ask with a working client, server, benchmark and UX already
   built behind it. Unlocks high-frequency agent payments on mainnet.
2. **A SEP for agent identity.** Unlocks portable reputation for the whole
   ecosystem, not just us, and everything downstream of it.
3. **The seller side of MPP channels** — registration handshake and settle
   loop. Turns agents from customers into peers.
4. **Contract-account authorization for x402 payments.** Lets a capped smart
   account pay directly, which closes the gap our float pattern papers over.
5. **`scheme_upto_stellar.md`.** Metered and streaming pricing; already
   inside the SCF facilitator RFP's scope.
6. **Escrow capabilities, with Trustless Work:** after-deadline unilateral
   reclaim, payout assignment for subcontracting, write-once evidence.
7. **ed25519-initial-signer deploy in smart-account-kit.** Small, and it
   deletes the software-authenticator workaround for every headless user.

None of these block us from shipping the layer as it stands. Each one turns
something we currently document as a limitation into something that just
works.

---

## 6. What we are doing in the meantime

So this is not a list of excuses:

- Everything above is **proven on testnet** rather than deferred, so each
  unblock is a config change and not a build.
- The `EscrowRails` seam means adopting a better escrow — SDF-native, MPP-
  native, or anyone else's — is one new file and one `setRails()` call, never
  a rewrite. If the foundation ships an escrow primitive, we become its
  client the same week.
- Where we cannot fix the mechanism, we fix the **honesty**: the README's
  "Not built yet — and why" names each limitation with its reason, and the
  test suite asserts the limits out loud (`test:bounty-open` asserts that
  re-signed evidence still wins on arrival order, rather than pretending the
  signature scheme prevents it).
