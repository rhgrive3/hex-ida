# OpenJev Boundary Referee — Design v1.1

Status: Reviewed MVP — instrumentation + shadow first.

## Decision

OpenJev is **not** a new analysis engine, proof source, confidence source, or full reranker. It is an optional **Boundary Referee** for interactive single-goal game-location analysis.

Given deterministic candidates `D1..D8`:
- `D1..D3` are immutable.
- Normal verification remains `D1..D4`.
- Only when the deterministic `D4/D5` boundary is genuinely ambiguous may OpenJev inspect compact semantic facts for `D4..D8`.
- It may propose at most one challenger from `D5..D8`.
- A challenger never enters normal verification directly. It first gets at most **one bounded binary-grounded probe**, which may open at most `VERIFY_FUNCTIONS = 3` distinct function windows—the same cap the ordinary verifier applies.
- If that probe fails, Hex uses the original `D1..D4`.
- If it succeeds, existing deterministic evidence—not Jev probability—decides whether the challenger can compete with D4.

The purpose is to improve allocation of the existing verification budget, not to make Hex “deeper”.

## Current-main constraints

The reviewed main has these relevant properties:
- shape discovery can return up to 8 candidates via `shapes.byGoal(..., 8)`;
- normal location verification uses `VERIFY_CANDIDATES = 4`;
- one candidate can open up to `VERIFY_FUNCTIONS = 3` functions;
- background auto location analysis has a default budget of 7;
- the interactive single-goal path has a much larger budget (48);
- existing proof/evidence/fusion/verdict semantics are already binary-grounded.

Therefore a Jev-selected candidate must **not** be moved to the front of the normal verification list: it could consume up to 3 of 7 auto-analysis calls before deterministic candidates. Phase 1 is interactive-only.

## Goals

- Rescue true candidates that deterministic ranking leaves at D5–D8 when D4/D5 is genuinely ambiguous.
- Improve boundary-rescue / verification-hit@4 without worsening final top-1, wrong-top-1, false-likely, or analysis cost.
- Preserve Hex behavior when OpenJev is absent or unavailable.
- Keep the public frontend static/lightweight while keeping the shared OpenJev key secret.

## Non-goals

Do not let OpenJev determine function boundaries, CFG, ABI facts, field offsets, types, proof, verdicts, or final confidence. Do not send whole binaries, assembly, pseudocode, absolute addresses, offsets, existing shape scores, deterministic rank, or existing role labels. Do not add a Deep/OpenJev mode, settings UI, generic LLM abstraction, agent loop, or background-all-goals integration.

## Invocation policy

Call the referee only when all applicable gates pass:
- interactive single-goal path;
- `o.analyze` exists;
- supported existing shape goal **that also has calibrated goal guidance**
  (`reason: 'uncalibrated-goal'` otherwise);
- 5–8 candidates;
- scan is complete and not capped;
- not cancelled and analysis budget remains;
- D4/D5 ambiguity satisfies a policy derived from labelled holdout data.

Candidate count alone is never sufficient. If D4 clearly beats D5, external traffic is zero. Background auto traffic is zero in this rollout.

### Calibrated-goal rule

The model-facing wording lives in `SEMANTIC_BOUNDARY_GOAL_GUIDANCE` in `js/semantic-boundary-referee.js`, and a goal is eligible only when it has an entry there. A regression asserts that every entry cites a real holdout case that labels that goal, so the cheap way to enable a goal is to add labelled evidence — not to widen a set. This matters because some goals have no distinguishing shape hypothesis at all: on the OpenMW fixture, `level` and `item` expose exactly the same five resources as `hp`, so the boundary question would be ill-posed and a confident answer would be unfounded. Those goals therefore fail closed with zero egress.

## Candidate summary

Send only observed semantic facts. Candidate IDs are opaque (`c0`, `c1`, …); the browser retains the candidate→offset mapping.

Allowed examples:
- goal id / human-readable goal label;
- size;
- decreases / increases / clamped / crossObject / scaled;
- usedAsAmount / usedCross / usedScaled;
- functionCount / loadCount / storeCount;
- identityKnown / completeness.

Forbidden:
- absolute address or offset;
- deterministic rank;
- shapeScore/resourceScore/damageSourceScore;
- precomputed role such as `damage-source`;
- machine bytes, assembly, pseudocode, full symbols.

This keeps the Jev signal meaningfully independent instead of teaching it to repeat Hex’s current heuristic.

## Shadow evaluation before promotion

Before production influence, add instrumentation that records for labelled game-analysis holdouts:
- true candidate deterministic rank;
- D4/D5 score and gap;
- candidate count;
- analyze-call count;
- candidates verified;
- first verified candidate;
- final top-1 and verdict;
- wrong-top-1 / false-likely.

First establish that real failures exist where truth is D5–D8 and the current D1–D4 verification boundary misses it. If that rescue opportunity is not measurable, do not force production integration.

