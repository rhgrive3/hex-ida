# OpenJev Boundary Referee — Measurement Report

Consolidated record of everything measured for this feature: what was built, what
was falsified, what the numbers are, and what the numbers do **not** say. Written
so the decision can be made from this document alone.

- Branch: `codex/openjev-boundary-referee`
- Production state: **off**. No caller is wired, no setting enables it, the
  referee has no authority over any score, proof, ranking, or verdict.
- Everything below is either a live-service probe, a locally built source-grounded
  fixture, or a measurement on real distribution binaries. Provenance is stated
  per section so nothing has to be taken on trust.

---

## 1. Verdict (short)

1. The mechanism **works**: live OpenJev selects the labelled truth, the bounded
   probe re-confirms it with binary evidence, and every failure class falls back
   to the existing `D1..D4` result unchanged.
2. The mechanism **cannot change an answer in the situation it was designed for**.
   After a successful probe the verified evidence is binary/constant, and the only
   graded signal left is update-site breadth. A challenger from `D5..D8` therefore
   ties `D4` on proof and then loses on breadth. A *perfect* (oracle) referee does
   not move the top-1 either — measured, not inferred.
3. The activation premise **is true but is the wrong premise**. On real binaries,
   33.2% of remembered-name queries put the correct field outside the verified
   top-4 — but **83% of those misses never surface the field as a candidate at
   all**, which a referee choosing among existing candidates cannot reach by
   construction.
4. Only **2.0%** of real queries match the referee's activation conditions, and
   all four instances are free-form (`free`) queries, which the goal gates rejected
   twice over.
5. **Net: zero measurable real-data impact.** Production stays off.

The one genuinely actionable finding is upstream of this feature: the dominant
failure is **recall** in shape discovery, and it is deterministic work no prompt
tuning can reach.

---

## 2. What was built

| path | role |
|---|---|
| `js/semantic-boundary-referee.js` | contracts only: fact allow-list, ambiguity/admission policies, response validation, eligibility. No fetch, no evidence, no verdict dependency |
| `js/ai/provider/worker-semantic-rank.js` | fixed-spec worker provider; holds the upstream key server-side |
| `js/semantic-boundary-client.js` | thin browser-side injection adapter |
| `js/pinpoint-legacy.js` | D4 boundary evaluation, one bounded probe (one candidate, up to `VERIFY_FUNCTIONS = 3` distinct windows), full fallback to `D1..D4` |
| `tests/semantic-boundary-{referee,worker,holdout-eval,openmw-holdout}.mjs` | contracts, worker, synthetic holdout, source-grounded holdout |
| `tests/fixtures/openmw-boundary-holdout.manifest.json` | labelled cases + frozen policies + the live upstream contract |

Design invariants that were never violated:

- model probabilities are **never** fused into a Hex result;
- the model sees only an explicit fact allow-list (no address, offset, rank,
  score, role, symbol, assembly, pseudocode);
- candidate IDs are opaque (`c0..c7`) and the candidate→offset mapping stays local;
- the referee may never spend a probe on `D1..D4`;
- background auto-analysis makes zero calls; only the interactive single-goal path
  can ask;
- any failure → the existing deterministic result, byte-for-byte.

### 2.1 Upstream contract correction (the feature was dead on arrival)

The first implementation pinned `https://api.codiv.ai/v1/systemone` and model
`openjev-0.1`. Probed directly against the live service:

| host | model | result |
|---|---|---|
| `api.openjev.sh` | `openjev` | **200** |
| `api.openjev.sh` | `openjev-0.1` | 422 |
| `api.codiv.ai` | either | 401 |

`GET https://api.openjev.sh/v1/models` offers exactly one model: `openjev`.

Because every error falls back open, the wrong pinned values produced a *working
no-op*: the feature looked healthy while making zero successful calls. Corrected
contract, verified live:

