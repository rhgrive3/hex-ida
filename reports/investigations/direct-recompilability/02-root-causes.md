# Direct recompilability — Stage 3: root-cause mapping

Investigation-only lane. Production source was read, never modified. No
production fix, no prelude, no repair.

- base SHA: `05c93a1c92b34f4876060bd858e4393557d02dd4`
- inputs: `diagnostic-taxonomy.json` (Stage 2), raw records, and a new focused probe
- method: read the production emitter chains and join each cluster to the
  producer contract that generates its token, with `file:line` spans

## 1. What the decompiler API actually promises

`tools/validation/public-benchmark/subject.mjs` calls

```js
const response = await product.query.decompile(currentSnapshot, fn.address);
...
pseudocode: value?.pseudocode ?? value?.code ?? null
```

**once per function**, and stores one pseudocode string per function. There is no
entry point that returns a translation unit, and nothing downstream claims one.

So the API contract is **function-scoped pseudocode**, not standalone C. Three of
the largest failure clusters are therefore *contract* gaps rather than emitter
bugs:

| cluster | why a prelude alone cannot fix it |
|---|---|
| A-MISSING-PROTOTYPE (2,036) | no prototype list exists in the output model at all |
| A-GLOBAL-DATA-DECL (1,510) | `global_<addr>` is synthesised at print time; there is no global declaration list |
| A-RUNTIME-HELPER-DECL (2,810) | the helpers are not real symbols (see §4) |

This is the honest limit of the headline "0/160 compile as a TU": part of it is
asking the product for something it never claimed.

But it is only *part*. §5 shows that 68.9% of **individual** function bodies also
fail alone, with no concatenation involved. Those are genuine defects.

## 2. Is the metadata there, and does the printer throw it away?

`inferSemanticTypes()` (`js/decompiler/type-recovery.js:318-323`) returns

```js
return { args, locals, ret, values, locations, warnings };
```

and `locals` is built at `js/decompiler/type-recovery.js:293-297` with
`slot`, `offset`, `type`, `confidence`. So local-variable declaration metadata
**does exist**.

`semanticSignature()` (`js/decompiler/type-recovery.js:326-334`) consumes only
`ret` and `args`. The semantic renderer then assembles
(`js/decompiler/semantic-core.js:1620-1625`):

```js
const lines = [ line('sig', 0, signature, ...), line('ctrl', 0, '{') ];
for (const l of body) lines.push(l);
lines.push(line('ctrl', 0, '}'));
```

The line-kind vocabulary actually emitted across `js/decompiler/semantic-core.js`
is `sig`, `ctrl`, `stmt`, `label`. **There is no `decl` kind in the semantic
renderer — there is no local-declaration emission path at all.**

The *legacy* renderer does have one: `declarations()` at
`js/decompile-legacy.js:2160-2190` iterates `types.locals` and emits

```js
out.push(line('decl', 1, type + ' ' + names.slice(i, i + 8).join(', ') + ';', null));
```

That path is real and reachable — 416 of the 10,292 pseudocode blobs in the
frozen corpus contain such a block, e.g. `uint64 var_8, var_18, var_20;`. But it
(a) only runs on the legacy route, (b) uses the bare `uint64`/`uint32` spelling,
and (c) only covers `types.locals` (stack slots), never `call_<id>`,
`local_phi_<id>`, register pseudo-vars, or arguments.

| question | answer |
|---|---|
| does the analysis produce declaration metadata? | yes — `args`, `locals`, `values`, `locations` |
| does the semantic printer discard it? | yes — `locals` is never read by the semantic renderer |
| is a declaration emitter missing entirely? | yes, in the semantic path |
| is anything missing from the analysis? | yes — no TU/global/prototype/runtime-declaration model exists (`analysisMissing: true` for A-MISSING-PROTOTYPE, B-ENTRY-SIGNATURE, B-DUPLICATE-EMITTED-SYMBOL) |

## 3. Two type vocabularies in one emitted function

`js/decompiler/type-recovery.js:7-11`:

```js
const INTEGER_NAMES = new Map([
  ['8:s','int8'],['8:u','uint8'],['16:s','int16'],['16:u','uint16'],
  ['32:s','int32'],['32:u','uint32'],['64:s','int64'],['64:u','uint64'],
]);
```

`js/decompiler/pretty/c.js:60-70`:

```js
function exactUnsignedType(bits) { ... 'uint32_t' ... 'uint64_t' ... }
```

Both render into the same translation unit. Case `1/1_clang_O0_g` contains
`uint64 $x(void)` (bare vocabulary, from the signature) and, two functions later,
`local_m10 = (uint32_t)a1 + (uint32_t)a2;` (standard vocabulary, from the
expression printer). Neither is declared. That is one root cause producing two
clusters: A-NONSTANDARD-INT-ALIAS (8,990) and A-STANDARD-TYPE-ALIAS (4,552).

