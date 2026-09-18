# Stage 3 — Independent ARM64 generalization suite design

- Base SHA: `05c93a1c92b34f4876060bd858e4393557d02dd4` (`investigate/arm64-generalization`)
- Inputs: `inventory.json` (Stage 1), `gap-matrix.json` (Stage 2)
- Machine-readable companion: `proposed-matrix.json`
- **Design only.** This audit implements nothing: no production code, no new test file, no fixture was
  created. The output of this stage is a specification that a future owner lane can implement.
- CodeFuse remains the final external comparison object. It is **not** a fixture-design oracle and the
  suite is explicitly required to pass with an unchanged or worse CodeFuse score.

---

## 1. What this suite is, and what it deliberately is not

**It is** the missing half of ARM64 coverage: *decompiler end-to-end recovery from real, compiler-produced
ARM64 binaries, judged by an independent source-level oracle.*

**It is not** another instruction-coverage suite. `tests/machine-effects` already owns that ground
exhaustively — a 376,186-word decoder denominator, seven per-family effect denominators, `arm64e` PAC/BTI
denominators, and a locked A2 inventory that already refuses to claim full-ISA coverage
(`tests/machine-effects/a2-denominator.test.mjs:19-25`). Duplicating any of it would add cost and no
information. The new suite instead pairs those denominators with the requirement that any
ARM64-specific generalization claim rests on real binaries and real semantics.