- endpoint `https://api.openjev.sh/v1/systemone`, model `openjev`
- method `choice`: criteria keyed by candidate id + `none`
- method `noul`: criteria **must** be `true`/`false` (`yes`/`no` → HTTP 400) and the
  response is a scalar `noul` = **P(true)** — confirmed by asking about a
  blue-vs-green object (0.91 / 0.06)
- measured upstream latency: choice p50 ≈ 451–482 ms, p95 ≈ 581–630 ms;
  noul p50 ≈ 459–504 ms, p95 ≈ 761 ms

---

## 3. Why a referee cannot move the top-1 (structural)

Measured fusion item breakdown after a *successful* probe of the labelled truth,
with a forced oracle challenger (source-grounded fixture, `js/evidence.js` LR
table + the `js/pinpoint-legacy.js` producer):

| candidate | loc-drain-verified | loc-clamp-verified | loc-shared | logOdds | p |
|---|---|---|---|---|---|
| rank 1 (leader) | 3.4012 (n=3) | 1.7918 (n=3) | **1.1632 (n=3)** | 4.0080 | 0.982155 |
| labelled truth | 3.4012 (n=3) | 1.7918 (n=3) | **0.7754 (n=2)** | 3.6203 | 0.973924 |

- `loc-drain-verified` (lr 30) and `loc-clamp-verified` (lr 6) carry **constant**
  likelihood ratios, and the producer's strength `min(1, drains/2)` **saturates at
  two confirmed changes**. A verified drain is therefore a *binary fact*: every
  verified candidate gets exactly the same contribution.
- The only graded quantity left after verification is `loc-shared` — **how many
  functions touch the field** (update-site breadth).
- Consequence: a challenger entering verification can only win if it is *more*
  widely used than `D4`. That is a property of the code, not of the probe, and it
  is independent of which candidate the referee names.
- Measured upper bound: with the oracle naming the truth and the probe confirming
  it, `boundaryRescue = 0` and the final top-1 was unchanged.

Design tension worth recording: the design forbids the referee from influencing
confidence (correctly, for safety). Combined with the above, that means the
referee's output is discarded by construction whenever the truth is verified.
The feature only has room to act if two candidates are *exactly* tied on verified
evidence — i.e. if the referee is given a bounded tie-break authority, which is a
different design and a different safety story.

---

## 4. Source-grounded fixture (OpenMW, arm64)

Upstream pinned at `ce8a52117c746331251c0ecc353af5a4e735daa2` (GPL-3.0-only, so the
compiled artifact is deliberately **not** checked in). Built locally with
clang 14 + `ld64.lld`, `-O1`, `-target arm64-apple-macos11`, entry `__start`.

Object layout, from the pinned `apps/openmw/mwmechanics/stat.hpp` and confirmed by
the candidate set the scanner finds. `DynamicStat<int>` = `Stat<int> mStatic`
(`mBase`, `mModifier`) + `int mCurrent` (12 bytes), so `mCurrent` sits 8 bytes in:

| offset | field | offset | field |
|---:|---|---:|---|
| 24 | `ActorStats.health.current` | 60 | `ActorStats.shield.current` |
| 36 | `ActorStats.magicka.current` | 72 | `ActorStats.breath.current` *(no update site → not a candidate)* |
| 48 | `ActorStats.fatigue.current` | 84 | `ActorStats.poison.current` |

"Offset" is a byte offset from the object base (what the disassembly shows as a
base-register displacement), not an index and not a file position. The labelled
truth is not hand-waved: the fixture calls `__builtin_offsetof(ActorStats, health)
+ sizeof(Stat<int>)`, so the compiler states the answer (24).

### 4.1 The first fixture was measuring itself, not the model

The first fixture gave the true pool the **fewest** update functions. Counting the
real update sites per pool in the pinned upstream by one grep rule over `apps/` and
`components/`:

| pool | upstream update functions |
|---|---:|
| health | **21** |
| fatigue | 18 |
| magicka | 14 |

The fixture had health 3 (fewest) and fatigue 5 (most) — **the one surviving
discriminator was inverted**. Any conclusion drawn from it was a conclusion about
the fixture.

