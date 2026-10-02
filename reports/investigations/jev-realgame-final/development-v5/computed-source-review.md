# recovery-v5 computed-return member evidence — independent read-only review

**Reviewer lane:** Freebuff3 (DeepSeek v4.1 Flash high), independent source-only review.
**Product commit under review (exact):** `b3aa6b59c063bf36e2f7f679e56a87242595e707`
("Extend anonymous member context with bounded computed-return evidence").
**Diff range reviewed:** `9f047a0b11543e69efd3abd484ca5bb2343a4773..b3aa6b59c063bf36e2f7f679e56a87242595e707`.
**Worktree:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida` (clean; `git status --porcelain` empty).
**Mode:** read-only. No source edits, no API calls, no subagents, no real-game/oracle/untouched-v5 reads.

## 1. Scope actually inspected

The four product sources named by the prompt:

| file | sha256 |
|---|---|
| `js/analysis/cxx/member-types.js` | `f6604b92002d62bbcd368eb6a06229e9b5f904413d6a3dffdc3ea877b80dc8f5` |
| `js/analysis/cxx/object-evidence.js` | `6172d877b2943c76061add023f410f456f9358f4eacaa156c1d1da7d2a8ea26b` |
| `js/analysis/cxx/project.js` | `a70a569cb3e2896f7c99c96ab8519f3d94ceb2c41f0a9fb183aeecd435df0d7c` |
| `js/analysis/query/cxx-semantic-preference.js` | `aa3761dd6ec595a09f9e8b1923bcde35fbe0d175b81928a504dc49d764a806f1` |

and the three tests:

| file | sha256 |
|---|---|
| `tests/phase7/cxx/member-types.test.mjs` | `3fc6f188cdd4c60fb8ccb673fc183c3440326de289b7a7b47900aed6a9ce47e6` |
| `tests/phase7/cxx/member-evidence.test.mjs` | `4f6bf02509370bf1494cad75923496304ac9e442ee0210b9af35b158167d609e` |
| `tests/phase7/cxx/jev-recovery.test.mjs` | `2bf359b4e8a823249a7f0f80cd1b0c980be9ba2f1cecd6637518ec939f1f7e0f` |

Exact changed regions (new-side line numbers at the reviewed commit):

- `member-types.js`
  - `buildChains` — `definitions`/`duplicateDefinitions` maps (lines ~125, 143–147); return object adds `definitions`, `duplicateDefinitions`, `returnFlowUnknown` (line ~210).
  - `computedReturnMembers(chains,memberLoads,argumentIds,{complete})` (lines ~210–252).
  - `recoverMemberTypeEvidence` — `memberLoads` map (line ~404), population for non-indexed receiver loads (line ~464), invocation + role stamping (lines ~485–488), per-field `returnExpressionIncomplete` marker (line ~529).
- `object-evidence.js` — `CPP_MEMBER_ACCESS_ROLES` (line 24, now 9 roles), role/`returnExpressionIncomplete` validation (lines ~429–433), record spread (line ~466). `isCanonicalCppMemberEvidence` remains a `WeakSet` membership test (lines 44, 91–92).
- `project.js` — `projectMembers` forwards `returnExpressionIncomplete` into `createCppMemberEvidence` (line 164).
- `cxx-semantic-preference.js` — `withCxxReturnedMemberPreference`: incomplete-return full-owner veto (lines ~144–147), `computed-return-input` inclusive of the `linked` predicate (lines ~155–156).

Out of the prompt's inspection scope but present in the same commit: `reports/.../README.md`, `development-v5/*` receipts, `tests` (already above), and a generated `userscript/hex.user.template.js` + `userscript/release-version.json` version bump (`2.0.2322242298` → `2.0.2322242299`, buildId `5ce039bf...` → `1fdc83f4...`). See L-5.

## 2. Focused test result

Command run exactly once, as authorized:

```
node --test --test-name-pattern='computed return|computed returns|computed-return member|machine access roles' tests/phase7/cxx/member-types.test.mjs tests/phase7/cxx/member-evidence.test.mjs tests/phase7/cxx/jev-recovery.test.mjs
```

Result: **tests 4, pass 4, fail 0, cancelled 0, skipped 0** (duration 8694 ms).

Matched tests:
- `closed computed returns keep machine type unchanged and retain every contributing member`
- `computed return observations fail closed on unknown roots, constant annihilation, invalid locations and budgets`
- `single-function retrieval accepts one computed-return member but vetoes a hidden second operand`
- `machine access roles are bounded and cannot carry semantic labels`

## 3. What the change does (verified from source)

1. **Producer role, context only.** `computedReturnMembers` walks the function's `ret` operand SSA graph over `mov` (copy/trunc/zext/sext), `un` (neg/not/zext/sext/trunc), and whitelisted `bin` ops. It records only `accessRoles.add('computed-return-input')`; it never writes `category`, `typeLabel`, `signedness`, `memberName`, or the receiver. Classification is unchanged (classification reads only the representative access's `size/signed/fp/pointerUse/indexed/boolLike`), so **no type upgrade and no source-name injection**.
2. **Existing canonical member only.** The role is stamped on the `memberLoads` entry, which is populated only for `inst.op==='load' && !indexed && isReceiverBase(base)` — i.e. an already-observed receiver-member load. The downstream `linked` predicate in `cxx-semantic-preference.js` still requires `isCanonicalCppMemberEvidence`/`isCanonicalCppReceiverEvidence`, matching `receiverDigest`/`snapshotId`/`functionAddress`, `member.offsetBytes===BigInt(field.offset)`, `member.sizeBytes===field.size`, `readCount>0`, and `receiver.completeness==='complete'`.
3. **Closed bounded expression.** Requires `complete` (not truncated), `!chains.returnFlowUnknown`, `returnInputs.size<=32`, `depth<=MAX_CHAIN_DEPTH (8)`, `visits<=256`, acyclic (`active`), and no duplicated SSA definition ids. Value-producing RHS: load-of-receiver, existing constant, or function argument.
4. **Fail-closed vetoes.** Any untraceable return root (`call`, unknown `phi`/merge, load not through receiver, indexed load, unknown-width/mixed-width/incompatible-offset entry, duplicate definition, depth/visit/root budget) makes the whole observation `incomplete:true`, which (a) withholds the `computed-return-input` role and (b) stamps `returnExpressionIncomplete:true` on every field of the function report, which the query layer scans across the **complete published owner** (`owner.ivars`, not the ranked shortlist) and bails to the local result.
5. **Ambiguity preserved.** Two member operands in one returned expression are both stamped, so the existing `returned.length!==1` uniqueness veto fires. The ARM64 test (`ldr w1,[x0,#8]; and w0,w1,#3; ret`) proves the observation is reachable through real lifting.
6. **Default remains off.** `withCxxReturnedMemberPreference` is reachable only from `recoverCxxMembersWithJevInteractive`-style entry in `app-adapter.js`, gated by `options.enabled===true && options.mode==='partial'`. `grep` confirms `computed-return-input`/`returnExpressionIncomplete` have no other consumer. No product caller enables the JEV path by default.

## 4. Assessment vs. each required property

| required property | verdict | basis |
|---|---|---|
| preference for only an existing canonical anonymous member | PASS | role only on canonical receiver-member loads; `linked` re-validates canonical identity, digest, snapshot, offset/size |
| closed bounded scalar expression only | PASS | op whitelist; depth 8 / visits 256 / roots 32; cycles and duplicate defs fail closed |
| full-owner ambiguity veto | PASS | `returned` computed over `owner.ivars`; test filters the hidden operand from `candidates` and still vetoes |
| incomplete-return veto | PASS (broad) | marker on all report fields; owner-wide scan independent of shortlist and completeness |
| no type upgrade / no source name injection | PASS | role-only write; classification and naming paths untouched |
| no new analysis pass | PASS | logic added inside existing `recoverMemberTypeEvidence`/`buildChains`; no new traversal over binaries |
| malformed/cycles/multi-operand/unknown-call fail closed | PASS | each has an explicit reject and matching test |
| ARM64 lifting test meaningful | PASS, but narrow | only `and`-with-constant is lifted end-to-end; no lifted add/or/zext/mov-through case |

No blocking defect found. The change is additive and fail-closed: every failure path withholds the role and/or vetoes the preference rather than asserting a weaker fact.

## 5. Limitations, edge cases, blockers

**L-1 (recall, not safety) — global function-level veto.** `returnFlowUnknown` is true if *any* instruction in the first `maxInstructions` window has `op==='unknown'`, and *any* single untraceable return root anywhere in the function sets `incomplete`. A function with a clean, direct receiver-member return plus an unrelated untraceable return is now vetoed for **all** returned-member preference, including the pre-existing direct `return-input` path. Real functions commonly contain unknown ops, so recall may drop materially. This is conservative (safe direction) but is a behavior restriction on the previously working direct-return preference, and it is unmeasured.

**L-2 (narrow fail-open edge) — uniqueness is over *published* owner members.** `returned` is built from `owner.ivars`. If two receiver members feed the return but the canonicaliser drops one (malformed record) while publishing the other, `returned.length===1` and the preference can fire even though the return expression had a second member operand. The producer's computed-return member set is not consulted directly. Requires one malformed + one valid member at distinct offsets; fail-closed canonicalisation makes this rare, but it is a real asymmetry between the producer's set and the query-layer veto.

**L-3 (labeling nuance) — `hasComputation` is report-global.** A member that reaches a return directly (no `un`/`bin`) receives `computed-return-input` if *any other* return root in the same function contains a whitelisted `un`/`bin`. The role is redundant with `return-input` in that case and does not change the uniqueness count, but the role name overstates the member's own path.

**L-4 (arithmetic-annihilation asymmetry)** — `x-x`, `x&0`, `x*0`, `x/0` set `hasComputation` false *and* return `false`, producing `incomplete`/veto rather than "no member". Safe, but a provably constant result is treated as an untraceable flow rather than resolved.

**L-5 (generated output ownership, EP-003/EP-008)** — the same commit mutates `userscript/hex.user.template.js` and `userscript/release-version.json`. These are generated release artifacts; the diff shows a buildId/serial/hash bump with no corresponding runtime source change in the reviewed diff. Ownership/regeneration provenance was **not** verified (out of scope, no metadata read). Not a code correctness issue for the reviewed sources but should be confirmed by the owning lane.

**L-6 (test breadth)** — only the 4 pattern-matched tests ran; the `unknown`-op, cycles, mixed-width, budget and ARM64 assertions are all inside those 4. No lifted test exercises `or`/`xor`/`mul`/`shl`/`zext`-through-`mov`, binary `sub` of two members, or a genuine multi-return function. Test coverage is meaningful but not exhaustive.

**BL-1 source-only:** no live API, no real-game replay, no default activation — by construction.
**BL-2 metadata not read:** the `reports/.../development-v5/*` receipts and their claimed live-call hashes were not opened; the README's accuracy numbers are outside this source-review scope.
**BL-3 quality unproven:** no claim that marking `computed-return-input` improves selection accuracy, and none that the veto's recall cost is acceptable in real binaries. The README itself states "no reported accuracy gain" and "not yet received independent review".

## 6. Explicitly unproven

- A syntactic scalar dependence is weak context, **not** semantic equivalence: `member & mask`, `member + member2`, `member << n` all stamp the member without proving the returned value equals the member. The design correctly treats this as preference-only and never as a name, type, or ABI fact.
- No measurement of false-preference rate, false-abstention rate, or recall delta caused by the new global/`unknown` veto (L-1).
- The L-2 published-set asymmetry is reasoned from source only; no adversarial test constructs it.

## 7. Evidence gaps / useful vs. not useful

- Useful: the focused producer tests with **actual ARM64 lifting** (real value for a source-only reviewer); the `machine access roles` bound test that pins the role allowlist; the `jev-recovery` test that deliberately hides the second operand/incomplete marker outside the ranked shortlist (proves full-owner scanning).
- Not useful (or missing): no test that a lifted *multi-return* function behaves as intended; no test for the L-2 dropped-member scenario; no test for a computed expression containing a call operand *within a lifted* function.

## 8. Cost

- Producer: one extra `Map` of definitions and a duplicate-id `Set` per `buildChains` (O(instructions)); one bounded walk (≤32 roots, ≤256 visits, depth ≤8) per `recoverMemberTypeEvidence` call. No new binary pass, no new I/O.
- Test command: ~8.7 s for 4 tests (the ARM64-lifting test dominates at ~3.8 s).

## 9. Disposition

**No blocking defect.** The bounded computed-return observation is additive, context-only, canonical-only, and fails closed on malformed/unknown/cyclic/budget-exceeding flows, with the full-owner ambiguity and incomplete-return vetoes actually exercised by tests. Recommended non-blocking follow-ups: (a) measure/decide the recall cost of the global `unknown`/incomplete veto on the direct `return-input` path; (b) close or document the L-2 published-set asymmetry; (c) add a lifted multi-return/computed test; (d) confirm generated-artifact ownership (L-5) in the owning lane. This review does **not** authorize default-on behavior, real-game accuracy claims, or new analysis passes.