## 4. `unknown_call` is a sentinel, not a runtime helper

`js/decompiler/pretty/c.js:185`:

```js
case 'call': return `${n.callee || 'unknown_call'}(${...})`;
```

`js/decompiler/pipeline-core.js:1448`:

```js
const name = modelCall?.name || inst.extra?.name
  || (inst.extra?.target != null ? state.opts?.symbolFor?.(inst.extra.target) : null)
  || 'unknown_call';
```

When a call target cannot be resolved, the printer substitutes the literal name
`unknown_call` and emits a call to a symbol that does not exist. The IR tracks
that the arity is unknown (`ctx.unknownCallArities`, surfaced as a warning), so
the *information* is present; the printed form is what breaks. The token is a
contract leak, not a designed runtime function awaiting a declaration. The same
applies to the pseudo-intrinsics emitted as calls: `phi` (498), `bit_extract`,
`bit_insert`, `sext`, `__a64_movi_*`, `__arm64_condition_*`, `__arm64_nzcv_*`.

Note the internal inconsistency: SSA phi has **two** emitted encodings —
`local_phi_<id>` identifiers (B-UNDECLARED-PHI-TEMP, 342) and `phi(a, b)` calls
(A-RUNTIME-HELPER-DECL).

## 5. Focused probe: 31.1% of functions are valid C on their own

Stage 1 compiled each case as a concatenation, which conflates "the function is
not valid C" with "there is no TU around it". The probe
(`harness/probe-single-function.py`) compiles **each pseudocode blob alone**, with
nothing added:

| metric | value |
|---|---|
| function pseudocode blobs | 10,292 |
| blobs that compile alone | **3,204 (31.1%)** |
| blobs that fail alone | 7,088 (68.9%) |
| cases with at least one passing blob | 140 / 160 |
| cases where all blobs pass | 0 / 160 |

Per program group (blobs passing alone): group 1 33.2%, 2 30.9%, 3 27.1%,
4 55.3%, 5-1 27.8%, 5-23 39.2%, 6 5.6%, 7 29.8%.

First-error cluster of the 7,088 blobs that fail *in isolation*:

| first-error cluster | blobs | scope |
|---|---|---|
| B-UNDECLARED-STACK-SLOT | 3,574 | intra-function emitter |
| A-NONSTANDARD-INT-ALIAS | 1,896 | type vocabulary |
| A-STANDARD-TYPE-ALIAS | 550 | type vocabulary |
| B-UNDECLARED-ARG-PSEUDO-VAR | 392 | intra-function emitter |
| B-LABEL-BEFORE-BODY | 276 | intra-function emitter |
| A-GLOBAL-DATA-DECL | 264 | TU packaging |
| B-INCOMPLETE-TYPE-DECLARATION | 76 | intra-function |
| B-UNDECLARED-CONDITION-TEMP | 34 | intra-function |
| B-UNDECLARED-REGISTER-PSEUDO-VAR | 18 | intra-function |
| B-UNDECLARED-VALUE-PSEUDO-VAR | 8 | intra-function |

Emitter-scoped first failures (3,574+392+276+76+34+18+8 = 4,378) outnumber
packaging-scoped ones (1,896+550+264 = 2,710) even with the TU question removed
entirely.

## 6. Two precise insertion-anchor defects

These are the cleanest findings in the whole study, and both are single-index
bugs in the same file.

**B-LABEL-BEFORE-BODY** (648 occ, all 160 cases) —
`js/decompile-base.js:304-311`:

```js
function ensureLegacyLabel(lines, row, label, address) {
  ...
  let at = lines.findIndex((l) => l.row != null && l.row >= row && l.kind !== 'sig');
  if (at < 0) at = Math.max(1, lines.findIndex((l) => l.kind === 'ctrl' && l.text === '}'));
  if (at < 0) at = lines.length;
  lines.splice(at, 0, { kind: 'label', indent, text: `${label}:`, ... });
}
```

When neither search hits, `Math.max(1, -1)` evaluates to **1**. Index 1 is between
the `sig` line (index 0) and the `{` line (index 1) — the label is spliced into
the middle of the function declarator. The clamp was clearly intended to keep the
label below the signature, but the first body line is index **2**:

```
uint64 $x(void)
    loc_9A0:
{
```

**B-STATEMENT-OUTSIDE-FUNCTION** (532 occ, 76 cases) —
`js/decompile-base.js:317-338` anchors a synthesised `goto` at the last line
whose `row` is `<= edge.from.endRow`, then splices at `anchor + 1`. The legacy
renderer stamps its closing brace with a real instruction row
(`js/decompile-legacy.js:139`):

