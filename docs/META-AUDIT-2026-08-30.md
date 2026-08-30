# Meta-audit — the audit, and the fixes it produced

2026-08-30. Read-only pass over the tree at `13369ab` (identical content to `main` @ `d78a256` and
to `track1-session-slice`; `git diff 13369ab HEAD` is empty). Three lanes — fix efficacy, regression
hunt, audit quality — plus a challenger that reproduced every item. Items ruled wrong were dropped
before this document was written.

Everything below was reproduced on this machine. Where a claim is not reproduced, it says so.

---

## 1. Release verdict

**0.1.9 must not be published as it stands. Five blockers, three of them regressions introduced by
the fix pass itself.**

The green board is real and it is not covering the damage: `npx tsc --noEmit` exits 0, all 13
offline suites pass, and the live testnet resolver suite passes — *while the agreement parser
returns nothing for every document it is handed*. That combination is the single most important
finding in this document.

### Blockers

1. **F10 regressed `parseAgreement` to return empty for every agreement.**
   `src/pay/agreement.ts:138`. Adding the `m` flag for `^` also changed `$` to end-of-**line**, so
   `(?:\n## |\n*$)` matches zero-width at the blank line `buildAgreement` emits after every heading
   and the lazy group captures `""`. Declared `Resolution Effects` are silently discarded and money
   moves against the written terms in both directions. Fix: terminate with a lookahead that cannot
   fire per-line, e.g. `^## NAME\n([\s\S]*?)(?=\n## |$(?![\s\S]))` with `m`, and land it with a
   `buildAgreement → parseAgreement` round-trip assertion. **No test covers `parseAgreement` today.**

2. **F10 did not close audit §3.2 — heading injection still works, through four other fields.**
   `src/pay/agreement.ts:99` runs `demoteHeadings` on `a.terms` only. `title` (:95),
   `reviewQuestion` (:105), `allowedEvidence` (:109) and `resolverPolicy` (frontmatter) are
   interpolated raw and all sit *before* `## Resolution Effects`, so an injected heading wins the
   first match. Fix: run every free-text field through `demoteHeadings` inside `buildAgreement`.
   Fixing blocker 1 alone does **not** close this.

3. **F4 dropped the `v >= 0` half of the audit's own recommended guard.**
   `src/pay/offers.ts:155` is `Number.isFinite(usd) ? usd : null`. A negative amount is finite, so
   it passes `autoApprove` (`src/pay/policy.ts:49` tests only `usd > maxUsd`) and *subtracts* from
   the MCP's session reservation (`src/mcp.ts:225`). Fix: `Number.isFinite(usd) && usd >= 0`.
   Mainnet-reachable.

4. **F9 made `parse()` exit 2 on `-h`/`--help` and on every agent-launcher flag.**
   `src/cli.ts:277` exits inside the parse loop; `main()` calls `parse()` first (`src/cli.ts:1690`),
   so the help handler and the `passthrough` computation at `src/cli.ts:1707-1718` are unreachable.
   `stellar-pay claude -p hello`, `codex --model o3`, `goose run --text hi` and `<any-subcommand>
   --help` are all dead. Fix: recognise `-h`/`--help` in the chain as a no-op, and return early from
   `parse()` when `argv[0]` is `claude|codex|goose`.

