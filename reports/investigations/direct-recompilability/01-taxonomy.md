# Direct recompilability — Stage 2: diagnostic taxonomy

Investigation-only lane. No production code, tests, tools, or `package.json` were
modified. `reports/public-benchmark/` was read only. No source repair was applied.

- base SHA: `05c93a1c92b34f4876060bd858e4393557d02dd4` (branch
  `investigate/direct-recompilability`)
- input: the Stage 1 raw records (`/tmp/hex-recomp/raw/`), 160 cases
- method: deterministic matcher in `harness/analyze-taxonomy.py`; every one of the
  78,002 diagnostics in the corpus is assigned to exactly one cluster
- compiler: host `Ubuntu clang version 14.0.0-1ubuntu1.1`, `-std=gnu11` (host
  x86_64; **not** ARM64 native recompilability)

## Headline

Stage 1 showed all 160 cases fail the same first error ("undeclared identifier").
Stage 2 shows that is **not one bug**. It decomposes into two independent producer
contracts — TU packaging and function-body emission — plus a smaller set of
derived cascades:

| bucket | meaning | occurrences | independent occurrences |
|---|---|---|---|
| A | translation-unit packaging / declaration completeness | 20,516 | 20,516 |
| B | function-body (and signature) emission defect | 56,768 | 53,280 |
| C | cascades, notes, ambiguous | 718 | 0 |
| D | environment / toolchain only | 0 | 0 |
| **total** | | **78,002** | **73,796** |

Every one of the 160 cases contains **at least one independent packaging defect
and at least one independent body-emitter defect**: `caseProfiles = {mixed: 160}`.
There is no case that fails for packaging reasons only, and none that fails for
body-emitter reasons only. A packaging "prelude" alone cannot make a single case
compile; an emitter fix alone cannot either.

## Full cluster table

`occ` = all-diagnostic occurrences. `1stD` / `1stE` = cases where the cluster is
the first diagnostic (any severity) / the first error. `ind` = independent
defect; `no` entries carry a `cascadeOf` root.

| cluster | bucket | occ | cases | functions | 1stD | 1stE | ind |
|---|---|---|---|---|---|---|---|
| B-UNDECLARED-STACK-SLOT | B | 28,180 | 160 | 4,000 | 44 | 86 | yes |
| B-UNDECLARED-REGISTER-PSEUDO-VAR | B | 14,440 | 160 | 1,248 | 0 | 0 | yes |
| A-NONSTANDARD-INT-ALIAS | A | 8,990 | 160 | 1,538 | 0 | 0 | yes |
| A-STANDARD-TYPE-ALIAS | A | 4,552 | 160 | 1,886 | 0 | 0 | yes |
| B-UNDECLARED-ARG-PSEUDO-VAR | B | 4,012 | 148 | 2,364 | 0 | 0 | yes |
| B-MALFORMED-EXPRESSION-CASCADE | B | 2,988 | 160 | 662 | 0 | 0 | no → A-NONSTANDARD-INT-ALIAS |
| A-RUNTIME-HELPER-DECL | A | 2,810 | 160 | 2,186 | 74 | 0 | yes |
| B-UNDECLARED-CALL-TEMP | B | 2,698 | 122 | 696 | 0 | 0 | yes |
| A-MISSING-PROTOTYPE | A | 2,036 | 160 | 844 | 0 | 0 | yes |
| A-GLOBAL-DATA-DECL | A | 1,510 | 160 | 754 | 0 | 74 | yes |
| B-UNDECLARED-VALUE-PSEUDO-VAR | B | 796 | 88 | 180 | 0 | 0 | yes |
| C-NOTE-SUPPORT | C | 674 | 160 | 531 | 0 | 0 | no |
| B-UNDECLARED-ARCH-REGISTER | B | 664 | 114 | 384 | 0 | 0 | yes |
| B-LABEL-BEFORE-BODY | B | 648 | 160 | 648 | 0 | 0 | yes |
| B-UNDECLARED-LABEL | B | 544 | 104 | 326 | 0 | 0 | yes |
| B-STATEMENT-OUTSIDE-FUNCTION | B | 532 | 76 | 462 | 0 | 0 | yes |
| A-MANGLED-SYMBOL-PROTOTYPE | A | 480 | 36 | 306 | 0 | 0 | yes |
| B-IMPLICIT-VS-DEFINITION-CONFLICT | B | 384 | 38 | 384 | 0 | 0 | no → A-MISSING-PROTOTYPE |
| B-UNDECLARED-PHI-TEMP | B | 342 | 60 | 156 | 0 | 0 | yes |
| B-ENTRY-SIGNATURE | B | 160 | 160 | 160 | 42 | 0 | yes |
| A-MISSING-TYPE-DECL | A | 138 | 24 | 54 | 0 | 0 | yes |
| B-INVALID-DECLARATOR-NAME | B | 136 | 24 | 136 | 0 | 0 | yes |
| B-INCOMPLETE-TYPE-DECLARATION | B | 76 | 16 | 76 | 0 | 0 | no → B-INVALID-DECLARATOR-NAME |
| B-UNDECLARED-CONDITION-TEMP | B | 70 | 42 | 58 | 0 | 0 | yes |
| C-CASCADE-RECOVERY | C | 44 | 18 | 44 | 0 | 0 | no → type aliases |
| B-ARG-COUNT-MISMATCH | B | 40 | 12 | 14 | 0 | 0 | no → A-MISSING-PROTOTYPE |
| B-UNRESOLVED-OPERAND-PLACEHOLDER | B | 38 | 16 | 22 | 0 | 0 | yes |
| B-DUPLICATE-EMITTED-SYMBOL | B | 12 | 8 | 12 | 0 | 0 | yes |
| B-STRING-CONCAT-EMISSION | B | 6 | 3 | 3 | 0 | 0 | yes |
| B-INVALID-MEMBER-ACCESS | B | 2 | 2 | 2 | 0 | 0 | yes |
| C-UNCLASSIFIED | C | 0 | 0 | 0 | 0 | 0 | n/a |
| D-TOOLCHAIN | D | 0 | 0 | 0 | 0 | 0 | n/a |

