# stability-design-v2 — evidence-constrained routing design receipt (CORRECTED, supersedes v1)

**Lane:** requested continuation beyond the measured `NO_GO` (remove destructive/stochastic behavior,
not merely disable Jev). **Mode:** READ-ONLY over product/evaluation sources; **0 live API calls,
0 product edits, 0 commits, no suites, no delegation, no holdout inspection.** All observed outcomes
are **development data for v2**. `TMPDIR/TMP/TEMP=/mnt/workspace/.dev-state/agent-work/scratch`.
Parent implementer owns all edits; this is a design/review receipt only.

## 0. Errata — this revision supersedes the original receipt (sha256
`6920fbef530f2a4845a7e6732020f726d37b44300de1de616a17390c9b2cc38b`, preserved in parent's backup)

Two defects in the original, corrected here:

1. **Probe scoring was not the frozen comparator.** The v1 probe `score()` omitted `demangleCxx` on
   `functionContexts[].name` (the frozen `deterministicRecoveryPick` demangles before tokenizing) and
   used `conflict → -1` instead of `0`. Therefore v1's `s` was **not** identical to frozen DET, and the
   following v1 claims are **withdrawn**: bucket counts "detDecisive 9 / contested 31", "member-augmented
   argmax DS = 4/40", "B-rule over DET accepts 3/40 — all wrong (`FH-MW-12/14/19`)", "B-rule over Hex
   accepts 19/40 (14 wrong)", and the reasoning that groundedness equals comparator decisiveness
   "by formula identity" (the identity was false under the flawed score). Corrected numbers: §2.
2. **Transport/timeout is not "zero API calls".** A timeout occurs *after* a call starts. The fail-closed
   invariant for post-call failures is **committed decision unchanged** (bounded attempts, no unbounded
   retry), not call absence. "Zero calls" applies only to pre-call gates. T3 below is restated accordingly.

Nothing in the recommendation changes; corrected analysis **strengthens** it (§1.3).

## 1. Reviewed identity and verdict

- Worktree `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`, HEAD
  `0350d215a0448cba87293ca5906e09f3aa3adaaf` plus parent's uncommitted `js/pinpoint.js` delta
  (working copy sha256 `378da9828c138af61f2e59d4732029442b25f94b3f23d26954d4ad87958e3af2`) and
  `tests/pinpoint-jev-shortlist.test.mjs`: contradictory key/index identity rejection, actual bounded
  timeout, stale/duplicate lattice-view rejection in `rerankWithJev`. Treated as landed precondition.
- Reviewed (sha256): `js/pinpoint-jev-eligibility.js` `94a507cee76efc073ae8d2598349c8e5c74608e075273fccca343a28ab7431fd`;
  `js/analysis/cxx/query-recovery.js` `8fe2c74b2748bb779c346d25dd237bea4cedc94c73ad18bd1ca84bcf760f7597`;
  `scripts/jev-realgame-recovery-contract.mjs` `e2f3f168feed368fc14e1d095c53590bb46f747075e364d67b71c3c01e3e3939`
  (=`promptSha256`, policy `e242fa93b08e3ea00666bb326f403f72a78f9a84d50e4d048adc7d1cee92008d`);
  `js/analysis/query/app-adapter.js` `d7e2a954782a8f71e2151b6ada1f04a3508ba6d7db2ace33ae1709fa391feb75`;
  `scripts/verify-jev-realgame-recovery.mjs` `5a317b0295e37c3333d9da3e98144ddb46f21e2022ba65c1420619e31d0befa4`.
- Seams: `rerankWithJev` `js/pinpoint.js:132`; `assessJevEligibility` `js/pinpoint-jev-eligibility.js:44`
  (`JEV_PIPELINE`, `JEV_REASON.DECISIVE` at `:54`); frozen comparator
  `deterministicRecoveryPick` `scripts/jev-realgame-recovery-contract.mjs:30` (evaluation-only today).