5. **The evidence-theft overclaim F18 was written to retract survived in three shipping files.**
   `src/mcp.ts:976` ("Stolen/re-wrapped evidence fails the signature check"),
   `skills/stellar-pay/SKILL.md:78` ("someone else re-submitting your evidence fails the signature
   check"), `src/pay/bounty.ts:290` ("a stolen evidence document cannot be re-signed and claimed by
   anyone else"). All three are false, the shipped test proves it, and `package.json` `files`
   publishes `dist`, `skills` and `docs`. `src/pay/bounty.ts:321` says the opposite 31 lines below
   its own header. Fix: reword all three to match `README.md:186-190`.

**Also required in the release commit** (docs-only, graded non-blocking on its own):
`docs/AUDIT-2026-08-30.md:15-31` ships inside the tarball and tells the reader the defects are
"NOT in the released 0.1.8, which is what npm install gives you today" and to "treat the session
budget as advisory rather than enforced until you are on the patched release." Shipped inside
0.1.9 those sentences are false — except, ironically, the last one, which stays accidentally true
until blocker 3 is fixed. Rewrite §0 to past tense in the same commit as the version bump, or drop
`docs` from `package.json` `files`. Also fix `README.md:185`, which still states the pre-F14
preimage `sha256(contractId | evidence)`.

Nothing else found in this pass gates the release. Ten of the eighteen fixes hold under attack.

---

## 2. Fix scorecard

| # | Meant to close | Holds? | Evidence |
|---|---|---|---|
| **F1** | probe.yml lost `STELLAR_PAY_ALLOW_DB`; catalog publish dead 6 days | **YES** | `.github/workflows/probe.yml:34` (Probe) and `:45` (Publish) both carry it; `src/catalog.ts:70-73` is what demands it. Live proof: the published snapshot is `901` rows, newest `2026-08-30T03:30:30.042Z`, **1.6h old** at the time of this run. |
| **F2** | a blackout must announce itself | **PARTIAL** | The warning fires (`src/catalog.ts:181-186`) but (a) its text asserts staleness while `filter` drops rows for four reasons — a snapshot stamped `now` with `lastStatus:"500"` prints *"the catalog snapshot is 0h stale — every row is outside the 48h freshness window"*, reproduced; (b) an **empty** snapshot is completely silent, and that is the loudest outage; (c) the notice is `console.error`, so an MCP agent never sees it — `list_catalog` returns `{"total_live_endpoints": 0, "hosts": []}` with no staleness field, verified over a real stdio handshake. `catalogAgeHours()` has exactly one caller, inside the same file. |
| **F3** | hourly freshness canary on the published snapshot | **YES** | `.github/workflows/canary.yml` jq/date pipeline replayed locally against the live artifact: `newest=2026-08-30T03:30:30.042Z`, `age=1.6h` → `[ "$AGE" -lt 48 ]` passes. Blind spots are shut: network failure → `[]` → epoch → fail; a GitHub 404 body makes `jq` non-zero under `bash -e -o pipefail`. Residual: the catalog step has no `if: always()`, so when the sandbox step fails first the issue title reads `catalog ?h` — the second signal is lost exactly when something is already wrong. |
| **F4** | non-numeric amount defeats the ceiling | **NO — incomplete, blocker 3** | `abc`, `1,0000000`, `1e999` → `null`, refused (the fix works). `-100000000000` → `usd=-10000`, `autoApprove` returns `{ok:true, reason:"$-10000.0000 within $0.05"}`. Replaying `mcp.ts`'s own arithmetic over three negative offers plus four coercion shapes: `sessionReservedUsd = -10100.50`, remaining budget the server believes it has = **$10101.50** against a $1 session budget. Also `0x10 → 0.0000016`, `" 12 " → 0.0000012`, `[] → 0`, `true → 1e-7` — `Number()` coercion is wide open. |
| **F5** | `guard` optional → required | **PARTIAL** | Required at `src/pay/governed.ts:69` and `tsc --noEmit` exits 0 because both call sites now pass one. But `src/pay/curl.ts:121` and `src/pay/proxy.ts:132` still declare `guard?:`, and both are public exports (`src/index.ts:27`, `:64`). `README.md:514-521` is the documented library example and omits `guard` entirely. The rationale at `governed.ts:63-67` applies verbatim one layer down. |
| **F6** | MCP passes `blockedTarget ?? resolveHost().blocked` | **YES** | `src/mcp.ts:266-269`. Attacked with a local 302 → `http://127.0.0.1:<port>/latest/meta-data/iam/`: `blocked="refused: 127.0.0.1 is a loopback/private/link-local address…"`, private host reached **0** times. `test:ssrf` 14/14, `test:policy` 14/14. |
| **F7** | `startProxy`/`curl` get a guard | **PARTIAL** | `src/cli.ts:371` and `src/cli.ts:1456` install `resolveHost(...).blocked` — the per-host **spend** policy only. Neither calls `blockedTarget`. Same 302 probe with the CLI guard copied verbatim: `blocked=undefined`, private host reached **1**, body `{"iam":{"creds":"AKIA-SECRET"}}` returned. The commit message states the defect as "no surface re-checked SSRF or the per-host policy on a redirect hop"; the SSRF half reached only the MCP. |
| **F8** | strip credentials on a cross-origin hop | **YES** (with a gap) | `src/pay/curl.ts:97/152`, per-hop origin compare against the *current* URL. Measured against a real 302 to a different port: `auth=null cookie=null`, `x-api-key="K"` preserved; same-origin keeps `authorization`/`cookie`. Gap the audit's own fix text asked for and the pass skipped: the hop re-issues `{...init}` unchanged, so **method and body survive** — the collector received `method:"POST", content-length:"8"`. Real `fetch` downgrades 303 (and 301/302 on POST) to GET with no body. |
| **F9** | unknown flags exit 2 | **NO — regressed, blocker 4** | `src/cli.ts:277`. Measured: `curl <url> --help`, `curl -h`, `receipts --help`, `balance --help`, `policy --help`, `claude --help`, `claude -p hello`, `codex --model o3`, `goose run --text hi` → **all exit 2**. Only bare `stellar-pay --help` works, because `argv[0]` is read as the command. The unknown-flag rejection itself is otherwise clean — every long flag in the docs is accepted; `--`, `-X GET` and negative values after a value-taking flag all survive. |
| **F10** | heading injection + line-anchored sections + frontmatter deadline | **NO — regressed, blockers 1 and 2** | See §3. `demoteHeadings` works for `terms`; the parser it was paired with parses nothing, and four other fields are still raw. |
| **F11** | `released`-only terminal, engagementId assertion, deadline enforcement | **YES** | Driven through a fake `EscrowRails` via the exported `setRails()`: tampered description → *"the on-chain agreement does not hash to its engagement_id — refusing to resolve terms the chain did not pin"* (`src/pay/resolver.ts:105-109`); already-released → throws; already-disputed + "no" → completes the documented `dispute` → `resolve` path with no deadlock; expired + no evidence → refund labelled `deadline-expired`; expired **with** evidence → policy still runs, so no honest worker loses a payout. `npm run test:resolver` passed end-to-end on live testnet (provider credited `9970000` = pot − 0.3%; buyer refunded `10000000`). |
| **F12** | `EscrowState` gains seats/balance/resolver; balance from the token contract | **PARTIAL — new bug** | The struct extension is correct and the balance genuinely comes from the token. But `src/pay/rails-trustless-work.ts:284` is `let balance = 0n;` with no else branch at `:299` — a failed or empty simulation is indistinguishable from an empty escrow, and `src/pay/worker.ts:318` reads `balance === 0n` as **settled**. One transient RPC 429 on the second simulation tells a worker it lost a still-funded bounty (`{paid:false, reason:"lost-or-refunded"}`) and no income receipt is ever written. `readEscrow` now issues 1 `getAccount` + 2 `simulateTransaction`, and `awaitPayout` polls it every 5s for 300s — 60 polls × 3 round trips against a public endpoint is exactly where a 429 comes from. |
| **F13** | decision-seats, awaitPayout baseline refusal, native/non-native credit filter | **PARTIAL** | Seats check works for the attack it was built for (`src/pay/worker.ts:127-136`; negative case at `src/sandbox/unit-test.ts:377-382`), but it cannot fire on the default path: `src/cli.ts:1074` and `src/mcp.ts:889` default `resolver` to the buyer, so the comparison is buyer === buyer while `rails-trustless-work.ts:83` seats the buyer everywhere. A worker sees `VALID` under a banner reading "Never work a REFUSED row." The baseline refusal is right (`latestEffectCursor` returns `""` on a 200 with no effects, `null` only on `!r.ok`) but its **caller** was not updated — `src/cli.ts:1045` has no try/catch, so `bounty watch --json` emits **0 bytes on stdout, exit 1** while `src/mcp.ts:1152` returns `json({error})`. The asset filter is `(rec.asset_type === "native") !== wantNative` (`src/pay/worker.ts:245`) — asset **class** only, no `asset_code`, no operation-to-contract check, so §3.14's headline scenario (two concurrent XLM bounties) is untouched while the docstring at `worker.ts:206-207` claims "filtered to the bounty's OWN asset". |
| **F14** | bind the worker address into `submissionDigest` | **YES** (code) | `src/pay/bounty.ts:334`: `${contractId}|${worker}|${JSON.stringify(evidence)}`, used symmetrically. Offline against `pickWinner`: replay (re-wrap under a new address, keep the signature) → `bad-signature`; re-sign the same evidence under the thief's key → `valid`, and the thief wins when it arrives first; cross-contract → `wrong-bounty`. That matches the corrected docs exactly. Two residuals: the wire format changed with no version field (a 0.1.8-signed packet is judged `bad-signature`, indistinguishable from a forgery) and the overclaim survived in three files — blocker 5. |
| **F15** | test asserts BOTH the replay rejection and the honest limit | **YES** | `src/sandbox/bounty-open-test.ts:127-163` builds `stolenReplay` and `stolenResigned`, asserts the exact reason `bad-signature` for the first, and asserts the re-signed packet **wins** when it arrives first — failing loudly if reality ever improves past the documentation, and naming `bounty.ts`'s header as the thing to update. That is the right shape, and it is the file that proves blocker 5. |
| **F16** | redirect-test exits clean (Windows libuv assertion) | **YES** | `src/sandbox/redirect-test.ts:93-96`: `closeAllConnections()` then `await`ed `close()` before `process.exit`. `npm run test:redirect` exits 0, 4/4. The class was not swept — `hostile-test.ts`, `marketplace-test.ts`, `proxy-test.ts` still `createServer` + `process.exit` without it — and `.github/workflows/ci.yml:19-20` still carries `continue-on-error: windows-latest` with the now-stale comment blaming this exact assertion, so a genuine Windows regression (including in `test:osstore`, the reason the 3-OS matrix exists) still ships green. |
| **F17** | `send`'s declined branch uses `EXIT.refused` | **YES** | `src/cli.ts:780` with `EXIT.refused = 3` at `src/cli.ts:160`, matching `README.md:460` and `llms.txt`. Swept the other exit sites: `cli.ts:838`, `:965`, `:1319`, `:1388`, `:1488` all use `EXIT.refused` on refusals; no bare `2` remains on a refusal path. |
| **F18** | disclosure banner, Circle correction, 48h consistency, tool count | **PARTIAL** | The mechanical parts are right: `llms.txt:21` says "MCP tools (26)" and `grep -c registerTool src/mcp.ts` = 26; the 48h rule is stated identically in `skills/stellar-pay/SKILL.md:15`, `src/mcp.ts:350` and `llms.txt:41`; the §0 banner exists; the Circle custody correction is present. The *substance* — retracting the evidence-theft claim — reached `README.md` and `docs/ECOSYSTEM-ASKS.md` and missed `src/mcp.ts:976`, `skills/stellar-pay/SKILL.md:78`, `src/pay/bounty.ts:290` and `src/pay/worker.ts:25-27`: the four surfaces an agent or a contributor actually reads. `README.md:185` still carries the pre-F14 preimage. And the banner itself becomes false on publish. |

**Score: 10 hold · 6 incomplete · 2 regressed.**

---

## 3. Regressions

All 13 offline suites and the live testnet resolver suite pass at HEAD, and `npx tsc --noEmit` on
the **full** tsconfig (which includes `src/sandbox`, unlike `tsconfig.build.json`) exits 0:

```
tsc exit=0
units 37/37 · policy 14/14 · ssrf 14/14 · parity PASS · scrimp 12/12 · catalog 6/6
hostile 4/4 · pin 8/8 · redirect 4/4 · receipts PASS · send 8/8 · keystore PASS · verify PASS
test:resolver  RESULT: PASS — settled BOTH ways on-chain, each judgment receipted
```

Four fixes regressed working behaviour anyway.

### R1 — F10 killed the agreement parser (critical)

`src/pay/agreement.ts:138`. The whole diff is `^` + the `m` flag. Same document, old regex vs new:

```
Terms               OLD "do the work\n\nSettlement rails: …"                  NEW ""
Review Question     OLD "Did the provider deliver the work described in Terms?"  NEW ""
Allowed Evidence    OLD "- the submission hash recorded on the milestone"     NEW ""
Resolution Effects  OLD "- yes => refund\n- no => release"                    NEW ""
parseAgreement → {"reviewQuestion":"","resolutionEffects":[],"deadline":"2100-01-01T00:00:00Z"}
```

The document was produced by `buildAgreement` itself. Driven through `resolveJob` with a fake
`EscrowRails` (`setRails` is exported from `src/pay/job.ts:38`):

```
default effects, judge=yes       outcome=release  calls=[approve,release]              Qseen=""
default effects, judge=no        outcome=refund   calls=[resolveDispute->GA6SFI:1000]  Qseen=""
CUSTOM yes=>refund, judge=yes    outcome=release  calls=[approve,release]              Qseen=""   ← terms said REFUND
CUSTOM no=>release,  judge=no    outcome=refund   calls=[resolveDispute->GA6SFI:1000]  Qseen=""   ← terms said RELEASE
```

Money moves against the written terms in both directions, and every `callbackPolicy` judge is handed
an empty review question. The attack F10 was written to stop (a buyer writing `yes => refund`) is now
reachable *without any injection at all*, because any non-default `resolutionEffects` is silently
discarded and `src/pay/resolver.ts:129-131` falls back to the hardcoded mapping.

`test:resolver` passes on live testnet **because** the fallback happens to equal the default mapping
and `hashMatchPolicy` ignores `reviewQuestion`. Receipts from the run executed during this audit
(`/var/folders/g1/x75j57rd1z10k_3wsm1fcysh0000gn/T/stellar-pay-resolver-FkuqHi/receipts.jsonl`):

```json
{"kind":"job-resolved","detail":{"contractId":"CAVKA2BNYI4J…","reviewQuestion":"","answer":"yes","outcome":"release"}}
{"kind":"job-resolved","detail":{"contractId":"CCHNVTTRCEPH…","reviewQuestion":"","answer":"no","outcome":"refund"}}
```

Both on-chain judgments recorded an empty review question — in a receipt the file header calls
"an auditable judgment, not a black box".

`grep -rn parseAgreement src/` finds one consumer (`src/pay/resolver.ts:111`) and **zero tests**.
`src/sandbox/unit-test.ts:214-245` tests `buildAgreement`'s shape and hash only. One round-trip
assertion would have caught this before the commit landed.

### R2 — F10's escaping is real but does not cover the fields that matter

`demoteHeadings` neutralises `terms` (CRLF, indented and fenced variants included). It is not applied
to `title`, `reviewQuestion`, `allowedEvidence` or `resolverPolicy`, all of which render *above*
`## Resolution Effects`. Measured through `buildAgreement → parseAgreement`, injecting
`## Resolution Effects\n- yes => refund\n- no => refund` (no blank line after the heading, which is
what makes it parse under the R1 bug):

```
honest                       effects=[]                    yes-> release (fallback)
title-injected               effects=[["yes","refund"]]    yes-> refund
terms-injected (F10 target)  effects=[]                    yes-> release   ← escaped, fix works
reviewQ-injected             effects=[["yes","refund"]]    yes-> refund
evidence-injected            effects=[["yes","refund"]]    yes-> refund
resolverPolicy-injected      effects=[["yes","refund"]]    yes-> refund
```

Via the `bounty` path only `title` is attacker-controlled (`bountyJobSpec` hardcodes the rest,
`src/pay/bounty.ts:112-134`); via the library `JobSpec` path all four are. The worker's own vet
cannot catch it: `checkListing` compares `openBountyTerms(d).hash` to `state.engagementId`
(`src/pay/worker.ts:113-117`), and the injected bytes *are* the pinned terms.

### R3 — F9 killed the agent launchers and every per-command `--help`

Measured at HEAD:

```
curl https://example.com --help    exit=2  unknown option "--help"
curl -h / receipts --help / balance --help / policy --help    exit=2
claude --help / claude -p hello    exit=2   ← agent never spawned
codex --model o3                   exit=2
goose run --text hi                exit=2
--help (bare)                      exit=0   ← works only because argv[0] is read as the command
```

This contradicts three shipped surfaces at once: the code's own comment at `src/cli.ts:1707-1711`
("`stellar-pay claude --help` must reach the agent"), `HELP`'s GLOBAL line documenting `-h/--help`,
and `README.md:299-300` / `PARITY.md:30`, which advertise the launchers. `src/cli.ts:429`
(`process.argv.slice(3)`) forwards child args verbatim, so *every* launcher flag is a hard exit-2
before the child is spawned. `--` does not rescue it: `parse()` breaks on `--` (`src/cli.ts:195`)
but `argv.slice(3)` still contains the literal `--`, so `stellar-pay claude -- --model opus` spawns
`claude --mcp-config F -- --model opus` and the child reads the flag as positional text. The `run`
verb is fine — its child args legitimately sit after `--`. The audit's §3.8 fix text explicitly said
"Guard the run/claude/codex/goose passthrough"; that half was not applied.

### R4 — F13's baseline refusal broke the `--json` contract on the CLI door

`src/pay/worker.ts:305-309` throws when no Horizon baseline can be established. `src/mcp.ts:1152`
wraps it; `src/cli.ts:1045` does not, so the throw unwinds to `main().catch` and exits 1 with
nothing on stdout. Demonstrated on an equivalent throwing path:

```
$ stellar-pay bounty list --from http://127.0.0.1:1/nope --json
EXIT=1  stdout_bytes=0  stderr: error: fetch failed
```

Refusing to watch is the correct direction — the fix is right, the caller was not updated.

### Confirmed clean (regression risks that did not materialise)

- **F2's `console.error` does not corrupt MCP framing or `--json` stdout.** Real stdio handshake
  (`initialize` + `notifications/initialized` + `tools/call list_catalog`) against
  `node bin/stellar-pay.mjs mcp` with a 2165h-stale `CATALOG_FILE`: both stdout lines parse as
  strict NDJSON, the warning lands only on fd 2. Same for `search --json`.
- **F4's `null` is fail-closed at all six consumers.** `policy.ts:43-48` refuses outright;
  `mcp.ts:198`/`:225` use `?? MAX_PER_CALL`, charging an unpriceable offer the *full* per-call
  ceiling rather than zero; the rest are display-only behind `!= null`.
- **F12's `EscrowState` widening broke no fixture.** The only object literal outside the rails
  implementation is `src/sandbox/unit-test.ts:330-345`, and it is not vacuous — `approver` and
  `releaseSigner` are a key distinct from the buyer, with a negative case at `:374-381`.
- **F11's deadline default leaves normal jobs alone.** `src/pay/job.ts:106` defaults to
  `2100-01-01T00:00:00Z`; expired-**with**-evidence still runs the full policy; a malformed
  deadline degrades to "not expired". No honest worker loses a payout.

---

## 4. Where the audit was wrong

The audit itself is good. Re-checking every CRITICAL and HIGH finding and a sample of MEDIUM/LOW
against `b5be9af` (the tree it ran on) turned up **no surviving false positive** beyond the two
already known. The verifier's severity corrections that could be checked (§3.5 critical→high,
§3.9 critical→high, §3.11/§3.13/§3.14/§3.25/§3.31 high→medium, the §3.37/§3.39/§3.40 deflations) are
all defensible. The failures are in the *fix pass* and in the audit's own bookkeeping.

