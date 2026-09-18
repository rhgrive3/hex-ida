# 02 — Hex first divergence for the 320 UNSUPPORTED rows (stage 3)

Representative binary: `1/1_clang_O0_g` (`…9600e39…0135ce.bin`).
Checkout: `05c93a1c9` + investigation commits (production code untouched).
Method: code read + read-only product probe via
`tools/validation/public-benchmark/node-worker.mjs` transport
(`installNodeWorkerTransport`), `Backend.open → analyze → SymbolIndex →
ensureFunctions/ensureProgram → AnalysisQueryAPI.decompile` — the same
`product-host.mjs → subject.mjs` path the benchmark uses.

## End-to-end chain (first failure first)

1. **Loader / symbol records.** ELF `STT_FUNC _init @0x860 size 0` and
   `_fini @0x2a84 size 0` pass start authority but carry no extent.
   `js/binary/elf-mapping.js:321-326` (`elfFunctionExtentRejection` returns
   null for `size <= 0`, i.e. "no claim", not "proven empty"), and
   `js/binary/elf-core-original.js:839-842` mints the seed with
   `size: extentRejection ? null : (size || null)` — BigInt `0n` is falsy, so a
   published `st_size == 0` becomes `size: null`. Seed: start proven
   (`exactFunctionStart: true`, `functionStartEvidence: ELF STT_FUNC …`),
   extent absent.
2. **Seed merge.** `js/binary/model.js:1109-1135` (`functionSeed`) keeps
   `end: null`; `mergeFunctionSeeds` `1254-1274` derives `end` only from
   `size`, explicit `end`, or — for missing extents — `next-function-start`
   **iff both sides have `function_starts` sources** (`1262`). Our seeds have
   source `symbol`, so no `next-function-start` inference fires even though the
   next discovered start after `0x860` is `0x940`. Result: `funcEnds[0x860] ==
   null`, `funcEnds[0x2a84] == null`.
3. **Discovery projection.** `functions` query lists 74 functions including
   `0x860` and `0x2a84` with `end: null`
   (`js/analysis/query/app-adapter.js:609-612` `rowAt`: `end: fn?.end ?? null`).
   The subject records exactly this (`tools/validation/public-benchmark/
   subject.mjs:39-46`): `address decimal, name $x, end null`.
4. **Range gate (FIRST DIVERGENCE).** Every decompile goes through
   `rangeFor` (`js/analysis/query/app-adapter.js:227-258`):
   `fn.end == null → {ok: false, reason: 'function-end-unproven'}` (`246`).
   `produceFunction` (`449-451`) converts that to
   `unsupported(id, 'function-end-unproven')` (`142-144`:
   `{value: null, status: {completeness: 'unsupported', reason}}`).
   `App.validatedFunctionRange` (`js/app.js:1383-1399`) agrees: `fn.end == null`
   → try `functionWindowBound`, which is null here → `ok: false,
   reason: 'function-end-unproven'`. Measured on both addresses.
5. **Decompile surface (reason masking).** `decompile` (`app-adapter.js:900-916`)
   calls `loadFunction` → gets the unsupported above (`value: null`), finds no
   `value.decompiler` and no `value.model`, and returns
   `unsupported(id, 'decompiler-projection-unavailable')` (`909`). That is the
   *surfaced* reason in a live query; the *first* reason is
   `function-end-unproven`. The benchmark subject then maps `value == null` to
   per-function `state: UNSUPPORTED`
   (`subject.mjs:43`: `value ? … : 'UNSUPPORTED'`) with
   `completeness: 'unsupported'`, `pseudocode: null` — exactly the 320 rows
   (`end null, state UNSUPPORTED, completeness unsupported`).

Measured probe (representative binary, this checkout):

