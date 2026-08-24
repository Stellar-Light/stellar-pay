# Security

stellar-pay moves real money. If you find a vulnerability, please report it
privately — do not open a public issue.

**Report:** open a [private security advisory](https://github.com/Stellar-Light/stellar-pay/security/advisories/new)
on this repository (preferred), or email the maintainers.

**Scope highlights** — the things we most want to hear about:

- Any way to make a payment exceed the approved amount, recipient, or asset
  (the approve gate, the per-host policy, the x402/MPP challenge pinning).
- Key material leaking to a wrapped child process, the environment, disk, or
  another local process (keystore, `run` proxy, MCP).
- The `run` proxy: reaching the TLS terminator or spending the wallet without
  the per-run token; CA misuse beyond the child's own session.
- SSRF past the MCP `curl` guard (metadata/loopback/private ranges, rebinding).

**Practices:** keys live in the OS keychain or an AES-256-GCM keystore, never
plaintext; the wallet secret is stripped from wrapped commands' environments;
every spend passes one shared approval gate; full-history secret scanning
(gitleaks) and the offline proof suite run in CI on every push and pull
request. `vendor/` is third-party code — see `vendor/NOTICE.md`.

We aim to acknowledge reports within 72 hours.
