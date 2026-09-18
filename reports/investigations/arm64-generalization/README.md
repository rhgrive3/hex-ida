# Independent ARM64 generalization coverage audit

**Status:** investigation and design only. No production code, no new test, and no existing test was
created or modified by this audit. Nothing here is implemented.

| | |
|---|---|
| Repository | `/mnt/workspace/hex-ida` |
| Audit worktree | `/mnt/workspace/hex-agent-h` |
| Branch | `investigate/arm64-generalization` |
| **Exact base SHA** | **`05c93a1c92b34f4876060bd858e4393557d02dd4`** |
| Date | 2026-09-18 |
| Reviewed process contract | `docs/ENGINEERING_PROCESS_GUARDRAILS.md` (read before acting, per `AGENTS.md`) |

## Documents

| File | Stage | Content |
|---|---|---|
| `inventory.json` | 1 | machine-readable inventory: 21 evidence classes, per-dimension map, gate reachability |
| `00-existing-inventory.md` | 1 | what each ARM64 evidence class actually asserts (not filename counts) |
| `gap-matrix.json` | 2 | 15 gaps with coverage kind, product risk, overfit risk, fixture style, cost; 3 measured base observations |
| `01-gap-matrix.md` | 2 | narrative separation of decoder coverage from decompiler end-to-end recovery |
| `proposed-matrix.json` | 3 | proposed tier/case matrix, provenance schema, hard-zero counters, overfit rules, reuse map |
| `02-suite-design.md` | 3 | the suite design in prose |
| `README.md` | 4 | this merge-acceptance proposal |

---

## 1. Current coverage strengths (do not rebuild these)

1. **Exhaustive instruction ownership.** A locked 376,186-word A64 decoder denominator, seven per-family
   effect denominators (e.g. the integer denominator asserts 39 encoding families / 68,901 cases / 83
   mnemonics), `arm64e` PAC/BTI denominators, and a locked A2 inventory over four architecture profiles.
2. **Self-limiting coverage claims.** The A2 denominator forbids claiming full-ISA coverage and exposes
   blocking gaps explicitly (`tests/machine-effects/a2-denominator.test.mjs:19-25`).
3. **False-green discipline that already exists.** Phase 8 owns nine-style hard-zero counters against a
   frozen baseline plus a two-run determinism proof under one shared time budget
   (`tools/validation/phase8/metrics.mjs`); the SCPA fixtures pin source and binary digests with a recorded
   rebuild command and an explicit non-claim string; the machine-effects prerequisites fail closed on a
   missing pinned toolchain.
4. **A real-compiler semantic oracle already exists.** `tests/compiler-truth` compiles C/C++/ObjC/Swift for
   `aarch64-unknown-linux-gnu` and `arm64-apple-ios13.0` at `-O0…-Oz` and evaluates recovered return
   expressions against independently computed values over a boundary set.
5. **A real ARM64 binary end-to-end path already exists.** `tests/scpa/threaded-native-acceptance.test.mjs`
   takes an owned AArch64 ELF through the real ELF parser, the deployed Capstone WASM decoder, a worker
   thread, the scoped ARM64 producer and the public QueryAPI — measured at 10.5 s for 5 tests.
6. **A language-recipe foundation exists.** `tests/competitive-arm64/manifest/post-b.json`:
   12 cases, 6 recipes (C/C++/ObjC/Swift/Rust/Go), pinned compilers/argv/triples, 28 metrics, honest
   `UNMEASURED` reporting.

## 2. Blind spots (what is not proven)

1. **ARM64 has no machine-byte decompiler route.** The frozen Phase 8 corpus decompiles ARM64 from clang
   `-S` text re-parsed test-side, while `x86_64`/`riscv64` freeze real linked bytes decoded by the shipped
   Capstone artifact (`tools/validation/phase8/build-corpus.mjs:31-37`). `js/targets/architecture/arm64/`
   has no decoded-instruction provider, and the decoded-driver tests skip ARM64
   (`tests/phase8/provenance/navigation.test.mjs:24`).
2. **No compiler-produced ARM64 binary is tied to a semantic oracle inside the canonical gate.**
3. **Swift is unproven and currently invisible**: `compiler-truth` exits 0 while `swiftc` is skipped
   (`tests/compiler-truth/language-matrix.mjs:163`; assertions only cover the clang lane).
