# ARM64 function-discovery gap — root-cause investigation

**Investigation-only lane.** No production code, tests, `tools/`, or `package.json` were
modified. `reports/public-benchmark/` was treated as read-only and was not rewritten. All
artifacts live under `reports/investigations/function-discovery/`.

---

## 1. Identity

| item | value |
| --- | --- |
| investigation checkout HEAD | `05c93a1c92b34f4876060bd858e4393557d02dd4` |
| branch | `investigate/function-discovery-gaps` |
| worktree | `/mnt/workspace/hex-agent-e` |
| benchmark report generator SHA (`baseSha`) | `c061412fcea53d355b2ada8ff644a21c05b34207` (reported `dirty: true` by the producing run) |
| `reports/public-benchmark/summary.json` sha256 | `e44df2a95b98bb0dfdb06bac4bc54d837db6830723830c9a71403142f83cada0` |
| `benchmarks/public/codefuse-arm64/manifest.json` sha256 | `de5d7726ef6bb18649a0b8cc5e4d261e01873eb7ae2c5734d203fed7c8eef992` |
| reference oracle | IDA Pro 9.1 / Hex-Rays (`CodeFuse-DeBench published artifact`) |

`baseSha` is the SHA recorded *inside* the report; it is not the investigation checkout SHA.
Both are recorded in every machine-readable artifact here.

## 2. Evidence sources

- `reports/public-benchmark/summary.json` — the comparison rows (`comparison.cases[].rows`)
- `reports/public-benchmark/<caseId-hex>.json` — per-case Hex subject output
  (`schema: hex-public-benchmark-subject/v1`: `functions[]`, `functionDiscoveryComplete`,
  `productRoute`, `state`)
- `benchmarks/public/codefuse-arm64/manifest.json` — per-case binary hash, compiler,
  optimization, debug
- `benchmarks/public/codefuse-arm64/inputs/*.bin` — the 160 binaries (read directly)
- `benchmarks/public/codefuse-arm64/reference/**` — published IDA Hex-Rays output for each case;
  used as the IDA-side oracle (function headers, names, `__noreturn` annotations, IDA's own
  warnings)
- production source, **read only**: `js/binary/elf-core-original.js`,
  `js/binary/elf-aarch64-mapping.js`, `js/binary/elf-dynamic-original.js`, `js/words.js`,
  `js/worker-legacy.js`, `js/worker-fixes.js`, `js/worker-data-in-code-fix.js`, `js/backend.js`,
  `js/symbols.js`, `js/analysis/demand-driven-runtime.js`, `js/analysis/discovery/producers.js`,
  `js/analysis/discovery/artifact.js`, `js/analysis/query/app-adapter.js`,
  `js/analysis/summary/interprocedural.js`, `js/analysis/semantic-function-base.js`
- the repository's own read-only host `tools/validation/public-benchmark/product-host.mjs`,
  reused by `scripts/first-divergence-probe.mjs` for focused reproduction

## 3. Recalculated result (all 160 cases, from this checkout)

| metric | value | task reference | agrees |
| --- | ---: | ---: | --- |
| cases | 160 | 160 | yes |
| address-union denominator | 11,124 | 11,124 | yes |
| matched by address | 10,804 | 10,804 | yes |
| **IDA-present / Hex-absent** | **172** | 172 | yes |
| **Hex-present / IDA-absent** | **148** | 148 | yes |
| IDA-present total | 10,976 | — | — |
| Hex-present total | 10,952 | — | — |

No discrepancy against the reference values. `scripts/baseline-extract.mjs` enumerates the rows,
cross-checks them against `comparison.aggregate`, and fails closed if they disagree.

Structural facts about the 172:

- they collapse to **39 distinct addresses**; mean ≈ 1.08 addresses per case
- **every one of the 160 cases** has at least one IDA-only address
- the distribution is flat over group / compiler / optimization / debug
  (clang 92 / gcc 80; `O0..Os` 34/36/34/34/34; `-g` 91 / no-`g` 81)
- function-level crashes do **not** explain it: 66/160 cases are `state: CRASH`
  (`reason: function-crash`), but mean IDA-only per case is 1.152 (CRASH) vs 1.021 (PASS)
- **none** of the 172 carries an `STT_FUNC` symbol, **none** is the entrypoint, **none** has an
  FDE starting at it, and **none** is the target of any `bl` or `b` in its binary
