# Phase 3 — First divergence per root-cause cluster

Investigation-only lane. No production code, tests, tools, or `package.json` were modified.

## 0. Stage model and how it was traced

The benchmark subject reads Hex's function list through `product.query.functions(...)`
(`tools/validation/public-benchmark/subject.mjs`), which resolves to
`SymbolIndex.funcs` + `SymbolIndex.nameAt` (`js/analysis/query/app-adapter.js:592`).
`SymbolIndex.funcs` is the canonicalized worker analysis payload `funcs`
(`js/symbols.js:99`), extended by demand-driven discovery
(`js/analysis/demand-driven-runtime.js:472`, `installCancellableFunctionDiscovery`).

So the traced stages are:

```
S1  ELF metadata           sections, symbols, mapping symbols, relocations, unwind
S2  loader/base starts     worker payload `funcs` + `functionProvenance`
                           (BinaryImage.functions canonical seeds, producers.js contract)
S3  discovery              backend.guessFunctions -> region scan -> heuristic starts
S4  SymbolIndex.funcs      canonical start list (+ nameAt for naming)
S5  benchmark function list product.query.functions rows
```

Routing fact established by reading the source: `Backend.guessFunctions`
(`js/backend.js:884`) diverts to the **platform** worker only for non-legacy Mach-O
architectures. **ELF/arm64 uses `this.call('guessFunctions', …)`**, i.e. the classic shipped
worker implementation in `js/worker-legacy.js:1029` plus the overlays
`js/worker-fixes.js` and `js/worker-data-in-code-fix.js`. The generic Phase-7 discovery
producer/artifact pipeline (`js/analysis/discovery/producers.js`, `artifact.js`) is constructed
inside `js/analysis/index.js:290` for the analysis surface and consumed by
`js/rebuild/transaction-v2.js` — it is **not** on the `S2 → S3 → S4` path this benchmark uses.

Focused reproduction (`scripts/first-divergence-probe.mjs`, read-only, reuses the repository's
own `tools/validation/public-benchmark/product-host.mjs`) was run for one representative per
cluster plus a control:

| case | base starts (S2) | final functions (S4) | discovery result |
| --- | ---: | ---: | --- |
| `1/1_clang_O1_g` | 73 | 76 | complete, reasons `[]`, per-region discovered `[0,0,29,0]` |
| `5-1/5-1_clang_O0_g` | 215 | 215 | complete, reasons `[]`, per-region discovered `[0,0,208,0]` |
| `4/4_clang_O1_g` | 78 | 78 | complete, reasons `[]`, per-region discovered `[0,0,46,0]` |

The four scan regions are, in order, `.init`, **`.plt`**, `.text`, `.fini`
(verified in the probe output: `p0_s23:.init@0x860+0x18`, `p0_s24:.plt@0x880+0xa0`,
`p0_s25:.text@0x940+0xf74`, `p0_s26:.fini@0x18b4+0x14`).

## 1. Cluster A — PLT0 resolver stub (160 rows)

**Representative:** `1/1_clang_O1_g`, address `0x880`, `.plt` section start.

| stage | address `0x880` present? | evidence |
| --- | --- | --- |
| S1 | **yes** | `.plt` `PROGBITS` `AX` `0x880 + 0xa0`; `.plt` `SECTION` symbol + `$x` mapping symbol at `0x880`; file-backed code bytes `stp x16,x30,[sp,#-16]!` |
| S2 | **no** | worker payload `funcs` has no `0x880`; `functionProvenance` has no entry |
| S3 | **no** | region `p0_s24` (`.plt`, `exec:true`) was scanned and produced **0** starts |
| S4 | **no** | not in `SymbolIndex.funcs`; nearest preceding start is `0x860` (`_init`) |
| S5 | no | `hexPresent:false` |

- **Expected evidence:** a real callable entry at `0x880` — a `bl`/`b` target, an `STT_FUNC`
  symbol, an FDE, an export, a relocation target, or an init-array entry.
