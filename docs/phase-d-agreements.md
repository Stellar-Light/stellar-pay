# Phase D sketch — agreements: escrow-backed agent work

*Status: sketch (2026-08-29). Nothing here is built. This is the design we'd
build against, written down while the reasoning is fresh.*

## Why — the layer above payments

Ali Yahya (a16z crypto, [June 25](https://x.com/alive_/status/2070172260430663755)):
agentic *commerce* — agents paying for things, our phases A–C — is weakly
differentiated for crypto, because credit cards are reliable, universal, and
more programmable than assumed. The crypto-native win is **agent-to-agent
coordination**: one agent hires another it doesn't trust, funds sit in escrow,
release happens only on verified completion — programmatic verification where
possible, a judge-agent otherwise. NEAR's answer
([Illia's reply](https://x.com/ilblackdragon/status/2070240198693470302)) is
Agent Market: "discovery, negotiation, escrow and potential derivatives,
dispute resolution."

Our own census agrees from the data side: Stellar's x402 supply is thin (217
payable endpoints from 3 hosts vs Base's 14,385). More rails don't create
demand. An **agreement primitive** gives agents a reason to transact here that
a card cannot serve: enforceable hold-verify-release between mutually
untrusting parties, settled in USDC, with fees measured in cents.

The pitch extension is one line: today stellar-pay governs **what an agent may
spend** (Scrimp, the approve gate, the vault bet); phase D governs **when a
payment releases**. Complementary, not a pivot.

## What already exists on Stellar (reuse, don't build)

[Trustless Work](https://docs.trustlesswork.com) is escrow-as-a-service on
Soroban, live on testnet **and mainnet**, USDC-native, and actively shipped
(contract repo pushed 2026-08-29; they publish an
[agents skill](https://github.com/Trustless-Work/trustlesswork-skill) — they
are courting exactly this integration). Their primitives map onto the thesis
almost verbatim:

| Yahya's thesis | Trustless Work primitive |
|---|---|
| hire | deploy escrow (roles, milestones, amount, asset, receiver, engagement id) |
| hold | fund escrow (USDC; mainnet issuer `GA5ZSE…KZVN`) |
| do the work | service provider "change milestone status" + attach **evidence** |
| verify | approver "sign the approval of a milestone" |
| pay on completion | release signer executes payout |
| judge | dispute resolver "resolve disputes by redirecting funds" |

Escrow types: **single-release** (all milestones approved → one payout: one-off
jobs — our default) and **multi-release** (per-milestone payouts: phased work).
Fees: 0.3% protocol + a configurable platform fee (we set ours to 0 — the
neutral layer takes no cut). Integration is REST (mainnet
`api.trustlesswork.com`, testnet `dev.api.trustlesswork.com`): the API builds
the transaction, the caller's wallet signs — which is precisely the shape our
keystore already serves for 402s. No new signing machinery.

**We never author a Soroban contract** (house rule, same as the vault bet).
The escrow contract, its lifecycle, and its indexer are theirs; we consume.

## The primitive we ship: `job`

A **job** is an escrow with agent keys in the roles. Two stellar-pay
installs — buyer agent and seller agent — drive the whole lifecycle from the
CLI/MCP they already run for payments:

```sh
# Buyer side: hire — deploys + funds a single-release escrow
stellar-pay job open --provider G…SELLER --amount 25 \
  --spec ./task.md --judge G…RESOLVER
#   → job id, escrow contract, funded; spec hash pinned in the engagement id

# Seller side: deliver — marks the milestone done, attaches evidence
stellar-pay job deliver <id> --evidence ./result.json
#   → evidence hash on the milestone

# Buyer side: verify + release
stellar-pay job approve <id>        # signs approval (policy-gated, below)
stellar-pay job release <id>        # release signer pays out, minus 0.3%

# Either side, when it goes wrong
stellar-pay job dispute <id>        # judge (dispute resolver) redirects funds
```

Role assignment for the common case: buyer key = approver **and** release
signer; seller key = service provider **and** receiver; a third key (optional
but default-on) = dispute resolver. Where no judge exists, `--judge none`
degrades honestly: the buyer can withhold forever — the CLI says so at open.

MCP mirrors the verbs (`job_open`, `job_status`, `job_deliver`, `job_approve`,
`job_release`, `job_dispute`) so a Claude-style agent can run either side. The
**persistent ledger** roadmap item lands here naturally: jobs are exactly the
history worth keeping (spec hash, evidence hash, approvals, payout tx).

## Verification — the honest part

Yahya's caveat is the design's load-bearing wall: escrow-release-on-
verification is only *clean* when completion is programmatically checkable.
Three tiers, declared per job at `open`:

1. **Hash-match** (`--verify sha256:<hash>`): approve iff the delivered
   artifact hashes to the agreed value. Deterministic outputs only — rare, but
   when it applies the approve is fully automatic.
2. **Policy approve** (`--verify policy`): the buyer's own agent decides, but
   the approve action routes through the same Scrimp/approve gate every
   payment already passes — a human cap on what the agent may sign, not a
   claim the check is objective.
3. **Judge** (`--verify judge`): approval contested or absent → the dispute
   resolver (a third agent, or a human) redirects funds. This is the general
   case, and it is honest to say the judge is the weakest link: today it is a
   trusted third party, not a protocol.

We do **not** claim trustless verification of arbitrary work. Nobody has it;
the sketch's bet is that hash-match plus a credible judge covers enough real
agent jobs (data pulls, evals, format conversions, scored benchmarks) to
matter.

## Gates before this touches mainnet

- **Audit status of the escrow contract is unverified.** Their docs don't
  state it; our own audits registry has no Trustless Work entry. Gate: find
  or obtain the audit, or ship testnet-only (their dev API) with the same
  sandbox discipline the 402 sandbox uses. No mainnet default without it.
- **API dependency.** `job` calls their REST service. If the API dies
  mid-escrow, funds sit in a contract we can read but drove via their
  builder. Gate: confirm every lifecycle action is reproducible against the
  contract directly (their contract repo + indexer are open) so an escrow is
  never orphaned by an API outage. Document the escape hatch before GA.
- **Fee honesty.** 0.3% protocol fee + trustline reserve (0.5 XLM) disclosed
  in `job open` output, same as `curl` discloses price before paying.

## Benchmark — `job.sh`

Same discipline as `pay.sh`: a scripted end-to-end run on testnet — open →
fund → deliver → approve → release — timed per step, fees recorded, both
sides driven by two stellar-pay installs, output a stellar.expert link per
transaction. If the full loop can't run unattended in under a minute for
under a cent (fees, not principal), the primitive isn't agent-ready and the
sketch says so.

## Non-goals (for phase D)

- **Discovery/marketplace** — who to hire is out of scope; that's a registry
  problem (talos-shaped, testnet experiments exist) and the census says the
  demand side is thin. We ship the agreement, not the market.
- **Negotiation, derivatives** — NEAR's framing, not ours. A job has a fixed
  price; haggling is prompt-space, not protocol-space.
- **Multi-release phased projects** — the single-release one-off job is the
  MVP; multi-release is a flag away when a real use case shows up.

## Sequencing

Phase D slots **after** the two standing bets, not before: MPP session mode
serves demand that already exists (busy agent loops on live 402 endpoints);
the smart-account vault hardens custody for everything including escrow
funding. Phase D is the first bet that tries to *create* a Stellar-native
reason to transact rather than serve one — higher risk, and the reason it
stays a sketch until the census or a design partner shows a buyer.

The SDF story extends unchanged: agreements on SDF-adjacent rails (Trustless
Work is an SCF-funded, summit-winning Stellar builder), consumed neutrally,
no contract of our own, benchmarked in public.
