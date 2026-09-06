# Stage A convergence governance successor draft

Status: `UNPUBLISHED_DRAFT`. This document records a reviewable, owner-scoped
successor proposal. It does not activate T061, register a candidate gate,
promote a task, publish an integration receipt, or admit a production component.

The draft is anchored to exact commit
`f8b8f1bc27e743c2b7f09d7407bd5242c5df357b` and tree
`4a07bee6258469927be7b6caae191a207037cf0a`. The original task text is retained
as an exact 100645-code-unit/101048-byte prefix with SHA-256
`c6340e1dfecd18a81713512e96eccb17a2a8c5368c938b2c3339d4ba44e1b383`; the
full successor task text is bound in `stage-a-convergence.json`. The frozen
foundation ownership digest remains
`17c869290b57aef76a1ee1d68ea32338`, and the frozen initial candidate-gate
digest remains `63fb512b688c281f862740411f20df72`.

## Route and ownership

| Task | Role | Dependencies | Checkpoint | Admission rule |
| --- | --- | --- | --- | --- |
| T062 | `STAGE_A_CONVERGENCE_GOVERNANCE` | T009, T061 | separate governance receipt | exact T061 DONE maintenance receipt, serialized reuse of the historical T009 specs owner, and independently reviewed T046 successor amendment |
| T063 | `STAGE_A_CONVERGENCE_COMPONENT` | T062, T011, T017 | T049 | exact T011/T017 handoffs, T062 receipt, actual producer oracle, and resolved external overlaps |
| T064 | `STAGE_A_CONVERGENCE_COMPONENT` | T062, T063, T013 | T049 | exact T013 handoff, T063 checkpoint, and independent actual behavior/performance oracle; its receipt gates T018 only |

T009 historically owns the broad `specs/005-analysis-final-closure/**`
subtree. T062 therefore declares T009 as a completed predecessor so the
extension's contract and evidence paths are sequentially reused under the
existing ownership rule. T062–T064 are materialized in a separate
`hex-final-closure-task-ownership-extension/v1`; the frozen
`task-ownership.json` bytes and all of its existing rows remain unchanged.

T063 owns only these six currently unassigned producer boundaries and its
private tests:

- `js/architecture/compat/ir-core-arm64-aapcs64-v1.js`
- `js/semantics/compat/index.js`
- `js/ir-core.js`
- `js/ir-public-base.js`
- `js/semantics/ir/function.js`
- `js/decompiler/pipeline-core.js`
- `tests/final-closure/t063/**`

T011 retains its decompiler and private MemorySSA projection paths; T012
retains `analysis-identity.js` and `valuenumber.js`; T013 retains all Phase 8
transaction/source/performance paths; and T017 retains MachineEffects and
compatibility/effects paths. T064 owns only `tests/final-closure/t064/**`.
No component owns generated output or governance manifests.

## Validator and admission state

The draft adds an owner-scoped successor implementation to
`tools/validation/final-closure/preflight.mjs`. It validates the exact task
classification, append-only ownership extension, raw base-registry digest,
task prefix/full-text digests, retained-owner digest, exclusive paths with
sequential reuse, dependency/closure rules, and a canonical contract identity.
The extension is applied only as an in-memory validation view; it does not
rewrite the frozen registry.

`candidateGates.status` is explicitly `UNREGISTERED`, with no T063/T064 gate
rows. Shape-only governance tests are not semantic shadow oracles. The real
validator accepts the structurally complete draft only with `requireActive:
false`, and rejects admission with
`stage-a-convergence-candidate-gates-unregistered`. An eventual `REGISTERED`
state must provide a separately specified `actual-product-behavior-v1` oracle
with independent verification and negative behavioral cases. No producer
behavior or completion PASS is claimed here.

Oracle registration and product acceptance are separate lifecycle decisions.
Once a future successor supplies the content-bound observer, fixture, result,
and independent receipt, its oracle may be registered with a `NONPASS` product
result while T063 is still unimplemented. That result must carry
`semanticPass: false`, `acceptance: false`, and its blocked finding IDs. The
canonical component and checkpoint gates may then execute and report their
actual result; registration alone cannot turn unknown producer behavior into
PASS. PO-001 through PO-004 therefore block T063/T064 product acceptance and
semantic PASS, while they do not create a reverse dependency from T062 to the
T063 implementation.

The registered oracle binds every case's `entrypoint`, `observes`, fixture
IDs, negative counterexample, and expected outcome to independently authored
source, fixture, and result blobs. A checkpoint product row also binds the
effective ownership identity and a fresh Git authentication of the frozen
predecessor packet. That row binding authenticates governance state only; it
does not assert producer behavior.

The current oracle preparation is the independently reviewed but explicitly
unregistered bundle
`/mnt/workspace/hex-stage-a-evidence/producer-behavior-oracle-independent-review-v2.json`
(SHA-256
`845cba05797d90954d2d5b4d2964aa94b7ba0df8ca0300d2ac7f82833f1ccb2b`). Its
specification and runner are content-bound in the contract, but the review
records missing producer authority and an independent x86 value oracle. The
bundle therefore cannot register or activate T063/T064. In particular, the
Phase 8 corpus adapter's direct compatibility call remains a required caller
route to repair before semantic evidence can be admitted.

T064 is never a prerequisite for T013. T049 receives no new static dependency.
T018 retains its historical dependency text; its machine closure predicate
requires an accepted T064 checkpoint after the T013 handoff.

## Required owner successor actions

The T046 owner or a reviewed exact successor must bind this extension to the
current integration head, amend the canonical preflight and its regression,
register the extension without rewriting the original registry bytes, and
append synchronized spec/plan/data-model/closure rules through the valid owner
route. The existing ownership manifest assigns `spec.md` to T003 rather than
T046, so that one required synchronization remains a coordinated T003/T046
successor hook and is intentionally absent from this draft. Before any component admission it must also bind the exact T061 receipt,
T011/T017 handoffs, external-overlap resolution, and an independently specified
actual product oracle. T063/T064 remain pending until those conditions hold.

## Focused draft verification

Commands are run from this worktree with Node `v22.22.1` and Git `2.49.1` on
the explicit pinned PATH. The structural validator result is expected to be:

```text
validateStageAConvergence(requireActive=false): valid=true, active=false
validateStageAConvergence(requireActive=true): valid=false,
  stage-a-convergence-candidate-gates-unregistered
```

The three new test files exercise this validator with mutation cases for
identity, prefix, ownership overlap, route classification, closure ordering,
and active-without-oracle registration. Syntax, JSON, whitespace, and focused
runner results are recorded in the successor review artifact. No source
behavior, workflow, remote ref, task status, generated output, or accepted
history was changed by this draft.