- **Last stage where it exists:** S1 (as a section/mapping marker only).
- **First stage where it is missing:** **S2**.
- **Control that proves it is the seed layer, not the scanner:** the *neighbouring* `.init`
  start `0x860` **is** in S2 (`source:"symbol"`, `confidence:0.995`) — and only because the
  binary carries a real `STT_FUNC` symbol `_init` at `0x860`
  (`readelf -sW`: `179: 0000000000000860 0 FUNC GLOBAL HIDDEN 11 _init`).
  Candidates at `0x880` have *no* `STT_FUNC` symbol. So the divergence is not "the scanner
  rejects `.plt`"; the seed layer simply has nothing to hand it.
- **Relevant source / symbols:**
  - `js/binary/elf-core-original.js:842` — the only ELF function-seed push, gated on
    `type === STT_FUNC || STT_GNU_IFUNC`. Mapping symbols (`STT_NOTYPE`) and `SECTION`
    symbols never seed.
  - `js/binary/elf-aarch64-mapping.js` — consumes `$x`/`$d` mapping symbols but **only** to
    publish `metadata.aarch64MappingSymbols` and to *filter* existing seeds via
    `image.addDataInCodeEntry` / `image.isDataInCode`; it never adds a start.
  - `js/analysis/discovery/producers.js` — `symbolTableProducer` skips any symbol whose
    `kind` is not `function`/`indirect-function`; `referenceProducer` needs
    `image.relocationTargets` / `vtableEntries` / `exceptionMetadata`.
  - `js/worker-legacy.js:1029` `guessFunctions` — starts come from (a) `bl` targets,
    (b) windows opened after `ret` / direct `b` / indirect `br` / trap, (c) prologue-shaped
    instructions after an end marker, (d) Mach-O metadata tables. None of these can fire on a
    region's **first** instruction, and `.plt` contains no `ret`, no `b`, no `bl`.
  - Search result: **`grep -rn '\bplt\b' js/ --include=*.js` returns 0 matches.** Hex has no
    PLT model at all — no PLT thunk naming, no PLT0 seeding, and no PLT-specific exclusion.
- **Intentional?** There is no explicit rejection of `.plt` anywhere, so this is *unmodelled*,
  not *deliberately excluded*. Declining to call the PLT0 resolver stub a function is a
  defensible product choice (IDA's own name for it is `sub_880`, i.e. it had no identity
  either). What is **not** defensible is the second-order fact below.
- **Second-order defect (confirmed):** the omission is **silent**. `functionStartsComplete`
  and `functionDiscovery.complete` are `true`, `reasons: []`, for every traced case while the
  `.plt` start is absent. `elf-aarch64-mapping.js` *does* have a `markPartial(...)` mechanism
  and does mark other conditions partial; nothing marks "an executable region produced zero
  starts". So Hex reports a complete, exact start set that omits a start the reference tool
  reports.
- **Generalized fix surface (not benchmark-specific):**
  1. a *generic* producer for an executable region's **first** instruction when it decodes to
     a real instruction and is not covered by any symbol extent (this is not PLT-specific —
     it also covers any bare hand-written/`--section-start` code region); and/or
  2. make `functionStartsComplete` (and `functionDiscovery.reasons`) reflect "executable region
     produced no seed and no discovered start" so the gap is not silent.
  Both live in the S2/S3 layer, not in a benchmark-specific path.

## 2. Cluster B — IDA tail split after an inferred-noreturn call (10 rows)

**Representative:** `5-1/5-1_clang_O0_g`, address `0x2b50` (and `0x2bac`).

| stage | `0x2b50` present? | evidence |
| --- | --- | --- |
| S1 | as code inside `_Z20test_cpp_oo_featuresv` `[0x2a84,0x2b90)`; no symbol, no FDE, no branch target | relocation `R_AARCH64_RELATIVE` at `.data.rel.ro` does **not** reference it |
| S2 | **no** separate start (S2 carries `0x2a84` for the whole symbol) | `baseLayerStartPresent:false` |
| S3 | **no** | `.text` scanned, 208 starts found, this is not one |
| S4 | **no** | `inFinalSymbolIndex:false`, enclosing start `0x2a84` |
| S5 | no | `hexPresent:false` |

