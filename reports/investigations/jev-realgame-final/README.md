# Jev / Pinpoint real-game final decision

## Executive Summary

**Final production policy: NO_GO. Jev remains disabled by default.** Improved anonymous-C++ Jev E rescued **1 OpenTTD case and 5 OpenMW cases**, with **0 primary C++ regressions**, on the independent final judge. Hex top-1 was **0/40**; E was **6/40 (15%)**. The pre-frozen deterministic comparator already achieved **5/40**. Hex recovered the correct structural member in **13/40 (32.5%)**. This demonstrates conditional semantic value, but insufficient value and preservation evidence for normal routing.

Zero C++ regressions do not establish safety: Hex had zero correct answers, so destruction is **undefined (0/0)**. E destroyed baseline-correct regression controls on **4/15 repeated calls**; SP08 and SP33 remained unstable. API latency was **698 / 998 / 1118 ms p50/p95/p99**. Explicit cold recovery had separate substantial costs. The frozen classification does not qualify for optional or default promotion.

高校生向け：Hexがゲーム内の候補を探し、Jevがその中から人間の質問に近い候補を選びます。今回は40問中13問で正解の候補を見つけ、Jevが6問を正しく選びました。関数名などの手掛かりがある候補には効果がありますが、匿名の番号しか分からない候補の意味は当てられません。既に正しい答えを壊す問題も残ったため、通常ONにはしません。

This report separates the original frozen70 experiment, its expanded **development replay**, and a separately frozen **final50** (40 verified answers, 10 controls). Every semantic result uses actual production candidates from the release games and real remote calls. Independent offline replay checks requests, responses, scoring and aggregates. Synthetic fixtures validate boundaries only.

## What changed

