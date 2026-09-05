# Implementation Plan: Rendered-Entity Provenance Mapping

**Branch**: `feat/analysis-hex-c4-03-provenance` | **Date**: 2026-09-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-render-provenance-mapping/spec.md`

## Summary

Close HEX-C4-03 (raw/optimized/rendered bidirectional provenance) by extending the existing
Phase 8 projection so that every rendered pseudocode entity resolves, in both directions, to
canonical pre-transform evidence (instruction rows / canonical semantic references), with
validation that fail-closes on provenance loss, stale snapshot identity, and budget overflow.
The existing origin/identity architecture and the Phase 8 `provenanceLossCount = 0` hard-zero
gate remain the sole authority; no new semantic identities are minted.

## Technical Context

**Language/Version**: JavaScript (ES modules, Node >= 20 for tests; browser-safe production code)

**Primary Dependencies**: None new. Consumes existing in-repo modules: `js/decompiler/phase8/projection.js`
(transform records, `applyPhase8Projection`), `js/decompiler/phase8/contract.js` (fail-closed
contract helpers, `transformList`, hard-zero `provenanceLossCount` gate), `js/decompiler/phase8/artifact-identity.js`
(snapshot/version binding), `js/decompiler/provenance.js` (source row/address formatting),
`js/core/identity/origin.js` (origin-set identity).

**Storage**: N/A (in-memory frozen result structures; no persistence).

**Testing**: `node:test` + `node:assert/strict`; run via `tests/phase8/run.mjs` (`npm run phase8:test`);
ownership via `tools/validation/phase8-ownership.mjs`; repo gates `npm run check` (quiet wrapper
provided by `scripts/run-quiet-command.mjs`).

**Target Platform**: Browser (iPad/WebKit first-class) and Node CI; deterministic, budgeted,
cancellable analysis per constitution.

**Performance Goals**: Provenance build/validation adds deterministic bounded work to the
existing projection pass; no new unbounded traversal. Pathological fixtures must complete within
existing Phase 8 budgets.

**Constraints**: No second semantic engine; rendered entities never become semantic identities;
unknown/partial stays explicit; ledger and origin storage capped with explicit truncation;
component lane does not commit generated userscript output (integration handoff).

**Scale/Scope**: Single finding lane (HEX-C4-03 / backlog FR-C4-03A). Phase 8 projection +
new render-provenance module + validation + tests + verifier/metrics wiring.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| I. One Canonical Semantic Truth | PASS — extends existing `applyPhase8Projection`/origin evidence; no second memory/semantic engine; rendered IDs stay projections. |
| II. Uncertainty Is Explicit | PASS — provenance-incomplete, stale, truncated states are explicit; no confidence scores; fail-closed validation. |
| III. Deterministic Proof Before Promotion | PLAN — implementation MUST start with a deterministic pre-fix counterexample (a rendered entity losing its origin) failing before production edits. |
| IV. Bounded, Cancellable, Portable | PASS — deterministic caps on ledger/origins, explicit truncation, cancellation through existing Phase 8 budget substrate. |
| V. Exact Product and Integration Proof | PLAN — exact-head/candidate-tree proof happens at integration; component lane records changed-file inventory and does not commit generated output. |

## Project Structure

### Documentation (this feature)

```text
specs/004-render-provenance-mapping/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── render-provenance.contract.md
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
js/decompiler/phase8/
├── projection.js            # Existing: applyPhase8Projection, transform records (extended to attach render provenance)
├── contract.js              # Existing: fail-closed helpers, transformList (extended validation codes)
├── render-provenance.js     # NEW: bidirectional provenance map build + validation
└── artifact-identity.js     # Existing: snapshot/version identity (consumed, not modified unless required)

tests/phase8/
└── provenance/              # NEW: counterexample, positive, negative, budget, determinism, stale-snapshot tests
    └── run.mjs (registered by canonical runner discovery check)

tools/validation/phase8/
└── metrics.mjs              # Existing: wire render-provenance validation into safety counters (provenance loss)

docs/
└── analysis-improvement-finding-ledger.md  # Ledger row/checkpoint update for HEX-C4-03
```

**Structure Decision**: All production edits stay inside the Phase 8 decompiler ownership
boundary (`tools/validation/phase-ownership/phase8.json` lanes: `js/decompiler/**`,
`tests/phase8/**`, `tools/validation/phase8/**`, ledger doc). `js/semantics/**`,
`js/analysis/**`, `js/targets/**` remain forbidden and are consumed only through existing
published seams already present in the projection inputs.

## Complexity Tracking

> No constitution violations. No complexity justifications required.