- **Expected evidence:** a function boundary at `0x2b50`. The only proffered evidence is IDA's
  inference that the preceding `bl 0x2404` (`_Z18test_cpp_exceptionv`) never returns.
- **Last stage where it exists:** S1, only as an interior byte offset of the enclosing symbol.
- **First stage where it is missing:** **S3** — the discovery layer is the first stage that
  *could* have created the start, and the pipeline even contains a producer for exactly this
  shape.
- **Relevant source / symbols:**
  - `js/worker-legacy.js:1199-1201`:
    `if (prevWasNoreturnCall && looksLikePrologue(w)) { if (reserveAux()) postNoreturn.push(pc); }`
  - `js/worker-legacy.js:1225`: `prevWasNoreturnCall = callTarget != null && noreturnTargets.has(callTarget)`
  - `js/worker-legacy.js:653`: `NORETURN_NAME = /(?:^|_)(?:stack_chk_fail|objc_exception_throw|abort|assert_rtn|cxa_throw|terminate|swift_.*fatal|swift_.*trap|fatalError)(?:$|@)/i`
  - `js/worker-legacy.js:654-657`: `slice.noreturnTargets` is built **only** from that name
    regex over the symbol/entry list.
  - `js/words.js:604` `looksLikePrologue` accepts only `stp …,[sp,#-N]!`, `sub sp,sp,#imm`,
    `bti`, `paciasp`/`pacibsp`.
- **Why it fires for IDA and not for Hex — two independent gates, both closing:**
  1. `_Z18test_cpp_exceptionv` / `_Z20test_cpp_oo_featuresv` are *internal* functions whose
     noreturn-ness is only knowable by **interprocedural inference**. They do not match
     `NORETURN_NAME`, so `noreturnTargets` never contains them →
     `prevWasNoreturnCall` is always `false` → `postNoreturn` is never populated.
  2. Even if it were populated, the continuation words are `mov w1, w0` (`0x2b50`) and
     `ldr w0, [sp, #8]` (`0x2bac`), which `looksLikePrologue` rejects, so the candidate
     would still be dropped.
- **Hex already has the missing knowledge elsewhere:** an interprocedural noreturn lattice
  exists in the semantic layer — `js/analysis/summary/interprocedural.js`
  (`noreturn` is a must-property joined across callees) and
  `js/analysis/semantic-function-base.js:275` (`prototypeNoreturnState`). Discovery does not
  consume it; discovery uses the name-regex allowlist only.
- **Intentional?** Deliberate conservatism. The comment on line 650-652 says the rule is
  deliberately restricted to *known* noreturn names, and the prologue gate is a deliberate
  precision guard. It is not a targeted exclusion of this benchmark.
- **Is Hex wrong?** No. The ELF symbol table declares one function `[0x2a84,0x2b90)`; IDA split
  it and its own output says `// positive sp value has been detected, the output may be wrong!`
  and renders `sub_2B50(unsigned int a1)` as consuming the previous call's `w0`. Hex's reading
  is the more faithful one. **This cluster should not be "fixed" for correctness.** It is a
  reference-convention divergence.
- **Generalized fix surface (only if the convention is judged worth matching):** let discovery
  consume the existing semantic noreturn summary (or an interprocedurally-derived noreturn set)
  as a *corroborating* post-call boundary, with an explicit region-precision guard, instead of
  the fixed name allowlist. This is generic (any ELF/Mach-O binary with a noreturn leaf), not
  CodeFuse-specific.

## 3. Cluster C — address-taken switch-case body (2 rows)

**Representative:** `1/1_clang_O1_g` / `1/1_clang_O1_no_g`, address `0x174c`.

