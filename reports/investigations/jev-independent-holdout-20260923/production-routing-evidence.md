# Independent Jev holdout: production-routing evidence

Product commit: `71e8d619a7680befe5b0158c1ac08db21d8422f4`. Cases: **48** (36 answerable, 12 abstain-gold).
This is independent at the case/field/query level; it reuses three historical binaries, so binary-level generalization is not established. G28 is a research candidate and is not deployed.

| Arm | answerable top-1 | action correct (all) | abstain | false strong | unsafe confident |
| --- | ---: | ---: | ---: | ---: | ---: |
| A_baseline | 3/36 (8.3%) | 10/48 | 35/48 | 7 | 11 |
| B_deterministic_lexical | 3/36 (8.3%) | 10/48 | 35/48 | 7 | 11 |
| C_G28_routed | 3/36 (8.3%) | 10/48 | 35/48 | 7 | 11 |
| D_Jev_force_all | 3/36 (8.3%) | 10/48 | 35/48 | 7 | 11 |

C routed **0** cases; Jev choice precision on valid routed answerable cases was **0/0**.
Versus B: **0 rescue, 0 regression, net rescue 0**. Calls per rescue: **0**.
B was already correct on **0** routed answerable cases.
D force-all made **42** HTTP attempts and had **0 rescue / 0 regression** versus B.

C HTTP latency p50/p95/max: **null/null/null ms**; total **0.00 s**.
D HTTP latency p50/p95/max: **642.57/817.53/867.88 ms**; total **26.13 s**.
API-reported tokens: C **0 input / 0 output**, D **0 / 0**. Missing usage for unsuccessful attempts is not imputed. USD cost is unknown.
Technical retries: **0**; API errors: **42**; collection errors: **0**.

## By case family

| Family | answerable | B correct | C correct | C rescue | C regression | C routed | C unsafe |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| account identity | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ad chain | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ad lifecycle | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ad targeting | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| ambiguous reference | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| audio control | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| buffer capacity | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| click handling | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| download cache | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| error reporting | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| event deduplication | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| event identity | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| feedback control | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| file integrity | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| identifier | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| image cache | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| impression state | 2 | 0 | 0 | 0 | 0 | 0 | 1 |
| layout asset | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| measurement metadata | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| network asset | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| out-of-scope | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| playable duration | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| request actor | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| request origin | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| response content | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| session timing | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| synchronization | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| text formatting | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| timer state | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| tracking beacon | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| video configuration | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| video control | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| video display | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| video timing | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

## Interpretation limits

- The current shipped eligibility helper requires an ambiguous verdict while G28 requires a strong verdict. Arm C is a frozen research composition, not the actual shipped route.
- The historical deterministic-first projection used ground truth to skip calls; this run uses only observable B-versus-baseline agreement.
- Jev changes preference only. It does not promote or lower the baseline verdict, and its uniqueness score is diagnostic. Therefore abstain safety depends entirely on the unchanged local verdict.
- Each case had one frozen API decision. Model consistency across independent successful calls is unmeasured; technical retries were only for transport/HTTP failure.
- Failure classes are post-run analysis. They were not used to change this holdout, prompt, route or thresholds.
