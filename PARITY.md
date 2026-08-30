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
| Launch an agent with payments | `claude`,`codex`,`goose`,`acp`,`qodercli` | `claude`,`codex` mount the MCP | ✓ for those two; `run -- goose` is possible but untested and buffers bodies (no SSE streaming), so ○ for streaming agents |
| MCP server for agents | `mcp` | `mcp` | ✓ |

`run` is a local MITM proxy that pays 402s for **any** child process, so pay's
per-tool wrappers collapse into one general command. Reproduced by hand: real
`curl` paid a live 402 through it and read a gzipped response back correctly; the
checked-in `test:proxy` covers the plain-HTTP pay path end to end.

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
| Catalog of paid APIs | contributor `PAY.md`, CI-probed at PR/build time | **probed daily** (cron) for live, Stellar-payable | ↑ our edge is continuous liveness, not that pay never probes |
| Catalog search / detail (MCP) | `search_catalog`,`list_catalog`,`get_catalog_entry` | same | ✓ |
| Spend controls | budgets / caps | approve gate **+ Scrimp** (dedup / fresh / quarantine / budget, all verified; outcome-attributed waste) | ↑ |
| Balance / spend report (MCP) | `get_balance` | `get_balance`,`spend_report`,`begin_task`/`end_task` | ↑ |

## Deliberate non-goals & not-yet

| Capability | pay.sh | stellar-pay | |
|---|---|---|---|
| Sell / monetize an API (self-host paywall) | `gate`,`server` (YAML, self-host or Vercel) | sandbox serves MPP charge + channel + x402 v2 (in-process facilitator) | our sandbox is a reference seller on all three protocols (`test:x402` proves the x402 route with an unmodified `@x402/fetch` client); production selling still belongs to SDF's middleware |
| Seller onboarding, neutral | — | `verify` (checks a provider's 402 is correct + Stellar-payable) | ↑ neutral, no gateway |
| Author a catalog listing | `skills`,`catalog scaffold`,`create_skill` | — | we probe instead of authoring |
| High-frequency channels | `subscriptions` (session) | `session open/status/close` + `curl --session` + MCP `session_*` | ✓ on testnet, full UX: deposit once (5 XLM default), pay per call off-chain (10× per-call vs charge), channel reuse across restarts, verified refund at close. Mainnet stays gated on the one-way-channel audit; no public channel-mode server exists yet besides our sandbox |
| Visual payment debugger | web UI | runnable sandboxes (`npm run test:*`) | different shape |


## Doc-level details (from pay.sh/docs)

Behaviours the docs specify, and where we land:

- **Pass-through mechanism** — pay "runs the tool, detects 402, builds a proof, retries with the same URL, method, headers, and body." Ours is identical, via the `run` MITM proxy. ✓
- **`pay curl` (wrap a binary) vs `pay fetch` (internal client)** — we split the same way: `run -- curl` wraps the binary; `curl` is the internal client. ✓
- **`--sandbox` / `--debugger`** — we have `--sandbox` (testnet) globally; pay's `--debugger` (inspect the exchange) maps to our `offers` (preview) and `verify` (validate). ✓
- **`setup` → OS secure store** — ours stores in the macOS Keychain (`setup --keychain`). ✓
- **Seller (`gate`/`server`)** — self-hosted YAML paywall. We don't host; on Stellar that role is SDF's x402/MPP middleware, and we add the neutral `verify` + catalog discovery instead.

## Bottom line

Strong across the client/catalog/governance lane, and ahead on the probed
catalog, `verify`, and outcome-attributed governance. Real gaps remain: no
per-signature human/biometric auth in the MCP (it's policy-gated), macOS-only
keychain, no ephemeral-sandbox wallets or auto-setup, and partial curl arg
fidelity. Built on Stellar's own rails (`@x402/stellar`, `@stellar/mpp`), and
interop-tested against pay.sh itself.

**Beyond pay.sh — the work layer (testnet).** pay.sh pays per request; it has
no equivalent of escrow-backed **jobs** with hash-committed agreements, an
automated **resolver**, open-claim **bounties**, the on-chain-capped
**vault**, or the tamper-evident **receipts** ledger. That layer is
stellar-pay's own lane (see [`docs/SPINE.md`](docs/SPINE.md)), testnet-gated
until the contracts it reuses clear their audit posture.