In shadow mode compare two OpenJev question contracts on the same holdout:
1. one `choice` over the boundary candidates with explicit `none`;
2. parallel `noul` questions asking whether each candidate semantically matches the requested gameplay value.

If using parallel noul, all candidate questions must be in one System One request, not separate HTTP calls. Compare boundary rescue, precision, abstention behavior, false promotion, probability margin, and latency. Keep only the better contract in production.

## Bounded one-probe rule

An admitted D5–D8 challenger gets at most one probe before normal verification, and that one probe may open at most `VERIFY_FUNCTIONS = 3` distinct function windows. Reuse existing binary-grounded mechanisms such as `program.functionRange()`, `analyze()`, `describePurpose()`, and `changeAt()`.

The probe must independently re-establish the relevant field/change from actual instructions. A window that does not reconfirm the change is not evidence, but it also does not end the probe: the next scanned site is tried, still inside the same three-window cap. Only when no window reconfirms the change is the challenger discarded and the original D1–D4 path preserved.

`SEMANTIC_BOUNDARY_PROBE_RESERVE` is therefore `VERIFY_CANDIDATES * VERIFY_FUNCTIONS + VERIFY_FUNCTIONS` (15): the untouched `D1..D4` envelope plus the whole bounded probe, so a failed probe can never eat into the baseline plan.

A successful probe still does **not** turn Jev probability into evidence. D1–D3 remain unchanged, and D4/challenger competition must be resolved from existing binary-grounded evidence.

## Core integration boundary

Keep OpenJev/fetch/Cloudflare out of pinpoint core. Inject an optional callback, conceptually:

```js
semanticBoundaryReferee?: async ({ goal, candidates }) => ({
  challengerId: "c2" | null,
  method: "choice" | "noul",
  probabilities: {},
  model: "openjev",
  abstain: false
})
```

The callback returns no proof, verdict, Hex confidence, or authority. With no callback, current behavior must remain unchanged.

A small module such as `js/semantic-boundary-referee.js` may own gating, fact summarization, and admission. Do not build a generic semantic/LLM framework.

## Worker architecture and shared key

Use the existing Cloudflare Worker boundary and existing provider-spend controls.

```text
Browser
  -> POST /api/semantic-rank + existing Hex AI capability
worker-entry.js
  -> origin/CORS
  -> provider-spend authorization
worker.js
  -> strict schema / body cap
  -> existing AI_QUOTA
  -> fixed OpenJev request
  -> finite timeout, no retry
api.openjev.sh/v1/systemone
  Authorization: Bearer env.OPENJEV_API_KEY
```

The shared key exists only as Cloudflare Secret `OPENJEV_API_KEY`. Never commit it, expose it through PUBLIC/VITE variables, return it, or log it.

`/api/semantic-rank` must be a purpose-built endpoint, not a generic OpenJev proxy:
- POST + JSON only;
- strict schema and numeric/string bounds;
- small request body (initial recommendation: <=24 KiB);
- at most 8 candidates;
- client cannot choose upstream endpoint, model, instructions, or arbitrary questions;
- reuse existing AI capability/provider-spend authorization and `AI_QUOTA`;
- `Cache-Control: no-store`;
- production logs contain only minimal metadata such as status, latency, candidate count, and usage—not state or OpenJev response bodies.

## OpenJev contract

Use `POST https://api.openjev.sh/v1/systemone` with Bearer authentication. This is the contract verified against the live service (the same endpoint/base as `jev-context`) and confirmed by a direct probe: the shared key authenticates there, `api.codiv.ai` rejects it with 401, and `GET https://api.openjev.sh/v1/models` offers only `openjev` (an `openjev-0.1` request returns 422). Production must pin that exact id: `openjev`. Do not use `openjev-latest` in production. Validate the returned `model` field and abstain/fallback on mismatch.

Phase 1 intentionally does not use advanced/deep reads:
- no `think`;
- no `samples > 1`;
- no `steps > 1`;
- no `sequential`;
- no generation endpoint;
- no multi-stage reasoning or agent loop.

Start with an upstream timeout ceiling of 2.5 seconds and zero automatic retries; shorten it after measuring p95. OpenJev is optional, so waiting longer is not correctness-critical.

## Failure semantics

Any timeout, network failure, 401/403, 429, 5xx, malformed response, invalid candidate ID, missing probability, unexpected model, contradictory answer, abstention, or failed admission/probe falls back to the deterministic D1–D4 path. OpenJev failure must never make Hex analysis fail.

## Confidence and evidence boundary

Phase 1 must not:
- add an `ai-semantic-match` evidence item;
- feed Jev into `GROUP.EXTERNAL` or evidence fusion;
- promote to LIKELY/CONFIRMED because of Jev;
- change function/type/field authority;
- synthesize missing proof.

OpenJev probability/confidence is a model preference signal, not a calibrated probability that the candidate is correct.

A future, separate ADR/PR may consider weak external evidence only after a sufficiently labelled holdout permits independent Brier/ECE measurement and calibration. That is explicitly outside this design.

