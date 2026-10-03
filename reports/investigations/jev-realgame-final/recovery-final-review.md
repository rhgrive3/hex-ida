# recovery-final-review — independent adversarial review of production recovery/publication + evaluator

**Lane:** `recovery-final-review` (Freebuff4). **Evidence only** — no source edits, no commits, no
delegation, no API/live-Jev calls, no evaluation outcomes, no candidate snapshots.
Every command ran with `TMPDIR`/`TMP`/`TEMP` = `/mnt/workspace/.dev-state/agent-work/scratch`.

## 1. Exact head and reviewed bytes

- Repository `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
- **HEAD reviewed:** `913b8d55d25b6c10b73f85997b1de2057f925630` ("Freeze independent exact-build game
  queries and audited structural identities"); worktree clean (`git status --porcelain` → 0 entries).
- **Product source:** `b01f3e642aadd646e9be7a7cda18517dc92b369e`; `git diff --quiet b01f3e642..HEAD -- js/`
  succeeds, i.e. **all `js/` product bytes are byte-identical to b01f3e642** (confirmed by me, not taken
  on trust).
- Two files were re-read after the scope update and their **current** hashes recorded below
  (`evaluate…`/`verify…` moved to per-role policy binding in HEAD).

| reviewed file | sha256 |
| --- | --- |
| `js/analysis/cxx/query-recovery.js` | `8fe2c74b2748bb779c346d25dd237bea4cedc94c73ad18bd1ca84bcf760f7597` |
| `js/analysis/cxx/project.js` | `63cd27a6adf305f6f7df0aa51a8f71eae495b5985108e27e93e467dfceeb38ad` |
| `js/analysis/cxx/member-types.js` | `d2da6615189c9fdf94da48e4c3704a4f449f3b1081b4f3171e68c132e54b353c` |
| `js/analysis/cxx/object-evidence.js` | `920d58a7490978fa702adc67509983bb6d104d7ff980425fd32ff955f01ea94a` |
| `js/analysis/cxx/member-index.js` | `a9763ca25965695e2d3a86e15f7fe3b99794e7c4de5d097facf7fa716ea74628` |
| `js/analysis/query/app-adapter.js` | `d7e2a954782a8f71e2151b6ada1f04a3508ba6d7db2ace33ae1709fa391feb75` |
| `js/panels-base.js` | `3b2d7c0eda1b6fcd04f55179516f5e2a3aa82722ac0a9f3f258568e5430d573e` |
| `js/pinpoint.js` | `c94629ce03c6da9190c944928fa26ad8d467f812f4bbb545224b8a6423207d4e` |
| `scripts/collect-jev-realgame-recovery.mjs` | `a62b7cbe78beb677a4d1251aad9d4347c9ac82df0216623a5c109ca1a756b729` |
| `scripts/evaluate-jev-realgame-recovery.mjs` | `902854731c673ba111f4388aa873447927335831fad501c491a440d300a34b45` |
| `scripts/verify-jev-realgame-recovery.mjs` | `402ed487e0611627588df9fad2e1c6e97331eab5c0270e106c53260f0e83ab61` |
| `scripts/jev-realgame-recovery-contract.mjs` | `e2f3f168feed368fc14e1d095c53590bb46f747075e364d67b71c3c01e3e3939` |
| `scripts/jev-realgame-final-contract.mjs` | `5c27813bf8d2d4c0b9a76989e1b17dffc82944787dd04cd2983239c93ae89e7e` |
| `scripts/read-jev-evidence.mjs` | `94cdfb604e72a1ee795c661f211343b21d9f75ba05bc463b98f9579b87f24f40` |
| `scripts/audit-jev-recovery-holdout.mjs` | `0be24a6dbf5847e1249dd4b05d539dd5b05db149ac86b9874b1a74cb952a0690` |

Supporting freezes read as contracts (no outcomes): `recovery-policy-freeze.json` (final)
`e242fa93b08e3ea00666bb326f403f72a78f9a84d50e4d048adc7d1cee92008d`;
`recovery-policy-freeze-development.json` (archived original70 development)
`8aabe4fc144e1317fde0a39d7605c7299a45b91234d50664f5cdbf2f5c0514f5`;
`recovery-experiment-freeze.json` `9ba747381197a880c1fc21a95d2290c2c23037dcf6487f6891f166bb176274fb`.
Tests hashed: `query-recovery.test.mjs` `52d1a323…f62faa`, `member-types.test.mjs` `f43464ae…ed5df4`,
`member-evidence.test.mjs` `ef1bcd01…64a745`.

Hash bindings I re-derived independently: `policy.promptSha256`
(`e2f3f168…`) == sha256(`scripts/jev-realgame-recovery-contract.mjs`) ✓;
final `policySha256` (`e242fa93…`) == `experiment.corpora['untouched-final'].policySha256` ✓;
archived development policy bytes hash == `experiment.corpora['development-original70'].policySha256`
(`8aabe4fc…`, byte-identical to the policy as it stood before the final freeze) ✓;
`experiment.corpora['untouched-final'].independentHoldoutSha256` =
`31a0247628db0e651da39a1108c80f4f2e667b9f7d7d569cefd6611153a2c397` == sha256 of my
`fresh-holdout.json`, whose three files are still byte-identical to my freeze ✓ (**my corpus
untouched**; I modified nothing).

## 2. Verdict

**No merge-blocking defect found in the reviewed bytes.** The path is still safe-by-default and
generic: recovery stays opt-in, bounded, snapshot-bound, canonical-owner-gated, oracle-isolated and
fail-closed at every external boundary. All three previously filed blockers (**B2** UI no-progress,
**B3** elapsed budget, **B4** direct-seed roles) are genuinely fixed, and a new folded-symbol
publication gate closes the ownership-ambiguity hole the prior review only argued about. What
remains are **verification gaps** (§5) that should be closed before the untouched-final run is
*accepted*, plus one carried measurement risk (B1) that is now instrumented but still unmeasured.

## 3. Prior-review fixes verified (B2 / B3 / B4) — not re-researched

| prior blocker | status | proof |
| --- | --- | --- |
| **B2** "attempted>0 treated as success → user loop" | **Fixed** | `query-recovery.js:89-93` `cxxRecoveryMadeProgress()` requires `attempted[].pseudocode===true` **and** `afterRevision>beforeRevision`; `app-adapter.js:61,66-67` now returns `beforeCount/afterRevision/afterCount`; `panels-base.js:3349` shows "No related C++ routines…" when nothing was attempted, `:3350` shows "No additional member evidence was found." and returns **without reopening** the sheet, `:3351` reopens (`sheet.close(); showCandidates`) only on real progress. Test `query-recovery.test.mjs` "no-progress results do not reopen…" asserts no-growth=false, growth=true, no-pseudocode=false. |
| **B3** elapsed budget exceeded while status stays `complete` | **Fixed** | `query-recovery.js:85` post-loop `if(now()-started>=maxElapsedMs)status='budget-exhausted'` in addition to the pre-iteration check (`:76`); test drives `now` to 20 ms against `maxElapsedMs:10` and asserts `status==='budget-exhausted'` **and** `elapsedMs===20`. |
| **B4** roles missed when the load feeds a target with no copy | **Fixed** | `member-types.js:291` is now `targets.has(loadValueId)\|\|flowsInto(loadValueId,targets,chains.consumers)` for all four roles (the `pointerUse` shape at `:264` was the model). Direction remains under-claim only. |

Delta since the prior review head `d22762571` is exactly these three fixes plus: the folded-symbol
planner/publication gate, method-token de-duplication and the tie-break order (`query-recovery.js:53-60`),
`before/after` revision reporting, the three pipeline scripts, the per-role policy split and the
holdout audit script. Prior B1 instrumentation (`recovery.functionCount`, `recovery.plan`,
`collection.analyzedFunctions`) is present in `app-adapter.js:66-67` and `collect…:50,58`.

## 4. Checklist findings (each with the seam that proves it)

1. **Ownership ambiguity incl. folded symbols — VERIFIED (fail-closed).**
   Planner: thunk and multi-owner slots blocked with `records.delete` so a
   later symbol cannot resurrect them (`query-recovery.js:28`); symbol class ≠ unique vtable owner blocks
   (`:32`); **two different symbols folded onto one address block** (`:37`) — covered by the test
   "folded positive member symbols from different owners fail closed" (two `_ZN…` names at `1n` →
   `plan()` returns `[]`). Publication (independent of planning): `project.js:196-209` builds
   `symbolOwners` only for aliased addresses, `:438-441` requires
   `symbolBindingValid = !symbolOwners?.size || (size===1 && has(owner.className))` before
   `memberIndex.publish`; conflicting vtable tables still collapse to an anonymous identity
   (`object-evidence.js:566-577`, comment at `:576` names identical-code folding) and secondary
   vtables fail closed (`offsetToTop!==0n`).
2. **Boundedness — VERIFIED at runtime; not replayed offline (G4).**
   Planner `maxFunctions 1..32` (`query-recovery.js:50`); recovery `maxFunctions 1..32`,
   `maxElapsedMs (0,120000]`, per-iteration abort + budget, address dedupe, `decompilerTimeBudgetMs:1500`
   under `profile:'fast'` (`:71-85`); provider caps `maxClasses 128 / maxSlots 64 / maxReads 4096 /
   maxMembers 256` (`project.js:272-275`); member walk `maxFields 256 / maxInstructions 8192` and
   `MAX_CHAIN_DEPTH` on every role/pointer walk (`member-types.js:184-196,282`); shortlist 2..255
   (`jev-realgame-final-contract.mjs:85`); policy binds 8 functions / 15000 ms per query
   (`collect…:40-42`). Collection invariant `keyCollisions===0 && rows===cases` (`collect…:59`).
3. **Snapshot / cache binding — VERIFIED.** One `query.snapshot({signal})` per run
   (`app-adapter.js:43`); `checkBinding()` before/after **every** decompile and after the loop
   (`:48-52,63-64`) rejects a swapped member index or moved `symbols.gen`; planner cache keyed on the
   provider plus `symbolsGen` (`:53-58`); provider entry invalidated on backend/symbols/generation/
   architecture/pointer-size change (`:103-105`); `cxxMemberIndexForApp` re-validates the same identities
   (`:72-81`) and is publication-only (never builds or reanalyzes).
4. **Canonical-only roles — VERIFIED.** Whitelist of exactly the four roles with `length<=4` or the
   canonicaliser throws `cpp-member-access-role-invalid` (`object-evidence.js:379-381`, dedupe/freeze `:404`);
   unknown/duplicate/over-long roles are rejected by tests (`member-evidence.test.mjs:147-150`,
   `'GOLD SECRET'` in `jev-realgame-final.test.mjs:160`); the contract re-filters through its own `ROLES`
   set twice (`jev-realgame-recovery-contract.mjs:11,22,38`); the **canonical member key excludes
   `accessRoles`** (`member-index.js:103-105`) so roles cannot change publication identity or conflict
   state — they travel only as bounded provenance samples (`member-index.js:151-160`).
5. **Fast default unchanged — VERIFIED.** `recoverCxxMembersForQuery` returns `disabled` unless
   `options.enabled===true` (`app-adapter.js:39`), `recoverCxxQueryMembers` defaults `enabled=false`
   (`query-recovery.js:68`); exactly three callers exist repo-wide (`panels-base.js:3345` explicit tap,
   `collect-…:40`, `scripts/probe-cxx-query-recovery.mjs:25`), all pass `enabled:true` explicitly.
   The planner does no decompilation; ordinary Fast decompile still goes through the pre-existing
   `ensureCxxEvidenceProviderForApp` + `projectForFunction` seam (`app-adapter.js:1212,1262`) and the
   query option whitelist (`:20-29`); `js/` is byte-identical to `b01f3e642`.
6. **UI no-progress handling — VERIFIED by reading (G6: no automated test).** Three-way outcome
   (nothing planned → specific toast; planned but no new evidence → specific toast, sheet stays open;
   progress → close and re-rank) at `panels-base.js:3349-3351`; re-entrancy guard `recovering`
   (`:3342`), progress box always dismissed, abort path swallowed only when the user cancelled.
7. **Fail-closed routing — VERIFIED.** Router unchanged: Jev is called only for `mode==='partial'`,
   `candidates>=2`, verdict not `confirmed|likely` (`pinpoint.js:140-154`); client errors return `null`
   and never reach the router (`jev-realgame-final-client.mjs:48-57`), `rerankWithJev` falls back to the
   Hex top1 on `null`/throw (`pinpoint.js:141,205-207`); collect's `routed` predicate
   (`collect…:51`) matches the router exactly; verify asserts `calls.length === routed ? repeats : 0`
   and `call.error ⇒ repeatedKeys[repeat]===input.topKey` (`verify…:54,59`), so an external failure is
   provably recorded as "Hex unchanged". Development vs final arm sets are derived from the role's own
   policy (`evaluate…:28`, `verify…:30`), so a development run can never masquerade as a final one.
8. **Oracle isolation — VERIFIED.** Collector is gold-blind: manifest keys restricted to
   `id|query|mode` with binary SHA binding and unique ids (`collect…:14-20`); the recovery contract
   imports no oracle and whitelists every candidate field (`jev-realgame-final-contract.mjs:1-64` with
   the explicit "Gold labels and arbitrary descriptions cannot flow through this boundary" comment);
   gold enters only in scoring (`structuralMatch`/`funnel`) and in the binary-binding assertion
   (`evaluate…:31`); verify re-derives every request body and asserts equality with the recorded
   `criteria` under the message `'oracle leakage or payload drift'` (`verify…:52`);
   `audit-jev-recovery-holdout.mjs` is evaluation-only by comment and import shape and is not reachable
   from any product collector/client.
9. **Structural scoring — VERIFIED (see G5).** `structuralMatch` requires exact
   `binarySha256 + className + offset + size`, rejects `conflict`, and applies `allowedCategories` only
   when the gold carries it (`jev-realgame-final-contract.mjs:94-105`); `funnel` separates
   recovered → published → shortlisted (`:106-115`); `summarize` derives rescue/regression/net/destruction/
   lattice-recall/shortlist-retention/unsafe-confident/apiErrorRate from those (`evaluate-jev-realgame-final.mjs:14-59`),
   matching the frozen policy metrics. The holdout audit expands compiler-proven **inherited aliases**
   into extra identities (`audit-…:50-57`: `className: alias.className, offset: a.offset,
   declaringClass, declaringOffset, inheritance`), which is what makes my inherited-view cases
   (e.g. `BaseStation::build_date` seen as `Station::build_date`) scoreable without touching the query
   text (`queryBodiesUnchanged:true`).
10. **Offline integrity replay — VERIFIED core (G1-G3, G4).** `verify-…` replays corpus hash, per-role
    policy hash, snapshot hashes (gzip-transparent via `readJevEvidence`, missing artifact → throw, never
    an empty pass), `complete`, product identity, per-row binary/SHA bindings, `keyCollisions===0`,
    funnel recomputation, A/DET keys, all arm keys/choices/call payloads/body hashes/response validation,
    shortlist bounds and subset relations, per-game summaries and latency percentiles — with **zero**
    network access. Per-role binding in the current bytes: `evaluate…:15,17-18` and `verify…:77-78,84`
    select `recovery-policy-freeze-development.json` for `development-original70` and
    `recovery-policy-freeze.json` otherwise, and both check `experiment.corpora[role].caseSha256`
    **and** `.policySha256`. The final policy now carries `current` in `arms`
    (`['Hex','DET','current','B','E']`), so the final comparison runs `current` alongside `B`/`E`
    (`evaluate…:26,57`, `verify…:28,64`) with `primaryArm:'E'` unchanged; the archived development
    policy keeps `['Hex','DET','B','E']`, i.e. the development run never pays for the new arm.
    The final corpus is now bound in the experiment freeze (`untouched-final`,
    `caseSha256 1846809a…`, `independentHoldoutSha256 31a02476…`, `verified 40`, `controls 10`,
    `queriesUnchanged true`) — the previously missing precondition for running the final role at all.

## 5. Blockers and verification gaps

**Blockers (merge/acceptance-stopping code defects): none found.**

Verification gaps, ranked (all fail in the safe direction or are undetected-drift risks, none silently
turn a red result green):

- **G1 (close before final acceptance):** `verify-jev-realgame-recovery.mjs` never re-hashes the
  **current** repository source bytes against `snapshot.sourceHashes`; it only asserts snapshot ==
  summary (`verify…:21`). `evaluate…:24` does that check at run time, so an offline replay after
  source drift reports `valid:true`. Recommend: re-hash `sourceHashes` from disk inside `verifyRecoveryEvidence`.
- **G2 (close before final acceptance):** `summary.finalPolicy` and `row.failureCauses` are produced
  only in `evaluate…:61` and are **not** re-derived by verify (it replays `summaries`, `perGame`,
  `coldRecoveryLatency` but not the decision rule). The policy's `decisionOrder` is prose, so a drifted
  acceptance rule would not be caught by the independent verifier. Recommend asserting `finalPolicy`
  from the frozen rule plus controls, and recomputing `failureCauses`.
- **G3:** `policy.promptSha256` is not asserted by any script. It currently equals
  sha256(`jev-realgame-recovery-contract.mjs`) (verified by me) and that file is covered transitively by
  `snapshot.sourceHashes` in `evaluate`; a one-line direct assertion in evaluate/verify would make the
  prompt binding explicit instead of transitive.
- **G4 (boundedness not replayable):** verify does not assert per-row budget conformance
  (`recovery.attempted.length <= policy.collection.maxFunctionsPerQuery`,
  `elapsedMs <= maxElapsedMs`, `status` consistent with the B3 rule). Boundedness is enforced and
  unit-tested at run time, but the offline replay cannot prove the retained rows respected it.
- **G5 (scoring asymmetry):** my final-corpus identities in `fresh-structural-cases.json` carry
  `type` but **no `allowedCategories`**, so `structuralMatch` cannot veto a proven category/type
  mismatch for the untouched-final corpus, whereas original70 golds can. This matches the frozen policy
  wording (binary/class/offset/size) and applies equally to every arm, but it is a real asymmetry with
  the development scorer; decide deliberately before the final run.
- **G6:** the `panels-base.js` recovery action (B2 behavior) has no automated test; verified by reading
  plus the `cxxRecoveryMadeProgress` unit tests only.
- **G7 (low):** `cxxRecoveryMadeProgress` keys on `revision`, which also grows when a *new provenance
  source* lands on an already-published field (`member-index.js:167`), so "progress" is "new member
  evidence", not necessarily "new fields"; `beforeCount/afterCount` are returned but unused by the UI.
  Harmless, but the toast wording and the metric should mean the same thing.
- **G8 (low, interpretive):** `collect-…` accumulates `rawRecovered` across the whole session and each
  row stores `recovered:rawRecovered.slice()` (`collect…:25,50`), and `published` is read from the shared
  lattice each row — so `funnel.recovered` is a **session-level** reachability fact, not a per-tap one.
  Per-query growth exists (`beforeCount`) but is not part of the funnel. Document it or fold
  `afterCount-beforeCount` into the row.
- **G9 (carried, measurement):** prior **B1** — the plan pool can starve on binaries whose method
  ownership depends on incomplete vtables (`query-recovery.js:29-30` keeps only ctor/dtor/const or
  uniquely vtable-owned symbols). It is now measurable per query (`recovery.functionCount`,
  `recovery.plan`, `collection.analyzedFunctions`) but, by scope, I did not read any outcomes, so the
  ceiling is still unknown. Do not claim improvement until those numbers are reported with the result.

## 6. Tests executed (3 focused files, no broad suite)

`node --test tests/phase7/cxx/query-recovery.test.mjs tests/phase7/cxx/member-types.test.mjs
tests/phase7/cxx/member-evidence.test.mjs` → **33 tests, 33 pass, 0 fail** (2.41 s).

Coverage actually exercised: static/ambiguous/thunk exclusion, folded-symbol fail-closed, budget
1..32, disabled-by-default + zero decompiles, snapshot identity, abort, error propagation,
ctor double-count, method-vs-class token crowding, B2 progress/no-progress, B3 overrun, role
whitelist/duplicates/unknown-role rejection, direct-seed B4, width-only/mixed-width/indexed fail-closed.
Deliberately **not** run: `tests/jev-realgame-final.test.mjs` and any suite that reads
`structural-gold.json`, `raw-results.jsonl`, `summary.json` or `production-snapshots/*` — those are
evaluation outcomes/oracle artifacts out of scope for this lane.

## 7. Scope compliance

Read: the guardrails document, the named product/evaluator files, the two policy freezes, the
experiment freeze, the holdout audit script, my own prior `recovery-design.md`, and the unit tests.
**Not** read: any Jev/evaluation output, any summary or raw result, any control/recovery-control
result, any candidate or production snapshot, any holdout outcome, `structural-gold.json`.
No `OPENJEV_API_KEY`, no network, no API call. No repository file modified (`git status` clean before
and after), no commit, no delegation. My fresh-holdout corpus files are byte-identical to my freeze and
were not touched. Detached GDB/readelf work from earlier lanes confirmed dead.

*This receipt is an independent review. All implementation, gate and acceptance decisions remain the
parent's.*
