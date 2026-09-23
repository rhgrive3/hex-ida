# Audit Report: Wall-Clock Budgets Affecting Analysis Results

## Executive Summary
This audit inspects all code paths reachable from `tools/validation/public-benchmark/product-host.mjs` (`openProduct()` and `product.query.decompile(..., {profile:'fast'})`), covering binary loading, symbol analysis, function discovery, program construction, RTTI/C++ discovery, and default FAST decompilation.

We examined every instance of wall-clock time budgets (`Date.now()`, `performance.now()`, `monotonicNow()`, `maxWallMs`, `wallClockMs`, `wallMs`, `timeBudgetMs`, `maxElapsedMs`, and deadline checks) across `js/`.

---

## Detailed Findings (Ranked by Impact)

### 1. `js/binary/elf-budget.js:8` (`createELFMetadataBudget`)
- **Default value:** `wallClockMs: 5_000` (5000 ms).
- **Location of check:** Lines 60 and 71 (`Date.now() - started > limits.wallClockMs`). Checked at `checkpoint()` and every 1024 operations in `take()`.
- **What gets truncated/skipped:** Decoded ELF section headers (SHT), symbols, relocations, and `.eh_frame` unwinding tables on slow hosts or large ELF binaries. Symbols and relocations are cut off mid-parse.
- **Warning/partial flag surfaced:** Yes (`image.metadata.elfMetadata.complete = false`, `image.metadata.elfMetadata.reasons.push('budget:wall-clock')`, warning added to `image.warnings`).
- **Deterministic bound exists:** Yes (`operations: 2_000_000`, `records: 250_000`, `objects: 500_000`, `stringBytes: 16 MB`, `inputBytes: 64 MB`, `estimatedHeapBytes: 96 MB`).
- **Classification:** **Accidental result-changing limit**. Like dynamic-symbol and relocation budgets, host load or slow I/O silently curtails symbol/relocation decoding, causing symbol counts, function discovery starts, and RTTI class counts to diverge across machines.

---

### 2. `js/binary/macho-budget.js:9` (`createMachOMetadataBudget`)
- **Default value:** `wallClockMs: 5_000` (5000 ms).
- **Location of check:** Line 82 (`Date.now() - started > limits.wallClockMs`). Checked every 1024 operations during `take()`.
- **What gets truncated/skipped:** Mach-O load command parsing, symbol table (`LC_SYMTAB`), dysymtab (`LC_DYSYMTAB`), function starts (`LC_FUNCTION_STARTS`), chained fixups, and exports triage.
- **Warning/partial flag surfaced:** Yes (`image.metadata.machoMetadata.complete = false`, `reasons.push('budget:wall-clock')`).
- **Deterministic bound exists:** Yes (`operations: 2_000_000`, `records: 250_000`, `objects: 500_000`, `stringBytes: 16 MB`, `inputBytes: 64 MB`, `warnings: 2048`, `estimatedHeapBytes: 128 MB`).
- **Classification:** **Accidental result-changing limit**. Causes Mach-O binary loading on slow runners to drop symbols, function starts, and exports, altering analysis output non-deterministically.

---

### 3. `js/binary/pe-loader-core.js:11` (`createPEMetadataBudget`)
- **Default value:** `wallClockMs: 5_000` (5000 ms).
- **Location of check:** Line 77 (`Date.now() - started > limits.wallClockMs`). Checked every 1024 operations in `take()`.
- **What gets truncated/skipped:** PE sections, COFF symbols, exports, imports, delay imports, exception directories (pdata/xdata unwind), TLS, and load config directories.
- **Warning/partial flag surfaced:** Yes (`image.metadata.peMetadata.complete = false`, `reasons.push('budget:wall-clock')`, warning pushed to `image.warnings`).
- **Deterministic bound exists:** Yes (`operations: 2_000_000`, `records: 250_000`, `objects: 500_000`, `stringBytes: 16 MB`, `inputBytes: 64 MB`, `estimatedHeapBytes: 96 MB`).
- **Classification:** **Accidental result-changing limit**. Under slow virtualization or heavy host load, PE metadata parsing halts early, directly corrupting function discovery and symbol tables.

---