**4.1 A false sub-finding that shipped.** `docs/AUDIT-2026-08-30.md:911-913`: "the date stamps:
`SPINE.md:100/135` and `ROADMAP.md:26/78/94` are all stamped 2026-08-30, a day ahead". The audit
commit is authored `2026-08-29T23:28:20-04:00` = `2026-08-30T03:28Z`, and the audit names *itself*
`AUDIT-2026-08-30.md`. The stamps were today's date in UTC. The fix pass correctly declined to act
on it — a good call — but the false premise is still in the shipped document, where it is used to
discredit `phase-d-agreements.md`'s 2026-08-29 stamp as "no evidence of freshness".

**4.2 A wrong cross-reference in the same sentence.** It cites "(§3.29)" for the
`phase-d-agreements.md` finding; §3.29 is the exit-code table, §3.30 is the one meant.

**4.3 A miscount in the headline.** `docs/AUDIT-2026-08-30.md:11` says
"1 critical · 9 high · 21 medium · 21 low" = 52. The body carries §3.1 through §3.53: critical = 3.1
(1), high = 3.2–3.10 (9), medium = 3.11–3.32 (**22**, not 21), low = 3.33–3.53 (21). Total 53.

**4.4 The four refuted findings are named nowhere.** `docs/AUDIT-2026-08-30.md:4` says "4 were
refuted and dropped"; `grep -in refuted` returns only that line in 1605 lines. Severity corrections
are documented inline and are auditable; the refutations are not. That is the one place a wrong call
silently removes a real defect, and it is the only part of this audit that could not be re-checked.

