# HEX-C3-02 Research Record

**Historical base**: `8a614ccd0184d6c25257c25d930b68af7e9ac81f`
**Historical pre-implementation base (superseded)**: `390741dcf6f8d391017b7f1ba224e35b49b973d3`

The final pre-edit reconciliation advanced the implementation branch to live
`origin/main` `48a0b42913e63f33a03783f9676994268d8a06e8` (PR #2498 merge). This
is historical baseline evidence; the final implementation-owner restack is
bound to the newer main head recorded below.

## Decision: retain one ABI owner

The canonical owner is the registered ABI plugin in `js/targets/abi/**`, with
`js/analysis/semantic-function-base.js` as the shared `semanticAbiAdapter`
boundary. `js/analysis/semantic-function.js` resolves the profile and binds
architecture/profile identity. Semantic IR call classification, summaries,
prototype recovery, type recovery, layout, and decompiler rendering are
consumers. No consumer may classify ABI placement from register spelling or
architecture-name heuristics.

Rationale: the repository already has profile-specific classifiers for Darwin
ARM64, AAPCS64, SysV AMD64, Microsoft x64/vectorcall, and RISC-V LP64-family
profiles. Replacing or duplicating those facts would create the second semantic
truth forbidden by the constitution.

## Decision: make evidence state part of the published contract

An exact downstream fact requires a supported, identity-valid classifier result
that is complete for the requested argument/return/aggregate fact and has no
unresolved layout, variadic, caller/callee, indirect-call, thunk, or tail-call
conflict. Partial, unsupported, unknown, stale, malformed, cancelled,
truncated, and budget-limited states remain explicit. A failed classifier call
publishes no staged exact result.

Rationale: the current ABI implementations intentionally return `partial`,
`unsupported`, `stackArgsUnknown`, and explicit reasons for unproven aggregate
flattening. A consumer must preserve those boundaries instead of laundering
them into a prototype.

## Decision: profile audit scope

The locked profile audit covers the following canonical profiles. The
identity/version values below were read from the registry at the historical
pre-implementation base `390741dcf6f8d391017b7f1ba224e35b49b973d3`.

| Profile | Identity | Architecture | Important conservative boundary |
|---|---|---|---|
| Darwin ARM64 | `darwin-arm64@1` | `arm64` | HFA/HVA and compact stack rules are profile-specific; unknown prototypes are partial. |
| AAPCS64 | `aapcs64@2` | `arm64` | aggregate register/stack normalization and hidden `x8` sret; unknown prototypes are partial. |
| SysV AMD64 | `sysv-amd64@2` | `x86_64` | eightbyte aggregate layout, split/mixed classes, and unknown/partial aggregate placement. |
| Microsoft x64 | `microsoft-x64@3` | `x86_64` | trivial aggregate and hidden `rcx`/`rax` result rules; unknown prototypes remain partial. |
| Microsoft vectorcall | `microsoft-vectorcall@1` | `x86_64` | vector/HVA placement; non-HVA aggregate return requires layout proof. |
| RISC-V LP64 | `lp64@1` | `riscv64` | integer `x10`–`x17`, aggregate-by-reference and hidden result input `x10`. |
| RISC-V LP64F | `lp64f@1` | `riscv64` | hard-float aggregate flattening is explicitly unproven/partial. |
| RISC-V LP64D | `lp64d@1` | `riscv64` | same aggregate flattening boundary; integer facts remain profile-correct. |
| Unknown | `unknown@1` | `unknown` | unsupported classifier returns no exact argument or return locations. |

`arm64e` is accepted by registry matching only as an architecture-compatible
candidate for an `arm64` plugin. It is not proof of an Apple platform profile;
the final contract must retain the requested architecture/profile identity and
require explicit platform selection. The current-main profile matrix tested
this distinction.

## Decision: first remaining divergence and deterministic proof

PR #2499 corrected the historical consumer bug: the original RISC-V and
unsupported-ABI smoke regression now passes. The branch was fast-forwarded to
the then-current live main `390741dcf6f8d391017b7f1ba224e35b49b973d3`, and a read-only
profile/ABI matrix was run before any production edit. It found the first
remaining soundness divergence in `abiContext`:

* `js/decompiler/types/prototype.js:L14-L51` resolves a registered plugin by
  adapter `id` without validating semantic version/identity, architecture, or
  completeness. Stale, malformed, mismatched, and conflicting adapters are
  therefore accepted as supported (`conventionKnown: true`).

The next downstream divergence is in `registerArguments`
(`prototype.js:L92-L120`): it classifies each live entry physical register
independently and has no canonical argument/piece grouping. AAPCS64, Darwin
HFA, Microsoft vectorcall HVA, and RISC-V LP64 multi-register aggregates are
therefore split into separate prototype arguments; Microsoft aggregate-indirect
class/pointer evidence is also lost. `classifyReturn`/`returnLocations`
(`prototype.js:L188-L235`) similarly drop canonical aggregate piece classes and
do not project SysV explicit aggregate return pieces.

These are independently chosen expectations from the registered classifier
contract, not implementation self-oracles. The revised regression
`tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs` constructs one stale
`aapcs64@1` adapter and one canonical AAPCS64 128-bit aggregate with x0/x1
pieces. On current main both fail closedness/grouping assertions before any
production fix.

Recorded baseline:

```text
PRE_FIX_SHA: 8a614ccd0184d6c25257c25d930b68af7e9ac81f
PRE_FIX_COMMAND: node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
PRE_FIX_RESULT: FAIL (exit 1)
PRE_FIX_FAILURE_1: expected convention lp64, received AAPCS64
PRE_FIX_FAILURE_2: expected unsupported conventionKnown=false, received undefined
```

Recorded current-main baseline:

```text
HISTORICAL_CURRENT_MAIN_SHA: 390741dcf6f8d391017b7f1ba224e35b49b973d3
CURRENT_PRE_FIX_COMMAND: node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
CURRENT_PRE_FIX_RESULT: FAIL (exit 1; 2 passing, 2 failing)
CURRENT_PRE_FIX_FAILURE_1: stale adapter aapcs64@1 yields conventionKnown=true
CURRENT_PRE_FIX_FAILURE_2: canonical AAPCS64 x0/x1 aggregate yields 2 prototype
                            arguments instead of 1 grouped argument
```

## Decision: collision handling

PR #2499 (`b12ccf604a454416d986c4e6b2bee461d0519368`) directly changed the
canonical prototype owner and added a phase8 ABI integration test. It merged at
`be5636b1baeadfaef5ae10d81406f02118dca780` after the initial collision wait.
The merged PR #2500 AAPCS64 contract remains an existing regression. The lane
was fast-forwarded to current main
`390741dcf6f8d391017b7f1ba224e35b49b973d3`; the merged #2499 owner/test
inventory was re-audited and no semantic ABI overlap remains with current open
PR #2498 (compact unwind). It remains `SAFE_TO_PROCEED: NO` because this is a
revised pre-implementation checkpoint awaiting Sol's plan-correction approval.
The specification, current failing regression, and design artifacts are safe
to prepare; no production file has been edited.

## Context-graph trace and environment gate

Graft was not run for this implementation-owner turn. The repository guardrail
permits Graft only inside GitHub Codespaces; this worktree has `CODESPACES`
unset, so installing, invoking, or emulating Graft would violate the gate. The
context audit therefore used local `git`, `rg`, exact source spans, and the
Spec Kit artifacts below. No Graft token or graph-savings claim is made.

```text
GRAFT_STATUS: NOT_RUN_BY_OUTSIDE_CODESPACES_GUARD
GRAFT_SAVINGS: NOT_APPLICABLE (0 tokens claimed)
LOCAL_TRACE:
  resolveABIPlugin -> registered ABI profile classifier
  evidence: js/targets/abi/index.js; js/targets/abi/riscv-lp64.js;
           js/targets/abi/sysv-amd64.js; js/targets/abi/microsoft-x64.js
  canonical owner: js/targets/abi/** and js/analysis/semantic-function-base.js
  direct consumers: js/decompiler/types/prototype.js,
                    js/decompiler/pipeline-core.js,
                    js/decompiler/type-recovery.js,
                    js/decompiler/semantic-core.js,
                    js/semantics/compat/**
  downstream: enhanceSemanticDecompilation -> phase8, aggregate layouts,
              high variables, semantic AST/C-AST, and printed output
  tests: tests/phase5/abi/**, tests/phase6/abi/**,
         tests/phase8/abi/hex-c3-02-*.mjs
```

## Historical current-main profile matrix (read-only)

Command 1 is the minimum deterministic regression and is the required
`CURRENT_PRE_FIX_COMMAND`:

```text
node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
```

At historical main `48a0b42913e63f33a03783f9676994268d8a06e8`, it reports four subtests:
two pass (selected RISC-V profile and unsupported ABI) and two fail (stale
`aapcs64@1` accepted as supported; canonical AAPCS64 x0/x1 aggregate split
into two prototype arguments). Exit status is `1`.

Command 2 is the locked read-only matrix invocation used for the profile audit:

```text
node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
```

Its exact run produced:

```text
MATRIX_SUMMARY total=66 passed=54 failed=12
MATRIX_EXIT=1
```

The 54 passing rows cover all ten profile-identity selections; scalar integer,
FP, and pointer arguments and returns for all eight supported profiles; Darwin
and AAPCS64 aggregate/HFA arguments; SysV explicit INTEGER/SSE eightbytes and
unknown aggregate partial state; Microsoft aggregate-indirect and vectorcall
HVA; RISC-V LP64 aggregate and LP64F/LP64D partial boundaries; large aggregate
by-reference cases; aggregate returns; hidden sret for AAPCS64, Microsoft x64,
and RISC-V; hard-float/vectorcall partial returns; known variadic frontiers;
unknown prototypes; and unsupported ABI.

The 12 failing rows are all current consumer gaps, not harness/profile errors:
four stale/malformed/architecture-mismatched/conflicting adapters are accepted
as supported; ABI semantic identity is absent; AAPCS64, Darwin HFA, vectorcall
HVA, and LP64 aggregate pieces are flattened; Microsoft aggregate-indirect
class/pointer evidence is lost; AAPCS aggregate return piece metadata is lost;
and SysV explicit aggregate return pieces are omitted. The RISC-V soft/hard
float class expectations and x86 physical-register aliasing were corrected in
the final run (`xmmN` is stored as canonical physical `ymmN`); no such harness
rows remain in the 12 failures.

## Historical implementation evidence (superseded checkpoint)

The implementation was approved after `ANALYZE_RESULT: CLEAN` and the #2499
collision was closed by its merge. It keeps the registered profile classifier
as the only placement authority. The adapter now carries semantic identity,
architecture/profile identity, canonical provenance, and binary/slice/function
invalidation keys. Prototype recovery consumes canonical argument/return
classification, preserves aggregate pieces and split register/stack entries,
and rejects stale, unsupported, malformed, incomplete, cancelled, truncated,
budget-limited, indirect-call, and caller/callee-conflict evidence.

```text
IMPLEMENTATION_BASE_SHA: 48a0b42913e63f33a03783f9676994268d8a06e8
PRE_FIX_COMMAND_1: node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
PRE_FIX_RESULT_1: FAIL (exit 1; 2 passing, 2 failing)
PRE_FIX_COMMAND_2: node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
PRE_FIX_RESULT_2: FAIL (exit 1; MATRIX_SUMMARY total=66 passed=54 failed=12)
POST_FIX_COMMAND_1: node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
POST_FIX_RESULT_1: PASS (17 tests)
POST_FIX_COMMAND_2: node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
POST_FIX_RESULT_2: PASS (MATRIX_SUMMARY total=66 passed=66 failed=0)
POST_FIX_COMMAND_3: npm run phase8:test
POST_FIX_RESULT_3: PASS (30/30 discovered files; 290 tests)
FOCUSED_SUBSYSTEM_RESULT: PASS (selected phase5/phase6 ABI, compatibility, and decompiler suites; 42 tests)
PHASE5_RESULT: PRE_EXISTING_BASELINE (275 pass, 4 fail; exact frozen Clang/LLD unavailable)
PHASE6_RESULT: PRE_EXISTING_BASELINE (105 pass, 10 fail; exact frozen RISC-V toolchain unavailable)
CONVERGENCE_RESULT: CLEAN (implementation scope accounted for; no generated tasks)
```

The full phase5/phase6 failures are environment/toolchain gates with
`P5_6_TOOLCHAIN_MISMATCH`/`P6_TOOLCHAIN_MISMATCH`, not failures in the changed
ABI/decompiler suites. No generated artifact input was changed.

## Review 1 correction refresh (implementation owner)

The worktree was refreshed from live `origin/main` at
`4900032916b6b5ba3171e73d1d1cccc2a0d45067` before applying the Review 1
corrections. The correction set adds permanent regressions and fail-closed
paths for unproven aggregate size/member layout on AAPCS64, Darwin arm64, and
RISC-V LP64-family profiles; rejects partial and budget-limited hidden sret
evidence; validates aggregate argument byte spans/classes/order at the
compatibility boundary; requires an explicit Darwin platform identity; and
preserves known variadic fixed prefixes while keeping anonymous candidates
uncertain. The Spec Kit feature resolver was exercised through both
`.specify/feature.json` and `SPECIFY_FEATURE_DIRECTORY`; both resolved the same
absolute feature directory without changing the ledger. Trailing whitespace in
the ABI checklist and research header was removed. Review and delivery tasks
remain open for their independent gates.

```text
REFRESHED_LIVE_MAIN_SHA: 4900032916b6b5ba3171e73d1d1cccc2a0d45067
CORRECTION_TEST_COMMAND: node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
CORRECTION_TEST_RESULT: PASS (38 tests)
LOCKED_PROFILE_MATRIX_RESULT: PASS (66/66 rows)
```

The moving-main reconciliation then refreshed `origin/main` to
`4b5e87a2d76f5e7dff0614661fecc25a46004bd6`. Its post-`49000329` commits do
not touch the C3-02 canonical ABI, prototype, compatibility, or regression
surfaces; the only tracked noise change is the repository-wide node_modules
untracking. The implementation branch retained its C3-02 files and recorded
this as a no-semantic-overlap reconciliation; final tests were rerun after the
refresh.

```text
MOVING_MAIN_OLD_BASE: 4900032916b6b5ba3171e73d1d1cccc2a0d45067
MOVING_MAIN_CURRENT: 4b5e87a2d76f5e7dff0614661fecc25a46004bd6
MOVING_MAIN_OVERLAPPING_FILES: node_modules only (tracking policy)
MOVING_MAIN_SEMANTIC_OVERLAP: NO
MOVING_MAIN_RETEST_REQUIRED: YES (focused/profile gates rerun)
```

An immediate pre-handoff refresh advanced `origin/main` again to
`9cca81bb2317cfea9b4e3379825265d92a26f55c`. That commit changes only the UI
route/diff surface (`js/diff/**`, `js/ui/**`, `js/workspace.js`, and their
regressions); it has no overlap with the C3-02 ABI classifier, adapter,
prototype, compatibility, phase8 ABI, or Spec Kit implementation files. No
semantic rebase was required; the final C3-02 gates remain bound to this
branch's exact head and the parent campaign will reconcile this unrelated
moving-main change before Review 2/merge.

```text
MOVING_MAIN_LATEST: 9cca81bb2317cfea9b4e3379825265d92a26f55c
MOVING_MAIN_LATEST_OVERLAP: NO
MOVING_MAIN_LATEST_ACTION: retain reviewed implementation head; parent campaign reconciles before Review 2/merge
```

## Final implementation-owner reconciliation

The implementation-owner worktree was safely restacked again after fetching
the newest available `origin/main`. The prior dirty work and pre-restack
commits remain recoverable under `backup/c3-02-before-restack` and
`backup/c3-02-before-latest-restack`; the old merge commit's unrelated
main-side changes were not replayed. The intended branch now starts at the
exact fetched main head and contains only the C3-02 finding/doc/test commits.
Review and delivery tasks remain open.

```text
FETCHED_ORIGIN_MAIN: 3ac625938333636bcc6c00634d2e21648778ce0f
RESTACK_BASE: 3ac625938333636bcc6c00634d2e21648778ce0f
CODE_RESTACK_HEAD: 3b868746cbdd3823a82e73fac4c52cb631ef6d4c
RESTACK_METHOD: backup old heads; new branch from latest origin/main; cherry-pick only C3-02 commits after 204c; skip old merge commit
RESTACK_SHARED_ROOT_RESET: NO
RESTACK_DISCARD: NO
```

Final implementation-owner evidence:

```text
FOCUSED_COMMAND: node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs tests/phase8/integration/issue-2478-abi-prototype-recovery.test.mjs
FOCUSED_RESULT: PASS (45 tests)
LOCKED_PROFILE_MATRIX_COMMAND: node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
LOCKED_PROFILE_MATRIX_RESULT: PASS (66/66 rows)
DOWNSTREAM_COMMAND: node tests/issue-914-stack-return-reanchor.mjs; node tests/decompiler-pipeline.mjs; node --test tests/phase6/generic-core/issues-907-909-910-913.test.mjs
DOWNSTREAM_RESULT: PASS (issue 914, pipeline, and 17 generic-core tests)
LEGACY_REGISTER_AUDIT: PASS; generic consumers query canonical adapter locations; x0/x0..x7 literals remain only in explicit legacy presentation paths
SPECKIT_PREREQUISITES: PASS (feature directory, required tasks, and available design artifacts resolved)
SPECKIT_ANALYZE_RESULT: CLEAN (13 functional requirements, 9 success criteria, and 39 tasks mapped; no contradictions or coverage gaps)
SPECKIT_CONVERGENCE_RESULT: CLEAN (no additional implementation tasks; T027-T035 remain open review/delivery gates by instruction)
PHASE5_RESULT: PASS (44/44 discovered files; 279 tests)
PHASE6_RESULT: PASS (23/23 discovered files; 116 tests)
PHASE8_RESULT: PASS (30/30 discovered files; 322 tests)
HISTORICAL_GENERATED_DOUBLE_RUN: NOT_APPLICABLE (historical checkpoint; the
current semantic-function-base change makes generated applicability YES)
REVIEW_TASKS: OPEN (T027-T035 intentionally unchanged)
```

## Alternatives rejected

- **Keep the existing prototype literals**: rejected because they fabricate
  AAPCS64 facts for RISC-V, x86_64, and unsupported profiles.
- **Add a decompiler-only ABI classifier**: rejected because it creates a
  second semantic truth and can disagree with Semantic IR and summaries.
- **Treat all registered profiles as exact**: rejected because LP64F/LP64D
  aggregate flattening, vectorcall non-HVA returns, anonymous varargs, and
  unknown identity are intentionally partial or unsupported.
- **Merge around #2499 without reconciliation**: rejected because two changes
  would compete for the canonical prototype owner and invalidate review/CI
  evidence.

## Review 1 correction/resume evidence (2026-08-30)

This resume starts from the requested clean exact head
`42d472c310c12685e59dbf13a59e7572e8429ae2`. The C3-02 scope inventory remains
anchored at `3ac625938333636bcc6c00634d2e21648778ce0f` and contains exactly 38
feature paths. The requested moving-main checkpoint
`66a5640359c5b39526fb89f6937e023294e54bdd` is an ancestor of the currently
fetched `origin/main` `1645b4e4a2b5cd9baf37e2efe5b2e6045481b1aa`; the latter
also contains unrelated identity-hardening commits. The moving-main decision
is therefore recorded as a candidate-tree gate, not silently substituted with
the historical `66a` SHA. The origin-main changes from scope base touch only
project/runtime identity surfaces and their tests, with no semantic ABI owner
overlap.

Graft was not invoked: this worktree is outside GitHub Codespaces (`CODESPACES`
is unset), and the repository guardrail explicitly forbids installing,
emulating, or requiring Graft in that environment.

### Counterexample-first correction

The first correction run deliberately executed the new five tests before the
production changes:

```text
node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs
PRE_FIX_CORRECTION_RESULT: 45 total, 40 pass, 5 fail (exit 1)
```

The failures were the forced-stack HFA/HVA physical-slot overlap, unlocated
aggregate padding accepted as exact, unsafe/string/non-finite/overflowing
coordinates accepted by piece normalization, duplicate scalar stack evidence
accepted, and stale stack-layout cache after same-identity registry
replacement. The unchanged assertions now pass:

```text
node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs
POST_FIX_BOUNDARIES: 45 pass, 0 fail
node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
POST_FIX_BOUNDARY_PROFILE: 49 pass, 0 fail
node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs tests/phase8/integration/issue-2478-abi-prototype-recovery.test.mjs
POST_FIX_BOUNDARY_PROFILE_DOWNSTREAM: 50 pass, 0 fail
node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
POST_FIX_REQUIRED_PROFILE_MATRIX: MATRIX_SUMMARY total=66 passed=66 failed=0
```

The AAPCS64 producer now derives homogeneous physical spans from the canonical
member layout and uses `max(8, elementBytes)` for each forced-stack element;
the wrapper and prototype consumer preserve those offsets and group the lanes
under one canonical parameter. Aggregate layout evidence requires every
member-plus-padding byte to be located, ordered, non-overlapping, and covered.
Piece normalization rejects non-number, unsafe, non-finite, and overflowed
coordinates. A single validator checks exact stack spans across argument and
return projections and allows only an explicitly identified canonical split;
duplicate scalar evidence fails closed. Registry bindings now carry a monotonic
generation and classifier digest, while prototype caches are keyed by the
exact registered profile object and adapter identity requires that same object
and digest.

### Ownership and lifecycle truth

The Phase 8 lane manifest was not widened. The dedicated
`tools/validation/phase-ownership/c3-02.json` manifest explicitly assigns all
38 feature paths to `abi-canonical`, `adapter-and-compat`,
`prototype-consumer`, `spec-and-lifecycle`, or `cross-phase-regressions` and
lists generated paths and governance paths separately. Its cross-lane
decisions explain that Phase 5 owns canonical producer behavior, Phase 6 owns
compatibility contracts, Phase 7 owns the shared adapter seam, Phase 8 owns
prototype consumers, and integration owns generated output. The dedicated
gate currently reports:

```text
node tools/validation/c3-02-ownership.mjs --check-manifest
OWNERSHIP_MANIFEST: valid=true featurePaths=38 generatedPaths=2
node tools/validation/c3-02-ownership.mjs --base-sha 3ac625938333636bcc6c00634d2e21648778ce0f --head-sha 42d472c310c12685e59dbf13a59e7572e8429ae2
OWNERSHIP_INVENTORY: featureCount=38 generatedCount=0 governanceCount=0 violations=0
```

The installed Spec Kit was discovered rather than inferred:

```text
specify --version: 1.0.1
specify workflow list/info speckit: Full SDD Cycle v1.0.0
.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks: PASS
.specify/scripts/bash/setup-tasks.sh --json: PASS
specify bundle list: no project bundles
specify bundle validate: expected no-bundle error (not a project bundle)
specify integration status: warning/error for unsafe multi-install `agy`; no files changed
```

No unsupported `specify speckit` command or fabricated resource was used. The
current artifacts explicitly retain specify, clarify, plan, checklist, tasks,
analyze, implement, and converge evidence; T027–T035 and delivery work remain
open. The refreshed analyze/converge result is intentionally recorded only
after the final task ledger and moving-main/generated gates complete.

### Test and generated-output status

The owning suites currently pass after the correction: Phase 5 `44/44` files
and `279` tests, Phase 6 `23/23` files and `116` tests, and Phase 8 `30/30`
files and `327` tests. Generated applicability is YES because
`js/analysis/semantic-function-base.js` reaches the bundled worker graph used
by `scripts/build-userscript.mjs`. The canonical dependency restore and two-run
generator transaction are still required; no generated output is hand-edited.

The dependency restore and a deterministic pre-candidate generator transaction
completed successfully:

```text
npm ci: PASS (42 packages added; npm reported one existing high-severity audit finding)
npm run userscript:build (first run): PASS; expected generated paths only
  userscript/hex.user.template.js
  userscript/release-version.json
FIRST_GENERATED_DIFF_DIGEST: 3a8c775c477eada799ac768e7f6756e88d26009a875a0a80b714b012fe3e3ee5
npm run userscript:build (second run): PASS
SECOND_GENERATED_DIFF_DIGEST: 3a8c775c477eada799ac768e7f6756e88d26009a875a0a80b714b012fe3e3ee5
GENERATED_ADDITIONAL_DIFF: ZERO
```

This transaction was repeated once more to verify stability, but the final
candidate-context transaction remains a delivery task (T047/T048) and must be
recorded after the final source head is committed.

### Candidate-tree reconciliation after implementation commit

The implementation commit is `9363140a65b81d56eb502814791bc2dd24c472a6`.
During the final reconciliation, `origin/main` advanced from the requested
checkpoint `66a5640359c5b39526fb89f6937e023294e54bdd` through independent
runtime/project identity fixes to
`7fb8e58daf542ac8a12807fb5adf2796a9aa01af`. The requested checkpoint is an
ancestor of that fetched head. The origin-main delta from C3 scope base
`3ac625938333636bcc6c00634d2e21648778ce0f` is limited to project/runtime
identity files and Phase 10/project regressions; it has no semantic ABI owner
overlap. A candidate merge tree was computed without changing branch history:

```text
git merge-tree --write-tree HEAD origin/main
CANDIDATE_MERGE_TREE: 1534a6894be15859e15b5f2d4f30d8a8a17a46ae
CANDIDATE_MERGE_CONFLICTS: none
MERGE_BASE: 3ac625938333636bcc6c00634d2e21648778ce0f
```

The candidate tree preserves the 42 C3-owned tracked paths relative to the
scope base (38 feature paths, two generated outputs, and two governance files)
and adds only the nine independent origin-main paths listed above. No merge or
PR was created, consistent with the implementation-owner handoff constraint.

The final candidate-context generator transaction was repeated after this
reconciliation. It retained only the two canonical generated paths and
produced a zero-additional-diff digest on its second run.

Final candidate-context generated transaction (after commit and candidate-tree
selection) completed successfully:

```text
CANDIDATE_GENERATED_BASE: 42d472c310c12685e59dbf13a59e7572e8429ae2
CANDIDATE_GENERATED_FIRST_RUN: PASS (userscript serial 2322242114; generated paths already contain the expected diff)
CANDIDATE_GENERATED_EXPECTED_DIFF_DIGEST: 9fc1c9df4de139d093ec85202f821daee61f079874357126b8ccbb0ec4d6cf0c
CANDIDATE_GENERATED_SECOND_RUN: PASS
CANDIDATE_GENERATED_SECOND_DIFF_DIGEST: 9fc1c9df4de139d093ec85202f821daee61f079874357126b8ccbb0ec4d6cf0c
CANDIDATE_GENERATED_ADDITIONAL_DIFF: ZERO
```

The ownership gate on the committed implementation reports
`featureCount=38`, `generatedCount=2`, `governanceCount=2`, and
`violations=0`, with inventory digest
`32e07ef84727ec5035437df0065760958be2f797bba9ff2ffd6fd6a2811a119a`.

`specify integration status` was also run against the installed CLI. It
reports `ERROR unsafe-multi-install` because `agy` is not multi-install safe,
plus ten managed-file modification/collision warnings for the Codex
integration. No integration upgrade or generated skill rewrite was attempted;
this is an environment/lifecycle warning, not a fabricated Spec Kit command or
an artifact failure.

### Final read-only Spec Kit analysis and convergence

After the correction tasks and final candidate-context checks, the installed
Spec Kit prerequisite resolver returned the feature directory and required
tasks. A read-only cross-artifact analysis loaded the constitution plus
`spec.md`, `plan.md`, and `tasks.md`; it found no placeholders, no uncovered
requirements, no duplicate task IDs, no contradictory ownership decision, and
no task-order inconsistency. All 16 functional requirements and 10 buildable
success criteria map to the 49 unique tasks (11 remain open because they are
independent review/delivery gates). No new convergence task was needed.

```text
SPECKIT_FINAL_ANALYZE_COMMAND: .specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
SPECKIT_FINAL_ANALYZE_RESULT: CLEAN (26/26 requirements and success criteria covered; 49/49 unique tasks; no placeholders)
SPECKIT_FINAL_CONVERGE_RESULT: CLEAN (all implementation/convergence work satisfied; no Phase 8 convergence section appended; review/delivery tasks remain open)
SPECKIT_FINAL_IMPLEMENT_RESULT: COMPLETE for implementation tasks T040–T048; T027–T035 and T049 remain open by instruction
```

The converge assessment was intentionally limited to the artifacts' declared
scope and did not turn independent reviewer, merge, exact-head CI, or live-main
tasks into implementation findings.

The final full Phase 8 run was executed after the generation-field change and
candidate-tree reconciliation:

```text
npm run phase8:test: PASS (30/30 discovered files; 327 tests; 327 pass; 0 fail)
```
