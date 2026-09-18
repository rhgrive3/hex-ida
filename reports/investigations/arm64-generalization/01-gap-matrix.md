# Stage 2 — Independent ARM64 generalization gap matrix

- Base SHA: `05c93a1c92b34f4876060bd858e4393557d02dd4` (`investigate/arm64-generalization`)
- Input: `inventory.json` (Stage 1)
- Machine-readable companion: `gap-matrix.json` — 15 gaps, a per-dimension coverage summary, measured
  costs, and three observed base conditions.
- Mode: investigation and design only. No production code and no existing test was changed.

Coverage vocabulary used below (and defined in the JSON):

| Term | Meaning |
|---|---|
| exact-executable-regression | green test that fails on the real defect, reachable from the canonical gate |
| unit-level-semantics | the semantic unit is asserted in isolation, without a compiled program |
| synthetic-only | the artefact under test is built inside the test, not by a real toolchain |
| partial | real evidence exists, but a stated part of the dimension is unproven |
| not-covered | no evidence of any class |

---

## 0. Three observations about the base before any gap is named

These were measured, not inferred. All three are pre-existing at the audit base SHA; none was caused by
this audit (the worktree is clean and nothing under `js/` or `tests/` was touched).

**OBS-1 — the canonical gate is red on the ARM64 decompiler lane.**
`node tests/phase8/run.mjs --group provenance/arm64-expanded-semantic-denominator` exits 1:

```
AssertionError: quality.gvn_call_barrier.O0: projection history
  + actual - expected
  + undefined
  - 'complete'
    at tests/phase8/provenance/arm64-expanded-semantic-denominator.test.mjs:51
```

`tests/support/phase-node-test-runner.mjs:9-20` discovers every `*.test.mjs` recursively with no skip
list, so this failure is inside `npm run phase8:test`, and therefore inside `npm run check`. The existing
ARM64 decompiler-corpus lane is **not** a green baseline, and a new suite must not treat it as
"already covered".

**OBS-2 — the instruction-coverage gate fails closed locally.**
`assertMachineEffectsPrerequisites()` throws:

```
machine-effects-prerequisite-failure: missing llvm-mc LLVM 18;
tried /usr/bin/llvm-mc-18:ENOENT, llvm-mc-18:ENOENT
```

This environment has LLVM 14 only. The behaviour is *correct* (fail closed, never skip), but it means the
376,186-word decoder denominator and all seven family denominators could not be re-measured in this audit.
`tools/validation/machine-effects/prerequisites.mjs:22-28` pins LLVM 18 for `llvm-mc`, `clang`,
`llvm-objdump`, `llvm-objcopy`.

**OBS-3 — the strongest ARM64 semantic suite can be green while a mandatory language never runs.**
`npm run compiler-truth` exits 0 and prints
`{"executed":36,"expectedCases":36,"hardFailures":0, ... "swift":{"status":"skipped","reason":"swiftc unavailable"}}`.
The assertions at `tests/compiler-truth/run-core.mjs:243-245` only cover the clang lane; the skip is
produced at `tests/compiler-truth/language-matrix.mjs:163` and cannot fail the run. **A missing
toolchain/language must be BLOCKING, never a skip.** This single observation shapes a requirement of the
Stage 3 design.

Measured cost references (for the Stage 3 budget): `tests/scpa/threaded-native-acceptance.test.mjs`
5 tests ≈ **10.5 s** (real ELF + deployed Capstone + worker + public query); `npm run compiler-truth`
full matrix ≈ **18.8 s**; `tests/phase8/provenance/arm64-expanded-semantic-denominator.test.mjs` ≈
**10 s** (fails per OBS-1); `tests/phase8/corpus/no-op-equivalence.test.mjs` did **not complete in 200 s**.

---

## 1. The structural gap: ARM64 has no machine-byte decompiler route

**G-01 — coverage: not-covered. This is the most important finding of the audit.**

The frozen Phase 8 decompiler-quality corpus is explicit about it
(`tools/validation/phase8/build-corpus.mjs:31-37`, echoed in `decompile-corpus.mjs:1-13`):

| architecture | representation | decode path |
|---|---|---|
| `arm64` | `assembly` (clang `-S` text) | re-parsed test-side by `parseOperands` from `js/arm64.js`, then the public `decompile()` facade |
| `x86_64` | `machine-bytes` from a final ELF link | shipped Capstone artifact → target lifter → shared Semantic IR/CFG/SSA/MemorySSA |
| `riscv64` | `machine-bytes` from a final ELF link | same as x86_64 |

This is not a documentation artefact. `js/targets/architecture/arm64/` contains only
`encoding-word.js`, `memory-access-qualifiers.js` and `effects/` — there is no decoded-instruction
provider and no architecture `semantic-function` entry, whereas both x86_64 and riscv64 have them. And the
"decoded production driver" tests skip ARM64 because the driver does not exist for it:

- `tests/phase8/provenance/navigation.test.mjs:24` — `for (const architecture of ['x86_64','riscv64'])`
- `tests/phase8/provenance/presentation-cache.test.mjs:24` — same pair
- `tests/phase8/corpus/explicit-compiler-abi.test.mjs:49` — same pair