**4.5 Three recommended fixes were correct and got applied at half strength.** These are fix-pass
failures, but they are worth recording as audit-process failures too, because in each case the
audit's own text was more correct than what landed:

- §3.6 recommended `Number.isFinite(v) && v >= 0 ? v / 10_000_000 : null`. The `v >= 0` was dropped
  (blocker 3).
- §3.8 said "guard the run/claude/codex/goose passthrough". Not applied (blocker 4).
- §3.16's fix text said "per fetch semantics downgrade 303 (and 301/302 on POST) to GET with no
  body". Only the credential strip landed; the body still replays cross-origin.

**4.6 One "found clean" area was not actually checked.** §2.8 lists the ephemeral proxy CA under
"Areas examined and found clean". `src/pay/proxy.ts:357-368` sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
`REQUESTS_CA_BUNDLE` and `GIT_SSL_CAINFO` to `caPath`, and `proxy.ts:66-72` writes *only* the
ephemeral root there. Unlike `NODE_EXTRA_CA_CERTS`, all four of those **replace** the default trust
store. Any TLS the wrapped child makes that does not traverse the proxy fails verification against a
one-cert bundle. On macOS this is masked (curl links SecureTransport and ignores `CURL_CA_BUNDLE`;
LibreSSL falls back to the keychain), so it is a Linux/container failure — which is where agents run.

