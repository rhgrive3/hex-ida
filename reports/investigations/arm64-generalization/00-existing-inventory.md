# Stage 1 — Existing ARM64 coverage inventory

- Audit: independent ARM64 generalization coverage audit
- Repository: `/mnt/workspace/hex-ida`
- Worktree: `/mnt/workspace/hex-agent-h`
- Branch: `investigate/arm64-generalization`
- Base SHA: `05c93a1c92b34f4876060bd858e4393557d02dd4`
- Mode: **investigation and design only** — no production code and no existing test file was modified.
- Machine-readable companion: `inventory.json` (evidence ids `E01`–`E21`, dimension map, gate reachability)

**CodeFuse posture.** `benchmarks/public/codefuse-arm64/**` was inspected only to size the external
comparison target. No CodeFuse source, binary, case name, function name, address, or reference output
was copied into any fixture proposal in this stage. CodeFuse is the final external comparison object,
not a fixture-design oracle.

---

## 1. What already exists (size and shape)

ARM64 is not an uncovered architecture in this repository. `git ls-files` returns 576 tracked paths
matching `arm64|aarch64`, of which the bulk are the 160 CodeFuse binaries plus 160 CodeFuse reference
files. The test surface proper is:

| Surface | Count |
|---|---|
| tracked files under `tests/` | 4,245 |
| `tests/**/*.test.mjs` | 2,748 |
| `tests/machine-effects/*.test.mjs` | 239 (119 with `arm64` in the name) |
| `tests/phase4/binary/*.test.mjs` | 197 (42 referencing arm64/aarch64) |
| `tests/scpa/**` referencing arm64 | 65 |
| `tests/competitive-arm64` | 12 cases, 6 language recipes, 6 source files |
| CodeFuse ARM64 external suite | 160 cases (8 programs × {clang,gcc} × {O0,O1,O2,O3,Os} × {debug,no-debug}) |
| Phase 8 frozen decompiler corpus | 135 cases; 45 ARM64 |

The decisive question is not how many files mention ARM64, but **what each one asserts**. The
classification below is the spine of `inventory.json`.

---

## 2. Evidence classes, and what each one actually proves

### 2.1 Exhaustive instruction / effect ownership (largest volume, narrowest reach)

`E01`, `E02`, `E04`, `E05`, `E16`, `E21`

`tests/machine-effects/arm64-a64-decoder-denominator.test.mjs` runs a locked candidate word corpus
(376,186 candidates / 375,875 unique words, digest-bound in the inventory) through the deployed
Capstone ARM64 session and requires every valid in-profile encoding to be owned by exactly one
canonical effect family, with a separate negative proof that no valid encoding can reach the
unmatched-family fallback. The per-family denominators are equally concrete — the integer
denominator asserts `encodingFamilyCount = 39`, `encodingCaseCount = 68,901`, `mnemonicCount = 83`,
and set-equality against the shipped `ARM64_INTEGER_EFFECT_MNEMONICS` registry
(`tests/machine-effects/arm64-a64-integer-denominator.test.mjs:34-37`).

`tests/machine-effects/a2-denominator.test.mjs` locks all four architecture profiles
(`arm64:a64`, `arm64e:a64+pac`, `x86_64:long-64`, `riscv64:rv64imc`) with
`fullIsaCoverageIncluded = false` and requires `blockingGapCount === 0` for terminality. That guard is
important: the repository already forbids equating registry ownership with full ISA coverage
(`tests/machine-effects/a2-denominator.test.mjs:19-25`).

**What this proves:** decode ownership and effect-classification ownership per instruction form.
**What it does not prove:** that any function-level recovery is correct, or that a compiler-produced
sequence of those instructions decompiles to the right semantics.

### 2.2 Lost ARM64 assembler text-based decompiler corpus

`E07`, `E08`

`tests/phase8/corpus/functions.json` is the primary decompiler-quality corpus: 135 cases =
3 architectures × 15 source functions × {`-O0`,`-O1`,`-O2`}, with a frozen pre-Phase-8 baseline and
hard-zero counters in `tools/validation/phase8/metrics.mjs:315-410`
(`semanticMismatchCount`, `provenanceLossCount`, `unknownSafetyRegressionCount`,
`renderProvenanceLossCount`, `renderProvenanceUnboundCount`). Determinism is proved by two independent
in-process runs sharing one time budget (`MEASUREMENT_TIME_BUDGET_MS = 20000`).

**The structural limitation matters more than the case count.** `tools/validation/phase8/build-corpus.mjs:31-37`
and `tools/validation/phase8/decompile-corpus.mjs:1-13` state it plainly:

- `arm64` lane → `representation: 'assembly'`; the frozen text is re-parsed by the test-side helper
  `parseOperands` from `js/arm64.js` and fed to the public `decompile()` facade.
- `x86_64` and `riscv64` lanes → `representation: 'machine-bytes'` frozen from a final ELF link and
  decoded later by the shipped Capstone artifact through the target lifter and the shared
  Semantic IR / CFG / SSA / MemorySSA pipeline.

A machine check confirms it: `representations = ['arm64:assembly', 'riscv64:machine-bytes',
'x86_64:machine-bytes']`. The ARM64 decompiler lane therefore never exercises
`loader → Capstone decode → decoded-instruction → semantic pipeline`. That is the single most valuable
ARM64 gap in the repository, and it is a measurement-realism gap rather than an instruction-coverage
gap.

### 2.3 Real compiler truth with real semantic evaluation — but outside the gate

`E09`

`tests/compiler-truth/` is the only existing suite that compiles real sources for real ARM64 targets and
evaluates recovered semantics:

- targets `aarch64-unknown-linux-gnu` and `arm64-apple-ios13.0`
  (`tests/compiler-truth/language-matrix.mjs:17`);
- sources `scalars.c`, `scalars.cpp`, `scalars.m`, `scalars.swift`, `extended.c`;
- optimizations `-O0 … -Oz` (`tests/compiler-truth/language-matrix.mjs:16`);
- the decompiled return expression is evaluated over
  `[0, 1, -1, 2, -2, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678]` and compared with an
  independently computed expected value (`tests/compiler-truth/language-matrix.mjs:112-130`);
- the suite is bound to a guarded deterministic boundary
  (`tests/compiler-truth/deterministic-decompile.mjs`) and a self-check that no component imports the
  product decompiler directly (`tests/compiler-truth/run.mjs:53-65`).

Two observations:

1. It is **not in `npm test` and not in `npm run check`**. `grep` over `.github/workflows` finds it only
   in `ghidra-differential.yml`. The best existing ARM64 semantic oracle is therefore not a regression.
2. It is still **assembly-text based** (`-S`, then a test-side parser builds a synthetic model), so it
   shares the realism limitation of §2.2 while being much stronger on semantics and language breadth.

`tools/validation/machine-effects/external-oracles.mjs:11-24` already registers `compiler-truth` as
`independent-source-and-concrete-vector-evidence` with `semanticAuthority:
'source-manifest-and-independent-evaluation-only'` — a policy hook a new suite can reuse.

### 2.4 Owned real ARM64 ELF end-to-end — the strongest existing artifact, with a narrow claim

`E10`

`tests/scpa/threaded-native-fixture.mjs` is the only path that takes a **real ARM64 binary** through the
actual product machinery: owned AArch64 assembly → `clang --target=aarch64-linux-gnu -fuse-ld=lld` →
`threaded-integer.elf` / `threaded-call-memory.elf` / `dispatch-table.elf`, each with pinned
`sourceSha256` and `binarySha256` and a recorded rebuild command in a sidecar manifest
(`tests/scpa/fixtures/threaded-integer.json`). The test then runs the real ELF parser, the **deployed
Capstone WASM** decoder, an actual `worker_threads` thread, the opt-in scoped ARM64 producer
(`js/analysis/scoped-arm64-producer.js`), and the public `AnalysisQueryAPI`, asserting function extents,
demand-query publication, integer-fragment and range-proof nodes, replay integrity/byte binding, and
invalidation on symbol-revision or binary-epoch change
(`tests/scpa/threaded-native-acceptance.test.mjs:11-38`).

`tests/scpa/threaded-native-fixture.mjs:4-6` states the claim boundary explicitly — "NOT browser/iPad
evidence" — and the sidecar manifests carry `"claim": "Test-owned assembled ELF fixture; not compiler-twin,
native execution, competitor, browser, or physical-device evidence." This is exactly the provenance
discipline a new suite should copy.

**Limits:** three hand-written assembly fixtures, no language matrix, no compiler-generated code, and the
oracle is proof/provenance shape rather than decompiled semantics.

### 2.5 Format-layer ARM64 correctness — real breadth, synthetic bytes

`E11`, `E15`, `E20`, `E14`

`tests/phase4/binary/**` (42 files referencing ARM64) covers ELF64, Mach-O including `arm64_32`, fat
archives, chained fixups, threaded bindings, LSDA/unwind xdata, and PE32+ ARM64: indirect symbol pointer
widths, load-command sizes, section VM layout, pointer widths, relocation whitelists, function-start
discovery. These fixtures are constructed in-test with `DataView` writers — the idiomatic shape is
`function buildIndirectFixture(...)` in
`tests/phase4/binary/issue-3615-macho-arm64-32-indirect-pointer-width.test.mjs:25-40`.
Exactly 1 of the 197 `phase4/binary` test files reads a checked-in binary fixture.

