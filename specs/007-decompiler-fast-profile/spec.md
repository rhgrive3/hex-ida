# Feature Specification: Decompiler Fast Profile for Interactive Binary Exploration

**Feature Branch**: `feat/decompiler-fast-profile`

**Created**: 2026-09-21

**Status**: Draft

**Input**: User description: "リモートメインからツリー作って、そこに移動してfastを実装しなさい。Speckitを使うこと。なお、今の未コミット壊さないよう注意" (Implement Fast profile for rapid decompilation and interactive game reverse engineering)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fast Decompilation Profile Option (Priority: P1)

As a reverse engineer analyzing game binaries or exploratory code, I want to decompile functions with a `'fast'` profile so that complex or unoptimized functions display in under 2 seconds instead of taking 6+ seconds due to saturated rewrite passes.

**Why this priority**: Directly solves the interactive latency bottleneck during binary exploration without sacrificing control flow recovery (if/else/loops) or variable offsets.

**Independent Test**: Decompiling `param_strcmp @ 0x18b8` with `{ profile: 'fast' }` finishes under 2.5 seconds and returns valid, readable pseudocode with correct control flow.

**Acceptance Scenarios**:

1. **Given** a function model (such as `param_strcmp @ 0x18b8`), **When** `decompile(model, { profile: 'fast' })` is called, **Then** `decompilerTimeBudgetMs` and `phase8TimeBudgetMs` are capped to 30ms and execution completes under 2.5s.
2. **Given** `opts = { profile: 'fast' }`, **When** decompiling, **Then** the resulting pseudocode retains recovered structured control flow (`if`, `while`, `return`) and local variable expressions.
3. **Given** default options `{}` or `{ profile: 'deep' }`, **When** decompiling, **Then** the existing default budgets (250ms pass budget, 120ms phase8 budget, 1,000,000 work items) are used without regression.

---

### User Story 2 - Lightweight Provenance & Bounded History (Priority: P2)

As a user navigating code interactively, I want source lines to retain basic address associations (`addr`, `row`) without paying multi-second penalties for exhaustive provenance derivation.

**Why this priority**: Provenance construction in `decompileSemantic` accounts for multiple seconds when unbounded on unoptimized stack-heavy code. Bounding it keeps interactive line navigation working without overhead.

**Independent Test**: Decompiling with `profile: 'fast'` produces non-empty line addresses while capping provenance record collections.

**Acceptance Scenarios**:

1. **Given** `opts = { profile: 'fast' }`, **When** `decompile` runs, **Then** `lines` retain `addr` metadata for instruction navigation while `renderProvenanceBudget` is capped to lightweight thresholds (`maxTransformRecords <= 128`).

---

### User Story 3 - Backward Compatibility & Lane Ownership (Priority: P3)

As a maintainer, I want the fast profile changes to be completely opt-in, backwards-compatible, and strictly compliant with repository ownership gates (`lanes.p8`).

**Why this priority**: Preserves existing CI passes, benchmarks, and architectural boundaries.

**Independent Test**: `npm run phase8:ownership` reports 0 violations, and existing test suites pass without regressions.

**Acceptance Scenarios**:

1. **Given** the modified codebase, **When** `node tools/validation/phase8-ownership.mjs` is executed on changed files, **Then** 0 violations are reported.
2. **Given** standard test suites without `profile: 'fast'`, **When** run, **Then** all assertions pass identically to `origin/main`.

---

### Edge Cases

- **Custom budget override with profile**: If the caller specifies both `{ profile: 'fast' }` and an explicit `{ decompilerTimeBudgetMs: 15 }`, the explicit option MUST take precedence or be respected.
- **Empty or trivial functions**: Functions with no basic blocks or 1 return instruction should execute in < 5ms without overhead from profile resolution.
- **Missing or invalid profile string**: If an unrecognized profile is provided (e.g. `{ profile: 'unknown' }`), system MUST gracefully fall back to the default profile.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `decompile` and `enhanceSemanticDecompilation` MUST support an opt-in `profile` option (`'fast'` | `'deep'` | `'balanced'`).
- **FR-002**: When `profile === 'fast'`, `decompilerTimeBudgetMs` MUST default to 30ms (unless explicitly overridden by caller).
- **FR-003**: When `profile === 'fast'`, `phase8TimeBudgetMs` MUST default to 30ms and `phase8WorkBudget` MUST default to 10,000 work items (unless explicitly overridden).
- **FR-004**: When `profile === 'fast'`, `renderProvenanceBudget` MUST cap `maxTransformRecords` to 128 (unless explicitly overridden).
- **FR-005**: All profile resolution logic MUST reside within Phase 8 owned paths (`js/decompiler/**` or `js/decompile.js`).
- **FR-006**: Existing calls to `decompile(model, opts)` without `profile` MUST retain identical defaults and behavior.
