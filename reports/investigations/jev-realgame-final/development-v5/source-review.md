# recovery-v5-design — independent source-only design + adversarial review

**Lane:** jev-realgame-final recovery v5 (authorized continuation of accepted V4 source review).
**Mode:** READ-ONLY. 0 API calls, 0 extra agents, 0 source edits. Exactly two focused named tests run
(both pre-existing files, no fixtures written). `TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch`
set on every command. No gold/holdout/oracle/snapshot/results/README/metrics read.
**Root:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
**Worktree HEAD:** `92f7c880dadaea0c93ab11abdf63712c98e7144d` (`92f7c880d`).
**No production authorization is granted by this document.** Parent verification required.

This review covers (A) the **already-implemented** generic structured-ABI owner fix in
`js/rtti.js` + `js/analysis/cxx/object-evidence.js` and its test, reviewed against the compiler
receipt, (B) the **V5 design** for a bounded interactive extension that incorporates remote
retrieval without losing the original candidate facts or original exact/strong output, and (C) an
additional source-only assessment of Itanium **literal template arguments** (`L … E`) as a bounded
eligibility gap, confirmed against an independent g++ 11.4.0 fixture. No source is edited.

---

## 0. What was actually reviewed (and the verification anchors)

Parent's stated change is the secondary item of the checkpoint prompt: replace the
`demangled.split('::')` owner heuristic in `analyzeFunctionSymbol` with structured outer-ABI
name-component parsing, exported as `cxxAbiFunctionIdentity`. The diff is exactly three files,
53 insertions / 15 deletions:

```
 js/analysis/cxx/object-evidence.js               | 21 ++++++++-------------
 js/rtti.js                                       | 23 +++++++++++++++++++++--
 tests/phase7/cxx/typed-argument-binding.test.mjs | 24 ++++++++++++++++++++++++
```

**Anchor 1 — working tree equals the stored repaired snapshots byte-for-byte.**
`js/rtti.js` == `abi-template-owner/rtti.js.repaired` and `js/analysis/cxx/object-evidence.js` ==
`abi-template-owner/object-evidence.js.repaired` (both `diff -q` clean). So the reviewed source is
exactly what the parent ran the compiler receipt and old-source negative against.

**Anchor 2 — old-source negative reproduces the bug and is fixed in the reviewed tree.**
`regression-receipt.json` records `oldSource 92f7c880d` (the HEAD), `oldSourceTestExit 1`,
`repairedSourceRestored true`. `old-source-negative.log` shows the pre-fix assertion:
`actual 'Widget::get<abc'` vs `expected 'Widget'` for `_ZNK6Widget3getIN3abc1XEEEiv` — the exact
misattribution described in the prompt (`Widget::get<abc`). The reviewed tree contains the fix.

**Anchor 3 — independent compiler receipt.** `compiler-verification.json`
(`independentCompiler: g++11.4`, `complete:true`) confirms two positive identities:
`_ZNK3BoxIN3abc1XEE3getEv → Box<abc::X>::get() const` and
`_ZNK6Widget3getIN3abc1XEEEiv → Widget::get<abc::X>(int, void) const`.

**Focused tests run (2, named, both PASS):**

| test | file | result |
|---|---|---|
| `ABI component boundaries keep method template namespaces out of owners` | `tests/phase7/cxx/typed-argument-binding.test.mjs` | ✔ 1/1 pass (`11.70 ms`, exit 0) |
| `only outer ABI role tokens prove constructors, destructors or const members` | same file | ✔ 1/1 pass (`2.87 ms`, exit 0) |

No suite, typecheck, build, or API test beyond these two was run in this lane. The stored
`userscript-build.log` (parent-run, `built dist/ with 7030ffa31ac…`) is read as a receipt only.

---

## Part A — Adversarial review of the structured-ABI owner fix

### A.1 What the code now does (verified by reading, then by the two tests)

`js/rtti.js`:
- `readNested` (outer nested name, `captureFunctionRole===true`) now also records, at the outer
  `E`, a **component segmentation** of the collected `parts`: a part that begins with `<`
  (template-argument list) is appended to the *preceding* component; every other part starts a new
  component. `functionIdentity = { owner: components.length>=2 ? components.slice(0,-1).join('::') : null, method: components.at(-1) }`.
  A leading template part with no preceding component returns `null` (fail-closed).
- New exported `cxxAbiFunctionIdentity(name)`: requires `_ZN`, a valid outer `readName` with
  `captureFunctionRole`, a complete `readArgs` to end-of-string (`p.i === s.length`), and returns
  `{...functionRole, ...functionIdentity}` frozen, else `null`. Comment states the contract
  ("An exact outer ABI function name, not a split of a display signature").
- `cxxAbiFunctionRole` is now a thin projection (`kind`, `constQualified`) of the new identity
  function, preserving its old return shape and full-length validation for the other consumer
  (`js/analysis/cxx/class-type.js:12`).

`js/analysis/cxx/object-evidence.js` `analyzeFunctionSymbol`:
- Drops the `demangled.indexOf('(')/split('::')` heuristic entirely.
- `const abiRole = cxxAbiFunctionIdentity(sym)`. If `!abiRole?.owner`, returns
  `isFreeFunction:true, isMember:false, isConstructor/isDestructor/isConstMember:false`, with
  reason `'unverified-function-name'` when the parser rejected it (vs `'no-class-qualifier'` when
  it parsed but had <2 components). Otherwise `className = abiRole.owner`, `methodName = abiRole.method`.

### A.2 Findings

**A2-1 (verified correct — the reported bug is fixed).** For
`_ZNK6Widget3getIN3abc1XEEEiv` the component segmentation yields
`parts=['Widget','get','<abc::X>'] → components=['Widget','get<abc::X>'] → owner='Widget', method='get<abc::X>'`.
Matches the g++11.4 receipt and the new test. `_ZNK6WidgetIN3abc1XEE3getEv → Widget<abc::X>/get`
and `_ZNK3abc6WidgetIN3def1XEE3getIN3ghi1YEEEiv → abc::Widget<def::X>/get<ghi::Y>` also segment
correctly: a namespace inside a template argument can no longer leak into the owner, and a template
argument on the method can no longer leak into the owner. This is a strict improvement.

**A2-2 (verified fail-closed).** Malformed/unusual `_ZN` encodings now produce
`isFreeFunction:true` instead of a guessed member. In `extractCppObjectEvidence` such a symbol
only becomes a receiver when `hasVtableMembership` independently proves it — the name classifier
grants no ownership. `project.js:388-405` still filters multi-owner vtable sets through
`primaryOwnerFor` + the alias veto, and the typed-argument path still requires canonical evidence
and `enableTypedArguments`. The fix cannot widen a receiver proof; it can only *narrow* name-derived
candidates.

**A2-3 (behavior change that must be measured — coverage surface).** `demangleCxx` and
`cxxAbiFunctionIdentity` share the same `readNested`, but the identity path is stricter: it
validates ctor/dtor tokens (`captureRole && /[123]/` for `C`, `/[012]/` for `D`) and requires a
complete `readArgs`. Therefore symbols that `demangleCxx` accepts but the identity parser rejects
(e.g. the malformed `_ZN3FooC9Ev`, asserted `isCxx:true, isConstructor:false` by the older test)
move from `isMember:true` to `isFreeFunction:true`. This is the intended safe posture, but it is a
**real reduction of the name-derived candidate set**. Consumers of `info.className` that must be
re-audited for the drop:

- `js/analysis/cxx/query-recovery.js:53` — `info.className` feeds `declaringOwner` and the
  `className = … ?? info.className` fallback. A formerly member-classified row whose `className`
  disappears now `continue`s at the `!symbolProof && names?.size!==1 && !declaringOwner && !argumentProof`
  gate and leaves `choices()`. This is precisely a *function-choice shortlist coverage* loss and
  must be counted, not assumed negligible.
- `js/analysis/cxx/project.js:218` — `symbolOwners` set for the alias veto: dropping an
  unverifiable owner there is arguably *safer* (fewer aliases), but changes the alias size used by
  the `project.js:395` veto, so it can change which shared functions are considered proven.
- `js/analysis/cxx/project.js:422` and `scripts/validate-pinpoint-cxx-members.mjs` — same
  classifier; no ownership is granted, so impact is limited to candidate selection.

**A2-4 (test quality).** The new test is genuinely adversarial and exercises the real projection
path, not just the parser: for each positive case it builds a provider, calls
`projectForFunction`, and asserts `receiver.classIdentity.className === owner` and that the member
index contains exactly one class with that name. It also asserts the malformed negatives return
`className === undefined` and that an ordinary (non-const) qualified method gets `owner='Widget'`
with `isConstMember:false` — i.e. it explicitly encodes "an ordinary source-qualified method is not
a receiver proof." This is the correct shape for the requirement.

