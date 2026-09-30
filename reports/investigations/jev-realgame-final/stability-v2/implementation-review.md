# stability-v2-final-review — independent adversarial review (stability-design-v2 lane)

**Reviewed head:** actual worktree HEAD `7e32114cf53887414b158bc2cf8022b667904ef8`
(note: prompt said `505bf3500`; one newer pre-calls commit `7e32114cf` "Record prospective shortlist
recall separately for the guarded arm" exists — it only adds per-arm shortlist instrumentation,
refreshes execution-freeze hashes, and asserts the new field in the verifier).
**Mode:** read-only review; **no API calls, no source edits, no holdout query bodies / oracle names /
outcomes read** (files not read: `holdout.json`, `queries-*.json`, `structural-cases.json`,
`authority.md`, `layout-*.json`, `freeze.json`). `TMPDIR/TMP/TEMP` set as required.

**Source identities (sha256, current disk = HEAD):**
- `js/pinpoint.js` `9f80701fb298e2bac1028fd8e7182b3a525cfde41b179957c8676e7870ec7f2f` (= policy `routerSourceSha256` ✓)
- `js/analysis/query/cxx-semantic-preference.js` `0cb3730c500ef1c211140f59f65a155e2deafdf9c2d9b1cd5dabbb9d661b0434` (= policy `rankingSourceSha256` ✓)
- `scripts/jev-realgame-stability-contract.mjs` `b598a99deccbd5233a96f8faeea37d5e479fdea7855dbb2025ed06c88a4ad9c2` (= policy `contractSha256` ✓)
- `scripts/collect-jev-realgame-stability.mjs` `2f83ae5ff9547060df9b644eb9074208638f23b5c8dcd905bee1056f5bce22da`
- `scripts/evaluate-jev-realgame-stability.mjs` `e5431b7229878f242c33319b00ce08cd0fdb80d6b9cb4b3c0d5c01d254dfe651` (= execution-freeze ✓)
- `scripts/verify-jev-realgame-stability.mjs` `00c82f97f76e707af06bea3cf759f7f5b92f8ef3b924ec4b29eee9232f382b48` (= execution-freeze ✓)
- `scripts/run-jev-stability-controls.mjs` `ca4ea6fec73659e6d922451abedc3b840326df86eefc854ddf99aca070d7d265` ✓; `scripts/jev-realgame-final-client.mjs` `cf0776f0…a9d07` ✓
- `stability-v2/policy-freeze.json` `a43b48fde7d15f6863c7c7483757a1223313cea5796352706a9183a6670d4d59` (= execution-freeze `policySha256` ✓); `stability-v2/execution-freeze.json` `fa46a0f830d4fb1fc0dfad15f8a640033e9d02ff7bddf021af861008975baf32`
- All five execution-freeze `sourceHashes` match disk (checked mechanically). All 12 collector-bound
  product sources have **zero diff** from collection SHA `77984276ef1ef4f4e09eb00bbcfe13836498c2dc` to HEAD.

**Test command and result (one cheap focused run, no broad suites):**
`node --test tests/pinpoint-jev-shortlist.test.mjs tests/phase7/cxx/pinpoint-publication.test.mjs`
→ **27 tests, 27 pass, 0 fail** (16.9 s), covering: advisory committed-local under varying suggestions,
contradictory/malformed identities, duplicate structural keys, real timeout with request abort,
post-snapshot-change rejection, default-disabled, no-verdict-promotion, and the semantic-preference
test (verdict unchanged, `analyses === 0`, mixed-lattice bail, invented-owner → null view).

## Verdict

**Conditional PASS — one process blocker (B1) must be fixed before any final-holdout API call.**
The implementation faithfully realizes the accepted design: deterministic local commit (R1) with
one-sided advisory separation, a strictly bounded tie-pool remote route (G), fail-closed router
hardening, and promotion criteria whose denominators fail closed. No representation-leakage or
guard-invariant violation was found in scope. This review does **not** claim model stochasticity
disappeared: raw stochasticity remains a measured quantity; only *committed* stability of R1/ADVISORY
is guaranteed by construction, and G/E2 committed stability is only ever *measured*.

## B1 — blocker: execution freeze is not mechanically enforced

`evaluate` and `verify` never read `execution-freeze.json`. Its `sourceHashes` (evaluate, verify,
controls, client), `collectionProductSha`, `policySha256`, `maxAttempts`, `repeats` are documentary
only. Policy bindings cover contract/ranking/router/holdout; snapshot `sourceHashes` cover the 12
collector sources; **nothing binds the evaluator and verifier themselves at runtime**, so either can
be edited after this review with no failing check — the guardrail class "a documented invariant that
is not mechanically enforced is not an invariant yet".
**Smallest fix (~10 lines each, pre-calls, no criteria/representation change):** in both `main()`s,
load `execution-freeze.json` and fail closed unless (a) `sha256(own file)` equals its entry, (b) every
`sourceHashes` entry matches disk, (c) `snapshots.productSha === collectionProductSha`, (d)
`policySha256` matches. This also closes the unasserted collection-SHA claim.

## N-notes (cheap reconciliations, not safety holes)

- **N2 provenance gap:** `verifierHardeningBeforeFinalEvaluation.priorVerifierSha256` = `5f9d4338…`
  does not equal the original freeze entry for the verifier (`e7bd8cc2…` before `7e32114cf` refreshed
  it) — one intermediate verifier transition is unrecorded. All claim `finalHoldoutCallsBeforeChange: 0`;
  reconcile the field (or mark the original entry superseded) so the audit chain is continuous.
