# stellar-pay roadmap

The neutral layer is built: a probed catalog, a 402-paying client (x402 + MPP),
an MCP with spend governance, and a wallet (setup, encrypted keystore, send,
topup with QR + on-ramps, history). Three bets remain, in rough priority.

## 1. Command-wrapping proxy — pay *any* tool's 402s

pay.sh's headline: `pay curl`, `pay <anytool>` run the tool behind a local
forward proxy that intercepts 402s, pays, and retries — so it pays for tools
it didn't write. We pay our own `curl` and MCP calls only.

- **Value:** wrap arbitrary CLIs (a user's own script, another agent's client).
- **Cost:** a real forward proxy, and a local CA to read/modify HTTPS bodies —
  heavy. For agents, the MCP already covers the need, so this is a
  power-user/CLI feature, not an agent one.
- **Shape if built:** a small Node HTTP/HTTPS proxy that classifies 402s with
  the existing `readOffers`, pays with `payFetch`, retries; `HTTPS_PROXY` +
  a generated local CA the wrapped process trusts for the session only.

## 2. MPP session mode — high-frequency paying

We do MPP **charge** (one on-chain settle per request). Session mode opens a
one-way channel: deposit once, then sign off-chain cumulative commitments —
right for an agent making many small calls per task.

- **Value:** cheaper, faster high-frequency paying; the natural fit for a busy
  agent loop.
- **Cost:** `@stellar/mpp` supports it (`channel/client`), but it needs the
  channel contract lifecycle (open, commit, close) and per-provider channel
  state. A real build, not a flag.
- **Shape if built:** a `session` mode on the MCP `curl` that opens/reuses a
  channel per host and signs commitments; `spend_report` already has the
  vocabulary for it.

## 3. Smart-account vault — spend caps enforced on-chain

Today the wallet is a classic ed25519 key; governance (Scrimp + the approve
gate) is app-layer. A **smart account** (OpenZeppelin, via SDF's
[`smart-account-kit`](https://github.com/stellar/smart-account-kit), Apache-2.0)
enforces limits **on-chain** in `__check_auth`: a daily USDC cap, an allowlist
of callable contracts, session-key expiry — so a compromised agent key still
cannot exceed the cap.

Confirmed feasible for agents (not passkey-only): the kit imports headless
(`MemoryStorage`), supports **Ed25519 external signers**, ships a first-class
**spending-limit policy**, and its testnet contracts are published. The one
gap: paying a 402 *from* a smart account isn't drop-in — `@x402/stellar` signs
with a classic key, and a contract account authorizes differently, which the
facilitator/scheme would need to accept.

- **Shape (the pattern that works today):** the smart account is a **vault** —
  holds the balance, on-chain daily cap + a `CallContract` rule scoped to the
  USDC SAC, with the agent's ed25519 key as an External signer. It tops up a
  small **hot classic key** the client uses for 402s. Bulk funds are protected
  on-chain; only a small float is ever at the key an agent signs 402s with.
  `send` can already run through `kit.transfer(USDC_SAC, to, amount)`.
- **Reuse, don't build:** adopt `smart-account-kit` + a published policy
  contract. We never author a Soroban contract.

## Why it strengthens the SDF story

Each is "on SDF's own rails": MPP session mode uses SDF's MPP spec, the vault
uses SDF's smart-account-kit and OZ's audited contracts, and the proxy makes
the neutral client wrap the whole ecosystem. The pitch stays: **the neutral
supply-and-governance layer for agent payments, consuming every router, on
Stellar's own rails.**