- **every** IDA-only name is an IDA-generated `sub_XXXX`; IDA had no real name for any of them

### Benchmark-methodology observation (reported, not assumed)

`comparison.aggregate.idaCoverage = idaFunctions / denominator = 10976/11124 = 0.9866954`,
while `hexCoverage = hexPseudocode / denominator = 10292/11124 = 0.9252068`. The two published
"coverage" numbers are therefore **not the same quantity** — one is function presence and the
other is pseudocode success. The 172 IDA-only rows drive `matched`/the IDA-only count, not
`hexCoverage` directly. This is recorded as an observation about the published artifact; it was
not modified.

## 4. Root-cause cluster table

| cluster | rows | cases | addrs | confidence | first divergence | generalizable class |
| --- | ---: | ---: | ---: | --- | --- | --- |
| **A** `ida_synthetic_plt_resolver_stub` | 160 | 160 | 28 | **confirmed** | S2 loader base starts (nothing seeds it) + S3 scans `.plt` and yields 0 starts | linker-generated PLT resolver stub; no PLT model exists in Hex at all |
| **B** `ida_noreturn_split_of_enclosing_function` | 10 | 5 | 10 | **confirmed** | S3 discovery (both gates of the post-noreturn boundary rule close) | interprocedurally-noreturn leaf called mid-function |
| **C** `ida_address_taken_table_target_split` | 2 | 2 | 1 | **probable** | S3 discovery (post-indirect-BR acceptance rejects a `mov imm; ret` case body) | address-taken switch case body behind `br` |

Confirmed **170** rows / probable **2** rows / unknown **0** rows.

### A — `.plt` resolver stub (160 rows, one per binary)

The address is exactly the start of `.plt`; its only symbols are the `.plt` `SECTION` symbol and
the AAELF64 mapping symbol `$x`. IDA declares the PLT0 resolver stub a function (`sub_XXXX`);
Hex declares nothing in the whole `.plt` range. The individual PLT thunks are absent from IDA's
function list too, so the entire disagreement is this one object.

Tracing (`1/1_clang_O1_g`, `0x880`): present at S1 as a section start + code bytes → **absent at
S2** → S3 scans region `p0_s24` (`.plt`, `exec:true`) and discovers **0** starts → absent at S4/S5.
The control is the neighbouring `.init` start `0x860`, which **is** present at S2 — and only
because the binary carries a real `STT_FUNC` symbol `_init` there. So it is not "the scanner
rejects `.plt`"; the seed layer has nothing to offer.
`grep -rn '\bplt\b' js/ --include=*.js` → **0 matches**: Hex has no PLT model and no PLT-specific
exclusion.

### B — IDA tail split after an inferred-noreturn call (10 rows, 5 cases, all `5-1` clang `-g`)

Every row: interior to an `STT_FUNC` span, no symbol/FDE/branch reference, immediately preceded
by `bl` to a function IDA annotates `__noreturn`, and IDA's own reference carries
`// positive sp value has been detected, the output may be wrong!`.

`.text` is scanned and yields 208 starts in the representative case, but not these. The producer
exists (`js/worker-legacy.js` `postNoreturn`) and both of its gates close:

1. `prevWasNoreturnCall` requires `slice.noreturnTargets.has(callTarget)`, and
   `noreturnTargets` is built **only** from the fixed `NORETURN_NAME` regex
   (`stack_chk_fail|objc_exception_throw|abort|assert_rtn|cxa_throw|terminate|swift_*fatal|swift_*trap|fatalError`)
   — a user C++ function that is noreturn only by interprocedural inference does not match;
2. the continuation must satisfy `Words.looksLikePrologue` (only `stp →sp`, `sub sp`, `bti`,
   `paciasp`/`pacibsp`) — `mov w1, w0` and `ldr w0,[sp,#8]` do not.

Hex already has the missing knowledge in the semantic layer
(`js/analysis/summary/interprocedural.js`, `semantic-function-base.js`
`prototypeNoreturnState`); discovery does not consume it.

### C — address-taken switch case body (2 rows, 2 cases, `1/1_clang_O1`)

