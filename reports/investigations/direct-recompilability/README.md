# Direct recompilability — failure taxonomy and repair plan

Investigation-only lane, base `05c93a1c92b34f4876060bd858e4393557d02dd4`, branch
`investigate/direct-recompilability`.

No production code, test, tool, or `package.json` change was made. No production
fix was attempted. `reports/public-benchmark/` and
`benchmarks/public/codefuse-arm64/` were read only. Diagnostic C sources live in
`/tmp` and are not committed. **No fixed-prelude benchmark was implemented.**

## Answer to the headline question

Raw Hex pseudocode from the 160 `codefuse-arm64` cases does not form a standalone
compilable translation unit. That single fact decomposes into **three different
things that must not be merged**:

1. **Emissible today, just not emitted.** Local declarations, temporaries, label
   placement, and type spelling exist as analysis data and can be fixed inside a
   single function. Recoverable metadata: `inferSemanticTypes()` returns `locals`.
2. **Not in the product's contract.** Prototypes, global declarations, runtime
   helper declarations, and an entry-point signature have no home in a
   function-scoped `pseudocode` string. `tools/validation/public-benchmark/subject.mjs`
   calls `product.query.decompile(snapshot, address)` once per function.
3. **Measurement artifacts.** `expected expression`, `expected ']'`,
   `conflicting types`, implicit-vs-definition conflicts, and argument-count
   mismatches are cascades of (1)/(2), not separate bugs. They are tagged
   `independentDefect: false` with a `cascadeOf` root.

## Numbers

Exact base SHA: `05c93a1c92b34f4876060bd858e4393557d02dd4`.

| metric | value |
|---|---|
| cases | 160 |
| raw syntax/type/declaration stage pass | **0 / 160** |
| raw link stage pass | **0 / 160** (link stage never reached; not an independent measurement) |
| link stage reachable | 0 / 160 |
| packaging-only failure | **0 / 160** |
| emitter-only failure | **0 / 160** |
| mixed (independent packaging **and** independent emitter defect) | **160 / 160** |
| unknown / unclassified | 0 / 160 |
| total `error` diagnostics | 71,836 |
| total `warning` diagnostics | 5,492 |
| cluster occurrences | A packaging 20,516 · B emitter 56,768 (53,280 independent) · C cascade/note 718 · D toolchain 0 |

Every case fails for both reasons at once. There is no case that a packaging fix
alone can rescue and none that an emitter fix alone can rescue.

Focused isolation probe (each function's pseudocode compiled **alone**, nothing
added): **3,204 / 10,292 function bodies (31.1%) already compile**; 140/160 cases
have at least one such function; 0 cases have all of them. Of the 7,088 that fail
alone, 4,378 fail first on an emitter-scoped defect and 2,710 on a packaging one.

## Neutral control: this is a property of the tool class

The same corpus ships 160 IDA Pro 9.1 / Hex-Rays reference `.c` artifacts. Running
**the identical compiler rules** on them (`harness/reference-control.py`):

| | Hex (160 case TUs) | IDA Pro reference (160 files) |
|---|---|---|
| syntax pass | 0 / 160 | **0 / 160** |
| typical error count | 76–1,680 | 2–15 |
| dominant first family | undeclared identifier (`local_*`, `global_*`) | `unknown type name '__int64'` |

Both fail. `__int64`, `_QWORD`, `__fastcall`, `JUMPOUT(...)` are exactly the same
*class* of problem as `uint64`/`unknown_call`: decompiler output assumes a prelude
that the tool does not emit.

**This is not a quality or superiority comparison and must not be reported as
one.** The artifacts differ structurally (IDA emits one program-scoped file per
case with local declarations already present; Hex emits function-scoped text), the
error *count* is dominated by cascades and is not a quality metric, and no
semantic check of any kind was performed here. A fair comparison is the
benchmark's own oracle-based evaluation, which is out of scope for this report.

## Root-cause clusters (top, with source locations)

See `root-causes.json` for all 32 and `02-root-causes.md` for detail.

