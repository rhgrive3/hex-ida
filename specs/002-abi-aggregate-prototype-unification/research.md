# HEX-C3-02 Research Record

**Historical base**: `8a614ccd0184d6c25257c25d930b68af7e9ac81f`
**Current pre-implementation base**: `390741dcf6f8d391017b7f1ba224e35b49b973d3`

The final pre-edit reconciliation advanced the implementation branch to live
`origin/main` `48a0b42913e63f33a03783f9676994268d8a06e8` (PR #2498 merge). The
same two deterministic consumer regressions and the same locked 66-row matrix
failures were reproduced there before production edits.

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

The locked profile audit covers the following currently registered canonical
profiles. The identity/version values below were read from the registry at the
current pre-implementation base `390741dcf6f8d391017b7f1ba224e35b49b973d3`.

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
current live main `390741dcf6f8d391017b7f1ba224e35b49b973d3`, and a read-only
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
CURRENT_MAIN_SHA: 390741dcf6f8d391017b7f1ba224e35b49b973d3
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

## Graft/context-graph trace

Graft was run against this worktree. `graft map .` refreshed the graph from the
main checkout and reported 1,628 files, 14,535 symbols, and 45,570 edges. The
following compressed trace is evidence-backed by these calls:

```text
graft ask --source --limit 8 "selected ABI profile canonical classifier semanticAbiAdapter prototype recovery aggregate return hidden sret" .
graft callers recoverFunctionPrototype .
graft callers semanticAbiAdapter .
graft callers --direction out --depth 2 enhanceSemanticDecompilation .
graft callers classifyCallWithAbi .
graft callers --direction out --depth 2 analyzeSemanticFunction .
```

```text
PRODUCER:
  resolveABIPlugin -> registered ABI profile classifier
  evidence: js/targets/abi/index.js:L47-L64;
  js/targets/abi/riscv-lp64.js:L553-L618;
  js/targets/abi/riscv-lp64.js:L198-L551;
  js/targets/abi/sysv-amd64.js:L150-L387;
  js/targets/abi/microsoft-x64.js:L170-L357
CANONICAL_OWNER:
  ABI plugins under js/targets/abi/**; adapter
  js/analysis/semantic-function-base.js:L122-L230
CANONICAL_OBJECT:
  classifier argument/return pieces, classes, stack, sret, and variadic state;
  adapter publishes argument locations and call return fields
  (semantic-function-base.js:L122-L230)
IDENTITY:
  profile id, semantic version/identity, architecture/profile selection, and
  analysis identity; selection path is analyzeSemanticFunction
  (js/analysis/semantic-function.js:L198-L302) -> resolveABIPlugin
  (js/targets/abi/index.js:L47-L64)
PROVENANCE:
  classifier evidence and Semantic IR node/origin path; adapter call evidence
  is consumed by compat projectNode through classifyCallWithAbi
  (js/semantics/compat/semantic-ir-v2-to-v1-core.js:L104-L141;
  js/semantics/compat/semantic-ir-v2-to-v1-nodes.js:L460-L460)
COMPLETENESS:
  classifier partial/unsupported/unknown and stack uncertainty are retained by
  adapter; profile-specific partial results are visible in classifier spans
  above and adapter normalization (semantic-function-base.js:L122-L230)
PUBLICATION:
  analyzeSemanticFunction -> Semantic IR/compat -> call summaries and
  decompiler pipeline; enhanceSemanticDecompilation invokes prototype recovery,
  aggregate layouts, high variables, and C-AST publication
  (js/decompiler/pipeline-core.js:L615-L714)
INVALIDATION:
  summary identity gates function/snapshot/analyzer identity
  (js/analysis/summary/local.js:L180-L194;
  js/analysis/summary/contract.js:L222-L265); phase8 invalidation derives
  changed producer/consumer keys (js/decompiler/phase8/transaction.js:L114-L118)
DIRECT_CONSUMERS:
  recoverFunctionPrototype (js/decompiler/types/prototype.js:L237-L277),
  pipeline ABI argument locations (js/decompiler/pipeline-core.js:L33-L47),
  compat projectNode/classifyCallWithAbi, summaries, and type/layout recovery
DOWNSTREAM:
  enhanceSemanticDecompilation -> runPhase8Stage, recoverAggregateLayouts,
  recoverHighVariables, semantic AST/C-AST and printed decompiler output
  (js/decompiler/pipeline-core.js:L615-L714)
TEST_OWNER:
  existing phase5/phase6 ABI contracts, issue-135-145 AAPCS contract, and
  tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
COLLISIONS:
  merged PR #2499 owns the prior prototype overlap; after reconciliation, live
  main is 48a0b42913e63f33a03783f9676994268d8a06e8. Its delta from the #2499
  merge is PR #2493's ARM64 SIMD GP/ZR guard and test, with no ABI semantic
  overlap; PR #2498 changes compact-unwind metadata only and is now merged.
  The implementation was approved by Sol after refreshed clean analysis.
```

## Current-main profile matrix (read-only)

Command 1 is the minimum deterministic regression and is the required
`CURRENT_PRE_FIX_COMMAND`:

```text
node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
```

At `48a0b42913e63f33a03783f9676994268d8a06e8`, it reports four subtests:
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

## Implementation evidence

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
