# Research benchmark — stellar-pay scored against the agent-economy corpus

_Written 2026-08-29 against branch `track1-session-slice`, HEAD `b5be9af`, by reading the source.
Every claim about our code carries a `file:line`. Where a source could not be fetched it says so and
the reasoning falls back to the underlying idea. Claims about the Trustless Work wasm and the
one-way-channel wasm are marked unverified — we have not read either contract._

## 1. Why this document exists

The reading list is not a reading list. Each source in it names a *mechanism* an agent economy is
supposed to have — an expiry refund a dispute cannot block, a challenger who stakes against a false
claim, a receipt a stranger can check, a spend cap the chain enforces — and taken together those
mechanisms are a specification we can be graded against. So this document grades. Section 3 is the
scorecard: mechanism by mechanism, what the research demands, what stellar-pay actually does at a
line number, and a verdict. It is written to be uncomfortable. An honest ABSENT row is worth more
than a stretched PARTIAL, because the ABSENT rows are the roadmap and the stretched ones are how a
project ends up believing its own README.

## 2. The corpus

| Source | Mechanism it contributes to the bar | Fetch |
|---|---|---|
| cgi.md/essays/economic-alignment | access-without-transfer; conditional recall; superset-state intermediary; **verification + challenge markets where challengers stake**; attribution flowing backward through contribution chains | fetched |
| ERC-8004 (Trustless Agents) | identity / reputation / validation as **containers, not judgment**; feedback callable by anyone except the agent's own operators; off-chain files hashed on-chain | fetched |
| ERC-8195 (Task Market) | deterministic pre-computable `taskId`; write-once deliverable hash; worker stake in Claim mode; ranked basis-point payouts; **the Fund Recovery Invariant — `refundExpired` must succeed past expiry and cannot be blocked by a dispute** | **eips.ethereum.org 404**; recovered in full from the Ethereum Magicians thread — secondhand but detailed |
| ERC-8194 (PGTR) | a payment receipt as the *authorization* for a relayed transaction | **404**; only the summary embedded in the 8195 thread. Thin. |
| autocontracts.org | Ricardian pattern: markdown agreement + deterministic contract logic + third-party resolver; `keccak256(document_bytes)` over a canonicalized preimage | homepage + `/read/agreement-format` fetched |
| ClawBank / Shodai | three-layer Ricardian object: signed prose / machine state machine / the contract address embedded in the signed document | press coverage only — homepage not fetched. Secondhand. |
| Nookplot | bonded arbiters; permissionless 50/50 dispute expiry — an unattended dispute must terminate | **not fetchable** (JS shell; page returned a title and slogans). Every Nookplot detail here is secondhand from `docs/reputation-design-questions.md:139-146`. No parameter independently verified. |
| Circle — open agentic economy / agents.circle.com | settlement final-programmatic-global-neutral; user-defined spend limits; "self-declared onchain feedback is cheap to game"; **"ranking describes the world; it never judges disputes or holds funds"** | both fetched |
| Nulucre | reputation as a *paid signed oracle* — 0-100 over 8 Horizon signals, read for $0.001 via x402 | fetched |
| Merit Systems / solana-foundation `pay.sh` | the adoptability bar: one thing people install; local wallet authorization behind biometrics | both fetched |
| x402 v2 + `upto` scheme | CAIP-2 networks; `accepts[]` selection; phase-dependent authorized-max vs settled amount | fetched; **no Stellar `upto` variant exists** — only `scheme_upto_evm.md` |
| SDF MPP (draft-stellar-charge-00) | Challenge–Credential over HTTP 402; charge vs session intents; `Payment-Receipt` | partial — shape yes, full field list no. Our own `src/pay/offers.ts` is the better field reference. |
| scalingtrust.org.uk | programme landing page — PUF attestation, 3-party MPC, "without intermediaries" | fetched but **thin**: slogans, no spec-level detail. Not scored. |
| X threads (alive_, ilblackdragon, benfielding, ditto_anc) | — | **unfetchable: x.com returns HTTP 402 to WebFetch.** Used only as already paraphrased in our own `docs/phase-d-agreements.md:8-18`, and labelled as ours. |
| "ICME" | credited in `src/pay/receipts.ts:15-17` for policy-as-artifact | **could not identify the entity.** Not scored. |

## 3. The scorecard

Verdicts: **IMPL** implemented · **PART** partial · **ABS** absent · **DEF** deliberately deferred.

### A. Agreement and task binding

