# Phase 2 — Evidence classification of all 172 IDA-only functions

Investigation-only lane. No production code, tests, tools, or `package.json` were modified.

Method: `scripts/classify.mjs` gathers independent evidence per address from the
**binary itself** (self-contained ELF64 parser plus an AArch64 static scan — no optional
host tooling required) and from the **published IDA Hex-Rays reference artifact**
(`benchmarks/public/codefuse-arm64/reference/<case>.c`, which is IDA's own function list).

Evidence gathered per address:

- containing section, section flags (W/A/X), whether the address is the section start
- exact symbol-table entries (name / type / binding / size) and mapping symbol (`$x`/`$d`)
- enclosing `STT_FUNC` symbol (name / span) — i.e. whether the address is *interior*
- entrypoint equality, `.plt` / `.init` / `.fini` region membership
- executable code bytes present at the address
- previous-instruction class (`bl` / `b` / other) and its target
- whether any `BL`/`B` in the image targets the address (call-target evidence)
- `ADRP+ADD` / `ADR` address materialization in code
- presence in an `R_AARCH64_RELATIVE` relocation addend (address-taken table evidence)
- `.eh_frame_hdr` FDE starts (unwind evidence): exact FDE at the address, nearest FDE ≤ address
- from the IDA reference: function header present, name, auto-`sub_XXXX` naming,
  `__noreturn` annotation, and IDA's own "positive sp value has been detected" self-doubt warning

## 1. Result

**172 / 172 classified, 0 unknown.**

| cluster | rows | cases | distinct addrs | confidence | section |
| --- | --- | ---: | ---: | --- | --- |
| `ida_synthetic_plt_resolver_stub` | 160 | 160 | 28 | confirmed | `.plt` |
| `ida_noreturn_split_of_enclosing_function` | 10 | 5 | 10 | confirmed | `.text` |
| `ida_address_taken_table_target_split` | 2 | 2 | 1 | probable | `.text` |

## 2. Suite-wide evidence rollup (all 172 rows)

| fact | result |
| --- | --- |
| address is exactly the start of its section | 160 / 172 (all `.plt`) |
| mapping symbol at the address | `$x` for 160 / 172, none for 12 |
| an exact `STT_FUNC` symbol exists at the address | **0 / 172** |
| address equals the image entrypoint | **0 / 172** |
| any `BL` or `B` in the image targets the address | **0 / 172** |
| an FDE starts exactly at the address (`.eh_frame_hdr`) | **0 / 172** |
| `R_AARCH64_RELATIVE` addend equals the address | 2 / 172 |
| IDA reference has a function header at the address | 172 / 172 |
| IDA reference name is an auto-generated `sub_XXXX` (no real symbol name) | **172 / 172** |
| IDA reference emits its own "positive sp value has been detected" warning | 10 / 172 |

Two suite-wide facts already exclude the obvious hypotheses:

- **Not a call-target discovery miss.** No `bl`/`b` in any of the 160 binaries targets any of the
  172 addresses, so a missed `bl`-target producer cannot be the cause.
- **Not a symbol-seed rejection.** No address carries an `STT_FUNC` symbol, so no
  symbol-table-start path could have produced it; and **not one of the 172 IDA names is a real
  function name** — IDA itself had no name for any of them.

## 3. Cluster A — `ida_synthetic_plt_resolver_stub` (160 rows, 160 cases, confirmed)

**Signature:** the address is exactly the first byte of the `.plt` section. The only symbols at
that address are the `.plt` `SECTION` symbol and the AAELF64 mapping symbol `$x`. 28 distinct
addresses across 160 binaries.

**Why the two tools disagree, from evidence:**

- the `.plt` stub at offset 0 is the *dynamic-linker resolver stub* (PLT0), not a
  function-pointer thunk: `stp x16,x30,[sp,#-16]!` / `adrp x16,…` / `ldr x17,[x16,#…]` /
  `add x16,x16,#…` / `br x17`;
- individual PLT thunks are **not** in the IDA function list either — the IDA reference for
  `1/1_clang_O1_g` contains exactly one function in the whole `[0x880,0x940)` `.plt` range,
  `sub_880` at the section start, and no entries at the thunk addresses;
- so the disagreement is narrowed to exactly one object: **IDA declares the PLT0 resolver stub
  a function; Hex declares nothing there**;
- Hex's final function list contains mapping-symbol-derived entries elsewhere (`.init`,
  `.fini`) and does contain the `.init` start, but nothing at all in `.plt` — see Phase 3 for
  the mechanism (`.init` is seeded by the `_init` `STT_FUNC` symbol, not by mapping symbols).