Reconciliation: `Σ occ = 78,002 = 71,836 errors + 5,492 warnings + 674 notes`,
matching the Stage 1 totals exactly.

## A — translation-unit packaging / declaration completeness

**A-NONSTANDARD-INT-ALIAS** — 8,990 occ / 160 cases / 1,538 functions.
The printer emits non-C type names in both declaration and cast position:
`uint64`, `uint32`, `int64`, `uint8`. Producer: **type alias rendering**. A
one-line typedef block would remove this whole cluster.

```
6: uint64 $x(void)
7: {
8:     x0_1 = *(uint64 *)0x13FD0;
```
`error: unknown type name 'uint64'`, and in cast position
`error: use of undeclared identifier 'uint64'`.

**A-STANDARD-TYPE-ALIAS** — 4,552 occ / 160 cases / 1,886 functions.
Same rendering site, but the *correct* spelling is used (`uint32_t`, `uint64_t`,
`int32_t`) with no `<stdint.h>` include and no typedef. Producer: **type alias
rendering / missing standard header emission**. Note the corpus emits *both*
spellings for the same type in the same body:

```
56:     local_m10 = (uint32_t)a1 + (uint32_t)a2;
```

**A-RUNTIME-HELPER-DECL** — 2,810 occ / 160 cases / 2,186 functions; first
diagnostic in 74 cases. Decompiler pseudo-intrinsics are emitted as ordinary
function calls with no declaration: `unknown_call` (1,860), `phi` (498),
`__arm64_condition_unknown` (152), `bit_extract` (116), `sext` (64),
`bit_insert` (62), `__a64_movi_*`, `__arm64_nzcv_*`, `__arm64_sbfx`, `N_adds32`.
Producer: **call rendering + pseudo-intrinsic/runtime declaration contract**.

```
1: void start(void)
2: {
3:     unknown_call(global_13FD8);
```
`warning: implicit declaration of function 'unknown_call' is invalid in C99`.

**A-MISSING-PROTOTYPE** — 2,036 occ / 160 cases / 844 functions; all warnings.
Distinct real callees (`sub_<addr>`, `process_char`, `test_*`, ...) called before
definition or never defined. Producer: **function prototype rendering / TU
ownership boundary**. This is C99-invalid and a hard error on clang ≥ 16 and
gcc ≥ 14, so the host clang 14 result understates how far from compilable the raw
output is by modern toolchains.

