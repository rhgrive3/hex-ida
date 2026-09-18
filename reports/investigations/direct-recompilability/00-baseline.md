# Direct recompilability — Stage 1: exact raw baseline

Investigation-only lane. No production code, tests, tools, or `package.json` were
modified. `reports/public-benchmark/` was read only. No source repair of any kind
was applied: no typedef, prototype, extern, stub, variable repair, rename, or
syntax rewrite.

- base SHA: `05c93a1c92b34f4876060bd858e4393557d02dd4`
- branch: `investigate/direct-recompilability`
- worktree: `/mnt/workspace/hex-agent-g`
- corpus: `reports/public-benchmark/` — 160 case artifacts + `summary.json`, suite `codefuse-arm64`

## What is being measured, and what is not

This stage measures **standalone translation-unit completeness only**: can the raw
Hex pseudocode saved in the benchmark artifacts be handed to a C compiler as one
translation unit, with nothing added, and survive the syntax/type/declaration
stage, and then the link stage.

It does **not** measure Hex's semantic quality. A case that fails to compile as a
standalone TU can still have a semantically correct function body. The whole point
of the later stages is to keep these two facts separate:

- translation-unit packaging incompleteness (missing typedef / global decl /
  runtime decl / prototype), versus
- decompiler function-body (and signature) emission defects.

It is also **not** an ARM64 native recompilability result. The compiler used is a
host x86_64 clang; a case that fails here would very likely fail on an
`aarch64-linux-gnu` clang too, because the failures are C-level (undeclared
identifiers, missing type names, malformed declarations), not target-ISA-level.
That inference is stated as reasoning, not as measured ARM64 evidence.

## Toolchain identity

| field | value |
|---|---|
| compiler | `Ubuntu clang version 14.0.0-1ubuntu1.1` |
| host target | `x86_64-pc-linux-gnu` |
| standard | `-std=gnu11` |
| syntax stage | `clang -std=gnu11 -fsyntax-only -ferror-limit=0 <tu.c>` |
| link stage | `clang -std=gnu11 -O0 -ferror-limit=0 <tu.c> -o <tu.out>` |
| per-case timeout | 10 s |
| global run deadline | 900 s (actual 6.9 s) |

The link stage is attempted only when the syntax/type stage exits 0. Where the
syntax stage fails, `linkPass=false` with `linkStageReachable=false`: that is a
dependency result, **not** an independent link measurement.

### Methodological note: default diagnostic truncation

A first run without an explicit error limit reported **exactly 19 errors in every
one of the 160 cases**. That is clang's default `-ferror-limit` truncation, not a
property of the corpus. The figures below use `-ferror-limit=0`.

This is a presentation-only change: the syntax-stage exit status is identical with
and without the limit (fail in both runs), so nothing about *what is tested*
changed. Without it, the diagnostic families in Stage 2 would have been silently
sampled at 19 errors per case.

## Exact reconstruction rule

For each case artifact:

1. walk `functions[]` in stored array order;
2. keep only entries whose `pseudocode` is a non-null string;
3. join those pseudocode strings with a single `\n` separator;
4. append one trailing `\n`.

Nothing else is inserted — no prelude, no includes, no forward declarations, no
braces. The reconstruction is deterministic and every case has at least 36
pseudocode-bearing functions (min 36, max 189; source size 5,682–49,908 bytes).
`sourceSha256` and the per-function emitted line ranges are recorded per case in
`compiler-diagnostics.json` so any claim here can be re-derived.

Diagnostic sources were written to `/tmp/hex-recomp/src/` and are **not**
committed.

## Result

| metric | value |
|---|---|
| cases | 160 |
| syntax/type/declaration stage pass | **0 / 160** |
| link stage attempted | 0 / 160 (unreachable) |
| link stage pass | **0 / 160** |
| total `error` diagnostics | 71,836 |
| total `warning` diagnostics | 5,492 |
| mean errors per case | 449 (median 328, min 76, max 1,680) |

Zero of the 160 saved pseudocode sets is a standalone compilable translation unit
under the host compiler as emitted. The link stage is never reached, so **link
completeness is currently unmeasurable from this corpus** — every link failure is
masked by an earlier syntax/type failure.

## First failure

Every one of the 160 cases fails first with `use of undeclared identifier 'X'`
(160 / 160 first-error family). The first *diagnostic* is not always an error:

| first diagnostic severity | cases |
|---|---|
| warning | 116 |
| error | 44 |

First-diagnostic families: implicit declaration of an undefined callee (74),
undeclared identifier (44), `main` return type mismatch (42).

Classifying the first **error** with the deterministic identifier taxonomy in
`harness/identifier_taxonomy.py`:

| class | meaning | cases |
|---|---|---|
| A | TU packaging / declaration completeness | 74 |
| B | function-body emission defect | 86 |
| C | ambiguous / mixed | 0 |
| D | environment / toolchain only | 0 |

The A-first cases fail on a missing global data declaration (`global_<addr>` in
`_start`); the B-first cases fail on an undeclared stack-slot pseudo-variable
(`local_pFFFFFFFFFFFFFFF0` and friends) inside the first emitted function.

Two implications, both carried into Stage 2:

- The uniform first-error family ("undeclared identifier") is **not** a single
  bug. At least two different producer contracts are responsible, and they split
  roughly evenly at the first failure.
- The first failure is a poor proxy for the case: it never surfaces the malformed
  declaration/label/control-flow defects that Stage 2 finds later in the same
  translation unit.

## Representative raw evidence

Case `1/1_clang_O0_g`, first error (`A`), function `_start`:

```
2: void start(void)
3: {
4:     unknown_call(global_13FD8);
5:     unknown_call(global_13FD8);
6: }
```
```
/tmp/.../1_1_clang_O0_g.c:3:5: warning: implicit declaration of function 'unknown_call' is invalid in C99
/tmp/.../1_1_clang_O0_g.c:3:18: error: use of undeclared identifier 'global_13FD8'
```

Same case, a later function body (`B`) — a whole-function shape defect, not just a
missing declaration:

```
uint64 $x(void)
    loc_9A0:
{
    ...
    goto loc_9A0;
    return x0;
}
    goto loc_A54;
```

A label is emitted *before* the function's opening brace, and a `goto` is emitted
*outside* any function. Both are body/signature-emitter defects, and neither is
attributable to a missing typedef.

## Artifacts

| file | content |
|---|---|
| `compiler-diagnostics.json` | per-case baseline record (required fields below) |
| `harness/run-baseline.py` | deterministic reconstruction + compile driver |
| `harness/analyze-stage1.py` | raw record → `compiler-diagnostics.json` |
| `harness/identifier_taxonomy.py` | deterministic identifier → A/B/C classification |

`compiler-diagnostics.json` per case contains `baseSha`, `caseId`, compiler
command + version, `syntaxPass`, `linkPass` (with `linkStageReachable` and
`linkSkipReason`), `firstDiagnostic`, `firstError`, `diagnosticClass`,
`implicatedFunction`, `implicatedLine` (plus relative line and exact snippet).

## Reproduce

```bash
python3 reports/investigations/direct-recompilability/harness/run-baseline.py \
  --bench-dir reports/public-benchmark --out-dir /tmp/hex-recomp
python3 reports/investigations/direct-recompilability/harness/analyze-stage1.py \
  --raw-dir /tmp/hex-recomp/raw \
  --out reports/investigations/direct-recompilability/compiler-diagnostics.json \
  --base-sha "$(git rev-parse HEAD)" --compiler-version "$(clang --version | head -1)" \
  --recon-rule "functions[] order, non-null pseudocode, joined with \\n"
```