`tests/phase7/corpus/manifest.json` declares mandatory lanes `arm64`/`riscv64`/`x86_64`, supplementary
`arm64e`, and format lanes `elf`/`macho`/`pe`, with 19 alias/memory fixtures and explicit per-query truth
values (`no` / `may-or-weaker` / `must`) plus an `expectStrong` flag that keeps soundness and precision
separate. The ARM64 lane shares one frozen fixture shape with the other architectures — good for
cross-architecture symmetry, but it means the ARM64 lane cannot be more realistic than the shared shape.

The AAPCS64/Darwin ABI suites (`tests/phase6/abi`, `tests/phase8/abi`, `tests/semantic-v2/aapcs64-*`)
assert argument/return classification and placement as units: register pairs, stack natural alignment,
return width authority, v8–v15 clobber, HFA/HVA, Darwin compact slots, long double, variadic word slots,
ILP32/arm64_32 widths, indirect `sret` returns, required profile matrix. High rule coverage, and almost
never validated against a real compiled call site.

### 2.6 Large real ARM64 Mach-O — present, pinned, and unexecuted

`E19`

`tests/fixtures/real-binaries.json` pins three shas with sizes 28,153,072 / 45,994,784 / 63,455,952 bytes
(iOS game images). In this worktree `tests/battlecats`, `tests/TsumTsum`, `tests/YWP` each contain a
62–69 byte placeholder reading `HEX_LARGE_FIXTURE_PLACEHOLDER … Run: npm run fixtures:large`. The
`accuracy` harness that scores them is `npm run accuracy`, which is not part of `npm run check`. The
repository's only large real-world ARM64 corpus is therefore an opt-in, non-regression artifact.

### 2.7 The existing generalization foundation that must not be replaced

`E13`

`tests/competitive-arm64/manifest/post-b.json` is the 12-case / 6-recipe foundation named in the review:
cases `bv-wrap`, `alias-subobject`, `reaching-store`, `source-sink`, `length-buffer`, `allocation-guard`,
`register-dispatch`, `virtual-open`, `selector-open`, `witness-open`, `slice-bounds`, `closure-capture`;
recipes `c-micro`, `cpp-micro`, `objc-micro`, `swift-micro`, `rust-micro`, `go-micro` with pinned
compiler, argv, target triple, platform and source sha256; 28 metrics; 2 toolchain slots.

`tools/competitive-arm64/manifest.mjs` is an offline source-and-denominator gate: it re-verifies every
source hash, proves a deliberately wrong oracle sentinel is rejected, and reports all cells
`UNMEASURED` with `victoryEstablished: false`, `binaryTwinsVerified: false`, `nativeCompetitorsRun:
false`. The toolchain slots are `UNBOUND`. This is honest provenance scaffolding with **zero executed
measurement**; the correct action is to reuse and extend it, never to build a parallel ARM64 suite from
zero.

---

## 3. What the inventory establishes

1. **Instruction-level ARM64 ownership is already exhaustively covered** and must not be re-created.
   Duplicating decoder/effect enumeration would add cost and no information.
2. **Decompiler end-to-end ARM64 recovery is covered only through assembler text**, while the sibling
   x86_64 and riscv64 lanes use real machine bytes. This asymmetry is the primary realism gap.
3. **The strongest real-ARM64-binary end-to-end path (`tests/scpa`) asserts proofs and provenance, not
   decompiled semantics.** Nothing today connects a compiler-produced ARM64 binary to a semantic
   equivalence oracle.
4. **The strongest semantic oracle (`tests/compiler-truth`) is not in the canonical gate**, so it cannot
   act as a regression today.
5. **Language breadth exists but is not executed**: 6 recipes in `tests/competitive-arm64` and 160
   external cases in CodeFuse, against 1 assembled-ELF language (hand-written assembly) actually run
   end-to-end.
6. **Format breadth is synthetic**: ELF/Mach-O/PE ARM64 parsing is proven on in-test byte builders, with
   one (1) checked-in binary fixture in `phase4/binary`.
7. **Large real binaries are pinned but absent**, so they cannot gate anything.
8. **False-green discipline already exists and should be inherited**: the A2 locked denominator forbids
   full-ISA claims; Phase 8 owns hard-zero counters and a two-run determinism proof; the SCPA manifests
   carry explicit non-claims.

Stage 2 converts these eight statements into a per-dimension gap matrix with explicit coverage kinds
(exact executable regression / unit-level semantics / synthetic / partial / not covered / unknown), and
separates decoder-owned coverage from decompiler end-to-end recovery.
