<p align="center"><b>stellar-pay</b></p>
<p align="center"><b>The missing payment layer for HTTP on Stellar — x402 & MPP 402 challenges, paid in USDC from your own wallet.</b></p>
<p align="center">
  <a href="https://www.npmjs.com/package/stellar-pay"><img src="https://img.shields.io/npm/v/stellar-pay" alt="npm"></a>
  <a href="https://github.com/Stellar-Light/stellar-pay/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
  <a href="https://github.com/Stellar-Light/stellar-pay/actions/workflows/probe.yml"><img src="https://img.shields.io/github/actions/workflow/status/Stellar-Light/stellar-pay/probe.yml?label=daily%20probe" alt="probe"></a>
</p>
<p align="center"><a href="#install">Install</a> · <a href="#quick-start">Quick Start</a> · <a href="#-for-agents-mcp-claude-code-raven">MCP</a> · <a href="#-a-catalog-thats-evidence-not-a-listing">Catalog</a></p>

---

```sh
# Without stellar-pay — the API answers 402 Payment Required
curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'

# With stellar-pay — it reads the terms from that 402, asks you, pays in USDC, returns the answer
stellar-pay curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'
```

**Try it now — a real on-chain payment, with play money:**

```sh
export STELLAR_PAY_PASSPHRASE=sandbox   # testnet play money; any value works
npx stellar-pay setup --sandbox --save sandbox                 # funded testnet wallet, sealed locally
npx stellar-pay curl https://stellar-pay-sandbox.fly.dev/data --yes --sandbox
```

