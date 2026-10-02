# recovery-v5-compact-review — independent source review of the compact-accessor-v5 prototype

lane: jev-realgame-final recovery v5 compact-accessor prototype (independent source-only review)
mode: READ-ONLY source review. 0 source edits, 0 API calls, 0 subagents, 0 broad tests, 0 real-game analysis, no holdout/gold/DWARF/source-label reads.
root: /mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida
head: `36d8451afc37bd001b878fe35358e3162c81b867` ("Prototype compact abstaining retrieval and verify actual interactive rescue", 2026-10-02 10:51:52 +0800); working tree clean (`git status --porcelain` empty).
production state: opt-in only. No product caller sets `jevRequestPolicy`, so the compact policy is unreachable except from the test file and the development script (see §5). Production stays OFF.

Context from the parent: the call-context design's positional premise (`inst.args[descriptor.index]` as a logical ABI port) was rejected as authority, because `attachAbiProjectedArguments` deduplicates SSA values and appends ABI state inputs. No new call-context facts were implemented, and this compact path does not depend on them.

---

## 0. Exact reviewed source hashes (sha256, working tree at 36d8451af)

- `js/analysis/query/jev-recovery.js` — `b64833196f578f59623e29fe2c78a5980649633156197e6a077c61daa977645c`
- `js/analysis/query/app-adapter.js` — `72cac447eac5c0a54e1b19aa524eef6342f525de18aee9b4d839e6b3f1b8b0a8`
- `tests/phase7/cxx/jev-recovery.test.mjs` — `6f6650799d1ddc2686b39e5636cd917d754a3108728e570e6462f9a41c73090e`
- `scripts/evaluate-jev-compact-development.mjs` — `7e1e36408ff9529c8c53efb98f193b1f7c5ae5074844b0782ff1921014a1a89e`
- `scripts/jev-realgame-final-contract.mjs` (serialization/binding authority used by the script) — `5c27813bf8d2d4c0b9a76989e1b17dffc82944787dd04cd2983239c93ae89e7e`
- `js/analysis/cxx/query-recovery.js` (choice planner / extent authority) — `daae83d634391a328f0921dd7ddb257270627a15e9c82d1f32cb165d1d189dc6`

Exact reviewed ranges:

- `jev-recovery.js`: `COMPACT_POLICY` 16; `compactDescription` 17–20; `jevRecoveryRequest` 22–40 (compact branch 24–29, legacy branch 30–40); `selectJevRecoveryPlan` 42–101 (compact guards 50–67, timeout race 68–74, response validation 76–96, owner check 93).
- `app-adapter.js`: routing addition at 66–68; pre-existing post-selection extent filter 76–81; interactive entry 124–126.
- `jev-recovery.test.mjs`: compact tests 232–267 (abstention) and 269–303 (cap/dedup/transport).
- `evaluate-jev-compact-development.mjs`: whole file 1–70.
- `query-recovery.js`: `choices` 134–170 (semantic-retrieval-v5 focused budget 141–156), `planOwner` 173–178.

---

## 1. Focused test results (exactly one command, as authorized)

```
node --test --test-name-pattern='compact retrieval|semantic retrieval selects|disabled, stale' tests/phase7/cxx/jev-recovery.test.mjs
```

Result: 4 tests, 4 pass, 0 fail (duration ~1.2s):

- ✔ semantic retrieval selects only existing proven release functions and agrees on owning object
- ✔ disabled, stale, HTTP failure, malformed, invented choices and real timeout preserve the deterministic plan
- ✔ compact retrieval provides an explicit abstention and never interprets it as a function
- ✔ compact retrieval caps all protocol choices at255 and removes unanalysable or indistinguishable entries

No other test command was run.

---

## 2. What the compact path actually does (verified by reading, then by the tests)

### 2.1 Protocol choice budget 254 + `none` (serialized 255)

`selectJevRecoveryPlan` asks `planner.choices(query,{maxChoices:254})` for compact (line 52). `jevRecoveryRequest` throws `compact retrieval requires at most254 functions` if a caller hands it >254 (line 25), and adds `criteria.none` after building `c0..cN` (line 27). So the wire body carries at most 255 criteria keys (254 + the abstention sentinel). Test asserts `input.choices.length===254` and `Object.keys(criteria).length===255`. The planner itself already caps at 255 (`query-recovery.js` 135) and throws on `maxChoices>255`, so 254 is inside its contract.