- Corrected development probe (offline, no API): `/mnt/workspace/.dev-state/agent-work/scratch/stability-design-v2-devprobe.mjs`
  sha256 `6d0f824b940d9a47e2285e63cbe547ce81d25fa19269c43d7ace733e86e41e8e`, output
  `devprobe-corrected.out` sha256 `49d32d210c1b969461fe20efd30fa268cad80e5523804fc91e582991d59a8540`;
  input hashes: `raw-results.jsonl.gz` `31902316…ae136`, `regression-controls.json` `841a16a7…651b`,
  `recovery-control-results.json` `d1affdbb…43cb`, `failure-analysis.json` `f90e99cf…5d1`.
  Snapshot recomputation reproduced every stored DET pick (0 mismatches). No `fresh-*`/holdout file
  opened; the new final holdout was neither sought nor inspected.

**Verdict (unchanged, now stronger):**

1. **No gold-free guard can remove both false choices and instability while the remote is in the
   commit path.** Acceptance of a varying remote answer is itself varying: any guard either collapses
   to a choice the deterministic layer already makes (remote adds nothing) or leaves ≥2 accepted
   outcomes (instability persists inside the accepted region). Pick at most two of: remote-in-loop,
   stability, no-gold.
2. **With byte-identical scoring, a comparative "challenger beats commit" guard over a deterministic
   argmax commit is vacuous by construction** — the argmax cannot be strictly outranked. Corrected
   measurement confirms: **0/40** remote picks pass `s(remote) > s(DET-commit)` (§2). Tier-2 remote
   commit over a DET selection is a no-op, not an experiment.
3. **Caching and majority are not promoted.** Caching gives run-to-run repeatability only *after* an
   already-stochastic first call (4/15 baseline-correct control calls destroyed, first-call-primary);
   it is presentation stability, never correctness. Majority is frozen-out
   (`recovery-policy-freeze.json.majorityVoting=false`).
