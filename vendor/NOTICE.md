# Vendored: Scrimp

`vendor/scrimp/` is the core of **[kaankacar/scrimp](https://github.com/kaankacar/scrimp)**
(commit 82b082c) by Kaan Kacar — outcome-attributed spend control for agentic
payments on Stellar. Copied verbatim from its `src/scrimp/` (zero runtime
dependencies).

**Permission:** the author granted use ("anyone can use it", Aug 2026). The
upstream repo does not yet carry a formal license file, so for a fully clean
public release it's worth asking Kaan to add one (MIT/Apache); the permission
to use it here is explicit. Credit stays with Kaan Kacar.

**Verified:** the author noted it was a one-hour workshop build and wasn't sure
it worked. All four suppression rules — duplicate, fresh, quarantine, budget —
plus consumption tracking, attribution, and the `report()` figures are exercised
and pass in `.local/scrimp-exercise` against this vendored core. One nuance: the
quarantine rule keys on the exact request, not the provider across different
requests, so its comments read broader than the behaviour.
