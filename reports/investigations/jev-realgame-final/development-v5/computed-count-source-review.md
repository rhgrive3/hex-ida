# recovery-v5 computed-return member-count fix — independent read-only review

**Reviewer lane:** Freebuff3 (DeepSeek v4.1 Flash high), independent source-only review.
**Delta reviewed:** `b3aa6b59c063bf36e2f7f679e56a87242595e707..58979301c2c17f2a6ae5117d3192c9a220372149`
**Exact product commit:** `58979301c2c17f2a6ae5117d3192c9a220372149`
**Worktree:** `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida` (clean).
**Scope:** the four named sources + three tests only. No edits, no API, no gold/untouched reads, no broad tests.

## 1. Verdict

**No blocker. This closes the earlier L-2 published-set asymmetry.** The producer now counts the distinct structural returned members *before publication* and carries that count on every canonical record, so a hidden or dropped second operand can no longer be made to look unique by publication alone. All changes are additive, bounded, and do not alter type/width/verdict/name facts.

## 2. Source hashes (7 files)

| file | sha256 |
|---|---|
| `js/analysis/cxx/member-types.js` | `6928419680fea663f84e2733d8676b072e9db7a25ee4e6acf87a75aa1767c388` |
| `js/analysis/cxx/object-evidence.js` | `4e3b29c2796bd58508a7524d6cbab48c41a7838dcd2c2faeabeee0fe2155cd7d` |
| `js/analysis/cxx/project.js` | `74526ec114cd1806641785cffa6a805ffcf8f863e40982662ff8b71ef8e9317e` |
| `js/analysis/query/cxx-semantic-preference.js` | `c390bd58a55b58a63b59d98c5d73d5308a13f7084b64ad4ab8551e5e8b62c1d5` |
| `tests/phase7/cxx/member-types.test.mjs` | `7b8a654bc3a87d5681866769a5253d4c2f4bb89060c90cd6010bc42bebcb7901` |
| `tests/phase7/cxx/member-evidence.test.mjs` | `2224261b666fef6d686859e168a7afb21bf6672febb220f2060dd471d8100a8f` |
| `tests/phase7/cxx/jev-recovery.test.mjs` | `f3246c6a6fdaa25f7e690df5df3cb1a93c08152003d770204d52b570af9c2e2d` |

## 3. What changed (verified from source)

1. **Producer count before publication** (`member-types.js` `computedReturnMembers` ~253): `memberCount = new Set([...members].map(id=>memberLoads.get(id).offset)).size`. Counted from the raw walked member set (not the `hasComputation`-gated role set), so direct and computed returns are both counted. Distinct **offsets** ⇒ two loads of the same structural member count once. `unavailable()` returns `memberCount:null`; the closed path returns a number.
2. **Carried on every record** (`member-types.js` ~528): `returnedMemberCount` attached to every field of the report, independent of which member is return-linked. `object-evidence.js` validates `safe integer 0..256` (else `cpp-member-return-member-count-invalid`) and persists it; `project.js` forwards it.
3. **Full-owner veto extended** (`cxx-semantic-preference.js` ~149): for each owner field, a provenance member of the selected function now also vetoes when `returnedMemberCount != null && !== 1`. This fires across `owner.ivars`, so a **dropped** second operand is still seen (its count rode on the surviving record).
4. **Computed role requires count 1** (`cxx-semantic-preference.js` ~159): `linked` accepts `computed-return-input` only with `returnedMemberCount===1`; a computed-return member **without** a count is not linked (missing-count case ⇒ no preference).
5. **Deterministic comparator parity** (`cxx-semantic-preference.js` ~17): `cxxSemanticScores` now treats a context as return-linked when `return-input` is present, or when `computed-return-input && returnedMemberCount===1 && returnExpressionIncomplete!==true` — matching the remote/preference path. `cxxSemanticViews` (~72) exposes `returnedMemberCount` and `returnExpressionIncomplete` on contexts.

## 4. Required checks

| check | result |
|---|---|
| hidden/dropped operand cannot acquire uniqueness | **PASS** — count precomputed over all walked members; `dropped` test publishes only the surviving member with `returnedMemberCount:2` and still gets no preference |
| missing computed count vetoes | **PASS** — `missing` test: computed-return-input with no count yields unchanged local |
| same-offset separate loads counted once | **PASS** — `new Set(...offsets)`; test sets both loads to `disp:8n` and asserts `returnedMemberCount===1` |
| no semantic name/type/width/verdict change | **PASS** — diff touches only the integer count and the gates; classification, labels, `semanticPreference.verdict` unchanged |
| bounded growth | **PASS** — validator bounds `0..256`; producer count ≤ walked members ≤ visit budget (256), walks remain ≤256 visits / ≤32 roots / depth 8 |
| comparator fairness | **PASS** — `cxxSemanticScores` uses the same computed-return gates; test asserts `score===10` with `returnedMemberCount===1` |

Precedence in the comparator is `a || (b && c && d)`, and the same evidence is applied consistently in `linked`, the veto, and `cxxSemanticScores`.

## 5. Edge cases / residual notes (non-blocking)

- **Count 0 also vetoes** (`0 != null && 0!==1`). Harmless: count 0 means no member flows to the return, so no field is return-linked and no preference was possible anyway.
- **Legacy/null count** leaves only the pre-existing direct `return-input` path active (null is not vetoed), which cannot be acquired by a hidden operand because the current producer always stamps a count. This is the correct back-compat boundary.
- **The `===1` in `linked`** is redundant with the veto for non-null counts but is the necessary guard for the null case; correct as written.
- **L-1 remains** (global `unknown`/incomplete-return recall veto) — explicitly unchanged and unmeasured; not a defect of this delta.
- Out-of-scope files in the commit (`README.md`, `development-v5/*` receipts, `tools/validation/*/cross-lane-inventory.mjs`, and the generated `userscript/*` build) were not inspected per instructions; the generated build is owned by the parent canonical build.

The unchanged live positive result (1/4) belongs to the old `b3aa6b59` head and is **not** a claim about this source delta.

## 6. Test result

Command run exactly once:
```
node --test --test-name-pattern='computed return|computed returns|computed-return member|machine access roles' tests/phase7/cxx/member-types.test.mjs tests/phase7/cxx/member-evidence.test.mjs tests/phase7/cxx/jev-recovery.test.mjs
```
**tests 4, pass 4, fail 0, cancelled 0, skipped 0** (duration 10483 ms). The extended `jev-recovery` test now also covers dropped-operand, missing-count, and comparator-parity seams; `member-types` asserts `returnedMemberCount` 1/2/1 across direct, two-operand, and same-offset cases; `member-evidence` covers invalid counts.

## 7. Disposition

**L-2 closed; no blocker.** Non-blocking follow-ups remain from the prior review: measure L-1 veto recall cost, and add a lifted multi-return computed test. No default/real-game authorization is granted by this receipt.
