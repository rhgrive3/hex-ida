# Jev / Pinpoint real-game final decision

## Executive Summary

**Initial frozen-design decision: NO_GO for automatic Jev routing on real-game C++ member queries. Jev remains disabled by default.**

**Work continues:** following the user's request, query-directed recovery and machine-use context are being implemented and will be judged on a separate untouched holdout. The tables below preserve the completed original 30-function design; they are not yet the expanded-recovery final result. C++ publication is useful and mergeable; it does not recover source member names. The preselected context representation D produced **0 rescues, 0 regressions, 0/49 verified top-1 answers**. The current, minimum-name and structured representations each rescued **one OpenTTD case**, giving 1/49. No OpenMW improvement was demonstrated. We did not select a different primary arm after seeing these results.

高校生向けに言うと、Hexがゲーム内の候補を探し、Jevがその中から人間の質問に近い候補を選びます。今回は正解が候補に入った質問が49件中2件しかありませんでした。しかも候補は全部匿名で、役割の説明も十分ではありません。Jevを通常ONにする価値は確認できず、まずHexの候補回収と意味の証拠を改善する必要があります。

This is a completed evaluation of the unchanged 70-case corpus under the **pre-frozen, blind 30-function Fast warmup per binary**. It is not an exhaustive recovery experiment over every game function, a claim that Hex can never recover the remaining members, or a well-powered test of OpenMW semantics. The verified OpenMW denominator is only one. These limits are reasons to withhold automatic promotion, not to report success from synthetic candidates.

## What changed