| # | The research demands | What we do (file:line) | V | The honest gap |
|---|---|---|---|---|
| A1 | prose + deterministic logic, the chain binding inside the signed artifact (autocontracts, ClawBank) | the agreement doc's sha256 **is** the escrow `engagement_id`, and the full doc is the on-chain `description` — `agreement.ts:107-109`, `job.ts:140-148` | IMPL | It is our format, not one anyone else reads. `agreement.ts:1-22` says so. |
| A2 | a stranger can prove the chain pinned exactly these terms | `openBountyTerms()` re-derives the hash from **public descriptor data alone** (`bounty.ts:354-359`) and `checkListing` compares both directions — `sha256(on-chain doc) == engagement_id` and `re-derived(descriptor) == engagement_id` (`worker.ts:105-117`) | IMPL | Strongest row on the board, and stronger than anything the corpus specifies. |
| A3 | a canonical preimage so the hash is stable across renderers | `buildAgreement` canonicalizes the document it **emits** — LF, exactly one trailing newline, BOM stripped (`agreement.ts:54-56,101`) | PART | Asymmetric. `agreementHash()` (`:107-109`) does not re-canonicalize, and verifiers hash the on-chain string as-is (`worker.ts:108`). A doc that picks up CRLF or a BOM in transit **fails** verification rather than normalizing. |
| A4 | the contract can re-validate that fund matches what open initialized | `jobAgreement()` is deterministic from the JobSpec (`job.ts:80-112`, asserted `sandbox/unit-test.ts:236-247`) and `fundJob` re-derives byte-identical terms and re-sends the full struct (`job.ts:197-203`) | PART | Whether TW's wasm actually *compares* the struct is unverified — the anti-TOCTOU note at `rails-trustless-work.ts:72` is our own comment. `fundJob` also passes the caller's `o.engagementId` (`job.ts:200`) without asserting it equals the freshly derived hash. |
| A5 | pre-computable task id (8195: `keccak256(chainid, contract, requester, nonce)`) | `engagement_id` is deterministic and pre-derivable | PART | The **escrow contract id is not** — it comes back from a salted deploy (`rails.ts:59-61`, `job.ts:144-148`). Nothing can be pre-addressed; every flow waits on the deploy receipt. |
| A6 | deliverable hash MUST NOT be overwritten once set (8195) | `deliverJob` calls `change_milestone_status` with no write-once guard, and the provider key can call it again (`job.ts:217-239`) | ABS | Our side asserts nothing. Whether the TW wasm forbids re-writes is **unverified — we did not read the contract**. A provider could plausibly swap evidence after a resolver reads it and before approval. |
| A7 | **fund recovery invariant** — an expiry refund that a dispute cannot block (8195; Nookplot's 50/50 expiry is the same shape) | the agreement writes a `deadline` (`agreement.ts:46-47,76`) that **nothing reads** — `parseAgreement` returns only the review question and effects (`agreement.ts:113-137`) and `job.ts:106` defaults it to `2100-01-01`. `grep -rn deadline src` finds no consumer. | ABS | The most serious structural hole. See §4(c) and §5. |
| A8 | cancellation before work starts (no corpus source; every human buyer expects it) | nothing — `grep -rniE 'cancel\|expire' src/pay/` returns only x402 offer `expires` fields in `offers.ts` | ABS | A buyer who posts and changes their mind ten seconds later has no path back. |

### B. Verification and adjudication

| # | The research demands | What we do (file:line) | V | The honest gap |
|---|---|---|---|---|
| B1 | verification cheaper than redoing the work (8195 Benchmark mode) | `verificationEvidencePolicy` is fully deterministic — JSON array, wanted-set membership, duplicate rejection, final size equality, `/^https?:\/\//`, non-empty verdict + excerpt, parseable `checkedAt`, freshness within `maxEvidenceAgeDays` with a 0.5-day future-skew allowance (`bounty.ts:190-220`) | IMPL | It verifies the **shape** of evidence, not its truth: a plausible excerpt on a live URL passes. And `:213` uses `Date.parse`, which accepts non-ISO strings, while the on-chain review question (`:113`) promises "checkedAt (ISO 8601)" — the judge is slightly laxer than the terms it enforces. |
| B2 | (nobody demands this — it is ours) | `hashMatchPolicy`'s own header states it proves the worker *knows* the hash, not that they *have* the deliverable, and names its soundness condition (`resolver.ts:52-64`) | IMPL | None. Self-limiting documentation the corpus never asks for and should. |
| B3 | the verdict's basis is recorded, not hidden (autocontracts, ClawBank) | every resolution receipts policy label, review question, answer, outcome, evidence and txs (`resolver.ts:158-171`) | IMPL | The receipt is a local file (C4). A counterparty cannot independently pull it. |
| B4 | "ranking describes the world; it never judges disputes or holds funds" (Circle) | the resolver adjudicates and moves funds; nothing ranks | IMPL | **Satisfied by absence.** There is no ranking layer to keep separate. Score this "no violation", not "a design achieved". |
| B5 | challenge market — challengers stake against claims, valid challenges earn, bad ones lose stake (CGI) | nothing. `grep -rniE '\b(stake\|bond\|slash\|arbiter)\b' src/pay src/mcp.ts src/cli.ts` returns **zero hits** | ABS | Nothing makes garbage costly to submit and nothing pays anyone to catch it. Credibility here is passive — exactly what CGI argues fails. |
| B6 | bonded / slashable arbiter (Nookplot, secondhand; implied by CGI) | the resolver holds approver **+** release_signer **+** dispute_resolver at once (`job.ts:51-56`, `rails.ts:24-27`), and `resolveDispute` distributions can name any address (`job.ts:304-329`) | ABS | **A compromised or colluding resolver can redirect the entire pot, with no bond to slash and no appeal.** `reputation-design-questions.md:28-30` calls resolver collusion "the deepest attack"; the code ships the concentrated-role design anyway. |
| B7 | worker stake to lock a task, forfeited on non-delivery (8195 Claim mode) | nothing. `makeSubmission` needs only a keypair and leaves no on-chain footprint (`bounty.ts:362-375`) | ABS | Open races are free to flood. First-valid-wins addresses *quality*, not *volume*. |
| B8 | third-party validation / attestation registry (ERC-8004 Validation Registry; Circle's verifiable compute) | nothing | ABS | Every verdict comes from one resolver instance. No second opinion, no way to record one. |
| B9 | evidence bound to the party who produced it | open-claim packets are ed25519-signed over `sha256(contractId \| JSON.stringify(evidence))` and `pickWinner` verifies that signature against the claimed worker key before judging (`bounty.ts:302-309, 394-407`), so a packet cannot be **replayed** with the original signature under a new payout address | ABS | **It does not bind evidence to a worker.** The worker address is absent from the digest preimage, so anyone who receives a packet can re-sign the same evidence under their own key and, arriving first, take the pot. Proven by re-running the code. The fix is the worker address in the preimage (and/or commit-reveal). **Three places overstate this and should be corrected at source: the comment at `bounty.ts:277-279`, `ROADMAP.md:108` ("stolen evidence dies on the signature check"), and the e2e at `sandbox/bounty-open-test.ts:125-126`, which builds the "theft" case as `{...sub2, worker: worker1.publicKey()}` — keeping worker2's signature, which of course fails. The realistic re-sign attack is untested.** |

### C. Identity and reputation

| # | The research demands | What we do (file:line) | V | The honest gap |
|---|---|---|---|---|
| C1 | portable identity container (ERC-8004; Circle calls it foundational) | nothing. `grep` across `src/` for `8004`, `did:`, `agent-card`, `.well-known` is **clean**; ERC-8004 appears only as prose in `README.md` and `docs/reputation-design-questions.md`. The subject of every agreement, receipt, descriptor and submission is a raw `G…` address (`agreement.ts:28-36`, `receipts.ts:62-64`, `bounty.ts:57-59,294`) | ABS | The one endpoint any artifact publishes is the bounty descriptor's optional `submitUrl` (`bounty.ts:60-62`) — a per-bounty inbox the buyer operates, not an agent-scoped service endpoint. `reputation-design-questions.md:128-135` names this as the Stellar-wide gap and the SDF ask. Correct diagnosis, unbuilt. |
| C2 | reputation costly to fake, multi-input, behaviour-grounded (Circle, CGI) | not built. `docs/reputation-design-questions.md` is a real design doc with a real Sybil cost estimate (~0.4% of face value to wash-trade). There is **no `src/pay/reputation.*`** | DEF | The deferral is defensible. `SPINE.md:18` advertising a `pay/reputation` module is not — delete the line. (`SPINE.md:16` likewise advertises a `job` CLI verb that does not exist; see D-notes.) |
| C3 | only a real counterparty can leave feedback (8004: anyone *except* the agent's own operators) | N/A — no feedback exists | DEF | — |
| C4 | the record is portable even before the score exists | receipts are a **per-install local JSONL file** (`receipts.ts:19-22, 96-114`) | ABS | This one is not deferred, it is unnoticed. The stated fallback — "the record accrues while the score waits" — does not hold as built. A file its own owner can delete, or simply never show you, is a log, not a record. `checkLedger` (`:131-144`) detects edits only for whoever already holds the file. Anchoring or publishing receipts is cheap today and impossible to retrofit once the ledger has history (§6, flaw 1). |
| C5 | sybil resistance (CGI, Circle, Nookplot) | nothing | ABS | Acknowledged in the README. |

### D. Payments, custody, settlement

| # | The research demands | What we do (file:line) | V | The honest gap |
|---|---|---|---|---|
| D1 | spending authority bounded without moving custody (Circle) | a smart-account vault holds funds; the agent key sits on a token-scoped rule with an on-chain spending-limit policy; an over-cap draw is refused by the chain and receipted (`vault.ts:110-153`, `:252-311`) | IMPL | Strong row. The refusal classifier at `vault.ts:290-300` — only a *real* cap refusal is receipted as a policy decision, an RPC failure is not — is better than the corpus asks for. |
| D2 | …and revocable | **no revoke, rotate, or rule-removal path exists.** `vault.ts:135` is the only `kit.rules` call in the file | ABS | If the agent key leaks, the human's recourse is to drain the vault faster than the attacker spends the daily cap. Compounded by the owner passkey persisted in plaintext, as the file's own header admits (`vault.ts:17-21`; written at `:158`): disk access gets the *owner* role, not the capped agent role. |
| D3 | per-agent spend policy with containment (Circle; pay.sh's global cap is the weaker version) | per-host ceilings, denies, true allowlist mode, most-specific-rule resolution, `--max-usd` can only tighten (`policy.ts:127-169`); fails closed on an unparseable policy or a NaN ceiling (`policy.ts:38-42, 98-113`) | IMPL | Testnet payments auto-approve without checking asset or amount, branching on the **wallet's** network (`policy.ts:33-34`) — but the guard in front (`:28-32`) refuses any offer whose network differs from the wallet's, so a pubnet offer cannot ride a testnet wallet's no-value approval. That guard exempts offers advertising the bare network `stellar` (`:28`), which `curl.ts:195-203` has to catch separately. |
| D4 | settlement final, programmatic, global, neutral (Circle) | on x402/MPP the caller only ever sees the post-payment response — `payFetch` approves, hands off to the protocol client, returns the retried response (`curl.ts:228,286`). Bait-and-switch is pinned: the MPP `onChallenge` network gate (`curl.ts:181-203`) and the x402 requirements selector (`:244-270`) | PART | We never verify settlement ourselves, and the settlement hash can come back **null** on both paths (`curl.ts:167,234,287-298`). Whether settlement is final before the body is served is the seller's/facilitator's behaviour, not something we check. |
| D5 | a receipt any third party can verify (the receipt-as-first-class-artifact framing shared with PGTR) | `verifyOnChain` checks a receipt against Horizon rather than our ledger: transaction found and successful, plus — **only when the row carries both a payee and an amount** — an `account_credited` effect crediting that payee that base-unit amount (`receipts.ts:161-198`) | PART | It never compares the credited **asset**, and `toBase` (`:181-184`) hard-codes 7 decimals. Rows without payee/amount — every job-deliver / job-approve / job-dispute row (`job.ts:230-238, 251-259, 293-301`) — return `ok:true` on tx-succeeded alone. |
| D6 | payment receipt as *authorization* (ERC-8194 PGTR) | nothing in the system accepts a receipt as authority to act | ABS | `receipts.ts:6-10` cites "the PGTR pattern, ERC-8194". The citation is **imprecise rather than false**: PGTR is an authorization primitive (a payment receipt standing in for a signature on a relayed transaction); ours is settlement evidence. We share the premise, not the mechanism. ERC-8194 has no page on eips.ethereum.org (404), so the citation should point at the authors' repo, and **ERC-8195 is the closer analogue to our bounty layer**. |
| D7 | payment flows backward through contribution chains (CGI); ranked basis-point payouts (8195) | receipt rows carry a `refs` array of prior receipt ids, and the open→fund→deliver→approve→release chain links each step to its predecessor (`receipts.ts:67-68`; `job.ts:211,235,256,277`) | PART | **The lineage exists; the money does not follow it.** The rails accept `Array<[string, bigint]>` distributions (`job.ts:308`) and every call site passes exactly one entry (`resolver.ts:152`, `bounty.ts:470`). And the chain breaks at both ends: dispute / resolve-dispute refs are optional (`job.ts:298,322`), the terminal `job-resolved` receipts carry **no refs at all** (`resolver.ts:158`, `bounty.ts:475`), and `resolveJob`'s release path calls `approveJob` with `prevReceiptId: o.prevReceiptId ?? ""` (`resolver.ts:120`) — writing `refs:[""]`, a link to a receipt that does not exist. The audit lineage breaks exactly where the money moves. |
| D8 | high-frequency metering without a settle per call | one-way channels: funded once with a 5 XLM default deposit (`session.ts:48,82`), `openChannel` refuses any non-testnet wallet (`:72-75`) and any second channel for a host (`:77-81`); off-chain cumulative commitments settling at close (`session.ts:5-12`, `:196-221`). 10× measured (`ROADMAP.md:17-24` — their measurement, not re-run here) | IMPL | Exposure to a seller is bounded by the deposit **if the one-way-channel contract behaves as one-way channels do**. That contract is a third-party wasm deployed by hash, "uploaded by the stellar-mpp-sdk demo" (`session.ts:43-46`), unaudited by its own README and unread by us — the bound is a design property we rely on, not one we enforce or have verified. In practice the per-host bound is sticky: `dropChannel` (`session-store.ts:148`) has **no callers**, so a closed channel is never cleared from the registry. |
| D9 | both sides of a channel, so peers can pay each other | the shipped agent surface is payer-only: `session.ts` exports `openChannel`/`sessionFetch`/`closeChannel`, nothing recipient-side | ABS | A working seller exists in-repo only as the sandbox (`sandbox-server/server.ts:87-105` — MPP SDK channel middleware, in-memory state, `feePayer: { envelopeSigner: seller }`); the durable seller pieces, the operator settle loop and settle-without-close, are listed as remaining (`ROADMAP.md:32`). **A stellar-pay agent cannot yet earn through channels.** |

### E. Confidentiality — CGI's first three mechanisms

| # | The research demands | What we do | V |
|---|---|---|---|
| E1 | access without transfer — compute over a private asset, return a bounded output | nothing | ABS |
| E2 | conditional recall — inspection must not become permanent knowledge transfer | nothing | ABS |
| E3 | superset-state intermediary — the mechanism sees more and reveals less | nothing; the resolver sees exactly what is public | ABS |

Consequence, stated plainly: the agreement, the review question, the allowed-evidence list and the
worker's full evidence document all sit on a public chain in the clear (`job.ts:144-148`,
`bounty.ts:171-185`). For a human paying an agent to work on anything private — a document, a
customer list, an internal URL — that is disqualifying, not merely incomplete. Three of CGI's five
mechanisms are about exactly this and we score zero on all three.

### F. Discovery and liveness

| # | The research demands | What we do (file:line) | V | The honest gap |
|---|---|---|---|---|
| F1 | open index, public methodology, permissionless inclusion, competing rankers (Circle) | for **endpoints**: a probed catalog with per-row liveness, published as an orphan git branch anyone can read (`catalog.ts:26-34`), plus a self-serve seller check (`verify.ts`) | IMPL | We index supply of endpoints. We rank nothing — which is consistent with B4. |
| F2 | freshness enforced, not claimed | the catalog carries `lastStatus`/`lastCheckedAt`/`lastPaidAt`/`consecutiveFailures` (`catalog.ts:27-32`), the default view enforces a 48h window (`catalog.ts:143-148`), and **the cadence lives in this repository**: `.github/workflows/probe.yml` runs `src/probe.ts --execute` on `cron: "40 5 * * *"` then force-pushes the snapshot to the orphan `catalog` branch the CLI/MCP read; `.github/workflows/canary.yml` probes the deployed sandbox hourly (`cron: "37 * * * *"`) | IMPL | None. This is a real strength and was nearly mis-filed as a gap. |
| F3 | a published, versioned work-discovery format | the bounty feed — a bare array or `{bounties:[{contractId, descriptor}]}`, no envelope, no version, no format identifier, rows shape-filtered on two fields (`worker.ts:55-78`) — is the only discovery format we **define** | ABS | **We only consume it.** Nothing in the repo publishes a feed; the sole writer of one is the sandbox harness (`src/sandbox/marketplace-test.ts:79`). Every buyer must operate a server to be hireable, and a worker has no way to find feeds. |
| F4 | an index of agents | nothing | ABS | Circle's missing layer is still missing here. |

**Tally: 11 IMPLEMENTED · 6 PARTIAL · 19 ABSENT · 2 DELIBERATELY-DEFERRED (38 mechanisms).**

## 4. Where we disagree with the research, and why we think we are right

**(a) Staked identity vs an evidence portfolio.** Nookplot, CGI's challenge market and 8195's Claim
mode all say the entry ticket should cost something. `reputation-design-questions.md:44-75` argues
instead for a multi-tier evidence portfolio with no stake gate, so entry stays permissionless.

We side with us — **for the buyer-picks-the-worker case only**, and we have over-generalised the
argument. In human→agent hiring a stake requirement freezes out exactly the new agents a thin market
needs; evidence-portfolio is right there. It does not transfer to **open-claim races**, where nobody
picks anyone and the only thing between the resolver and a thousand junk packets is `pickWinner`
iterating an array (`bounty.ts:379-424`). A refundable **per-submission bond** — returned on a valid
submission, forfeit on an invalid one — is the narrowly-correct version of the corpus's demand and
does not compromise permissionless entry, because it is per-submission and not per-identity. We
currently pay for the "no stake" position with an unbounded free-flood surface and file it as a
Sybil gap; it is a missing-bond gap.

**(b) Reputation as a score vs as a record.** Nulucre ships a 0-100 number as a paid oracle; Circle
warns the number is the manipulable part. We choose record-over-score.

We side with us on the substance and against us on the execution. Deferring the *score* is right —
the wash-trading math in our own doc is convincing. But the fallback claim, repeated in `SPINE.md`
and the README, is not true of the code as built (C4): the record is a local file. A record only one
party can see, delete, or withhold is not a substrate. The deferral is honest only if the record is
portable, and today it is not. Publishing or anchoring receipts is the cheap half of the reputation
problem and we have skipped it while taking credit for it.

**(c) "Disputes are an optional extension" (8195) vs "the dispute path IS the refund path" (us).**
ERC-8195 deliberately keeps `Disputed` out of the core status enum and guarantees expiry refunds
*around* disputes. We did the opposite: our only refund route runs *through* a dispute
(`resolver.ts:131-146`), and for an open bounty `resolveOpenBounty` throws before it can pay even a
valid winner unless the buyer has already disputed (`bounty.ts:451-464`).

We side hard with the corpus. Our choice was forced by the escrow's role model, not chosen — the
contract forbids the dispute_resolver from disputing its own escrow (`resolver.ts:85-90`), which is
itself sound. But the consequence is that a buyer who posts a bounty, escrows real money and then
goes offline strands both their own funds and every honest worker's payout, with no deadline to fall
back on because nothing reads the agreement's `deadline` (A7). 8195's instinct — fund recovery must
never depend on the dispute machinery working or on any counterparty being alive — is correct, and a
rails constraint pushing us the other way is an argument for the rails seam earning its keep sooner.

**(d) Circle's "ranking never holds funds" vs our resolver holding everything.** We cite this
principle approvingly in `SPINE.md:83-88` and then concentrate approver + release_signer +
dispute_resolver in one keypair (B6). We side with Circle. The separation we actually implement —
reputation from adjudication — costs us nothing, because reputation does not exist. The separation
that would cost us something, approval from dispute resolution, we did not make.

## 5. Agent-to-agent

### What already works with no human in the loop

- **The worker half is already A2A.** `src/sandbox/marketplace-test.ts` spawns a separate process
  with its own key and its own receipts ledger, hands it a feed URL, and it discovers work, refuses
  a decoy listing claiming 10× the real payout, does live verification work, submits a signed
  packet, and confirms it was credited pot − 0.3%. Not a mock.
- **Chain-vetted listings** mean the feed does not have to be trusted: six checks against escrow
  state, including re-deriving the terms hash from the descriptor alone (`worker.ts:82-138`).
- **The authority root is a human-signed on-chain rule, not a human.** A person deploys a smart
  account, installs a spending-limit rule and walks away; the rule outlives the session, the
  process, and an agent-key compromise (`vault.ts:120-153`). That is the correct A2A shape — the
  human is upstream in *time*, not in the loop.
- **Fail-closed headless behaviour.** The TTY prompt is skipped two ways with opposite results:
  under `--yes` the CLI falls through to the policy decision (`cli.ts:1419-1425`), and under a
  non-TTY invocation without `--yes`, `ask()` returns false (`cli.ts:293-294`) so the payment is
  **refused outright** rather than policy-evaluated. Headless mainnet paying requires `--yes`;
  headless without it fails closed.
- **Custody composes.** One install wallet both earns and spends: the worker verbs and the paying
  curl path both use whatever account `ensureSecretLoaded`/`loadWallet` resolves (`cli.ts:1115`,
  `:1390-1391`) and `payFetch` signs with that same keypair (`curl.ts:106-117`).

### What breaks when the human leaves the loop

| Layer | What breaks | Where |
|---|---|---|
| Approval | The MCP surface never prompts a person: `approveGate` decides on policy alone — network match, USDC, per-call ceiling, per-host rule, session budget — and its two human-escalation branches are **inert**, because `askHuman` can never reach a client | `mcp.ts:200-227` (:213, :219), `mcp.ts:270` `const mcp: McpServer \| null = null` and never assigned |
| Authority | The on-chain cap bounds **withdrawals from the vault**, not total agent spend. Income credited directly to the agent's classic key is spendable without the cap ever being consulted. **This is already true of our own earn side today**, before any A2A scenario; it gets structurally larger in A2A, where an agent's income is mostly not its owner's treasury | `vault.ts:283-289` vs `worker.ts:294-302` |
| Evidence | Anyone who *receives* a packet can re-sign the identical evidence under their own key and submit a valid competing claim. Evidence theft is prevented only by arrival order, not by cryptography | `bounty.ts:302-309` (digest omits the worker address), `:394-408` |
| Liveness | A vanished counterparty freezes the pot forever: no expiry, no cancel, refund only through a dispute someone else must raise | `agreement.ts:76` vs `:113-137`; `resolver.ts:131-146`; `bounty.ts:451-464` |
| Discovery | Nothing publishes a feed. Every buyer must run a server to be hireable | `worker.ts:55-78` consumes only; sole writer is `sandbox/marketplace-test.ts:79` |
| Earning | An agent cannot receive channel payments — the shipped surface is payer-only | `session.ts`; `ROADMAP.md:32` |
| Attribution | The earn-side receipts carry **no `refs`**, so the ledger cannot answer "which job's income funded this hire?" — the defining A2A question, and the exact CGI mechanism `receipts.ts:11-14` calls "cheap now, impossible to retrofit later" | `worker.ts:185-194`, `:294-302` |
| Composition | Escrow roles are frozen at init, so A-subcontracts-to-B is two unlinked escrows: A must fund escrow 2 from its own balance before escrow 1 releases, and if B fails A is still fully on the hook | `rails-trustless-work.ts:88-100` |
| Surface | Neither the MCP nor the CLI has a `job_*` verb: no way to open a job with your own terms, review question, or resolver policy from either surface — that is library-only. The escrow **lifecycle** is reachable from both through the bounty wrapper's fixed agreement and schema policy: `bounty_assign`/`bounty_open` (open+fund), `bounty_submit` (deliver), `bounty_dispute`, `bounty_resolve` | 26 tools in `mcp.ts` (`:908,930,951,997,1023,1031`); `cli.ts:41` imports only `disputeJob`; `cmdBounty` at `cli.ts:1086,1100,1151,1165,1180,1195`; exercised end-to-end only by `sandbox/job-test.ts` and `sandbox/resolver-test.ts` |
| Segregation | By default one wallet both earns and spends. The keystore *does* support multiple named accounts (`--account work` beats the environment), so separation is possible manually — but nothing in the code distinguishes an earnings key from a spend key or routes income anywhere | `keystore.ts:334-420` |

### Ranked roadmap — smallest unlocks first

1. **Bind the worker address into the submission digest.** `sha256(contractId | worker | evidence)`,
   plus a re-sign test that actually models the attack. ~1 line in `submissionDigest`
   (`bounty.ts:302-309`). Correct the three artifacts that assert the opposite at source before this
   reaches partners: the comment at `bounty.ts:277-279`, `ROADMAP.md:108`, and
   `sandbox/bounty-open-test.ts:125-126`. *Why first: it is a live defect, it is one line, and every
   A2A discovery story requires a third-party submission transport — the only thing currently
   standing between a worker and evidence theft.*
2. **Make the deadline mean something.** Have `parseAgreement` return `deadline`
   (`agreement.ts:113-137`) and add to the resolver: past deadline with no evidence → refund; past
   deadline with valid evidence and no dispute → release (`resolver.ts:98-114`). ~15 lines, no
   contract change, no new role. *Why: it removes the counterparty-vanished failure that only exists
   once nobody is watching. A human notices a frozen pot; two agents do not.*
3. **Route earned income behind the cap.** On a successful `awaitPayout`, optionally sweep the credit
   into the vault via the existing `topupVault` (`vault.ts:183-247`). ~5 lines. *Why: without it the
   vault's headline claim — the chain enforces the cap — silently stopped being true the moment the
   worker layer started working.*
4. **Fix the receipt chain.** `refs` on the earn-side rows (`worker.ts:185-194`, `:294-302`), on the
   terminal `job-resolved` rows (`resolver.ts:158`, `bounty.ts:475`), and kill the `refs:[""]` at
   `resolver.ts:120`. ~6 lines, and the receipts module already says it is impossible to retrofit.
5. **Resolve the MCP human-escalation honesty defect.** Either assign `mcp` in `buildServer()` or
   delete `askHuman` and state plainly that the MCP surface is policy-governed with no human in the
   loop (`mcp.ts:270, 291-323`). *The correct answer is also the more interesting one for A2A.*
6. **Derive `network` instead of hardcoding it** — 18 receipt call sites plus the agreement builder
   (§6, flaw 2). Mainnet correctness first; CAIP-10 subjects fall out free.
7. **Charge for submission.** The descriptor's `submitUrl` is already a buyer-operated URL
   (`bounty.ts:60-62`); document and demo it answering 402, and add a fee-proportionality check to
   `checkListing` (`worker.ts:82-138`) so a worker refuses a bounty whose entry fee is a rip-off.
   State the perverse incentive plainly — a buyer profits from rejects, so the fee cap and a public
   accept/reject record are part of the feature, not polish.
8. **Publish a versioned feed + an aggregator.** Give the feed an envelope
   (`{format:"stellar-pay/bounty-feed-v1", bounties:[...]}`) and ship a program that fetches N feeds
   and re-serves the union. Because every row is vetted against the chain, a malicious aggregator can
   lie only by omission. Not a marketplace: we hold adjudication, and ranking would put us on both
   sides of Circle's line.
9. **Two asks, not builds.** (a) Back-to-back escrow — a provider's payout conditioned on or assigned
   into a second escrow; that is a rails capability (`rails-trustless-work.ts:88-100`) and belongs in
   the TW/SDF conversation next to the audit ask. (b) The MPP channel registration handshake and the
   seller settle loop (`session.ts:14-17`, `ROADMAP.md:32`) — the receiving half of channels is what
   makes agents peers rather than customers, and part of it is upstream.

**Deliberately not on this list:** reputation (the design-phase argument still holds), a ranked
marketplace, a bonded-arbiter *market* (that is a platform — the resolver role is already swappable
per job, `job.ts:52-55`, which is the neutral half; the bonding is somebody else's product), and
streaming payment as a distinct feature (cumulative commitments already are a stream sampled at
request boundaries).

## 6. Standards interop

**Position: yes to *readable*, no to *joined*.** Every standard in the corpus with an on-chain
component is EVM-native — keccak preimages, `uint256` chain ids, ERC-721 token ids, Solidity
interfaces. Joining means renting an EVM contract or authoring a Soroban one, and we do neither.
Readability costs nothing and is won entirely inside our own files.

### The mapping

| Our artifact | Their container | Verdict | The delta |
|---|---|---|---|
| agreement doc + sha256 `engagement_id` | Ricardian / autocontracts | **EXPORTABLE** | Same five sections in the same order. Our terms hash is `0x` + sha256(utf8 document bytes); autocontracts specifies keccak256 over a similar preimage discipline. Our canonicalization (`agreement.ts:54-56`) is a **strict tightening** of theirs: both normalize to LF and forbid a BOM, but autocontracts permits either no trailing newline or exactly one after the final **non-whitespace** character, while we always emit exactly one and strip only trailing newlines — trailing spaces or tabs stay in our preimage. Compatible in spirit; not the same rule, and a different hash function. Our `network: stellar:testnet` is strictly better than their EVM-only integer `chain_id`. |
| bounty descriptor + escrow | ERC-8195 `Task` | **ADAPTABLE** | Near one-to-one by rename, and our `engagement_id` already does `taskId`'s job better — it commits to the *terms* rather than to a counter. Missing: `expiryTime`, `contentHash`/`contentURI`, and a worker agent id. Our evidence is a JSON document written on-chain, not a write-once `bytes32` — richer, not compatible. |
| receipts ledger | ERC-8004 feedback / validation file | **ADAPTABLE**, blocked on two fields | `at`→`createdAt`, `payer`+`network`→`clientAddress` (CAIP-10, once network is honest), `tx`/`payer`/`payee`/`network`→`proofOfPayment`, resolver `policyLabel`→`tag`. Missing a **subject** (we key on a raw G-address only inside payer/payee) and an **author** (receipts carry no signature). Both are blocked by content-addressing — see flaw 1. |
| escrow rails seam | any other escrow primitive | **ADAPTABLE internally / INCOMPATIBLE with EVM task contracts** | Shaped by Trustless Work: `feeAddress` in `releaseFunds()` and `resolveDispute()` (`rails.ts:78,85`), integer `index` milestones (`:65,72`), `milestoneStatus` on `EscrowState` (`:43`). A non-TW rails must fake or ignore those three. `engagementId` (`:53-54`) is the exception — our own sha256 terms address, documented as cross-ecosystem; any rails would want to carry it. |
| bounty feed | pay.sh's `skills.json` catalog envelope | **ALIGNED 2026-08-30** | Now `stellar-pay/bounty-feed-v1` with `schema_version` and `generated_at` — pay.sh's own field names for the same two ideas, rather than a private spelling. `buildFeed()` authors one and `bounty feed` publishes it, so we are no longer consume-only; an unknown `schema_version` is refused instead of guessed. |
| submission packet | ERC-8195 claim/submission | **ADAPTABLE** | One-to-one by rename except that our evidence is a JSON document, not a write-once `bytes32` deliverable hash. |
| commit packet | *(none found)* | **OURS, BY ABSENCE** | ERC-8195's five modes (Bounty, Claim, Pitch, Benchmark, Auction) specify no commit-reveal; Ricardian practice covers the agreement, not submission ordering; pay.sh has no work layer. Searched before minting, recorded in `bounty.ts`. The digest already commits to (format, contract, worker, evidence, nonce), so adopting a future spec is a serialization change. |

### Align now / design toward / ignore

**Now** — four fixes, each a defect that happens also to be an interop win. They pass the test of
being worth doing *even if we ignore every standard in this report.*

1. **Derive `network` instead of hardcoding `"stellar:testnet"`** — the agreement builder
   (`job.ts:82`) and **18 receipt call sites**: 7 in `job.ts` (152, 206, 232, 253, 275, 295, 319), 3
   in `bounty.ts`, 2 in `worker.ts`, 1 in `resolver.ts`, 5 in `vault.ts`. (`job.ts:82` is a ninth
   hardcode but it is the agreement's network field, not a receipt; `vault.ts:54` is a type
   declaration.) A mainnet job would pin a document asserting testnet and write a ledger that lies.
2. **Fix the submission signature** — bind the worker address (§5 item 1), add a domain-separation
   tag, include the network and the descriptor/engagement hash, cover `signedAt`, hash canonical
   JSON. There are **zero external signers today**: this is a breaking change now and an impossible
   one later.
3. **Widen receipt ids to the full sha256** (`receipts.ts:79-83` truncates to 16 hex chars = 64
   bits) and canonicalize nested `detail`.
4. **Promote `engagementId` and `contractId` to typed receipt fields** out of the untyped `detail`
   bag. This is *the* join key every external container needs, and it already exists.

**Design toward, build nothing.** An 8004-shaped export of receipts (after fixes 1 and 4 it is a
pure serialisation — write no exporter, no registry integration; the constraint is only "do not add
a field that makes this mapping impossible"). The descriptor as an 8195-shaped task object (also a
pure rename given a stable id; add `expiryTime` on its own merits). A versioned feed envelope.
x402's `upto` inherited by dependency bump when `@x402/stellar` ships it — **no Stellar variant
exists**, only `scheme_upto_evm.md`.

**Ignore.** ERC-8004's on-chain registries (containers, not credibility — export toward the
container, never join the registry). ERC-8195 as an escrow or settlement layer (different chain,
keccak ids, a contract we would have to author; its value is as a vocabulary check). Emitting
`auto.contracts/v1` (already correctly rejected at `agreement.ts:4-12`; borrow their frontmatter
vocabulary instead). ClawBank as a wire format (it is a legal-entity + e-signature layer). Nulucre
as a spine signal (a live oracle, not a schema). And **do not adopt "Stellar 8004"** — it is one
hackathon team's three Soroban contracts, not an SDF standard, not a SEP, not mainnet. There is no
Stellar agent-identity standard to align with yet.

### Format flaws that would block future interop

Ranked by cost-to-fix-later.

1. **Content-addressed receipt ids make every field addition retroactively breaking.** Adding a
   subject, a signature, or a promoted `engagementId` after the ledger has history re-ids every row
   and severs every `refs` edge (`receipts.ts:73-83`). The window is now, at the smallest ledger we
   will ever have.
2. **`network` is a hardcoded literal** in the agreement builder and every work-layer receipt (18
   sites). A correctness bug before it is an interop bug, and it silently blocks CAIP-10 derivation.
3. **The submission digest binds too little** — no worker address (the live defect, B9), no
   domain-separation tag, no network, no descriptor hash. `signedAt` is set *outside* the signed
   digest (`bounty.ts:367` signs, `:372` assigns), so the packet's own timestamp is unauthenticated
   and any relay can rewrite it. Nothing reads it today — grep finds only the type declaration and
   the write, and `pickWinner` tiebreaks on array order — so that half is a **latent** hazard, live
   the moment settlement ordering keys on the timestamp.
4. **The rails provider is baked into the hashed terms — but not the way you would guess.** The
   Terms section hardcodes "Settlement rails: Trustless Work single-release escrow … Trustless Work
   protocol fee: 0.3%." (`agreement.ts:87`) as a template literal that **never consults the rails
   binding**. So swapping rails via `setRails()` (`job.ts:38-40`) leaves the agreement bytes and the
   `engagement_id` hash completely unchanged — and a non-TW rails would silently pin a document
   asserting a settlement provider and a 0.3% fee it does not use.
5. **The rails dispatch is genuinely clean; the seam is not free.** `job.ts` holds a single
   module-level `rails` binding (`:36-43`) and all nine on-chain calls route through it (144, 198,
   223, 246, 268, 289, 311, 337, 348). But swapping providers is more than a new file plus
   `setRails()`: `twFeeAddress` is still a required `JobSpec` field (`job.ts:64`) threaded through
   `resolver.ts:80,126,151` and `bounty.ts:122,235,469`, `job.ts:33` re-exports
   `TW_ESCROW_WASM_HASH`, and the agreement bytes still name TW (flaw 4).
6. **Price lives in prose, not frontmatter** (`agreement.ts:87`). A machine reader must regex the
   Terms section to learn amount and asset; autocontracts reserves `amount`/`currency` for this.
7. **`deadline` is written and never read** (A7). Compare 8195's `expiryTime` + permissionless
   `refundExpired`. Ours is decoration.
8. **The bounty descriptor has no id, no hash, no standalone version key and no expiry of its own.**
   It carries `format, kind, title, items[], instructions, amount, tokenContract,
   maxEvidenceAgeDays, resolver, buyer` and optional `submitUrl` (`bounty.ts:43-63`). The version is
   embedded in the format literal `stellar-pay/bounty-v1` (`:44`); there is no separate version key.
   `maxEvidenceAgeDays` (`:54-55`) bounds evidence freshness, not the bounty's life.
9. **`EvidenceEntry.item` is a free string, not a URI** (`bounty.ts:163-169`) — a slug meaningful
   only to whoever posted the bounty, so evidence is not reusable outside one buyer.
10. **The feed has no envelope or version** (F3) — the least self-describing artifact we have, and
    the only one intended for strangers.
11. **No subject identifier anywhere** (C1). Correct for today; named so it is a known gap. After
    fix 1 the G-address becomes a valid CAIP-10 subject, which is enough to bind to whatever
    identity layer eventually lands.
12. **`refs` do not join across parties** — 16-char ids local to one machine's ledger, so two
    counterparties to the same job produce two ledgers that do not join. Fix 4 (a promoted
    `engagementId`) is the cheapest partial answer.

One documentation defect found in the same sweep: `ROADMAP.md:126-129` claims "the catalog already
records `scheme` per endpoint" — the Mongo row and the probe do (`store.ts:15`, `probe.ts:213`) but
the published snapshot drops it (`catalog.ts:16-34`), so the `upto` inheritance story has a hole on
the export path. And `SPINE.md:16,18` advertise a `job` CLI verb and a `pay/reputation` module that
do not exist (`cli.ts` command map has no `job`; `ls src/pay/` has no reputation file).

## 7. Where this is going

Human-to-agent commerce is the wedge because the hard part is not payment — payment is table stakes,
and we already do it three ways. The hard part is a stranger being willing to hand money to software
before the work exists, and that needs a hold-verify-release primitive with terms the chain pins,
a judge whose basis is recorded, and a receipt anyone can check. We have that primitive on testnet,
and the worker half of it already runs with no human anywhere: a separate process with its own key
finds work from a feed, refuses a tampered listing, does the work and collects. Agent-to-agent is the
destination, and the honest statement is that the substrate composes but the guarantees do not yet.
Four things have to become true before the second case works. The authority root has to keep binding
when an agent earns its own money, which today it does not — the on-chain cap governs draws from the
vault, not income credited straight to the agent's key. A stuck job has to terminate on its own,
which today it cannot, because the deadline we write into every agreement is read by nothing and the
only refund path runs through a dispute some human has to raise. Work has to be bound to the party
who did it, which today it is not: the submission digest omits the worker address, so the only thing
stopping evidence theft is arrival order. And submitting has to cost something, or an open race with
free identities is a spam market waiting for its first spammer. None of those four is a research
project; the largest is about fifteen lines. What is a research project — economic skin in the game,
a challenge market, a bonded arbiter, portable identity, confidentiality — we do not have at all, and
this document is where that stays written down instead of quietly rounding up to PARTIAL.
