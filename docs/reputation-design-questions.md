# Reputation — open design questions (THINK FIRST, build later)

Status: **design phase, deliberately.** The owner's call (2026-08-30): this is
the flagship's last pillar and the one that cannot be un-shipped casually —
especially if it one day underwrites **credit lines for agents**. A gameable
ranking is an annoyance; a gameable underwriting signal is a solvency risk.
Nothing in this file is a commitment; these are the questions a real design
must answer before code exists.

The bar, restated from [SPINE.md](./SPINE.md): costly-to-fake evidence
(escrow-judged outcomes, real money moved by a resolver's decision), and
describe ≠ adjudicate (reputation only describes; it never judges or holds
funds).

## 1. Sybil and collusion — the existential question

A wash-trading pair (buyer-agent and provider-agent run by the same party) can
manufacture perfect release records at the cost of TW's 0.3% fee + gas. That
makes naive release-rate reputation gameable at ~0.4% of face value.

- What makes an outcome COSTLY to fake beyond the protocol fee? Candidates:
  counterparty-diversity weighting (n distinct funders, weighted by THEIR
  standing — recursive, PageRank-shaped), stake/bond slashed on disputed
  fraud, time-in-market, fee-burn floors, identity attestation as a
  multiplier (never a gate — permissionless entry stays).
- Is the score value-weighted (10×$100 jobs ≠ 100×$1 jobs) and does that
  create its own farming shape?
- Does the resolver's OWN reputation gate how much weight its judgments
  carry? (A colluding resolver is the deepest attack — resolver diversity
  may matter more than counterparty diversity.)

## 2. What is the subject — key, agent, operator, or model?

- A keypair is cheap; burn-and-restart laundering erases bad history. Does
  reputation attach to a key, a persistent agent identity (what anchors it?),
  or the operator behind many agents?
- Cross-key linkage: vault funding trails link keys structurally. Do we USE
  that (anti-laundering) or is that surveillance creep a neutral layer
  shouldn't do?
- Negative history portability is THE hard case: good history follows keys
  willingly; bad history is abandoned. Any design that only aggregates
  positives converges to five-stars-everywhere (the marketplace disease).

## 3. What exactly counts as evidence?

- Tier the signal by verifiability: resolver-judged release (strongest) >
  refund (negative, but ambiguous — buyer remorse vs provider failure) >
  dispute outcomes > session/x402 payment volume (weak, Circle's explicit
  warning: manipulable) > self-declared anything (excluded, full stop).
- hash-match resolutions are deterministic; callback-policy resolutions are
  as good as their judge. Does the policy label weight the outcome?
- Off-platform work (jobs settled outside our rails): invisible, or
  attestable somehow? If invisible, the record is honest but partial — say so
  in the artifact.

## 4. Read model — score, record, or oracle?

- A NUMBER invites gaming and false precision (Goodhart). A RECORD (the
  receipts themselves, aggregated but inspectable) matches our
  evidence-not-opinion DNA. An ORACLE (Nulucre-style paid endpoint) makes it
  a product. These compose: record first, derived views later, oracle last.
- Where does it live? Local aggregation over receipts (private, per-user),
  a published feed (public good, neutral-layer-shaped), or on-chain
  attestations (composable, but premature standardization risk)?
- Who pays for the read, and does charging for it distort what gets scored?

## 5. The credit-line horizon (the owner's question — not off topic)

If the record is trustworthy enough, it underwrites: an agent with N released
jobs, low dispute rate, diverse counterparties could draw a credit line —
working capital for agents (fund the vault against future earnings; the
lender's risk priced off the work record). That is the reputation → credit
arc every financial system walks.

- Constraint it imposes TODAY: the record must be underwriting-grade —
  auditable evidence chains, no un-provable claims, explicit uncertainty.
  Design for the lender reading it, even if the lender is years away.
- It also names the failure mode to avoid: a score optimized for
  marketplace ranking (engagement-shaped) is the wrong substrate for credit.
  If we ever must choose, choose the lender's needs.
- Adjacent prior art to study when we get here: Nulucre (wallet
  creditworthiness — a SIDECAR signal, never the spine), TradFi thin-file
  underwriting, DeFi undercollateralized-lending failures (what killed
  them: unverifiable off-chain reputation. Exactly the trap above).

## 6. Cold start and fairness

- New agents have no record. Does the system admit "unrated" honestly
  (preferred — absence ≠ badness, our house rule) or invent priors?
- Does early reputation compound unfairly (rich-get-richer) and freeze out
  new entrants — and is some of that just what trust IS?

## What would change our mind toward building sooner

- A real design partner (a marketplace or hiring surface) with concrete read
  needs — design against a consumer, not in the abstract.
- Volume: until there are hundreds of real (non-self-dealt) jobs, any score
  overfits noise. The receipts substrate keeps accumulating regardless —
  building the RECORD costs nothing; it's the SCORE that waits.

## Prior art to study during the design phase (from the 2026-08-30 link sweep)

- **ERC-8004** — live on Ethereum mainnet, and the container everyone writes
  to (Circle's registries, Nookplot's portable feedback). It is identity +
  reputation + validation REGISTRIES, deliberately not judgment — Circle's
  own words: containers, not credibility. Two takeaways: (1) portability is
  won by a shared container standard, and Stellar has no equivalent (our
  named SDF gap); (2) design our record so it could EXPORT into an
  8004-shaped container later without adopting its trust assumptions.
- **Nookplot** — the richest agent-trust stack seen so far: wallet identity,
  graph-weighted endorsement reputation written to ERC-8004, permissionless
  verifiers scoring 4 dimensions paid from an epoch pool, escrow-backed
  hiring (2.5% fee), 30-day permissionless 50/50 dispute expiry, NOOK
  staking multipliers. Study it as the OPPOSITE integrity trade to ours:
  endorsements + paid verifier scores are rich but cheap-to-game (rings,
  collusion — exactly Circle's warning); token staking is circular skin-in-
  the-game. Their 50/50 expireDisputed deadlock-breaker is genuinely
  clever and worth stealing the SHAPE of.
- **OKX AI × Solana** — a live custodial agent marketplace ("discover work,
  get hired, transact, reputation on-chain"): the platform pole is shipping
  h→a hiring TODAY. Confirms the wedge and the urgency; our counter remains
  neutrality + self-custody + costly-to-fake outcomes.
- **Space and Time / EigenCloud** — the verification layer keeps growing
  flavors (verifiable data before paying; AVS-attested compute). Both are
  candidate tier-2 evidence sources for resolvers someday, not now.

## The one decision already safe to take

Keep writing receipts exactly as we do — content-addressed, ref-chained,
on-chain-verifiable, with resolver policy labels. Whatever reputation becomes,
that substrate is its raw material, and it accrues while we think.