Integration starts from main `d2177389cd1770edb3548251a080bf23e829a8a0`, incorporates A (`bb5f415cc9498aff47fc41f0867f201a515d53b2`, PR #9662) and B (`b696f8fcc`), and preserves main's changes. [PR #9663](https://github.com/rhgrive3/hex-ida/pull/9663) consolidates implementation and decision.

Production publishes canonical C++ member evidence into Pinpoint, preserves anonymous members, and adds an **explicit** query-directed recovery action. Its pure planner selects up to eight release-symbol/canonical-owner functions for existing scoped Fast analysis. It does not run automatically for every member or add a heavy pass to ordinary Fast. Existing member-type analysis provides four bounded machine roles: return input, comparison input, arithmetic input and address base. These observations do not manufacture source semantics. Folded/ambiguous release aliases and adjusted receivers fail closed.

A real OpenMW hang was profiled before repair. An existing recursive SSA dependency walk revisited shared subgraphs exponentially. Its iterative replacement visits each object once, with 12,000-node/96,000-edge limits and cancellation. Exhaustion returns unknown; both consumers conservatively preserve stores. It adds no analysis pass, ranking exception or binary fact. All formerly stalled collections completed after repair. See [runtime disclosure](recovery-runtime-repair.json) and [independent native review](native-repair-review.md).

Evaluation now uses exact-build structural gold, frozen representations/policies, the full recall funnel, actual payloads/responses and independent replay. Safety/integrity tests enter the canonical chain. Temporary diagnostic/probe scripts are removed; historical evidence and commits remain retained.

## C++ candidate publication

| Collection profile | Game | Before → after | Classes | Named / unnamed | Key collisions |
|---|---|---:|---:|---:|---:|
| Original blind 30-function warmup | OpenTTD | 0 → 47 | 19 | 0 / 47 | 0 |
| Original blind 30-function warmup | OpenMW | 0 → 19 | 10 | 0 / 19 | 0 |
| Original70 query-directed development | OpenTTD | 0 → 180 | 38 | 0 / 180 | 0 |
| Original70 query-directed development | OpenMW | 0 → 59 | 4 | 0 / 59 | 0 |
| Independent final50 query-directed | OpenTTD | 0 → 127 | 18 | 0 / 127 | 0 |
| Independent final50 query-directed | OpenMW | 0 → 133 | 34 | 0 / 133 | 0 |

The latter profiles select different functions and accumulate evidence in a shared per-game session. Their counts are not a controlled publication-only comparison. Original 47/19 isolates the publication connection; larger counts describe added explicit analysis. All members remain anonymous.

Publication accepts canonical receiver/member objects only. Owner, binding, offset, width and access proof must agree. No proof, malformed evidence, mixed/indexed accesses, ambiguous owners and secondary adjusted receivers are rejected. Keys include class/structural identity and are disjoint from ObjC keys. Observations deduplicate per function, provenance is bounded to 64 contexts, and cache views bind binary/slice/backend/symbol identity and index revision. Reading/publishing launches no recovery. Anonymous names cannot independently create strong verdicts.

The original 0→nonzero change connects already recovered canonical evidence to shared enumeration. See [publication review](publication-review.md), [recovery design](recovery-design.md), [adversarial review](recovery-final-review.md) and [fix verification](recovery-final-review-verify.md). Receipts retain reviewed SHAs/scopes; they do not substitute for final-head CI.

## Structural gold mapping and OpenMW authority

Original70 queries retain SHA-256 `05def989cdf8df4728bbdee5201f069e37a4e2a0c0d8bd6a91055cd10895df9a`. Its 55 initial answerable labels audit to **49 verified (48 OpenTTD, 1 OpenMW), 6 unverified, 15 controls**. Unverified cases execute but do not count toward accuracy. No query was rewritten to suit recovery.

Both games use exact Ubuntu debug packages matching the release build-ID:

| Game | Release SHA-256 | GNU build-ID |
|---|---|---|
| OpenTTD 13.4-1build3 ARM64 | `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5` | `d878fe2573ea43be2209d5ea5afef0b476f39d70` |
| OpenMW 0.48.0-1ubuntu5 ARM64 | `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db` | `eef0625b6b9af7971e72c4fc8260258b50dcae43` |

RTTI proves class identity, not member names/offsets. Older OpenTTD DWARF is rejected: exact `Vehicle.cur_speed` is **offset 274, size 2**, not historical 306. RG33 `CompanyProperties.max_loan` and RG44 `Window.scale` are absent. OpenMW RG51–53 lack proven health/fatigue/magicka identities; `mSpells` is a known-spells container, not a replacement. RG54's unqualified `CreatureStats.mLevel` has ambiguous namespace authority. RG55 `MWWorld::Ptr.mRef` is verified at offset 0, size 8.

Scoring uses binary SHA + exact owner/layout identity + byte offset + size. Source labels are report-only. Compiler metadata proves allowed inherited-owner aliases and base displacements; production ownership is never rewritten from gold. Exact source types/layout are audited separately. Machine-use categories need not equal original C++ types; category veto applies if explicitly supplied, but neither actual corpus invents an exact-category constraint. Width/owner conflicts still fail closed. A synthetic type-veto test is not evidence that all source types were recovered.

Fresh50 has **20 exact-layout answers and 5 controls per game**. Parent independently re-extracted GDB layouts and checked **40/40**. It has no original-query or physical-gold overlap. See [original authority](oracle-authority.json), [original audit](oracle-audit.md), [fresh authority](fresh-holdout-authority.md), [parent authority](fresh-parent-authority.json), and retained layouts. Collectors receive only binary key/hash, case ID, query and mode; gold/debug/source names are outside their input boundary.

## Representations, tuning separation and policy freeze

[Original policy](policy-freeze.json) froze A baseline, deterministic comparator, current Jev, B minimum (`Class.member_0xOFFSET`), C structured (class/offset/recovered category/size), and **primary D** (C plus existing read/write/function context). D scored 0/49 and was not replaced after seeing other arms. First repeat is primary; three calls measure instability, never majority voting.

After the original failure and the user's recovery request, original70 became development data. A separate agent froze fresh50 before final evaluation. [Experiment freeze](recovery-experiment-freeze.json), [final policy](recovery-policy-freeze.json) and [development policy](recovery-policy-freeze-development.json) bind hashes and identical collection settings, with separate arm sets. Final policy SHA is `e242fa93b08e3ea00666bb326f403f72a78f9a84d50e4d048adc7d1cee92008d`; final structural-case SHA is `1846809a9c453e625db18fb0c994d4554ef585b1120db1fa75c1e5b4a9e15b8c`.

Improved E adds only release-derived methods, existing counts and four canonical roles to structured candidates. Its general instruction separates the queried object/value from actions/helper objects. The frozen deterministic comparator scores class tokens and bounded method tokens with return-input evidence, original-order ties and conflict veto. It is evaluation-only. No class, offset or query whitelist exists.

Partial retrieval/deterministic results from failed collection attempts were inspected before the **runtime-only** SSA repair. That is disclosed rather than described as completely blind retrieval tuning. Final prompt, queries, scoring and ranking did not change after final outcomes. E final calls occurred only after repair. No post-result threshold, hybrid route or majority-vote promotion was introduced.

## Candidate recall funnel — independent final judge

| Stage | OpenTTD | OpenMW | Total |
|---|---:|---:|---:|
| Verified answerable | 20 | 20 | 40 |
| Matching raw member recovered | 7 | 6 | 13 (32.5%) |
| Gold in eligible lattice | 6 | 6 | 12 |
| Gold in shortlist ≤255 | 6 | 6 | 12 |
| Hex top-1 | 0 | 0 | 0 |
| Improved E top-1 | 1 | 5 | 6 |
| Not recovered | 13 | 14 | 27 |
| Recovered but eligible-lattice excluded | 1 | 0 | 1 |
| Eligible published but outside shortlist | 0 | 0 | 0 |
| E failures among shortlisted gold | 5 | 1 | 6 |

Retention is **12/12 (100%)**. Recovered-only E accuracy is **6/13 (46.15%)**; shortlisted-only is **6/12 (50%)**. Per-game recovered-only: OpenTTD 1/7, OpenMW 5/6.

Frozen `recoveredButNotPublished` includes FH-OP-12: **Order.type is physically published at offset 4, size 1**, but incompatible int8/bool-like evidence marks it conflicted and excludes it from the eligible lattice. This is a conservative veto, not a missing publication hook. Frozen metrics/denominators are retained. The 27 unrecovered cases are retrieval failures, not Jev mistakes.

## Accuracy and per-game results

Rescues/regressions compare with actual Hex A on identical per-case snapshots. Primary is the first call.

| Arm | Top1 / 40 | Rescue | Regression | Net |
|---|---:|---:|---:|---:|
| Hex A | 0 (0%) | 0 | 0 | 0 |
| Frozen deterministic | 5 (12.5%) | 5 | 0 | +5 |
| Current Jev | 3 (7.5%) | 3 | 0 | +3 |
| B anonymous minimum | 2 (5%) | 2 | 0 | +2 |
| Improved E, primary | 6 (15%) | 6 | 0 | +6 |

| Game | Hex | Deterministic | Current | B | E | E rescue / regression |
|---|---:|---:|---:|---:|---:|---:|
| OpenTTD | 0/20 | 1/20 | 0/20 | 0/20 | 1/20 | 1 / 0 |
| OpenMW | 0/20 | 4/20 | 3/20 | 2/20 | 5/20 | 5 / 0 |

E versus deterministic is **+0 OpenTTD, +1 OpenMW**, with zero regressions. All six E successes were correct 3/3. Regression/rescue is 0/6, but baseline destruction is undefined 0/0. This small sample does not establish broad safe coverage.

Original70 expanded development recovered **9/49 (18.37%)**, all OpenTTD, versus initial **2/49 (4.08%)**. Development A/B were 0/49; deterministic/E 1/49 (one rescue, zero regressions). Original OpenMW still has only one verified question and no recovery. These results are not independent final success.

Historical blind30 A/DET/D scored 0/49; current/B/C 1/49, one OpenTTD rescue and zero regressions. D recovered-only was 0/2; current/B/C 1/2. Four remote arms made 840 calls. [Initial summary](summary.json) and [integrity](evaluation-integrity.json) preserve that failure.

## Failure analysis and semantic evidence

[Failure analysis](failure-analysis.json) records all development/final cases, raw funnel, frozen causes and instability. No baseline-correct C++ case was excluded. All six final shortlisted failures were wrong 3/3:

| Case | Report-only gold | Cause |
|---|---|---|
| FH-OP-04 | Vehicle.colourmap | Constructor-only evidence cannot identify palette meaning. |
| FH-OP-05 | Vehicle.group_id | Group owner is a lexical trap for a Vehicle field; insufficient semantics. |
| FH-OP-07 | Vehicle.cargo_age_counter | Constructor evidence cannot identify cargo age; wrong owner selected. |
| FH-OP-18 | Group.folded | Constructor context cannot distinguish boolean-like fields. |
| FH-OP-20 | CompanyProperties.face | Verified Company base layout, insufficient face semantics. |
| FH-MW-10 | AiSequence.mNumCombatPackages | Queue/object versus numeric count; noun/action confusion. |

Successful release context includes `Vehicle.GetEngine/GetGRF/GetGRFID`, `CreatureStats.getKnockedDown/getFallHeight`, `NpcStats.getBaseDisposition`, `TimeStamp.getHour` and `CellStore.getWaterLevel`. These are release symbols, not DWARF labels injected into production. They explain why some anonymous offsets are selectable. Constructors accessing many offsets do not explain which means speed, money or face. Missing semantic evidence is explicit.

## SP08 / SP33 / XA40

Actual historical ObjC lattices are retained and hash-bound. E made five calls per baseline-correct query:

| Control | E correct | Stability | Destruction |
|---|---:|---|---|
| SP08 basic driver's host | 3/5 | Unstable | Two SUHost.bundle selections: lexical trap / owner confusion. |
| SP33 installation signatures | 3/5 | Unstable | Two SUAppcastItem._signatures selections: duplicate name / owner confusion. |
| XA40 RC4 key | 5/5 | Stable | Zero |

All first repeats were correct, but **4/15 (26.67%) correct baseline calls were destroyed**, with destructive instability in **2/3 cases**. Majority voting is not promotion evidence. Initial D had SP08 5/5, SP33 0/5, XA40 5/5; B SP33 2/5. Class context helps but does not eliminate these traps. See [E calls](recovery-control-results.json) and [original calls](control-results.json).

## Latency and reliability

Final50 made **450 API calls** (150 each current/B/E), development70 **420**, and E controls **15**. All final calls had **0 errors, 0 timeouts, 0 retries**. Failure fallback is tested separately; this sample does not guarantee availability.

| Measurement | p50 ms | p95 ms | p99 ms | Scope |
|---|---:|---:|---:|---|
| Hex without Jev | 2.55 | 7.26 | 9.97 | Cached final queries, excludes cold setup |
| E added API | 698.16 | 997.62 | 1118.11 | 150 calls |
| E cached total | 701.32 | 1000.71 | 1120.19 | Hex plus API |
| Explicit cold recovery | 16386.43 | 37743.81 | 77263.77 | 50 driver operations, excludes host/planner setup |
| E control API | 710.74 | 2081.11 | 2081.11 | 15 calls |

The 15-second recovery budget is **cooperative**, not a hard wall-clock timeout. Synchronous analysis overruns it: fresh OpenMW maximum was 77.26 seconds. Final overrun statuses: 13 OpenTTD, 20 OpenMW. SSA repair prevents the observed exponential stall but adds no hard interruption boundary. Separate cold setup was 25.75 seconds for final OpenTTD and 230.63 seconds for development OpenMW, dominated by binary opening. These costs are not hidden in API latency.

E differed across repeats in **6/50 (12%)** cases: FH-OP-01/08/14/20 and FH-CTL-01/08. Current differed in 7/50, B in 12/50; first call determines accuracy. Development E differed in 20/70, initial D 14/70. All 10 final controls received weak preferences and zero strong verdicts: this is **not semantic abstention**.

## Safety and privacy

Jev selects an existing candidate only, shortlist ≤255. Errors, timeout, malformed response, out-of-range and invented candidates fall back to Hex. Disabled/API-less Hex works. Remote choices add no binary facts or strong verdicts; deterministic exact/strong paths retain eligibility protection. False-strong and unsafe-confident are **0 under this verdict-preservation definition**, not proof of calibrated remote confidence.

Improved E and deterministic comparator remain evaluation-only; no normal/default API route is enabled. Explicit recovery performs local analysis and makes zero Jev calls. No bulk per-member API route exists. Existing optional external use sends the human query and bounded candidate descriptions: class, offset/category/size and available release contexts. Raw binaries, debug packages, DWARF/source gold names and API credentials do not enter evidence payloads or remote logs. Context is bounded and contains no invented semantic label.

Tests cover named/anonymous publication, multiple classes/shared offsets/names, malformed/no-proof/ambiguous ownership, aliases, snapshots, ObjC separation and keys; anonymous/class representations and structural alternatives; disabled/strong preservation, 255-boundary and transport failures; corpus/manifest/build/source/prompt bindings, oracle leakage, budget receipts and replay tampering. Actual WebKit tests candidate growth and unchanged result UI when explicit recovery makes no progress.

## Final production policy and limitations

**NO_GO for ordinary Jev routing.** Frozen criteria consider gain, regression severity/destruction, recall, semantics, deterministic alternative, latency, reliability and fail-closed behavior. The old regressions≤1 condition is not the sole gate. Recall and repeated preservation controls fail; no validated generic selective route exists. No post-result threshold, query exception or new default comparator is introduced.

Blockers: **27/40 unrecovered identities**, constructor-only semantics, **4/15 destructive control calls**, only **+1 answer over deterministic**, no baseline-correct C++ sample, external dependency and costly cooperative cold recovery. Oracle labels cannot legally fix these limitations. Future promotion needs better release-derived coverage and a new independent judge, not retuning these outcomes.

User-visible changes are anonymous C++ Pinpoint candidates, explicit query-related routine analysis, conservative owner binding and repair of the native stall. E's 6/40 success is experimental value under useful evidence, not default semantic accuracy or recovered source names.

## Evidence and final verification

All four repaired collections succeeded at **`1c274ec00d8006354a01db415a8c91b86f3a2dc0`**: [run 36723696486](https://github.com/rhgrive3/actions/actions/runs/36723696486). [Recovery integrity](recovery-integrity.json) binds nine source hashes, binaries, snapshots, freezes and policy. Independent replay validated **70 cases / 49 verified / 420 calls** and **50 / 40 / 450**. Artifact/report-only final cleanup is checked against these hashes; old CI is not substituted for final-head proof.

Lossless raw calls/snapshots are indexed by [packaging manifest](evidence-packaging.json). [Development summary](recovery-results/development-original70/summary.json) and [final summary](recovery-results/untouched-final/summary.json) retain machine-readable metrics. Failed/cancelled pre-repair collectors remain failures. Final-head canonical gate, generated rebuild, focused real games and merge-tree/review receipts are attached to [PR #9663](https://github.com/rhgrive3/hex-ida/pull/9663). External PR receipts bind the ultimate SHA without creating a post-gate report commit.

Offline replay, no API:

```sh
REPORT=reports/investigations/jev-realgame-final
node scripts/verify-jev-realgame-final.mjs "$REPORT/production-snapshots" "$REPORT"
node scripts/verify-jev-realgame-recovery.mjs "$REPORT/development-original70.json" "$REPORT/recovery-snapshots/development-original70" "$REPORT/recovery-results/development-original70" "$REPORT/recovery-control-results.json"
node scripts/verify-jev-realgame-recovery.mjs "$REPORT/fresh-structural-cases.json" "$REPORT/recovery-snapshots/untouched-final" "$REPORT/recovery-results/untouched-final" "$REPORT/recovery-control-results.json"
```

## Requested numerical answers

| Question | Independent final answer |
|---|---|
| 1. OpenTTD improvements / worsening | **1 / 0**, 20 verified questions |
| 2. OpenMW improvements / worsening | **5 / 0**, 20 verified questions |
| 3. Correct member recovery | **13/40 = 32.5%**; OpenTTD 7/20, OpenMW 6/20 |
| 4. Jev among recovered | **6/13 = 46.15%**; eligible shortlist 6/12 = 50% |
| 5. Hex versus Jev top-1 | **0/40 versus 6/40**; deterministic 5/40 |
| 6. Correct Hex destruction | C++ **N/A (0/0)**; control calls **4/15 = 26.67%** |
| 7. Added latency | **698 / 998 / 1118 ms p50/p95/p99**, cold costs separate |
| 8. Ordinary ON? | **No. NO_GO, default-off.** |
| 9. Blockers | Low recovery, missing semantics, destructive instability, +1 over deterministic, missing preservation sample and latency. |
| 10. User benefit | Actual anonymous game candidates, explicit related-routine recovery and native stall repair; experimental E rescues 6/40. |
