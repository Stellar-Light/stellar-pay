# stellar-pay roadmap

Direction lives in [SPINE.md](./SPINE.md); this file tracks what's built vs
what remains. The neutral layer is built: a probed catalog, a 402-paying
client (x402 + MPP), an MCP with spend governance, a wallet (setup, encrypted
keystore + macOS Keychain, send, topup with QR + on-ramps, history), the
`verify` seller check, and the **command-wrapping proxy** (`run`). The three
bets below have each landed on testnet; what remains on each is the mainnet
gate and the listed follow-ups.

## 1. MPP session mode — high-frequency paying

We do MPP **charge** (one on-chain settle per request). Session mode opens a
one-way channel: deposit once, then sign off-chain cumulative commitments —
right for an agent making many small calls per task.

**Status 2026-08-29 — the protocol loop is PROVEN on testnet, both sides
ours** (`npm run test:session`): channel deployed from the on-chain wasm hash
(no rust in the loop), 8 off-chain commitments at 457 ms/call vs 4,589 ms/call
charge (10×, on-chain load 8→2 txs), close via the MPP credential path with
the funder's refund verified to the stroop. The client's cumulative baseline
persists across restarts (`src/pay/session-store.ts` — the SDK's anti-reset
warning, answered), and the sandbox serves channel mode behind
`CHANNEL_CONTRACT`/`COMMITMENT_PUBKEY`.

**The `--session` UX SHIPPED (2026-08-30, `npm run test:session-ux`):**
`session open <url> --deposit 5` (5 XLM default), `curl --session` pays per
call off-chain and reuses the host's channel from the persistent store,
`session status`/`close`, and the MCP's `session_open`/`session_status`/
`session_close` (+ `curl{session:true}`) give agents the same loop.

