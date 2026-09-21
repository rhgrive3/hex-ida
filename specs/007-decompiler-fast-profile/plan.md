# Implementation Plan: Decompiler Fast Profile

**Branch**: `feat/decompiler-fast-profile` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

## Summary

Implement a `{ profile: 'fast' }` option for the decompiler pipeline (`decompile` and `enhanceSemanticDecompilation`) that caps rewrite pass time budgets to 30ms, Phase 8 solver work budgets to 10,000 items, and provenance record caps to 128. This delivers sub-2-second interactive decompilation for complex/unoptimized binaries without degrading control flow or local variable identification, while preserving 100% of existing behavior when the option is omitted.

## Technical Context

**Language/Version**: JavaScript (ESM, Node.js 24+)
**Primary Dependencies**: None (internal core decompiler engine)
**Target Platform**: Linux, macOS, iOS Safari (iPad), Web Workers
**Testing**: `node --test tests/phase8/substrate/decompiler-fast-profile.test.mjs`
**Performance Goals**: Decompilation of `param_strcmp @ 0x18b8` completes in < 2.5s (down from 6.6s).
**Constraints**: Zero violations on `tools/validation/phase8-ownership.mjs`; zero regressions on existing CI tests.

## Constitution & Ownership Check

- Lane: `p8` owns `js/decompiler/**` and `tests/phase8/**`.
- Modified files:
  - `js/decompiler/pipeline-core.js` (owned by p8)
  - `js/decompiler/pipeline.js` (owned by p8)
  - `js/decompile-base.js` (owned by p8)
  - `tests/phase8/substrate/decompiler-fast-profile.test.mjs` (owned by p8)
- Forbidden paths: None touched.

## Implementation Steps

1. **Step 1: Profile Resolution Function**:
   Define `resolveDecompilerProfile` in `js/decompiler/pipeline-core.js` with `'fast'` and `'deep'` presets.
2. **Step 2: Wire Profile into Decompiler Pipeline**:
   - In `js/decompiler/pipeline-core.js`, apply resolved profile budgets to `PassManager` and `phase8Budget`.
   - In `js/decompile-base.js`, pass resolved `renderProvenanceBudget` into `decompileSemantic` and `finalize`.
3. **Step 3: Test Suite**:
   Create `tests/phase8/substrate/decompiler-fast-profile.test.mjs` testing:
   - Profile resolution and defaults.
   - Bounded execution time and output validity.
   - Caller explicit override precedence.
4. **Step 4: Quality & Ownership Gates**:
   - Run `node tools/validation/phase8-ownership.mjs` (must be 0 violations).
   - Verify performance improvement on `param_strcmp @ 0x18b8`.