| cluster | occ | root cause | location |
|---|---|---|---|
| B-UNDECLARED-STACK-SLOT | 28,180 | semantic renderer emits **no declaration lines**; `lines = [sig, '{', body, '}']` and the line-kind vocabulary has no `decl` | `js/decompiler/semantic-core.js:1620-1625` |
| B-UNDECLARED-REGISTER-PSEUDO-VAR | 14,440 | same missing declaration path; not covered even by the legacy decl emitter | same |
| A-NONSTANDARD-INT-ALIAS | 8,990 | bare type vocabulary in the signature renderer; no typedef/prelude | `js/decompiler/type-recovery.js:7-11`, `:326-334` |
| A-STANDARD-TYPE-ALIAS | 4,552 | expression printer uses `uint32_t`; nothing emits `<stdint.h>` or typedefs | `js/decompiler/pretty/c.js:60-70` |
| B-UNDECLARED-ARG-PSEUDO-VAR | 4,012 | signature renders no args while the body names `a1..aN` | `js/decompiler/type-recovery.js:326-334` |
| A-RUNTIME-HELPER-DECL | 2,810 | `unknown_call` is the **unresolved-callee sentinel**, printed as a call; pseudo-intrinsics likewise | `js/decompiler/pretty/c.js:185`, `js/decompiler/pipeline-core.js:1448` |
| B-UNDECLARED-CALL-TEMP | 2,698 | `call_<id>` temporaries created but never declared | `js/decompiler/pipeline-core.js:1183` |
| A-MISSING-PROTOTYPE | 2,036 | no TU ownership boundary exists; function-scoped contract | `tools/validation/public-benchmark/subject.mjs:20-38` |
| A-GLOBAL-DATA-DECL | 1,510 | `global_<addr>` synthesised at print time; no global declaration list | `js/decompiler/semantic-core.js:861-866` |
| B-LABEL-BEFORE-BODY | 648 | `ensureLegacyLabel` clamps its insertion index to `Math.max(1, …)`, which lands **between** `sig` and `{`; the first body line is index 2 | `js/decompile-base.js:304-311` |
| B-STATEMENT-OUTSIDE-FUNCTION | 532 | `ensureLegacyGoto` anchors at the last line with `row <= endRow`; the legacy renderer stamps the closing `}` with a real row, so the `goto` lands at file scope | `js/decompile-base.js:317-338`, `js/decompile-legacy.js:139` |
| B-UNDECLARED-LABEL | 544 | goto emission and label emission disagree about which blocks are materialised | `js/decompiler/semantic-core.js:1486-1500` |
| B-UNDECLARED-PHI-TEMP | 342 | two inconsistent phi encodings: `local_phi_<id>` vars and `phi(a,b)` calls | `js/decompiler/pipeline-core.js:1187` |
| B-ENTRY-SIGNATURE | 160 | no entry-point contract; `void main(void)` | `js/decompiler/type-recovery.js:326-334` |

The two insertion-anchor defects (`B-LABEL-BEFORE-BODY`,
`B-STATEMENT-OUTSIDE-FUNCTION`) are single-index bugs and are the cheapest real
emitter defects in the study.

## General fix candidates

Ordered by (measured occurrences) / (blast radius), all inside the emitter:

1. **Seed the label insertion anchor at the first body line.** Change the
   `Math.max(1, …)` floor in `ensureLegacyLabel` to the index after the `{` line,
   and exclude closing-brace lines from `ensureLegacyGoto`'s anchor search. Two
   local edits; removes 648 + 532 errors and unblocks every case's structural
   validity.
2. **Emit a body-local declaration block** for every materialised
   pseudo-variable: recovered `locals`, register/high-variable names, `call_<id>`,
   `local_phi_<id>`, `v<id>`, `a<n>`, condition/flag temporaries. The metadata is
   already returned by `inferSemanticTypes()`; the legacy route already
   demonstrates the emission shape (`js/decompile-legacy.js:2160-2190`).
3. **Unify the type vocabulary.** One table, `_t` spelling, plus a deterministic
   prelude. Removes both alias clusters and their cascades.
4. **Give the unresolved-callee sentinel a real representation.** Today an
   unresolved target prints as a call to `unknown_call`. Either declare the
   runtime/intrinsic surface or print an explicit unresolved-call form that does
   not fabricate a symbol.
5. **Escape or demangle non-C symbol names** at the symbol boundary: `$x`,
   `Container::get`, `thunk to …::funcB`, `param_atomic_ops.constprop.0`, mangled
   `_Z…`. Also make placeholder names unique (8 cases currently redefine `$x`).
6. **Make label emission and goto emission share one block-materialisation set**
   and fail closed instead of emitting a `goto` to a label that was not emitted.
7. **Introduce a translation-unit assembly layer** for prototypes, global variable
   declarations, and the entry-point signature. This is new product surface, not a
   printer tweak, and it is the only way to make items in group (2) above
   measurable at all.

## What a deterministic prelude would measure — and what it would not

If a fixed prelude (`<stdint.h>`/`<stddef.h>`, a typedef block, and declarations
for the runtime/intrinsic surface) were introduced later, it would let us measure:

- the **delta** in cases/functions that transition from fail to pass, and whether
  that delta is exactly the packaging clusters;
- the **residual** failure set with packaging removed, which is the real
  emitter-quality signal (expected residual first-failure mass: ~4,378 isolated
  functions, dominated by undeclared stack slots);
- whether the emitter clusters are *disjoint* from the packaging clusters or
  interact (e.g. does fixing `uint64` expose further, previously masked,
  expression defects).

What it would **not** measure:

- whether the emitted program is *semantically* correct — `unknown_call` has no
  correct definition, so materialising it as a no-op would measure a different
  program;
- anything about ARM64 execution (see below);
- Hex's semantic quality, which is a separate axis from translation-unit
  completeness.

Two hard requirements if that benchmark is ever built: the **raw baseline in this
report stays the reference** (a prelude result must never replace it), and the
prelude must be a single frozen artifact whose exact bytes are recorded, because
its content decides the result.