`0x174c` is an `R_AARCH64_RELATIVE` addend in `.data.rel.ro` (`0x12db8`), reached by
`ldr x8,[x8,w1,sxtw #3]; br x8`. Hex **does** discover the three sibling case bodies
(`0x1754/0x175c/0x1764`) that follow a `ret`, and does **not** discover the one that follows the
indirect `br`. The asymmetry is the rule shape: `postRet` accepts `MOVIMM:RET` tiny leaves, while
the `postIndirectBranch` loop accepts only load-prefixed dispatch thunks, ADRP-prefixed dispatch
thunks, or a candidate that is itself an unconditional `b`.

Counter-evidence in the same suite: in `1/1_clang_O2/O3/Os` Hex reports 20–23 **more** starts than
IDA, all exactly the `R_AARCH64_RELATIVE` addends of the same `.data.rel.ro` tables and all real
`FUNC LOCAL` symbols in those binaries. Hex resolves this construct when the symbol layer wins.

## 5. Generality — why these are not benchmark-specific

| cluster | why it generalizes |
| --- | --- |
| A | Every dynamically linked ELF links `.plt`; the trigger is "an executable region whose start has no `STT_FUNC` symbol", which also covers hand-written / `--section-start` code regions. No benchmark address, name, compiler, or case id is involved. |
| B | The trigger is "an internal function that never returns, called from the middle of its caller" — a language-level C/C++ construct, not a benchmark shape. The gap is structural: discovery uses a fixed known-import name allowlist while the semantic layer already computes real noreturn state. |
| C | The trigger is "a compiler-emitted pointer table of code addresses behind an indirect branch" — the standard lowering of large `switch` statements, and the same construct the suite exercises in both directions. |

None of the three requires any CodeFuse-specific function name or address to be recognized, and
no proposed change in this report is keyed on one.

## 6. Confirmed / probable / unknown

| status | rows | meaning |
| --- | ---: | --- |
| **confirmed** | 170 | mechanism proven from binary evidence + source anchors + reproduced stage trace |
| **probable** | 2 | mechanism proven, but "which tool is right" is a convention decision, not a fact |
| **unknown** | **0** | nothing left unclassified |

**Unresolved count: 0 rows.** Two *design* questions remain open by construction (they are
convention choices, not unknown evidence):

1. should Hex model the PLT0 resolver stub as a function at all;
2. should Hex match IDA's per-case-body split for address-taken case bodies.

One thing is **not** a design choice and is a confirmed defect: **the `.plt` omission is silent**
— `functionStartsComplete = true` and `functionDiscovery.reasons = []` in every traced case while
an executable region produced zero starts.

## 7. Production fix candidates

Ordered by evidence strength. None is implemented here.

### Candidate A1 — stop reporting discovery as complete when an executable region yields no starts *(confirmed defect)*
- **Where:** `js/worker-legacy.js` `guessFunctions` region loop and the completeness
  aggregation in `js/analysis/demand-driven-runtime.js` (`symbols.functionDiscovery`);
  marks exist (`js/binary/elf-aarch64-mapping.js` uses `markPartial`/`markELFMetadataPartial`).
- **Shape:** a region with zero seeds and zero discovered starts, when it is executable and
  non-empty, must not report `complete: true` with an empty `reasons` list.
- **Blast radius:** the completeness/staleness gate only
  (`app.js`, `analysis/shared-app-artifacts.js`, `analysis/query/product-adapter.js`,
  `diff/*` all read `functionStartsComplete`). Could turn currently-"complete" cases into
  "partial", so it must be paired with a decision on A2.

### Candidate A2 — a generic "executable region first instruction" seed *(confirmed gap, design-gated)*
- **Where:** seed layer (`js/binary/elf-core-original.js`) or the scanner's region prologue
  (`js/worker-legacy.js`).
- **Shape:** emit a start for the first instruction of an executable region when it decodes to a
  real instruction and no symbol extent covers it. Generic; not PLT-specific.
- **Blast radius:** start-set size for every ELF with a `.plt` (+1 start per binary here);
  no effect on the analysis of real functions, but it changes the reference-comparison numerator.

### Candidate B1 — let discovery consume the existing interprocedural noreturn summary *(convention-gated)*
- **Where:** `js/worker-legacy.js` `noreturnTargets` construction (replacing the fixed regex with
  inferred noreturn state) plus a relaxed continuation gate for the post-noreturn case.
