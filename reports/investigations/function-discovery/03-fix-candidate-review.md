# Phase 5 — Fix-candidate review (REPORT ONLY)

**Scope of this pass:** re-derive the production *fix candidates* only. No production code, tests,
`tools/`, or `package.json` were touched (`git diff --stat` over the branch: report directory only).
The 172-row classification, the cluster assignment, and the first-divergence traces are **not**
revised here — no evidence in this pass contradicts them, so none of that data was edited.

The review asked four specific questions:

| # | question | verdict |
| --- | --- | --- |
| A1 | is "non-empty executable region with 0 starts ⇒ `complete=false`" a sound general rule? | **no — candidate withdrawn, replaced** |
| A2 | is "first instruction of every executable region ⇒ generic seed" sound? | **no — candidate withdrawn, replaced** |
| B1 | does "discovery reads the interprocedural noreturn summary" create a phase cycle? | **yes — removed from fix candidates, re-framed as downstream refinement (design-gated)** |
| C1 | may relocation targets be published as function starts? | **corroborating evidence only, never a start authority** |

Evidence for this pass (all read-only, all 160 binaries, no external downloads, no network):

| artifact | content |
| --- | --- |
| `exec-region-and-plt-evidence.json` (`scripts/exec-region-and-plt-evidence.mjs`) | executable-region taxonomy, coverage accounting, and the ELF dynamic-structure PLT model — 160/160 binaries |
| `benchmarks/public/codefuse-arm64/inputs/*.bin` | self-contained ELF64 reader in the probe script (no `readelf`/`llvm-*` dependency, no shell-outs) |
| `benchmarks/public/codefuse-arm64/reference/**` | IDA oracle, to test whether IDA's own model is a *function* model for the disputed bytes |

---

## 1. Q1 — taxonomy of ELF executable regions (measured, all 160 binaries)

| measurement | value |
| --- | ---: |
| binaries | 160 |
| distinct executable section names | exactly `.init`, `.plt`, `.text`, `.fini` (160 each) |
| executable regions outside `{.init,.plt,.text,.fini}` | **0** |
| executable sections | 640 |
| … with ≥1 `STT_FUNC` symbol inside | 480 |
| … with **0** `STT_FUNC` symbols inside | 160 = exactly the `.plt` of each binary |

Byte-level coverage (union of `STT_FUNC` extents of size > 0, clipped to executable regions):

| metric | bytes |
| --- | ---: |
| executable bytes | 889,944 |
| covered by a `STT_FUNC` extent | 785,656 (88.3 %) |
| **uncovered** | **104,288 (11.7 %)** |
| uncovered in `.plt` | 53,056 |
| uncovered in `.text` | 44,192 |
| uncovered in `.init` | 3,840 |
| uncovered in `.fini` | 3,200 |
| executable sections containing uncovered bytes | **640 / 640** |

Taxonomy of "executable bytes with no function start" in this corpus:

| id | class | present here | evidence |
| --- | --- | --- | --- |
| **R1** | linker-generated stub table (PLT resolver slot + import thunks) | yes, 160/160 | §2 |
| **R2** | real function with no symbol (hand-written / symbol-stripped entry code) | not observed | `.init`/`.fini` both carry their `STT_FUNC` symbol here (`funcs=1`) |
| **R3** | alignment / inter-function padding | yes | `.text` 44,192 uncovered bytes with no start of their own |
| **R4** | veneer/thunk pool (`b`-only trampolines) | not observed | no extra AX section |
| **R5** | data inside an `AX` region (e.g. `.init_array` marked AX) | not observed | 0 executable sections outside the four names |
| **R6** | non-code bytes inside a stub slot | yes | the resolver slot is 32 bytes but only 20 bytes are instructions |

**Conclusion for A1:** even in a corpus whose linker always emits a PLT, "0 starts" is *not*
coincident with "no function and no model": `.text`/`.init`/`.fini` all contain uncovered
executable bytes (R3, R6) and `.init`/`.fini` are executable regions whose *only* start is a
symbol that a different toolchain need not emit. Any rule keyed on "region has 0 starts" is a
rule about *symbol provenance*, not about *code*.

## 2. Q2 — an ELF evidence model for the PLT, without section names