**A2-5 (compiler-fixture gaps — adversarial coverage).** The compiler receipt independently
confirms only the **two positive** identities. It does **not** cover:
- the multi-scope case `abc::Widget<def::X>`,
- `operator<<` / `operator()` (the `symbols.txt` shows only `_ZNK8OperatorclEv.isra.0` /
  `…lsEi.isra.0` local clones, i.e. the bare `_ZNK6WidgetclEv` / `_ZNK6WidgetlsEi` used by the test
  are **parser-only assertions**, not compiler-verified),
- any negative/malformed encoding (only parser-asserted).
So the claim "adversarial compiler fixture coverage" is only partly satisfied. The independent
compiler validates the *positive* boundary; the *adversarial* boundary is self-asserted.

**A2-6 (no regression on the ABI-tag case).** I checked the obvious worry that stricter parsing
could drop ABI-tagged members (`B5cxx11`). It cannot: `demangleCxx` uses the same `readNested`,
which rejects `B…`, so those symbols were already `cxx-demangle-failed` before this change. The net
classification delta is confined to `_ZN` symbols that demangle but fail identity validation (A2-3).

### A.3 Part A verdict

The fix is **correct, minimal, and fail-closed**, with a materially better test than the one it
replaces. It does not, on its own, claim or cause any real-game recovery improvement (correctly not
claimed). Its only residual risk is the (intended, unmeasured) narrowing of the name-derived
candidate set in A2-3/A2-5.

---

## Part B — V5 bounded interactive extension design (remote retrieval vs reranking)

### B.1 Current wiring (verified)

- `selectJevRecoveryPlan` (`js/analysis/query/jev-recovery.js`) sends `planner.choices(query,{maxChoices:255})`
  (≤255 rows) and, only if `object` and `pick` agree on class, returns
  `planOwner(query, selected.className, {firstAddress: selected.address})`. Any failure — disabled,
  no client, stale (`isCurrent()!==true`), query >2048, <2 choices, timeout/invalid timeout,
  non-`openjev` payload, malformed choice/confidence/probabilities, class disagreement, exception —
  returns the **captured Hex fallback** (`planner.plan(query)`, `source:'hex'`). No confidence
  *threshold* is applied; confidence/probabilities are used only for well-formedness. This satisfies
  the "fail/error/timeout/malformed/stale → captured Hex unchanged" and "no post-hoc confidence
  threshold" constraints and should be preserved verbatim. **Scope note:** this pre-analysis
  selection-time fallback is distinct from a stale *snapshot during publication*, which must
  **cancel** rather than return a stale captured answer (B.4.2).
- `recoverCxxMembersForQuery` (`js/analysis/query/app-adapter.js`) forbids remote retrieval in the
  extension stage: `if(options.unpublishedOwnersOnly===true && options.jevRetrieval===true) throw`.
  The extension (`object-context-v4`) is local-only and `excludeOwners` already-recovered owners.
- `recoverCxxQueryStages` (`query-recovery.js:160`) captures a baseline before extension, computes
  `represented` from owner tokens, and only extends when the local result is not already
  strong/represented and budget remains. Its comment already states the key accounting rule:
  *"more recovery is not counted as remote reranking gain."*

### B.2 Where function-choice shortlist coverage is lost (the core problem)

Four distinct loss points, in priority order:

1. **The `symbolProof` gate excludes ordinary methods from `choices()`** (`query-recovery.js:56`:
   `const symbolProof = info.isConstructor||info.isDestructor||info.isConstMember;`
   then `if(!symbolProof && names?.size!==1 && !declaringOwner && !argumentProof) continue;`).
   A plain non-const, non-ctor/dtor qualified method with no unique vtable slot and no typed-arg
   proof never enters `choices()` — so **no selector over `choices` can ever pick it**. This is the
   literal source of "a source-qualified ordinary method alone cannot prove nonstatic ownership"
   and the main reason semantically relevant release methods are missed. It is a *deliberate* proof
   gate and must not be loosened to a proof; any change here must keep proof fail-closed (B.3).
2. **Lexical `score>0` filter in `plan()`** (`plan`: `scoreRows(phrase).filter(row=>row.score>0)`).
   Zero-class-token-overlap owners (measured 5/37 in prior V3 evidence) are not reachable by the
   local plan and, when they are also absent from `choices`, not by remote retrieval either.
3. **Category mismatch**: `choices()` is emitted while the local `plan()` is score-ranked, so the
   remote selector sees a *different* candidate order than the local plan; the selected owner may
   not be in the local plan at all, which is the retrieval gain (if any).
4. **The implemented ABI fix (Part A) narrows name-derived candidates** (A2-3): rows that lose
   `className` under `cxxAbiFunctionIdentity` also leave `choices()`. This must be measured before
   attributing any V5 retrieval delta to the model.

### B.3 Receiver proofs remain fail-closed (invariants V5 must not touch)

- Name classification only produces an owner *candidate*; `isMember:true` is never a `this`.
  Publication proof stays `extractCppObjectEvidence` + `project.js:388-405` splice +
  `primaryOwnerFor` + alias veto + thunk/static/typed-argument gates.
- A row may be labelled as a retrieval-selected *analysis directive* only. The selected class must
  be required to exist in `choices` and to be backed by a proven row; otherwise discard the remote
  answer pre-analysis and use the Hex plan (a selection failure, not a stale-snapshot publication).
- No new analysis pass, no byte/model read in the selection layer, no source/DWARF read.

### B.4 Transaction, preservation, and conflict handling (must be explicit)

Reanalyzing an owner that already has canonical fields can widen or conflict with the class and
change `fieldCount`/`revision`; that — **not** plan ordering — is how original exact/strong output
can be disturbed. A stable Hex plan prefix is **not** a preservation guarantee. V5 must treat every
retrieval-directed decompile as a transaction:

1. **Capture before-state**: existing `beforeCount`/`beforeRevision` capture in
   `recoverCxxMembersForQuery`, plus the `checkBinding()` (symbols gen + `memberIndex()` identity +
   snapshot generation) before and after each `decompile`.
2. **A stale snapshot cancels; it never republishes a captured answer.** A binding change during or
   after a retrieval-directed analysis is an abort: propagate cancellation and surface the
   stale-binding error. Do **not** return or publish the captured Hex answer as a current result —
   once the binding moved, that answer is stale by construction. `checkBinding()` throwing is the
   **cancel** signal, not a fallback trigger. (Distinct case: a *remote-selection* failure before
   any analysis — timeout/malformed/disabled/binding moved before analysis — legitimately falls back
   to the Hex plan, because nothing stale has been published yet; that pre-analysis fallback stays
   as-is.)
3. **Owner exclusion on extension (primary preservation mechanism)**: `excludeOwners` (all
   already-recovered classes) must remain on the extension plan, and where possible on the primary
   retrieval-directed plan too; remote retrieval must not be allowed into the extension stage (keep
   the existing `throw`). Excluding already-published owners is what prevents conflicting
   reanalysis in the first place.
4. **Conflicting canonical observations are retained, never silently rejected.** If a
   retrieval-directed analysis observes fields that contradict an existing canonical record (same
   `ownerKey`, different field set/digest), do **not** delete/overwrite the prior record and do
   **not** drop the new observation — discarding either hides a binary fact. Instead apply one of:
   (a) prevent the situation by excluding already-published owners from reanalysis (item 3); or
   (b) record both observations in an independently bound staging transaction with an explicit
   conflict marker, keeping each attributable and reversible. Count it as `conflict` (never as
   gain); never resolve a conflict by discarding a fact and never under a post-hoc threshold.
5. **State separation**: a V5 retrieval attempt must not mutate the planner cache
   (`CXX_QUERY_PLANNERS`) or the provider; the only mutations allowed are decompile-produced member
   records inside the bound snapshot.

### B.5 Measuring remote retrieval vs reranking gains separately

Define the following disjoint, per-query counters over the *same* decompile set (no extra passes):

- `retrievalReachableOwner` — was the selected class present in `choices`? If not, the miss is
  **pool-limited**, not reranker failure (do not score it as model quality).
- `retrievalNovelOwner` — selected owner differs from the local plan's top owner → gain attributable
  to **retrieval** (changing *who* is attempted).
- `rerankingReordered` — same owner, selected address appears earlier than in the local plan and is
  reached within budget → gain attributable to **reranking** (changing *order* for the same owner).
- `conflict` / `bindingCancel` — counted separately, never counted as gain, and never resolved by
  discarding one of the two observations.
- `recoveryDelta` — `afterRevision - beforeRevision` via the existing `cxxRecoveryMadeProgress`.
  Only count *publishing* attempts; `recoverCxxQueryStages`' existing "more recovery is not remote
  reranking gain" rule stays authoritative: extension-stage recovery must be excluded from the
  remote gain accounting.

Report both the **Hex-only baseline** and the **retrieval-enabled** run on the same queries and the
same budget, so retrieval vs reranking deltas cannot double-count.