### 4.2 Rebuild, breadth-faithful, and the result

Rules: every pool gets all of its upstream sites; the two pools upstream does not
have in this form (shield, poison) take the median of the three real counts (18);
every pool keeps an identical 2:1 decrement/increment mix; 86 → 89 functions;
arm64 Mach-O, 28 736 bytes,
sha256 `f86fd4f947a11e90da9c7703918bf27b08b3b39ed749c8a22b02cf3d152f66de`.

Offline harness, `labelsConsistent: true`, `promotionEligible: false`:

| case | labelled truth | deterministic rank | baseline top-1 | truth rescue |
|---|---|---:|---|---:|
| `hp` | offset 24 | **1** | **offset 24 = truth** | already correct |
| `stamina` | offset 48 | 2 | offset 24 | 0 |

With upstream-faithful breadth the truth is **rank 1** — the deterministic model
already answers it. `stamina`'s truth is rank 2, inside the ordinary verified set.
Neither case puts a labelled truth in the boundary set (rank 4+) the referee can
reach, so the activation scenario **does not reproduce from this source**.

Also measured on this fixture: all five candidates are the same
`DynamicStat<int>::mCurrent` shape, shape scores saturate (0.25 each), the verified
candidates tie at p = 0.982155, and the D4/D5 gap is 0. The ambiguity gate
**fires on a case whose top-1 is already correct** — `maxD4D5Gap` is not a
risk signal on saturated scores.

### 4.3 Live OpenJev on the inverted fixture (historical)

Both methods selected the labelled truth (choice 6/6 at p = 0.99; parallel noul
5/5 at p = 0.88–0.91) once the wording was made goal-appropriate. The gated probe
admitted and re-confirmed. **The final top-1 still did not move** — same structural
reason as §3. This is the result that first showed the ceiling.

---

## 5. Real-binary measurement (the decisive one)

The design document makes promotion conditional on this:

> First establish that real failures exist where truth is D5–D8 and the current
> D1–D4 verification boundary misses it. **If that rescue opportunity is not
> measurable, do not force production integration.**

That precondition had only ever been tested against fixtures this branch built.
It is measured here on three real distribution binaries.

- Binaries: `battlecats`, `TsumTsum`, `YWP` via `npm run fixtures:large`
  (= `tools/fetch-large-fixtures.mjs`, public GitHub raw, no secret required).
  Fetched size and Git blob sha1 verified against `tests/large-fixtures.json`:

  | fixture | bytes | sha256 (matches `tests/fixtures/real-binaries.json`) |
  |---|---:|---|
  | battlecats | 28 153 072 | `567234909b2a33d62548257c4148290d9215d7edf414fa17c6b06fcf8c7cdf13` |
  | TsumTsum | 45 994 784 | `4f877bb1d4e1503b439ce07c601a1fddd6a38a6f32395bfd3071b056f77839b3` |
  | YWP | 63 455 952 | `cd1c72a30ba29f423a670f9e534c8865689ca09890769a95822869c162d240a6` |

- Labels: fields whose name is **unique in the image**, so the correct answer is
  well defined without any manual RE. Same rule the repository's own accuracy
  harness uses.
- Instrument: `pinpointField` **already returns the ranked candidate list**, so the
  truth's rank is read directly. No new instrumentation was needed for this — the
  `rankedShapeScores` instrumentation added earlier in the branch is not required
  for this measurement.

### 5.1 Two regimes

| mode | queries | top-1 correct | outside verified top-4 |
|---|---:|---:|---:|
| exact name | 230 | **229 (99.6%)** | **0** |
| remembered partial name | **196** | 53 (27.0%) | **65 (33.2%)** |

Per binary, partial-name mode:

| binary | queries | decided | not found | top-1 correct | outside top-4 | 5–8 candidates | gate match |
|---|---:|---:|---:|---:|---:|---:|---:|
| battlecats | 86 | 64 | 22 | 29 | 26 | 20 | 1 |
| TsumTsum | 60 | 43 | 17 | 16 | 22 | 17 | 1 |
| YWP | 50 | 35 | 15 | 8 | 17 | 14 | 2 |
| **total** | **196** | **142** | **54** | **53** | **65** | **51** | **4** |