### 4. `js/worker-budget.js:20` (`createSupplementalBudget`)
- **Default value:** `SUPPLEMENTAL_WALL_MS: 3000` (3000 ms).
- **Location of check:** Line 27 (`Date.now() - start > 3000`) inside `take()`, and Line 39 (`expired: () => Date.now() - start > 3000`).
- **What gets truncated/skipped:** In `js/worker-legacy.js:716` and `js/objc-stub-recovery.js`, `objcStubNames()` recovers Objective-C helper stub names (e.g. `_objc_msgSend$selector`) and method names from `__objc_methlist` and `__objc_selrefs`. When the 3s budget expires, stub recovery terminates prematurely.
- **Warning/partial flag surfaced:** **No**. Stubs collected up to the timeout are kept; remaining stubs are silently omitted without setting a warning or partial flag on the symbols object.
- **Deterministic bound exists:** Yes (`read: 32 MB`, `resident: 8 MB`, `regions: 128`, `names: 80_000`, `strings: 8 MB`, `operations: 2_000_000`).
- **Classification:** **Accidental result-changing limit**. Silent truncation directly changes recovered symbol names and downstream call target resolution based on host speed.

---

### 5. `js/decompiler/passes/manager.js:5` (`PassManager`)
- **Default value:** `DEFAULT_PASS_BUDGET.timeBudgetMs: 40` (overridden by default FAST profile in `profiles.js:12` to `decompilerTimeBudgetMs: 30`).
- **Location of check:** Lines 121, 127, 149, 166, 171, 177, 192 (`clock() >= passDeadline`).
- **What gets truncated/skipped:** Optional middle-end optimization and recovery passes: `high-variable-recovery`, `prototype-recovery`, `aggregate-layout-recovery`, `canonical-expression-build`, and `semantic-rewrite`. Passes crossing the deadline are skipped or degraded to fallback ASTs.
- **Warning/partial flag surfaced:** Yes (`state.warnings.push(...)`, `state.degraded = true`, `state.passMetrics.push({ skipped: true, reason: 'deadline' })`, `pipelineCompleteness(state)` returns `'partial'`).
- **Deterministic bound exists:** Yes (`nodeBudget: 12000`, `maxIterations: 16`).
- **Classification:** **Intended documented FAST valve**. Explicitly documented to prevent interactive UI hangs. Can be disabled deterministically via `opts.deterministicTransforms === true` (which sets `deadline = Infinity`).

---

### 6. `js/decompiler/rewrite/engine.js:6` (`RewriteEngine`)
- **Default value:** `DEFAULT_REWRITE_BUDGET.timeBudgetMs: 18` (in pipeline-core: `Math.max(4, Math.min(22, budget.timeBudgetMs / 2))`, so 15 ms under FAST profile).
- **Location of check:** Lines 139–143, 152, 191 (`now() >= deadline || context.shouldAbort?.()`).
- **What gets truncated/skipped:** Iterative rule applications during semantic IR tree rewriting (expression simplification, algebraic rewrites, redundant cast pruning). Stops before reaching rewrite fixed-point.
- **Warning/partial flag surfaced:** Yes (`stats.budgetExceeded = true`, warning `'Decompiler rewrite budget reached; output was conservatively degraded.'` added in `pipeline-core.js:2059`).
- **Deterministic bound exists:** Yes (`maxIterations: 16`, `maxApplications: 256`, `nodeBudget: 1024`, `maxHistoryOrigins: 128`).
- **Classification:** **Intended documented FAST valve**. Documented as an interactive degradation valve that can be bypassed deterministically via `opts.deterministicTransforms === true` or `budget.deterministic === true`.

---

### 7. `js/decompiler/phase8/index.js:134, 561` (`runPhase8Stage`)
- **Default value:** `phase8TimeBudgetMs: 30` (from FAST profile `profiles.js:13`).
- **Location of check:** Lines 568, 589, 592 (`clock() >= deadline`).
- **What gets truncated/skipped:** Phase 8 optimization stages (SCCP, GVN, DCE, induction, structuring, aggregates, provider passes). If deadline expires before publication, ledger is withheld with reason `deadline-before-publication`.
- **Warning/partial flag surfaced:** Yes (`ledger: withheldLedger('cancelled', 'deadline-before-publication', ...)`).
- **Deterministic bound exists:** Yes (`maxWorkItems: 10000` from FAST profile).
- **Classification:** **Intended documented FAST valve**. Explicitly documented as a separate stage with declared budget so it does not steal rewrite iterations from PassManager.

