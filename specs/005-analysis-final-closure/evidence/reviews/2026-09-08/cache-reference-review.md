# Independent current cache/reference review

- **Reviewed source:** `/mnt/workspace/hex-development-gate-policy`
- **Reviewed HEAD:** `71bf992abe131c044b144175ce8db72939c87b1d`
- **Target changes:** `880f1657284b0895a5ac09184479308b18c59edd` (canonical Semantic IR/MemorySSA reuse) and `0303789389784686f3b71d18b88f5692216c2bc3` (frozen P8 reference/numeric binding).
- **Scope:** read-only production review; no tracked files or primary checkout changes.

## 880f16572: canonical Semantic IR/MemorySSA reuse

Production path reviewed:

- `js/semantics/ir/function.js:51-75,308-346` keeps private WeakSet/WeakMap authority, checks abort before the default-budget fast path, only marks deeply frozen factory output, and rechecks explicit-budget objects.
- `js/semantics/memoryssa/build.js:60-86,1507-1522` caches only the deeply frozen builder artifact and binds its semantic digest to the exact IR object when the serialized identity digest agrees.
- `js/semantics/memoryssa/operand-forwarding.js:25-37,94-99` and `js/semantics/memoryssa/queries.js:55-56,1234-1260` retain digest/identity checks and the private producer-brand gate. `js/semantics/compat/index.js:519-522` uses the canonical digest in the compatibility identity.

Six boundary probes all passed:

1. default-budget canonical IR validates by identity;
2. a pre-aborted signal still rejects before the fast path;
3. a structured clone is unbranded and is normalized independently;
4. an exact producer/IR pair receives the private semantic binding while the clone does not;
5. a canonical producer with a mismatched serialized semantic digest receives no semantic binding;
6. a mutable unbranded MemorySSA-shaped object is redigested after mutation.

The focused Node 22 test `tests/final-closure/t013/memoryssa-digest-cache.test.mjs` passed **5/5**, including the explicit looser-budget object being rejected by later default limits. I found no concrete correctness defect in these exercised cache, cancellation, budget, clone, or identity boundaries.

Reproducible probe artifacts: [source](<independent-cache-probe.mjs.txt>), [output](<independent-cache-probe-output.json>), and [commands](<independent-probe-commands.txt>).

## 030378938: frozen P8 reference and numeric binding

Production path reviewed:

- `tools/validation/competitive/measurements.mjs:926-963` enforces candidate/reference denominator identity, candidate completeness, finite metric values, and computes the comparison.
- `tools/validation/competitive/measurements.mjs:977-1073` loads the repository baseline, provenance sidecar, and corpus as one authority, rejects caller-supplied digest drift, and returns repository-owned objects after binding.
- `tools/validation/competitive/measurements.mjs:1096-1135,1138-1246` rechecks the frozen baseline/provenance/corpus lineage at validation and carries those digests into denominator/oracle fields.

Eight boundary probes all produced the expected blocking behavior:

1. canonical deep clones with no capture remain `UNMEASURED/twin-capture-missing`;
2. baseline commit drift is rejected as `phase8-frozen-baseline-authority-mismatch`;
3. a self-consistent changed baseline observation is rejected as baseline authority mismatch;
4. a self-consistent changed provenance sidecar is rejected as provenance authority mismatch;
5. a changed corpus function identity is rejected as corpus authority mismatch;
6. candidate ID/order drift is rejected as observation denominator mismatch;
7. an incomplete candidate semantic row is rejected;
8. a non-finite candidate metric is rejected.

The focused Node 22 test `tests/competitive/measurements.test.mjs` passed **6/6** with the supplied `HEX_COMPETITIVE_P8_CAPTURE_FIXTURE=/mnt/workspace/.dev-state/competitive-measurement-captures/p8-1813-capture.json` and the LLVM 18 toolchain path. This is a positive regression-fixture result for the binding/test harness; it is **not** measured product or release evidence for the canonical corpus. No release claim is based on this fixture run.

Reproducible probe artifacts: [source](<independent-reference-probe.mjs.txt>), [output](<independent-reference-probe-output.json>), [commands](<independent-probe-commands.txt>), and [focused test output](</mnt/workspace/.dev-state/hex-development-batch/competitive-measurements-p8-fixture-output.txt>).

## Findings and limits

- **No concrete product defect found in the exercised boundaries.** The cache is private/immutable and falls back to full digesting for unbranded values; the P8 caller inputs are digest-bound and the score path uses repository-loaded authority.
- **Evidence scope limitation:** `tools/validation/phase8/build-corpus.mjs:327-330` loads the corpus JSON without recomputing its declared `corpusDigest`. `phase8FrozenAuthority` compares declared baseline/corpus fields at `measurements.mjs:982-996`, and later lineage checks recompute function/source/byte identity for captures, but the 030 change itself does not independently authenticate the corpus file's top-level digest. A coordinated edit to the tracked corpus plus matching baseline/provenance metadata would therefore rely on exact-head/Git integrity outside this runtime path. This is a release-evidence limitation, not a demonstrated scoring failure.
- No full repository gate, corpus/profile run, or trusted-device/capture run was started. The parent’s live canonical gate and exact-head/release evidence remain authoritative for those claims.