4. **Recommendation (stable-local/advisory separation):** promote the pre-frozen deterministic
   comparator to the production commit (deterministic, stable, net gain over today's product) and keep
   the remote out of the committed decision — one-sided advisory/telemetry. Only construction with
   zero remote-driven destruction *and* zero effective-decision instability.

## 2. Development findings (CORRECTED — frozen-identical score)

`s(c)` = byte-identical to frozen `deterministicRecoveryPick`: `source!=='cxx' || conflict → 0`;
else `2·classHits + max(0, …, 4·methodHits·(2 if return-input))` over contexts **with `demangleCxx`**;
ties by original candidate order; score-0 → `hex top1`. (For named/ObjC candidates frozen DET is 0 by
definition; the ObjC numbers below use a clearly-labeled *proposed* `s_named = 2·classHits + memberHits`,
no contexts — a v2 design candidate to freeze prospectively, not the frozen formula.)

- Final40 (first call): Hex A **0/40**; frozen DET **5/40** (`FH-OP-03, FH-MW-03/04/05/13`); E **6/40**
  (adds only `FH-MW-11`; E ⊇ DET; E wins stable 3/3; six shortlisted failures wrong 3/3).
- Buckets under identical scoring: DET-decisive (unique positive argmax) **16/40** (DET correct 2);
  contested **24/40** (DET correct 3, E correct 4); strong/exact-authority **0/40**; "grounded but
  non-DET" **0/40** — for these all-C++ anonymous lattices, `s` *is* the frozen formula, so
  grounding = comparator decisiveness **by genuine identity** (verified: probe recomputation matches
  stored DET keys exactly; member-augmented argmax equals DET on **40/40**).
- Variant commit accuracy: Hex **0**, DET-first **5**, argmax-of-identical-`s` **5** (same picks as DET),
  Hex+challenger-guard(E) **5**, DET+challenger-guard(E) **5**.
- Challenger guard (`s(remote) > s(commit)`, strictly greater):
  - **over DET commit: 0/40 accepted — provable: commit is the argmax of `s`, so nothing can strictly
    outrank it.** The v1 "3 accepted, all wrong" was an artifact of the flawed score.
  - over Hex commit (fusion order ≠ argmax): accepts **18/40, 13 of them E-wrong**; the 5 correct
    acceptances are exactly the DET wins already covered → **net gain over DET = 0**, +13 wrong remote
    flips, +instability.
  - The only net-new correct remote pick, `FH-MW-11` (`TimeStamp.getHour` semantics), has
    `sE=4 < sDET=8` → **rejected by the guard over both Hex and DET commits.** No guard-verifiable
    independent remote value exists in the development data.
- Baseline-correct ObjC controls (proposed `s_named`; frozen DET inert for non-cxx): SP08 commit
  `SPUBasicUpdateDriver#16#_host s=5` (six-way tie at 5 among `*_host` drivers), observed destructive
  pick `SUHost#16#bundle s=1`, **0 wrong candidates strictly above commit** (guard structurally safe on
  this lattice); SP33 commit `SPUInstallationInputData#40#_signatures s=1`, destructive pick
  `SUAppcastItem#40#_signatures s=1` — equal, so **strictness is load-bearing**, 0 strictly above;
  XA40 commit `XADRC4Handle#72#key s=1`, **7 wrong candidates strictly above (`s=2`: `bytesproduced`,
  `bytestreamproducebyte_ptr`, `eofenv`, `_currblock`, …)** → guard **structurally unsafe** here despite
  observed E 5/5 correct. Any token *selector* applied to ObjC also destroys XA40 (`bytesproduced`
  wins) — hence ObjC must not enter a committing selector or committing remote path.
- Raw Jev stochasticity (remote+payload property): E 6/50, current 7/50, B 12/50 unstable on final50;
  controls E unstable 2/3 cases, **4/15 destructive**. C++ baseline-correct denominator is **0 →
  destruction there is undefined (0/0)** and must never be reported as safe.
- Retrieval ceiling unchanged: 27/40 unrecovered — a retrieval failure, never a reranker failure; no
  routing design reconstructs absent semantics, and no API can return facts the binary evidence lacks.

## 3. Proposed algorithm — "deterministic commit, one-sided remote" (v2 route)

Pure function `commit(query, hexResult, facts)`; the remote is never inside it in the default tier.

**Candidate facts (whitelisted, gold-free — same boundary as `snapshotCandidate`):** `key`, `source`,
`className`(+classIdentity), `fieldName`/anonymous offset, `size`, `recoveredType.category/.proven`,
`conflict`, `functionContexts[]` (raw release symbol for `demangleCxx`, `accessRoles ∈ {return-input,
comparison-input, arithmetic-input, address-base}`, `receiverProven`), `readCount/writeCount`,
`fusion.logOdds` order, `askedByName`, `recallLane`; lattice facts: candidate count, verdict, mode,
parser/lifter/extent completeness, `assessJevEligibility` decision. No DWARF/source/gold names, no
query/case/class/offset whitelist, no tuned confidence threshold.

```
TIER 0 — fail-closed gates:
  Pre-call (remote not contacted — zero calls): !enabled | mode≠partial | <2 candidates |
    lattice incomplete | parser/lifter/extent failure | verdict ∈ {confirmed,likely} |
    askedByName exact authority at top | eligibility ≠ ELIGIBLE.
  Post-call (call already started — bounded attempts, no unbounded retry): timeout/transport error |
    malformed or contradictory key/index identity | out-of-range/invented key | stale or duplicate
    lattice view  →  committed decision UNCHANGED (decision-preservation invariant; call absence is
    NOT claimed). Parent's identity/timeout/stale-view fixes in rerankWithJev cover this block.

TIER 1 — deterministic commit (default; promotes first):
  if lattice source is C++:  det = deterministicRecoveryPick(query, candidates)   // byte-identical
                             commit = det.score > 0 ? det : hex top1              // frozen fallback
  else:                      commit = hex top1                                   // ObjC never reselected
  Remote may be consulted only where assessJevEligibility = ELIGIBLE with DET integrated
  (DET decisive ⇒ JEV_REASON.DECISIVE ⇒ no call), but its answer NEVER changes `commit`;
  recorded as advisory annotation (optional freeze per query+shortlist+product SHA, labelled
  caching = presentation stability only). Verdict never promoted; no binary facts from remote.

TIER 2 — remote commit: NOT A SEPARATE MECHANISM over a DET selection — by §1.2 the comparative
  guard over an argmax commit accepts nothing. The only guard with bite is over the Hex fusion-order
  commit; development shows 18 accepted / 13 wrong / 0 net over DET. Kept as an explicitly
  experimental, opt-in flag whose promotion requires the prospective criteria in §5; default OFF.
```

**Eligible scope for any committing remote:** C++ partial, weak verdict, complete lattice, ≥2 eligible
candidates, DET non-decisive, no exact authority (=`JEV_REASON.ELIGIBLE` with DET wired into the
deterministic pass). ObjC/named lattices: advisory-only, ever.

## 4. Goal mapping and safety counterexamples

1. **Grounded baselines without gold:** (a) *exclusion* — Tier 1 keeps the remote out of the commit
   path, preserving every correct baseline by construction; (b) *rules* — DET decisiveness (generic
   class/member/context, frozen formula) narrows remote eligibility; comparative guard blocks strictly
   lower-scoring challenges. (b) alone is insufficient — counterexamples: **XA40** (correct commit
   `s_named=1`, 7 wrong candidates `s_named=2` pass any beat-the-commit guard; any token selector
   destroys it), **SP08** (correct baseline is *not* strict argmax — six-way tie; protection comes only
   from strictness vs the `s=1` trap, an `≥` guard would accept destruction), **FH-OP-04** (E pick is a
   conflicted lattice member → conflict veto must precede any scoring). Rules narrow the blast radius;
   only exclusion removes it.
2. **Effective stability under a varying remote:** achieved iff the remote does not determine the
   commit (Tier 1 → instability exactly 0, machine-checkable by replaying `commit` over stored facts).
   Sacrificed: remote-only committed value — on corrected development data exactly the `FH-MW-11` class
   (phrase↔release-method semantics below token/context overlap): E 6/40 → committed 5/40 (dev); plus
   remote `unique`/noul as a decision input (already forbidden). Versus today's product (Jev off,
   comparator evaluation-only) Tier 1 is strictly better: +5/40 dev rescues, zero remote dependency,
   zero API cost/latency.