That settles on Stellar testnet for real — the output carries the
stellar.expert link. No real funds, no signup, nothing installed. The
[sandbox](https://stellar-pay-sandbox.fly.dev/) is our own paid endpoint,
priced in native XLM so a friendbot-funded wallet can pay it immediately (no
trustline, no faucet) with the seller sponsoring fees.

Or look without paying anything, on mainnet:

```sh
npx stellar-pay offers https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{"query":"stellar"}'
npx stellar-pay claude "find a paid Stellar API and tell me what it costs"   # Claude Code with the payment tools mounted
```

Inspired by Solana's [pay.sh](https://github.com/solana-foundation/pay) — an
HTTP client that settles 402s in stablecoins. Built on Stellar's own rails:
[`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) and
[`@stellar/mpp`](https://www.npmjs.com/package/@stellar/mpp).

## 💵 Pay for any API

Both live Stellar payment standards, one client:

- **x402** — the `exact` scheme
  ([spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md)),
  settled through a facilitator.
- **MPP, Stellar charge method** —
  [draft-stellar-charge-00](https://paymentauth.org/draft-stellar-charge-00),
  SDF's spec. No facilitator; the server settles.

On a 402, stellar-pay reads the price, token, recipient and network from the
challenge and signs **authorization entries**, not a whole transaction — the
server (or its facilitator) assembles, submits, and pays the fee. Your wallet
holds USDC and nothing else: no XLM, no sequence numbers, no RPC.

```sh
stellar-pay offers <url>                      # what the 402 asks — pays nothing
stellar-pay curl   <url>                      # asks you, pays, returns the answer
stellar-pay curl   <url> --yes --max-usd 0.05 # unattended, under a ceiling
stellar-pay verify <url>                      # seller check: is your 402 correct and Stellar-payable?
```

**Router-agnostic by design.** A router (like
[mpp-router](https://www.mpprouter.dev/)) proxies many APIs behind one gateway
and takes the payment itself — real supply, and the largest source in our
catalog. stellar-pay sits above all of them: it pays *any* host from the
**user's own wallet** — mpp-router, the x402 Bazaar, a provider serving its
own 402 — with no gateway in the middle, no operator's cut, no lock-in.

## 🛠️ Wrap any tool — `stellar-pay run`

`curl` pays for requests you make. `run` pays for requests made by a tool we
didn't write — curl, a Python script, another agent's client:

```sh
stellar-pay run --yes --max-usd 0.05 -- curl -X POST https://apiserver.mpprouter.dev/v1/services/exa/search -d '{"query":"stellar"}'
stellar-pay run -- python my_script.py        # any command; its 402s get paid
```

It starts a localhost proxy, points the child at it (`HTTPS_PROXY` + a local
CA the child alone trusts, never installed system-wide), and routes every
request through the same pay loop: on a 402 it reads the offer, pays in USDC,
retries — the tool just sees the 200. The proxy is gated by a per-run auth
token, its CA key lives only in memory, and it dies with the command.

## 🤖 For agents: MCP, Claude Code, Raven

Mount the MCP into an agent:

```sh
stellar-pay claude            # Claude Code with stellar-pay mounted
stellar-pay codex             # Codex with stellar-pay mounted
stellar-pay goose             # goose with stellar-pay mounted (--with-extension)
claude mcp add stellar-pay -- stellar-pay mcp   # or register it yourself
stellar-pay mcp               # raw stdio server for Cursor, goose, or your own client
```

Tools: `search_catalog`, `get_catalog_entry`, `list_catalog`, `curl`,
`get_balance`, `begin_task` / `end_task`, `spend_report`, plus `send_usdc`
(two-step confirm with a single-use server nonce, so funds never move on one
model call) and `get_history`. The agent-facing playbook is
[`skills/stellar-pay/SKILL.md`](skills/stellar-pay/SKILL.md).

Or script the whole loop without MCP — every command takes `--json` and
returns a documented exit code (`0` ok · `2` usage · `3` payment refused · `4`
no wallet · `1` runtime):

```sh
stellar-pay search "web search for a query" --json      # discover live endpoints
stellar-pay curl <url> --yes --max-usd 0.02 --json      # pay; body + {paid:{usd,hash}} trailer
stellar-pay balance --json                              # {usdc, xlm, …}
```

**Who approves what:** the CLI asks a human before it signs (or `--yes
--max-usd N` to authorize unattended); the MCP signs only within a spending
policy — on mainnet a payment must be USDC, under a per-call ceiling
(`STELLAR_PAY_MAX_USD_PER_CALL`), and inside a session budget
(`STELLAR_PAY_SESSION_BUDGET_USD`).

**Per-host spend policy.** Beyond the flat ceiling, an optional policy file
(`~/.config/stellar-pay/policy.json`, `stellar-pay policy init` to scaffold)
gives an operator per-host control the flat cap can't — a different ceiling
per host, an outright **deny**, or **allowlist mode** where only listed hosts
are payable at all. It applies to every door (CLI `curl`, `run`, and the MCP):

```json
{
  "mode": "denylist",
  "default": { "maxUsdPerCall": 0.05 },
  "hosts": {
    "apiserver.mpprouter.dev": { "maxUsdPerCall": 0.10 },
    "*.trusted-provider.com": { "maxUsdPerCall": 0.50 },
    "sketchy.example.net": { "deny": true }
  }
}
```

A host rule can raise or lower the ceiling; an explicit `--max-usd` only ever
tightens it. In `allowlist` mode an autonomous agent can pay **only** the hosts
you pre-approved — containment the flat cap doesn't give you.

**Spend governance — pay for what's used, not what's asked.** Inside a task,
[Scrimp](https://github.com/kaankacar/scrimp) (by Kaan Kacar) adds
outcome-attributed control a budget cap can't match:

- a request already bought in this task is **replayed free**, not paid twice;
- one re-fetched inside its freshness window is replayed free;
- a provider that just failed repeatedly is **quarantined**;
- every purchase is labelled **wasted** if its response was never read.

`spend_report` shows spend versus what an ungoverned client would have paid,
and the waste rate. Proven on testnet: two identical calls in a task → one
on-chain payment.

**Raven.** [Raven](https://github.com/stellar-experimental/stellar-raven) is
the Stellar ecosystem's agent gateway — one MCP that routes an agent's
question to the right Stellar service. stellar-pay is built to mount the same
way: catalog search through Raven's routing, paid calls through a wallet under
the same spend governance.

## 🔍 A catalog that's evidence, not a listing

Registries list endpoints that died months ago, and "supports x402" says
nothing about Stellar: the same standard runs on Base, Solana and Polygon, and
most servers name only those. Measured 2026-08 from the x402 Bazaar: of its
~1,611 hosts, **three** name `stellar:pubnet`. A listing is not supply.

So the catalog probes instead of trusting. An entry is in it because it
**answered a real 402 naming `stellar:pubnet` within the last day** —
re-probed daily, carrying its price, protocol, the method that produced the
challenge, and how long it has been alive. About **390 endpoints** qualify
today across the x402 Bazaar and mpp-router. If it's in the catalog, your
wallet can pay it right now; the live 402 is still the authority on price.

Using the catalog needs no secret — it's a public feed anyone can pull:

```
https://raw.githubusercontent.com/Stellar-Light/stellar-pay/catalog/catalog.json
```

The daily job publishes the snapshot to the `catalog` branch; the client reads
the same file. Aggregators and other agents are welcome to ingest it — every
row carries its evidence (price, protocol, method, `lastCheckedAt`, days
alive). Only the probe job (`npm run probe`, `probe:execute`, `export` — CI,
daily) touches the database.

## 🔐 Wallet

```sh
stellar-pay setup --save main                 # new wallet, sealed in an encrypted local keystore
stellar-pay topup                             # get USDC in: QR + address + live on-ramps; waits for the deposit
stellar-pay balance                           # USDC + XLM at a glance
stellar-pay send <G...address> --amount 1.5   # send USDC (confirms first)
stellar-pay history                           # recent payments to/from the wallet
```

The key never sits in plaintext: the keystore seals it with AES-256-GCM under
a passphrase (`STELLAR_PAY_PASSPHRASE` for agents and the MCP, an interactive
prompt for humans), or `--keychain` keeps it in the macOS Keychain instead.
Already have a wallet? `STELLAR_SECRET_KEY` in the environment always wins.
`account list / import / default / remove / export` manage saved wallets.

`topup` shows a SEP-7 QR any mobile Stellar wallet scans (Lobstr, Freighter),
and on mainnet lists live fiat on-ramps — MoneyGram cash→USDC and more,
pulled from Stellar Light's partner directory; `topup --buy` opens a card
on-ramp pre-filled and waits for the USDC to land.

## Install

Alpha. From source:

```sh
git clone https://github.com/Stellar-Light/stellar-pay && cd stellar-pay
npm install     # .npmrc sets legacy-peer-deps: @x402/stellar and @stellar/mpp pin different stellar-sdk majors; both run on 16
npm run build   # compile to dist/ (the CLI runs from source via tsx without this)
npm link        # puts `stellar-pay` on your PATH (or use `npm run pay -- <args>`)
```

## 📦 Use it as a library

The same package is the CLI, the MCP server, and an importable library — so a
tool that wants the 402 loop *inside* it doesn't have to shell out:

```ts
import { payFetch, loadWallet, decide } from "stellar-pay";

const wallet = loadWallet();
const { res, paid } = await payFetch(url, { method: "POST", body }, {
  wallet,
  // your approval rule — or reuse ours, per-host policy file included
  approve: async (offer, url) =>
    decide(offer, { network: wallet.network, url, requested: 0.05 }).ok,
});
console.log(res.status, paid?.hash);
```

Also exported: `readOffers` / `offerUSD` (parse a 402), `startProxy` +
`proxyEnv` (wrap a child process), `verifyEndpoint` (seller check),
`loadCatalog` / `searchCatalog`, `buildGoverned` (spend governance), and
`buildServer` (mount the MCP in your own host). Full TypeScript types ship
with it; the Mongo indexer is a dev-only dependency, so installing the
library doesn't pull it.

## Quick start

```sh
# 1. Point at a wallet holding USDC (or make one: stellar-pay setup --save main)
export STELLAR_SECRET_KEY=S...   # STELLAR_NETWORK defaults to stellar:pubnet; --sandbox uses testnet

# 2. See what a paid API asks — costs nothing
stellar-pay offers https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{}'

# 3. Pay it
stellar-pay curl https://apiserver.mpprouter.dev/v1/services/exa/search -X POST -d '{"query":"stellar x402"}'
```

## 📚 Proof you can run

Everything above is backed by a runnable check — no USDC touched:

- `npm run sandbox` — mints a SEP-41 asset on testnet, runs a local MPP charge
  server, pays it, checks the settlement on-chain.
- `npm run test:mcp` — over stdio: pays a 402 through `curl`, replays the
  duplicate free, reads `spend_report`.
- `npm run test:wallet` — setup + trustline, a real testnet send A→B, the
  over-spend and no-trustline guards, history.
- `npm run test:proxy` — a plain request through `run`'s proxy: 402 → paid →
  200, settlement on-chain.
- `npm run test:keystore` · `test:scrimp` (all four rules) · `test:ssrf` ·
  `test:parity` (reads pay.sh's reference MPP challenge) · `test:verify`.

## Status

Alpha. Built on `@x402/stellar` and `@stellar/mpp` — SDF's own rails — and on
the measurement that made it necessary: the same x402 standard does not make
an endpoint Stellar-payable, so the catalog probes instead of trusting. Spend
governance vendors [Scrimp](https://github.com/kaankacar/scrimp) (Kaan Kacar),
used with the author's permission; all four of its rules are verified in
`npm run test:scrimp` against the vendored core.

## License

MIT (the stellar-pay code). `vendor/` carries third-party code under its own
terms — see [`vendor/NOTICE.md`](vendor/NOTICE.md).
