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
| A | Every dynamically linked ELF carries a PLT. The generalizable class is "executable bytes that no symbol describes because the *linker* generated them as a stub table", and it is recognised from the dynamic table (`DT_PLTGOT`/`DT_JMPREL` + `R_AARCH64_JUMP_SLOT` structure), not from a section name — verified on all 160 binaries (§2 of `03-fix-candidate-review.md`). Note the trigger is **not** "an executable region whose start has no symbol": that formulation was reviewed and withdrawn (see §7, A1′), because 640/640 executable regions here contain uncovered bytes and `.init`/`.fini` are executable regions whose only start is a symbol that another toolchain need not emit. No benchmark address, name, compiler, or case id is involved. |
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
an executable region produced zero starts. Its *remedy* was revised in the report-only review pass
(`03-fix-candidate-review.md`): report the unclassified executable bytes as coverage (A1′) rather
than redefine `complete`.

## 7. Production fix candidates

Ordered by evidence strength. None is implemented here. **Reviewed and revised** in
`03-fix-candidate-review.md` (report-only pass); the wording below is the post-review version.

### Candidate A1′ — executable-byte coverage accounting *(replaces A1; recommended, additive)*
- **Rejected predecessor:** *"a non-empty executable region that yields 0 starts must not report
  `complete: true`"*. Withdrawn as unsound: 640/640 executable regions here contain bytes no
  `STT_FUNC` extent covers (`.text` 44,192 bytes, `.init` 3,840, `.fini` 3,200, `.plt` 53,056), so
  the rule measures symbol provenance, not code; it also assumes region boundary == function
  boundary, and it redefines `complete` from a *truncation* claim into a *coverage* claim.
- **Where:** `js/worker-legacy.js` `guessFunctions` (`complete: !capped`, line 1509) and the
  completeness aggregation in `js/analysis/demand-driven-runtime.js` (`symbols.functionDiscovery`).
- **Shape:** leave `complete` **exactly as it is** ("producer was not truncated") and add
  `discovery.coverage = { executableBytes, attributedBytes, unclassified: [{start,end,class}] }`
  with `class ∈ {stub-table, function-without-symbol, padding, veneer-pool, data-in-executable,
  slot-padding, unknown}`. A range is classed `padding` only on positive evidence (zero words /
  `nop` `0xd503201f` / decodable filler), never on "no start here". The honesty signal becomes
  `unclassified.filter(c => c.class === 'unknown')`.
- **Blast radius:** additive fields only. Consumers that read only `complete`
  (`js/app.js:784` cache gate, `js/app.js:146-147` truncation reason,
  `analysis/shared-app-artifacts.js`, `analysis/query/product-adapter.js`, `diff/*`) see no change,
  so this cannot regress the existing signal — and the silent `.plt` omission is fixed at the
  reporting layer instead of by inventing a function.

