<p align="center"><b>stellar-pay</b></p>
<p align="center"><b>The neutral payment layer for agents on Stellar.</b><br>Find a paid API, pay its 402 in USDC from your own wallet, get the data — from a CLI or an MCP, over a catalog probed daily for what a Stellar wallet can actually pay.</p>
<p align="center"><i>Inspired by Solana's <a href="https://github.com/solana-foundation/pay">pay.sh</a>: an HTTP client that settles 402s in stablecoins. Built on Stellar's own rails.</i></p>

---

```sh
# A paid API answers 402 Payment Required
curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'

# stellar-pay reads the terms from that 402, asks you, pays in USDC, returns the answer
stellar-pay curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'
```

## Why this exists

The rails for agent payments on Stellar are done — SDF's MPP charge spec and
x402 both settle real USDC today. What's missing sits one layer up:

- **No neutral client.** The wallets that exist are tied to one router or one
  gateway. An agent that wants to pay *any* paid API — whichever host, whoever
  built it — from *its own* wallet has nowhere to go.
- **No honest catalog.** Registries list endpoints that died months ago, and
  "supports x402" says nothing about Stellar: the same standard runs on Base,
  Solana and Polygon, and most servers name only those. Of pay.sh's 38
  providers, **none** take `stellar:pubnet`; of the x402 Bazaar's 1,611 hosts,
  **three** do. A listing is not supply.
- **No spend governance.** Paying per HTTP call is new enough that nothing
  stops an agent buying the same thing twice, or paying into a provider that
  just failed.

stellar-pay is those three things, and nothing else: a **router-agnostic
client**, a **probed catalog**, and **outcome-attributed spend control** — a
neutral layer that consumes every supplier rather than being one.

## Neutral by design — it consumes routers, it isn't one

A router (like [mpp-router](https://www.mpprouter.dev/)) proxies many upstream
APIs behind one gateway and takes the payment itself. That's real supply —
and mpp-router is the single largest source in this catalog. But it's one
gateway with one inventory and one operator.

stellar-pay sits above all of them. It pays *any* host from the **user's own
wallet** — mpp-router, the x402 Bazaar, a provider serving its own 402 —
and indexes every source together. No gateway in the middle, no operator's
cut, no lock-in. That neutrality is the point: it's public-good infrastructure
on SDF's own rails, not a product competing with the suppliers it reads from.

## What happens on a 402

The server's challenge carries the price, the token, the recipient and the
network. `stellar-pay` reads it, shows it, and signs only after approval. On
Stellar the client signs **authorization entries**, not a whole transaction:
the server (or its facilitator) assembles and submits, and pays the fee. Your
wallet holds USDC and nothing else — no XLM, no sequence numbers, no RPC.

Both live Stellar standards are handled:

- **MPP, Stellar charge method** — [draft-stellar-charge-00](https://paymentauth.org/draft-stellar-charge-00), SDF's spec (Aug 2026). No facilitator; the server settles.
- **x402 on Stellar** — the `exact` scheme, settled through the OpenZeppelin Channels facilitator.

## The catalog is evidence, not a listing

An entry is in the catalog because it **answered a real 402 naming
`stellar:pubnet` within the last day** — re-probed daily, carrying its price,
protocol, the method that produced the challenge, and how long it has been
alive. About **390 endpoints** qualify today across the x402 Bazaar and
mpp-router. If it's in the catalog, your wallet can pay for it right now; the
live 402 is still the authority on price.

Using the catalog needs no secret: the daily job publishes a snapshot to the
`catalog` branch, and the client reads it through your own `gh` auth. The
probe job is the only thing that touches the database.

## Spend governance — pay for what's used, not what's asked

Two layers, composed. An always-on **approve gate**: on mainnet a payment must
be USDC and within a per-call ceiling. And, inside a task, **[Scrimp](https://github.com/kaankacar/scrimp)**
(by Kaan Kacar) — outcome-attributed control that a budget cap can't match:

- a request already bought in this task is **replayed free**, not paid twice;
- one re-fetched inside its freshness window is replayed free;
- a provider that just failed repeatedly is **quarantined**;
- and every purchase is labelled **wasted** if its response body was never read.

`spend_report` shows what was spent versus what an ungoverned client would
have paid, and the waste rate. Proven on testnet: pay once, ask the same URL
again in a task → replayed free, one on-chain payment for two calls.

## For agents: MCP, Claude Code, Raven

An MCP server gives agents the whole loop under that governance:

```sh
stellar-pay claude            # Claude Code with stellar-pay mounted
stellar-pay mcp               # stdio server for Claude Desktop, Cursor, Codex, or your own client
```

Tools: `search_catalog`, `get_catalog_entry`, `list_catalog`, `curl`,
`get_balance`, `begin_task` / `end_task`, `spend_report`, plus the wallet
basics `send_usdc` (two-step confirm so funds never move on one model call) and
`get_history`. The agent-facing
playbook is [`skills/stellar-pay/SKILL.md`](skills/stellar-pay/SKILL.md).

**Raven.** [Raven](https://github.com/stellar-experimental/stellar-raven) is
the Stellar ecosystem's agent gateway — one MCP that routes an agent's
question to the right Stellar service, already routing to Stellar Light's
Scout. stellar-pay is built to mount the same way: catalog search through
Raven's routing, paid calls through a wallet under the same spend governance.

## Install & use

Private alpha — from source:

```sh
git clone https://github.com/Stellar-Light/stellar-pay && cd stellar-pay
npm install                    # .npmrc sets legacy-peer-deps: @x402/stellar and @stellar/mpp pin different stellar-sdk majors; both run on 16
```

```sh
export STELLAR_SECRET_KEY=S...  # a wallet holding USDC; STELLAR_NETWORK defaults to stellar:pubnet, --sandbox uses testnet
stellar-pay whoami
stellar-pay balance
stellar-pay offers  https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{}'   # what it asks — pays nothing
stellar-pay curl    https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{"query":"stellar x402"}'
stellar-pay curl <url> --yes --max-usd 0.05   # unattended, under a ceiling

stellar-pay setup                             # new wallet (testnet: funded + USDC trustline)
stellar-pay send <G...address> --amount 1.5   # send USDC to an address (confirms first)
stellar-pay history                           # recent USDC payments to/from the wallet
```

## Proof you can run

- `npm run sandbox` — mints its own SEP-41 asset on testnet, deploys its
  contract, runs a local MPP charge server, pays it, and checks the settlement
  on-chain. No USDC touched.
- `npm run test:mcp` — drives every MCP tool over stdio and ends with a paid
  call plus a deduped replay through the governance layer.

## The catalog job

`npm run probe` discovers from the x402 Bazaar and mpp-router and re-probes
everything indexed; `npm run probe:execute` writes; `npm run export`
snapshots. CI runs all three daily and publishes the snapshot to `catalog`.
Only this job needs `DATABASE_URI`.

## Status

Private alpha. Built on `@x402/stellar` and `@stellar/mpp` — SDF's own rails —
and on the measurement that made it necessary: the same x402 standard does not
make an endpoint Stellar-payable, so the catalog probes instead of trusting.
Spend governance vendors [Scrimp](https://github.com/kaankacar/scrimp)
(license pending coordination with the author).

## License

MIT (the stellar-pay code). `vendor/` carries third-party code under its own
terms — see [`vendor/NOTICE.md`](vendor/NOTICE.md).