- `total funcs 74`; `near 0x860: [0x860, 0x940]`; `near 0x2a84: [0x2a84]`
- `nameAt(0x860) == $x`, `nameAt(0x2a84) == $x`; `functionAt().end == null` both
- `functionWindowBound == null` both (so the `App` fallback also fails)
- `validatedFunctionRange → {ok: false, reason: 'function-end-unproven'}` both
- `decompile → {valueNull: true, completeness: 'unsupported',
  reason: 'decompiler-projection-unavailable'}` both

## The five prompt questions, answered narrowly

- **Why is function end null?** Zero-size `STT_FUNC` gives start authority with
  no extent (`elf-core-original.js:842`); no unwind/`function_starts`/exception
  seed supplies an extent; `mergeFunctionSeeds` next-start inference requires
  `function_starts` sources on both sides and does not fire for `symbol`
  seeds. `SymbolIndex._functionEnd` (`js/symbols.js:311-320`) therefore returns
  null, and `functionAt` (`390-403`) reports `{start, end: null}` for the exact
  start. This is fail-closed extent handling (#2409/#2458 contract), not a
  decoder failure — the bytes decode fine (`llvm-objdump` shows them).
- **Mapping display vs semantic seed.** The discovered function's *existence*
  comes from the `STT_FUNC` seed (provenance `symbol`, confidence 0.995). Its
  *displayed name* `$x` comes from the same-address naming projection winning
  for the AAELF64 mapping marker (`exact(0x860) == $x`; transport dedupes
  same-address entries keeping the first, `js/worker-legacy.js:548-560` pattern;
  C lane `fix/arch-symbol-ranking` re-ranks FUNC over zero-size local
  STT_NOTYPE without touching seeds/extents). Naming and seeding are separate
  projections over the same address — conflating them is the exact error the
  prompt warns against.
- **`.init`/`.fini` special-section semantics.** The two functions are the only
  occupants of their sections (`.init` holds `_init` + crtn tail `$x@0x870`;
  `.fini` holds `_fini` + tail `$x@0x2a90`; next discovered start after `.init`
  is `.plt@0x880`/`.text@0x940`, not a continuation). A naive "extend to next
  function start" would swallow `.plt` — the measured `windowBound == null`
  (cross-region containment, `js/symbols.js:339-367`) is the guard refusing that.
  Correct section-bound end (`0x878` / `0x2a98`) exists in section headers but no
  symbol/unwind authority claims it, so the pipeline refuses to invent it.
- **Fallthrough / return / boundary.** Both bodies end with `ldp; ret` tails
  (at `0x870`/`0x2a90`, under the `$x` label), so a return-terminated scan
  *could* find a boundary — but the product's range contract requires *proven*
  extent (`function-end-unproven` fail-closed), not a heuristic scan. No
  fallthrough into the next section is involved; the issue is purely unproven
  extent, not control flow.
- **Section-wide function treatment.** The product does **not** treat the whole
  `.init`/`.fini` section as one function extent: it keeps the FUNC seed (start
  only) and the mapping markers as names, with no extent. IDA instead emits one
  row per section (`.init_proc`/`.term_proc`). The two tools agree on *address*
  (matched rows) and disagree on *extent authority policy*.

## "Would fixing the name to FUNC enable decompile?" — No (not assumed, measured)

Name and extent are independent fields. The range gate checks `fn.end`, never
`fn.name`. After C's ranking fix the rows would display `_init`/`_fini` but
`end` stays null through the identical seed/merge path, so `rangeFor` still
returns `function-end-unproven` and `decompile` still returns
`value: null / unsupported`. Re-verify after C lands by re-running the probe:
expected `nameAt → _init/_fini`, `end → null`, `decompile → unsupported`
unchanged. Any extent fix is a separate, deliberately-scoped decision (section-
bound extent authority), not a consequence of renaming.

## Production code: unchanged

`git diff --name-only BASE..HEAD` contains only
`reports/investigations/unsupported-semantics/*`. All file:line refs above are
reads. No loader/seed/range/decompile behavior was modified in this worktree.
