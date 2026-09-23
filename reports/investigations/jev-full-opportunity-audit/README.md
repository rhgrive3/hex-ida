# Jev / OpenJev full opportunity audit

Scope: investigation, measurement and design only. No production Jev integration, Pinpoint ranking/verdict change, or runtime API dependency is proposed. The measured product base is `09dfcb283f721b6598f34675a8a42480147d5752` (fetched `origin/main`, 2026-09-23). The three game binaries, query fixture and collector are hash-bound in [`manifest.json`](./manifest.json). The baseline was freshly collected on this base. Every candidate and evidence summary used by the live ranking calls was byte-for-byte the same as the older #9450 lattice; top1 and P4 verdicts also matched 426/426. The only collector edit in this PR permits a persistent external binary fixture root.

The #9464 scheduler audit was still an open PR when this audit started. Its pinned result commit is `64096f5cb04c300a6bc7f412d7030896bc48d067`; the current checked head is `f035af71dd183c25d36af7d1eebe413ecfd4bb04`, which corrected offline latency-budget hindsight. We reran the fixed scheduler against its 61-case catalog and confirmed H6 21/61, budget oracle 21/61, and gap zero. We then broadened the same receiver-safe catalog to 105 currently ambiguous partial rows with at least two candidates: H6 resolved 2/105, the six-action budget oracle resolved 2/105, the unbounded oracle resolved 2/105, and the gap remained zero. This report treats both catalogs as measured studies, not the Hex-wide denominator. Relevant antecedents are [#9432](https://github.com/rhgrive3/hex-ida/pull/9432), [#9437](https://github.com/rhgrive3/hex-ida/pull/9437), [#9448](https://github.com/rhgrive3/hex-ida/pull/9448), [#9450](https://github.com/rhgrive3/hex-ida/pull/9450), [#9464](https://github.com/rhgrive3/hex-ida/pull/9464), C++ recovery [#9447](https://github.com/rhgrive3/hex-ida/pull/9447), and the subsequently checked, still-open canonical member-evidence projection [#9469](https://github.com/rhgrive3/hex-ida/pull/9469) at latest head `6d31d638a7102cd48316bc70a3822a858e3a3ddd`.

## 1. Executive summary

**Production recommendation: no Jev integration from these results.** The strongest *observed* Jev signal is a forced choice among existing candidates for partial/remembered-name queries. On 196 queries, names alone move 46 wrong top1 answers to the fixture truth and 7 correct answers away from it. This would be a net 39 top1 improvement if all 196 were forcibly reranked, but it is not a safe product result: 29 of the 46 rescues occur on currently strong results, where a model preference cannot overrule binary evidence or promote a verdict. Restricting to ambiguous results gives 17 rescues and 6 regressions before any confidence gate. A conservative uniqueness/confidence gate fires in **0/196** cases.

A simple deterministic lexical grid, selected on BattleCats and evaluated on TsumTsum/YWP, gives 103 rescues and 4 regressions (152/196 partial correct). This is a **benchmark shortcut**, not a production proposal: the fixture partial queries were generated as last-two-word tails of longer unique field names, and the selected rule rewards longer suffix matches. The same generator and SDK families occur on both sides of the binary split. The six label-only Jev rescues missed by this one deterministic comparator do not prove that only Jev can solve them. **Defensible Jev-only rescue count among the 144 current wrong top1 rows: 0 demonstrated.** Raw forced-choice rescue count is **46**, with seven regressions and no strong-verdict authority. The broadened evidence-planning screen adds no Jev-specific rescue: its deterministic H6 already equals both scheduler oracles.

The most plausible future integration point, if independently validated, is a bounded *hypothesis-only* semantic interpretation/rerank suggestion for ambiguous partial/free-form intent, after binary candidate admission and before user-facing explanation. No current predicate achieves the necessary correctness and latency evidence. Semantic names for unnamed fields are a separate research lead, not a measured production gain.

## 2. Current Hex failure landscape

