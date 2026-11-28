# Decompiler Transform Budgets & Presentation Passes

Last updated: 2026-11-28

## Execution Profiles (`js/decompiler/profiles.js`)

The decompiler exposes two execution profiles via `DECOMPILER_PROFILES`:

| Profile | `decompilerTimeBudgetMs` | `transformSafetyCeilingMs` | `phase8WorkBudget` | `renderProvenanceBudget` | `renderProvenanceBindingBudget` |
| --- | --- | --- | --- | --- | --- |
| `fast` (default) | `null` | `2000` (monotonic ms ceiling) | `10000` | `{ maxTransformRecords: 128 }` | `{ maxConsumers: 256 }` |
| `deep` | `250` | `null` | `null` | `null` | `null` |

### Deterministic Work Limits

During normal `fast` decompilation, deterministic work limits are the primary stop condition so identical input reaches the same work boundary regardless of host speed:

- **PassManager (`js/decompiler/passes/manager.js`)**: `DEFAULT_PASS_BUDGET` is `12,000` nodes, `16` iterations (and `40 ms` standalone default when not overridden by a profile).
- **RewriteEngine (`js/decompiler/rewrite/engine.js`)**: `DEFAULT_REWRITE_BUDGET` is `4,096` nodes, `12` iterations, and `2,048` rule applications.
- **Phase 8 (`js/decompiler/phase8/index.js`)**: Uses the profile's `10,000` work-item budget in `fast` mode (`null` / caller-controlled in `deep` mode).
- **Stack recovery passes (`js/decompiler/passes/stack-phi-recovery.js`, `js/decompiler/passes/stack-return-recovery.js`)**: Cap rewrite budgets at `2,048` nodes (clamped against `decompilerNodeBudget`).

### Monotonic Safety Ceiling & Time Overrides

- `fast` mode enforces one monotonic `2,000 ms` transform safety ceiling (`transformSafetyCeilingMs`, clamped to `<= 2000 ms`) carried as an absolute `transformDeadline` across Phase 8, `PassManager`, `RewriteEngine`, and stack recovery.
- Exhausting deterministic work limits records `transform-work-budget`.
- Hitting the profile safety ceiling records `degradationReason: "transform-safety-ceiling"` in `PassManager` metrics and `stopReason: "transform-safety-ceiling"` in a withheld Phase 8 ledger.
- Supplying an explicit `decompilerTimeBudgetMs` overrides the profile ceiling and reports `transform-time-budget`.
- Supplying `deterministicTransforms: true` disables transform wall-clock deadlines while keeping all deterministic work limits active.
- Results remain structurally valid after either work-limit or deadline truncation.

## Clean View & Post-Emit Presentation (`js/decompiler/clean-view.js`, `js/decompiler/apple-arc-swift-pass.js`)

After the core decompiler pipeline emits pseudo-C (`js/decompiler/pipeline-core.js`), the UI and workbench apply the pure, deterministic **Clean View** presentation pass (`formatCleanViewLines` / `formatCleanViewText`, enabled by default in the Pseudo-C tab with a toggle to inspect raw output):

1. **Typedef prelude hiding**: Hides fixed-width primitive/`id` typedef preludes while preserving recovered `typedef struct`/`union`/`enum` definitions.
2. **Dead stack-spill elision**: Conservatively elides dead local spill assignments (`var_XX = <pure>;`) and unused local declarations.
3. **Callee-saved spill folding**: Conservatively folds ARM64 callee-saved register prologue/epilogue stack save/restore pairs (`x19..x30`, `fp`, `lr`, `d8..d15`).
4. **Consecutive duplicate `__asm` collapse**: Collapses consecutive duplicate `semantic-v2` `__asm(...)` lines (`collapseDuplicateAsm: true`).
5. **Apple ObjC / Swift / ARC & 4-ABI demangling (`refineAppleSwiftDecompile`)**: Rewrites `_objc_msgSend$<sel>` and direct `objc_msgSend` calls to `[recv sel:args...]`, folds ObjC/Swift ARC retain/release boilerplate, and demangles inline Swift (`$s`/`_$s`), Itanium C++ (`_Z`), Rust (`_R`), and MSVC C++ (`?`) symbols via the unified 4-ABI WASM demangler (`js/analysis/types/core/symbol-demangler.js`).

Clean View is strictly a presentation layer: it never mutates canonical IR, SSA, or proof provenance.

## Relationship to Process-Boundary Timeouts

All budgets in this document are **in-process cooperative** transform limits. Hard per-function enforcement (`--function-timeout-ms` with parent `SIGKILL` supervision) lives at the outer process boundary; see [`FUNCTION_TIMEOUT_SEMANTICS.md`](FUNCTION_TIMEOUT_SEMANTICS.md).