3. **DET-first as stable baseline:** yes — deterministic, stable by construction, 5/40 dev vs 0/40,
   controls untouched (ObjC falls back to `hex top1`), no new analysis pass. A subsequent remote step's
   independent value is real but only in *semantics DET cannot score* (`getHour` channel); corrected
   analysis shows it is **not gold-free-verifiable per case** (its pick scores below the commit and is
   guard-rejected) and is measurable only in aggregate, prospectively. Do not claim the API can
   reconstruct semantics the binary evidence lacks.
4. Algorithm/facts/invariants above; tests §5; counterexamples: XA40, SP08/SP33 (equal-score trap,
   strictness load-bearing), FH-MW-11 (guard rejects the only net-new correct pick; every
   guard-accepted remote pick in dev was wrong or already DET-covered), FH-OP-04 (conflict veto).
5. Prospective evaluation and machine-readable criteria: §5.

**Focused tests (cheap, offline, no API):**
- **T1 purity/stability:** `commit()` on stored snapshot facts rerun with a stub remote returning a
  *different* choice each call → committed top1 identical every run (Tier 1); replay hash equals
  policy hash.
- **T2 control-shape vetoes:** synthetic lattices reproducing SP08 (tied fusion + lexical class trap),
  SP33 (equal-score trap; strict `>` required), XA40 (stronger-scoring wrong candidate): Tier 1 never
  commits a remote pick; guard variant rejects equal/lower, accepts higher only with an "unstable"
  flag; conflicted candidate rejected before scoring.
- **T3 fail-closed matrix (corrected wording):** pre-call gates → **zero calls** (spy client);
  post-call failures (timeout, transport, malformed/contradictory identity, out-of-range, stale view)
  → **call already started (bounded attempts), committed decision unchanged, no retry escalation.**
  The asserted invariant is decision preservation, never call absence for post-call failures.
- **T4 DET parity:** product copy of the comparator returns byte-identical picks to frozen
  `deterministicRecoveryPick` over hash-checked evaluation snapshots (including `demangleCxx` on
  context names — the exact defect this correction caught); score-0 → `hex top1` fallback asserted.