Rank histograms (partial mode, rank of the correct field):

- battlecats: `1:29 2:22 3:7 4:2 5:1 7:1 11:1 13+:1 not-found:22`
- TsumTsum: `1:16 2:17 3:4 4:1 5:3 8:1 13+:1 not-found:17`
- YWP: `1:8 2:16 3:4 4:5 5:2 not-found:15`

### 5.2 The decomposition that decides the design

| | count | share of queries | share of misses | reachable by a referee? |
|---|---:|---:|---:|---|
| correct field is **not a candidate at all** | 54 | **27.6%** | **83%** | **no, by construction** |
| candidate exists but ranks below `D4` | 11 | 5.6% | 17% | partly |
| — of which matches the referee's activation gate | **4** | **2.0%** | 6% | yes |

A referee picks *among existing candidates*. The 83% head of the failure
distribution is therefore outside its reach entirely. This is a **recall** defect
in shape discovery, not a boundary-ranking defect.

### 5.3 The four reachable cases (all free-form)

```
battlecats: action button → FBNativeAdBaseView._callToActionButton        rank 7/7   gap 0.0000
TsumTsum  : new count     → LCLGCategoryNewCount.mCategoryNewCount        rank 5/5   gap 0.0008
YWP       : custom close  → GADCloseButton._enabledOnCustomClose          rank 5/12  gap 0.0000
YWP       : load finish   → PAGExpressRewardFullScreenVM._normalPlayableLoadFinish rank 5/8 gap 0.0000
```

Three of the four also satisfy the 5–8 candidate-count gate (the 12-candidate case
does not). All four are `free`, the free-form goal, which the design rejected
twice: first `supported-goal` (not in the shape-goal set), then
`uncalibrated-goal` (no calibrated wording). So under the design as written the
referee emits **zero** requests on real data.

### 5.4 `free` is the mainstream path

`parseGoal` maps anything that does not match a preset to
`{ id: 'free', free: true, text: raw, expects: {} }` — free-form input, with the
user's own words in `text`. Goal distribution over the 196 sampled partial-name
queries:

```
free: 192    login: 3    network: 1
```

The referee was designed around preset goals (`hp`, `stamina`) and is ineligible
for 98% of the query shapes that actually occur. Enabling `free` was done in this
branch (`ce73f5309`): free-form needs no authored guidance because the request's
goal label *is* the user's words, so the calibrated-guidance rule (which exists to
stop an unvalidated prompt being added silently) still applies to every preset
goal. The packet stays `{ id, label }`.

---

## 6. Hypotheses tested and falsified

Recorded so nobody repeats them.

| hypothesis | result |
|---|---|
| "The upstream contract is fine; the 401 is a key problem" | **false** — the key is valid; host and model were wrong |
| "A referee rescues a stranded truth (fixture evidence)" | **false** — the fixture had the only surviving discriminator inverted |
| "Breadth-faithful fixture will still strand the truth" | **false** — truth is rank 1; the model already answers it |
| "Hex rarely misses the verified window on real binaries" | **false** — 33.2% of remembered-name queries |
| "The referee's activation scenario covers the real failures" | **false** — it covers 2.0%; 83% of misses are recall failures |
| "Hex is often wrong on real binaries" | **false** in the exact-name regime — 229/230 rank 1 — and the misses that do occur are dominated by recall |
| "The gate fires because the top-1 might be wrong" | **unverified and contradicted** — measured on a case where it fired with a correct top-1 |

---

## 7. Proven / not proven

Proven:

- the referee is safe (correct top-1 is never displaced, even when handed a wrong
  challenger; every provider failure class falls back unchanged);
- live OpenJev does select the labelled truth when the wording is goal-appropriate;
- a perfect oracle referee does not move the top-1 in the measured cases;
- real-data impact of the referee as designed is **zero**;
- the real failure mode is **recall**: 27.6% of remembered-name queries never
  surface the correct field as a candidate.