---

## 5. What both audits missed

**5.1 There is no test for the fixes themselves.** This is the root cause of R1.
`grep -rn parseAgreement src/` → `src/index.ts:84`, `src/pay/resolver.ts`, `src/pay/agreement.ts`.
No test calls it. `src/sandbox/redirect-test.ts` asserts the guard is consulted and the host is
unreached (4/4) but asserts **nothing** about F8's credential strip. Two additions would have caught
one blocker and hardened another: a `buildAgreement → parseAgreement` round-trip on
`reviewQuestion` + `resolutionEffects`, and a cross-origin hop asserting `authorization`/`cookie`
absent and a same-origin hop asserting them present.

**5.2 The deadline F11 enforces cannot be set from any shipped surface.** `BountyDescriptor`
(`src/pay/bounty.ts:47-74`) has no `deadline` field; `bountyJobSpec` never passes one;
`grep -rn deadline src/cli.ts src/mcp.ts src/pay/bounty.ts` returns **nothing**. So
`src/pay/job.ts:106` defaults every agreement to `2100-01-01T00:00:00Z` and `expired` is false for
the next 74 years on every bounty a user can create. Two docs now assert otherwise: `README.md:646`
("The agreement's deadline now terminates a job") and `docs/ECOSYSTEM-ASKS.md:106` ("We made the
agreement's deadline terminate a job") — the latter in the file framed as "what we shipped instead"
for an SDF conversation.

**5.3 `src/pay/worker.ts:25-27` still teaches the retracted claim and the wrong inbox.**
"packets are self-authenticating (ed25519 over `sha256(contractId | evidence)`), so the transport
needs no trust — v1 POSTs to the descriptor's `submitUrl` (any inbox the buyer operates)." Both
halves were changed: the preimage is `contractId|worker|evidence` and `src/pay/bounty.ts:64-73` now
says submitUrl "should be the RESOLVER's inbox, not the buyer's… the buyer is the one party that
profits from stealing it". `worker.ts` is the module a contributor reads to understand the earn side,
and it is the last file pointing them at the buyer.

**5.4 `fetchFeed`'s 2MB cap rejects after the damage.** `src/pay/worker.ts:60-63`:
`text = await r.text();` runs *before* `if (text.length > 2_000_000) throw`. The whole body is
buffered first; a hostile feed streaming a multi-GB body is bounded only by a 10s abort. The module
header calls the feed "a stranger's server" and the MCP exposes it as `bounty_feed`.

**5.5 `openBrowser` is the one child spawn that is not env-stripped.** `src/cli.ts:296-305`:
`spawn(cmd, args, {stdio:"ignore", detached:true})` inherits `process.env`. By the time
`topup --buy` reaches `src/cli.ts:663`, `ensureSecretLoaded` has written the decrypted wallet secret
into `process.env.STELLAR_SECRET_KEY` (`src/pay/keystore.ts:429/440`). Both `run` (`src/cli.ts:389-397`)
and the launchers (`src/cli.ts:431-448`) build a stripped `childEnv` for exactly this reason. The
audit's "found clean" bullet praised that stripping without noting the third spawn site.

**5.6 The submission packet is a cross-install wire format with no version field and it changed in a
patch bump.** `OpenSubmission` (`src/pay/bounty.ts:304-311`) carries no `format`. A packet signed by
0.1.8 and judged by HEAD returns `[{"valid":false,"reason":"bad-signature"}]` — indistinguishable
from a forgery. `docs/SPINE.md:148`, written in the same fix pass, lists "CLI verbs, exit codes, MCP
tool names or catalog.json shape" as needing a version bump and omits the one format two independent
installs must agree on. Low severity today because no second install exists — which is exactly why
now is the cheap moment to add the field.

**5.7 The MCP reservation is never released when a payment fails.** `src/mcp.ts:225` reserves before
the payment; the only release is `src/mcp.ts:676-678`, inside `else if (paid)`. The catch at
`src/mcp.ts:641-644` and the refusal path both leak. `grep -n sessionReservedUsd src/mcp.ts` returns
`97, 198, 222, 225, 676, 678` — no rollback anywhere. Fail-**closed**: ~20 failed payments exhaust a
$1 session budget and every later payment is refused with $0.00 actually spent. Independent of
blocker 3 and it survives fixing it.

**5.8 The resolver's deadline comparison accepts any timezone-free string.**
`src/pay/resolver.ts:119` is `Date.parse(deadline) < Date.now()` and `src/pay/agreement.ts:159`
accepts anything `Date.parse` understands. A date-only deadline parses as UTC midnight, so a buyer
west of UTC who writes today's date gets an instant refund of their own escrow; a datetime with no
offset parses as *local* time, so the same document expires at different instants for the buyer, the
provider and the resolver. Money is decided on this comparison.

**5.9 `resolveJob`'s terminal guard still misses a settled escrow** (not a regression — the old
`released || disputed` guard was equally permissive). Read live from testnet after `test:resolver`:
the dispute-refunded escrow reports `released=false disputed=false balance=0`, so a second
`resolveJob` passes the guard, re-disputes a drained escrow and calls `resolveDispute` with
`distributions: [[buyer, esc.amount]]` against `balance=0`, failing at the contract with an opaque
error instead of a clean "already settled". No double payout — the chain protects the money. F12 now
supplies `balance`, so `if (esc.released || esc.balance === 0n)` is available and free.