**A-GLOBAL-DATA-DECL** — 1,510 occ / 160 cases / 754 functions; first *error* in
74 cases. Producer: **global symbol rendering** (address-derived data symbol
table is never rendered as declarations).

**A-MANGLED-SYMBOL-PROTOTYPE** — 480 occ / 36 cases / 306 functions. Mangled C++
symbols emitted as C identifiers (`Z12template_maxIiET_S0_S0_`,
`ZN11SimpleClass8setValueEi`, `ZTv0_n24_N14DiamondDerived4funcEv`, ...) and called
with no prototype. Note the leading `_` of the Itanium `_Z` prefix is stripped.
Producer: **symbol naming + prototype rendering**.

**A-MISSING-TYPE-DECL** — 138 occ / 24 cases / 54 functions; first error in 74
cases. `vector128`, `Base`, `Derived`, `Container`, `MultiDerived`,
`DiamondDerived`, `std`. Producer: **type declaration rendering**.

## B — function-body and signature emission

### Body-scoped variables that are never declared

The single largest defect family. These tokens are body-internal and cannot be
fixed at TU level.

**B-UNDECLARED-STACK-SLOT** — 28,180 occ / 160 cases / 4,000 functions (first
error in 86 cases). `local_x29`, `local_pFFFFFFFFFFFFFFF0`, `local_m10`,
`var_<off>`, `field_<off>`, `memory_unknown`.

```
51: void sequential_ops(void)
52: {
53:     local_m4 = a1;
54:     local_m8 = a2;
```
`error: use of undeclared identifier 'local_m4'`.

**B-UNDECLARED-REGISTER-PSEUDO-VAR** — 14,440 occ / 160 cases / 1,248 functions.
`x0`, `x0_1`, `x19`, `w0`, `d0`. Raw architecture register names escape into the
body as ordinary identifiers (`x0_1 = *(uint64 *)0x13FD0;`).

**B-UNDECLARED-ARG-PSEUDO-VAR** — 4,012 occ / 148 cases / 2,364 functions.
The emitted signature does not declare the parameters the body reads:

```
51: void sequential_ops(void)
52: {
53:     local_m4 = a1;
```
`a1`, `a2`, `a3` are used while the declarator says `(void)`. Producer:
**signature rendering vs body variable rendering**.

**B-UNDECLARED-CALL-TEMP** — 2,698 occ / 122 cases / 696 functions. Per-call
result temporaries (`call_155`) generated and consumed without declaration.
Producer: **temporary generation inside the body emitter**.

**B-UNDECLARED-VALUE-PSEUDO-VAR** — 796 occ / 88 cases / 180 functions. SSA value
indices (`v165`, `v1010`, `v44`) used as operands. Shares the spelling space with
ARM64 SIMD registers `v0..v31`.

**B-UNDECLARED-PHI-TEMP** — 342 occ / 60 cases / 156 functions. SSA phi
temporaries (`local_phi_1297`) emitted as identifiers instead of being lowered
into declared locals — and note there are *two* phi encodings: this one, and
`phi(a, b)` emitted as a call under A-RUNTIME-HELPER-DECL.

**B-UNDECLARED-ARCH-REGISTER** (664 / 114), **B-UNDECLARED-CONDITION-TEMP**
(70 / 42, `condition_le`, `flag_eq`).

### Signature / declaration-shape defects

**B-LABEL-BEFORE-BODY** — 648 occ / **160 cases** / 648 functions. A label is
emitted between the declarator and the opening brace:

```
13: uint64 $x(void)
14:     loc_9A0:
15: {
```
`error: expected function body after function declarator`. This is present in
every case and is the strongest single reason no "add a prelude" fix can work.

**B-STATEMENT-OUTSIDE-FUNCTION** — 532 occ / 76 cases / 462 functions. A `goto`
is emitted after the function's closing brace, at file scope:

```
155: }
156:     goto loc_C44;
157: uint32 nested_if_deep(int64 a1, ...)
```
`error: expected identifier or '('`.

**B-ENTRY-SIGNATURE** — 160 occ / 160 cases. `void main(void)` is emitted instead
of `int main(...)`; first diagnostic in 42 cases.

**B-INVALID-DECLARATOR-NAME** — 136 occ / 24 cases / 136 functions. C++ qualified
and demangled names emitted as C declarators: `uint64 thunk to
MultiDerived::funcB(int64 a1)`, `void Container::get(...)`. Producer: **function
name rendering**.