**Why it is needed** (Stage 2, re-stated as the design's reason to exist): the frozen Phase 8 corpus
decompiles ARM64 from clang `-S` assembler text re-parsed test-side by `parseOperands`, while `x86_64` and
`riscv64` freeze real linked machine bytes decoded by the shipped Capstone artifact
(`tools/validation/phase8/build-corpus.mjs:31-37`). `js/targets/architecture/arm64/` has no
decoded-instruction provider at all, and the ARM64 lane is skipped in the decoded-driver tests
(`tests/phase8/provenance/navigation.test.mjs:24`). The strongest real-compiler ARM64 semantic suite
(`tests/compiler-truth`) is outside the gate and, per OBS-3, reports success while a mandatory language
never runs.

---

## 2. Tier structure and cost separation

| Tier | Purpose | Budget | Gate posture |
|---|---|---|---|
| **Tier 0** — micro invariant | prove the suite cannot lie about itself: determinism, oracle self-rejection, provenance completeness, counted environment exclusions | ≤ 5 s | merge-blocking |
| **Tier 1** — end-to-end ARM64 | compiler-produced binary → real loader → shipped decoder → shared semantic path → oracle equivalence (12 cases) | ≤ 60 s | merge-blocking |
| **Tier 2** — ABI / language | ABI at a real call site (6 cases) plus the existing 6 recipe lanes made executable (5 language cases) | ≤ 90 s | merge-blocking for ABI; language lanes blocking-but-unavailable until their pinned toolchains exist |
| **Tier 3** — pathological / stress | large, deep, and scaling inputs; large real Mach-O | opt-in, minutes | never in the per-PR path |

**Measured references that make these budgets credible** (from Stage 2):
`npm run compiler-truth` full C/C++/ObjC matrix ≈ 18.8 s; `tests/scpa/threaded-native-acceptance.test.mjs`
(5 tests through real ELF + deployed Capstone + worker thread + public query) ≈ 10.5 s. Meanwhile
`tests/phase8/corpus/no-op-equivalence.test.mjs` did **not complete in 200 s** — the direct evidence that
the expensive class must live in its own tier rather than inside a general corpus.

Total added per-PR cost target: **≤ 2.5 minutes.**

---

## 3. Tier 0 — the anti-false-green layer

Nine hard-zero counters, one counted exclusion set, and four self-tests. These are the parts that make a
green run mean something:

1. **T0-01 determinism.** Two independent in-process runs of the Tier 1 observation corpus must be
   byte-identical, and both must share a **single** time budget. Reuses the pattern at
   `tools/validation/phase8/metrics.mjs` (`determinismFailures` + `MEASUREMENT_TIME_BUDGET_MS`), including
   its documented lesson: comparing a fast run against a slow run is a measurement defect, not a transform
   defect.
2. **T0-02 oracle sentinel rejection.** Every oracle must reject a deliberately mutated expectation before
   any case is admitted, following the `checkU64Add7` good/bad pair already used by
   `tools/competitive-arm64/manifest.mjs`.
3. **T0-03 independent arithmetic model self-test.** The oracle's integer/flag model is test-owned and
   reproduces hand-computed wrap, carry and overflow vectors; it must not import product semantics
   (shape precedent: `tools/validation/machine-effects/independent-oracle.mjs`).
4. **T0-04 provenance completeness.** Every declared case carries a source digest, artifact digest, oracle
   identity and rebuild command. A missing field is *counted* (`unboundCaseCount`), never skipped.
5. **T0-05 counted environment exclusions.** The prerequisite set is enumerated as a set. An unsatisfied
   member **blocks** the run and appears in `excludedByEnvironment`; a "green" run with a non-empty
   `excludedByEnvironment` is a blocked run. This exists specifically because OBS-3 showed that a missing
   language can currently be a silent skip inside a green suite
   (`tests/compiler-truth/language-matrix.mjs:163`, assertions only on the clang lane at
   `run-core.mjs:243-245`).

The nine hard-zero counters (`semanticPathLost`, `oracleMismatch`, `unknownBecameSilent`,
`rawAssemblyEscalationIncrease`, `exactClaimOnUnknown`, `withheldLedgerClaimsTransforms`,
`unboundCaseCount`, `nonDeterminismCount`, `excludedByEnvironment`) mirror counters the repository already
enforces for Phase 8 (`tools/validation/phase8/metrics.mjs:315-410`) so that "we lost the semantic path"
or "we now claim certainty we cannot support" cannot be laundered into a pass.

---

## 4. Tier 1 — the actual generalization holdout

Each case is an **owned** source file with a declared contract, compiled through a recorded argv, linked
to a minimal ELF, and frozen by sha256. Execution: real loader → shipped Capstone decode → shared semantic
pipeline → the public query/decompile facade. The oracle is a **source-level contract evaluated by a
test-owned interpreter over a finite value set** — the style already proven in
`tests/compiler-truth/language-matrix.mjs:112-130`, deliberately not a reference text.

Twelve cases, chosen to cover the Stage 2 gaps that unit coverage cannot reach:

| id | dimension | contract |
|---|---|---|
| `gen-int-wrap` | integer width | 64-bit wraparound at the arithmetic boundary |
| `gen-int-width` | integer width | signed/unsigned extension matrix across 8/16/32/64-bit |
| `gen-mem-reach` | memory reaching definition | store→load link survives, and breaks on an unknown clobbering call |
| `gen-pointer-stride` | pointer arithmetic | array-of-struct stride and distinct field offsets |
| `gen-cfg-irreducible` | irreducible flow | goto dispatcher; all reachable blocks preserved |
| `gen-loop-early-exit` | loop shape | counted loop with a mid-body break |
| `gen-loop-nested` | loop shape | nested loop with an induction pair |
| `gen-switch-dense` | jump table | dense switch → table branch, all targets recovered |
| `gen-switch-sparse` | jump table | sparse switch → compare chain, default arm distinct |
| `gen-indirect-unknown` | indirect control | unresolvable target stays explicitly open |
| `gen-fp-contract` | FP | floating-point accumulation/clamp against a computed result |
| `gen-simd-contract` | SIMD | vector reduction against a computed result |

Optimization levels: `-O0`, `-O2`, `-O3`. `-O3` is included deliberately: the in-gate corpus stops at
`-O2`, and aggressive optimization is the normal iOS release configuration.

**Stripped twins.** Every Tier 1 case also runs against an allowlisted strip-only copy of the same linked
artifact, using the twin policy already declared and never yet executed in
`tools/competitive-arm64/manifest.mjs` (`policies.twins`). The asserted invariant is the useful one:
*a declared-exact result must not degrade silently, and a symbol-dependent claim must become explicitly
unknown rather than wrong.*

### Assertion split

| Class | Blocking? | Examples |
|---|---|---|
| Semantic | yes | shared semantic path retained; oracle equivalence over the value set; declared-unknown stays explicit; raw-assembly escalation does not increase over the frozen baseline |
| Presentation | only via an explicit frozen-baseline regression rule | rendered length, `goto` count, readability vector |

This is D-I8's separation, and it is what stops a readability tweak from either blocking a correct merge or
masking a semantic regression.

---

## 5. Tier 2 — ABI at a real call site, and the language recipes made executable

**ABI (6 cases, merge-blocking).** The repository already owns ~60 classification tests across
`tests/phase6/abi`, `tests/phase8/abi` and `tests/semantic-v2` (register pairs, stack natural alignment,
return-width authority, v8–v15 clobber, HFA/HVA, Darwin compact slots, long double, variadic word slots,
`sret`, ILP32 widths). **None of them compiles a call site.** Tier 2 adds the missing half:
`abi-hfa-by-value`, `abi-aggregate-return-17`, `abi-varargs-word-slots`, `abi-sret-indirect`,
`abi-wide-integral-pair`, `abi-stack-natural-alignment`. The oracle is derived from the source contract and
the AAPCS64 rule text — never from another tool's output.

**Language lanes.** The existing `tests/competitive-arm64` manifest is the *inventory of record* and is
**extended, never replaced**: its 12 cases, 6 recipe ids (`c-micro`, `cpp-micro`, `objc-micro`,
`swift-micro`, `rust-micro`, `go-micro`), pinned compilers, argv, target triples and source digests all
stay. What Tier 2 adds is the missing *execution mode* — an owned linked binary per recipe with a semantic
oracle — reusing `virtual_open`, `selector_open`, `witnessOpen`, `slice_bounds`, `ClosureCapture`.

The six lanes are declared as a **set**. Every lane must be present-and-bound; an unbound lane blocks the
run and is counted (D-I12). Locally, this audit measured `swiftc`, `rustc` and `go` as **missing**, so the
design's honest position today is: *the Swift/Rust/Go lanes are blocking-but-unavailable, and that state
must be loud rather than green.* That is also the concrete fix for OBS-3.

---

## 6. Tier 3 — pathological and stress, opt-in

Four cases, run only by `npm run arm64-generalization:tier3`: a deterministically generated large function,
deep nesting, the existing sha256-pinned large iOS images (`tests/fixtures/real-binaries.json`), and
many-function discovery scaling. Bounds are expressed in **work units** and as "result set unchanged",
never as wall-clock thresholds, so an unrelated slow CI machine cannot flip the verdict. This is the
guardrails' EP-016 discipline: fix and bound the algorithmic hot path rather than hiding it behind more
runners.

---

## 7. Provenance contract

Every fixture is a `arm64-generalization-fixture/v1` document with: `caseId`, `tier`,
`source.{path,sha256}`, `build.{compiler,compilerVersion,linker,linkerVersion,targetTriple,platform,
optimizationLevel,debug,argv,rebuildCommand}`, `artifacts.{binary,binarySha256,strippedTwin,
strippedTwinSha256}`, `oracle.{id,authority,independent,inputSpace}`, `expected.{functions,semantics}`,
`counters.hardZero`, and a `claim` string.

The claim template is the same honesty discipline already used by the SCPA fixtures:

> Owned compiler-produced AArch64 fixture. Not CodeFuse, competitor, browser, physical-device or
> reference-text evidence.

Precedents reused rather than reinvented: `tests/scpa/fixtures/threaded-integer.json`
(`scpa-owned-assembled-fixture/v1`, with `sourceSha256`, `binarySha256`, `rebuild`, `expectedFunctions`,
`claim`) for artifact provenance, and `tools/validation/phase8/build-corpus.mjs` for toolchain recording
(compiler version string, per-target triple, optimization levels). Re-running the builder changes corpus
identity and invalidates the frozen baseline **as one documented transaction** — never as a quiet
regeneration.

---

## 8. Overfit prevention rules (normative)

Forbidden:

- **OF-1** copying any CodeFuse-declared case name, function name, address, binary digest or reference text;
- **OF-2** using another tool's output (IDA or any reference `.c`) as an oracle;
- **OF-3** asserting against a specific rendered string produced by the current implementation;
- **OF-4** making CodeFuse score improvement a merge condition — the suite must pass with an unchanged or
  worse CodeFuse score.

Required:

- **OF-5** the source set, the oracle type and the optimization set must each differ from CodeFuse's frozen
  shape (C-only sources, IDA reference, `{O0,O1,O2,O3,Os} × {debug,no-debug}`);
- **OF-6** every case states in the manifest why its assertion cannot be satisfied by memorizing the
  current product output;
- **OF-7** holdout discipline: Tier 1/2 sources are owned and are **not** published as a scored corpus.
  CodeFuse remains the only published external scoreboard.

The practical consequence: a change that improves the CodeFuse score while breaking
`gen-cfg-irreducible` or `abi-hfa-by-value` fails the merge; a change that leaves the CodeFuse score
identical but improves ARM64 generalization passes. CodeFuse becomes a *reported* signal, not an
*authority*.

---

## 9. Reuse map — what is reused, what is extended, what is genuinely new

**Reused unchanged** (no modification, cited as precedent):
`tests/machine-effects` ARM64 denominators as a precondition; `tools/validation/machine-effects/
prerequisites.mjs` fail-closed resolution; `tools/validation/machine-effects/independent-oracle.mjs`
independent arithmetic model; `tools/validation/phase8/metrics.mjs` hard-zero counters, frozen-baseline
comparison and shared-budget determinism; `tests/scpa/fixtures/*.json` +
`tests/scpa/threaded-native-fixture.mjs` provenance and real-ELF harness shape;
`tests/compiler-truth/deterministic-decompile.mjs` guarded deterministic boundary and its boundary-value
oracle style; `tools/competitive-arm64/manifest.mjs` wrong-oracle sentinel.

**Extended, not replaced:**

- `tests/competitive-arm64/manifest/post-b.json` — keep all 12 cases, 6 recipes, digests and the closed
  6-language set; add the executable owned-fixture lane per recipe. **No existing case is removed.**
- `tests/compiler-truth` — add the missing language lanes and make every declared lane a blocking
  prerequisite. The existing suite is not moved or rewritten by this audit.
- `tests/scpa` three owned ELF fixtures — keep them for the exact-extent and replay invariants they already
  prove; add compiler-produced fixtures alongside them.

**Genuinely new:** the Tier 1 real-binary semantic-oracle cases (the ARM64 machine-byte decompiler route
does not exist today); the nine counters as one shared contract; the counted
`excludedByEnvironment` set; and the stripped-twin pair assertion on the ARM64 semantic path.

---

## 10. Minimum deliverable, and open questions for the merge decision

**Minimum proposed new cases.** `mustDo`: the 12 Tier 1 cases plus the 6 ABI cases.
`shouldDo`: Tier 0 (T0-01…T0-05) — without it the suite can be green while measuring nothing.
`deferred`: the Swift/Rust/Go language lanes until their pinned toolchains are available and blocking;
Tier 3 entirely.

**Open questions a merge decision must answer** (recorded in `proposed-matrix.json`):

1. Which lane owns the **existing red** ARM64 provenance test (OBS-1,
   `tests/phase8/provenance/arm64-expanded-semantic-denominator.test.mjs:51`) *before* a new suite may cite
   Phase 8 ARM64 coverage as an existing strength?
2. Does Tier 1 require a production ARM64 decoded-instruction provider first, or should it initially assert
   through the existing `decompile()` facade while marking the decoded route as an explicit remaining
   unknown? Either answer is defensible only if it is written down and counted.
3. Which tier becomes merge-blocking first — Tier 1 alone, or Tier 0 + Tier 1 together?

Stage 4 turns these into the merge-acceptance proposal: how existing focused regressions, this independent
ARM64 generalization suite, and CodeFuse as an external scoreboard combine so that benchmark-specific
optimization cannot be merged.