**Product risk.** ARM64 is the primary shipping architecture (iOS/iPad-first per
`docs/ENGINEERING_PROCESS_GUARDRAILS.md` §8). Its only decompiler-quality evidence is assembler text that
the tests re-parse, i.e. a *simulation* of the decoder's textual output. A defect in real Capstone
operand text, in the loader, or in any conversion between them is invisible to the strongest existing
decompiler gate. This is precisely the "decoder coverage ≠ decompiler end-to-end recovery" confusion the
audit was asked to avoid.

**Missing evidence.** A test that loads a real ARM64 binary, decodes it with the shipped Capstone
artifact, enters the shared semantic pipeline, and asserts recovered semantics against an independently
computed oracle — for the same source set the other two architectures already run.

---

## 2. Missing evidence by dimension

Everything below is stated with the specific evidence that does exist, so the gap is "what is unproven",
never "what is absent from the repository".

### G-02 Swift — not-covered, and currently invisible

`tests/compiler-truth/language-matrix.mjs:160-164` returns `{status:'skipped'}` when `swiftc` is absent;
`run-core.mjs` cannot fail on it (OBS-3). The `swift-micro` recipe in the existing competitive manifest has
never executed. Swift coverage today is metadata/witness-table structure only
(`tests/scpa/swift-generic.test.mjs`, `issue-2378`, `issue-4005`, `issue-5893`).

*Risk:* Swift is the dominant iOS language; the whole Swift ARM64 decompiler path can regress with no gate
turning red. *Overfit risk:* low — CodeFuse's frozen set is C-only. *Fixture style:* owned compiler twin
with a pinned `swiftc`, and a **BLOCKING** prerequisite if absent.

### G-03 Rust and Go — not-covered

Recipes `rust-micro` and `go-micro` exist in `tests/competitive-arm64/manifest/post-b.json` with pinned
compiler argv, but all cells are `UNMEASURED` (`tools/competitive-arm64/manifest.mjs`). Current coverage is
symbol/metadata decoding: `issue-3715`, `issue-6182`, `issue-6203`, `issue-6237`, `issue-6239`,
`issue-5347`, `issue-7879`. *Overfit risk:* low. *Fixture style:* extend the existing 6-recipe identity with
an executable owned-fixture lane rather than inventing a second manifest format.

### G-04/G-05 Mach-O and PE — synthetic-only

42 of 197 `tests/phase4/binary` files reference ARM64, and they are built in-test with `DataView` writers
(canonical shape: `tests/phase4/binary/issue-3615-macho-arm64-32-indirect-pointer-width.test.mjs:25-71`).
Exactly **one** file reads a checked-in binary (`tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf`).
The three pinned real iOS images are absent — each of `tests/battlecats`, `tests/TsumTsum`, `tests/YWP`
holds a 62–69 byte `HEX_LARGE_FIXTURE_PLACEHOLDER`.

*Risk:* Mach-O is the shipping container; its parser is validated only against bytes authored by the same
authors who wrote the parser, so byte-builder and parser can share one blind spot. *Fixture style:* one
digest-pinned owned Mach-O ARM64 fixture produced by a recorded local assembler/link recipe, with an
explicit statement that it is not Apple-toolchain evidence; keep large real images in a separate opt-in tier.

### G-06 FP and SIMD data flow — unit-level-semantics

`arm64-a64-fp-denominator` / `arm64-a64-simd-denominator` assert registry ownership over enumerated
encodings; `arm64-fp-*` / `arm64-simd-*` assert operand and modifier domains. No compiler-produced ARM64
function asserts floating-point or vector *semantics* after decompilation. *Risk:* high — this is where a
decoder-level notion of correctness most easily diverges from recovered source semantics. *Overfit risk:*
**medium**: FP cases must be designed from the language contract (dot product, clamp, fma chain) with an
independently computed value set — never from any reference text.

### G-07 Atomics and ordering — unit-level-semantics

Effects are classified (`issue-8603`, `issue-8607`, `arm64-atomic-*`) and five claim-local litmus programs
exist under `tests/machine-effects/fixtures/formal-source/`. Neither bounds the lifter. *Fixture style:*
two-sided assertion — exact semantics where the product claims exactness, and an explicit **"unknown must
remain unknown"** where it does not. Silently dropping to raw assembly is a failure, not a fallback.

### G-08 ABI at a real call site — unit-level-semantics

Roughly sixty files across `tests/phase6/abi`, `tests/phase8/abi` and `tests/semantic-v2` assert AAPCS64
and Darwin classification rules as units (register pairs, stack natural alignment, return-width authority,
v8–v15 clobber, HFA/HVA, Darwin compact slots, long double, variadic word slots, ILP32/arm64_32 widths,
`sret`). **None compiles a call site that actually passes an HFA by value or returns a 17-byte struct.**
*Risk:* a rule that is correct in isolation can still be bound to the wrong registers or slots at a real
call site — exactly the user-visible failure. *Overfit risk:* low (CodeFuse exercises neither).

### G-09 Stripped vs debug twins — not-covered in practice