### B.6 Safe alternatives (prefer additive over replacing)

- **A1 (recommended): additive plan, with preservation from exclusions/staging — NOT from the plan
  prefix.** Never replace the Hex plan; compute it first, mark its entries `source:'hex'`, and append
  up to N retrieval-directed addresses not already present, each `proven:false`. **A stable Hex
  prefix guarantees only scheduling intent; it does not guarantee that publication preserves
  existing members.** The appended analyses feed the same canonical member lattice and can conflict
  with, reorder, merge, or widen members an earlier attempt already published. Preservation must
  instead come from (i) excluding every already-published owner from reanalysis (owner exclusions),
  or (ii) an independently bound staging transaction (B.4).
- **A2: dry-run verification.** Run the same well-formedness checks as today, plus
  `choices.some(row=>row.className===selected.className && row.address===selected.address)`; if not
  satisfied, discard the answer.
- **A3: coverage instrumentation first.** Before changing the selector, measure B.2 loss points
  (rows dropped by the `symbolProof` gate; rows that lose `className` under the new ABI parser;
  zero-overlap owners) on the real games. Adopt the selector change only if the measured pool
  actually contains the missing owners.
- **A4: bounded exploration only via unused budget** (not a percentage/random tranche, which was
  already withdrawn): append deterministic score-0 owners only when the local plan is short of
  `maxFunctions`.
- **A5: ordinary-method candidates never grant proof.** If A3 shows ordinary methods are needed,
  admit them to `choices` as retrieval candidates but require the existing publication gates to
  prove ownership; never label an ordinary method `non-static`. This keeps B.3 intact.
- **Explicitly rejected:** post-hoc confidence thresholds, query/class/address/game exceptions,
  extra Fast passes, bulk analysis, random or percentage-based exploration defaults.

### B.7 Concrete implementation scope (no new passes; ≤16 functions; ≤255 choices)

| File | Bounded change |
|---|---|
| `js/analysis/query/jev-recovery.js` | Keep the fallback contract verbatim. Add a post-answer `choices`-membership check (A2) and preserve `retrievalSource`. No new budget. |
| `js/analysis/query/app-adapter.js` | Keep the `unpublishedOwnersOnly && jevRetrieval` prohibition. Retain the Hex plan and append retrieval-only addresses (A1), but enforce preservation via owner exclusions or an independently bound staging transaction (B.4) — not via the plan prefix. Cancel on stale binding rather than republishing a captured answer. Thread the B.5 counters into the returned result. |
| `js/analysis/cxx/query-recovery.js` | Optional: expose the coverage counters of B.2 (no scoring change) and keep `excludeOwners` on the extension. |
| `js/analysis/cxx/object-evidence.js` / `js/rtti.js` | No further change required for V5; A2-3 measurement is read-only. |

All changes are scheduling/ordering/accounting over already-proven rows plus one selection-membership
check. None adds an analysis pass, reads bytes/source/DWARF, or touches a proof gate.

---

## Part C — Literal template arguments (`L … E`): a bounded eligibility gap (assessed, not implemented)

**Hypothesis under test:** `readType` does not decode Itanium literal template arguments
(`<expr-primary> ::= L <type> <value> E`), so constructors/const methods on class templates with
integral/enum non-type parameters remain unsupported. **Verdict: CONFIRMED at source and at the
compiler, and it is a complete eligibility loss, not merely an owner-misattribution.**

**C.1 Source cause.** `js/rtti.js` `readType` handles `P R O K V N S I`, source-name digits and
builtins, but has no `L` branch. `readTemplateArgs` calls `readType` for every argument; an `L…`
argument returns `null`, so `readNested` returns `null` and **both** `demangleCxx` and
`cxxAbiFunctionIdentity` fail. The shared parser means the vtable/typeinfo class-name derivation
(`findCxxClasses`) fails on the same symbols too.

**C.2 Read-only probe (current tree, no edits).** Every literal-arg symbol tested returns
`demangle=null`, `className=undefined`, `isCxx=false`, `reason='cxx-demangle-failed'`:
`_ZN3FooILi5EEC1Ev`, `_ZNK3FooILi5EE3getEv`, `_ZN3FooILi5EE3getEv`, `_ZN3FooILin5EE3getEv`,
`_ZN3FooIL4Colori0EEC1Ev`, `_ZTV3FooILi5EE`, `_ZN3FooIXpl1ELi2EEE3getEv`, `_ZN3FooIL_Z3barvEE3getEv`.
Because `isCxx=false`, these rows are dropped before every planner gate — they never reach
`choices()` and cannot be retrieved by any selector.

**C.3 Independent compiler receipt (g++ 11.4.0, scratch fixture `v5-literal-abi.cpp`).** Confirms
the exact mangling forms and that a bounded decoder is well-defined:

| emitted symbol | g++ `nm -C` |
|---|---|
| `_ZN3FooIN3abc1XELi5EEC1Ev` | `Foo<abc::X, 5>::Foo()` |
| `_ZNK3FooIN3abc1XELi5EE3getEv` | `Foo<abc::X, 5>::get() const` |
| `_ZN3FooIN3abc1XELin5EEC1Ev` | `Foo<abc::X, -5>::Foo()` (negative: `Lin5E`) |
| `_ZN3BazIL5Color0EEC1Ev` | `Baz<(Color)0>::Baz()` (enum: `L5Color0E`) |
| `_ZNK3BazIL5Color0EE3getEv` | `Baz<(Color)0>::get() const` |

The literal sits *inside* the `I…E` template-argument list, so the Part A component segmentation
(a `<`-prefixed part appends to the preceding component) already places it correctly once `readType`
can consume it: `…Foo I <abc::X> <5> E C1 E v → owner='Foo<abc::X, 5>', method='Foo'`. The enum type
name inside `L5Color0E` is likewise absorbed into the template-argument component and can never
leak into the owner.

**C.4 Fail-closed grammar a bounded decoder must obey.**
- Accept **only** `L <type> [n] <digits> E` with a canonical non-negative integer in the digits
  position, bounded (e.g. ≤64 digits) and consumed exactly so `p.i` stays correct; display the
  literal opaquely (its numeric rendering need not be independently meaningful for identity).
- Accept any <type> the existing `readType` already decodes (integral/enum/bool/char), so
  `Li5E`, `Lin5E`, `Lb1E`, `L5Color0E` work.
- **Reject** `X <expression> E` (dependent expression) and `L <mangled-name> E`
  (pointer/reference-to-name literal) by returning `null` — do not guess. On any unrecognized
  byte, return `null` exactly as today.
- No new state, no analysis pass, no unbounded scan; reuse the existing `guard<64` argument budget.

**C.5 Why this does not guess ordinary methods.** The decoder only restores *parsing*. Eligibility
still flows through the unchanged `symbolProof = isConstructor||isDestructor||isConstMember` gate:
`Foo<5>::Foo()` and `Foo<5>::get() const` become eligible; `Foo<5>::get()` (ordinary non-const) does
**not**, so no ordinary qualified method gains ownership. Publication proof is untouched. The change
is therefore additive to proof-backed eligibility, which is exactly the property V5 needs.

**C.6 Independent compiler fixture requirements (extend `abi-template-owner/`, not self-assert).**
1. Add to `compiler.cpp`: a class template with an `int` non-type parameter and an `enum`
   non-type parameter (plus a negative value), explicitly instantiated, with `noinline`/
   address-taken members so the emitted symbols are the bare `_ZN…C1Ev` / `_ZNK…3getEv` forms
   (the probe above produced bare `W` symbols; `.isra.0` clones appeared only for non-noinline
   helpers in the existing fixture).
2. Emit a vtable-bearing instantiation (keep RTTI) so `_ZTV…` name derivation is cross-checked.
3. Record compiler id/version and the demangled output in `compiler-verification.json`, and assert
   that the project's `demangleCxx` equals `nm -C` for each symbol (independent identity, not
   self-consistency).
4. Assert fail-closed `null` for `X…E` and `L<mangled-name>E` (parser-only; a compiler cannot emit
   these for a non-dependent instantiation).

**C.7 Scope interaction.** This is a fourth way the shortlist is narrowed beyond A2-3 (B.2), and it
is unrelated to the Part A fix. It should be measured alongside the A2-3 drop. Recommendation:
treat the `L`-decoder as its own bounded, independently-fixtured change (C.4/C.6), sized within the
same ≤16-function / no-new-pass budget, and only claim eligibility recovery after the C.6 receipt
exists. Scratch fixture: `completion` evidence under
`/mnt/workspace/.dev-state/agent-work/scratch/v5-literal-abi.cpp`
(sha256 `7d0896c4f538f71a3964e1c8199779545bc956c6ae6004ce23ee87347710f9fd`), object
`v5-literal-abi.o` (sha256 `d2ed3002ee30119ddab05b67a9f45e8f1e97fc05a71cd076fc381b875c7eb22d`).