| stage | `0x174c` present? | evidence |
| --- | --- | --- |
| S1 | as code inside `computed_goto` `[0x172c,0x176c)`; **is** an `R_AARCH64_RELATIVE` addend at `.data.rel.ro 0x12db8` | no symbol, no FDE, no `bl`/`b` target |
| S2 | **no** separate start | `baseLayerStartPresent:false` |
| S3 | **no** — but its three siblings `0x1754`/`0x175c`/`0x1764` **are** created here | `.text` scanned |
| S4 | **no** | `inFinalSymbolIndex:false`, enclosing start `0x172c` |
| S5 | no | `hexPresent:false` while `0x1754/0x175c/0x1764` are `hexPresent:true` |

- **Expected evidence:** address-taken through a switch table — the `.data.rel.ro` entry
  `0x12db8 R_AARCH64_RELATIVE -> 0x174c` (the `ldr x8,[x8,w1,sxtw #3]; br x8` dispatch at
  `0x1744`/`0x1748` loads exactly that table).
- **Last stage where it exists:** S1 (as a relocation addend).
- **First stage where it is missing:** **S3**.
- **Relevant source / symbols:**
  - `js/worker-legacy.js` `postIndirectBranch` windows open for the instruction following an
    indirect `br` (line ~1185). The acceptance loop for them narrows to three shapes:
    `directTargetSafeMemArgs` (LOAD prefix), `virtualDispatchPrefix` (LOAD/`ldp` prefix),
    `globalDispatchPrefix` (ADRP prefix), or the candidate itself being an unconditional `b`
    with a plausible next kind. The candidate here is `mov w0, wzr` = `MOVIMM`, which fails
    every branch, so it is dropped at `if (c.kind !== Words.KIND.BRANCH …) continue;`.
  - Its siblings at `0x1754/0x175c/0x1764` follow a `ret`, so they open `postRet` windows and
    are accepted by `POST_RET_START_PAIRS` (`Words.KIND.MOVIMM + ':' + Words.KIND.RET`) and by
    the explicit `if (c.kind === MOVIMM && c.nextKind === RET) strong = true;` rule.
    **The asymmetry is exactly "post-RET windows accept `mov imm; ret` leaves; post-indirect-BR
    windows do not."**
  - The generic discovery layer *does* have a relocation-target producer —
    `js/analysis/discovery/producers.js:302` (`referenceProducer`, kind `relocation-target`)
    and `js/analysis/discovery/artifact.js:795` normalizes `image.relocationTargets` — but
    (i) that pipeline is not on the ELF/arm64 `guessFunctions` route, and
    (ii) `grep -rn 'relocationTargets' js/binary/*.js` returns **0 hits**, i.e. no ELF loader
    publishes `image.relocationTargets` at all. So the evidence that identifies this case is
    computed by neither layer.
- **Intentional?** Yes, deliberately narrowed. The comment before the loop states the reason:
  *"Do not accept every indirect-branch fallthrough: switch tables also use `br`."* The rule is
  a precision guard against exactly this construct.
- **Is Hex wrong?** Not clearly. Keeping the case bodies inside `computed_goto` matches the ELF
  symbol table (`computed_goto` `st_size = 64` covers them), so Hex is defensible; IDA's
  per-case-body split is also defensible. Confidence `probable`, not `confirmed`.
- **Corroborating in-repo counter-evidence that the capability exists:** in
  `1/1_clang_O2/O3/Os` Hex reports 20–23 **more** starts than IDA, all exactly the
  `R_AARCH64_RELATIVE` addends of the same `.data.rel.ro` function-pointer tables
  (`op_add 0x1640`, `op_sub 0x1648`, …), which are real `FUNC` `LOCAL` symbols in those
  binaries. So the two tools disagree on the *same construct* in both directions depending on
  which layer's evidence wins (symbol seed vs dispatch analysis), and Hex's side in the O2
  cases is the symbol-table-faithful one.