## 5. Prospective final evaluation and machine-readable promotion criteria (freeze BEFORE outcomes)

Arms on the separately prepared holdout (never inspected here): `A` (Hex), `R1` (Tier-1 commit, remote
out of path), `R2` (Tier 1 + remote advisory logged), `R3` (experimental remote-commit flag). Freeze
before any outcome exists: route/comparator(with `demangleCxx`)/prompt/corpus/verifier SHA-256,
repeats=3, first-call primary, `majorityVoting=false`, baseline-correct preservation set ≥15 cases
(≥5 per binary, ≥1 C++ weak-verdict) so destruction has a non-degenerate denominator. Independent
verifier replays `commit()` offline from stored facts (no API) and recomputes all metrics.

```json
{ "schema": "hex-pinpoint-routing-policy/v2",
  "metrics": {
    "rawJevStochasticity": "cases with >1 distinct remote key across repeats / cases called (remote+payload property)",
    "effectiveDecisionInstability": "cases with >1 distinct COMMITTED key across repeats+reruns / cases (must be 0 when remote not in commit path; proven by replay, not sampling)",
    "destructionFirstCall": "baseline-correct cases with incorrect commit / baseline-correct cases",
    "destructionAllRepeats": "destructive calls / (baseline-correct cases x repeats)",
    "marginalNetOverR1": "R3.correct - R1.correct (overall and per game)" },
  "criteria": {
    "promote_R1_DET_STABLE_SELECTIVE": { "required": {
      "netVsAOverall": ">0", "netVsAEachGame": ">0", "regressions": "==0",
      "effectiveDecisionInstability": "==0 (offline replay, 3 reruns)",
      "destructionFirstCall": "==0", "destructionAllRepeats": "==0",
      "falseStrong": "==0", "unsafeConfident": "==0", "remoteInCommitPath": false } },
    "promote_R3_REMOTE_COMMIT": { "requiresPromotesR1": true, "required": {
      "marginalNetOverR1Overall": ">0 with one-sided exact binomial p<0.05",
      "marginalNetOverR1EachGame": ">=0",
      "destructionFirstCall": "==0", "destructionAllRepeats": "==0 over >=15 baseline-correct cases incl. >=1 C++ weak-verdict; else UNDECIDED (fail-closed: 0/0 never passes)",
      "effectiveDecisionInstabilityOnBaselineCorrect": "==0", "destructiveInstability": "==0",
      "apiAddedP95Ms": "<=1000", "apiErrorRate": "<=0.05",
      "falseStrong": "==0", "unsafeConfident": "==0" },
      "onFailure": "advisory-only or NO_GO; no retuning, no query exceptions, no majority, no cached answer counted as accuracy" } } }
```

## 6. Hard blockers

- No gold-free rule separates baseline-correct from baseline-wrong weak lattices; C++ destruction stays
  `0/0` unless the new holdout supplies baseline-correct C++ cases — R3 cannot promote without them.
- Guard-accepted remote value over DET is **0 by construction (identical scoring) and 0 by measurement
  over the Hex commit** (5 = 5 dev, 13 wrong flips); R3 promotion evidence does not exist and must come
  from the new holdout.
- 27/40 unrecovered is a retrieval ceiling; routing must not be scored as if it could fix it.
- Missing release semantics (constructor-only evidence, anonymous offsets) cannot be reconstructed by
  any remote prompt; the API returns a preference among existing candidates, never new facts.

## 7. Integration seams for the parent (no edits made here)

`js/pinpoint.js`: add pure `deterministicCommit` + `remoteMayCommit:false` default flag inside
`rerankWithJev`; factor the comparator from `scripts/jev-realgame-recovery-contract.mjs:30` into a
product module **including `demangleCxx`** with T4 parity against the frozen copy; wire
`assessJevEligibility`'s `deterministicEvidence` to DET decisiveness; tests T1–T4 alongside
`tests/pinpoint-jev-shortlist.test.mjs`. Parent's identity/timeout/stale-view fixes are Tier-0
preconditions and are not re-derived here.