---

## Exact hashes (sha256)

Reviewed working-tree source (`HEAD 92f7c880dadaea0c93ab11abdf63712c98e7144d`):

| path | sha256 |
|---|---|
| `js/rtti.js` | `c975acea2fd5e3130480f8e8af61549060dae3c48fc5309cf588f38bb2b90ff5` |
| `js/analysis/cxx/object-evidence.js` | `180a970f6cad2057b2d9e3a0a21149668f9cc267bdca732bd07b7236c1e9b9f1` |
| `tests/phase7/cxx/typed-argument-binding.test.mjs` | `4bf9ff2beac7b1248891b6fc51ddc3e4611899182d03ab5962dec63be08d6ed2` |
| `js/analysis/query/jev-recovery.js` | `dddcef89cddb9352fddcfbed34b0449501d6064ccfd42aa85f9fd4ccc118f393` |
| `js/analysis/query/app-adapter.js` | `8da96037bb8da71ab5494528b9e529ca7d04f00e1ca4b27342dc8b95570ef097` |
| `js/analysis/cxx/query-recovery.js` | `3a22e8d6858526e1e2b9ebddcc0aaa863949ef63fc4ad9a85bf301df5283f67b` |

Evidence inputs (`…/evidence/jev-realgame-final/abi-template-owner/`):

| path | sha256 |
|---|---|
| `compiler-verification.json` | `3224831e6a1aa39664b50158e0ea52e485e3c9d5c4df9b20078b4525d8c79ccd` |
| scratch `v5-literal-abi.cpp` (Part C probe, not product) | `7d0896c4f538f71a3964e1c8199779545bc956c6ae6004ce23ee87347710f9fd` |
| scratch `v5-literal-abi.o` (Part C object) | `d2ed3002ee30119ddab05b67a9f45e8f1e97fc05a71cd076fc381b875c7eb22d` |
| `compiler.cpp` | `c11aa3f716efeeaa32f0ef308656dde80c3a26ef42e1cc8943eb5a578bbd1106` |
| `symbols.txt` | `e5352f0853837267ba58eb278a442ce44036de309d465dde7868bb04db2ab5b1` |
| `regression-receipt.json` | `72cc0475e7d3da7524f3a24050f4e6e731ed5756895c8768e9a5dd3444e1b929` |
| `old-source-negative.log` | `739c8059b52cb6a77f9fdee00ab0fb3388d6c5ef5212a1627f6cc11393865e6d` |
| `rtti.js.repaired` | `c975acea2fd5e3130480f8e8af61549060dae3c48fc5309cf588f38bb2b90ff5` (= working tree) |
| `object-evidence.js.repaired` | `180a970f6cad2057b2d9e3a0a21149668f9cc267bdca732bd07b7236c1e9b9f1` (= working tree) |

`compiler-verification.json` internal: `complete:true`, `independentCompiler:g++11.4`.
`regression-receipt.json`: `oldSource:92f7c880d`, `oldSourceTestExit:1`, `repairedSourceRestored:true`.

---

## Blockers (must be resolved before any recovery-scope claim)

- **B-1 (coverage regression unmeasured — parent measuring).** No receipt yet quantifies how many
  rows lose `className` under the stricter `cxxAbiFunctionIdentity` (A2-3), nor the pre/post
  `choices()` pool coverage on the real games; **parent is measuring release-symbol classifier
  coverage to close this.** Until then an observed recovery delta cannot be separated from the ABI
  fix.
- **B-2 (adversarial compiler fixture incomplete — parent extending).** The independent g++11.4
  receipt covers only the two positive identities; `operator<<`, `operator()`, the multi-scope `abc::Widget<def::X>` case,
  and all negative/malformed encodings are parser-only assertions (A2-5). Extend `compiler.cpp`
  with `asm`/`noinline` or match the emitted `.isra.0` symbol, and add a negative symbol to the
  receipt, before calling the fixture "adversarial compiler coverage." The Part C literal-argument
  forms (`Lin5E`, `L5Color0E`, `_ZTV…ILi5EE`) have an independent g++ 11.4.0 receipt in this lane
  but are **not** yet in `abi-template-owner/`; fold C.6 into the same fixture extension.
- **B-3 (source-only: no full green suite — still pending in this lane).** Only the two named
  focused tests were run (per instruction). No repository typecheck, lint, phase7, or build
  verification was performed here. The stored `userscript-build.log` is parent-run.
- **B-4 (source-only: V5 extension unimplemented — still pending).** The design in Part B is a
  proposal; no source exists for the counters, additive plan, membership check, transaction/staging,
  or cancellation handling. Nothing here authorizes production changes.

---

## Proposed recovery scope (for parent judgment; not authorized here)

1. **Land Part A as-is** once B-2 (compiler fixture gap, parent extending) is closed; no further
   source change to `js/rtti.js` / `object-evidence.js` is proposed here.
2. **Add Part C as a separate, independently-fixtured change** (bounded `L…E` decoder per C.4 + C.6
   receipt); it restores ctor/dtor/const eligibility for integral/enum template arguments without
   touching any proof gate. Do not bundle it silently into Part A.
3. **Close B-1 first** (parent measuring classifier coverage): publish the B.2 pre/post loss counts.
   If the `symbolProof` gate provably excludes needed owners, prefer A5 (candidates without proof)
   over loosening the gate.
4. **Implement the V5 extension as A1 + A2 only**, with preservation enforced by owner exclusions or
   an independently bound staging transaction (B.4) — **not** by the Hex plan prefix — and with
   stale-binding **cancellation** (never a stale captured answer). Include the B.5 counters, behind
   the existing interactive/explicit flags.
5. **Re-run the exact same query set** under Hex-only and retrieval-enabled with the same budget;
   report retrieval vs reranking separately, with pool-limited misses called out, and report
   `conflict`/`bindingCancel` separately from gain.
6. No production authorization, no default-on, no new pass, until B-1/B-2 receipts and a green
   suite exist.

## Limits (no softening)

- Selection is never proof; the ABI owner fix narrows candidates and cannot widen a receiver proof.
- **A stable Hex plan prefix is not a preservation guarantee:** publication can still conflict with
  or reorder existing members, so preservation must come from owner exclusions or a bound staging
  transaction, and contradictory canonical observations must be retained (never silently rejected).
- **A stale snapshot cancels; it never returns a stale captured answer.** A captured Hex result is
  only a fallback for a pre-analysis selection failure, not for a moved binding during publication.
- One Fast call can overrun the window; no lookahead promises near-target latency.
- Zero-overlap owners outside `choices` are unreachable by any selector over `choices`.
- This document is an independent source-only review with two focused test executions; parent
  verification and implementation are required.


# recovery-v5-delta — independent source-only review of the corrected V5 delta

**Lane:** jev-realgame-final recovery v5 delta. **Mode:** READ-ONLY. 0 API calls, 0 extra agents,
0 source edits, exactly two focused named tests run. `TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch`
set on every command. No gold/holdout/oracle/results/README-metrics read (the committed
`default-v4/results/*` and `snapshots/*` were deliberately not opened).
**Root:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
**HEAD:** `a48ce5c424d5cc2c326b681f4e46dd72c5b6359e` (`a48ce5c42`, parent commit preserving V4
evidence; the reviewed delta is the uncommitted working-tree change on top of it).

This receipt reviews the correction pass after `recovery-v5-design.md`: the literal template-argument
support in `js/rtti.js`, the `semantic-retrieval-v5` shortlist in `js/analysis/cxx/query-recovery.js`,
the two extended independent compiler fixtures, and the two durable release-coverage measurements.

---

## 0. Verification anchors

- Working tree still matches the stored repaired snapshots for the Part A files
  (`js/analysis/cxx/object-evidence.js` sha256 `180a970f…` unchanged; the `rtti.js.repaired`
  snapshot is the pre-literal revision, superseded by the new `js/rtti.js`).
- The four new durable fixtures exist and are well-formed JSON with `complete`/count fields that
  I re-derived independently (below), not merely read.
- Two focused named tests pass; no suite, build, typecheck or API run.

**Focused tests run (2, named, both PASS):**

| test | file | result |
|---|---|---|
| `integral and enum template arguments retain exact ABI owner and receiver proof` | `tests/phase7/cxx/typed-argument-binding.test.mjs` | ✔ 1/1 pass (`11.90 ms`, exit 0) |
| `V5 retrieval retains matching owner depth and broad exploration without adding receiver authority` | `tests/phase7/cxx/jev-recovery.test.mjs` | ✔ 1/1 pass (`36.99 ms`, exit 0) |

---

## 1. Source delta reviewed

### 1.1 `js/rtti.js` — bounded integral/enum literal decoder (Part C implemented)