**Representative addresses:** `0x620`, `0x640`, `0x680`, `0x6d0`, `0x7a0`, `0x860`, `0x880`,
`0x9b0`, `0xd60`, `0x12e0`, `0x13a0`, `0x1630`, `0x19a0`.
**Representative cases:** `1/1_clang_O0_g` (`0x880`), `2/2_gcc_O0_g` (`0x6d0`),
`4/4_clang_O1_g` (`0x640`), `7/7_gcc_O0_g` (`0x860`), `5-1/5-1_clang_O0_g` (`0x19a0`).

**Distribution:** perfectly flat — clang 80 / gcc 80, `O0..Os` 32 each, `-g` 80 / no-`g` 80,
all 8 groups. This is a per-binary linker artifact, not a per-source-function behaviour.

**Assessment:** IDA-only **synthetic** function start. IDA's own name (`sub_XXXX`) shows it has no
symbol identity. Hex is not losing a source-level function here; it is declining to model a
linker-generated trampoline. **But** Hex's omission is silent: `functionStartsComplete` is still
reported `true` (see Phase 3), so the gap is invisible in Hex's own completeness signal.

## 4. Cluster B — `ida_noreturn_split_of_enclosing_function` (10 rows, 5 cases, confirmed)

**Signature:** the address lies strictly inside an `STT_FUNC` symbol's span, is not a `BL`/`B`
target, has no FDE, and the *immediately preceding* instruction is a `bl` whose target IDA
annotates `__noreturn` in its own reference. All 10 rows also carry IDA's
`positive sp value has been detected` warning.

All 10 rows have the identical shape:

| case | address | enclosing symbol | previous instruction |
| --- | --- | --- | --- |
| `5-1/5-1_clang_O0_g` | `0x2b50` | `_Z20test_cpp_oo_featuresv` | `bl 0x2404` (`_Z18test_cpp_exceptionv`) |
| `5-1/5-1_clang_O0_g` | `0x2bac` | `main` | `bl 0x2a84` (`_Z20test_cpp_oo_featuresv`) |
| `5-1/5-1_clang_O1_g` | `0x2008` | `_Z20test_cpp_oo_featuresv` | `bl 0x1b74` |
| `5-1/5-1_clang_O1_g` | `0x205c` | `main` | `bl 0x1e04` |
| `5-1/5-1_clang_O2_g` | `0x1370` | `_Z20test_cpp_oo_featuresv` | `bl 0x10c0` |
| `5-1/5-1_clang_O2_g` | `0x1458` | `main` | `bl 0x1278` |
| `5-1/5-1_clang_O3_g` | `0x137c` | `_Z20test_cpp_oo_featuresv` | `bl 0x10c0` |
| `5-1/5-1_clang_O3_g` | `0x1464` | `main` | `bl 0x1284` |
| `5-1/5-1_clang_Os_g` | `0x1368` | `_Z20test_cpp_oo_featuresv` | `bl 0x10c0` |
| `5-1/5-1_clang_Os_g` | `0x13b0` | `main` | `bl 0x1278` |

Concrete disassembly (`5-1/5-1_clang_O0_g`, symbol table is authoritative here):

```
2a84 <_Z20test_cpp_oo_featuresv>   ; st_size = 268 -> ends at 0x2b90
   ...
2b4c  bl  0x2404 <_Z18test_cpp_exceptionv>
2b50  mov w1, w0           <-- IDA starts a new function here (sub_2B50)
   ...
2b8c  ret
2b90 <main>                        ; st_size = 44 -> ends at 0x2bbc
2ba8  bl  0x2a84 <_Z20test_cpp_oo_featuresv>
2bac  ldr w0, [sp, #8]     <-- IDA starts a new function here (sub_2BAC)
2bb8  ret
```

