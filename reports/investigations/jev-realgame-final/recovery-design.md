# recovery-design — independent evidence-only review of query-directed C++ member recovery

**Lane:** `recovery-design` (freebuff3), evidence only. **Mode:** offline; **0 live Jev/OpenJEV calls, 0 holdout/oracle/source-gold reads, 0 repository source edits, 0 commits.**
**Repository:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
**Exact heads reviewed:** `d227625716c2fcc8369d7f634c465bea45d25955` (HEAD), over `18718e3e7` ("Add explicit bounded query-directed canonical C++ member recovery") and `d22762571` ("Use bounded query recovery and binary machine-use context without oracle names"); parent baseline `6780f80e7`.
**Reviewed artifacts (sha256):**

| file | sha256 |
| --- | --- |
| `js/analysis/cxx/query-recovery.js` | `ed5c5360bce87f5ce5115205d76fea378c06e7f81a70d5dddd78a83ad9c74389` |
| `js/analysis/query/app-adapter.js` | `66333733781e7a6b9dcbde37208a6f545f316cebc98056bacb43c63c41bc9e4b` |
| `js/analysis/cxx/member-types.js` | `e19550a053c6cbb65eebf1c6fc38d2c7bfb7f9637837574a0692dd980d1d30bb` |
| `scripts/jev-realgame-recovery-contract.mjs` | `d1f730c4ff220f6acdd64b7000d4c65c0165f614145133ba55ff1294a8cdc1ca` (= `recovery-policy-freeze.json.promptSha256`) |
| `scripts/probe-cxx-query-recovery.mjs` | `bf663c7639436c89bc3cd14ff26ac455726bb49cb5a9e65540b85c7904367399` |

## Verdict

The path is **safe-by-default, generic, and mechanically sound**; it adds no new default Fast pass, cannot upgrade a type/verdict, and reuses the existing scoped decompiler seam. It is **not yet evidence that it improves the 2/49 ceiling**: the plan pool is filtered to symbol-proven (ctor/dtor/const) or uniquely vtable-owned functions (`query-recovery.js:30`), and that pool is exactly what the prior failure mode starves. Four concrete blockers follow; **B1 and B2 should be fixed/measured before this is claimed to improve recovery**.

## 1. Verified properties (each with the seam that proves it)

1. **Constructor class token is not counted twice as method semantics — fixed.**
   `analyzeFunctionSymbol` classifies `C1/C2/C3` and `parts[last]===parts[last-1]` as constructors (`object-evidence.js:459-463`), and the planner sets `methodTokens: info.isConstructor||info.isDestructor ? [] : cxxQueryTokens(info.methodName)` (`query-recovery.js:35`). The `+2` `exactObject` term (`query-recovery.js:51`) is object-identity, applied equally to ctors and methods, so it is not a ctor method-semantics boost. Test "constructor class words cannot outrank..." passes; a `_ZN10WidgetListC1Ev` row carries `classTokens=['widget','list']`, `methodTokens=[]`.