4. **Rust and Go are unexecuted** recipes with no decompiler evidence.
5. **Mach-O/PE ARM64 is synthetic-only**: hand-built `DataView` fixtures; exactly one checked-in binary
   fixture in 197 `phase4/binary` tests; the three pinned large iOS images are absent placeholders.
6. **ABI classification is never validated at a real call site** (~60 unit tests, no compiled call site).
7. **FP/SIMD/atomics have no decompiler-level semantics evidence.**
8. **Optimization coverage stops at `-O2` in-gate; compiler diversity is clang-only in-gate.**
9. **Stripped/debug twins have never been built** (`binaryTwinsVerified: false`).
10. **Three measured base conditions** (`gap-matrix.json`): a red canonical-gate test on the ARM64
    provenance lane; a correctly fail-closed LLVM-18 prerequisite blocking local re-measurement; and a
    silently-skipped mandatory language. None was introduced by this audit.

## 3. Minimum proposed new cases

| Class | Items | Notes |
|---|---|---|
| **mustDo** | 12 Tier 1 end-to-end cases + 6 Tier 2 ABI cases | the smallest set that closes blind spots 1, 2 and 6 |
| **shouldDo** | Tier 0 `T0-01…T0-05` | without it the suite can be green while measuring nothing |
| **deferred** | Swift/Rust/Go language lanes; all of Tier 3 | blocked on pinned toolchains (`swiftc`/`rustc`/`go` are missing in this environment) and on budget separation |

### High-value cases (best value per second)

| Case | Why it is high value | Cost |
|---|---|---|
| `gen-int-wrap` | first compiler-produced ARM64 binary judged by an independent oracle; closes the structural route gap end to end | ≈1–3 s |
| `gen-indirect-unknown` | directly tests that unknown stays explicit rather than being folded to a plausible target — the failure users cannot see | ≈1–3 s |
| `gen-switch-dense` / `gen-switch-sparse` | jump-table recovery is where raw-assembly escalation and lost case targets hide | ≈2–6 s |
| `abi-hfa-by-value` / `abi-aggregate-return-17` | converts a correct-in-isolation classification rule into a real call-site proof | ≈2–4 s |
| `T0-01` / `T0-05` | the two counters that stop "green but empty" and "green but non-deterministic" | <1 s |
| `gen-fp-contract` | first FP semantics evidence of any kind after decompilation | ≈1–3 s |

### Expensive / deferred cases

- all of **Tier 3** (large function, deep nesting, large real Mach-O, discovery scale) — opt-in only;
  motivated by the measured hazard that `tests/phase8/corpus/no-op-equivalence.test.mjs` did not complete
  in 200 s;
- **Swift/Rust/Go lanes** — deferred until a pinned toolchain exists *and* is a blocking prerequisite;
- **large real iOS images** — the pinned artifacts are absent, so they cannot gate anything.

## 4. Suite runtime budget proposal

| Tier | Budget | Gate |
|---|---|---|
| Tier 0 | ≤ 5 s | merge-blocking |
| Tier 1 | ≤ 60 s | merge-blocking |
| Tier 2 | ≤ 90 s | merge-blocking (ABI), blocking-but-unavailable for absent language lanes |
| **added per-PR total** | **≤ 150 s (2.5 min)** | |
| Tier 3 | minutes | opt-in command, never in the per-PR path |

Calibration reference points: `compiler-truth` full matrix 18.8 s; SCPA threaded acceptance 10.5 s.

## 5. Provenance requirements

Every fixture is an `arm64-generalization-fixture/v1` record containing the case id and tier, source path
and sha256, full build identity (compiler, compiler version, linker and version, target triple, platform,
optimization level, debug flag, argv, and a copy-pasteable rebuild command), artifact path and sha256 plus
the stripped twin's sha256, the oracle id/authority/independence/input space, the expected functions and
semantics, the hard-zero counters, and an explicit **claim** string:

> Owned compiler-produced AArch64 fixture. Not CodeFuse, competitor, browser, physical-device or
> reference-text evidence.

Rules: a rebuild that changes a digest invalidates the frozen baseline as **one documented transaction**,
and the baseline is re-captured from the base product, never from the candidate. A missing mandatory
toolchain is **blocking** and counted, never a skip.

## 6. Overfit prevention rules

Forbidden: copying CodeFuse case names, function names, addresses, binary digests or reference text;
using another tool's output (IDA or any reference `.c`) as an oracle; asserting against a specific rendered
string of the current implementation; **making CodeFuse score improvement a merge condition**.