Model asserted and verified for all 160 binaries, using **only** `PT_DYNAMIC`/`.dynamic` tags and
the relocation tables (`DT_PLTGOT`, `DT_JMPREL`, `DT_PLTRELSZ`, `DT_PLTREL`, `R_AARCH64_JUMP_SLOT`
entries with their `r_offset`):

| predicate | result |
| --- | ---: |
| PLT identified from dynamic structures | 160 / 160 |
| `size == 16 * (jumpSlots + 1)` with a 32-byte slot 0 | 160 / 160 |
| slot 0 decodes as the AAELF64 resolver stub (`stp x16,x30,[sp,#-16]!` + `adrp x16` / `ldr x17,[x16,#o]` / `add x16,x16,#o` / `br x17`) | 160 / 160 |
| slot 0 materialises `&GOT[2] == DT_PLTGOT + 16` (and `add` target == `ldr` source) | 160 / 160 |
| slot 0's materialised address is **not** any jump-slot `r_offset` | 160 / 160 |
| slot *k* (k ≥ 1) encodes exactly `.rela.plt[k-1].r_offset` | 2996 / 2996, **in order** |

Properties that make this a *structural model* rather than a heuristic:

1. it is anchored on the dynamic table and the relocation table — both survive `strip`; no
   `sh_name`, `sh_type`, section index or symbol table is consulted;
2. it is **discriminative**: slot 0 is separated from slots 1..n by "materialises a GOT slot that
   is not an import", and the thunks by "materialises exactly an import's GOT slot";
3. failure mode is safe: a binary whose layout does not match yields "no stub region identified",
   never a wrong start;
4. the 32-byte resolver slot / 16-byte thunk stride is the AAELF64 + GNU ld/lld AArch64 layout,
   and it is *corroborated* (not assumed) by the size identity and by the ordering check above.

Toolchain-independence caveat stated honestly: the model recognises *the PLT construct*, not
"any executable stub". Other stub generators (`.plt.sec`/IBT variants, `-z now` layouts, veneer
pools, `--section-start` hand-written regions) are **not** covered by it; for those the model is
silent, which is why it is the right shape for a fix that must not manufacture starts.

## 3. Is IDA's object a function? (oracle check before designing anything)

`reference/2/2_gcc_O0_g.c` (a `.plt`-affected case) contains 69 functions. In the `.plt` range
there is exactly **one**:

```
/* Function: sub_6D0 @ 0x6D0 */
void sub_6D0() { JUMPOUT(0); }
```

The 7 import thunks of that binary (`0x6F0`, `0x700`, …) appear nowhere in IDA's function list —
no library-import-named functions exist in the file at all. So IDA's model of the same bytes is:
*one* object at the region start whose body is an unresolvable indirect branch, plus n table
entries it does not model as functions at all.

That matters for the review in two directions:

- it removes the "IDA says so" justification for a per-*slot* fix (IDA does not model the thunks
  either), and
- it identifies IDA's `sub_6D0` as the product of "decode from the region start until an indirect
  branch" — a code-vs-data heuristic with a degenerate body, not evidence of a function.

## 4. A1 — withdrawn and replaced

### 4.1 Why the original candidate is unsound

Original wording: *a non-empty executable region that yields 0 starts must not report
`complete: true`*.

| objection | evidence |
| --- | --- |
| "0 starts" is not "no function" | `.init`/`.fini` are executable regions whose only start is an `STT_FUNC` symbol; a different linker need not emit it (R2). The rule then measures symbol provenance. |
| it fires on legitimate padding | 640/640 executable sections contain uncovered bytes; `.text` alone has 44,192 (R3). Each of those bytes would have to become a start or a permanent "incomplete". |
| it assumes region boundary == function boundary | the region start happens to be a stub base in `.plt`, but `.text` may begin mid-fragment, and `.plt` slot 0 is 32 bytes of which only 20 are instructions (R6). |
| it makes `complete` mean two different things | today `complete = !capped`, i.e. a *truncation* claim (`js/worker-legacy.js:1509`, `:1512-1516`). Re-defining it as a coverage claim would silently change every consumer, including the `functionStartsComplete === true` cache gate (`js/app.js:784`) and the `function-discovery-incomplete` truncation reason (`js/app.js:146-147`). |

