# G direct recompilability repair campaign

Status: IN PROGRESS; G must not be closed from this checkpoint.

Base: `82a10ee1c84970f73d8e8c4eab23fc2bfd0e51b2`, including Phase 2 PR #9226.
Phase 1 source commits: `a20983b0a`, `10d53eeee`, `0313cef5c`.
Phase 1 measurement candidate: `747761bbe`.
PR: https://github.com/rhgrive3/hex-ida/pull/9229

The existing raw baseline and public benchmark artifacts are unchanged. Historical
counts are not subtracted to estimate remaining defects. Full fresh corpus counts
are pending. A host C compiler probe does not establish ARM64 execution correctness.

## Confirmed additional production defect

The initial semantic renderer emits a type-backed stack declaration, but the C AST
expression renderer independently changes the stack name. Counterexample:
`sdiv x2,x0,x1; str x2,[sp,#0x10]; ret` formerly declared `int64 var_10;`
and assigned `local_p10 = ...;`. The repair binds the declaration to its actual
IR stack slot through a producer-owned record and makes C AST memory references
use that same name. This neither guesses a type nor mutates recovered type metadata.
The division expression, including its zero-divisor semantics, is unchanged.

## Focused counterexamples and mutations

`tests/direct-recompilability-emitter-phase1.test.mjs` covers label placement,
shared cleanup after nested if/while/switch, evidence-backed locals, missing type
evidence, unchanged executable statements, and final C AST declaration ownership.

Run the test with the in-memory loader to restore each defect without modifying
production files:

```sh
HEX_RECOMPILABILITY_MUTATION=nested-close node --import ./tests/helpers/recompilability-mutation-loader.mjs --test tests/direct-recompilability-emitter-phase1.test.mjs
```

| Mutation | Expected failing counterexamples | Observed |
|---|---|---|
| `nested-close` | if/while/switch cleanup boundary | 3 failed, exit 1 |
| `label-floor` | label between signature and opening brace | 1 failed, exit 1 |
| `naive-declarations` | stack slot exists but type is unknown | 1 failed, exit 1 |
| `orphaned-stack-declaration` | declared and referenced slot spelling diverges | 1 failed, exit 1 |

Phase 1 + Phase 2 focused tests: 21/21 passed before the additional handoff repair.
Handoff repair plus signed stack-identity regressions: 16/16 passed.
These are checkpoint results, not final exact-head verification.

Persistent local receipts:
`/mnt/workspace/.dev-state/agent-work/evidence/g-recompilability-20260919/`.
The first full subject attempt on `1/1_clang_O0_g` timed out at 90 seconds with no
completed artifact; it is not counted as a compiler result. A bounded eight-function
probe isolated opening (~1.1s) from analysis (e.g. sequential_ops ~8.1s). The fresh
harness must preserve function progress and a retry manifest instead of losing an
entire case on timeout.