The latest-main real-binary field denominator is BattleCats 206, TsumTsum 120, YWP 100: **N=426**. Truth candidate presence is 426/426. Top1 is 282/426 (66.2%): exact 229/230 (99.6%), partial 53/196 (27.0%). There are 144 wrong top1 rows (1 exact, 143 partial). Under P4, 211 correct rows are strong, 71 correct rows are ambiguous, 67 wrong rows are strong, and 77 wrong rows are ambiguous. Scores are not calibrated as correctness probabilities; #9432's high-score bucket already showed this problem.

The mutually exclusive current-field taxonomy is in [`failure-taxonomy.json`](./failure-taxonomy.json). Its overlapping, snapshot-observable tags include 53 literal top alternatives matching the short phrase, 54 truths on the lexical recall lane, 21 wrong tops in the same class as the truth, 6 same field names across classes, 5 truths with higher fusion score but a lower display rank, and 113 wrong rows whose truth lacks a dataflow evidence group. These are **descriptions of the captured lattice**, not proofs of the first causal defect. A separate #9450 diagnostic found 22/144 without a captured positive evidence differential and 122/144 with only metadata or weak differentials. This audit's stricter ordered-code equality tag counts 18, so the two numbers use different definitions.

| Required category | Latest-main observation | Limit of claim |
| --- | --- | --- |
| Candidate recall | 0/426 misses | #9437 repaired the measured remembered-name narrowing loss; unseen paraphrases remain unmeasured. |
| Ranking | 144/426 wrong top1 | Dominant field-query failure; one exact and 143 partial. |
| Confidence/calibration | 71 correct-but-ambiguous; 67 wrong-but-strong | Jev preference is not an independent evidence group. |
| Query interpretation / alias ambiguity | 53 literal alternatives; 6 same names across classes | The fixture truth is a hidden class+field identity; the short phrase often does not distinguish it. No independent user-intent labels. |
| Semantic evidence, type/class/object, cross-function, structural equivalents, evidence conflict | Captured weak/duplicate signatures and 5 score/order conflicts above | Causal attribution and broader primitive availability are not established by these snapshots. |
| Unsupported / parser / lifter / extent | 0 such errors in this 426-field denominator | A separate older [unsupported-semantics study](../unsupported-semantics/README.md) found 320 DT_INIT/DT_FINI extent gaps, and [function discovery](../function-discovery/README.md) classified 172 IDA-only rows. These were not remeasured as current-main counts here. |
| Location / field / exact / partial / free-form | 1 DSDA location holdout; 426 fields, including 230 exact and 196 partial; 0 independently authored free-form intents | DSDA is excluded from the 426 field rates. |

The corpus is largely metadata-rich ObjC/SDK fields. It is **not** an adequate standalone oracle for gameplay concepts such as `attack power`, `player hp`, or unnamed C++ `field_38` roles. Calling the hidden unique-name field the only semantically valid answer to `close button` or `wait time` would overstate the ground truth.

## 3. Investigated Jev use cases

[`use-case-matrix.json`](./use-case-matrix.json) records A–H plus structural failures, their denominators, baseline, deterministic alternative, Jev result, oracle and disposition. The screen starts with failure distributions. A, C, F and G received live Jev calls because a semantic choice could plausibly affect them. B has zero remaining recall ceiling on this corpus. The current SystemOne contract returns a choice among **client-supplied** criteria; it cannot emit a novel synonym string through this endpoint. A bounded synonym dictionary supplied by Hex could also be enumerated deterministically, so no unique generation gain is claimed without a separate paraphrase holdout. D's original 61-case catalog and the broadened 105-row ambiguous-partial catalog both have zero scheduler-oracle gap after H6. E's RTTI/vtable truth and the structural `OTHER` cases require binary proof. The separate CodeFuse source-repair lane needs generative code and compiler/runtime verification; SystemOne's typed choice output cannot perform that job. H lacks an objective next-step or analyst-value label and the present API only returns typed judgments, not free-form explanations.

## 4. Real-binary methodology

The baseline is one production `pinpointField` analysis per query using the 28.2 MB, 46.0 MB and 63.5 MB cached game binaries. It records all candidates, independent fixture truth, evidence groups, verdict and latency. The hashes match #9464's fresh corpus; the current-main collection completed 427 rows, including a separately excluded DSDA holdout. `rows.jsonl` in this PR is a compact projection of the 426 field rows plus live outputs. No API request contains `truth`, `expectedClass` or `expectedField`.