### 4.2 Replacement — A1′: separate completeness from coverage

Keep the existing contract and *add* an accounting record:

- `complete` stays **exactly** what it is now: "the producer was not truncated by cap/budget".
  No production change to that derivation.
- add `discovery.coverage = { executableBytes, attributedBytes, unclassified: [{start,end,class}] }`
  where `class ∈ {stub-table(R1), function-without-symbol(R2), padding(R3), veneer-pool(R4),
  data-in-executable-region(R5), slot-padding(R6), unknown}`.
- the honesty signal consumers need is then `coverage.unclassified.filter(unknown).length`, not a
  mutated `complete`.
- a range is classed `padding` only on positive evidence (all-zero words / `nop`
  `0xd503201f` / a decodable alignment filler), never on "no start here" — this is what stops the
  rule from firing on `.text`/`.init`/`.fini` (R3/R6).
- blast radius: additive fields only; consumers that read only `complete` are unaffected, so the
  change cannot regress the honesty of the existing signal, and the *silent* `.plt` omission is
  fixed at the reporting layer instead of by inventing a function.

Confirmed observation that survives this revision (unchanged from the root-cause report): the
`.plt` omission is **silent** — `functionStartsComplete = true` with `functionDiscovery.reasons = []`
while an executable region produced 0 starts. What changes is the *remedy*: report it in a coverage
record (A1′), do not redefine `complete`.

## 5. A2 — withdrawn and replaced

### 5.1 Why the original candidate is unsound

Original wording: *emit a start for the first instruction of an executable region when it decodes
and no symbol covers it.*

| objection | evidence |
| --- | --- |
| "region boundary == function boundary" is an assumption, and a false one in general | R2/R3/R5/R6; the model in §2 needs dynamic evidence precisely because the section boundary is not a stub boundary |
| it is degree-of-freedom-driven, not evidence-driven | "one more function per binary with a `.plt`" is a *count* target. The instruction is explicit that the change must not become "IDA-parity +1"; §3 shows the parity target itself is a heuristic artifact |
| it generalises to regions where no stub exists | `.init_array` marked AX, veneer pools, `.text` sections starting mid-fragment — a generic rule would seed all of them |

### 5.2 Replacement — A2′: stub-table realisation gated on the §2 model

- Emit **at most one** synthetic start per dynamically-identified PLT: the resolver-slot base,
  i.e. the address of the `stp x16,x30,[sp,#-16]!` the dynamic model matched. Provenance tag
  `elf-plt-structure`, low confidence, kind `stub` (explicitly not offered as a decompilable
  function body).
- Emit **no** starts for the import thunks. They are R1 table entries: they belong in
  `coverage` (A1′) and in *naming* (their import name is recoverable from `.rela.plt` +
  `.dynsym`, which is the actually useful information), not in the start set.
- The address must come from the dynamic-table anchor, **never** from `region.start`. Since the
  recogniser is keyed on `DT_PLTGOT`/`DT_JMPREL`/jump-slot structure, it cannot fire on `.text`,
  `.init_array`, or a veneer pool, so the failure mode of A2 is "nothing added".
- Determinism / offline: pure binary parsing, no network, no external tools, no per-case or
  per-name special case; works on stripped binaries.
- A1′ is a prerequisite in the sense of *sequencing*, not correctness: A2′ alone adds ≤1 start per
  binary while the unclassified coverage record would still list the rest of the region. Shipping
  A2′ without A1′ is acceptable but leaves the underlying silence unaddressed.

Explicit non-goal recorded for the repair lane: **no production constant, name, address or
threshold may be derived from the public benchmark's expected values or from IDA's output.**

## 6. B1 — cycle analysis, and why it is no longer a fix candidate

### 6.1 Call/phase order observed in the code