- **Caveat:** IDA's own output marks this split as suspect, and matching it moves Hex away from
  the ELF symbol table. Recommend **not** fixing for correctness; if the convention is adopted,
  make it explicit and golden-tested.

### Candidate C1 — address-taken fallback for post-indirect-branch case bodies *(convention-gated)*
- **Where:** the `postIndirectBranch` acceptance loop in `js/worker-legacy.js`.
- **Better shape:** publish ELF `relocationTargets` in the loader (currently
  `grep -rn relocationTargets js/binary/*.js` → **0 hits**, a dead end on the ELF route) so the
  existing generic `referenceProducer` / discovery artifact can corroborate — this also unlocks
  the generic path for ELF rather than adding another heuristic branch.
- **Blast radius:** start granularity inside already-recognized functions for C/C++ switch
  tables; also touches the Hex-only direction of the same construct.

## 8. Expected blast radius summary

| candidate | surfaces touched | user-visible effect |
| --- | --- | --- |
| A1 | completeness signal (`functionStartsComplete`, `functionDiscovery.reasons`), everything that consumes them | more honest "partial" states; no analysis change |
| A2 | ELF seed set / scanner region start | +1 function per ELF binary with a `.plt` |
| B1 | discovery boundary rule for post-noreturn continuations | changes where starts are drawn, against the ELF symbol table |
| C1 | post-indirect-BR acceptance rule and/or ELF `relocationTargets` publication | more starts inside switch dispatchers |

## 9. Recommended regression fixtures

1. **(A1/A2)** A synthetic ELF/AArch64 PIE built with the standard linker: assert either a start
   at the `.plt` section start, or that `functionDiscovery.reasons` marks the region that
   produced no starts. Plus a region-level unit test: an executable region with zero starts and
   zero seeds cannot report `complete: true`.
2. **(B1)** A small C/C++ fixture with an internal noreturn leaf called from the middle of a
   caller; a golden test pins Hex's chosen convention so a future change cannot drift silently.
3. **(C1)** A C `switch` compiled so the compiler emits a pointer table behind `br`; assert the
   convention for both the dispatcher-adjacent and the `ret`-preceded case bodies.
4. **(methodology)** A check on the public-benchmark report that `idaCoverage` and `hexCoverage`
   are documented as different quantities (function presence vs pseudocode success).

No fixture should reference any benchmark case id, function name, or address.

## 10. Dependency between the repair lanes (A / B / C)

*Naming note:* this investigation produces exactly three clusters, and the repair-lane names
below are assigned to them (**A** = `.plt` / seed layer, **B** = noreturn boundary, **C** =
address-taken case bodies). If "A/B/C" refer to pre-existing external lanes, this mapping must be
confirmed before scheduling.

| lane | depends on | blocks | can ship alone? |
| --- | --- | --- | --- |
| **A1** completeness honesty | nothing | A2 scheduling (A2 alone would make previously-complete cases silently larger without any partial signal for the still-unseeded regions) | yes |
| **A2** generic region-start seed | the A1 decision (must not enlarge the start set while completeness stays `true` for unseeded regions) | — | yes, but pair with A1 |
| **B1** noreturn boundary | a convention decision (IDA's split is an artifact) | — | yes; not recommended for correctness |
| **C1** address-taken case body | convention decision; if implemented via ELF `relocationTargets` publication it also becomes a prerequisite for using the generic discovery artifact on ELF | — | yes |

Independent of A/B/C: publishing ELF `relocationTargets` is a *shared prerequisite* if the intent
is ever to move ELF off the classic worker onto the generic Phase-7 discovery artifact — the
artifact's `referenceProducer` is currently unreachable for ELF.

## 11. Artifacts and commits

| file | phase |
| --- | --- |
| `00-baseline.md`, `ida-only-functions.json`, `hex-only-functions.json`, `per-case-comparison.json` | 1 |
| `01-classification.md`, `classification.json` | 2 |
| `02-first-divergence.md`, `root-cause-clusters.json` | 3 |
| `README.md` | 4 |
| `scripts/baseline-extract.mjs`, `scripts/classify.mjs`, `scripts/elf-probe.mjs`, `scripts/cluster-roots.mjs`, `scripts/first-divergence-probe.mjs` | tooling |

All JSON artifacts are written to a temporary path, re-parsed for schema/count validation, then
atomically renamed (no partially written or failed-producer artifact is published).
