# Public competitor artifact benchmark

This lane is separate from SCPA native-competitor acceptance. It compares the current Hex ARM64 product analysis path with frozen, public competitor artifacts without installing the competitor locally. It never sets `nativeCompetitorsRun`, never measures competitor latency, and consumes zero native SCPA cells.

## CodeFuse ARM64 / published IDA Pro 9.1 artifacts

Prepare once from a pinned CodeFuse-DeBench checkout:

```bash
npm run benchmark:public:prepare -- --source /path/to/CodeFuse-DeBench --out benchmarks/public/codefuse-arm64/manifest.json
```

Preparation freezes the denominator and SHA-256 of every matched `build/arm64/...` binary and `decompiled/ida_out/arm64/...c` artifact and rejects reference files whose header is not `Decompiled by IDA Pro 9.1 with Hex-Rays`. The requested manifest must stay below `benchmarks/public/<suite>/manifest.json`; preparation refuses to overwrite an existing suite directory.

Run from the repository root:

```bash
npm run benchmark:public -- --manifest benchmarks/public/codefuse-arm64/manifest.json --output reports/public-benchmark --timeout-ms 120000
node tools/validation/public-benchmark/report.mjs reports/public-benchmark/summary.json
```

The analyzer runs in a child Node process with a finite timeout. The benchmark binary is passed to the analyzer as input and is never executed as an operating-system process. The terminal host uses the production `Backend`, product `App` discovery/range methods, artifact route, public `AnalysisQueryAPI`, and shipped workers through a Node transport. Network fetch inside worker threads is disabled. The adapter contains no decoder, semantics, rewrite, or oracle implementation.

The default report measures function/address coverage and structural readability proxies. Semantic correctness and recompilability remain `UNMEASURED` until a symmetric, precommitted evaluator is added; CodeFuse's historical LLM-repaired scores are not compared to raw Hex output.

## Claims

Allowed: `Hex <candidate> vs CodeFuse-DeBench published IDA Pro 9.1 ARM64 artifacts` for metrics actually measured.

Not allowed from this lane: IDA 9.3/9.4 victory, native IDA timing, same-machine performance, same-Astra efficiency, or SCPA native-competitor acceptance.