OpenJev was probed *before* evaluation. On 2026-09-23, `GET https://api.openjev.sh/v1/models` returned the `openjev` model and `POST /v1/systemone` returned model `openjev` with typed `choice`/`noul` answers under `answers`. This matches the [current official API reference](https://api.openjev.sh/docs) and [advanced contract](https://openjev.sh/docs/advanced); the older `api.codiv.ai` / `openjev-0.1` design note was not used as a live contract. Keys stayed in the environment. API responses were validated for model, type, candidate ID, probability and uniqueness; failures fallback to the existing top index.

The ranking ablation uses the **same 196 partial queries and same complete candidate universe** in three independent calls per query: field name only; field+class; field+class+existing binary evidence codes/groups. It sends no source name or truth. All 588 calls completed with no HTTP/shape/timeout error. Baseline and offline deterministic arms cost zero API calls and no extra binary analysis. The lexical grid has 168 fixed parameter settings; BattleCats 86 selects one and TsumTsum/YWP 110 evaluate it. Because the query-construction rule is shared, this is not an independent natural-language holdout.

Access-pattern, call-site, update/read-site and bounded-disassembly ablations on the **426 game-query lattice are N=0**: the frozen per-candidate rows do not contain receiver-proven versions of those facts. The #9464 61-case probe catalog records selectors and some verified accessor observations. The broadened run covers 105 current ambiguous partial rows (76 wrong and 29 already correct), but it remains a catalog-relative oracle: 51 rows lack a scored analysis primitive, 6 lack a binary-supported observation, and 17 remain in other unresolved categories. Filling those arms with guessed disassembly would break the binary-fact boundary. A separate seven-field compiler-produced AArch64 ELF screen tests local facts versus cross-function facts; two roles are marked unresolvable from the presented evidence, leaving five supported labels. This fixture is a diagnostic, never a production GO denominator. #9469 at latest head `6d31d638a7102cd48316bc70a3822a858e3a3ddd` adds canonical per-function member evidence to the C++ projection seam and measures six typed member observations per compiler fixture, correcting two stale-projection false positives. Its latest follow-up also rejects a missing member offset before canonicalization, preserving the binary-grounded location invariant. It still deliberately emits no semantic field names; it had not merged into the measured main.

## 5. Per-use-case results

| Use | N | Baseline | Deterministic | Jev-assisted | Oracle / finding | Decision |
| --- | ---: | --- | --- | --- | --- | --- |
| A intent / C ranking, partial | 196 | 53 correct | 152 correct, 103 rescue, 4 regression; generator-biased | name-only 92 correct, 46 rescue, 7 regression | hidden-truth candidate oracle 196; no user-intent oracle | RESEARCH_ONLY |
| B generation | 426 | 426 present | #9437 fixes measured misses | No live call | recall gain ceiling 0 | NO_GO on this corpus |
| D1 current probes | 61 | 19 correct | H6 21 correct, 222 extra analyses; post-hoc | No live scheduler call | budget/unbounded oracle 21 | NO_GO |
| D2 broader planning | 105 ambiguous partial (76 wrong) | 29 correct baseline | H6 31/105, 2 rescues, 0 regressions | not a Jev call | budget/unbounded oracle 31/105, 2 resolved, gap 0 | RESEARCH_ONLY; NO_GO for this catalog |
| E RTTI / virtual dispatch | 3 compiled variants | #9447 facts; #9469 member projection pending | deterministic binary proof | no proof call | semantic naming separated to F | NO_GO for model inference of facts |
| F field roles | 5 supported of 7 compiler fields | type/width facts only | local 3/5, cross-function 4/5 | local 2/5, cross-function 4/5 | 2 controls not distinguishable | RESEARCH_ONLY |
| G cross-function semantics | same 5 | local evidence | 3→4 correct | 2→4 correct | no net gain over deterministic | RESEARCH_ONLY |
| H explanation/guidance | 61 focused | reason/probe table exists | reason templates derive from it | no objective live test | 59 remain unresolved after catalog | RESEARCH_ONLY |

The seven compiler roles are health, state, object reference, speed, ammo, text and a boolean flag in a real clang-linked binary from #9447's source fixture. `state` (incrementing word) and `ammo` (constructor constant 30 only) are *not* scored as evidence-supported semantic identifications. Method symbol names make four of the remaining five roles accessible to deterministic rules. The local/cross-function model comparison is recorded row by row in [`field-role-results.json`](./field-role-results.json).

## 6. Deterministic vs Jev comparison

| Partial 196, forced top1 | Correct | Wrong→correct | Correct→wrong | Extra analysis | API calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production baseline | 53 | 0 | 0 | 0 | 0 |
| Deterministic lexical screen | **152** | **103** | 4 | 0 | 0 |
| Jev, semantic label only | 92 | 46 | 7 | 0 | 196 |
| Jev, class/context | 88 | 47 | 12 | 0 | 196 |
| Jev, evidence summary | 75 | 38 | 16 | 0 | 196 |

Adding class and current evidence degrades model accuracy. A plausible explanation is that existing metadata/dataflow signals favor the literal alternative, while the hidden fixture label favors a longer field name; this is an **inference**, not proven model behavior. The deterministic screen beats Jev across the generator-shared TsumTsum/YWP holdout (81/110 vs label-only 45/110). It still has four regressions and no calibration proof, so it is not a proposed product rule. Against this single comparator, Jev alone rescues 6, 8 or 8 rows depending on arm; those rows are not evidence of Jev-exclusive solvability. Several repeat the same field/query family across binaries.

On #9464's focused 61 cases, label-only Jev forced preference yields 25/61 (11 rescues, 5 regressions) while the lexical screen gives 49/61 (31 rescues, 1 regression). These are **pre-verdict preferences**. H6 and oracle each reach 21/61 with binary-backed strong evidence; the metrics are not interchangeable.

## 7. Oracle ceilings

[`oracle-ceilings.json`](./oracle-ceilings.json) separates three meanings. The candidate oracle is 426/426 because every truth is present. An oracle told the hidden fixture identity could choose all 426, but is not deployable. The recorded-evidence diagnostic from #9450 had no robust truth-side deterministic differential among the 144 wrong rows; it does not bound future acquired semantic facts. The P4 confidence oracle could mark all 282 correct tops strong and zero wrong tops strong if it knew correctness; today it has 211 correct strong and 67 false strong.

For the *current* probe catalogs: the original focused set has 61 eligible, baseline 19, H6 21, six-probe/six-analysis/1,000 ms budget oracle 21, and unbounded oracle 21. The broadened set has 105 eligible ambiguous partial rows, baseline 29, H6 31, budget oracle 31, and unbounded oracle 31. H6 was post-hoc, so these are not out-of-sample deterministic success claims. The oracle gap is nevertheless zero on both measured catalogs. No oracle ceiling is claimed for the remaining 39 wrong-but-strong rows or for new read/write, caller, type-propagation or virtual-target primitives.

## 8. Accuracy impact

If every partial answer were forcibly reranked and exact answers left alone, label-only Jev's *offline* top1 would be 321/426 (75.4%) versus 282/426 (66.2%). The deterministic screen would be 381/426 (89.4%). These are not safe production accuracies. Exact stays 229/230 only because the proposed experiment never calls the API on exact queries. The 67 baseline false-strong rows cannot be safely relabeled from a model choice. Among 105 currently ambiguous partial queries, label-only Jev has 17 rescues and 6 regressions. Of 21 label-arm answers with model choice confidence at least 0.9, only 15 match the hidden fixture truth; confidence is not a calibrated correctness probability here. Maximum self-rated uniqueness is 0.51. Requiring both `unique>=0.9` and `confidence>=0.9` triggers no cases in any arm; safe top1 gain and safe strong-verdict gain are therefore **0 demonstrated**.

## 9. Latency / reliability impact

On 588 live ranking requests at concurrency three: API p50 **542 ms**, p95 **788 ms**, p99 **1,061 ms**; zero observed timeouts, malformed responses, 5xx or 429. Label-only p50/p95/p99 are 534/781/1,192 ms. The 14 compiler-role calls had p50/p95/p99 513/593/593 ms. The separate baseline partial binary analysis has p50 1,380 ms, p95 4,547 ms; summing separate runs is only an indicative overhead, not a paired end-to-end benchmark. A repeated 20-call sample reproduced 19 choices; one evidence-arm choice changed. No model determinism guarantee is inferred.

The 15 s timeout, malformed response, model mismatch, invalid candidate, missing probability, unavailable API and rate limit all map to deterministic fallback in the measurement adapter. Only the success path was observed for availability/rate-limit/timeout in this run; incident rates cannot be estimated from zero observed events. A retry was never required; retry policy remains unmeasured. Exact state+model+binary/evidence-version caching could avoid repeated calls but has no measured production hit rate. The current API state sends class/field/evidence descriptions to an external service, so user/device privacy and dependency availability would need an explicit product decision.

## 10. Failure modes

- **Hidden-label ambiguity:** `wait time`, `close button` and similar tails can legitimately point to several existing fields. The unique-name fixture target is independent of Hex but often absent from the user phrase.
- **Benchmark construction leakage:** the deterministic suffix rule and potentially Jev favor longer names because the partial set is generated from last-two-word tails.
- **False preference:** Jev changes 7, 12 or 16 correct rows to wrong depending on the information arm. Evidence summary is not a monotone safety improvement.
- **Unsupported semantic facts:** width, RTTI, vtable, receiver and extent are binary facts. No model output may mint them.
- **Catalog-relative oracle:** D2 covers 105 ambiguous partial rows, while 39 wrong-but-strong rows are intentionally excluded by the fail-closed scheduler predicate. Call-site and disassembly context remain unmeasured across the full wrong set. The zero gap is evidence against the measured probe catalog, not against every future deterministic primitive.
- **External behavior:** one of 20 repeated choices changed; timeout/rate-limit/unavailability risks remain unmeasured beyond fail-closed adapter logic.

## 11. Safety / fail-closed design

If a later independent study warrants integration, the smallest safe interface is an opt-in, bounded hypothesis result attached to an **already complete binary candidate lattice**. It must run only after cheap deterministic ranking on a separately validated ambiguous hard-case predicate. Limit candidates and request bytes, pin model and schema, bind cache identity to binary/evidence/query versions, and apply a fixed short timeout. A malformed or absent response returns the original candidate order and verdict. The hypothesis may explain or suggest an investigation, never set `confirmed`/`likely`, erase contradictory binary evidence, create a symbol, or weaken exact-query precedence. User-visible semantic field names must remain confidence-marked hypotheses with cited binary observations, not confirmed identities.

## 12. Production integration candidates

There is **no approved production integration candidate in this PR**. The highest-upside research point is a selective semantic hint for ambiguous natural-language/remembered-name queries; the present benchmark cannot distinguish it from a cheap generator-specific lexical rule. A second research point is semantic naming for unnamed fields after deterministic type/read/write/call-site fusion, but this audit has only five supported compiler-field labels and zero real-game stripped-field labels. #9469 moves proven member categories into the canonical C++ projection, reducing the amount Jev would need to infer; its remaining worker-side lifecycle and constructor IR-binding gaps are deterministic integration problems. Current probe scheduling, binary C++ fact recovery, parser/lifter/extent repair and candidate expansion on the 426 queries should remain deterministic.

## 13. GO / CONDITIONAL_GO / RESEARCH_ONLY / NO_GO matrix

| Classification | Uses | Measured reason |
| --- | --- | --- |
| GO | none | No safe, independent Jev-only accuracy gain. |
| CONDITIONAL_GO | none | No validated hard-case predicate with positive net safe gain and acceptable latency. |
| RESEARCH_ONLY | A, C, D2, F, G, H | Raw preferences or small fixture signals exist; oracle/labels/safety/latency evidence is insufficient. D2 is NO_GO for the measured catalog but remains open only for genuinely new deterministic primitives and a new holdout. |
| NO_GO | B on current corpus, D1 current catalog, E for proof obligations, structural OTHER | Zero recall ceiling, zero scheduler-oracle gap, or binary fact is the required authority. |

## 14. Recommended next experiment

Build an independently authored, lawful real-binary holdout with user-style natural phrases and explicit object/gameplay context, including unnamed fields and read/write/call-site chains. Freeze separate development and holdout query families, not only different binaries sharing SDK fields. First measure candidate admission and a deterministic semantic/lexical reranker. Then evaluate Jev on **only** baseline-wrong ambiguous cases plus correct controls, with the same candidate universe and a same-budget evidence-acquisition oracle. Record query intent labels, acceptable alternative answers, false strong, exact-query controls, p50/p95/p99 end-to-end latency, privacy exposure and repeated-query stability. Production reconsideration requires a positive **Jev-minus-best-safe-deterministic** gain on the holdout, zero new false strong and a narrow predicate with enough rescued cases to justify >500 ms per call.

## 15. Reproduction instructions

All temporary work must stay under `/mnt/workspace/.dev-state/agent-work/`; set `TMPDIR`, `TMP` and `TEMP` to its `scratch` directory. The three large binaries are licensed/existing fixture inputs and are **not** committed in this PR; materialize them from the verified fixture source described in #9464 at a persistent cache root. Check the three SHA-256 values in `manifest.json` before measuring. The report's rows and summaries can be reviewed without those binaries; a full fresh collection needs them and takes roughly 13 minutes on this host.

```sh
export TMPDIR=/mnt/workspace/.dev-state/agent-work/scratch
export TMP="$TMPDIR" TEMP="$TMPDIR"
export HEX_PINPOINT_FIXTURE_ROOT=/mnt/workspace/.dev-state/agent-work/cache/pinpoint-jev-probe-audit-20260923
AUDIT_EVIDENCE=/mnt/workspace/.dev-state/agent-work/evidence/jev-full-opportunity-audit
mkdir -p "$AUDIT_EVIDENCE/current-main" "$AUDIT_EVIDENCE/live-checkpoint"
node --max-old-space-size=8000 scripts/measure-pinpoint-confidence.mjs --out "$AUDIT_EVIDENCE/current-main"
node reports/investigations/jev-full-opportunity-audit/evaluate.mjs --mode live --input "$AUDIT_EVIDENCE/current-main/rows.jsonl" --checkpoint "$AUDIT_EVIDENCE/live-checkpoint" --arms label,class,evidence --concurrency 3
node reports/investigations/jev-full-opportunity-audit/evaluate.mjs --mode summarize --input "$AUDIT_EVIDENCE/current-main/rows.jsonl" --checkpoint "$AUDIT_EVIDENCE/live-checkpoint"
node reports/investigations/jev-full-opportunity-audit/deterministic-screen.mjs
node reports/investigations/jev-full-opportunity-audit/field-role-screen.mjs
node reports/investigations/jev-full-opportunity-audit/build-report.mjs "$AUDIT_EVIDENCE/live-checkpoint" "$AUDIT_EVIDENCE/repeat-checkpoint" "$AUDIT_EVIDENCE/current-main/measurement.json" "$AUDIT_EVIDENCE/broader-probes/scheduler-comparison.json"
node reports/investigations/jev-full-opportunity-audit/validate.mjs
```

The broader D2 result was reproduced from the open #9464 head `f035af71dd183c25d36af7d1eebe413ecfd4bb04`. In that checkout, apply [`broader-probe.patch`](./broader-probe.patch), set `HEX_JEV_BROADER_OUT` to a persistent evidence directory, copy the current-main `rows.jsonl` and `measurement.json` into its `baseline/` directory, and run `measure-pinpoint-jev-probes.mjs` followed by `compare-pinpoint-jev-schedulers.mjs`. The committed [`broader-scheduler-summary.json`](./broader-scheduler-summary.json) records the resulting source hashes and aggregate counters. The comparison uses no Jev API calls; it is a deterministic scheduler/oracle control for the Jev opportunity screen.

`OPENJEV_API_KEY` must be provided in the environment for the two live scripts; never print or commit it. The role fixture is produced by `buildCxxFixtures({outDir:<persistent cache path>})` from `tests/phase7/cxx/fixtures/build.mjs`; its O0 binary hash is in `manifest.json`. The first 10 partial cases were an exploratory live smoke test before the 588-call sweep; prompts and frozen deterministic grid were not changed after seeing those answers. Twenty separate repeated calls assess stability. Reproduction may observe a different model answer distribution; record a new manifest rather than silently replacing this one.