### 2.2 Sentinel fails closed

`answer('none')` is only accepted when `compact` (line 79), maps to `index=-1` (line 81), and `indexes.some(index => index === null || index < 0)` forces `fallback()` (line 91). `fallback` returns `{source:'hex', plan: planner.plan(...)}` — the deterministic plan, not an empty plan. The test asserts `abstained.source==='hex'` and `abstained.plan` deep-equals the deterministic baseline. In the interactive caller, `requireJevSelection:true` then empties the plan (`app-adapter.js` 74), so abstention cannot be dressed up as a selection.

### 2.3 Pre-API extent filter

For compact, when `options.maxDeclaredSizeBytes` is supplied it must be a safe integer in [4,16384] or the function falls back before calling (lines 54–56). Rows must have `typeof declaredSizeBytes==='bigint'`, `>0n`, `<= BigInt(bound)` (lines 56–57). Planner rows really are `bigint|null` (`query-recovery.js` 77/86/95: `extentFor` returns `end-address`, both `bigint`). Test duplicates fixture with `257n` and `null` and asserts they never reach the client. This filter is applied **before** the request is built and sent.

### 2.4 Duplicate visible descriptions are excluded wholesale

`counts` is built from `compactDescription` over the post-extent choices, then every label occurring more than once is dropped (lines 61–66). The comment is explicit that truncation collisions count too. Conservative: both colliding members are removed rather than one being chosen. Test asserts the surviving choices are exactly the two unique labels.

### 2.5 Production transport recomputes the whitelist body

`createJevRecoveryClient` ignores any caller-supplied `body` and rebuilds `jevRecoveryRequest(query, choices, {requestPolicy})` from `choices` (lines 9–15). Test passes `body:{oracle:'secret_oracle_label'}` and asserts the serialized request contains neither the oracle string nor anything but `questions.pick` with `criteria.none`.

### 2.6 Malformed / out-of-range / error / timeout

- Non-`openjev` payload → `fallback` (line 75).
- `answer.type!=='choice'`, invalid, or out-of-range index → `null` → fallback (77–84, 91). Test covers `c254` out of range and `invented`.
- `confidence` and `probabilities[choice]` must be unit (line 83); `NaN` confidence fails.
- Every probability **key** must be `none` (compact only) or a valid in-range `cN` with unit probability (86–89); a rogue key fails. Test covers `{c0:1,invented:0}`.
- Non-compact keeps the two-question owner-agreement check (lines 78, 93) and rejects `none`.
- `try/catch` maps every throw and the timeout/abort race to the deterministic fallback (98–101); `finally` clears the timer and removes the abort listener. The legacy test covers thrown HTTP, abort/timeout, and stale binding.

### 2.7 Legacy representation unchanged

The legacy branch of `jevRecoveryRequest` (30–40) is byte-for-byte the previous body (class / release method / address / receiver evidence; `object` + `pick`). The only control-flow change is that an unknown `requestPolicy` now falls back instead of silently using legacy (line 51) — a new fail-closed guard, not a representation change.

### 2.8 Binding and reachability

`app-adapter.js` forwards only `requestPolicy:options.jevRequestPolicy` and `maxDeclaredSizeBytes:options.maxDeclaredSizeBytes` (line 68). The interactive entry (124–126) passes `maxDeclaredSizeBytes:256` but does **not** pass `jevRequestPolicy`, so it still runs the legacy two-question policy. `grep` over `js/` and `userscript/` shows no product caller of `compact-accessor-v5`; only the test and the development script use it. Compact is opt-in and dormant.

---

## 3. Quality tradeoff: the removed owner-agreement check (explicitly unproven)

The legacy policy asks two questions and requires `object.className === selected.className` before accepting (line 93). The compact policy has only `pick`, so **that cross-question owner-agreement constraint no longer exists**. Assessment, stated without claiming safety:

