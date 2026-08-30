# C2-01 Quickstart and Evidence Ledger

## Pre-fix proof

Run the minimum deterministic adjacent-store/wider-load regression from the repository root:

```sh
node tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs
```

Before implementation, the test must fail because the existing value boundary exposes no exact
reconstructed value for the load. Record the exact command, base SHA, assertion output, and
failure reason here before editing production source.

```text
PRE_FIX_SHA: 8a614ccd0184d6c25257c25d930b68af7e9ac81f
PRE_FIX_COMMAND: node tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs
PRE_FIX_FAILURE: AssertionError — actual load.dst.const=13124n (0x3344), expected 860098850n (0x33441122); current boundary forwards only the latest same-region store and omits the proven lower lane.
```

## Focused validation sequence

1. `node --check` on every changed JavaScript module and T0 contract/diff checks.
2. The focused C2-01 test file, including positives, paired negatives, stale/malformed,
   cancellation/budget/truncation, replay, and downstream behavior.
3. `npm run semantic-v2:test` and the owning phase/subsystem tests.
4. Spec Kit `converge`; if it adds tasks, implement/test/converge until CLEAN.
5. Canonical generated build twice, with the second run producing zero diff (only if this lane
   has generated inputs; this plan expects none).
6. Exact-head CI, candidate merge-tree checks, merge, and live-main post-merge verification.

## Post-fix ledger (filled during implementation)

```text
POST_FIX_SHA: exact candidate HEAD is recorded in the implementation packet (the source commit is
  cleanly rebased on the latest origin/main)
POST_FIX_COMMAND: node tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs
POST_FIX_PASS: PASS — HEX-C2-01 minimum byte-exact forwarding regression
```

The identical focused command passes after implementation. Review 1 started from
`8586617462e2adf82e573359d68f3390db3dee8a` and its independent attack set failed. The resumed
implementation also reconciled safely from that review lane onto current `origin/main` without
discarding the prior owner's dirty work. The repaired boundary now covers structural
`reachingStore` publication, canonical cross-region coverage, canonical store operand/value
binding, issuer-bound alias proofs, canonical access qualifiers, artifact/proof digests, and
producer-owned access/source binding. Exact publication additionally requires a distinct,
non-serialized producer/session identity token; the artifact's own serialized identity is
explicitly rejected as current authority. Validation enforces finite `maxDefinitions` and
`maxWorkItems` with explicit budget-limited/deadline/cancelled outcomes and no partial exact
publication. Those fixes are covered by permanent focused, semantic, point-to, decompiler, and
support-matrix regressions.

```text
SPEC_KIT_ANALYZE: CLEAN
CONVERGENCE_RESULT: CLEAN — no new tasks appended
IMPLEMENT_TASKS: T001–T027 complete
REVIEW_DELIVERY_TASKS: T028–T039 intentionally remain reviewer/delivery-owned and unchecked
BASE_SHA_PRESERVED: c6171cb4393847394be8d6d65c49ac8fd35c579f (backup/hex-c2-01-c6171cb4)
MOVING_MAIN: current origin/main 1645b4e4a2b5cd9baf37e2efe5b2e6045481b1aa, including reviewer
  66a56403 plus the two non-overlapping main commits 087ab51d and 1645b4e4; the candidate was
  stashed, rebased, and reapplied without loss. The original 39-path inventory remains exact;
  the validation-budget correction adds only canonical owner path
  js/semantics/memoryssa/contract.js, for 40 changed paths in the full candidate diff.
GRAFT: NOT RUN — repository guardrail scopes Graft to GitHub Codespaces; CODESPACES is unset in
  this environment. Normal source inspection/rg was used; graph savings are 0 tokens/commands.
FOCUSED_C2_01: PASS — canonical, compatibility, point-to, decompiler, and support-matrix assertions
PRODUCER_IDENTITY: PASS — exact query rejects artifact/self-attested identities and accepts only
  the builder-issued non-serialized producer/session token
VALIDATION_BUDGET: PASS — maxDefinitions/maxWorkItems/deadline/cancel taxonomy and atomic no-
  partial-exact publication are covered by focused regressions
SEMANTIC_TEST: direct C2-01 and touched semantic-v2 consumers PASS; the npm wrapper's child corpus
  phase remains environment-blocked (login-shell nvm rejects inherited npm_config_prefix and
  reports node not found), so its current-corpus report is 0/25 for infrastructure reasons
DECOMPILER_DIRECT_TESTS: PASS — `npm run decompiler:test` and all touched direct suites
PHASE7_TEST: PASS — 356 tests, 58 discovered files on current main
PHASE7_OWNERSHIP: PASS — manifest valid
MODULE_BOUNDARIES: PASS
EVIDENCE_WRITERS: PASS
MIGRATION_GUARDRAILS: PASS
SEMANTIC_V2_CORPUS: focused/direct touched corpus PASS; required-gates wrapper remains blocked by
  inherited npm_config_prefix (`node: command not found`)
COMPILER_TRUTH: environment limitation — clang unavailable, so extended truth executes 0/56
PHASE9_RELEASE: environment failure — release evidence cannot import missing `playwright`;
  direct phase9 tests pass 106/107, with only that release fixture blocked
```

The repository semantic-v2 and compiler-truth failures are recorded environment baselines,
not weakened or skipped assertions. Generated Phase 7 reports produced by verification were
restored and are not inputs to this lane; this feature has no generated source inputs.

## Boundaries

`C2-01` owns the canonical MemorySSA byte-forwarding query and its direct value consumer/tests.
The touched points-to, decompiler, and symbolic files are only downstream handoff gates: they
accept `isCanonicalExactMemoryForwarding`/operand capabilities and contain no private memory
graph, alias solver, structural `reachingStore`, or architecture-name forwarding. The lane does
not reopen `C1-02`, modify ABI/range engines, hand-edit generated artifacts, or alter unrelated
Issue-resolution work.