- **Remaining:** settle-without-close and the operator settle loop (the
  seller-side half). **Mainnet remains gated on the one-way-channel contract
  audit** (the contract's own README says unaudited) — the standing SDF ask,
  now backed by a working client+server+benchmark+UX.

## 2. Smart-account vault — spend caps enforced on-chain

Today the wallet is a classic ed25519 key; governance (Scrimp + the approve
gate) is app-layer. A **smart account** (OpenZeppelin, via SDF's
[`smart-account-kit`](https://github.com/stellar/smart-account-kit), Apache-2.0)
enforces limits **on-chain** in `__check_auth`: a daily USDC cap, an allowlist
of callable contracts, session-key expiry — so a compromised agent key still
cannot exceed the cap.

Confirmed feasible for agents (not passkey-only): the kit imports headless
(`MemoryStorage`), supports **Ed25519 external signers**, ships a first-class
**spending-limit policy**, and its testnet contracts are published. The one
gap: paying a 402 *from* a smart account isn't drop-in — `@x402/stellar` signs
with a classic key, and a contract account authorizes differently, which the
facilitator/scheme would need to accept.

- **Shape (the pattern that works today):** the smart account is a **vault** —
  holds the balance, on-chain daily cap + a `CallContract` rule scoped to the
  USDC SAC, with the agent's ed25519 key as an External signer. It tops up a
  small **hot classic key** the client uses for 402s. Bulk funds are protected
  on-chain; only a small float is ever at the key an agent signs 402s with.
  `send` can already run through `kit.transfer(USDC_SAC, to, amount)`.
- **Reuse, don't build:** adopt `smart-account-kit` + a published policy
  contract. We never author a Soroban contract.
- **PROVEN on testnet (2026-08-29, `npm run test:vault`):** headless deploy
  via a software authenticator (`src/pay/passkey.ts`, path (a)
  — P-256 in process memory through the kit's `webAuthn` hook; no CBOR
  needed, the kit reads the raw key from `response.publicKey`). The vault
  shape holds end-to-end: OWNER passkey on the Default rule; AGENT ed25519
  key ONLY on a CallContract rule scoped to the XLM SAC carrying the
  spending-limit policy (params must go through `convertPolicyParams` — raw
  JS params trap the VM). Under-cap transfer landed on-chain; over-cap
  transfer REFUSED BY THE CHAIN ("would exceed the spending limit for the
  current period") with funds untouched, recipient balance verified. Both
  outcomes land in the receipts ledger — on-chain governance and app-layer
  governance, one substrate. Traps recorded: spending-limit cannot install
  on the Default rule (#3227 — it needs a token-scoped context);
  TransactionResult is a union, never thrown — branch on `.success`;
  `getAvailableSigners()` reads only the Default rule (hand the cap-rule
  signer to `buildSelectedSigners` directly). SDF ask #4 (ed25519-initial-
  signer deploy) remains the CLEANER path but no longer blocks.
- **The vault verbs SHIPPED (2026-08-30, `npm run test:vault-flow`):**
  `vault create --cap-xlm N` (owner = a durable software passkey, persisted
  for reopen), `vault topup` (a plain SAC transfer — bulk funds behind the
  cap), `vault draw` (the hot-key top-up loop: the agent pulls float, an
  over-cap draw is refused BY THE CHAIN and receipted), `vault status`; MCP
  `vault_draw`/`vault_status` let an agent top itself up within the human's
  cap. The integrated e2e pays a real 402 from drawn float.
- **Remaining:** seal the owner passkey PEM in the encrypted keystore
  (today it sits plaintext in the session store, honestly flagged), and the
  mainnet decision — which waits on the smart-account contracts' own audit
  posture.

## 3. Phase D — agreements: escrow-backed agent work — BUILT (testnet)

Payments govern what an agent may spend; **agreements** govern when a payment
releases. Sketched in [phase-d-agreements.md](./phase-d-agreements.md), now
built and proven on testnet (2026-08-30):

- **Jobs on swappable rails** (`src/pay/job.ts` + `rails.ts`): Trustless
  Work's live escrow, integrated KEYLESS — deploy-from-wasm-hash, straight at
  the contract, no API key (their SaaS auth is not a blockchain requirement).
  `test:job`: open → fund → deliver → approve → release, payout exact
  (amount − 0.3% platform fee).
- **Stellar-native agreements** (`stellar-pay/agreement-v1`, sha256): the
  agreement hash IS the escrow's engagement id; the chain pins the terms.
- **Automated resolver** (`test:resolver`): policy answers the agreement's
  review question, maps through declared effects — release (approve+release)
  or refund (dispute-with-standing + resolve-to-buyer), receipted.
- **Verification bounties** (`test:bounty`, `test:bounty-open`): directed and
  open-claim (escrow before a winner exists; ed25519-signed evidence packets;
  first VALID wins; a REPLAYED signature is rejected — though a thief who
  obtains the evidence can re-sign it, which is why evidence goes to the
  resolver and commit-reveal is the real fix, roadmapped). The proof
  bounty did REAL work — live directory-row verification.

**Remaining:** mainnet (gated on the escrow contract's audit posture + the
`TW_FEE_ADDRESS` question), and the product sequence from
[SPINE.md](./SPINE.md) — verification bounty surface → an operated resolver.
Reputation stays a **design phase**
([reputation-design-questions.md](./reputation-design-questions.md)) — the
receipts substrate accrues evidence meanwhile.

## Why it strengthens the SDF story

Each is "on SDF's own rails": MPP session mode uses SDF's MPP spec, the vault
uses SDF's smart-account-kit and OZ's audited contracts, and the proxy makes
the neutral client wrap the whole ecosystem. The pitch stays: **the neutral
supply-and-governance layer for agent payments, consuming every router, on
Stellar's own rails.**

- **x402 `upto` scheme** — the SCF facilitator RFP requires authoring
  `scheme_upto_stellar.md` upstream. When it lands in `@x402/stellar`, we
  inherit it by bumping the dependency; the catalog already records `scheme`
  per endpoint, so no data-model change is needed.