- **Generalized fix surface (only if the convention is judged worth matching):** a generic
  address-taken fallback for post-indirect-branch case bodies keyed on a relocation-table
  entry (not on any address/name from this benchmark), ideally by publishing ELF
  `relocationTargets` in the loader and letting the existing `referenceProducer`
  corroborate. This is generic C/C++ switch-table behaviour, not CodeFuse-specific.

## 4. Summary table

| cluster | rows | exists at S1 | last stage present | first stage missing | Hex's behaviour intentional | Hex "wrong"? |
| --- | ---: | --- | --- | --- | --- | --- |
| A — `.plt` resolver stub | 160 | yes (section/mapping marker) | S1 | **S2** (no seed) then S3 (0 starts) | unmodelled, not excluded | no (but omission is silent) |
| B — noreturn tail split | 10 | yes (interior bytes) | S1 | **S3** | yes (name allowlist + prologue gate) | no — IDA artifact |
| C — address-taken case body | 2 | yes (relocation addend) | S1 | **S3** | yes (deliberate narrowing) | not clearly |

**No cluster is a "Hex failed to notice a real, symbol-attested function" case.** All 172 rows
lack an `STT_FUNC` symbol, an entrypoint role, an FDE, and any `bl`/`b` reference. The three
divergences are (i) an unmodelled linker stub plus a silent completeness signal, (ii) and (iii)
deliberately narrow boundary rules that disagree with IDA's inference convention.

## 5. Fix-candidate revision (report-only review pass, post-dates §1-§4)

This section is **additive**: the traces, cluster assignments and confidence levels above are
unchanged, and the 172-row classification data was not re-derived. A later report-only review
revised only the *production fix candidates*:

| original candidate | disposition | reason (summary) |
| --- | --- | --- |
| A1 "0 starts in a non-empty executable region ⇒ `complete=false`" | **withdrawn** → A1′ coverage accounting | 640/640 executable regions contain bytes no `STT_FUNC` extent covers; the rule measures symbol provenance, not code, and silently redefines `complete` from a truncation claim into a coverage claim |
| A2 "first instruction of any executable region ⇒ generic seed" | **withdrawn** → A2′ PLT-structural stub start | region boundary ≠ function boundary; "+1 per binary" is a count target, and IDA's own object there is `sub_6D0() { JUMPOUT(0); }` while IDA models none of the import thunks |
| B1 "discovery reads the interprocedural noreturn summary" | **removed from candidates** → B1a downstream refinement (design-gated) | phase cycle: the summary is built from the entity/call-graph model that is built from discovery's start set (`js/app.js:829` before the program scan, `js/analysis/index.js:290`) |
| C1 "publish ELF relocation targets" | **kept, narrowed** to corroboration-only | an `R_AARCH64_RELATIVE` addend also denotes jump-table bases, case bodies and data addresses; Hex is *right* in `1/1_clang_O2/O3/Os` precisely because the symbol layer outranks it |

Cluster A's *confirmed observation* is unchanged — the `.plt` omission is silent
(`functionStartsComplete = true`, `functionDiscovery.reasons = []`). Only its remedy moved from
"change `complete`" to "report unclassified executable bytes".

Full analysis, measurements, and revised fixtures: **`03-fix-candidate-review.md`** (evidence in
`exec-region-and-plt-evidence.json`).

## 6. Artifacts

| file | contents |
| --- | --- |
| `root-cause-clusters.json` | machine-readable per-cluster trace, source anchors, intentionality, fix surface, and the `fixCandidateReview` block |
| `03-fix-candidate-review.md`, `exec-region-and-plt-evidence.json` | fix-candidate review (executable-region taxonomy, ELF PLT model, cycle analysis) |
| `scripts/first-divergence-probe.mjs`, `scripts/exec-region-and-plt-evidence.mjs` | focused read-only stage-by-stage probe (reuses the repository's own product host) and the ELF evidence probe |
| `01-classification.md`, `classification.json` | Phase 2 evidence classification |
| `00-baseline.md`, `ida-only-functions.json` | Phase 1 baseline |
