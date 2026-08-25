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
(`STELLAR_PAY_SESSION_BUDGET_USD`). When the MCP client supports **elicitation**, a payment the policy refuses *on price* is put to the person driving the agent rather than failing silently; a denied host or a network mismatch is never escalated, because those are operator decisions or attacks, not judgement calls.

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

So the catalog probes instead of trusting. An entry appears in the default
view only if it **answered a real 402, on a network this catalog claims, and
was re-probed within the last 48 hours** — carrying its price, protocol, the
method that produced the challenge, the networks it actually named, and how
long it has been alive. (48 hours, not 24, so a single missed daily probe is
not an outage. The one deliberate exception is our own testnet sandbox, marked
`curated`, so newcomers have something to pay.) About **390 endpoints** qualify
today across the x402 Bazaar and mpp-router.

Being in the catalog means it **answered a Stellar 402 at the last probe** —
that is strictly better than a registry listing, and still short of a
guarantee. Roughly **8% of live rows fail a strict check** (`stellar-pay
verify <url>` is the same validator our probe uses, and it is the honest
second opinion): a host can rotate its price, change asset, or go down between
probes. The live 402 is always the authority — `curl` re-reads it and pins the
payment to what you approved, so a stale row costs you a refusal, never a
wrong payment.

Using the catalog needs no secret — it's a public feed anyone can pull:

```
https://raw.githubusercontent.com/Stellar-Light/stellar-pay/catalog/catalog.json
```

The daily job publishes the snapshot to the `catalog` branch, and the client
fetches that exact URL over plain HTTPS — no token, no `gh`, no account.
(It falls back to your own `gh` auth only if the direct fetch fails.) Aggregators and other agents are welcome to ingest it — every
row carries its evidence (price, protocol, method, `lastCheckedAt`, days
alive). Only the probe job (`npm run probe`, `probe:execute`, `export` — CI,
daily) touches the database.

## 🔐 Wallet

```sh
stellar-pay setup --save main                 # new wallet, sealed in an encrypted local keystore
stellar-pay topup                             # get USDC in: QR + address + live on-ramps; waits for the deposit
stellar-pay balance                           # USDC + XLM at a glance
stellar-pay send <G...address|name> --amount 1.5   # send USDC (confirms first); --amount max drains
stellar-pay account export --name main backup.json # 0600 backup; import restores it
stellar-pay balance --account work                 # run ONE command as another wallet
stellar-pay history                           # recent payments to/from the wallet
```

The key never sits in plaintext: the keystore seals it with AES-256-GCM under
a passphrase (`STELLAR_PAY_PASSPHRASE` for agents and the MCP, an interactive
prompt for humans), or `--keychain` keeps it in the macOS Keychain instead —
written over stdin, so it never appears in the process table.
`account list / import / default / remove / export` manage saved wallets.

`STELLAR_SECRET_KEY` in the environment still wins when set, which is handy in
CI and for a throwaway testnet key — but it leaves a raw secret in your shell
and in every child process's environment, so prefer the keystore for anything
funded. `run` and the agent launchers strip it from the commands they spawn.