- It is true that all choices are existing, planner-proven release functions, so the selector cannot invent an identity or an address. That bounds the failure mode to *choosing the wrong existing owner*, not to fabricating one.
- It is **not** thereby established that removing owner agreement is quality-safe. The specific property the second question enforced — that the selected method belongs to the object the model first declared primary — is simply absent. A method from a related or incidental object whose class/method tokens match the phrase can now be selected with no veto.
- The failure is partially contained downstream: `recoverCxxMembersForQuery` plans only the selected owner's functions and `withCxxReturnedMemberPreference` will publish nothing unless exactly one canonical return-linked member is found; the interactive caller additionally requires `requireJevSelection`. A wrong owner therefore tends to yield `no-unique-canonical-return` rather than a wrong answer, but that is a *recovery* guard, not an owner-agreement guard, and it is not a precision claim.
- The compact representation also drops `address` and `receiver evidence`, so choices are less individually distinguishable; the duplicate-label filter compensates only for exact (post-truncation) collisions, not near-duplicates.
- Offsetting, the explicit `none` abstention gives the model a way to decline that the two-question form lacks (legacy must always pick an object and a method).

Net: the owner-agreement removal is a **plausible but unmeasured quality regression risk**, balanced by an abstention option. It is not established safe. This must be measured on the frozen judge before any activation.

---

## 4. Findings

### Blocking defects
None found. Every compact behavior named in the task is present, fail-closed, and covered by the four focused tests, and the legacy path is preserved.

### Non-blocking observations
- **N-1 (robustness).** The response-validation guards at lines 79 and 87–88 are correct but rely on `&&`/`||` precedence inside one dense expression (`A || (B && C)` and `(A && B) || C`). They pass adversarial cases today, but a later edit is easy to invert. Extracting named predicates (`isValidSentinel`, `isValidChoiceKey`) would remove the footgun. Not a defect.
- **N-2 (coverage cost).** Duplicate-label exclusion removes *both* entries, including a possibly-correct accessor, when names collide at the 160-char truncation. Conservative and intentional; note it as a recall cost, not a bug.
- **N-3 (generated output).** The commit also bumps `userscript/hex.user.template.js` and `userscript/release-version.json` (generated loader identity). This is a generated-output transaction boundary (guardrails EP-003/EP-008); confirm the integration/release lane owns that regeneration. Not a code defect, and it does not activate compact.
- **N-4 (unbounded direct caller).** `jevRecoveryRequest` does not itself bound `query`; `selectJevRecoveryPlan` bounds it to 2048 chars (line 50). A direct caller could send a longer phrase. Minor hardening opportunity.

No other logic bug was found by reading, and none surfaced in the focused tests.

---

## 5. Concrete blockers / limits of this review

- BL-1 — Source-only. No live API call was made; the remote contract is inferred from the request shape and the injected-client tests, not observed.
- BL-2 — No real-game analysis, no holdout/gold/DWARF; development metadata was not read. The script's `sourceHashes` drift allowlist could not be checked against the actual metadata snapshot.
- BL-3 — Only the four authorized tests were run; the full `jev-recovery.test.mjs` and repository gate were not run.
- BL-4 — The measured-scope claims in the development script (eight live calls, four dev queries, latency percentiles) are design/structure only and were not executed or verified here.
- BL-5 — No activation/quality authorization: compact remains opt-in, unmeasured on the frozen judge, and no precision, recall, or latency claim is made.

## 6. Explicit unproven quality claims (do not treat as established)

- Removing the legacy owner-agreement check does **not** degrade retrieval precision/recall (the property the second question enforced is gone and its effect is unmeasured).
- Duplicate-label exclusion and the 4..16384 extent filter **do not** materially reduce useful coverage in real games (only adversarially/structurally reasoned here).
- The `none` abstention **does** reduce forced wrong selections on ambiguous queries (plausible, unmeasured).
- Compact does **not** change latency versus legacy (the script computes percentiles but no comparison was run).
- Request/source/metadata binding in the script guarantees reproducible real-game measurement (structure reviewed, not executed; N-4 aside).

## 7. Verdict

The compact-accessor-v5 prototype is a coherent, fail-closed, opt-in extension: 254+`none` serialized budget with the sentinel failing to the deterministic plan, pre-API extent and duplicate-label filtering, a transport that recomputes its own whitelist body, thorough malformed/out-of-range/error/timeout rejection, and an unchanged legacy representation. The four focused tests pass. The genuine risk is the deliberate removal of the two-question owner-agreement check, which is a plausible-but-unmeasured quality tradeoff and must not be treated as safe merely because every choice is an existing function. No blocking code defect was found; production stays OFF pending the frozen judge.
