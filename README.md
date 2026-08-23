<p align="center"><b>stellar-pay</b></p>
<p align="center">Pay for any API from a Stellar wallet — and know, before you try, which ones will actually take it.</p>
<p align="center"><i>Inspired by Solana's <a href="https://github.com/solana-foundation/pay">pay.sh</a>: an HTTP client that settles 402s in stablecoins. Built on Stellar's rails, around a catalog that is probed instead of listed.</i></p>

---

```sh
# Ask a paid API for something and it answers 402 Payment Required
curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'

# stellar-pay reads the terms from that 402, asks you, pays in USDC, and returns the answer
stellar-pay curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'
```

## What happens on a 402

The server's challenge carries the price, the token, the recipient and the
network. `stellar-pay` reads it, shows it to you, and signs only after you
say yes. On Stellar the client signs **authorization entries**, not a whole
transaction: the server (or its facilitator) assembles the transaction, pays
the network fee and submits it. Your wallet holds USDC and nothing else — no
XLM, no sequence numbers, no RPC of your own.

Two payment standards are live on Stellar and both are handled:

- **MPP, Stellar charge method** — [draft-stellar-charge-00](https://paymentauth.org/draft-stellar-charge-00), SDF's spec (August 2026). No facilitator; the server settles.
- **x402 on Stellar** — the `exact` scheme, settled through the OpenZeppelin Channels facilitator.

Most servers that take Stellar sponsor fees in both. The catalog records which.

## The catalog is evidence, not a listing

Every registry of paid APIs is full of endpoints that stopped answering
months ago, and "supports x402" says nothing about whether a *Stellar* wallet
can pay — the same standard runs on Base, Solana and Polygon, and most
servers name only those. So `stellar-pay` does not trust listings. Its
catalog is **re-probed every day**: an entry is in it because it answered a
real 402 naming `stellar:pubnet` within the last day, with its price, its
protocol, the request method that produced the challenge, and how long it
has been alive. About 390 endpoints qualify today, across the x402 Bazaar and
mpp-router. If it is in the catalog, your wallet can pay for it right now;
the live 402 is still the authority on price.

## For agents: MCP, Claude Code, Raven

Agents get the same loop through an MCP server, with a spending policy in
place of the prompt: a ceiling per call and a budget per session, USDC only
on mainnet, and the settlement hash returned with every paid response.

```sh
npm run pay -- claude            # Claude Code with stellar-pay mounted
npm run mcp                      # stdio server for Claude Desktop, Cursor, Codex, or your own client
```

Tools: `search_catalog` (rank live endpoints for a task), `get_catalog_entry`,
`list_catalog`, `curl` (pay a 402 within policy), `get_balance`,
`spend_report`. Policy: `STELLAR_PAY_MAX_USD_PER_CALL` (default 0.05) and
`STELLAR_PAY_SESSION_BUDGET_USD` (default 1.00). The agent-facing playbook is
[`skills/stellar-pay/SKILL.md`](skills/stellar-pay/SKILL.md).

**Raven.** [Raven](https://github.com/stellar-experimental/stellar-raven) is
the Stellar ecosystem's agent gateway: one MCP that routes an agent's question
to the right Stellar service. It already routes to Stellar Light's Scout
services, and `stellar-pay` is built to be mounted the same way — catalog
search through Raven's routing, paid calls through a hosted wallet under the
same spending policy. That is the integration this is heading for once the
catalog is public; Raven does not see it today.

Using the catalog from an agent needs no secret: the daily job publishes a
snapshot to the `catalog` branch of this repo and the MCP reads it through
your `gh` auth.

## Nothing is signed until you say so

Interactive use asks per payment. Agents run under the policy above. The
signer is pluggable: a raw key today; a policy-governed agent wallet with
operator approvals and an audit log — Soneso's
[stellar-agent-wallet](https://github.com/Soneso/stellar-agent-wallet) is the
candidate — once one allows mainnet signing.

## Proof you can run

`npm run sandbox` shows the whole loop on testnet without touching USDC: it
mints its own SEP-41 asset, deploys the asset's contract, runs a local MPP
charge server priced in it with fees sponsored, pays it, and checks the
settlement on-chain. `npm run test:mcp` does the same through the MCP — every
tool over stdio, ending in a paid call.

## Install

Private alpha — from source:

```sh
git clone https://github.com/Stellar-Light/stellar-pay && cd stellar-pay
npm install --legacy-peer-deps      # @x402/stellar and @stellar/mpp pin different stellar-sdk majors; both run on 16
```

## Use

```sh
export STELLAR_SECRET_KEY=S...       # a wallet holding USDC; STELLAR_NETWORK defaults to stellar:pubnet, --sandbox uses testnet
npm run pay -- whoami
npm run pay -- balance

# what an endpoint asks for — pays nothing
npm run pay -- offers https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{}'

# pay for it
npm run pay -- curl https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{"query":"stellar x402"}'

# unattended, under a ceiling
npm run pay -- curl <url> --yes --max-usd 0.05
```

## The catalog job

`npm run probe` discovers candidates from the x402 Bazaar and mpp-router and
re-probes everything already indexed; `npm run probe:execute` writes;
`npm run export` snapshots. CI runs all three daily and publishes the snapshot
to the `catalog` branch. The job is the only thing that needs `DATABASE_URI`.

## Status

Private alpha. Built on `@x402/stellar` and `@stellar/mpp`, and on the
measurement that made it necessary: of pay.sh's 38 providers, none accept
`stellar:pubnet`; of the Bazaar's 1,611 hosts, three do. The rails exist; the
supply has to be found and proven, which is what the catalog does.

## License

MIT.
