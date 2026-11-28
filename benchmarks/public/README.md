# Public benchmark inputs

Frozen public benchmark manifests and inputs live under this directory. Competitor binaries and benchmark run outputs are not vendored here.

## Suites

- `codefuse-arm64/` (`manifest.json`, schema `hex-public-benchmark-manifest/v1`): frozen 160-case ARM64 benchmark suite with 160 compiled binary inputs under `inputs/` and reference sources under `reference/`.

## Commands

```sh
npm run benchmark:public:prepare   # prepare/validate public benchmark inputs
npm run benchmark:public           # run the public benchmark harness
npm run benchmark:public:test      # run public benchmark harness tests
```

For methodology, scoring rules, and competitor protocol details, see `docs/PUBLIC_COMPETITOR_BENCHMARK.md`.