---

### 8. `js/decompiler/pipeline-core.js:776` (`selectedValueOrigins`)
- **Default value:** Hardcoded `250` ms (`performance.now() - started >= 250`).
- **Location of check:** Line 776 (`if (performance.now() - started >= 250) { incomplete = true; break; }`).
- **What gets truncated/skipped:** Provenance graph back-tracing for constant values and memory load operand selections. On timeout, sets `incomplete = true`, marking `originHistory` as truncated and adding reason `precomputed-source-history-incomplete` or `canonical-load-source-history-incomplete`.
- **Warning/partial flag surfaced:** Yes (via `originHistory: { ...history, truncated: true }` and `expressionHistoryBinding.completeness = 'incomplete'`).
- **Deterministic bound exists:** Yes (`seen.size < 512`, `state.opts?.renderProvenanceBudget?.maxTransformRecords: 128`).
- **Classification:** **Accidental result-changing limit**. Hardcoded 250 ms wall-clock timeout in helper without checking `deterministicTransforms` or honoring configurable budget.

---

### 9. `js/decompiler/phase8/projection-origin.js:85` (`captureProjectionData`) & `js/core/identity/live-data.js:166` (`captureIrData`)
- **Default value:** Hardcoded `250` ms (`performance.now() - started >= 250`).
- **Location of check:** Line 85 (`if (performance.now() - started >= 250 || shouldAbort?.()) throw new TypeError('projection-capture-cancelled-or-deadline')`).
- **What gets truncated/skipped:** AST/IR projection observation graph construction used for proof generation and expression token mapping. In `pipeline.js:56`, the error is caught by `try ... catch { /* optional proof is withheld */ }`, which drops optional proof metadata.
- **Warning/partial flag surfaced:** Partial: proof record is silently withheld on failure; caller receives output without proof.
- **Deterministic bound exists:** Yes (`PROJECTION_LIMITS.nodes: 32768`, `edges: 65536`, `depth: 64`, `expandedUnits: 131072`).
- **Classification:** **Accidental result-changing limit**. Hardcoded 250 ms ceiling causes proof data capture to fail on slow machines while succeeding on fast machines.

---

### 10. `js/il2cpp.js:12, 21` (`metadataBudget` & `bindingBudget`)
- **Default value:** `metadataBudget.wallMs: 2500`, `bindingBudget.wallMs: 3500`.
- **Location of check:** Line 45 (`nowMs() - started > limit.wallMs`) and Line 60 (`nowMs() - started > limit.wallMs`).
- **What gets truncated/skipped:** When loading Unity IL2CPP binaries, `global-metadata.dat` parsing and method address binding (`bindMethodAddresses`) are aborted if parsing or scanning exceeds 2.5s / 3.5s.
- **Warning/partial flag surfaced:** Yes (`throw budgetError('IL2CPP_METADATA_BUDGET', ...)` or caught in `tools-base.js:474` returning `binding-budget-exhausted`).
- **Deterministic bound exists:** Yes (`maxOperations: 3_000_000`, `maxOutputObjects: 300_000`, `maxScanBytes: 32 MB`, `maxCandidates: 5000`, `maxExtraReads: 12_000`).
- **Classification:** **Accidental result-changing limit**. Unity reverse engineering analysis results (recovered types and method symbols) depend on host speed.

---

### 11. `js/managed/cil/metadata-budget.js:13, 76` (`createCilMetadataAdmission`)
- **Default value:** `maxElapsedMs: 10_000` (10 seconds).
- **Location of check:** Lines 98–103 (`elapsed > limits.maxElapsedMs`). Checked every 1024 operations.
- **What gets truncated/skipped:** .NET ECMA-335 CIL CLI metadata decoding (TypeDef, MethodDef, Field, MemberRef tables) throws `CilMetadataResourceLimitError('cil-metadata-resource-limit-elapsed')`.
- **Warning/partial flag surfaced:** Yes (`{ supported: false, status: 'resource-limited', reason: 'cil-metadata-resource-limit-elapsed' }`).
- **Deterministic bound exists:** Yes (`maxRows: 200_000`, `maxObjects: 1_000_000`, `maxStringBytes: 8 MB`, `maxOperations: 8_000_000`).
- **Classification:** **Accidental result-changing limit**.

---