2. **Static / ambiguous owners excluded — holds.** Thunk (`info.isAdjustedThunk`) and multi-owner vtable slots (`names?.size>1`) are blocked (`query-recovery.js:27`); a non-const, non-ctor symbol with no unique vtable owner is dropped (`query-recovery.js:30`). An ordinary qualified symbol is never treated as proof of non-static (`query-recovery.js:26-27`). Test 1 passes.
3. **No extra default Fast analysis — holds.** `recoverCxxMembersForQuery` returns `disabled` unless `options.enabled===true` (`app-adapter.js:36`); `recoverCxxQueryMembers` defaults `enabled=false` (`query-recovery.js:70`); the only production caller is the explicit UI tap (`panels-base.js:3337-3344`). The module has no import-time side effects and the planner does no decompilation.
4. **Snapshot / binding / cancellation / duplicate / budget are bounded.** `recoverCxxMembersForQuery` binds `query.snapshot({signal})` once (`app-adapter.js:42`), refuses when `cxxMemberIndexForApp(app)!==entry.provider.memberIndex()` or `app.symbols.gen` changed (`app-adapter.js:43-49,57-59,61`), and the `decompile` wrapper re-checks before and after each call. `recoverCxxQueryMembers` validates `maxFunctions∈1..32` and `maxElapsedMs∈(0,120000]` (`query-recovery.js:73-74`), dedupes by address (`query-recovery.js:79`), checks `signal?.aborted` each iteration (`query-recovery.js:77`) and caps at `maxFunctions`/`maxElapsedMs` (`query-recovery.js:78`). `query.decompile(snapshot,functionId,options)` matches the real API (`analysis/query/api.js:445`); the result DTO is `{value:{pseudocode},status:{completeness,...}}` (`app-adapter.js:287,464,537`), so the recorded `pseudocode` flag is meaningful.
5. **Role claims reflect IR copy/unary flow and do not strengthen type/verdict — holds on real IR.** Roles are collected only for `load` values reached from `ret`/`cmp`/`cbr`/`bin` inputs over the existing `mov`/`un` consumer map (`member-types.js:135-138,289-292`); they are additive metadata (`member-types.js:337`), never read back into `classifyMemberAccess`. Canonicalisation whitelists the four roles and rejects anything else (`object-evidence.js:379-404`); the canonical member index key does not include `accessRoles` (`member-index.js:96-98`), so publication identity is unchanged while `record.sources` carries the member object (`member-index.js:88-90,151-153`), which is what the recovery contract reads. Scratch probe over real IR: `add w2,w1,#4` → `arithmetic-input`; `cmp`/`ret` shapes → `comparison-input`/`return-input`; category stays `int32` with `widthOnly:true`, no `memberName`.
6. **Recovery populates the same canonical lattice that re-ranking reads.** `query.decompile` internally calls `ensureCxxEvidenceProviderForApp(app)` + `projectForFunction` (`app-adapter.js:1196-1215`), i.e. the same `entry.provider` used by `cxxMemberIndexForApp`. So a re-run of `showCandidates`/`pinpointField` after recovery genuinely sees the newly projected members. This is the mechanism the design depends on and it is wired correctly.
7. **Recovery contract uses only release methods + machine roles.** `jev-realgame-recovery-contract.mjs` imports no oracle, demangles only `app.symbols` names (`demangleCxx(ctx.name)`), filters roles through the frozen `ROLES` set, and states the roles are "context, not proof". `promptSha256` in the freeze equals this module's sha256, so the model instruction is hash-bound.

## 2. Blockers (concrete, file:line, ranked)

**B1 — Plan pool can be empty on exactly the failing binaries (highest risk to the goal).**
`query-recovery.js:30` keeps only `isConstructor||isDestructor||isConstMember` or uniquely vtable-owned symbols. Release C++ game code is mostly non-const instance methods whose ownership rests entirely on resolvable vtables; `classEvidence()` returns `index?.report ?? null` (`project.js:448`), and the provider's `build()` is swallowed to `null` on failure (`app-adapter.js:110`). If vtable resolution is incomplete — the observed prior failure mode — the pool collapses to ctors/dtors/const methods and the path cannot move 2/49.
*Required before any improvement claim:* record `planner.functionCount` and `plan().length` per corpus binary/query in the probe output, and state the ceiling. Do **not** relax the static/ambiguous exclusion (`query-recovery.js:26-30`) without a receiver/ownership proof — the current exclusion is the safe call, but its coverage cost must be quantified, not assumed.

**B2 — "attempted>0" is treated as success → repeatable user loop.**
`panels-base.js:3348` re-opens the sheet whenever `recovered.attempted.length` is non-zero, but the per-function `pseudocode` flag (`query-recovery.js:83`) and lattice growth are ignored. Eight unsupported decompiles still reopen the identical weak-result screen (the button condition `panels-base.js:3333` is unchanged), so a user can loop with no gain.
*Fix:* gate the reopen on (a) at least one `attempted[].pseudocode===true`, and (b) lattice growth — compare `cxxMemberIndexForApp(app).fieldCount` before/after. `recoverCxxMembersForQuery` currently returns only post-run `candidateCount` (`app-adapter.js:61`); add `beforeCount`/`afterCount` so the UI can decide instead of guessing. Otherwise `toast` a specific miss.