### Candidate A2′ — PLT structural stub start *(replaces A2; recommended, gated on the ELF model)*
- **Rejected predecessor:** *"first instruction of every executable region ⇒ generic seed"*.
  Withdrawn: region start is not a function start in general, and "+1 function per binary" is a
  count target, not evidence. Oracle check: IDA's own object at that address is `sub_6D0() {
  JUMPOUT(0); }` and IDA models **none** of that binary's 7 import thunks as functions — so
  parity here would mean reproducing a code-vs-data heuristic artifact.
- **Shape:** emit **at most one** synthetic start per dynamically-identified PLT — the resolver
  slot base — tagged `elf-plt-structure`, low confidence, kind `stub` (not a decompilable body).
  Emit **no** starts for the import thunks; they are table entries and belong in `coverage`
  (A1′) and in naming (import name from `.rela.plt` + `.dynsym`). The address comes from the
  dynamic-table anchor, never `region.start`, so the recogniser cannot fire on `.text`,
  `.init_array`, or veneer pools — failure mode is "nothing added".
- **Model (verified 160/160, no section name consulted):** `DT_JMPREL` + jump-slot count ⇒
  `size == 16*(n+1)` with a 32-byte slot 0; slot 0 decodes as the AAELF64 resolver
  (`stp x16,x30,[sp,#-16]!` + `adrp`/`ldr x17`/`add`/`br`) and materialises `&GOT[2] == DT_PLTGOT+16`,
  which is **not** any jump-slot `r_offset`; slot *k* ≥ 1 encodes exactly `.rela.plt[k-1].r_offset`,
  in order (2996/2996). Works on stripped binaries; no `sh_name`/`sh_type`/symbol dependency.
- **Blast radius:** ≤1 stub entry per dynamically-linked AArch64 ELF; no effect on real functions.

### Candidate B1 — discovery consumes the interprocedural noreturn summary *(removed: phase cycle)*
- **Why removed:** the summary (`js/analysis/summary/interprocedural.js:49`, noreturn join at
  `:1152`) is computed from the entity/call-graph model built **from** discovery's start set
  (`js/app.js:829` runs discovery before the program scan; `js/analysis/index.js:290` builds the
  discovery artifact on that model). Discovery reading it gives
  `discovery → entity model → interprocedural summary → discovery` — a real, self-referential
  cycle. No cycle-free in-discovery variant exists: the 10 rows call **locally defined** noreturn
  helpers, unreachable from dynamic/import metadata, which is why the fixed-name allowlist misses
  them (`js/worker-legacy.js:653-656`).
- **Re-framed as B1a (design-gated, not recommended yet):** a downstream *additive-only*
  refinement after the summary exists. Mandatory constraints: invalidate
  `functionStartsComplete`/`functionDiscovery` or `js/app.js:784` serves the cached pre-refinement
  index; never move or delete an existing start; idempotent and epoch-guarded; and route splits
  through `js/rebuild/transaction-v2.js` rather than mutating the index in place.
- **Caveat unchanged:** IDA annotates these splits as suspect (`// positive sp value has been
  detected, the output may be wrong!`), so matching them is a convention decision.

### Candidate C1 — ELF `relocationTargets` publication *(kept, corroboration-only)*
- **Where:** loader ELF relocation parsing (currently `grep -rn relocationTargets js/binary/*.js`
  → **0 hits**, a dead end on the ELF route) so the existing generic `referenceProducer` /
  discovery artifact can corroborate; also unlocks the generic path for ELF instead of adding
  another heuristic branch.
- **Narrowed semantics:** relocation targets are **never a start authority**. An
  `R_AARCH64_RELATIVE` addend is a pointer-typed data word that also denotes jump-table bases,
  switch-case bodies, and `.data`/`.rodata` addresses. The corpus already shows the cost of
  inverting this: in `1/1_clang_O2/O3/Os` Hex reports 20-23 **more** starts than IDA, all of them
  `R_AARCH64_RELATIVE` addends that are also real `FUNC LOCAL` symbols — Hex is right there
  because the symbol layer outranks the heuristic.
- **Blast radius:** start granularity inside already-recognized functions for C/C++ switch
  tables; no start-set change on its own.

## 8. Expected blast radius summary

| candidate | surfaces touched | user-visible effect |
| --- | --- | --- |
| A1′ | new coverage fields on the discovery result; nothing that reads `complete` changes | new "unclassified executable bytes" information; `complete` semantics unchanged |
| A2′ | ELF seed layer + stub naming for dynamically-identified PLTs | ≤1 `stub` entry per dynamically-linked AArch64 ELF; nothing added for `.text`/`.init_array`/veneers |
| B1a (if ever scheduled) | symbol-index post-processing + `rebuild/transaction-v2.js` | deferred; would change start boundaries inside already-recognised functions |
| C1 | loader evidence publication (ELF relocations) | enables generic corroboration; no start-set change on its own |

## 9. Recommended regression fixtures

1. **(A1′)** Synthetic ELF with `.text` padding plus fully-symbolised functions: assert `complete`
   is unchanged and the padding is *positively* classed. The fixture must **fail** if a
   "0 starts ⇒ incomplete" rule is reintroduced.
2. **(A1′/A2′)** Linked dynamic AArch64 fixture: assert exactly one synthetic `stub` start at the
   dynamically-derived PLT resolver address, **zero** starts for the import thunks, and thunk-table
   + slot-padding classes in coverage.
3. **(A2′ negative)** Executable region with no PLT (hand-assembled `.text`; `.init_array` marked
   AX): assert **no** synthetic start is added — the guard against region-start seeding returning
   under another name.
4. **(A2′ portability)** The same fixture built with `-z now` / a non-default PLT layout: assert
   "no stub identified" rather than a wrong start.
5. **(B1a, when designed)** Idempotence + cache-invalidation: the refinement must invalidate
   `functionStartsComplete` and produce identical output when run twice.
6. **(C1)** Fixture where an `R_AARCH64_RELATIVE` addend points at a string/table base: assert the
   relocation target alone never creates a start and that symbol evidence still outranks it.
7. **(methodology)** A check on the public-benchmark report that `idaCoverage` and `hexCoverage`
   are documented as different quantities (function presence vs pseudocode success), and a guard
   that no production constant or path references the benchmark's expected counts.

No fixture should reference any benchmark case id, function name, or address.

## 10. Dependency between the repair lanes (A / B / C)

*Naming note:* this investigation produces exactly three clusters, and the repair-lane names
below are assigned to them (**A** = `.plt` / seed layer, **B** = noreturn boundary, **C** =
address-taken case bodies). If "A/B/C" refer to pre-existing external lanes, this mapping must be
confirmed before scheduling.

| lane | depends on | blocks | can ship alone? |
| --- | --- | --- | --- |
| **A1′** coverage honesty | nothing (additive) | nothing; sequencing with A2′ is a preference, not a requirement | yes |
| **A2′** PLT structural stub start | the §2 dynamic-structure model (must not become a region-start seed) | — | yes, but pair with A1′ so the remaining unclassified bytes are reported |
| **B1a** downstream refinement | a design pass (cache invalidation, append-only, re-entityisation through `rebuild/transaction-v2.js`) | nothing currently scheduled | no — do not schedule before its contract is fixed |
| **C1** relocation evidence publication | corroboration-only contract; symbol evidence must keep outranking it | the generic discovery artifact becoming usable on ELF | yes |

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
| `03-fix-candidate-review.md`, `exec-region-and-plt-evidence.json` | 5 (fix-candidate review, report-only) |
| `scripts/baseline-extract.mjs`, `scripts/classify.mjs`, `scripts/elf-probe.mjs`, `scripts/cluster-roots.mjs`, `scripts/first-divergence-probe.mjs`, `scripts/exec-region-and-plt-evidence.mjs` | tooling |

All JSON artifacts are written to a temporary path, re-parsed for schema/count validation, then
atomically renamed (no partially written or failed-producer artifact is published).