Required: the source set, oracle type and optimization set must each differ from CodeFuse's frozen shape;
every case states why its assertion cannot be satisfied by memorizing current product output; Tier 1/2
sources are owned and unpublished as a scored corpus, with CodeFuse remaining the only published external
scoreboard.

---

## 7. Merge acceptance proposal — combining the three signals

Merge readiness is decided by three **independent** signals, not one:

| Signal | Nature | Role in the merge decision |
|---|---|---|
| **A — existing focused regressions** | exact executable regressions: the ARM64 decoder/effect denominators, `arm64-*` root regressions, `issue-*-arm64*` defect tests, Phase 8 corpus counters | **must be green.** Catches the specific known defects. Fast and narrow. |
| **B — independent ARM64 generalization suite** | the proposed owned, unpublished holdout judged by source-level semantic oracles | **the primary merge condition.** Catches the class-level capability loss that no single defect regression expresses. |
| **C — CodeFuse external benchmark** | 160 frozen ARM64 cases scored against an IDA Pro reference; similarity-based | **reported only. Never a condition, in either direction.** |

### Decision rules

1. **B green** (all nine hard-zero counters zero, no case blocked by a missing prerequisite) **and A green**
   → mergeable. Signal C may be unchanged or worse; that does not block.
2. **B red** → not mergeable, even if C improves. Per guardrails principle 3, the first deterministic
   divergence (the generalization failure) is the bug to diagnose; the CodeFuse movement is downstream
   presentation and must not be repaired around.
3. **A red** → not mergeable, independent of B and C.
4. **C improves while B is unchanged** → allowed. The change must **not** be described as a generalization
   improvement; it is a distribution-specific effect and must be labelled as such.
5. **B is blocked, not green** (missing pinned toolchain, absent artifact, empty corpus) → **not mergeable
   on that evidence.** Absence of evidence is never a pass; the correct action is to restore the
   prerequisite or record an explicit, counted environment exclusion with a follow-up blocker, at which
   point the merge decision is deferred rather than granted.

### Why this combination defeats benchmark-specific optimization

CodeFuse's oracle is another tool's output on a *published, frozen* corpus, so a change can raise its score
without generalizing: matching IDA's naming, its formatting conventions, or memorizing its case distribution
are all sufficient. Signals A and B are structurally immune to that:

- **A** is a set of exact regressions for real defects — it moves only when a defect truly regresses.
- **B** is held out: owned sources that are not published as a scored corpus, judged by *source-level
  semantic contracts* rather than by any reference text, with assertions on invariants such as "the unknown
  stays explicit", "the semantic path is retained", and "raw-assembly escalation does not increase".
  None of those can be satisfied by resembling an IDA artifact.

The asymmetry is deliberate: an optimizer of the CodeFuse score gains nothing on B, while a genuine
capability improvement moves both. A change that only raises C is therefore mergeable but must be *labelled*
as distribution-specific; a change that lowers B is not mergeable at any C. CodeFuse stays valuable as a
reported cross-distribution diagnostic and as the external scoreboard, and it stops being an authority over
merges. **CodeFuse score improvement is never a merge requirement; the independent invariant is.**

### Resolutions required before this proposal can be adopted

1. The existing red ARM64 provenance test (base-condition OBS-1,
   `tests/phase8/provenance/arm64-expanded-semantic-denominator.test.mjs:51`) must be assigned to an owning
   lane and resolved before Phase 8 ARM64 coverage can be cited as a strength.
2. Tier 1 must either gain a production ARM64 decoded-instruction provider or explicitly begin on the
   existing `decompile()` facade with the decoded route recorded as a counted remaining unknown.
3. Decide whether merge-blocking starts with Tier 1 alone or Tier 0 + Tier 1 together.

---

## 8. Stage commits (this branch)

| Stage | Commit | Subject |
|---|---|---|
| 1 | `800092bc453e2c5be57de2ddeb20efaf898a9ae3` | `investigation(arm64-generalization): inventory existing coverage` |
| 2 | `d6f232259` | `investigation(arm64-generalization): identify independent coverage gaps` |
| 3 | `6f18509f5` | `investigation(arm64-generalization): design holdout coverage matrix` |
| 4 | *(this commit)* | `investigation(arm64-generalization): finalize generalization plan` |

Base: `05c93a1c92b34f4876060bd858e4393557d02dd4`. No merge or push to `main` was performed.