Integration branch `integration/jev-realgame-final` starts from main `d2177389cd1770edb3548251a080bf23e829a8a0`, incorporates publication branch A (`bb5f415cc9498aff47fc41f0867f201a515d53b2`, PR #9662) and holdout branch B (`b696f8fcc`), and preserves main's changes. Product publication sources are byte-identical to reviewed A. No new Jev prompt, routing threshold, default API dependency or production analysis pass was introduced.

The added evaluation boundary collects live canonical candidates from release binaries, separates exact-build DWARF gold from Jev descriptions, scores by structural identity, records a recovery funnel, and retains every actual request description, response, attempt and repeated selection. The historical name-only C++ evaluator now requires structural gold. Historical query files and results remain historical; this directory is the authoritative final report.

Jev evaluation and fail-closed tests now participate in the canonical test chain. This closes a process gap where dedicated Jev tests could pass separately while being omitted from `npm run check`. Exact integration ownership routes list the reviewed cross-owner files explicitly, without widening the Phase 7 ownership manifest.

## C++ candidate publication

| Binary | Candidates before / after | Classes | Named | Unnamed | Key collisions |
|---|---:|---:|---:|---:|---:|
| OpenTTD 13.4-1build3 ARM64 | 0 / 47 | 19 | 0 | 47 | 0 |
| OpenMW 0.48.0-1ubuntu5 ARM64 | 0 / 19 | 10 | 0 | 19 | 0 |

Publication consumes existing canonical receiver/member evidence. Owner, snapshot, access proof, offset and width must agree; ambiguous ownership, forged canonical-looking objects, indexed/mixed-width accesses and malformed evidence fail closed. Candidate keys include owner and structural evidence and are disjoint from ObjC keys. Per-function observations deduplicate, provenance is bounded to 64 contexts, and cache views bind binary/slice/backend/symbol identity plus index revision. Publishing or reading this view starts no new recovery pass. Anonymous C++ members cannot independently manufacture a strong name verdict.

The 0→nonzero change is the connection of already recovered canonical C++ evidence to the shared candidate enumeration and recall lane. It is not recovery of `cur_speed`, `health` or other source names. See [independent publication review](publication-review.md), including residual count-state growth, future named-producer risk, cache checks and adversarial collision probes. ObjC controls use actual historical runtime-derived lattices; production ObjC enumeration remains unchanged.

## Structural gold mapping and oracle audit

The frozen corpus is byte-identical: SHA-256 `05def989cdf8df4728bbdee5201f069e37a4e2a0c0d8bd6a91055cd10895df9a`, 70 queries, originally 55 answerable and 15 controls. Exact-build auditing yields **49 verified, 6 unverified, 15 controls**. Every original query, label and alternative remains in the audit; unverified cases still execute but do not inflate the accuracy denominator.

Both games use exact Ubuntu debug packages whose GNU build-ID matches the frozen release binary. RTTI establishes a class, not a member's name or byte layout. The previous OpenTTD DWARF file has a different build-ID and is rejected. This matters: exact 13.4 `Vehicle.cur_speed` is offset **274**, size **2**, whereas the historical annotation said 306. Offset 306 belongs to another member and is never accepted as speed.

The scoring identity is release SHA-256 + verified class identity + member byte offset + size, with compatible proven type information when supplied. Names serve report readers only. A correct anonymous member matches regardless of its synthetic name. Inherited members match only when exact compiler metadata proves the same declaring owner, owner-relative offset, size, type and base displacement. For example, `RoadVehicle.member_0x70` can score as `Vehicle.tile` because DWARF proves the base chain and physical offset 112; production ownership is not rewritten.

Excluded cases: RG33 `CompanyProperties.max_loan` and RG44 `Window.scale` are absent from the exact OpenTTD layout. OpenMW RG51–RG53 `ActorStats.health/fatigue/magicka` lack a proven frozen identity; the `mSpells` alternative is a spell container, not proof of a magical-energy pool. RG54 unqualified `CreatureStats.mLevel` cannot be silently assigned to `MWMechanics::CreatureStats` when another `ESM::CreatureStats` exists. RG55 `MWWorld::Ptr.mRef` is verified at offset 0, size 8 through compiler base-layout metadata. We do not infer replacement gold or rewrite queries to suit the build.

See [structural gold](structural-gold.json), [oracle authority](oracle-authority.json), [independent oracle audit](oracle-audit.md) and the retained [OpenTTD](layout-openttd.json) / [OpenMW](layout-openmw.json) layouts. The authoritative GDB `Type.fields` extractor is retained as `scripts/jev-realgame-gdb-layout.py`; the text `ptype /o` extractor provides an independent cross-check. Debug metadata never enters the production collector or candidate description.

## Pre-frozen representations and policy

[policy-freeze.json](policy-freeze.json) was frozen before the full live evaluation; SHA-256 `a813ad92963479b1fe6c0914b8d2aa398a1bef9a628b4ffbb65945b3eacbc45b`. Primary arm D, repeat count 3, routing, timeout/retry policy, deterministic comparator, scoring authority and decision criteria were fixed in advance. No prompt tuning used these 70 outcomes. The first repeat is the primary answer; repetition measures instability and is never majority voting.

| Arm | Description |
|---|---|
| A | Actual Hex baseline |
| DET | Best previously frozen deterministic lexical comparator; exact=0, extra=.5, classMatch=0, suffix=2 |
| current | Existing prospective Jev fieldName/name/key description and unchanged instruction |
| B | `ClassName.member_0xOFFSET` |
| C | Class, member offset, recovered category and size |
| D (primary) | C plus existing read/write counts and up to eight canonical access-function contexts |

Function names come only from symbols available in the release binary; contexts have proven receiver/access provenance. We did not infer statements such as "written during acceleration" from a DWARF member label. Offsets, widths and counts alone do not identify speed or money. A method shared by several accesses also does not necessarily distinguish their roles.

## Candidate recall funnel

| Stage | OpenTTD | OpenMW | Total |
|---|---:|---:|---:|
| Verified answerable | 48 | 1 | 49 |
| Matching structural member recovered | 2 | 0 | 2 (4.08%) |
| Gold in actual candidate lattice | 2 | 0 | 2 |
| Gold in Jev shortlist ≤255 | 2 | 0 | 2 |
| Hex top-1 | 0 | 0 | 0 |
| Current Jev top-1 | 1 | 0 | 1 |
| Primary D top-1 | 0 | 0 | 0 |
| Unreachable because not recovered | 46 | 1 | 47 |
| Recovered but not published | 0 | 0 | 0 |
| Published but outside shortlist | 0 | 0 | 0 |
| Reranking failures, current / D | 1 / 2 | 0 / 0 | 1 / 2 |

Lattice-to-shortlist retention is 2/2 (100%). All 47/19 actual candidates fit in the shortlist; increasing its 255 limit would not solve this result. The two reachable cases are RG07 `Vehicle.tile` and RG17 `Vehicle.direction`, both through proven `RoadVehicle` inheritance. The other 47 misses are **candidate recovery failures, not Jev reranking failures**. These recovery percentages describe the frozen warm state, not the whole binary's theoretical recoverability.

## Accuracy and per-game results

| Arm | Top1 / 49 | Rescue | Regression | Net | Accuracy when recovered |
|---|---:|---:|---:|---:|---:|
| Hex A | 0 | 0 | 0 | 0 | 0/2 |
| DET | 0 | 0 | 0 | 0 | 0/2 |
| Current Jev | 1 (2.04%) | 1 | 0 | +1 | 1/2 |
| B minimum | 1 (2.04%) | 1 | 0 | +1 | 1/2 |
| C structured | 1 (2.04%) | 1 | 0 | +1 | 1/2 |
| D binary context (primary) | 0 | 0 | 0 | 0 | 0/2 |

**OpenTTD:** A/DET/D 0/48; current/B/C 1/48. All three rescue RG07 on all three repeats. Current/B RG17 varies across wrong offsets; C/D consistently select the wrong `RoadVehicle` member. D also loses the RG07 rescue, choosing `DiagonalTileIterator.member_0xc` on all repeats. Release function context is available but does not reliably distinguish the desired member; more text does not guarantee better ranking.

**OpenMW:** every arm is 0/1, with 0 rescues and 0 regressions. RG55's verified `mRef` is not recovered in this warm state. Four originally answerable cases are unverified and one further query is a control. This is insufficient evidence to claim independent OpenMW gain or to estimate Jev's reachable-member accuracy there.

The C++ baseline-correct destruction rate is **undefined**, because there are zero correct baseline answers in the verified denominator. Reporting "0% destruction" would conceal the missing denominator. The regression controls below supply a meaningful baseline-correct check. See [summary.json](summary.json) and [per-case evidence](raw-results.jsonl).

## SP08 / SP33 / XA40 controls and failure analysis

These controls retain the original queries and real ObjC candidate lattices, with binary/corpus/snapshot hashes in [regression-controls.json](regression-controls.json). Five live repetitions per arm were run independently of the C++ corpus, without prompt tuning or query exceptions.

| Control | Hex | Current | B | C | D |
|---|---:|---:|---:|---:|---:|
| SP08 `SPUBasicUpdateDriver._host` | correct | 0/5 | 5/5 | 5/5 | 5/5 |
| SP33 `SPUInstallationInputData._signatures` | correct | 5/5 | 2/5 | 0/5 | 0/5 |
| XA40 `XADRC4Handle.key` | correct | 0/5 | 5/5 | 5/5 | 5/5 |

All baseline-correct destruction cases are retained in [control-results.json](control-results.json). Current loses SP08 and XA40 through missing class/object context and noun/action confusion. Class-qualified B/C/D resolve these two. SP33 remains a **duplicate-field / class lexical trap**: `SUSignatures` attracts selection despite the query targeting the installation input object's signatures. B is unstable; C/D are consistently wrong. Primary D destroys 1/3 baseline-correct controls (33.3%); current destroys 2/3. A five-call majority is not a fix.

For the 70 C++ queries, 47 verified misses are recovery failures. The two reachable misses expose insufficient member-level semantics and distracting shared method/class context. Unverified gold is a separate authority failure, not an accuracy miss. Repeated selection changes in 14/70 D cases (20%) demonstrate stochastic instability, although no C++ baseline-correct answer exists to assess destructive instability. Current has 16 unstable cases; B/C each 17. The raw record contains the keys and structural funnel for every case.

No magic class/offset whitelist, tuned confidence threshold, special query exception, new source labels or retrospective prompt was added. Any future representation/routing/prompt change requires a different untouched holdout; these results remain the final judge for this frozen design.

## Latency and reliability

Measurements are local client wall time for the live remote API after the fixed analysis warmup. No-Jev timings measure cached interactive ranking, not opening and decompiling a whole game. Warmup analysis timings are retained separately in the production snapshots.

| Path | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|
| Hex, no Jev | 0.55 | 2.84 | 9.11 |
| Current Jev added | 616.65 | 720.85 | 802.53 |
| B added | 452.77 | 690.34 | 719.71 |
| C added | 488.72 | 720.34 | 1067.42 |
| D added | 638.38 | 728.04 | 816.50 |
| Hex + D total | 639.10 | 728.68 | 816.97 |

70×4×3 = **840 live calls**, 840 attempts, **0 API errors, 0 timeouts, 0 retries**. Controls add 60 calls; their pooled added latency is p50 636.69, p95 882.57, p99 1143.42 ms. Zero observed errors is not a guarantee of remote availability. Timeout/error/malformed/invented/out-of-shortlist responses were exercised by injected failures through the actual client and router, preserving Hex's result.

## Safety, abstention and external boundary

Jev can select an existing shortlist member only. It cannot create a field, owner, offset, type, proof or strong verdict. Exact and deterministic strong paths skip the service. Disabled mode and missing API leave Hex fully functional; runtime failures fall back to the original Hex result. Publication and Jev both retain their existing fail-closed boundaries.

False strong and unsafe strong/confident verdict counts are zero. All 15 abstain/control queries nevertheless receive forced **weak preferences** in each arm: this is not semantic abstention and is not proof of a correct answer. Jev's confidence/uniqueness does not upgrade the binary verdict. The report distinguishes weak forced ranking from a claim that a target exists.

The existing optional client sends the user's query plus candidate descriptions to `https://api.openjev.sh/v1/systemone`. In this experiment those descriptions contain release-derived class identity, anonymous offsets, recovered categories, widths and bounded method/access context depending on arm. Raw game bytes, debug files and oracle gold labels are not sent. Queries and symbol names may still be sensitive; external API use remains explicit opt-in, interactive only, and never one call per bulk-analysis member. No new privacy/default exposure is introduced by this PR. Retained reports contain evaluation queries and release symbols, never API credentials.

## Integrity, reproducibility and validation

The live release-only production snapshots are retained as [OpenTTD](production-snapshots/openttd.json) and [OpenMW](production-snapshots/openmw.json). Collection used exact pushed product SHA `a15e196c0d5176870c22c5995b3cf1e1d399adc9` on [Actions run 36689172349](https://github.com/rhgrive3/actions/actions/runs/36689172349), with 47/19 anonymous candidates, zero key collisions and exact binary/case/policy/source bindings. The initial failed collector run is excluded; BigInt serialization was fixed and regression-tested before accepted collection.

Independent offline verification regenerates every one of the **840 actual request bodies and criteria from binary-only candidate snapshots**, recomputes each structural funnel and repeated top-1, verifies selection containment and recomputes all aggregate/per-game metrics. [evaluation-integrity.json](evaluation-integrity.json) records 70 cases, 49 verified, 840 calls and valid replay. Automated mutation tests reject query/hash drift, binary/policy binding drift, altered gold, oracle descriptions, invented selections, changed funnels and changed aggregates. Frozen alternatives and verified inheritance remain scoring-only.

```sh
export TMPDIR=/mnt/workspace/.dev-state/agent-work/scratch
export TMP=$TMPDIR TEMP=$TMPDIR
node scripts/verify-jev-realgame-final.mjs \
  reports/investigations/jev-realgame-final/production-snapshots \
  reports/investigations/jev-realgame-final
node --test tests/jev-realgame-final.test.mjs tests/jev-realgame-holdout.test.mjs
```

To reproduce oracle extraction, provide exact debug packages from `oracle-authority.json`, verify release/debug GNU build-ID and hashes, and use GDB with `HEX_ORACLE_CLASSES` pointing to a JSON list of audited classes, `HEX_ORACLE_OUTPUT` to a verified persistent output path, and `source scripts/jev-realgame-gdb-layout.py`. The class sets are in the retained layouts. The audit rejects a debug file from a different build. The script is evaluation-only and must never be loaded by product analysis. Source revision/build metadata and original rejected annotations remain visible in structural gold.

Final merge acceptance requires latest-main reconciliation, a regenerated userscript with zero drift, the focused publication/Jev/ownership contracts, relevant subsystem checks, independent verification and the **unchanged canonical gate** at the final pushed commit:

```sh
node scripts/run-quiet-command.mjs --label check -- npm run check
```

These heavy checks run on `rhgrive3/actions` with exact SHA and bounded fanout. Final real-game re-collection must preserve the candidate/request identities of this frozen evidence; report/doc/test changes do not license an unrecorded product or scoring change. The integration PR's validation record supplies final run IDs, conclusions and validated artifacts. A queued, stale or failed run is not accepted as passing evidence.

## Final production policy and remaining blockers

**NO_GO** applies to automatic game-member reranking for this design. It does not remove the existing explicit optional advisor or deny the one observed rescue in three other arms. No `DEFAULT_ON` or `SELECTIVE_DEFAULT_ON` scope was justified; no production default promotion was implemented.

Concrete blockers are: (1) 47/49 verified targets absent from the fixed candidate state; (2) anonymous member roles insufficiently distinguished even for the two recovered targets; (3) SP33 destroys a correct deterministic answer; (4) OpenMW offers only one verified answerable case and no reachable target; (5) 14/70 unstable primary selections and roughly 638 ms median external latency without demonstrated primary net gain. The pre-frozen decision order rejects no-gain designs before considering latency or permissive regression counts.

The user-visible improvement shipped here is **real C++ structural candidates** in Pinpoint: 47 OpenTTD and 19 OpenMW anonymous members with class, offset, width and canonical evidence, plus truthful evaluation and preserved deterministic/fail-closed behavior. The normal user's semantic top-1 experience is not claimed to improve by enabling Jev. Better recovery coverage and independently available member-role evidence are the next prerequisites; they require new evaluation rather than tuning this holdout until it passes.
