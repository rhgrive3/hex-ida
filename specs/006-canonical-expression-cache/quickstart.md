# Quickstart & Verification Guide: Phase 8 Canonical Expression Caching

## 1. Focused Unit & Counterexample Tests

Run the dedicated test suite for Phase 8 substrate proof projection and consumer source map validation batch:

```bash
node --test tests/phase8/substrate/proof-projection-origin.test.mjs
node --test tests/phase8/substrate/consumer-source-map-batch.test.mjs
```

Expected output: All tests pass with 0 failures.

## 2. Phase 8 Ownership Verification

Verify that the changes do not touch files outside Phase 8 ownership:

```bash
node tools/validation/phase8-ownership.mjs --files-json '["js/decompiler/pipeline-core.js", "tests/phase8/substrate/consumer-source-map-batch.test.mjs"]'
```

Expected output:
```json
{"phase":8,"manifestVersion":1,"lane":"p8","baseSha":null,"headSha":null,"changedFiles":2,"violations":0}
```

## 3. Correctness & Output Equivalence Check

Run the compare script to verify that generated pseudocode and proofs are byte-identical before and after:

```bash
node _perf_scratch/compare.mjs benchmarks/public/codefuse-arm64/inputs/9981aed241a45268b6c40d9beb43a4a15c767b6bd3885175cfa99991c07c2d93.bin 6328 3
```

Expected output:
- `pseudocodeDigest`: identical
- `cAstDigest`: identical
- `sourceMapDigest`: identical
- `rewriteProofDigest`: identical