### 12. `js/managed/wasm/parser-core.js:47` (`createWasmParseBudget`)
- **Default value:** `deadlineMs: 30000` (30 seconds).
- **Location of check:** Line 63 (`Date.now() - startedAt > limits.deadlineMs`). Checked every 16384 operations.
- **What gets truncated/skipped:** WebAssembly binary module parsing aborts with error `'wasm-resource-limit-deadline'`.
- **Warning/partial flag surfaced:** Yes (throws failure code).
- **Deterministic bound exists:** Yes (`maxOperations: 200_000_000`, `maxRecords: 100_000`, `maxObjects: 500_000`, `maxEstimatedHeapBytes: 96 MB`).
- **Classification:** **Accidental result-changing limit**.

---

### 13. `js/recognition/match-budget.js:23` (`createMatchBudget`)
- **Default value:** `maxWallMs: 2_000` (2000 ms).
- **Location of check:** Lines 107 and 123 (`now() - started > limits.maxWallMs`). Checked periodically during preprocessing, index construction, candidate generation, and postprocessing.
- **What gets truncated/skipped:** Binary function recognition and matching against known libraries (e.g. game engines, crypto, runtime libraries) aborts early, marking the candidate graph incomplete.
- **Warning/partial flag surfaced:** Yes (`budget.truncated = true`, `reason = stage + ' exceeded 2000 ms wall-clock budget'`).
- **Deterministic bound exists:** Yes (`maxPreprocessFunctions: 700_000`, `maxPreprocessWork: 4_000_000`, `maxCandidateEvaluations: 500_000`, `maxCandidateEdges: 100_000`, `maxSolverRelaxations: 500_000`).
- **Classification:** **Accidental result-changing limit**. Under heavy load, library identification drops matches.

---

### 14. `js/symbolic/executor.js:438, 441` (`symbolicExecute`)
- **Default value:** `timeoutMs: 250` (or `options.timeoutMs`).
- **Location of check:** Line 450 (`if (cancelled() || Date.now() > deadline) { truncated = true; break; }`).
- **What gets truncated/skipped:** Path exploration in light symbolic execution halts early; returns `truncated = true` with fewer paths explored. Reachable from Phase 8 conditional region reachability (`conditional-region-reachability.js:194`).
- **Warning/partial flag surfaced:** Yes (`execution.truncated = true`, `execution.status = 'partial'`).
- **Deterministic bound exists:** Yes (`maxSteps: 2000`, `maxBranches: 32`, `maxBlockVisits: 3`).
- **Classification:** **Accidental result-changing limit** (unless overridden by deterministic test harness).

---

### 15. `js/semantics/memoryssa/contract.js:127` & `js/semantics/memoryssa/queries.js:1087, 1259, 1297, 1315, 1326`
- **Default value:** `null` by default; caller-provided deadline (e.g. `options.deadline`, `options.budget.deadline`).
- **Location of check:** `Date.now() >= deadline` / `Date.now() >= deadlineMs`.
- **What gets truncated/skipped:** Memory SSA validation and forwarding queries throw `budgetFail('memory-ssa-validation-deadline-exhausted')` or `ForwardingStop('budget-limited', 'memory-forwarding-deadline-exhausted')`.
- **Warning/partial flag surfaced:** Yes (returns `'budget-limited'`).
- **Deterministic bound exists:** Yes (operation and step bounds exist alongside).
- **Classification:** Caller-owned deadline; no hardcoded non-null default.

---

### 16. `js/analysis/discovery/layout.js:71` (`queryDiscoveryLayout`)
- **Default value:** `timeoutMs: 1000` (1000 ms).
- **Location of check:** Line 74 (`if (performance.now() - started >= timeout) fail('timeout')`).
- **What gets truncated/skipped:** Synthetic layout candidate fusion and segment interpretation aborts with partial status (`status: 'partial'`, `reason: 'timeout'`).
- **Warning/partial flag surfaced:** Yes (`status.completeness = 'partial'`, `reason = 'timeout'`).
- **Deterministic bound exists:** Yes (`maxWork: 200_000`, `maxRecords: 16_384`, `maxBytes: 65_536`).
- **Classification:** **Accidental result-changing limit**.

---

## Summary Matrix

