# stellar-pay wire formats

Five formats define the layer **above** payment: how a bounty is described, how
its terms bind to an on-chain escrow, and how a worker claims and proves work.
They are versioned, hashed, and specified here so that a second implementation
— in any language, by anyone — can produce and verify them without reading our
source or installing our package.

**What is not here, on purpose.** Paying a 402 is [x402](https://github.com/x402-foundation/x402)
and [MPP](https://paymentauth.org/draft-stellar-charge-00). Those are other
people's specs and we are a client of them; nothing in this directory redefines
or forks them. The escrow is Trustless Work's Soroban contract, which is theirs.
This document covers only the formats we actually author.

Every value below is reproducible from [`vectors/`](./vectors), which is
generated from the implementation through its public entry point and asserted
in CI (`npm run test:vectors`). If a fixture and the code ever disagree, CI
fails — a spec whose fixtures drift is worse than no spec, because a second
implementer will match bytes we no longer emit and blame themselves.

## Stability

| Rule | |
|---|---|
| A change to any **signed or hashed preimage** is a **version bump**, never an edit | `commit-v1` → `commit-v2` when `committedAt` entered the preimage |
| A parser MUST reject a `format` it does not recognise | unknown version is a refusal, not a best-effort parse |
| Fields marked `$volatile` in a vector are **outside every signature** | do not treat them as authenticated |
| Base units are integers-as-strings; never floats | `"25000000"`, not `25.0` |

---

## 1. `stellar-pay/bounty-v1` — the descriptor

A shareable, off-chain description of work. Authoring it escrows nothing; it is
the object every later step derives from.

| Field | Type | Notes |
|---|---|---|
| `format` | `"stellar-pay/bounty-v1"` | |
| `kind` | `"verification"` | the only kind defined today |
| `title` | string | |
| `items` | string[] | ≥1. Evidence must cover every item **exactly once** |
| `instructions` | string | |
| `amount` | string | base units of `tokenContract` |
| `tokenContract` | string | Soroban SAC address (`C…`) |
| `maxEvidenceAgeDays` | number | freshness bound the resolver enforces |
| `resolver` | string | `G…`. MUST be a third party — see *Decision seats* |
| `buyer` | string | `G…` |
| `deadline` | string? | RFC 3339 with explicit offset. Absent = the agreement's far-future default |
| `submitUrl` | string? | where signed packets POST. **Part of the hashed terms** |

`submitUrl` should be the **resolver's** inbox, not the buyer's. Evidence is
stealable by whoever receives it first, and the buyer is the one party who
profits from stealing it.

## 2. `stellar-pay/agreement-v1` — terms, and the id the chain pins

The descriptor renders to a Markdown document with YAML frontmatter. Its hash
is the escrow's `engagement_id`, which is what makes the terms tamper-evident:
a feed row that disagrees with the escrow cannot survive re-derivation.

```
agreementHash = "0x" + sha256(agreementDocument)      // lowercase hex
```

The document is UTF-8, LF line endings, and is hashed **exactly as rendered** —
no normalisation, no re-serialisation. See
[`vectors/agreement-v1.json`](./vectors/agreement-v1.json) for a complete
document and its hash.

`submitUrl`, when present, appears in the Terms section. Changing where evidence
is delivered therefore changes `engagement_id`, which is the property that stops
a copied listing from redirecting a worker's evidence to an attacker.

## 3. `stellar-pay/commit-v2` — claiming before revealing

A worker publishes a commit **before** the evidence, so a thief who only sees
the evidence at reveal time has nothing to open.

```
evidenceHash = sha256(JSON.stringify(evidence))                       // hex
commitHash   = sha256(
    "stellar-pay/commit-v2" |contractId|worker|evidenceHash|nonce|committedAt
)                                                                     // hex
signature    = base64( ed25519_sign(worker, hex_decode(commitHash)) )
```

`|` is a literal pipe. `nonce` is 32 random bytes, hex. `committedAt` is RFC
3339 and is **inside** the preimage — in `v1` it sat on the packet outside the
signature, where any relay could rewrite it while it still looked authoritative.

**Ordering.** A resolver ranks commits by signed `committedAt`, ascending, ties
broken by ascending `commitHash`. It MUST NOT rank by the order it received
them. Commits dated in the future MUST be discarded.

**Honest limit.** A self-signed timestamp is a *claim*, not an authority: a
worker can date their own commit early, though only for evidence they had
already produced. What the signature buys is that a resolver who ignores the
order can be **caught** by anyone holding two commits. An on-chain commit
mailbox would be the real fix and does not exist yet.

## 4. `stellar-pay/submission-v1` — the evidence packet

```
digest    = sha256( "stellar-pay/submission-v1" |contractId|worker|JSON.stringify(evidence) [|nonce] )
signature = base64( ed25519_sign(worker, digest) )
```

Note the asymmetry with `commit-v2`, which hashes the evidence first and puts
`sha256(JSON.stringify(evidence))` in its preimage. **This one inlines the JSON
directly.** Both are stated as they are implemented rather than as they ought to
be; a spec that tidies up the code is fiction. Unifying them would be a version
bump on both formats.

**Canonicalisation hazard, stated plainly.** Both preimages depend on
`JSON.stringify(evidence)`, so they depend on JavaScript's property order —
insertion order for string keys. A second implementation MUST serialise evidence
objects with keys in the order `item`, `url`, `verdict`, `checkedAt`, `excerpt`,
no whitespace, to reproduce these digests. That is a weakness of the format, not
a feature; a future version should hash a canonical form (sorted keys) instead.
[`vectors/submission-v1.json`](./vectors/submission-v1.json) is the ground truth
to test against.

The nonce is present **iff** the packet is a reveal opening a commit. The digest
covers the worker address, so re-wrapping someone else's packet under a
different address invalidates the signature. It does **not** stop a thief who
re-*signs* stolen evidence with their own key — that is what commit-reveal is
for, and why a resolver requires commits.

`signedAt` is metadata and is **not** in the digest.

## 5. `stellar-pay/bounty-feed-v1` — publishing listings

```json
{ "format": "stellar-pay/bounty-feed-v1", "schema_version": "1",
  "generated_at": "…", "bounties": [ { "contractId": "C…", "descriptor": { … } } ] }
```

Anyone may host a feed; there is deliberately no central board. `generated_at`
is per-publish and unsigned. A consumer MUST refuse an unrecognised
`schema_version`.

---

## What a worker must verify before doing any work

A feed row is a **claim**. The chain is the fact. Before working, re-derive
everything and refuse on any mismatch:

| Check | Fails when |
|---|---|
| `sha256(on-chain description) == engagement_id` | the escrow's own terms were altered |
| `agreementHash(descriptor) == engagement_id` | the feed row disagrees with what was escrowed — including a swapped `submitUrl` |
| `amount`, `tokenContract`, `resolver`, receiver match the escrow struct | the row overstates the pot or names a different judge |
| **decision seats**: `approver == releaseSigner == resolver` | the buyer holds approve/release and can pay themselves after a stranger does the work — the agreement document cannot show this, it renders one `resolver` field |
| escrow balance ≥ `amount` | the bounty is unfunded |

The last two are the ones a careless implementation omits, and they are the two
that cost a worker their work.

## Reproducing the vectors

```bash
npm run vectors        # regenerate from the implementation
npm run test:vectors   # assert the committed files still match
```

The generator imports only from the package's public entry point, so it doubles
as a proof that these formats are reachable by a second party: if a vector needs
something we do not export, generating it fails.