Not proven (and not claimed):

- that a rescue case *cannot* exist elsewhere. The measurement covers three apps
  and the 4 reachable cases inside them; it does not prove universal absence;
- any real-binary case where a probe actually changes the top-1;
- that the ambiguity gate can be repaired with a small precondition. Its premise
  ("a D4/D5 tie implies the top-1 is uncertain") is itself unvalidated — one
  measured instance tied *and* had a correct top-1.

---

## 8. Decision options, with the data attached

| option | what the data says |
|---|---|
| **Freeze / keep shadow-only** | Supported. Zero measured real-data impact, 4 reachable cases in 196, all currently ineligible |
| **Give the referee bounded tie-break authority** | The only way the mechanism can ever act: verified candidates tie on binary evidence and breadth decides. Contradicts the "no confidence authority" rule; needs a new safety story |
| **Attack recall instead** | The data points here: 27.6% of queries never surface the right field, 83% of all misses. Deterministic work in shape discovery, upstream of this feature, no model required |
| **Extend eligibility (already done for `free`)** | Necessary but not sufficient: it converts "zero requests" into "requests that still cannot move the top-1" |

---

## 9. Remaining work

1. Run the four real cases through the referee on the ObjC/fields path — baseline,
   oracle ceiling, and live `choice`/`noul` — and record the result. Needed: a
   real-binary holdout harness (the existing OpenMW one is shapes-only) driven by a
   manifest of `{binary, query, class, ivar, expectedRank, expectedCandidateCount}`.
   `planShapeBoundaryVerification` is reached from the fields path
   (`js/pinpoint-legacy.js:796`) and needs `shapes` with
   `complete === true && capped !== false` plus `semanticBoundaryInteractive: true`;
   unknown options pass through `preparedOptions` in `js/pinpoint.js`.
2. Investigate the recall failure: why does the correct field never become a
   candidate? Split by goal hypothesis vs scan coverage.
3. Only after (1) or (2) produces a positive result should any activation be
   considered.

---

## 10. Repro / evidence index

Measurement runs (real binaries; restore the placeholders afterwards — the
binaries are git-tracked placeholders, the real ones live outside the repo):

```sh
cd <worktree>
cp <scratch>/real-fixtures/<binary> tests/<binary>      # 3 fixtures
node --max-old-space-size=8000 tests/_measure-boundary-premise.mjs tests/<binary> 120
git checkout -- tests/<binary>                          # restore placeholders
```

Offline source-grounded holdout:

```sh
HEX_OPENMW_HOLDOUT_ARTIFACT=<built>/openmw-holdout-breadth-arm64-o1.macho \
  node tests/semantic-boundary-openmw-holdout.mjs
```

Artifacts outside the repository
(`/mnt/workspace/.dev-state/agent-work/evidence/openjev-boundary-referee/`):

| file | content |
|---|---|
| `boundary-premise-battlecats.json` | raw per-query rows, battlecats |
| `boundary-premise-TsumTsum.json` | raw per-query rows, TsumTsum |
| `boundary-premise-YWP.json` | raw per-query rows, YWP |
| `measure-boundary-premise.mjs.txt` | the measurement script as run |
| `openmw-holdout-live.json` | live OpenJev results on the OpenMW fixture |

## 11. Environment limitations

- The canonical `npm run check` is executed quietly and stops at the
  `machine-effects` invariant gate with
  `machine-effects-prerequisite-failure: missing llvm-mc LLVM 18`. A missing
  toolchain in this environment, unrelated to these changes; the gate cannot run
  here.
- `tests/oracle.py` (the independent python oracle, `lief==1.0.0` +
  `capstone==5.0.9`) is not installed, so the repository's canonical
  `npm run accuracy` path was not used. The measurement here derives labels from
  the same unique-name rule that harness uses, from the image's own metadata.
- The OpenMW artifact is built locally and never checked in (GPL-3.0-only).