---

## 6. Residual risk, stated plainly

**If 0.1.9 ships as-is:**

*Mainnet, real money.* Two paths. (a) A hostile 402 quoting a **negative** amount is auto-approved
and *raises* the MCP's remaining session budget — one such response permanently un-caps the
concurrency reservation for the process (blocker 3). (b) `stellar-pay curl` and `stellar-pay run`
follow a 302 to a loopback, link-local or metadata address and return the body, because their guard
is the per-host spend policy only (F7). The MCP door is covered; the two CLI doors are not. Both are
reachable by a server the user simply pointed a command at.

*Testnet, play money — but real logic.* The escrow layer is hardwired to testnet, so the money at
risk is fake. The **logic** is not: declared `Resolution Effects` are discarded (blocker 1), a buyer
can hijack the effects table through the `title` field (blocker 2), and both are silent — the CLI,
the receipts and the test suite all report success. A user who reads the receipt to check what the
resolver decided sees `reviewQuestion: ""` and an outcome that may be the opposite of what they
escrowed. On the earn side, a transient RPC 429 can tell a worker it lost a bounty that is still
funded, with no income receipt written (F12), and `bounty watch --json` can emit zero bytes (R4).

*Agents.* An agent reading `src/mcp.ts:976` or `skills/stellar-pay/SKILL.md:78` is told its evidence
is safe to hand to a stranger. It is not: the shipped test asserts that a re-signed copy arriving
first wins (blocker 5). On the default `bounty post` — no `--resolver` — the buyer holds every
decision seat and `bounty list` still prints the row as `VALID` under "Never work a REFUSED row."