## Required tests

At minimum:
1. <=4 candidates: referee called 0 times.
2. 5–8 candidates with clear D4/D5 gap: 0 calls.
3. background auto: 0 calls.
4. incomplete/capped scan: 0 calls.
5. abstain/no challenger: original D1–D4.
6. recommendation inside D1–D4: no extra probe.
7. admitted D5–D8 challenger: at most one probe, bounded to at most 3 distinct analyze windows.
8. failed probe: original verification set/result.
9. successful probe: D1–D3 unchanged.
10. Jev probability alone cannot increase proof/evidence/verdict/confidence.
11. timeout/429/5xx/malformed response: deterministic fallback.
12. API rejects client-selected model/instructions/upstream.
13. outbound payload contains no address/offset/shapeScore/role/rank/pseudocode/assembly.
14. missing `OPENJEV_API_KEY`: safe fallback with no secret/upstream-body leakage.
15. callback omitted: existing fixtures remain behaviorally identical.

## Evaluation metrics and rollout gates

Measure:
- boundary-rescue rate;
- verification-hit@4;
- one-probe precision;
- final top-1;
- wrong-top-1 / false-likely;
- analyze-call delta (mean and p95);
- API call rate;
- added latency p50/p95.

Do not enable promotion unless rescue/hit@4 improves materially while final top-1 does not regress, wrong-top-1/false-likely do not increase, analysis count stays bounded, and provider-failure tests preserve baseline results. Admission thresholds/margins and the D4/D5 ambiguity policy must come from the labelled holdout, then be frozen in fixtures—not chosen by intuition.

## Rollout

- **Phase 0 — Instrumentation:** no API influence. Measure ranks/gaps/budget/outcomes and establish whether a rescue opportunity exists.
- **Phase 1 — Shadow:** call OpenJev without changing results; compare choice+none vs parallel noul and determine admission/latency.
- **Phase 2 — Probe MVP:** interactive single-goal only; admitted challenger gets at most one probe.
- **Phase 3 — Interactive default-on:** only after holdout gates pass; no new user-facing mode.
- **Future:** background auto, custom natural-language goals, or calibrated external evidence require separate design/PR decisions.

Rollback is simply disabling/removing `semanticBoundaryReferee` injection; core verification remains intact even if OpenJev disappears.

## Expected implementation surface

Likely touched/added files when implementation eventually begins:
- `js/pinpoint-legacy.js`: boundary hook + one-probe only; preserve D1–D3 and existing proof/evidence logic.
- `js/semantic-boundary-referee.js`: gating, summary, admission.
- `js/ai/provider/worker-semantic-rank.js`: strict schema and pinned OpenJev transport.
- `worker.js` / `worker-entry.js`: route and existing provider-spend boundary.
- focused evaluation harness/tests.
- `wrangler.jsonc` should not contain the key; secret is deployment configuration.

## Definition of Done for a future implementation

- No OpenJev key in repo, frontend bundle, response, or logs.
- Endpoint cannot be used as a generic OpenJev proxy.
- Provider absence/failure preserves deterministic analysis.
- D1–D3 never change because of Jev.
- At most one D5–D8 challenger and at most one pre-verification probe.
- Jev alone cannot raise verdict/probability/proof/authority.
- <=4 candidates, non-ambiguous boundaries, incomplete scans, and background auto produce zero external calls.
- Promotion remains disabled until instrumentation + shadow holdout demonstrates value.
- No new Deep/OpenJev mode or settings UI.

## Final design criterion

## What survives verification (measured)

A promotion decision needs to know which evidence can still separate candidates *after* the normal verifier runs. On the source-grounded OpenMW fixture, with a forced oracle challenger so the labelled truth is probed and verified:

| candidate | loc-drain-verified | loc-clamp-verified | loc-shared | logOdds | p |
|---|---|---|---|---|---|
| rank 1 (leader) | 3.4012 (n=3) | 1.7918 (n=3) | 1.1632 (n=3) | 4.0080 | 0.982155 |
| labelled truth (rank 5) | 3.4012 (n=3) | 1.7918 (n=3) | 0.7754 (n=2) | 3.6203 | 0.973924 |

The verified codes carry **constant** likelihood ratios (`loc-drain-verified` lr 30, `loc-clamp-verified` lr 6) and their strength saturates at two confirmed changes, so “verified drain” behaves as one binary fact. The only graded quantity left is `loc-shared` — how many functions touch the field. A referee can therefore only change the outcome when the labelled truth is not behind on usage breadth; a case whose truth is touched by fewer functions than its decoys cannot be rescued by any referee, including a perfect one. Holdout cases must be selected with that condition in mind, and each pool must include all of the upstream project's real update sites rather than a hand-picked subset.

Success is not “making Hex AI-powered.” Success is leaving already-clear deterministic results untouched while rescuing a genuinely ambiguous D5–D8 true candidate into one bounded binary-grounded probe—and retaining exactly the current Hex behavior when OpenJev is removed.