`readTemplateArgs` now dispatches `p.s[p.i]==='L'` to new `readIntegralTemplateArgument(p)` instead of
`readType(p)`; `readType` itself is unchanged. The new decoder implements Itanium ABI 5.1.6.1
`L <type> <number> E` with the following **fail-closed** grammar (verified by reading and by the
negative assertions in the new test):

| input | behavior |
|---|---|
| builtin integer/char/bool codes `b c a h s t i j l m x y n o` | accepted, value rendered (`2`, `-2`, `true`, `5ul`, …) |
| enum/class type (`N…E` or `[1-9]`/`S`), qualified-identifier only | accepted, rendered `(<type>)<value>` |
| float codes `f d e` | rejected (`readType` branch not taken) |
| `X <expression> E` | rejected (`readType('X')` returns null) |
| `L <mangled-name> E` (external name) | rejected (first type byte `_` fails the guard) |
| template-typed enum argument | rejected (type string fails the qualified-identifier regex) |
| leading-zero magnitude (`01`), `n` on unsigned/bool/char, out-of-range magnitude, `BAD` suffix | rejected |

Range checks: bool ≤1; unsigned bound `2^bits − 1`; signed bound `2^(bits−1) − (negative?0:1)`
(so `-2^(bits−1)` is admissible); non-builtin magnitude `< 2^128`; magnitude string ≤39 decimal
digits. It is invoked only from `readTemplateArgs`, matching the ABI (the literal appears only as a
template argument). It pushes no substitutions and adds no state.

**Assessment:** the decoder is strictly bounded, rejects every unsupported form, and — importantly —
a literal supplies only a name/identity token, never a member type or layout. It cannot grant a
receiver proof. This is the correct implementation of the Part C proposal.

### 1.2 `js/analysis/cxx/query-recovery.js` — `semantic-retrieval-v5` shortlist

- New policy added to the allowlist (and to the typed-argument recovery list in `app-adapter.js`).
- New `ownerScopeName(name)` strips `<…>` content (returns `null` on unbalanced brackets). Under v5,
  `classTokens` and the `exactObject` leaf are computed from `ownerScopeName(className)`, while the
  row's **`className` field keeps the full original identity** (`Box<Widget>`, not `Box`).
- `choices()` under v5 reserves `floor(maxChoices/2)` for depth within up to **8 query-matching
  owners** (`classHits>0`, sorted by `classHits` then `specificity`), then fills the remaining budget
  with the existing global round-robin, skipping already-seen addresses. The loop termination now
  continues while any group has a deeper row, so a one-method-per-class list cannot hide a late
  accessor of an already-present owner.

**Assessment:** this directly addresses the shortlist-depth loss. The new test proves the intended
properties: 255 unique choices, the late proven method becomes visible, non-matching owners keep
≥127 of the budget, ordinary qualified names remain unproven, `functionCount` is unchanged, and the
**local `plan()` is byte-identical to `value-accessor-v3`** (so ranking for publication is not
touched by the remote shortlist change).

**Scope wording note (not a defect, a precision):** the described change is "ignore class template
argument words when allocating focused owner budget," but `ownerScopeName` is applied to `classTokens`
and `exactObject` for **all v5 rows**, not only the focused tranche. The effect is still
scheduling/scoring only and the plan-equality assertion holds for the fixture; the stated scope
understates the code path.

### 1.3 `js/analysis/query/app-adapter.js`

`typedArgumentRecovery` now includes `'semantic-retrieval-v5'`, keeping the explicit-recovery gate
consistent with the new policy. No publication path change.

---

## 2. Parent measurement claims — independently verified

All figures below were re-derived from the durable fixtures by filtering the stored per-symbol
records, not read from summary text.

**2.1 Parser-owner-only change drops 0 real release names.** `release-coverage.json`
(`hex-cxx-abi-owner-coverage/v1`, `oldSource 92f7c880d`):

| game | defined `_ZN` symbols | ownerBefore | ownerAfter | lostOwners | changedOwners |
|---|---|---|---|---|---|
| openttd | 4514 | 3538 | 3538 | **0** | 0 |
| openmw | 25034 | 17771 | 17771 | **0** | **796** |

No owner name is lost; OpenTTD is byte-identical; OpenMW has 796 classifier-level owner
corrections (e.g. `sol::detail::comparsion_operator_wrap<Misc` → `sol::detail`). **These are
classification corrections, not publication/member changes.**

**2.2 Literal support adds 29 (OpenTTD) and 470 (OpenMW) ctor/dtor/const role names.**
`literal-release-coverage.json` (`hex-cxx-literal-owner-coverage/v1`), independently filtered:

| game | additionalVerifiedNameIdentities | of which ctor/dtor/const | reported `additionalNonStaticRoleNames` | symbols that lost `isCxx` | unparsed |
|---|---|---|---|---|---|
| openttd | 246 | **29** | 29 ✔ | 0 | 0 |
| openmw | 1145 | **470** | 470 ✔ | 0 | 0 |

`lostOwners` is empty in both; `correctedOwners` = 0 (TTD) / 796 (MW). The fixture's own `authority`
field states *"actual release ELF function names only; metadata coverage is not member recall"*,
which matches the parent's "metadata eligibility only, no member recall claim." No symbol regressed
from parsed to unparsed.

**2.3 Independent compiler fixtures close B-2.**
`compiler-extended-verification.json` (`independentCompiler g++11.4`, `complete:true`) records
**5 positive** identities — including the multi-scope `abc::Widget<def::X>::get<ghi::Y>`,
`Operator::operator()`, and `Operator::operator<<` that were previously parser-only — and
**5 malformed negatives** all resolving to `isCxx:false / cxx-demangle-failed`.
`compiler-literals-verification.json` records **5 positive** literal identities
(`IntBox<2>`, `IntBox<-2>`, `BoolBox<false>`, `BoolBox<true>`, `ModeBox<(abc::Kind)1>`) each with a
`compilerDisplay` cross-check (g++ demangler), and the emitted manglings are in
`symbols-literals.txt`. The new tests assert the negative literal forms (`Lb2E`, `Lin0E`, `Li01E`,
`Li2147483648E`, unsigned-negative, double, pointer, external-name, `BAD`) that a compiler cannot
emit.

**Conclusion:** B-1 (release-symbol classifier coverage) and B-2 (adversarial compiler fixture) are
**closed by parent-produced durable fixtures** for owner-classification/metadata-eligibility scope.

---

## 3. Residual blockers / limits (not closed by this delta)

- **No member-recall claim.** Both coverage fixtures measure owner/name classification and
  ctor/dtor/const eligibility, explicitly not publication or member recall. The 29/470 figures are
  **eligibility**, not recovered fields. V5's remote shortlist likewise grants no receiver authority
  (asserted by the test).
- **Publication transaction/cancellation still unimplemented.** The V5 delta covers the remote
  *shortlist* only. The B.4 constraints from `recovery-v5-design.md` (owner exclusions or an
  independently bound staging transaction; retain conflicting canonical observations rather than
  rejecting them; a stale snapshot must **cancel**, never return a stale captured answer) remain
  design requirements with no source.
- **B-3 (source-only: no full green suite) still pending in this lane.** Only the two named focused
  tests were run.
- **B-4 (source-only: end-to-end V5 extension unimplemented) still pending** for the transaction,
  staging, and accounting pieces; the shortlist portion is now implemented.
- **Minor, fail-closed:** the literal decoder rejects template-typed enum arguments and any
  `<number>` not encoded as bounded decimal digits; a compiler that emits a non-decimal literal form
  would simply remain unsupported (no wrong identity). `ownerScopeName` returns `[]` tokens on
  unbalanced input rather than guessing.

---

## 4. Fresh hashes (sha256)

Reviewed working-tree source (on HEAD `a48ce5c42`):

| path | sha256 |
|---|---|
| `js/rtti.js` | `74f18fffd7c2d7c0c920958172d8a7a855bd7f6354b670040fba4e0a661b3e35` |
| `js/analysis/cxx/object-evidence.js` | `180a970f6cad2057b2d9e3a0a21149668f9cc267bdca732bd07b7236c1e9b9f1` |
| `js/analysis/cxx/query-recovery.js` | `daae83d634391a328f0921dd7ddb257270627a15e9c82d1f32cb165d1d189dc6` |
| `js/analysis/query/app-adapter.js` | `4b2b9763c5ba37aedf8648d20f516a79b27549b5cf8272670f996a391a1c345b` |
| `tests/phase7/cxx/typed-argument-binding.test.mjs` | `246ab53511bfd83a5a55e9bef6d0297b8fa54fefb6b28700254296c075eb0e56` |
| `tests/phase7/cxx/jev-recovery.test.mjs` | `4548c6b83888b9ed80734503a5bd37ff4ff2e0b89f5af53271be43aeb9a30735` |

Durable fixtures (`…/evidence/jev-realgame-final/abi-template-owner/`):

