# Vendored: Scrimp

`vendor/scrimp/` is the core of **[kaankacar/scrimp](https://github.com/kaankacar/scrimp)**
(commit 82b082c) by Kaan Kacar — outcome-attributed spend control for agentic
payments on Stellar. Copied verbatim from its `src/scrimp/` (zero runtime
dependencies).

**Permission:** the author granted use ("anyone can use it", Aug 2026) and
confirmed on 2026-08-24 that vendoring and redistributing this copy — including
publishing it inside the `stellar-pay` npm package — is fine, with a formal
MIT/Apache license to be added upstream afterwards. Until that license lands in
`kaankacar/scrimp`, this NOTICE is the record of that grant. Credit stays with
Kaan Kacar; this directory is his work, not ours, and is excluded from our own
formatter and linter so it stays verbatim.

**Verified:** the author noted it was a one-hour workshop build and wasn't sure
it worked. All four suppression rules — duplicate, fresh, quarantine, budget —
plus consumption tracking, attribution, and the `report()` figures are exercised
and pass in `npm run test:scrimp` against this vendored core. One nuance: the
quarantine rule keys on the exact request, not the provider across different
requests, so its comments read broader than the behaviour.
