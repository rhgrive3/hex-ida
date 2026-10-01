# visible-v4-final-delta-review — final receipt (visible-argument-signature delta + live V4 projection repair)

- **Mode:** read-only, source-only, independent review. No delegation/subagents, no edits/commits, no network/API, no collectors/evaluators executed against files, no final query/gold/oracle/snapshot/result/policy contents inspected (independent 50 remain parent-unread).
- **Prompts:** `checkpoints/jev-realgame-final/visible-v4-final-delta-review.prompt.md` (original brief) and `checkpoints/jev-realgame-final/live-v4-review-handoff.prompt.md` (bounded repair handoff).
- **Exact reviewed HEAD:** `c2aaeb2f0610af3c241a22a9c2ad72acd1f89f96`
- **Checkout:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida` (branch `integration/jev-realgame-final`); `git status --porcelain` clean at review start and end.
- **Ranges:** original delta `f0d5b4d125b0eb7e5ad1d618af1b97635ead4a91..563eefa3dcedf6a57c427f27453ccd457f36af3d` (3 commits: `594e2be41`, `8d273e41a`, `563eefa3d`; exactly the 4 briefed files); repair `563eefa3..c2aaeb2f0` (1 commit `c2aaeb2f0` — exactly the 2 repaired files).
- **Prior retained receipts (not re-reviewed):** `f0d5b4d1` source review (13 hashes, parent-verified), `35cff04fc` input-width review (parent-verified).
- `TMPDIR`/`TMP`/`TEMP` = `/mnt/workspace/.dev-state/agent-work/scratch` for every command; no OS temps used.

## SHA256 of the 5 files at `c2aaeb2f0`

| File | SHA256 @ c2aaeb2f0 | vs 563eefa3 |
|---|---|---|
| `js/analysis/query/jev-advisory.js` | `71d0af8e741b0429a4fd34be07dd8e8c0e6974b7d367a0de87dda50b28bc4e8c` | changed (repair) |
| `tests/phase7/cxx/jev-recovery.test.mjs` | `fa6b17ee8605f1751f35feda251355fa8e5e283dd6db90a3df0216ffb02a05d4` | changed (repair) |
| `scripts/evaluate-jev-default-v4.mjs` | `817e0677d36c694e91504194cda27d423210cd286ad03e67d480b7ba5d075124` | byte-identical to 563 |
| `scripts/verify-jev-default-v4.mjs` | `d9124f03c3a927a13194f5ba32ef44a0f6e0062502ca64bfe759fe753c4d84e6` | byte-identical to 563 |
| `tests/phase7/cxx/object-context-ranking.test.mjs` | `1b205ce7f77193cf933c1ef349b58a613e05e3c774291c044834cb97b631c497` | byte-identical to 563 |

`git diff --quiet 563eefa3 HEAD` over the three eval/verify/test files confirms they are unchanged since the interrupted 563 review, so the 563 delta notes below still bind their exact bytes.

## Repair verification — the 2 changed files

**New module-private `memberRequestViews(candidates, contexts)`** (`jev-advisory.js`): maps each `cxxSemanticViews`-validated context 1:1 with `{anonymous, offset, size, recoveredType, readCount, writeCount}` sourced **from `candidates[index].field`** — the canonical published field (`member-index.js` `publishedField` sets exactly these properties from frozen recovery records). No arbitrary candidate display or oracle properties are read; index alignment is safe because callers first reject any null view in the 1:1 `contexts` array.

**Both former call sites now share this exact projection:**
1. `createJevMemberClient` (real HTTP body) previously mapped `offset/size/recoveredType` from *candidate top-level* (display-level, forgeable) — now field-sourced. Behavior-neutral for `offset/size` (`cxxSemanticViews` already enforces `candidate.offset===field.offset && candidate.size===field.size`) and a hardening for `recoveredType` (forged candidate display category no longer reaches the body — covered by the new test).
2. `rerankAnonymousCxx` (live wrapper) previously omitted `offset/size/recoveredType/readCount/writeCount` entirely — the exact defect below — now uses the same `memberRequestViews`.

**Consequences verified statically:** the live `argument-flow-v4` veto now builds descriptions without throwing (`member: offset 0x…` renders from branded `field.offset`); for any shared candidate the veto view and the HTTP-body view are value-identical, so body/veto consistency holds by construction; `jevVisibleArgumentContextSignature` itself is unchanged by the repair (only surrounding code added). Routing gates, default-disabled state, and the v3 (`value-flow-v3` / `jevMemberContextSignature`) path are unaffected — extra view properties are ignored by `jevSemanticRoute` scoring and by the member signature.

**New branded live test** (`jev-recovery.test.mjs`): `live V4 selection uses the same branded request projection as its ambiguity veto` — asserts a valid V4 selection survives the visible-context veto (`source==='jev'`, previously impossible), body criteria carry branded offsets (`0x8`/`0x9`), no `SECRET_ORACLE`/API-key leakage, identical-context peers still veto to the local top, disabled/stale/strong/forged-input variants make zero remote calls, and a forged candidate-level `recoveredType` cannot enter the body.

## Blocker disposition

- **BLOCKER (found at `563eefa3`, now RESOLVED at `c2aaeb2f0`):** the live wrapper's v4 veto called `jevVisibleArgumentContextSignature` on `cxxSemanticViews`-derived views that omit `offset`; `jevAdvisoryRequest` evaluates `c.offset.toString(16)` → `TypeError` inside the wrapper client → caught by `rerankWithJev`/`rerankAnonymousCxx` fail-closed handling → **Hex silently preserved after every valid V4 selection** (live v4 dead-on-arrival; eval harness unaffected because its pool candidates carry `offset`). Independently reproduced by the parent (new branded test FAIL at `563eefa3`, PASS at `c2aaeb2f0`). Repair removes both the missing-layout inputs and the candidate-display sourcing. No residual occurrence remains in the two changed files; the eval-side `v4SelectionAllowed` path was never affected (raw snapshot candidates carry `offset`).
- **No open merge-blocking defect at `c2aaeb2f0`.**

## Prior 563 delta notes (3 unchanged files)

### `scripts/evaluate-jev-default-v4.mjs`
- `v4SelectionAllowed(query,selected,pool,selective)` threads `query` into `jevVisibleArgumentContextSignature`; the same function, same `pool` (non-conflict candidates, pre-shortlist), and same equality predicate are used in the live wrapper, evaluator, and verifier — **same actual predicate threaded across all three**; non-selective arms never compute a signature (veto reduced to conflict/truncation guards).
- **`call.rawCorrect` judged on the raw selected member:** recorded as `correct(audit.selectedKey)` from the raw client audit (`RealGameJevClient.selectedKey`, set before any veto), not on the committed/fallback key; `committedKey` is stored alongside. `rawRemoteHighConfidenceErrors` now counts `call.rawCorrect===false` (false only for verified rows; `null` for unverified rows never counts) together with recorded `confidence>=0.9 && noul>=0.9` — the old convoluted repeated-key condition is gone and cannot mix committed outcomes into the raw metric.
- Default/disabled posture unchanged: `finalPolicy` fixed to `PENDING_PRESERVATION_AND_EXACT_HEAD_GATES`, `authorizesDefaultActivation` false, `assertV4Execution` still precedes any client construction.

### `scripts/verify-jev-default-v4.mjs`
- **New independent re-assertions (all cross-checked against `summarize`/`percentiles` formulas in `evaluate-jev-realgame-final.mjs` / `jev-realgame-final-contract.mjs`):** `policy.repeats===3 && summary.repeats===3`, `primaryRepeat===0`, `majorityVoting===false`, pending `finalPolicy`, `collectionRevision===snapshots[0].productSha` (source revision), `policySha256` bound to the execution-freeze's recorded policy hash, `executionFreezeSha256===sha256(freezeFile)`, `coldRecoveryLatency` re-derived with an independent `pcts` implementation byte-equivalent to `percentiles`, per-call `rawCorrect` re-derived with the independent local `matches`, `apiCalls/apiAttempts/apiFailures/apiErrorRate/timeouts/retries/apiAddedLatency/hexLatency`, funnel counters (`structurallyRecovered/goldInLattice/goldInShortlist/unreachable/recoveredButNotPublished/publishedButOutsideShortlist`), `unstableCases` (all rows) and `destructiveUnstableCases` (all-repeat destruction: baseline correct ∧ any repeat false), per-game `answerable===20` counts, and `rawRemoteHighConfidenceErrors`.
- **Denominators:** `s.hexTop1` recomputed per baseline (`A`/`A0`/`O4`) from actual verified rows — actual Hex and best-O4 denominators, `answerable===40` asserted; `baselineDestructionRate` bound to that denominator.
- **OBS-3 stale-residual check:** OBS-3's second sentence (verifier does not re-assert `primaryRepeat/majorityVoting/finalPolicy/coldRecoveryLatency/rawRemoteHighConfidenceErrors`) is **fully addressed by this delta — now stale/retired**. Its first sentence (verifier reuses production builders `jevArgumentFlowRequest`/`jevSemanticRoute`/`cxxObjectSemanticScores`/`jevVisibleArgumentContextSignature`/`validateChoice` for reconstruction) **remains true by design and is disclosed** as shared-builder consistency rather than independent re-derivation.
- **Replay circularity / actual case counts:** the replay is not summary-circular — every asserted summary field is recomputed from the raw `raw-results.jsonl` rows (which are themselves bound per call to `bodyHash`/`criteria`/`attempts` and per row to inputs+golds via the independent `matches`), or from freeze/source bytes. Shared-builder segments (body bytes, routing, visible-sig equality, O4 scoring) are value-circular w.r.t. production code but bound elsewhere (source review + unit tests). No *actual case count* among the briefed metrics is missing (50 rows/50 unique/40 answerable/20 per game, call/attempt/failure/latency counts, funnel counts, and unstable/destructive id lists all recomputed). Residual gap (non-blocking): a handful of derived `summarize` fields remain unasserted (`accuracy`, `recoveryRate`, `endToEndLatency`, `attemptErrors`, `regressions` list, control counters) — they are either pure functions of asserted values or outside the briefed metric list.
- Verifier also re-asserts per-repeat `committedKey` against the recomputed veto (`contextUnsafe` + visible-signature equivalence) and per-repeat `repeatedCorrect` against independent `matches`.

### `tests/phase7/cxx/object-context-ranking.test.mjs` (byte-identical to 563)
Five appended assertions in `argument context stays bounded…`, each mapping to a briefed check:
- **Hidden/provenance beyond shown 8:** a 9th context with a different address changes `jevArgumentContextSignature` (old sig) but not the visible sig — only the shown `slice(0,8)` contexts enter the description; verified by construction of `jevAdvisoryRequest` (priority-sorted `.slice(0,8)`).
- **Unknown release method addresses:** `name:null` contexts at different addresses normalize via `/release method: 0x[0-9a-f]+/` — matches `BigInt(address).toString(16)` (always lowercase) so unknown hex addresses never distinguish.
- **Layout/read/write counts dropped:** `offset/size/readCount/recoveredType` changes leave the visible sig equal — all live in the empty-context prefix (`class|member|size|category|proven|reads|writes`), removed by the exact `description.slice(prefix.length)`.
- **Delimiter inside className:** `className:'Owner | displayed class'` — the class appears as its own JSON element and inside the byte-exact prefix (removed wholesale), so an embedded ` | ` cannot restructure the split context.
- **Same first 240 class chars:** `'a'*240+'A'` vs `'…B'` equal — the sig's `bounded(className)` is the same `slice(0,240)` used for the shown `class:` text, so no hidden owner suffix differentiates.
- Prefix-alignment argument (static): both `description` and `prefix` are built by the same pipeline from the same view; with `functionContexts:[]` every context-derived segment (advisory context parts, value-flow store-role parts, construction-only marker, argument-flow input parts) is omitted, so `description === prefix + (' | '+contextText | '')` exactly; the sig is a pure function of `(bounded(className), shown-suffix)` — shown-identical ⇒ sig-identical, hidden-only differences ⇒ identical shown text ⇒ identical sig (coarser-only in the order/dedup step, i.e. fail-closed toward the veto). Exact-source input differences (entry-register/bit writes) remain shown and therefore distinguish — legitimate shown distinctions.
- **Default disabled:** repo search finds no production caller of `rerankAnonymousCxx`/`createJevMemberClient`; representation defaults to `value-flow-v3`, `routingPolicy` defaults to `legacy`.

## Tests run (exactly 2 quiet-wrapper commands, 3 named cases)

| # | Command (quiet wrapper) | Matches | Result | Exit |
|---|---|---|---|---|
| 1 | `node scripts/run-quiet-command.mjs --label live-v4-projection-focus -- node --test --test-name-pattern='live V4 selection\|argument context stays bounded' tests/phase7/cxx/jev-recovery.test.mjs tests/phase7/cxx/object-context-ranking.test.mjs` | 2 named cases (`live V4 selection…`, `argument context stays bounded…`) | `live-v4-projection-focus: PASS (1.0s)` | 0 |
| 2 | `node scripts/run-quiet-command.mjs --label v4-default-summary-focus -- node --test --test-name-pattern='V4 keeps recovery' tests/phase7/cxx/jev-default-summary.test.mjs` | 1 named case (`V4 keeps recovery drift…`) | `v4-default-summary-focus: PASS (0.7s)` | 0 |

**Focus counts: 3 named cases, 2 commands, 0 failures, exits 0/0.** Pattern-to-name binding was confirmed against source test titles (zero-match runs are silent under `node --test`); the two 563-era patterns also passed pre-repair in this lane. No broad suites, collectors, evaluators, or API calls were executed.

## Limitations / expected future work (not review prolongation)

- Source-only review; the verifier's execution against real artifacts remains unrun here — final manifests (`default-v4` policy-freeze/holdout/queries) are parent-held and **expected future work**, as is default activation.
- Eval-pool assumption: `v4SelectionAllowed` computes signatures over snapshot `input.candidates`; correct (non-degenerate) veto behavior presumes those serialized candidates carry `functionContexts` as written at collection. If absent, all same-class peers collide → veto fires always → fail-closed (remote never wins), never fail-open. Not verifiable in-scope (snapshots forbidden).
- Shared production builders in the verifier are disclosed (see OBS-3 above); independent replay separately recomputes structural scoring, counts, latency and stability.
- No default caller exists yet; this receipt is **not** default/gate/release authorization. All 50 final questions/gold remain parent-unread; parent freezes criteria after this source review.

## Constraint compliance

No source edits, commits, staging, or delegation; no final query/gold/oracle/snapshot/result/policy contents read; no network; no collectors/evaluators executed; every command exported persistent `TMPDIR`/`TMP`/`TEMP=/mnt/workspace/.dev-state/agent-work/scratch`. Prior completed receipts preserved.

## Addendum — docs-only descendant `22d5ed9aa` (operational note, post-receipt)

- After this receipt, the parent committed blinded policy/manifests + exact report inventory: HEAD `22d5ed9aa35228104bc274a2c2d8e53d1da9ec6e` — *"Freeze untouched V4 judge policy and blind release query manifests before semantic inspection"* — a descendant of `c2aaeb2f0610af3c241a22a9c2ad72acd1f89f96`.
- Range `c2aaeb2f0..22d5ed9aa` (file names via `git diff --name-only` only): `reports/investigations/jev-realgame-final/default-v4/{holdout.json, independent-author-authority.md, independent-author-freeze.json, policy-freeze.json, queries-openmw.json, queries-openttd.json}` and `tools/validation/phase7/cross-lane-inventory.mjs` / `phase8/cross-lane-inventory.mjs` — blinded policy, query manifests, and report-inventory tooling only. **No source or test file changed.** Report/policy/manifest *contents were not read* per instruction.
- **All five reviewed files byte-identical to `c2aaeb2f0`:** `git diff --quiet c2aaeb2f0..HEAD` over the five paths returned clean, and worktree SHA256 re-verification matches the table above exactly (`71d0af8e…`, `fa6b17ee…`, `817e0677…`, `d9124f03…`, `1b205ce7…`).
- This receipt therefore binds the `c2aaeb2f0` exact blobs; `22d5ed9aa` is a docs-only descendant for the reviewed surface. Tests not re-run (test-relevant bytes unchanged; prior 3/3 PASS stands).
- Worktree note: one untracked file `reports/investigations/jev-realgame-final/default-v4/layout-openttd.json` (product of the parallel blind release-only Actions collection) — left untouched and unread.
- No default/gate/release authorization; final questions/gold remain parent-unread by this reviewer.