| path | sha256 |
|---|---|
| `release-coverage.json` | `1f50e9ecf56d8937a711485813b2e62d22136664103212091b746695ff201798` |
| `compiler-extended-verification.json` | `65dc5a3d9fdc2d0655bd506acb699577aa9216a643b88430ab963c0ed3460426` |
| `literal-release-coverage.json` | `6d29f3a837e527e847e9bf852c1d6094be0d89e3f8ac9988f4062ab94b6e852c` |
| `compiler-literals-verification.json` | `28230ba531c1a5a5937d54954559643dde9756f526f743c2ac49f8198890c879` |
| `compiler-extended.cpp` | `cab457fda4890d1f01dde1b647d6fb9ca86094fd5b169557915392fda60f2e73` |
| `compiler-literals.cpp` | `27281321c44e934f7437454b1c6e5f57e8d09273054ddbb662451ed05a72361c` |
| `symbols-extended.txt` | `e9e4333ade6ddd9a147914a851d4cc0b9961fd04d6517aaf8a9fa431f3071866` |
| `symbols-literals.txt` | `21ad80ac0ce737e5784e5217f120f39fa5f86513754ab6c936610a92dfd36a7f` |

Prior receipt (unchanged): `recovery-v5-design.md` sha256
`a24a253abf9b163852e838b87d6f9afd00757bab140d8f2077dd16775e310d0d`.

---

## 5. Verdict

The delta is **correct and fail-closed**. The Part C literal decoder is bounded and grammar-strict;
the V5 shortlist restores owner depth without touching the local plan, without granting receiver
authority, and without adding an analysis pass; the four durable fixtures independently confirm
0 real release-name drops, 796 OpenMW owner corrections, and 29/470 newly eligible ctor/dtor/const
names as **metadata eligibility only**. B-3 and B-4 remain pending in this lane; the publication
transaction/cancellation design from `recovery-v5-design.md` is still unimplemented. No production
authorization; parent verification required.


# recovery-v5-safety — independent source-only review of the V5 safety successor

**Lane:** jev-realgame-final recovery v5 safety successor. **Mode:** READ-ONLY. 0 API calls,
0 extra agents, 0 source edits, exactly two focused named tests run.
`TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch` set on every command. No
holdout/oracle/results/README-metrics read; no binaries or collectors executed.
**Root:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
**HEAD:** `9b4dc9e8dff700427c11103a8e8b7a82dafb7e1c` (`9b4dc9e8d`, "Recover bounded ABI template
identities and expose proven method depth without trusting display renames"). Working tree is
**clean** (`git status -s` empty): the reviewed safety source is committed and stationary.

This receipt covers the **post-delta safety successor scope only** — the two repairs found by the
parent source audit and the collector's new `metadata-only` option syntax. It deliberately does not
present the earlier literal/shortlist hashes as safety evidence; they are cited at the end solely as
stationary context. `recovery-v5-delta.md` (sha256 `85d0fb4b…`) and `recovery-v5-design.md`
(sha256 `a24a253a…`) are left unchanged.

---

## 0. Scope and test receipts

Safety successor artifacts:

- `js/analysis/cxx/object-evidence.js` — new exported `cxxBinarySymbolNameAt` (raw release symbol table).
- `js/analysis/cxx/project.js` — captured raw `symbolNameFor` used for every proof name.
- `js/analysis/query/cxx-semantic-preference.js` — `cxxSemanticViews` reads raw binary symbols.
- `js/analysis/query/app-adapter.js` — `symbolsGeneration` bound in the slice cache.
- `tests/phase7/cxx/typed-argument-binding.test.mjs` — `display renames cannot …` test.
- `tests/phase7/cxx/pinpoint-publication.test.mjs` — `symbol epoch changes …` test.
- `scripts/collect-jev-context-development.mjs` — `metadata-only` operation option (syntax review only).

**Focused tests run (2, named, both PASS):**

| test | file | result |
|---|---|---|
| `display renames cannot create C++ ownership or enter binary-derived Jev contexts` | `tests/phase7/cxx/typed-argument-binding.test.mjs` | ✔ 1/1 pass (`173.27 ms`, exit 0) |
| `symbol epoch changes retire cached C++ publication before another semantic query` | `tests/phase7/cxx/pinpoint-publication.test.mjs` | ✔ 1/1 pass (`10.34 ms`, exit 0) |

No suite, build, typecheck, collector run, or API call was performed.

---

## 1. SB-1 — symbol-generation cache binding (`app-adapter.js`)

The C++ evidence-provider slice cache previously keyed only on backend/object identity, so a symbol
table mutated in place (same `symbols` object) could keep a stale provider and publish stale
ownership.

Repair (verified by reading the diff and the test):

- `ensureCxxEvidenceProviderForApp` computes `symbolsGeneration = symbols.gen ?? null` and stores it
  on the slice entry; the reuse check now also requires
  `entry.symbolsGeneration === symbolsGeneration`, otherwise the entry is rebuilt.
- `cxxMemberIndexForApp` additionally returns `null` when
  `entry.symbolsGeneration !== (app?.symbols?.gen ?? null)`.
- Backend generation (`backend.gen ?? backend.analysisEpoch ?? null`) remains checked as before.

**Fail-closed / compatibility:** hosts without a `gen` value compare `null === null` and keep the
prior object-identity contract, so nothing regresses for small first-party hosts.

**Test:** `symbol epoch changes …` builds a provider via `recoverCxxMembersForQuery(...,{planOnly:true})`,
asserts an index exists, then mutates `symbols.gen++` on the same symbols object and asserts
`cxxMemberIndexForApp(app)` is `null`; a fresh recovery yields a different index; `backend.gen++`
also retires it.

---

## 2. SB-2 — proof names from the captured raw release symbol table

The prior ownership/publication path could read a display name (`symbols.nameAt(...)`, or the
caller-supplied `functionName`/`rawSymbol`), so a user rename such as `Oracle::secretField` could in
principle influence owner selection or leak into semantic/Jev context.

Repair (verified by reading the diff and the test):

- `object-evidence.js` exports `cxxBinarySymbolNameAt(symbols,address)`:
  - if the release table has `names` + `addrs` of equal length, it binary-searches `addrs` for an
    **exact** address match and returns `names[left-1]`; because it requires exact equality, unsorted
    input can only *miss* (return `null`), never return a wrong symbol's name;
  - otherwise it returns `null` when `symbols.nameEvidence?.(address)?.manual === true`, else falls
    back to `symbols.nameAt?.(address) ?? null` for hosts that expose only `nameAt`.
- `project.js` `indexFromReport` exposes `symbolNameFor: address => firstSymbol.get(String(address)) ?? null`
  from the **existing** metadata walk's `firstSymbol` map (retained for O(1) lookup; no new pass, no
  new read). `projectForFunction` reads `binarySymbol = index.symbolNameFor?.(functionAddress) ?? null`
  once and uses it for the multi-vtable owner splice, the typed-argument symbol, and
  `extractCppObjectEvidence({functionName: binarySymbol, rawSymbol: binarySymbol})`.
- `cxx-semantic-preference.js` `cxxSemanticViews` now resolves context names via
  `cxxBinarySymbolNameAt(symbols,address)` instead of `symbols.nameAt(address)`.

**Behavioral tightening (intended):** the caller `rawSymbol`/`functionName` fallback is dropped; if
the address is absent from the release symbol table, no ownership is derived. That is the
fail-closed direction — no ownership without a raw symbol.

**Test:** `display renames cannot …` builds a provider whose real table is `['_Z4readv']` but whose
`nameAt` returns forged `_ZNK6Oracle11secretFieldEv`; the projection is `null` and `fieldCount` 0.
With a real `_ZNK6Widget4readEv` in the table, the same forged `functionName` still yields owner
`Widget` (raw table wins). It then builds semantic views over a `Widget` field and asserts the
context name is the raw symbol and the serialized views do **not** contain `secretField` — the rename
neither creates ownership nor leaks into Jev context.

---

## 3. Collector `metadata-only` option — syntax review (no execution)

`scripts/collect-jev-context-development.mjs` gains a fifth argv `operation`:

- usage now `RELEASE_BINARY PLAIN_QUERIES OUTPUT PLANNING_POLICY [collect|metadata-only]`, with
  `['value-accessor-v3','object-context-v4','staged-object-v4','semantic-retrieval-v5']` accepted for
  `planningPolicy` and `['collect','metadata-only']` for `operation`; anything else throws.
- In the per-case loop, `if(operation==='metadata-only')continue;` skips the recovery/decompile step
  after the metadata rows are recorded.
- The completion guard accepts metadata-only shapes:
  `operation==='collect' && rows.length!==manifest.cases.length` or
  `operation==='metadata-only' && (rows.length || metadataRows.length!==manifest.cases.length)` is an
  error; `operation` is recorded in the persisted schema.