**Compared with [pay.sh](https://github.com/solana-foundation/pay):** they
generate straight into the OS keystore and gate every mainnet signature behind
Touch ID / Windows Hello. We now match both halves on macOS — `--keychain`
pre-trusts no application, so unlocking the wallet requires **Touch ID** (or
the login password). For headless agents, where no biometric exists, a payment
the policy refuses on price is escalated to the human through **MCP
elicitation** — the same fallback pay.sh uses. Windows Hello and a Linux
polkit equivalent are genuinely not built.

Passkeys would be stronger still — the key would never leave the secure
enclave, and Soroban verifies secp256r1 natively via
[passkey-kit](https://github.com/stellar/passkey-kit). It is deliberately not
here: passkey signing needs WebAuthn, i.e. a browser and a human touching a
sensor, which a headless CLI paying 402s unattended does not have.

`topup` shows a SEP-7 QR any mobile Stellar wallet scans (Lobstr, Freighter),
and on mainnet lists live fiat on-ramps — MoneyGram cash→USDC and more,
pulled from Stellar Light's partner directory; `topup --buy` opens a card
on-ramp pre-filled and waits for the USDC to land.

## Using stellar-pay

Each row links to its own section below — full flags, not a pointer back to the
pitch.

| | |
|---|---|
| **[Pass-through commands](#pass-through-commands)** | `curl`, `offers`, and `run -- <anything>` to wrap a tool you didn't write |
| **[Top-up account](#top-up-account)** | `topup` — SEP-7 QR, card on-ramps, exchange and bridge routes |
| **[Manage accounts](#manage-accounts)** | `setup --save`, the `account` family, `--account`, `send`, `history` |
| **[Find things to pay for](#find-things-to-pay-for)** | `search` over a daily-probed catalog |
| **[Spend policy](#spend-policy)** | per-host ceilings, deny, allowlist |
| **[Agents](#agents)** | `mcp`, `claude`, `codex`, `goose` |
| **[Exit codes & JSON](#exit-codes--json)** | what to branch on in a script |

### Pass-through commands

Same request shape as `curl`, with 402s handled.

```sh
stellar-pay offers <url>                     # read the challenge, pay NOTHING
stellar-pay curl   <url>                     # ask, pay, return the body
stellar-pay curl   <url> --yes --max-usd 0.05  # unattended, under a ceiling
stellar-pay run -- <command> [args…]         # wrap a tool that isn't ours
```

| flag | meaning |
|---|---|
| `-X <METHOD>` | HTTP method (`-d` implies POST) |
| `-H "K: V"` | extra header, repeatable |
| `-d <body>` | request body; JSON gets `content-type: application/json` |
| `-i` | include response headers in the output |
| `--yes` | don't prompt — approve anything the policy allows |
| `--max-usd <N>` | ceiling for this call; can only *tighten* a host rule |
| `--x402` / `--mpp` | force a protocol instead of letting us pick |
| `--sandbox` | testnet |
| `--json` | machine output |
| `--account <name>` | run this one command as another saved wallet |

`run` starts a localhost proxy, points the child at it via `HTTPS_PROXY` plus a
CA only that child trusts, and pays any 402 it hits. The child never sees your
key — `run` strips `STELLAR_SECRET_KEY` and `STELLAR_PAY_PASSPHRASE` from its
environment.

### Top-up account

```sh
stellar-pay topup                    # address + SEP-7 QR + every route, then waits
stellar-pay topup --buy              # open a card on-ramp pre-filled, then wait
stellar-pay topup --buy --amount 25  # ask the ramp for a specific amount
```

`topup` prints your address and a **SEP-7 QR** that any mobile Stellar wallet
scans (Lobstr, Freighter), then watches the account and tells you when funds
land. On mainnet it also lists the real routes, and these are exactly what
ships — no others are implied:

| route | who | note |
|---|---|---|
| **Card / PayPal** | **MoonPay** | the same provider pay.sh uses; your address is pre-filled in the URL |
| | **Lobstr** | Stellar-native card purchase of USDC on Stellar |
| | **Rozo** | checkout that can settle USDC on Stellar |
| **Exchange withdraw** | **Coinbase**, **Kraken** | buy USDC, then **withdraw on the Stellar network**. Coinbase's *embedded* Onramp does **not** deliver to Stellar (EVM + Solana only), so it is buy-then-withdraw, not one click |
| **Bridge** | **Rozo Intent Bridge** | for USDC/USDT you already hold on Base, Solana or Ethereum |
| **Fiat anchors** | MoneyGram cash→USDC, FinClusive, regional anchors | pulled live from Stellar Light's partner directory, so the list tracks reality rather than this file |

Point `--buy` somewhere else with `STELLAR_PAY_ONRAMP_URL` — `{ADDRESS}` and
`{AMOUNT}` are substituted.

### Manage accounts

```sh
stellar-pay setup --save main             # new wallet, sealed locally
stellar-pay setup --save main --keychain  # …in the OS secret store instead
stellar-pay setup --sandbox --save dev    # testnet: funded + trustline, one command
stellar-pay setup --trustline             # add the USDC trustline to an existing wallet

stellar-pay account list                  # saved wallets — never the secret
stellar-pay account import --name work    # import STELLAR_SECRET_KEY under a name
stellar-pay account default --name work   # change the default
stellar-pay account remove --name old
stellar-pay account export --name work    # print the secret (stderr, after auth)

stellar-pay whoami                        # address + network
stellar-pay balance                       # USDC + XLM
stellar-pay history                       # recent payments, any asset
```

**Run one command as another wallet** without changing the default:

```sh
stellar-pay --account work curl <url> --yes
```

**Send:**

```sh
stellar-pay send <G…address> --amount 1.5   # to an address
stellar-pay send work --amount 1.5          # to a SAVED ACCOUNT NAME
stellar-pay send <G…address> --amount max   # everything, minus the XLM reserve
```

Where the key actually lives, in resolution order: `--account <name>` → an
explicit `STELLAR_SECRET_KEY` → the default keystore account. See
[Wallets](#-wallet) for the storage backends and the Touch ID gate.

### Find things to pay for

```sh
stellar-pay search "web search for a query" --json
stellar-pay search "price data" --limit 3
```

Searches the [catalog](#-a-catalog-thats-evidence-not-a-listing) — endpoints
that answered a real Stellar 402 **within the last day**, re-probed daily. Rows
carry price, protocol, method and how long they've been alive, so you can pick
on evidence rather than on a registry listing. The same data is a
[public feed](#-a-catalog-thats-evidence-not-a-listing) you can pull directly.

### Spend policy

```sh
stellar-pay policy        # show the active policy and where it lives
stellar-pay policy init   # scaffold one
```

Per-host ceilings, outright `deny`, or `allowlist` mode where only listed hosts
are payable at all. It applies to **every** door — CLI `curl`, `run`, and the
MCP — and a malformed file or an unrecognised `mode` **refuses to pay** rather
than silently reverting to no policy. Full example under
[Per-host spend policy](#-for-agents-mcp-claude-code-raven).

### Agents

```sh
stellar-pay mcp       # stdio MCP server for any client
stellar-pay claude    # Claude Code, tools already mounted
stellar-pay codex     # Codex
stellar-pay goose     # goose (--with-extension)
```

Ten tools, the spend policy, and — where the client supports elicitation — a
human approval prompt when the policy refuses on price. Details and the tool
list: [For agents](#-for-agents-mcp-claude-code-raven).

### Exit codes & JSON

Every command takes `--json`. Branch on the code, not on the text:

| code | meaning |
|---|---|
| `0` | ok |
| `1` | runtime failure |
| `2` | usage error (bad flag, unknown command, missing argument) |
| `3` | payment refused or declined |
| `4` | no wallet available |

```sh
stellar-pay --help            # every command and flag
stellar-pay <command> --json  # machine output on all of them
```

**Not built:** recurring **subscriptions / payment delegations** (pay.sh has
them). Every payment here is per-request and separately approved. MPP session
mode — one deposit, many off-chain vouchers — is the piece that would make
subscriptions natural, and it is not built either.

## Building with stellar-pay

The other side: making **your own** API answer a Stellar 402 so clients like
this one can pay it.

**1 — Check what you serve.** `verify` is the neutral validator, the same one
our probe uses, so it is the honest second opinion on your own endpoint:

```sh
stellar-pay verify https://your-api.example/paid -X POST -d '{}'
```

It checks the things that actually break payment: that you answer 402, that
the challenge parses, that it names a Stellar network, that the asset is the
USDC SAC (not the string `"USDC"`), that a recipient and amount are present,
and whether you sponsor fees. Each check passes or fails with the reason.

**2 — Serve the 402.** We do not ship a paywall gateway — on Stellar that
layer is SDF's own. Gate your route with
[`@stellar/mpp`](https://www.npmjs.com/package/@stellar/mpp) (charge mode) or
[`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) (the `exact`
scheme).

**3 — Copy a working seller.** `sandbox-server/` in this repo is a real,
deployed MPP seller in about 100 lines — the one behind
[the sandbox](https://stellar-pay-sandbox.fly.dev/). It shows the parts that
are easy to get wrong: sponsoring fees so the buyer needs no XLM, pricing in a
SAC rather than an asset code, and a challenge store that must be shared if you
run more than one instance.

**4 — Get discovered.** Anything that answers a live Stellar 402 is picked up
by the daily probe and appears in `search` for every agent using this client —
no registration, no listing fee. Liveness is the only membership test.

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
# 1. Make a wallet, sealed in the local keystore (macOS: add --keychain to use
#    the OS Keychain instead). The secret is never printed or exported.
stellar-pay setup --save main
#    Already have one? STELLAR_SECRET_KEY still works, but prefer
#    `stellar-pay account import --name main` so it isn't left in your shell.

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