| step | anchor |
| --- | --- |
| `ensureProgram` calls discovery **before** the program scan | `js/app.js:829` (`await this.ensureFunctions(primary,progressFn)`) |
| discovery itself (classic shipped worker for ELF/arm64) | `js/worker-legacy.js:1029` |
| discovery's current noreturn signal = fixed name regex over import entries, built at **slice load** | `js/worker-legacy.js:653-656` |
| the post-noreturn producer and both of its gates | `js/worker-legacy.js:1202`, `:1225`, `:1466` |
| the generic Phase-7 discovery artifact, built from the entity model | `js/analysis/index.js:290` (`createDiscoveryArtifact`) |
| the interprocedural noreturn summary (the knowledge B1 wants) | `js/analysis/summary/interprocedural.js:49` (analyzer id), `:1152` (noreturn join) |
| the cached-completeness gate that would serve a stale index | `js/app.js:784` |

### 6.2 Verdict

The interprocedural noreturn summary is computed from the entity/call-graph model that is built
**from** the start set discovery produces. Making discovery read that summary yields
`discovery → entity/call graph → interprocedural summary → discovery`: a real phase cycle, and a
self-referential one (the summary's call graph is derived from the very starts whose boundaries it
would then change). **B1 as written is therefore removed from the fix-candidate list.**

There is no cycle-free *in-discovery* variant: the 10 affected rows are calls to **locally defined**
noreturn helpers, so no dynamic-metadata (import/`DT_NEEDED`) path can reach them — that is exactly
why the current fixed-name allowlist misses them.

Cycle-free reformulation, recorded as **design-gated** rather than recommended:

- **B1a — downstream refinement (additive-only).** After the interprocedural summary exists, a
  pass proposes boundary starts at post-`noreturn`-call continuations and merges them into the
  symbol index. Constraints taken from the code, all mandatory:
  1. it must invalidate `symbols.functionStartsComplete` / `symbols.functionDiscovery`, otherwise
     `js/app.js:784` keeps serving the pre-refinement index from cache;
  2. it must be append-only (never move or delete an existing start): existing extents feed
     `AddressProvenance`, `ProgramIndex`, and `analysis/query`;
  3. it must be idempotent and epoch-guarded, like `ensureFunctions`;
  4. because a split *re-entityises* an existing function, it should go through the
     rebuild/transaction path (`js/rebuild/transaction-v2.js`) rather than mutating the index in
     place — otherwise consumers that already resolved an address to the enclosing function keep
     the pre-split answer.
- **B1b — convention change without semantics.** Not available (see above).

Status: cluster **B**'s root cause stays *confirmed* (both gates close for the 10 rows); only the
fix candidate is reclassified — from "recommended" to "unknown / needs design" until the refinement
path in B1a is designed and its cache-invalidation contract is settled. Note also that IDA's own
output annotates these splits as suspect (`// positive sp value has been detected, the output may be
wrong!`), so the value of matching them is a convention question, not a correctness one.

## 7. C1 — relocation targets as corroboration only

Kept in the candidate list, with the semantics narrowed:

- publish ELF relocation targets from the loader with an explicit provenance tag
  (`elf-relocation-target`), so the existing generic evidence/discovery path can *corroborate* a
  candidate;
- **relocation targets are never a start authority**. An `R_AARCH64_RELATIVE` addend is a
  pointer-typed data word; in these binaries the same relocation kind produces jump-table bases,
  jump-table *case* bodies, and `.data`/`.rodata` addresses. Promoting it to "function start"
  would raise the *Hex-only* direction of the comparison (the 148 rows) while "fixing" the IDA-only
  direction — the exact trade the benchmark's second column makes visible;
- the corpus already contains the counter-evidence in the same suite: in `1/1_clang_O2/O3/Os` Hex
  reports 20-23 **more** starts than IDA, and every extra start is an `R_AARCH64_RELATIVE` addend
  that is also a real `FUNC LOCAL` symbol. Hex gets that right because the symbol layer wins over
  the heuristic. A1′/C1 must not invert that ordering.

Rationale for still keeping C1: today `grep -rn relocationTargets js/binary/*.js` → 0 hits, so the
ELF route cannot use the generic `referenceProducer` at all. Publishing the evidence (with the
corroboration-only contract) is a prerequisite for ever moving ELF off the classic worker onto the
Phase-7 discovery artifact — that is its real value.

## 8. Completeness vs. function-start production (the separation being asked for)

Two contracts that must not be collapsed into one boolean:

| contract | question it answers | allowed to depend on |
| --- | --- | --- |
| **start production** | which addresses are functions, on the evidence available | loader metadata, dynamic/relocation structures, code shape |
| **completeness / coverage honesty** | was the producer truncated, and what executable code has no explanation | producer budget only (truncation) / byte accounting (coverage) |

Current state: one boolean `complete = !capped` is emitted as a truncation claim
(`js/worker-legacy.js:1509`) but *consumed* as if it were a coverage claim — the cache gate
(`js/app.js:784`) and the `function-discovery-incomplete` truncation reason (`js/app.js:146-147`).
The remedy in this review is deliberately asymmetric:

- A1′ fixes *honesty* by adding coverage accounting and leaves `complete` alone;
- A2′ fixes *production* by adding ≤1 evidence-backed stub per dynamically-identified PLT;
- neither is allowed to be justified by a change in the benchmark's matched counts, and a production
  consumer must not treat `complete: true` as "the function list is the whole truth".

## 9. Revised candidate table

| id | status | change from the root-cause report | gate |
| --- | --- | --- | --- |
| **A1′** coverage accounting (replaces A1) | **recommended** | general rule withdrawn; additive coverage record instead of redefining `complete` | none (additive) |
| **A2′** PLT structural stub start (replaces A2) | **recommended, gated on the §2 model** | region-start seed withdrawn; ≤1 start per dynamically-identified PLT, thunks not seeded; paired with A1′ | recognition must be dynamic-structure-only (works stripped) |
| **B1** discovery reads the semantic noreturn summary | **removed** | phase cycle; re-framed as B1a downstream refinement | design: cache invalidation + append-only + re-entityisation path |
| **B1a** downstream refinement pass | **design-gated, not recommended yet** | new | as above; must not be scheduled before its contract is fixed |
| **C1** ELF `relocationTargets` publication | **kept, corroboration-only** | narrowed semantics: never a start authority | must not reorder symbol-vs-heuristic precedence |
| — | **confirmed defect, unchanged** | the `.plt` omission is *silent* (`complete:true`, `reasons:[]`) | A1′ addresses the reporting half |

Blast-radius summary (revised):

| candidate | surfaces touched | user-visible effect |
| --- | --- | --- |
| A1′ | new coverage fields on the discovery result + whatever renders completeness | new "unclassified executable bytes" information; `complete` unchanged |
| A2′ | ELF seed layer / stub naming for dynamically-identified PLTs | ≤1 stub entry per dynamically-linked AArch64 ELF; no effect on `.text`/`.init_array`/veneers |
| B1a | symbol index post-processing + rebuild/transaction path | deferred; would change where starts are drawn inside already-recognised functions |
| C1 | loader evidence publication (ELF relocations) | enables generic corroboration; no start set change on its own |

## 10. Revised regression fixtures

1. **(A1′)** synthetic ELF with `.text` padding + fully-symbolised functions: assert `complete`
   is unchanged and coverage positively classes padding (R3) — i.e. the fixture must *fail* if a
   "0 starts ⇒ incomplete" rule is reintroduced.
2. **(A1′/A2′)** linked dynamic AArch64 fixture: assert exactly one synthetic `stub` start at the
   dynamically-derived PLT resolver address, **zero** starts for the import thunks, and thunk-table
   + slot-padding classes in coverage.
3. **(A2′ negative)** executable region with no PLT (hand-assembled `.text`, `.init_array` marked
   AX): assert **no** synthetic start is added. This is the guard against region-start seeding
   coming back under another name.
4. **(A2′ portability)** the same fixture built with `-z now` / a non-default PLT layout: assert the
   model yields "no stub identified" rather than a wrong start.
5. **(C1)** fixture where an `R_AARCH64_RELATIVE` addend points at a string/table base: assert the
   relocation target alone never creates a start, and that symbol evidence still outranks it.
6. **(B1a, when designed)** idempotence + cache-invalidation test: the refinement must invalidate
   `functionStartsComplete` and produce the same result when run twice.
7. **(methodology guard)** a check that no production constant/path references the public
   benchmark's expected counts or the IDA reference output.

No fixture may reference a benchmark case id, function name, or address.
