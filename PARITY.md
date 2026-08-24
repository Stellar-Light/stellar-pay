# stellar-pay vs pay.sh — parity

An honest, feature-by-feature comparison with [pay.sh](https://github.com/solana-foundation/pay)
(Solana Foundation), which stellar-pay is modelled on. `✓` at par, `↑` ahead,
`—` deliberate non-goal, `○` not yet.

## Cross-implementation test (the real benchmark)

`npm run test:parity` points **our** parser at **pay.sh's own** reference MPP
challenge (`debugger.pay.sh`) and asserts it reads it correctly:

```
pay.sh challenge → 1 offer parsed
protocol=mpp  network=localnet  amount=10000  asset=EPjFWdd5…  payTo=9LKZLd…  feesSponsored=true
Stellar-payable? false   (correct — pay.sh's reference is Solana)
PASS — cross-implementation interop confirmed
```

Our 402 reading interoperates with the reference implementation, and correctly
refuses a non-Stellar challenge. That's the strongest parity evidence there is.

## Paying & wrapping

| Capability | pay.sh | stellar-pay | |
|---|---|---|---|
| Handle a 402, pay, retry | `curl` | `curl` | ✓ |
| Preview a 402 without paying | `--debugger` (inspect) | `offers` | ✓ |
| Validate a provider's 402 (seller check) | `--debugger` | `verify` | ↑ neutral, no gateway |
| Wrap **any** tool's 402s | `curl`,`wget`,`http`,`fetch` (4 cmds) | `run -- <anything>` | ↑ one command wraps them all |
| Launch an agent with payments | `claude`,`codex`,`goose`,`acp`,`qodercli` | `claude`,`codex` (+ `run -- goose` etc.) | ✓ / ↑ `run` covers the rest |
| MCP server for agents | `mcp` | `mcp` | ✓ |

`run` is a local MITM proxy that pays 402s for **any** child process, so pay's
per-tool wrappers collapse into one general command. Verified: real `curl` paid
a live 402 through it.

## Wallet

| Capability | pay.sh | stellar-pay | |
|---|---|---|---|
| Create / import / list / default / remove / export | `account …` | `account …` | ✓ |
| New wallet | `setup` | `setup` (`--save`, `--keychain`) | ✓ |
| OS-keychain / biometric gating | Touch ID (native) | macOS Keychain (native prompt = roadmap) | ✓ storage; ○ per-sig prompt |
| Send | `send` | `send` (two-step confirm) | ✓ |
| Top up | `topup` (QR + card on-ramp + poll) | `topup` (QR + `--buy` on-ramp + poll + real partner ramps) | ✓ / ↑ |
| History | — | `history` | ↑ |
| whoami / balance | ✓ | ✓ | ✓ |

## Catalog & governance

| Capability | pay.sh | stellar-pay | |
|---|---|---|---|
| Catalog of paid APIs | contributor-authored `PAY.md` | **probed daily** for live, Stellar-payable | ↑ liveness is the product |
| Catalog search / detail (MCP) | `search_catalog`,`list_catalog`,`get_catalog_entry` | same | ✓ |
| Spend controls | budgets / caps | approve gate **+ Scrimp** (dedup / fresh / quarantine / outcome-attributed waste) | ↑ |
| Balance / spend report (MCP) | `get_balance` | `get_balance`,`spend_report`,`begin_task`/`end_task` | ↑ |

## Deliberate non-goals & not-yet

| Capability | pay.sh | stellar-pay | |
|---|---|---|---|
| Sell / monetize an API (self-host paywall) | `gate`,`server` (YAML, self-host or Vercel) | — (use SDF's x402/MPP middleware) | covered upstream on Stellar |
| Seller onboarding, neutral | — | `verify` + OpenAPI-discovery into the probed catalog | ↑ we help sellers get *discovered* without operating a gateway |
| Author a catalog listing | `skills`,`catalog scaffold`,`create_skill` | — | we probe instead of authoring |
| High-frequency channels | `subscriptions` (session) | ○ | needs the (unaudited) one-way-channel contract + a channel-mode server — none exist yet |
| Visual payment debugger | web UI | runnable sandboxes (`npm run test:*`) | different shape |


## Doc-level details (from pay.sh/docs)

Behaviours the docs specify, and where we land:

- **Pass-through mechanism** — pay "runs the tool, detects 402, builds a proof, retries with the same URL, method, headers, and body." Ours is identical, via the `run` MITM proxy. ✓
- **`pay curl` (wrap a binary) vs `pay fetch` (internal client)** — we split the same way: `run -- curl` wraps the binary; `curl` is the internal client. ✓
- **`--sandbox` / `--debugger`** — we have `--sandbox` (testnet) globally; pay's `--debugger` (inspect the exchange) maps to our `offers` (preview) and `verify` (validate). ✓
- **`setup` → OS secure store** — ours stores in the macOS Keychain (`setup --keychain`). ✓
- **Seller (`gate`/`server`)** — self-hosted YAML paywall. We don't host; on Stellar that role is SDF's x402/MPP middleware, and we add the neutral `verify` + catalog discovery instead.

## Bottom line

At or ahead of pay.sh on everything in the client/catalog/governance lane;
the only gaps are the seller side (a deliberate non-goal — we're neutral) and
MPP session mode (blocked upstream). Built on Stellar's own rails
(`@x402/stellar`, `@stellar/mpp`), and interop-tested against pay.sh itself.
