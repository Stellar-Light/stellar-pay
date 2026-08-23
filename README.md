<p align="center"><b>stellar-pay</b></p>
<p align="center">The missing payment layer for HTTP on Stellar — x402 &amp; MPP payment challenges with user-authorized stablecoin signing.</p>
<p align="center"><i>Inspired by Solana's payment layer, <a href="https://github.com/solana-foundation/pay">pay.sh</a>. Same shape, Stellar rails.</i></p>

---

```sh
# Without stellar-pay — you get a 402
curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'

# With stellar-pay — it reads the challenge, asks you, pays in USDC, returns the response
stellar-pay curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'
```

## Key Features

### 💵 Transparent 402 Handling

When an API returns 402, `stellar-pay` reads the payment challenge, shows you
the price from the live challenge (never from a catalog), asks for approval,
signs the payment from your Stellar wallet, and retries with the proof.

Supports both live payment standards on Stellar:
- **[MPP](https://paymentauth.org/draft-stellar-charge-00)** — Machine Payments Protocol, Stellar charge method (SDF, Aug 2026)
- **[x402](https://x402.org/)** — x402 Payment Protocol, `exact` scheme on Stellar

USDC (the Stellar Asset Contract) out of the box. Servers that sponsor fees —
most do — mean your wallet needs no XLM at all: the client signs authorization
entries, the server assembles and submits.

### 📚 A catalog that is probed, not listed

Registries list endpoints that stopped answering months ago. `stellar-pay`'s
catalog is **re-probed daily**: every entry answered a real 402 naming
`stellar:pubnet` within the last day, with its price, protocol, and how long
it has been alive. Today: ~390 live endpoints across the x402 Bazaar and
mpp-router. If it is in the catalog, a Stellar wallet can pay for it right now.

### 🤖 AI-Native with MCP

`stellar-pay` ships an MCP server, so any MCP client — Claude Code, Claude
Desktop, Cursor, Codex — gets the same loop under a spending policy you set:
`search_catalog` a task, see the price, `curl` it, get the data, with the
settlement hash in the result.

```sh
npm run pay -- claude            # launch Claude Code with stellar-pay mounted (what `pay claude` does)
npm run mcp                      # or serve it on stdio for any other client
```

Tools: `search_catalog`, `get_catalog_entry`, `list_catalog`, `curl`,
`get_balance`, `spend_report`. Policy: `STELLAR_PAY_MAX_USD_PER_CALL`
(default 0.05) and `STELLAR_PAY_SESSION_BUDGET_USD` (default 1.00); only USDC
is auto-approved on mainnet. `npm run test:mcp` drives every tool over stdio
and ends with a paid call on testnet. The agent-facing playbook is
[`skills/stellar-pay/SKILL.md`](skills/stellar-pay/SKILL.md).

Using the catalog needs no secret: the daily job publishes a snapshot to the
`catalog` branch of this repo and the MCP/CLI read it through your `gh` auth.

### 🔐 Approval Before Signing

Nothing is signed until you say so. Interactive use prompts per payment;
agents run under `--yes --max-usd` ceilings. The signer is pluggable: a raw
key today, a policy-governed agent wallet (operator approvals, spending
limits, audit log) next.

### 🧪 Sandbox

`npm run sandbox` proves the whole loop on testnet without touching USDC: it
mints its own SEP-41 asset, deploys its contract, runs a local MPP charge
server priced in it with fees sponsored, pays it, and checks the settlement
on-chain.

## Installation

Private alpha — from source:

```sh
git clone https://github.com/Stellar-Light/stellar-pay && cd stellar-pay
npm install --legacy-peer-deps      # @x402/stellar and @stellar/mpp pin different stellar-sdk majors; both run on 16
```

## Quick Start

```sh
# 1. Point it at a wallet that holds USDC (fees are sponsored by most servers, so no XLM needed)
export STELLAR_SECRET_KEY=S...       # STELLAR_NETWORK defaults to stellar:pubnet; --sandbox uses testnet
npm run pay -- whoami
npm run pay -- balance

# 2. See what an endpoint asks for — pays nothing
npm run pay -- offers https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{}'

# 3. Pay for it
npm run pay -- curl https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{"query":"stellar x402"}'

# For agents: approve automatically under a ceiling
npm run pay -- curl <url> --yes --max-usd 0.05
```

## The catalog job

`npm run probe` discovers candidates from the x402 Bazaar and mpp-router and
re-probes everything already indexed; `npm run probe:execute` writes and
`npm run export` snapshots. CI runs both daily and publishes the snapshot to
the `catalog` branch; the job is the only thing that needs `DATABASE_URI`.

## Status

Private alpha. Built on the official rails — `@x402/stellar` and
`@stellar/mpp` — and on the measurement that made it necessary: the same x402
standard does not make an endpoint Stellar-payable (0 of pay.sh's 38 providers
and 3 of the Bazaar's 1,611 hosts accept `stellar:pubnet`), so the catalog
probes instead of trusting.

## License

MIT.