*Humans.* `--help` after any subcommand exits 2, and the three documented agent launchers cannot be
passed a single flag (blocker 4). Annoying, not dangerous, but it is the first thing a new user types.

**What is genuinely safe.** The catalog is alive and watched (901 rows, 1.6h old, hourly canary
verified against the live artifact). Credentials do not leak across a redirect. The MCP's SSRF guard
holds under attack. The escrow assertion that the on-chain description hashes to its `engagement_id`
holds and is proven on live testnet. `EXIT.refused` matches the documented table. The replay attack
on submission packets is genuinely closed, and the test that proves its remaining limit is the most
honest artifact in the repo.

**After the five blockers are fixed**, the residual is: an unreleased reservation on failed payments
(fail-closed), an asset filter that can cross-attribute two concurrent same-asset bounties, a
balance read that cannot distinguish "empty" from "unreadable", a timezone-loose deadline, and a
handful of doc lines that describe a slightly better system than the one that ships. None of those
gate a patch release; all of them belong in 0.1.10.

---

### Method note

Read-only: no source edited, no build run, no commit made. `git status --short` is empty at the end
of this pass. Probes were written under `/tmp/mp/` and imported the package by absolute path.
Live testnet suites were executed (`test:resolver` passed, receipts captured). The published catalog
artifact and the canary's own jq/date pipeline were checked against the real endpoint.