The ELF symbol table reports one function per span. IDA ends the caller at the call to a
function whose body never returns and starts a *new* function at the following instruction —
which is the continuation of the caller. IDA's own output carries
`// positive sp value has been detected, the output may be wrong!` and renders the result as
`sub_2B50(unsigned int a1)` consuming the previous call's `w0`, i.e. IDA itself documents the
artifact.

**Assessment:** IDA-only **artifact** function start ("IDA tail split after an inferred-noreturn
call"). Hex keeping the caller whole is the correct reading of the ELF symbol table. Only the
5-1 C++ case is affected (it is the only group with an inferred-noreturn function call in the
middle of a caller), and only for clang.

## 5. Cluster C — `ida_address_taken_table_target_split` (2 rows, 2 cases, probable)

**Signature:** address is inside an `STT_FUNC` span, is **not** a `BL`/`B` target, has no FDE,
but **is** the addend of an `R_AARCH64_RELATIVE` relocation in the code-pointer table.

`1/1_clang_O1_g` / `1/1_clang_O1_no_g`, address `0x174c`:

```
; .data.rel.ro @ 0x12db8 is a switch table of code pointers
;   0x12db0 R_AARCH64_RELATIVE -> 0x171c
;   0x12db8 R_AARCH64_RELATIVE -> 0x174c      <-- cluster C address
172c <computed_goto>                ; st_size = 64 -> ends at 0x176c
  173c  adrp x8, 0x12000
  1740  add  x8, x8, #3512          ; x8 = 0x12db8
  1744  ldr  x8, [x8, w1, sxtw #3]
  1748  br   x8                     ; indirect dispatch
  174c  mov  w0, wzr                ; <-- case body 0 (IDA: sub_174C)
  1750  ret
  1754  mov  w0, #20                ; <-- case body 1 (Hex DOES have this start)
  1758  ret
  175c  mov  w0, #30                ; <-- case body 2 (Hex DOES have this start)
  1764  mov  w0, #10                ; <-- case body 3 (Hex DOES have this start)
```

The relocation table proves the address is *address-taken* through a table, not a direct branch
target. Note the asymmetry: Hex discovers the three case bodies that follow a `ret` but not the
one that follows the indirect `br x8` (see Phase 3).

**Assessment:** IDA-only function start at an **address-taken switch-case body**. Hex's answer
(case bodies stay inside the enclosing function) is defensible; IDA's answer (each case body is a
function) is also defensible. This is a *convention* difference and Hex is not obviously wrong.
Confidence `probable` rather than `confirmed` because which convention is "correct" is a product
decision, not a fact about the binary.

## 6. Cross-direction note (Hex-only side, evidence for the same mechanism)

The 148 Hex-only rows are concentrated: 92 of 148 come from the eight `1/1_clang_O2/O3/Os` cases
where Hex reports ~20–23 more starts than IDA. Their addresses are exactly the
`R_AARCH64_RELATIVE` addends of the `.data.rel.ro` function-pointer tables
(`0x1378`, `0x1380`, `0x11ac`, `0x1640`…`0x16a4`, `0x1760`…`0x178c`, `0x17c4`/`0x17cc`/`0x17d4`).

So **Hex does have relocation/address-taken-derived start discovery** in some cases and, in
`1/1_clang_O1` at `0x174c`, the same construct is missed. This is direct in-repository proof that
the cluster-C gap is a *rule-shape* asymmetry, not a missing capability, and it is why cluster C
is reported as probable rather than confirmed as a Hex defect.

## 7. Artifacts

| file | contents |
| --- | --- |
| `classification.json` | 172 rows with full per-address evidence + per-cluster aggregation |
| `scripts/classify.mjs` | ELF64 parser, AArch64 static scan, IDA reference oracle, cluster rules |
| `scripts/elf-probe.mjs` | ad-hoc per-case section/symbol probe used for spot verification |
| `00-baseline.md` | Phase 1 baseline identity and numbers |

## 8. Conclusion of Phase 2

The 172 IDA-only functions are **not** missing source functions. They are 39 addresses in three
structural positions: the PLT0 resolver stub (160), an IDA tail split after an inferred-noreturn
call (10), and an address-taken switch-case body (2). None of them is a direct branch target and
none carries an ELF function symbol, so no call-target or symbol-seed producer could have
created them. Phase 3 locates the exact stage at which each cluster stops.
