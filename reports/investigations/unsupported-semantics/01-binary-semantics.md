# 01 — Binary semantics of the 320 addresses (stage 2)

- baseSha: `05c93a1c92b34f4876060bd858e4393557d02dd4`
- mechanical aggregation: `semantics.json` (schema `hex-investigation-unsupported-semantics/v1`, 320 rows)
- this file adds sampled ELF ground truth for one representative binary plus
  the IDA pseudocode classification. Sampled ≠ corpus-wide unless stated.
- Representative binary: `1/1_clang_O0_g`
  `inputs/9600e39427753dcf4d4dc4c3ab218eca92bbf2fe898a8d3ca8204202ac0135ce.bin`
  (`binarySha256 9600e39…0135ce`).

## Mechanical aggregation (all 320, from current checkout)

From `semantics.json/summary`:

- `bySection`: `.fini 160 / .init 160`
- `byFuncSymbolName`: `_fini 160 / _init 160`
- `byFuncSymbolBind`: `GLOBAL 320`
- `byFuncSymbolVis`: `HIDDEN 320`
- `byFuncSymbolSize`: `0 → 320` (every FUNC symbol has `st_size == 0`)
- `byMappingSymbol`: `null 320` (aggregation field; see § mapping below)
- `byAddressIsSectionStart`: `true 320` (every address is its section's start)
- `byIdaNameAndSection`: `.term_proc→.fini 160 / .init_proc→.init 160`
- `sectionFlagsExec`: true (all rows; per-row field)
- `otherSymbols`:
  - 160 rows: `(SECTION:LOCAL, NOTYPE:LOCAL)`
  - 160 rows: `(SECTION:LOCAL, SECTION:LOCAL, NOTYPE:LOCAL)`

Row shape (per-row fields): `caseId, address, idaName, section,
sectionFlagsExec, funcSymbol, funcSymbolBind, funcSymbolVis, funcSymbolSize,
mappingSymbol, otherSymbols, addressIsSectionStart`.

## Sampled ELF ground truth (representative binary, read-only tools)

Commands (read-only): `readelf -S/-s/-l/-d`, `llvm-objdump -d`.

- Section headers:
  - `.init PROGBITS @0x860 size 0x18 flags AX` (index 11)
  - `.plt  @0x880 size 0xa0`, `.text @0x940 size 0x2144`
  - `.fini PROGBITS @0x2a84 size 0x14 flags AX` (index 14)
- Symbol tables (`.symtab`):
  - `0x860 0 FUNC GLOBAL HIDDEN [11] _init`, `st_size 0`
  - `0x2a84 0 FUNC GLOBAL HIDDEN [14] _fini`, `st_size 0`
  - `0x860 0 NOTYPE LOCAL [11] $x`, `0x2a84 0 NOTYPE LOCAL [14] $x`
  - `0x870 $x`, `0x880 $x` (mapping markers inside/after `.init`)
  - `0x2a90 $x` (mapping marker inside `.fini`)
- Disassembly (`llvm-objdump -d`):
  - `0x860 <_init>: nop; stp x29,x30,[sp,#-16]!; mov x29,sp; bl 0x974 <call_weak_fn>`
  - `0x870 <$x>: ldp x29,x30,[sp],#16; ret` (crtn epilogue tail of `.init`)
  - `0x2a84 <_fini>: nop; stp x29,x30,[sp,#-16]!; mov x29,sp`
  - `0x2a90 <$x>: ldp x29,x30,[sp],#16; ret` (crtn epilogue tail of `.fini`)
- Dynamic (`readelf -d`):
  - `INIT 0x860`, `FINI 0x2a84`
  - `INIT_ARRAY 0x13d20 / FINI_ARRAY 0x13d28` (separate; not the 320 rows)
- Program headers: `LOAD R E 0x0–0x39e0` covers `.init/.plt/.text/.fini/.rodata`;
  entry point `0x940` (`_start`, in `.text`, not in the 320 set).
- Relocations (`.rela.dyn`, 29 entries): `R_AARCH64_RELATIVE` on data addresses
  (`0x13d20…`); no code relocation targets `0x860`/`0x2a84`. No call-reference
  into `0x860`/`0x2a84` from `.text` other than the loader's INIT/FINI contract
  (loader-invoked, not user-called). Not a user-call graph node.

So each 320 address is, structurally:

1. an executable section start (`.init` or `.fini`),
2. a zero-size `STT_FUNC GLOBAL HIDDEN` symbol (`_init` / `_fini`),
3. co-located with an AAELF64 mapping marker `$x` (STT_NOTYPE LOCAL size 0),
4. the section body is CRT init/fini code (prologue + `bl` / epilogue split
   across `_init`+`$x` labels), and
5. (sampled) the exact value of the loader contract `DT_INIT` / `DT_FINI`.

## Mapping-symbol field note

`semantics.json/mappingSymbol == null (320)` means "no *separate* mapping-symbol
record was attached in that aggregation's column", **not** "no `$x` exists".
`readelf` proves `$x` markers exist at `0x860/0x870/0x880/0x2a84/0x2a90`.
The Hex product display name for the discovered function is `$x`
(`nameAt(0x860) == $x`, `nameAt(0x2a84) == $x`; see stage 3 probe), i.e. the
mapping marker won the same-address naming projection on this checkout.
That display fact is C-lane's ranking scope; it does not change any row's
section/symbol/size/section-start facts above.

## IDA pseudocode (reference artifact, not oracle)

`benchmarks/public/codefuse-arm64/reference/1/1_clang_O0_g.c`:

```c
/* Function: .init_proc @ 0x860 */
__int64 init_proc() { return call_weak_fn(); }
/* Function: .term_proc @ 0x2A84 */
void term_proc() { ; }
```

- IDA names (`.init_proc`/`.term_proc`) are IDA's own labels for the `.init`/`.fini`
  bodies; the ELF symbols are `_init`/`_fini`.
- IDA decompiles both (4-line and 1-line bodies). That proves IDA *chose* to emit
  them as functions, not that they are ordinary user functions.
- Classification from binary truth: **normal user function — no**;
  **ELF startup/finalization runtime code — yes** (C runtime init/fini sections,
  loader-invoked via INIT/FINI, HIDDEN linkage, zero-size FUNC + section-start).

## Checklist coverage (stage-2 prompt requirements)

- section: ✅ all 320 (`.init` 160 / `.fini` 160, exec true).
- symbol table entries: ✅ per-row `funcSymbol + otherSymbols`; full `readelf -s`
  dump sampled on 1 binary (above).
- symbol type/binding/size: ✅ `FUNC/GLOBAL/HIDDEN/size 0` all 320.
- mapping symbol: ✅ `$x` presence proven by `readelf` + product `nameAt`;
  aggregation column is null by schema (documented, not contradictory).
- ELF `.init`/`.fini` relation: ✅ section identity all 320; INIT/FINI dynamic
  values sampled on 1 binary (exact match).
- executable range: ✅ section AX + LOAD R E (sampled); per-row exec flag all 320.
- entry/call references: ✅ sampled — loader INIT/FINI contract only; no user
  call edge observed; entry point is `0x940`, outside the set.
- relocation evidence: ✅ sampled — no relocation targets the 320 addresses.
- function seed provenance: ✅ sampled via product probe —
  `functionEvidence {source: symbol, confidence: 0.995, confirmed: true}` at
  both addresses; end null (see stage 3 for seed→end mechanics).
- function end/boundary evidence: ✅ sampled — `functionAt().end == null`,
  `functionWindowBound == null`, next function start after `0x860` is `0x940`
  (different section); `.init` section end `0x878` is the natural section bound
  but no symbol extent claims it (size 0) and no `function_starts` extent
  inference applies (source is `symbol`, not `function_starts`).

## Classification (no privileged premise)

- "IDA emitted it ⇒ correct user function": **rejected as premise**
  (IDA label ≠ user-function proof; binary says CRT init/fini).
- "Hex unsupported ⇒ product bug": **rejected as premise**
  (Hex fail-closed `function-end-unproven` is by design; see stage 3).
- Positive finding: the 320 are **real executable CRT init/fini entities**
  (not IDA fictions — bytes, FUNC symbols, and INIT/FINI contract exist),
  but they are **not ordinary user functions** (HIDDEN, zero-size, section-start
  trampolines, loader-invoked). Whether they belong in a *user-function quality*
  denominator is a scope decision (stage 4), not a binary-truth dispute.