```js
out.push(line('ctrl', 0, '}', insns[insns.length - 1].row));
```

so the closing brace can *be* the anchor, and the `goto` lands after `}` at file
scope:

```
155: }
156:     goto loc_C44;
157: uint32 nested_if_deep(int64 a1, ...)
```

Both are 100% reproducible across every group and compiler variant, so they are
general defects, not corpus artifacts.

## 7. Generality outside the benchmark

For every top cluster, the cluster appears in **all 8 program groups and all 20
compiler/optimisation variants**:

| cluster | groups | variants | cases |
|---|---|---|---|
| A-RUNTIME-HELPER-DECL | 8/8 | 20/20 | 160 |
| A-GLOBAL-DATA-DECL | 8/8 | 20/20 | 160 |
| A-NONSTANDARD-INT-ALIAS | 8/8 | 20/20 | 160 |
| A-STANDARD-TYPE-ALIAS | 8/8 | 20/20 | 160 |
| A-MISSING-PROTOTYPE | 8/8 | 20/20 | 160 |
| B-UNDECLARED-STACK-SLOT | 8/8 | 20/20 | 160 |
| B-UNDECLARED-REGISTER-PSEUDO-VAR | 8/8 | 20/20 | 160 |
| B-LABEL-BEFORE-BODY | 8/8 | 20/20 | 160 |
| B-ENTRY-SIGNATURE | 8/8 | 20/20 | 160 |
| B-UNDECLARED-ARG-PSEUDO-VAR | 8/8 | 20/20 | 148 |
| B-UNDECLARED-CALL-TEMP | 8/8 | 20/20 | 122 |
| B-UNDECLARED-LABEL | 8/8 | 20/20 | 104 |
| A-MANGLED-SYMBOL-PROTOTYPE | 3/8 | 20/20 | 36 |
| B-UNRESOLVED-OPERAND-PLACEHOLDER | 2/8 | 14/20 | 16 |

`unknown_call`-style sentinels, the bare type vocabulary, the missing
declaration path, and the two insertion anchors are all reachable from the
emitter's own contracts; they do not depend on anything corpus-specific. The last
two rows are the exception: mangled-symbol and `?`-placeholder defects require a
C++-derived or an unresolved-operand program, so they are narrower — general to
the *contract* but not exercised by every program.

## 8. "Doesn't compile" is not one bug

The Stage 2 count already showed 160/160 cases are *mixed*. Stage 3 explains why
a single fix is not available:

- **Contract-level (needs a new TU ownership boundary):** prototypes, global
  declarations, runtime/intrinsic declarations, entry-point signature. These have
  no home in the current output model.
- **Emitter-level (fixable inside one function):** missing declaration block,
  label/goto insertion anchors, unresolved-operand `?`, argument-vs-signature
  disagreement, mangled/dotted/`$` names, duplicate placeholder names.
- **Vocabulary-level:** the two type-name tables.

A prelude would remove the vocabulary clusters and the `unknown_call` implicit
declarations, but it would not touch the 4,378 emitter-scoped first failures, and
it cannot make a single case compile while a label sits in the declarator or a
`goto` sits at file scope.

## 9. Confidence and limits

- High confidence: §1-§6 and every cluster with `confidence: high` in
  `root-causes.json` — each is backed by an exact `file:line` and a reproduced
  snippet.
- Medium: `A-MISSING-TYPE-DECL`, `B-UNDECLARED-CONDITION-TEMP`,
  `C-CASCADE-RECOVERY`, `B-STRING-CONCAT-EMISSION`, and
  `B-UNRESOLVED-OPERAND-PLACEHOLDER` (the `?` emitter's call site was narrowed to
  `printExpression` but not to a single statement).
- Not established: whether the *semantic* route or the *legacy* route produced
  each individual benchmark blob. The corpus embeds the legacy `decl` block in
  416 blobs, so both routes are represented, but the artifacts carry no
  per-function route field. This does not change any finding (both routes are
  traced), but it is an unknown.
- Host compiler only (x86_64 clang 14). Not ARM64 native evidence.
- Nothing here measures Hex semantic correctness; a function with an undeclared
  `local_m4` can still have a correct body.

## Artifacts

| file | content |
|---|---|
| `root-causes.json` | 32 clusters joined to root cause, contract, metadata status, source locations, generality |
| `single-function-probe.json` | focused probe: per-case and sampled per-blob single-function results |
| `harness/root-causes.py` | joins taxonomy + mapping + recomputed generality |
| `harness/probe-single-function.py` | the isolation probe (full per-blob record stays in `/tmp`) |
