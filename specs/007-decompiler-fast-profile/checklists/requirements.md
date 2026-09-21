# Requirements Checklist: Decompiler Fast Profile

- [ ] CHK001: Support `{ profile: 'fast' }` in `decompile` and `enhanceSemanticDecompilation`
- [ ] CHK002: Fast profile maps `decompilerTimeBudgetMs` to 30ms (if not explicitly specified)
- [ ] CHK003: Fast profile maps `phase8TimeBudgetMs` to 30ms and `phase8WorkBudget` to 10000 (if not explicitly specified)
- [ ] CHK004: Fast profile maps `renderProvenanceBudget.maxTransformRecords` to 128 (if not explicitly specified)
- [ ] CHK005: Explicit budget overrides take precedence over profile defaults
- [ ] CHK006: Unrecognized profile strings fall back gracefully to default
- [ ] CHK007: Phase 8 ownership gate passes with 0 violations (`phase8-ownership.mjs`)
- [ ] CHK008: Default decompiler calls without profile retain 100% existing behavior and outputs
- [ ] CHK009: Dedicated unit tests in `tests/phase8/` verify profile behavior and budget bounds