The policy already exists and has never run: `tools/competitive-arm64/manifest.mjs` declares
`twins: "one linked debug artifact copied then allowlisted strip only"` and reports
`binaryTwinsVerified: false`. *Risk:* real targets are stripped; a suite that only ever sees debug info
silently assumes symbol authority production does not have. *Fixture style:* the already-declared twin
policy, asserted as a pair with the invariant *neither twin may silently degrade a declared-exact result,
and a symbol-dependent claim must become explicitly unknown rather than wrong*.

### G-10/G-11 Optimization levels and compiler families — partial

The in-gate corpus stops at `-O2` (`tools/validation/phase8/build-corpus.mjs OPTIMIZATION_LEVELS`);
`-O3/-Os/-Oz` exist only in the out-of-gate `compiler-truth`. Only one compiler family is represented
anywhere in the gate. The guardrails require enumerated compiler families and forbid one available compiler
from silently satisfying a multi-family contract (§3.5). *Overfit risk:* **high** if the new grid copies
CodeFuse's `{O0,O1,O2,O3,Os} × {debug,no-debug}` shape; choose levels from the code-generation behaviour
under test and include at least one level CodeFuse does not use. *Requirement:* a second family must be a
**BLOCKING** enumerated prerequisite with recorded version/target, never an optional extra.

### G-12 Large / pathological functions — not-covered in gate

The only large ARM64 artefacts are the absent pinned images; `npm run accuracy` is out of the gate. OBS-4
shows unbounded corpus cost is already real. EP-016 in the guardrails records an O(N²) path that produced a
~139 s pathological function. *Fixture style:* a separate highest tier with deterministic generated inputs
and an **algorithm-sensitive** bound (work units), asserted as "completes within the declared bound" and
"result set unchanged" — never part of the per-PR budget.

### G-13/G-14 Symbol aliases and arm64_32 — synthetic-only / not-covered

Mapping symbols (`$x`/`$d`) and local aliases are only ever seen in hand-built symbol tables; the
`dispatch-table.elf` fixture is hand-written assembly without compiler-emitted mapping symbols. `arm64_32`
appears only as width assertions on built fixtures (`issue-8406`, `issue-3615`, `issue-8280`,
`issue-8428`). *Risk:* medium each — mapping symbols govern ARM64 code/data separation in ELF, and
arm64_32 width confusion produces plausible-looking wrong output.

### G-15 False-green resistance of the new coverage itself — partial

The repository already owns every discipline a new suite needs; the risk is that a new suite would not
reuse it:

| Existing pattern | Where | Why the new suite needs it |
|---|---|---|
| locked denominator that forbids full-ISA claims and exposes blocking gaps | `tests/machine-effects/a2-denominator.test.mjs:19-25` | prevents "we cover ARM64" from meaning "we cover a registry" |
| hard-zero counters vs a frozen baseline + two-run determinism under one time budget | `tools/validation/phase8/metrics.mjs:315-410`, `MEASUREMENT_TIME_BUDGET_MS` | makes a semantic or provenance regression impossible to launder |
| sha256 source+binary identity with a recorded rebuild command and an explicit non-claim string | `tests/scpa/fixtures/threaded-integer.json` | makes provenance auditable and prevents evidence inflation |
| fail-closed pinned-toolchain prerequisite | `tools/validation/machine-effects/prerequisites.mjs:22-28,77-84` | prevents a missing toolchain from becoming a silent pass (OBS-3) |

What is missing is that these are **per-suite, not shared**: there is no common excluded-by-environment
counter, no common separation of declared precision from achieved precision, and OBS-3 shows the failure
mode is already live.

---

## 3. What the matrix implies for the design stage

1. **Do not build an ARM64 instruction suite.** Decoder and effect ownership is already exhaustive; adding
   to it would add cost and no information. Reuse `tests/machine-effects` as-is and treat it as a
   precondition, not a target.
2. **The centre of gravity is the real-binary → semantic oracle path** (G-01, and by extension G-02…G-09,
   G-13, G-14). The cheapest proven foundation is the `tests/scpa` fixture discipline: owned source,
   pinned toolchain, sha256-pinned binary, recorded rebuild command, explicit non-claims — plus
   `tests/compiler-truth`'s oracle style: an independently evaluated source-level contract rather than a
   reference text.
3. **A missing toolchain/language must be BLOCKING** (OBS-3). A suite that can be green while a language
   lane never runs is worse than no suite, because it manufactures confidence.
4. **Separate semantic correctness from presentation metrics**, and count excluded-by-environment cells
   explicitly, so a green run can never mean an empty run.
5. **Do not inherit OBS-1 as a baseline.** A new suite must define its own frozen baseline captured from
   the exact base product, and the red ARM64 lane must be resolved on its own ownership lane before it can
   be cited as coverage.
6. **Stay orthogonal to CodeFuse.** Different source set, different oracle type (source-level semantic
   equivalence, not reference-text similarity), different optimization set, and no gate that can be
   satisfied by resembling an IDA artifact.

Stage 3 turns these six statements into a tiered, cost-bounded, provenance-fixed suite design that extends
the existing 12-case / 6-recipe foundation instead of replacing it.