### Control flow

**B-UNDECLARED-LABEL** — 544 occ / 104 cases / 326 functions. `goto loc_F88;`
where the emitted body never defines `loc_F88`: the control-flow structuring and
the label emission disagree.

**B-DUPLICATE-EMITTED-SYMBOL** — 12 occ / 8 cases. `$x` and two
`param_*` names are defined more than once.

### Expression-level

**B-UNRESOLVED-OPERAND-PLACEHOLDER** — 38 occ / 16 cases. A literal `?` is
emitted in operand position on both sides of an assignment:

```
956:     ? = *(uint64 *)(x1);
957:     *(uint64 *)(x0) = ?;
```
`error: expected ':'`.

**B-STRING-CONCAT-EMISSION** — 6 occ / 3 cases. `x1 = "\n" + 24;` — pointer
arithmetic on a string literal where the source did not do that.

**B-INVALID-MEMBER-ACCESS** — 2 occ / 2 cases. `param_atomic_ops.constprop.0(...)`
— a dotted symbol name parses as member access.

### Derived (not independent)

**B-MALFORMED-EXPRESSION-CASCADE** — 2,988 occ / 160 cases / 662 functions.
`expected expression` from `*(uint64 *)0x13FD0`; a pure consequence of the missing
aliases. **B-IMPLICIT-VS-DEFINITION-CONFLICT** (384 / 38) and
**B-ARG-COUNT-MISMATCH** (40 / 12) are consequences of the missing prototypes.
**B-INCOMPLETE-TYPE-DECLARATION** (76 / 16) is a consequence of the invalid
declarator names. **C-CASCADE-RECOVERY** (44 / 18) — all 34 `expected ']'`
occurrences sit on lines that also contain an undeclared int alias (verified:
34 of 34), so they are measurement noise from the alias gap.

## Why surface strings were not used as the cluster key

`unknown_call`, `uint64`, `global_*` and `x0_*` are only the spellings. Each was
traced to the contract that produced it:

| surface token | who produces it | why it is undeclared |
|---|---|---|
| `unknown_call`, `phi`, `bit_extract`, `sext` | call rendering | no runtime header is emitted |
| `global_<addr>` | global data symbol table | never rendered as declarations |
| `uint64` / `uint32_t` | type alias rendering | no typedef, no `<stdint.h>` |
| `x0_1`, `local_*`, `a1` | high-variable / register rendering | locals and params never declared |
| `call_<n>`, `local_phi_*`, `v165` | temporary generation | temporaries never declared |
| `Z12template_max...` | symbol naming (mangled) | name itself is not a C-symbol contract |
| `?` | expression rendering | placeholder token escapes |

Two tokens with the same surface shape land in different buckets for a reason:
`v0` in `v0 = *(double *)(x1);` is a SIMD register (B, register rendering) while
`v165` in `if (v165 != 0)` is an SSA value (B, temporary generation); both are
emitter-scoped, but neither belongs to a TU-level declaration list.

## Confidence and limits

- High confidence: all clusters with an exact snippet and a mechanical producer
  identification (the majority, 53,280 independent occurrences).
- Medium confidence: `A-MISSING-TYPE-DECL` (the set of user type names may not be
  exhausted), `B-INCOMPLETE-TYPE-DECLARATION`, `B-UNDECLARED-CONDITION-TEMP`,
  `B-STRING-CONCAT-EMISSION`, `C-CASCADE-RECOVERY`.
- The `firstDiagnostic` for 116 cases is a *warning*, so "first diagnostic" and
  "first failure" are different concepts; both are reported per cluster.
- These are diagnostics from a **host x86_64 clang**. The failures are C-level and
  would reproduce on an `aarch64` clang, but that is reasoning, not measurement.
- Nothing here measures Hex semantic quality. A case with an undeclared
  `local_m4` can still have a semantically correct body.

## Artifacts

| file | content |
|---|---|
| `diagnostic-taxonomy.json` | 32 clusters with counts, snippets, producer layers, confidence, cascade attribution |
| `harness/analyze-taxonomy.py` | deterministic matcher producing the above |
| `harness/identifier_taxonomy.py` | identifier → A/B/C classification shared with Stage 1 |