- **N3 criteria asymmetry:** evaluate's `OPTIONAL_ADVISORY` adds a conjunct
  (`summaries.ADVISORY.regression === summaries.R1.regression`) that the verifier's independent
  recomputation omits. It is redundant (ADVISORY.correct ≡ R1.correct by construction), and divergence
  can only cause a hard verifier *failure*, never a false pass — still, make both conditions
  byte-identical so replay and runner agree by construction.
- **N4 cumulative `recovered` attribution:** collector rows carry `recovered: rawRecovered.slice()`,
  session-cumulative across queries (identical pattern to the accepted v1 collector
  `collect-jev-realgame-recovery.mjs`), so funnel split `recoveredButNotPublished` /
  `candidate recovery failure` is cross-query and order-bound. Not promotion-affecting (DEFAULT_ON
  uses `latticeRecall` from session `published` by design, disclosed in v1), but the v2 report should
  state this disclosure explicitly as v1 did.
- **N5 started vs skipped calls:** timeout guarantees decision fallback regardless of client behavior;
  the test proves the signal is aborted. Wire-level "started" counts must come from client attempt
  logs — policy `timeouts` already requires this distinction; keep it in the report.
- **N6 HEAD mismatch:** prompt's `505bf3500` vs actual `7e32114cf` — evidence records must cite the
  SHA the final calls actually run on (Actions already bound to `77984276ef` for collection).

## What was verified as sound

**Guard invariants (`js/pinpoint.js` delta):**
- Pre-call gates → zero calls: `enabled`, `mode==='partial'`, ≥2 candidates, non-strong verdict,
  duplicate lattice keys rejected up front, `opts.signal.aborted` before dialing.
- Post-call gates → committed decision unchanged: bounded wrapper (`timeoutMs` 1..120000, default
  15 s, cancellation propagated), response bound to the exact sent view (reference + key-order +
  `isCurrent()` recheck after the await), contradictory key/index identity rejected, out-of-range and
  invented keys rejected, lattice match required to be unique (`matching.length === 1`), verdict never
  promoted, any throw → original local result.
- `adviseWithJev` structurally forces `top1 = local.top`, `source:'hex'`, advisory flagged
  `advisoryOnly` — remote can never mutate the committed result on this path; test asserts committed
  stability across three different suggestions and on client failure.

**Representation/leakage boundary:** collector manifest accepts only `{id, query, mode}` keys against
a binary SHA; E2 payload = frozen describeCandidate('C') + reads/writes + demangled release methods
and the four bounded roles; `cxxSemanticViews` derives method names **only from the active binary's
symbols** after full canonical-evidence validation (digest/offset/size/ownerKey/offsetToTop/`this`
role), returning null for any candidate that fails — and `withCxxSemanticPreference` then returns the
input untouched (fail-closed). Preference is skipped entirely for strong verdicts, empty lattices,
and any mixed/named/askedByName candidate set. No oracle import anywhere in the routed path; payload
drift is asserted in the verifier via bodyHash/criteria equality.

**Effective stability vs raw stochasticity:** metrics list both `raw repeated instability` and
`committed repeated instability`; `ADVISORY` rows replay E2 raw keys but commit R1 keys (verifier
asserts `ADVISORY.key === R1.key` and filled repeats); controls record `rawUnstable` and
`committedUnstable` separately with `committedKey === baselineKey` asserted; the summary's
interpretation string explicitly attributes remote value only vs R1 and never from preserved local
choices. R1/ADVISORY committed instability is 0 by construction (pure `stablePick`); G admits remote
choice inside a single-owner equal-score tie pool only, gated by `max > 2·ownerHits` (a query-matching
method context must exist) with deterministic `pool[0]` fallback on every failure mode.

**Source/snapshot binding:** single-valued `productSha` across snapshots; per-file drift loop over the
12 collector sources (verified clean vs `77984276ef`); `queriesSha256`/`policySha256` recorded;
production-ranking parity asserted twice (evaluator: stored `stableTopKey` vs contract `stablePick`;
verifier: same, plus `trustedViews` deep-equal to snapshot function contexts), so product and
evaluation scoring cannot silently diverge — the exact class of defect from the earlier receipt errata.

**Metrics/classification denominators:** remote arms scored `vsR1` (rescue/regression against the
deterministic commit, not against A); destruction = no `repeatedCorrect:false` on any R1-correct row
plus controls `rawCorrect === total` on every baseline-correct control; `preservationDenominator =
R1-correct + baseline-correct controls` requires ≥15 with ≥5 C++-weak — a repeat with a degenerate
0/0 C++ baseline **cannot** reach DEFAULT_ON or SELECTIVE (fail-closed, as required);
`localPromotion` is independent of any remote; verifier recomputes promotion independently instead of
trusting the runner; `majorityVoting:false` and primary repeat 0 frozen; control bar is stricter than
v1 (all 5 repeats raw-correct, not 3/5).

## Smallest justified fix list (in order)

1. **B1:** assert execution-freeze bindings (own hash, sourceHashes, collectionProductSha,
   policySha256) inside evaluate and verify `main()` — fail closed. (Blocker for final calls.)
2. **N2:** reconcile the verifier `priorVerifierSha256` field with the freeze's original entry.
3. **N3:** copy the OPTIONAL_ADVISORY conjunct set verbatim between evaluator and verifier.
4. **N4:** one disclosure line that `recovered`/`published` are session-cumulative (v1-equivalent).

No product-source edits were made by this review; parent owns all fixes.
