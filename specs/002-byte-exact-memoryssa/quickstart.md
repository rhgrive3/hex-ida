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
producer-owned access/source binding. Exact publication additionally requires membership in a
private, canonical-builder-issued object set; no producer token, registrar, transfer hook, or
artifact property is readable by consumers, and the artifact's serialized identity is never
authority. Validation enforces finite `maxDefinitions` and `maxWorkItems` with explicit
budget-limited/deadline/cancelled outcomes and no partial exact publication. Those fixes are
covered by permanent focused, concurrent-replay, semantic, point-to, decompiler, and
support-matrix regressions.

```text
SPEC_KIT_ANALYZE: CLEAN — installed Spec Kit `specify 1.0.1` prerequisites resolved the feature
  directory; all 13 functional requirements and 8 success criteria map to completed tasks with
  no contradictions across spec/plan/tasks/constitution.
CONVERGENCE_RESULT: CLEAN — implementation was checked against the plan and task traceability;
  no new tasks were required and `tasks.md` stayed byte-for-byte unchanged.
IMPLEMENT_TASKS: T001–T027 complete
REVIEW_DELIVERY_TASKS: T028–T039 intentionally remain reviewer/delivery-owned and unchecked
BASE_SHA_PRESERVED: c6171cb4393847394be8d6d65c49ac8fd35c579f (backup/hex-c2-01-c6171cb4)
MOVING_MAIN: current origin/main 99bb9a40420c5611601c0c4b6a28af22185ecbe0; the checkpoint
  37c7221090d76366ff69c80469dba6bba3258726 was safely rebased onto it. Main changes since the
  old merge-base, merged PR #2775, and open PR #2745 have zero path overlap with the feature
  inventory; no semantic or generated collision was found. The original 39-path inventory
  remains exact; the validation-budget correction adds only canonical owner path
  js/semantics/memoryssa/contract.js, for 40 changed paths in the full candidate diff.
GRAFT: PASS — actual `graft map` and three `graft ask --source` traces ran; aggregate graph
  savings are approximately 3,910,178 tokens for this implementation turn.
FOCUSED_C2_01: PASS — canonical, compatibility, point-to, decompiler, and support-matrix assertions
PRODUCER_AUTHORITY: PASS — exact query accepts only the exact object issued by the canonical
  builder's private WeakSet; exports contain no readable identity/binding token, registrar, or
  transfer hook, and clones/tampered/re-signed/IR-null artifacts stay stale without rebuild.
VALIDATION_BUDGET: PASS — maxDefinitions/maxWorkItems/deadline/cancel taxonomy and atomic no-
  partial-exact publication are covered by focused regressions
SEMANTIC_TEST: direct C2-01 and touched semantic-v2 consumers PASS; the npm wrapper's child corpus
  phase remains environment-blocked (login-shell nvm rejects inherited npm_config_prefix and
  reports node not found), so its current-corpus report is 0/25 for infrastructure reasons
DECOMPILER_DIRECT_TESTS: PASS — `npm run decompiler:test` and all touched direct suites
PHASE7_TEST: PASS — 361 tests, 60/60 discovered files on current main
PHASE7_OWNERSHIP: FEATURE INVENTORY PASS — 40/40 paths match the amended path-exact allowlist,
  with no outside or missing paths; the generic Phase 7 manifest is intentionally not the C2-01
  owner because it forbids the canonical MemorySSA paths this feature owns.
PHASE7_GLOBAL_OWNERSHIP: NOT APPLICABLE — the generic p7 lane intentionally rejects these
  feature-owned semantic/decompiler paths; no global Phase 7 allowlist was relaxed
EXACT_HEAD_VERIFIER: READY — final clean candidate run uses the full `--expect-sha $(git rev-parse
  HEAD)` identity; the generated READY evidence identity is reported in the implementation packet.
CANDIDATE_MERGE_TREE: conflict-free for origin/main 99bb9a40420c5611601c0c4b6a28af22185ecbe0
  plus the final source candidate
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
