# Research: Decompiler Fast Profile

## 1. Problem Statement & Context

In Hex, decompiling unoptimized (e.g. `-O0`) or large, complex functions can take 6+ seconds due to:
1. Saturated rewrite pass iterations in `PassManager` (`RewriteEngine`), where unoptimized stack spills cause the engine to repeatedly apply rules until hitting the default wall-clock/iteration budget.
2. Exhaustive line-level provenance binding in `decompileSemantic`, where thousands of intermediate store/statement history records are collected.
3. Heavy Phase 8 SMT/DPLL solver queries attempting to formally prove properties that cannot be discharged within interactive limits.

For exploratory reverse engineering (such as inspecting game binaries, finding field offsets, vtable addresses, or function call targets), analysts prioritize interactive sub-second feedback over exhaustive formal equivalence proofs.

## 2. Profile Options Architecture

### Profiles Defined
- **`'fast'`**:
  - `decompilerTimeBudgetMs`: `30` (reduced from 250)
  - `phase8TimeBudgetMs`: `30` (reduced from 120/1000)
  - `phase8WorkBudget`: `10000` (reduced from 1,000,000)
  - `renderProvenanceBudget`: `{ maxTransformRecords: 128, maxConsumers: 256 }`
- **`'deep'`** (or default / unspecified):
  - Preserves exact existing defaults:
    - `decompilerTimeBudgetMs`: 250
    - `phase8TimeBudgetMs`: 120
    - `phase8WorkBudget`: 1,000,000
    - `renderProvenanceBudget`: unconstrained / 1024

### Precedence Rules
Explicit user-specified options take precedence over profile presets:
```javascript
const profile = resolveDecompilerProfile(opts.profile);
const decompilerTimeBudgetMs = opts.decompilerTimeBudgetMs ?? profile.decompilerTimeBudgetMs;
const phase8TimeBudgetMs = opts.phase8TimeBudgetMs ?? profile.phase8TimeBudgetMs;
const phase8WorkBudget = opts.phase8WorkBudget ?? profile.phase8WorkBudget;
const renderProvenanceBudget = opts.renderProvenanceBudget ?? profile.renderProvenanceBudget;
```

## 3. Ownership & Safety Boundaries
- Files to modify:
  - `js/decompiler/pipeline-core.js`: Profile resolution in `enhanceSemanticDecompilation` and `PassManager` configuration.
  - `js/decompiler/pipeline.js` or `js/decompile.js`: Profile forwarding.
  - `tests/phase8/substrate/decompiler-fast-profile.test.mjs`: Test coverage.
- All touched paths belong strictly to `lanes.p8` (`js/decompiler/**`, `tests/phase8/**`).
- Zero modifications to forbidden paths (`js/core/identity/**`, `js/ir-core.js`, etc.).