| File:Line | Default | What is truncated/skipped | Warning/Partial Flag | Deterministic Bound | Classification |
|---|---|---|---|---|---|
| `js/binary/elf-budget.js:8` | `wallClockMs: 5000` | SHT symbols, relocations, `.eh_frame` unwind | Yes (`budget:wall-clock`) | Yes (`2M ops`, `250k recs`) | Accidental |
| `js/binary/macho-budget.js:9` | `wallClockMs: 5000` | Mach-O symbols, fixups, function starts | Yes (`budget:wall-clock`) | Yes (`2M ops`, `250k recs`) | Accidental |
| `js/binary/pe-loader-core.js:11` | `wallClockMs: 5000` | PE COFF symbols, exports, imports, pdata | Yes (`budget:wall-clock`) | Yes (`2M ops`, `250k recs`) | Accidental |
| `js/worker-budget.js:20` | `SUPPLEMENTAL_WALL_MS: 3000` | ObjC method/stub recovery names | **No (Silent)** | Yes (`2M ops`, `80k names`) | Accidental |
| `js/decompiler/passes/manager.js:5` | `timeBudgetMs: 40` (FAST: `30`) | Optional middle-end decompilation passes | Yes (`degraded: true`) | Yes (`12k nodes`, `16 iter`) | Intended FAST valve |
| `js/decompiler/rewrite/engine.js:6` | `timeBudgetMs: 18` (FAST: `15`) | Expression rewrite rules fixed-point | Yes (`budgetExceeded: true`) | Yes (`256 apps`, `16 iter`) | Intended FAST valve |
| `js/decompiler/phase8/index.js:561` | FAST: `phase8TimeBudgetMs: 30` | Phase 8 optimizer ledger stages | Yes (`withheldLedger`) | Yes (`10000 workItems`) | Intended FAST valve |
| `js/decompiler/pipeline-core.js:776` | `250 ms` (hardcoded) | Provenance graph back-tracing | Yes (`incomplete: true`) | Yes (`512 seen`, `128 recs`) | Accidental |
| `js/decompiler/phase8/projection-origin.js:85` | `250 ms` (hardcoded) | Proof data capture for decompiler | No (silently withheld) | Yes (`32k nodes`, `64k edges`) | Accidental |
| `js/core/identity/live-data.js:166` | `250 ms` (hardcoded) | IR data certification graph | Throws `TypeError` | Yes (`32k nodes`, `64k edges`) | Accidental |
| `js/il2cpp.js:12, 21` | `wallMs: 2500 / 3500` | Unity IL2CPP metadata & method binding | Yes (`IL2CPP_BINDING_BUDGET`) | Yes (`3M ops`, `5k cand`) | Accidental |
| `js/managed/cil/metadata-budget.js:13` | `maxElapsedMs: 10000` | .NET CIL metadata table admission | Yes (`resource-limited`) | Yes (`8M ops`, `200k rows`) | Accidental |
| `js/managed/wasm/parser-core.js:47` | `deadlineMs: 30000` | WebAssembly binary parsing | Yes (`resource-limit-deadline`) | Yes (`200M ops`, `100k recs`) | Accidental |
| `js/recognition/match-budget.js:23` | `maxWallMs: 2000` | Function fingerprint library matching | Yes (`truncated: true`) | Yes (`500k eval`, `100k edge`) | Accidental |
| `js/symbolic/executor.js:438` | `timeoutMs: 250` | Symbolic path exploration | Yes (`truncated: true`) | Yes (`2000 steps`, `32 br`) | Accidental |
| `js/analysis/discovery/layout.js:71` | `timeoutMs: 1000` | Discovery layout fusion | Yes (`partial`, `timeout`) | Yes (`200k work`, `16k recs`) | Accidental |

---

## Recommendations
1. **Binary Loader Budgets (`elf-budget.js`, `macho-budget.js`, `pe-loader-core.js`):** In batch/test/benchmark environments (or when deterministic mode is enabled), remove or disable the wall-clock timeout and rely solely on the operation and memory bounds.
2. **Worker Supplemental Budget (`worker-budget.js`):** Surface a truncation warning or remove the 3-second wall-clock ceiling in favour of `SUPPLEMENTAL_OPERATIONS`.
3. **Hardcoded Decompiler 250 ms Limits (`pipeline-core.js:776`, `projection-origin.js:85`, `live-data.js:166`):** Check `opts.deterministicTransforms` or respect `opts.decompilerTimeBudgetMs` instead of hardcoding 250 ms.
