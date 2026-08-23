# stellar-x402-index

**The probed index of x402 / MPP endpoints that are payable from a Stellar wallet.**

Private while the lane is new.

## Why this exists

x402 and MPP are shared standards, so "supports x402" tells a Stellar wallet
nothing. The 402 challenge names which networks it accepts, and a caller
holding USDC on Stellar can only pay a door that lists `stellar:pubnet`.

Measured across the whole public surface on 2026-08-22:

| surface | providers / hosts | accept Stellar |
|---|---:|---:|
| pay.sh catalog (challenge readable) | 38 | **0** |
| Coinbase x402 Bazaar | 1,611 hosts | **3** |

The ecosystem has the rails — `@x402/stellar`, `@stellar/mpp`, OpenZeppelin
Channels, Veridex — and no index of what is actually purchasable with them.

The largest multi-network lists in the Bazaar are *identical* across hundreds
of hosts (Algorand, Polygon, Monad, Arbitrum, World, BNB, Base, HyperEVM,
Solana, XRPL). Those sellers did not choose eleven chains; their facilitator
did. Stellar is not in that default, so it reaches nobody by inheritance —
which makes facilitator defaults the highest-leverage fix, not per-seller
outreach.

## What it does

**Discover** — pull candidates from the public registries (Coinbase's x402
Bazaar; Sextant's Stellar-native layer). Registries are discovery only.

**Probe** — request each URL and read the challenge it actually returns. That
is the only evidence an endpoint is payable, and the only way to know which
networks it takes. `accepts` is recorded verbatim.

A listing is not supply. On the first run, every one of Sextant's 20 rows was
an RFC 2606 reserved `.example` host that can never resolve — matching its own
`/health` (27 seeded, 0 live). Those are filtered out, not indexed.

## Discipline

- **Never assert a negative.** No challenge read means we could not see the
  terms — auth wall, wrong method, transport failure — not "unpaid".
- **`outcome` is what we saw**: `paid` (answered a challenge) · `open` (200) ·
  `walled` (401/403, terms invisible) · `absent` (404/410) · `unreachable`.
- **Going dark is kept, never deleted.** An endpoint that stops answering
  keeps its history and gains a `consecutiveMisses` streak — that transition
  is the single most useful thing this index can report.
- **History is why this is a database, not a file.** `firstSeen`, `lastPaid`
  and the miss streak are the product; a regenerated snapshot destroys them.

## Run

```sh
cp .env.example .env      # DATABASE_URI
npm install
npm run probe             # dry run — prints the table, writes nothing
npm run probe:write       # upserts into the paid_endpoints collection
```

## Current picture

209 endpoints answer a live 402 and are payable on Stellar — from **three
hosts**, none of them Stellar-ecosystem teams:

| host | endpoints |
|---|---:|
| agent402.tools | 176 |
| api.carbon-cashmere.de | 19 |
| app.heinrichstech.com | 14 |

That is the whole Stellar-payable surface today. It is the number the rest of
the work is measured against.

## The client (Phase B) — `curl` that pays

pay.sh-shaped: a plain request; on 402 the offers are read from the live
challenge (x402 `accepts[]` and MPP `WWW-Authenticate: Payment`), shown, and
**approved before anything is signed**; then paid from a Stellar wallet and
retried. Both protocols, fees sponsored when the server says so.

```sh
STELLAR_SECRET_KEY=S… npm run pay -- offers  https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{}'
STELLAR_SECRET_KEY=S… npm run pay -- curl    https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{"query":"stellar x402"}'
npm run pay -- balance | whoami            # --yes --max-usd 0.05 for agents, --x402|--mpp to pick a protocol
npm run sandbox                            # automated end-to-end proof on testnet (below)
```

**Proof, automated (`npm run sandbox`):** mints its own SEP-41 asset on
testnet (Circle's USDC faucet is captcha-only), deploys the asset's SAC, runs
SDF's MPP charge server locally priced in it with fees sponsored, pays it via
`payFetch`, and checks the settlement on-chain. Last pass 2026-08-23: 402 →
approved → 200, settlement tx source = the fee payer, payer balance 100 →
99.999. x402's client path is exercised on mainnet only (its server side needs
the OZ Channels facilitator).

Built on the official rails: `@x402/fetch` + `@x402/stellar` (exact-v2,
auth-entry signing) and `@stellar/mpp` (draft-stellar-charge-00, SDF, Aug 2026).

Traps met on the way, so nobody meets them twice: USDC is **7 decimals** on
Stellar; Stellar challenges name USDC by its **SAC address**, not "USDC";
x402 v2 says `amount` where v1 said `maxAmountRequired`; Soroban transactions
carry **exactly one op** and must be simulation-prepared (a classic op bundled
with `createStellarAssetContract` is `tx_malformed`); in MPP pull mode the
client never sees the hash — the receipt comes back in `Payment-Receipt`.
