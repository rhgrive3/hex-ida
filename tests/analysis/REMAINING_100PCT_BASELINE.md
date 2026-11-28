# Cross-binary accuracy baseline and regression floors

Cross-binary accuracy is measured against independent LIEF + Capstone oracles across three real-binary targets (`BattleCats`, `TsumTsum` via `bainary-test`, and `YWP`) using `npm run accuracy` (`tests/accuracy.mjs` + `tests/accuracy-base.mjs` + `tests/accuracy-short-selector.mjs`) and gated by `tests/accuracy-gate.mjs`.

## Recorded baseline metrics (`tests/benchmark-baseline.json`)

The active `observations.accuracy.targets` baseline records `functionStartPrecision: 1` and `functionStartRecall: 1` across all three targets. Features below `1.000` in the current recorded baseline are:

| Target | Feature | Recorded baseline | CI gate floor (`tests/accuracy-gate.mjs`) |
| --- | --- | ---: | ---: |
| BattleCats | `funcs-guess` | `0.9968745131640442` | `0.982` |
| TsumTsum (`bainary-test`) | `funcs-guess` | `0.9941073795556256` | `0.9732` |
| TsumTsum (`bainary-test`) | `kinds` | `0.9994435685801725` | `0.998` |
| TsumTsum (`bainary-test`) | `refs` | `0.9999984721791462` | `0.998` |
| TsumTsum (`bainary-test`) | `objc` | `0.9995778096766023` | `0.990` |
| TsumTsum (`bainary-test`) | `selffield` | `0.9987234042553191` | — |
| TsumTsum (`bainary-test`) | `apimeaning` | `0.9984817571914346` | `0.993` |
| TsumTsum (`bainary-test`) | `summary` | `0.995` | `0.990` |
| TsumTsum (`bainary-test`) | `pseudoc` | `0.9978510028653295` | `0.994` |
| YWP | `funcs-guess` | `0.9747791554692281` | `0.970` |
| YWP | `kinds` | `0.999957457670382` | `0.998` |
| YWP | `apimeaning` | `0.9983282246187818` | `0.992` |
| YWP | `pseudoc` | `0.9991641125661744` | `0.994` |

All other measured features on each target are at `1.000` in `tests/benchmark-baseline.json` (inapplicable features such as `formula` on TsumTsum or ObjC-specific metrics on YWP are recorded under `unmeasuredFeatures` and emitted as `N/A` rather than `0`).

## Verification and integrity rules

- Run `npm run benchmark:baseline` to validate the baseline contract (`tests/benchmark-baseline.mjs`).
- Run `npm run accuracy` (after fetching real fixtures via `npm run fixtures:fetch` or `npm run fixtures:large`) and `node tests/accuracy-gate.mjs` to check live cross-binary scores against the CI floors.
- Exactness improvements must come from general production semantics—never by lowering gate thresholds, hardcoding fixture-specific addresses, falling back to generic unknown API labels, or suppressing raw assembly. Oracle/scorer fixes are permitted only where the claimed ground truth is statically invalid (for example, `tests/accuracy-short-selector.mjs` for short selector name matching in `summary`).
