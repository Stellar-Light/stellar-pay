# stellar-pay — plans & context brief (for audit; not committed)

## What ships today (0.1.13, npm, public)
- CLI + MCP server + library: agents pay HTTP 402 APIs (x402 + MPP) from their own Stellar wallet, non-interactively.
- Encrypted keystore (AES-256-GCM/scrypt file or macOS Keychain); signer = @stellar/stellar-sdk Keypair.
- Spend policy engine: per-host allowlist/denylist w/ wildcard subdomains, per-call USD ceilings, network-match refusal, fail-closed on malformed policy.
- Receipts: append-only sha256 content-addressed JSONL; records refusals with the rule that fired.
- Earn layer / worker marketplace: open bounties on Soroban escrow, terms-hash pinning, commit-reveal evidence, resolver judges by declared policy; two-party e2e shipped.
- Vault: smart account holds bulk funds; agent key draws float under an on-chain cap (__check_auth refuses over-cap).
- Deterministic JSON output + stable exit codes throughout; probed x402/MPP endpoint catalog.

## Roadmap / active plans
1. Policy-file evolution (richer scoping), payments ledger surfaces, npm cadence.
2. NEW IDEA under evaluation: `stellar-pay bridge` — implement the local-signer side of Stellar-Wallets-Kit's proposed AI-agent bridge mode (Creit-Tech/Stellar-Wallets-Kit#111), so the same policy file governs both API payments and dApp-website signing. Not committed; assess if the architecture is actually ready for it.
3. Reputation layer on top of receipts — design phase only.
4. Cut/banned: hackathon-payouts feature (cut), Sextant dependency (banned).

## Audit asks
Audit the CODE (especially security-critical paths: keystore, signing, policy enforcement, receipts integrity, escrow/vault interactions, MCP server surface), the README claims vs what the code actually does (overclaim hunt), and the PLANS above (gaps, risks, sequencing critique — esp. whether the bridge idea is sound given the current code).