**Assessment (source-only):** the guard ordering and the `continue` correctly keep `metadata-only`
from running any analysis while still requiring one metadata row per manifest case; the CLI allowlist
rejects unknown operations. No collector or binary was executed in this review, and this receipt
makes **no execution-result claim** about the option.

---

## 4. Exact current hashes (sha256, at HEAD `9b4dc9e8d`)

Safety successor source:

| path | sha256 |
|---|---|
| `js/analysis/cxx/object-evidence.js` | `b29b1bde75b174a6b36523605e3c822d51e1c303359122c70d1337579b40d137` |
| `js/analysis/cxx/project.js` | `91ed342efb76c94e8e408568098d2aca7e34b38312e2350ed6a6a5b4e9618ae0` |
| `js/analysis/query/cxx-semantic-preference.js` | `58cb9cd07be847b3ddfa1ca54f1d30a22e42b251fdd4b2bc082482d4aaf0c667` |
| `js/analysis/query/app-adapter.js` | `a5f93c411b8dc3149829658f00af80dc79bab206a19f0d055f22d43dff3f7aec` |
| `scripts/collect-jev-context-development.mjs` | `89786c205c44230b54e870dcd7944b97d04b743797ecd5d30210af75c7abbd92` |
| `tests/phase7/cxx/typed-argument-binding.test.mjs` | `4e7b04de766519277e136e1ab532e3815e5b88bc396bf303d6ba1f1b1202f4f6` |
| `tests/phase7/cxx/pinpoint-publication.test.mjs` | `3af4c4e2ab00f737573103abce0b45828ff26c524bbb2d8550a23dba48d89127` |

Stationary context only (not safety proof):

| path | sha256 |
|---|---|
| `js/rtti.js` | `74f18fffd7c2d7c0c920958172d8a7a855bd7f6354b670040fba4e0a661b3e35` |
| `js/analysis/cxx/query-recovery.js` | `daae83d634391a328f0921dd7ddb257270627a15e9c82d1f32cb165d1d189dc6` |

Prior receipts (unchanged): `recovery-v5-delta.md` sha256
`85d0fb4b1efb970746257205bba4fb85fbb3e81ee50b52a05c3a5fa13797600d`; `recovery-v5-design.md` sha256
`a24a253abf9b163852e838b87d6f9afd00757bab140d8f2077dd16775e310d0d`.

---

## 5. Verdict

Both parent-audit safety blockers are repaired, fail-closed, and reproduced by the two named tests:
symbol-generation cache binding (SB-1) and raw-release-symbol proof provenance plus non-leaking
semantic contexts (SB-2). The `metadata-only` collector option is syntactically sound and not
executed here. Sources are stationary at `9b4dc9e8d`. No holdout or results were read; no production
authorization; parent verification required.


---

# Single-accessor successor review (source hashes bound to 3a6fe3c2ced21721f1b31fb1fcdc25877c0061e7)

# recovery-v5-successor-review — independent source-only successor delta review

**Lane:** jev-realgame-final recovery v5 successor delta (independent source review).
**Mode:** READ-ONLY. 0 API calls, 0 extra agents, 0 product edits, **exactly two** focused named test commands run.
`TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch` set on every command.
**No oracle / no holdout:** no game gold, results, snapshots, collector output, or README metrics were read.
The only external evidence read is the synthetic ABI compiler receipt
`internal-linkage-v5/compiler-verification.json` (g++ 11.4.0), which is **not** a holdout or oracle.
**Default-OFF:** this receipt records source scope only. It is **not** activation approval; no default-on
decision is made or authorized here.
**Root:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
**HEAD:** `281ceb4e8f39dfc0ef96c63d5d5dc8fc377c0ce5` (working tree dirty; reviewed delta is uncommitted and stationary).
**Original receipt preserved:** `recovery-v5-pipeline-review.md` sha256
`71589982975ff89ea86f86d8cf37f734801ed8fd56e96f02240dfb8e9a2d5063` (untouched; this is a separate successor file).

---

## 0. Exact reviewed source hashes (sha256, working tree)

| path | sha256 |
|---|---|
| `js/analysis/query/app-adapter.js` | `503657277c4a8f93f4fa222928a6cbc065f60be6a5dc662cad63b8ade42a1d2e` |
| `js/analysis/query/cxx-semantic-preference.js` | `4f7c66b9f3066c3dff83dc2611039c8eb30c942525bafc7d4ffdde9410da2ee7` |
| `js/analysis/cxx/typed-argument.js` | `c16b9859cd82de016c1edb3f696e02057fd1e84c95166d8d05ea361ca486ec6a` |
| `js/analysis/cxx/project.js` | `742c674dff1b06914afc6a5c7432ff09284c837260eb0cc833a162b74c5b5ce1` |
| `js/pinpoint.js` | `9f80701fb298e2bac1028fd8e7182b3a525cfde41b179957c8676e7870ec7f2f` |
| `tests/phase7/cxx/jev-recovery.test.mjs` | `628623f1d7338f6cd7565e40fbedbff942cd54cf49f7c4bc64f662425e4eb718` |
| `tests/phase7/cxx/pinpoint-publication.test.mjs` | `0e00acde05085a55edd4b7b61226fd0f19d70526ffddc74644cd877f1f814e5b` |
| `tests/phase7/cxx/typed-argument-binding.test.mjs` | `8bb265db7f7a98e71143224142ee40faf98e509981bbb05dad6f1852c143a0aa` |

Static context (unchanged, read for the call graph only):

| path | sha256 |
|---|---|
| `js/analysis/cxx/query-recovery.js` | `daae83d634391a328f0921dd7ddb257270627a15e9c82d1f32cb165d1d189dc6` |
| `js/analysis/cxx/member-index.js` | `a9763ca25965695e2d3a86e15f7fe3b99794e7c4de5d097facf7fa716ea74628` |
| `js/analysis/query/jev-recovery.js` | `dddcef89cddb9352fddcfbed34b0449501d6064ccfd42aa85f9fd4ccc118f393` |

**Compiler-evidence binding:** `internal-linkage-v5/compiler-verification.json` declares
`sourceHashes.typed-argument.js = c16b9859…` and `sourceHashes.project.js = 742c674d…`; both equal the
working-tree files above, so the synthetic ABI receipt is bound to the reviewed revision. That receipt:
`complete:true`, `developmentOnly:true`, `authorizesDefaultActivation:false`, compiler
`g++ (Ubuntu 11.4.0)`, **two positive checks only** (`_ZL10localConstPKN4demo4ItemEj` → `demo::Item`,
`_ZL5localP6Widgetb` → `Widget`; `oldEvidence:null`), each `internalLinkage:true`, `argumentIndex:0`,
`register:x0`. Compiler receipt sha256 `d4b5cd27b8f2df598099868da3b2dcd9715e96c1a3925001e782b858d321514e`.

---

## 1. Focused test commands and results (exactly two)

```
node --test --test-name-pattern="single-function retrieval" tests/phase7/cxx/jev-recovery.test.mjs
node --test --test-name-pattern="single-function interactive extension|internal-linkage" \
  tests/phase7/cxx/pinpoint-publication.test.mjs tests/phase7/cxx/typed-argument-binding.test.mjs
```

| test | file | result |
|---|---|---|
| `single-function retrieval selects one canonical returned member without upgrading facts or verdicts` | `jev-recovery.test.mjs` | ✔ |
| `single-function retrieval rejects hidden return ambiguity, contradictions and changed baseline identity` | `jev-recovery.test.mjs` | ✔ |
| `single-function retrieval cannot select outside the 255 member shortlist or scan an unbounded owner` | `jev-recovery.test.mjs` | ✔ |
| `single-function interactive extension preserves Hex on API failure and unknown or oversized extents` | `pinpoint-publication.test.mjs` | ✔ |
| `single-function interactive extension cancels stale epochs instead of returning the captured result` | `pinpoint-publication.test.mjs` | ✔ |
| `internal-linkage global functions bind an independently proven first object pointer` | `typed-argument-binding.test.mjs` | ✔ |
| `internal-linkage argument decoding rejects local scopes, qualified names, repeated linkage and unknown signatures` | `typed-argument-binding.test.mjs` | ✔ |

`7 tests / pass 7 / fail 0`. No suite, typecheck, build, API, binary, or collector run in this lane.

---

## 2. Successor delta A — production ≤255 member shortlist gate

**Requirement:** the elected returned member must belong to the authentic production ≤255 member shortlist,
not merely the ≤400 candidate lobby.

**What changed (verified):**

- `app-adapter.js` `recoverCxxMemberWithJev` now imports canonical `jevShortlist` (`js/pinpoint.js:100`) and
  passes `shortlist: jevShortlist(local.candidates, { max: 255 })` into the helper.
