# Jev advisory-versus-canonical closure (2026-09-25)

Scope: close requirement 5 of [`docs/HEX_COMPLETION_GOAL.md`](../../../docs/HEX_COMPLETION_GOAL.md)
("Pinpoint/Jev: ... evaluate on a new free-form, binary-disjoint holdout after the router freeze;
if safe, canonical, otherwise advisory; decide and finish").

Measured product: the candidate stack head
`f24fdca4040304c71d7e1ae74c301a6316f18781` ("build: sync userscript for Phase 8 repair checkpoint").
Frozen router: `js/pinpoint.js` (`rerankWithJev`), sha256
`62f3c7eb561218527db146b658f3394a1a6e12469b465b88b848e3f8cddb2173` — byte-identical to the
router frozen on 2026-09-24, so no router generation (G30+) was evaluated here.
Model/endpoint: `openjev` at `https://api.openjev.sh/v1/systemone`, node `v24.20.0`.

After these runs the working stack advanced to `3529a70230c9ccdbd9532817de32a5f9a08f98b2`
(cond integration + Phase 8 partial-source render history). The Jev surface is byte-identical between the
two heads — `js/pinpoint.js`, `js/pinpoint-jev-eligibility.js`, `jev-context/**`,
`scripts/run-jev-prospective-eval.mjs` and `scripts/verify-jev-binary-holdout.mjs` are unchanged — so the
measurements below stay exact-head evidence for `f24fdca40` and remain valid for that unchanged surface.

## Decision

**Advisory. Jev reranking stays optional and disabled by default (`rerankWithJev({ enabled: false })`).**
Canonical (default-on) reranking is *not* justified at this SHA, and no further router generation or
threshold patch is proposed.

The frozen canonical bar (from
[`reports/investigations/jev-final-decision-20260924/README.md`](../jev-final-decision-20260924/README.md))
is: `rescues > 0`, `regressions <= 1`, `regressions / rescues <= 0.1`, `zero new false strong`,
`fail-closed verified`. Two independent binary-disjoint free-form holdouts were evaluated at the exact
candidate SHA. One of them (Sparkle) still fails `regressions <= 1`, exactly reproducing its
2026-09-24 measurement, and the conservative pool over distinct cases fails it as well.

## Evidence at the exact candidate SHA

| run | holdout (binary) | cases | answerable / abstain | arm A top-1 | arm B top-1 | rescues | regressions | ratio | routed | frozen bar |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| xadmaster-run1 | XADMaster (new) | 72 | 60 / 12 | 4 (6.7%) | 43 (71.7%) | 40 | 1 (`XA40`) | 0.025 | 71 | met |
| xadmaster-run2 | XADMaster (new, repeat) | 72 | 60 / 12 | 4 (6.7%) | 43 (71.7%) | 39 | 0 | 0.0 | 71 | met |
| sparkle-rerun | Sparkle (canonical) | 62 | 50 / 12 | 6 (12.0%) | 40 (80.0%) | 36 | 2 (`SP08`,`SP33`) | 0.0556 | 60 | **not met** |
| pooled (distinct cases, worst-run-wins) | both | 134 | 110 / 24 | – | – | 76 | 3 | 0.0395 | – | **not met** |

False strong and unsafe confident are unchanged in every run (XADMaster `0/0` both arms; Sparkle
`0 -> 0` false strong, `1 -> 1` unsafe confident). Arm-B gains are large where the router fires:
+39 and +34 exact top-1 answers on the two holdouts.

Failure behaviour: 131 of 134 cases were routed to Jev; `httpErrors = 0`, `http400ChoiceLimitErrors = 0`
(no `>255` choice-limit rejection), `failedCallsObserved = 0` in all three runs, so the live
fail-closed path was *not* exercised. `failClosedObserved` is reported as `null` rather than as a pass.
Fail-closed behaviour (thrown client, network failure, timeout, malformed/null response, out-of-shortlist
or invented candidate, verdict never promoted to strong) is proven by injected adversarial tests in
`tests/pinpoint-jev-shortlist.test.mjs`, which pass 19/19 on this head.

## New genuinely disjoint holdout: XADMaster

- Binary: `XADMaster` (third-party Objective-C framework bundled in the official OpenEmu 2.4.1 release),
  sha256 `e02a74a58463dc26245540011dedf97628580dbdc59ce7c0415338ada00ddc38`, x86_64 slice of a universal
  x86_64+arm64 `MH_DYLIB`, archive sha256 `521ca1305c012d38f6f907f50399fefbf4e45a9bb8d9d4063157ffca78b217d4`
  (member `OpenEmu.app/Contents/Frameworks/XADMaster.framework/Versions/A/XADMaster`).
- Corpus: 72 cases (60 answerable, 12 abstain), hash-locked before any live Jev call,
  case sha256 `7d426b64daf5a098a3d4121569b4884ee1cb8eaf97ba251a47d920de7f59913f`.
- Ground truth: Objective-C class/ivar metadata parsed from the binary (231 classes, 157 with ivars,
  878 ivars). Every gold pair exists in that metadata; no duplicate golds; zero `(class, field)` overlap
  with the gold sets of the Sparkle, OpenEmu, or 54-case holdouts, and the binary is distinct from every
  previously evaluated holdout binary. This is the strongest disjointness available: the earlier audit
  found no additional Mach-O application with Objective-C metadata beyond the four already used.
- Shortlist retention at the exact head (`shortlist-retention.json`): gold in the 400-candidate lattice
  51/60 (85.0%); gold inside the `K<=255` shortlist 50/51 of lattice-present (98.0%);
  50/60 of all answerable (83.3%); max lattice-present gold rank 203.
  9 answerable queries (`XA14, XA16, XA17, XA18, XA37, XA38, XA39, XA42, XA54`) have **no** gold candidate
  in Hex's lattice, so no rerank of any kind can reach them; they stay in the primary denominator as
  misses for both arms.
- Sparkle retention re-verified at the same head: 49/50 in lattice, 49/49 shortlisted (100% of
  lattice-present), max rank 71 — unchanged from 2026-09-24.

## Why the regressions block "canonical"

- All three regressions are cases where Hex's **already-correct** top-1 was replaced by an incorrect Jev
  choice on a partial query Hex had marked ambiguous. They are exact-quality losses on those cases.
- Jev's own preference/confidence does not separate them from rescues. `XA40`
  ("Key bytes used to initialise the RC4 stream cipher") regressed in run 1 at
  preference `0.33` / confidence `0.32`, then was rescued in run 2 with the **gold** answer at
  preference `0.29` / confidence `0.27`. `SP08` regressed at `0.38`/`0.37`, `SP33` at `0.30`/`0.25`,
  while rescues range from `0.19` upward (median `~0.9`).
  Any "accept only if confidence > X" rule would therefore be an unprincipled bar that both
  fails to isolate the failures and is explicitly forbidden here ("do not treat the score as a
  probability"; "do not repair ranking defects with thresholds alone").
- The regression count is not run-stable: the identical holdout, router, binary and model produced
  1 and then 0 regressions in two consecutive runs. A single passing run is therefore not evidence
  that the bar is met, and the conservative pool is the honest aggregate.
- The demotion is caused by the router's unconditional acceptance of Jev's preference among existing
  candidates. The only in-scope remedies are acceptance/score thresholds (forbidden) or a change to the
  preference semantics (a new router generation, which the 2026-09-24 settlement ended). A genuine fix
  would have to change Hex's own candidate ordering or verdict strength on those queries, which is
  outside Jev integration scope.

## Inspected prior evidence (not re-used as new accuracy)

- 426-field denominator, recomputed from the committed lattice rows
  (`reports/investigations/jev-full-opportunity-audit/rows.jsonl`, measurement base `09dfcb283`):
  N=426, truth candidate present 426/426 (100%), max truth rank **15** (so 426/426 inside `K<=64` and
  therefore inside the `K<=255` shortlist), baseline top-1 282/426 (66.2%) — exact 229/230 (99.6%),
  partial 53/196 (27.0%); correct-and-strong 211, correct-and-weak 71, **wrong-and-strong (false strong)
  67**, wrong-and-weak 77. These match the numbers quoted by the 2026-09-24 decision. This lattice was
  **not** re-collected at `f24fdca40` (it needs fresh multi-minute analysis of the three large game
  binaries); it is quoted as historical context only.
- Free-form `#9519` holdout (`reports/investigations/jev-independent-holdout-20260923`): 48 cases
  (36 answerable), same three historical binaries, so not binary-disjoint. Its `D_Jev_force_all` arm made
  42 HTTP attempts with 42 API errors and 0 rescue / 0 regression versus baseline, and its `C_G28_routed`
  router is a research candidate that is not deployed. Per the goal, neither the G28 post-hoc arm nor the
  `HTTP 400` requests are counted as accuracy evidence. Only the artifacts above are used.

## Limits

- Gold labels are semantic: the ivar enumeration is machine-derived, but the free-form queries and their
  intended target were authored by hand for this holdout (as in the Sparkle holdout). No query contains
  an exact class or field identifier.
- 15% of the new holdout's answerable queries are unreachable by any reranker on this head because Hex's
  lattice does not contain the gold field; that is a Hex retrieval property, not a router property, and
  it is reported rather than dropped.
- The model is a live external service. Two identical runs already differ (1 vs 0 regressions), so all
  per-run numbers are single samples; the pooled view is worst-run-wins.
- Live fail-closed behaviour was not triggered (no API failures occurred); only the injected adversarial
  tests cover it.
- The 426-field lattice and the free-form `#9519` corpus were not re-measured at `f24fdca40`.

## Artifacts

- `xadmaster/` — new holdout: cases, manifest, shortlist retention, raw per-case results, summary.
- `xadmaster-repeat/` — repeat run of the same locked corpus (stability sample).
- `sparkle-rerun/` — canonical Sparkle corpus re-run at `f24fdca40` (cases/manifest byte-identical to
  2026-09-24, case sha256 `cfc02268...`), with retention re-verified.
- `decision-metrics.json` — machine-readable per-run and pooled metrics with the frozen criteria
  (`node scripts/summarize-jev-holdout-decisions.mjs --json <path>`).
- `decision.json` — the closure record.