**B3 — The elapsed budget can be exceeded while `status` still says `complete`.**
`query-recovery.js:78` checks elapsed only *before* each function, and the Fast time budget is explicitly best-effort/cooperative (`analysis/query/api.js:437-442`: a synchronous overrun blocks the event loop and cannot be preempted). One 1500 ms overrun plus 8 functions can exceed `maxElapsedMs` (15 s) with no status change.
*Fix:* re-check `now()-started>=maxElapsedMs` after the loop and set `status='budget-exhausted'`; surface `elapsedMs` in the UI/probe verdict.

**B4 — New roles can under-report a direct (no-copy) use (low severity, safe direction).**
`flowsInto()` never tests the seed id itself (`member-types.js:180-195`), whereas the existing `pointerUse` guards this with `chains.addressUsed.has(loadValueId) || flowsInto(...)` (`member-types.js:265`). If a decoder emits a load whose SSA value feeds `ret`/`cmp`/`bin` with no `mov`/`un` cast, the role is silently missed (under-claim, never over-claim). *Fix:* `targets.has(loadValueId) || flowsInto(loadValueId,targets,chains.consumers)` for the four new roles at `member-types.js:289-292`.

**B5 — Residual verification gap (declared, not a code defect).**
Per scope I ran no broad suite (`npm run check` not run). Only the two focused test files (`20 pass / 0 fail`) plus one scratch IR probe were executed. The `panels-base.js` UI change is untested; its symbols/scope were verified by reading (`progressBox.set` accepts `{done,all}` at `panels-base.js:1277`; `tapRow` supports `sub`/`onTap` at `ui.js:335`; `verdictRank`/`VERDICT` imported at `panels-base.js:60`). Broad-gate and real-binary evidence remain the parent's responsibility.

## 3. Lower-severity seams

- `panels-base.js:3334` gates the action on `app.store.get('architecture')` only; `architectureOf` (`app-adapter.js:339-341`) also falls back to `capability.architecture`/slice. An app classified only via capability hides the feature (feature hidden, never unsafe).
- `object-evidence.js:380` accepts up to four `accessRoles` entries before dedupe; duplicates are collapsed at `object-evidence.js:404`. Harmless.
- `query-recovery.js:83` stores the whole `result.status` object in `attempted[]` (not a string). Harmless, but consumers should not treat it as an enum.
- Planner cache keys on `entry.provider` + `app.symbols.gen` (`app-adapter.js:30,53-54`); `symbols.gen` exists (`symbols.js:148,703`) and class evidence is frozen after build, so the cache cannot serve a stale owner set for a replaced SymbolIndex.
- Recovery decompiles the first 8 ranked functions even when several produce no members; this is bounded and intended, but see B2.

## 4. Negative tests (generic, at most three; two already exist)

1. **Keep** `tests/phase7/cxx/query-recovery.test.mjs` test 1 — static (no owner, no const/ctor proof) dropped, ambiguous two-owner slot blocked, `_ZTh…` thunk blocked, budget `1..32` enforced.
2. **Keep** `tests/phase7/cxx/query-recovery.test.mjs` test 2 — disabled by default (no decompile), dedupe, `maxFunctions` exhaustion, abort rejection, snapshot error propagates. Add an assertion that the constructor row in test 3 has `classHits.length===1 && methodHits.length===0` (currently only the ordering is asserted), and one negative for `createCppMemberEvidence` rejecting an unknown role / >4 roles (`object-evidence.js:380`).
3. **New (ties to B2)** — when every planned decompile returns no pseudocode (or the lattice does not grow), the consumer must not treat the run as recovered: assert the "reopen only on pseudocode/new members" decision, not `attempted.length`.

## 5. Evidence produced by this review

- `node --test tests/phase7/cxx/query-recovery.test.mjs tests/phase7/cxx/member-types.test.mjs` → **20 tests, 20 pass, 0 fail** (2.2 s).
- Scratch probe `/mnt/workspace/.dev-state/agent-work/scratch/probe-role-flow.mjs` (outside the repo; not a source edit) confirming role classification and unchanged width-only category over real `buildIR` output.
- No holdout, oracle, source-gold, or original-evaluation artifact was read; no game binary or live service was touched.

*Parent keeps all edit/integration responsibility. This receipt is a review, not an implementation.*