- `cxx-semantic-preference.js` `withCxxReturnedMemberPreference` now takes `shortlist` (default
  `local?.candidates`) and fails closed unless:
  `Array.isArray(shortlist) && 1 ≤ length ≤ 255 && unique keys && every shortlist member is identity-present in
  local.candidates`; and the elected `top` must be `shortlist.includes(top)` (object identity preserved by
  `jevShortlist`'s `.slice(0,max)`).
- Owner-work bound: `owner.ivars.length > 400 → return local`.

**Boundary test coverage (new named test):**
- oversized implicit shortlist (300 candidates, no `shortlist` option → default length 300 > 255) → reject;
- explicit ≤255 shortlist that omits the returned member → reject;
- a copied/cloned shortlist (`kept.map(c=>({...c}))`) → reject (identity check);
- owner with 401 ivars → reject (bounded work).

**Assessment:** the requirement is now enforced at the helper boundary and the wrapper derives the shortlist
from the canonical producer. Behavior remains fail-closed and the earlier findings still hold.

**Residual boundary (not a regression, a scope limit):** the helper can validate cardinality, uniqueness,
lattice-membership and object identity, but it **cannot prove the shortlist was derived by `jevShortlist`** — a
caller could hand it any ≤255 identity-subset of `local.candidates` and it would pass. Authenticity is
established only at the wrapper call site. If the parent wants enforcement rather than convention, the
shortlist should carry an unforgeable binding (or the helper should take only the full lattice and compute
`jevShortlist` itself, which would require resolving the `app-adapter → pinpoint` import direction).

**Layering note:** `app-adapter.js` now imports `jevShortlist` from `js/pinpoint.js`, an upward (facade) import.
No cycle was found (`pinpoint.js` does not import `app-adapter.js`) and the focused tests pass; the parent may
prefer moving `jevShortlist` to a leaf module shared by both.

---

## 3. Successor delta B — generic internal-linkage (`_ZL`) support

**Requirement:** exactly one top-level `_ZL` before an ordinary global source-name; qualified/local
scopes/templates/unknown signatures stay rejected; independent class evidence remains required.

**`js/analysis/cxx/typed-argument.js` (verified):**
- Admission regex is now `/^_ZL?[1-9]/` for `_Z` optionally followed by a **single** `L`; `internalLinkage = symbol[2]==='L'`
  and parsing resumes at position 3 (else 2). `_ZLL…` is rejected by the regex (`L` is not `[1-9]`).
- The **function** name must be a plain source-name (`[A-Za-z_][A-Za-z0-9_]*`, length 1..240, `[1-9][0-9]{0,2}`);
  a qualified/`N…E`, local `Z`, or template `I…E` function head fails at the next required `P`, so local scopes,
  qualified names and function templates cannot be admitted.
- The first parameter is `P [K] (<N-scope ≥2 components> | <single source-name>)`; unknown/short signatures and
  `v` (void) trailing encodings are rejected; trailing types are fully validated (builtins, `P/R/O/K/V`,
  source-names, `N…E`, complete `S…` substitution with a successful `demangleCxx`), bounded to 16 params/depth 8.
- `internalLinkage` is annotation only: `receiverRole` stays `'typed-argument'`, `argumentIndex:0`, `register:'x0'`;
  internal linkage neither creates a receiver nor moves argument zero. The flag is folded into `stableDigest`.

**`js/analysis/cxx/project.js` (verified):** the argument-proof gate now mirrors the decoder
(`/^_ZL?[1-9]/`), so `_ZL` symbols reach `createCppTypedArgumentEvidence` and the projection path. Independent
class evidence is still required **twice**: (i) the planner only emits `release-typed-object-argument` rows whose
`className` is in `typedClassNames` (`classEvidence` + `buildCppClassTypeIndex`), and (ii) the projection only
builds a typed-argument receiver when `index.typedClasses.has(className)` or `classTypeFor(className)` (RTTI-derived)
resolves; otherwise `argumentOwner` is `null` and no receiver is published. The test's no-class case asserts
`choices()` is empty for a named pointee without independent class evidence.

**Compiler evidence:** two positive internal-linkage identities only (`_ZL10localConstPKN4demo4ItemEj`,
`_ZL5localP6Widgetb`), matching the reviewed source hashes. Negative forms (`_ZLL…`, local scope, qualified head,
template, void/unknown trailer, `BAD` suffix, `J`) are **parser-asserted in the test, not compiler-emitted** — a
compiler cannot emit those, so this is a self-consistency gap, not a correctness gap.

**Assessment:** the internal-linkage decoder is bounded, fail-closed, and additive to proof-backed eligibility;
it grants no ownership and cannot widen a receiver proof. The independent-class-evidence requirement holds at
both the planner and the projection.

---

## 4. Corrected claims (overclaim fixes — no softening)

The original receipt must **not** be read as proving answer preservation or quality. Corrections:

- **A weak preference CAN destroy a correct baseline answer.** The preference replaces the result `top` with the
  member the selected function returns. If the remote selection is wrong, a correct baseline `top1` is replaced by
  a wrong member — the weak preference is not monotone toward correctness. **Immutable/frozen inputs prove only
  that no canonical record is mutated; they do NOT prove the published answer is preserved.** Remove any reading
  that immutability implies answer preservation. (The wrapper's `retained` step and the helper's reorder both
  change `top`.)
- **Lexical-trap resistance, fair-comparator behavior, and latency success are NOT established by these source
  tests.** The tests assert fail-closed boundaries and rejection of malformed/impossible inputs; they do not
  benchmark ranking fairness or wall-clock latency.
- **The 256-byte extent filter is a scheduling budget, not a hard wall or deadline.** It filters on
  `declaredFunctionEnd - address` (declared metadata); it does not bound actual decompile time. Real cost is
  bounded only by the existing Fast budgets (`decompilerTimeBudgetMs:1500`, `maxElapsedMs`) and
  `selectJevRecoveryPlan`'s timeout.
- **Same-budget comparator: unproven.** No Hex-only vs retrieval-enabled, same-budget comparison was run here.
- **Stability: unproven.** No repeated-run stability measurement was made.
- **Real latency: unproven.** No timing beyond the ms-scale unit-test durations was measured.
- **Quality/recall/ranking: unproven.** No oracle or holdout was read; the compiler JSON is a synthetic ABI
  identity oracle, not evidence of retrieval quality.
- **Final gates: NOT approved.** `intent classification`, default activation, and product promotion remain
  unproven and unapproved. Default OFF.

---

## 5. Blockers / explicit scope limits

- **BL-Q (quality unproven).** Retrieval quality / reranking benefit is not measured in this lane; no oracle or
  holdout was consumed.
- **BL-COMP (comparator unproven).** Same-budget Hex-vs-retrieval comparison not run.
- **BL-STAB (stability unproven).** Not measured.
- **BL-LAT (latency unproven).** Real latency unknown; 256-byte is scheduling metadata, not a deadline.
- **BL-PRES (answer preservation unproven).** A wrong remote selection can destroy a correct baseline top; the
  weak preference is not proven safe for answer correctness — only for canonical-record immutability.
- **BL-AUTH (shortlist authenticity is convention).** The helper validates cardinality/uniqueness/identity-subset,
  not canonical derivation; only the wrapper calls `jevShortlist`.
- **BL-LAYER (import direction).** `app-adapter → pinpoint` is an upward import (no cycle found, tests pass).
- **BL-SUITE (source-only).** Only the two focused named commands above were run; no full suite/typecheck/build.
- **BL-COMPILER (fixture asymmetry).** Internal-linkage compiler receipt has positives only; negatives are
  parser-asserted.
- **BL-ACT (no authorization).** No default activation, no production promotion, no holdout claim.

**Explicitly NOT reviewed in this lane:** `reports/investigations/jev-realgame-final/README.md` (metrics),
`reports/investigations/.../development-v5/*.json` (results), `scripts/collect-jev-context-development.mjs`
(collector; its only non-test `recoverCxxMemberWithJev` caller, passing `enabled:true` explicitly — development
tooling, not a product default), and any game gold/holdout/oracle/results.

---

## 6. Verdict

The successor delta is **fail-closed and additive** as reviewed: the ≤255 production member shortlist is now
required (canonical `jevShortlist` in the wrapper; cardinality/unique-key/lattice-identity/top-membership checks
in the helper), the owner ambiguity scan is bounded to ≤400 ivars, and the internal-linkage decoder admits
exactly one top-level `_ZL` before an ordinary global source-name while rejecting scopes/templates/unknown
signatures and still requiring independent class evidence at both planner and projection. Seven focused tests
pass. **Parent retains final responsibility and must independently verify.**

**Scope/no-oracle declaration:** no holdout, gold, oracle, game results, snapshots, or README metrics were read;
the only external evidence is the synthetic g++ ABI receipt bound to the reviewed source hashes. **Default OFF.**
This document is **not** activation approval, not a quality/recall/stability/latency claim, and not proof that a
correct baseline answer is preserved.