## What must not be counted as repair

- Adding typedefs, prototypes, `extern`s, or includes **to the emitted source**
  and then reporting the result as Hex's recompilability. That measures the patch
  author, not the decompiler.
- Any per-case hand edit, rename, or syntax fix.
- Suppressing the gate: `-w`, `-Wno-implicit-function-declaration`,
  `-Wno-everything`, `-fpermissive`, or dropping the failing functions from the
  translation unit. Under clang ≥ 16 and gcc ≥ 14 the implicit-declaration
  warnings in cluster A-MISSING-PROTOTYPE (2,036) are already **errors**, so a
  pass obtained on clang 14 by silencing warnings is not a pass.
- Reporting the 3,204 single-function passes as "cases that compile". A function
  body is not a translation unit.
- Reporting host x86_64 clang results as ARM64 or target-runtime evidence.
- Concluding anything about Hex vs IDA/Ghidra from this report. The reference
  control shows both fail the same stage; superiority requires the benchmark's own
  oracle-based evaluation.

## What is needed to measure target ARM64 runtime functionality

Neither stage of this study executes anything. To measure "does the recovered
program behave like the original on ARM64", all of the following are required:

1. **ARM64 toolchain.** `aarch64-linux-gnu` (or Apple-silicon) clang/gcc with an
   aarch64 libc/sysroot. The host x86_64 clang used here cannot produce ARM64
   evidence, and none of the counts above should be relabelled as ARM64.
2. **An execution environment.** `qemu-aarch64` (user mode) or real ARM64
   hardware / an arm64 CI runner. iOS/iPadOS would additionally require the
   Apple toolchain and a device class.
3. **Correct semantics for the unresolved surface.** `unknown_call`, `phi`,
   `bit_extract`, `bit_insert`, `sext`, `__a64_movi_*`, `__arm64_condition_*`,
   `__arm64_nzcv_*` currently carry *unknown* semantics by design (the artifact
   records `unknownCallArities`). Measuring runtime behaviour requires either
   resolving those targets from the binary's symbol/relocation data, or accepting
   that the comparison is only valid on functions that contain none of them.
4. **Declaration truth from the binary.** Global addresses (`global_<addr>`),
   callee prototypes (`sub_<addr>`), and the entry point contract must come from
   the analyzed binary's symbols/relocations rather than from inference, otherwise
   a "successful" link proves alignment of inventions, not of the program.
5. **An oracle and a harness.** The corpus already provides the 160 ARM64 `.bin`
   inputs and 8 reference `.c` files, but per-case runtime oracles (argv/stdin,
   expected stdout/exit, or a differential harness against the original binary)
   are not present in `reports/public-benchmark/` and would have to be built and
   frozen like the denominator was.
6. **Deterministic link and run policy.** Frozen linker flags, frozen runtime
   preamble bytes, per-case timeout, and a documented policy for functions that
   remain `PARTIAL`/`CRASH` in the artifact. Denominator: **66 / 160 cases contain
   at least one CRASH function** (340 CRASH functions in total; case-level artifact
   states are 66 `CRASH` / 94 `PASS`). A CRASH function carries no pseudocode, so
   it never enters the reconstructed translation unit; the 66 affected cases would
   be reported as partial, not silently dropped. (No case is entirely CRASH, and
   no case is free of pseudocode-bearing functions.)

## Remaining unknowns

- **Route attribution.** The corpus has no per-function field saying whether the
  semantic or the legacy emitter produced each pseudocode blob. Both routes are
  traced in `02-root-causes.md` and 416 blobs visibly contain the legacy `decl`
  block, but blob-level attribution is not derivable from the artifact.
- **Cascade completeness.** Cascade tagging covers the families observed here
  (`expected expression`, `expected ']'`, `conflicting types`, argument-count
  mismatch, incomplete type, undeclared `i`). A different compiler's recovery
  diagnostics could produce cascades not classified as such.
- **Reference comparability.** The IDA control uses the same compiler command but
  a different output shape (program-scoped, with local declarations). The gap in
  error *counts* is not interpretable as a quality gap without the benchmark's
  oracle.
- **`B-UNRESOLVED-OPERAND-PLACEHOLDER`.** Confirmed as real emitted `?` tokens in
  operand position (16 cases) but narrowed only to `printExpression`, not to the
  specific statement that produced them.
- **Whether `locals` was deliberately dropped** from the semantic path or simply
  never wired; no commit/comment in the read source states the intent.

## Report index

| file | stage |
|---|---|
| `00-baseline.md` + `compiler-diagnostics.json` | raw compiler baseline, all 160 cases |
| `01-taxonomy.md` + `diagnostic-taxonomy.json` | 32 clusters, 78,002 diagnostics fully reconciled |
| `02-root-causes.md` + `root-causes.json` | producer-contract mapping with `file:line` spans |
| `single-function-probe.json` | isolation probe (3,204/10,292 pass alone) |
| `reference-control.json` | IDA Pro reference control (0/160 pass; not a quality comparison) |
| `harness/` | deterministic reproduction scripts |
