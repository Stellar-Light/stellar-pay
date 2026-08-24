# Contributing

Alpha software that moves real money — small, verified changes win.

## Setup

```sh
git clone https://github.com/Stellar-Light/stellar-pay && cd stellar-pay
npm install && npm run build
npm link          # `stellar-pay` on your PATH
```

## Before you open a PR

```sh
npm run check     # biome + tsc — must be clean
npm run test:units && npm run test:policy && npm run test:ssrf && npm run test:scrimp
```

Those four run offline. The testnet proofs (`test:wallet`, `test:mcp`,
`test:proxy`, `sandbox`) exercise real settlement on Stellar testnet — run the
ones your change touches; CI runs the offline set on every push.

## Ground rules

- **Money paths need a test.** Anything touching offers parsing, the approve
  gate, the policy file, or settlement lands with a check in `src/sandbox/`.
- **Fail closed.** A misconfigured limit refuses; it never approves.
- **`vendor/` is verbatim third-party code** (see `vendor/NOTICE.md`) — don't
  edit or reformat it.
- Match the existing style; `npm run check` enforces most of it.

Security issues: see [SECURITY.md](SECURITY.md) — never a public issue.
