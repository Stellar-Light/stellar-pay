# Who is responsible for what

Written because the first question an enterprise asks is not "what does it
do" — it is "who is liable when it goes wrong". A competing proposal in the
same space answers that with a matrix naming its regulated partner, its
wallet-infrastructure provider and its software layer. We have no partners to
name, which changes the answer but does not excuse skipping it.

This page states the boundary as it actually is today, not as it would be
convenient. Where the honest answer is "you", it says you.

## The one-line version

**stellar-pay is software you run. It takes no custody, holds no funds, runs
no server in the payment path, and takes no fee. Every consequence of a
payment it makes is yours, because every key it signs with is yours.**

That is the whole of it. The rest of this page is the detail behind it.

## The matrix

| Concern | Who | Detail |
|---|---|---|
| Private keys | **You** | Generated locally, stored in your OS keystore (macOS Keychain, Windows DPAPI, GNOME Keyring) or a file you control. Never transmitted. We cannot recover them and cannot spend without them. |
| Deciding to pay | **You**, then the agent inside your limits | A payment happens when your policy allows it (`~/.config/stellar-pay/policy.json`) and — for a vault — when the chain's own cap allows it. |
| Enforcing spend limits | **The chain**, for a vault; **this software**, otherwise | The vault's cap lives in the smart account's `__check_auth` and holds even if every process we run disappears — and refusing costs nothing, because `__check_auth` runs in simulation, so an over-cap payment is never submitted. The per-host policy file is enforced in our code — a promise our code keeps, which is weaker, and is why the vault exists. |
| Settling the payment | **The facilitator and the network** | `@x402/stellar`'s facilitator constructs, fee-sponsors and submits. We hand it a signed authorization; we do not submit for you and cannot reverse what it submits. |
| Custody of settled funds | **You** | Funds land in your account or your vault contract. No pooled account, no omnibus wallet, no intermediary balance. |
| Converting to fiat | **Nobody, here** | We have no fiat leg. There is no off-ramp, no regulated entity in this stack, and no reconciliation to a bank balance. If you need that, it is somewhere else in your architecture. |
| Onboarding / KYB / KYC | **Nobody, here** | We perform no identity checks and gate nothing behind them. That is the point for an autonomous agent, and it is a gap if your obligations require them. |
| Sanctions and AML screening | **You** | We do not screen counterparties. If you must, screen before your policy allows the host. |
| What an agent buys | **You** | Governance is a spend limit, not a judgement about the purchase. An agent operating inside its cap can still buy something useless. `receipts --statement` is how you find out. |
| The audit trail | **Shared, and independently checkable** | We write it; the chain proves it. `receipts check` shows tampering with our file, `receipts --verify` proves a row against the ledger, and reconciliation compares the whole set. You never have to trust our file on its own. |
| Uptime | **Not applicable** | There is no service to be down. The CLI runs on your machine; a network outage is between you, your RPC provider and Horizon. |

## What this means in the cases that actually come up

**A key is stolen.** Whoever holds it can spend whatever it can reach. If that
key is a vault's agent key, the chain limits the damage to the cap — that is
the vault's entire purpose. If it is a plain wallet key, the exposure is the
balance. We cannot freeze, claw back or reverse anything.

**An agent is prompt-injected into overspending.** The policy file and, for a
vault, the on-chain cap are the containment. Neither is a description in a
tool's help text — the repo is explicit that saying something in a tool
description is not an enforcement. What survives injection is what is checked
in code and in the contract.

**A payment is made twice.** Ours is at-most-once per approval by
construction, and the receipts ledger will show both rows if it happens
anyway. Detecting it is reconciliation's job; deciding what to do about it is
between you and the seller. There is no chargeback.

**The seller does not deliver.** For a plain 402 payment there is no recourse:
you paid for a request and got a response, or you did not. The escrow layer
exists for work worth disputing, and it is testnet-only.

**A regulator asks what happened.** Every value-moving row carries the request
that caused it and the transaction that settled it, exportable as CSV, each
row independently verifiable against the public ledger. What we cannot give
you is an entity that attests to it on your behalf.

## Where we are deliberately weaker than a custodial platform

Stated plainly, because pretending otherwise is how trust gets lost:

- **No fiat rail, no regulated perimeter.** A platform with a regulated
  partner can offer "you never touch crypto" and mean it under MiCA. We
  cannot make that claim and do not.
- **No recovery.** Lose the key, lose the funds. A custodial platform can
  restore an account; we have nothing to restore from.
- **No support obligation.** There is no SLA, no on-call, no one to escalate
  to. It is open-source software you run.
- **Mainnet posture is narrow.** The vault and the whole work layer are
  testnet-gated on the audit posture of contracts we do not author. The README
  says which parts run on mainnet and which do not; that gate is a real
  limitation, not a formality.

## What we will not do

- Hold your funds, pool them, or route them through an account we control.
- Take a fee, a spread, or a cut of settlement.
- Add a server to the payment path that has to be up for you to pay.
- Claim a compliance property we cannot demonstrate.

If any of those change, this page changes first.
