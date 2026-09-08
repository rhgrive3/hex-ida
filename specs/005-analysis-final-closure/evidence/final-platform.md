# T040 final-platform evidence

**Observation date:** 2026-09-08
**Disposition:** `PENDING` — implementation and local contract preparation are complete; exact final-platform measurement, external provenance, active deployment/runtime, and physical-device evidence are still required. This record does not close T040.

## Exact source boundary

The current primary is commit `b75874dbfb8d64167e84b1c83c8fbffdd0b54d91`, tree `9e7b1c164e69283a01a55dcdeaf19a5205142ec9`. The reusable local product proof is bound to source commit `8e045342db6bd9596056942d49b994aad55b895e`, tree `df2fb9e524d960977d78b17d7667d792ca478f17`. A direct diff from `8e045342d` to `b75874dbf` contains only documentation/evidence paths; no product, test, or generated source path changed. The full and browser results below are therefore reused as source-equivalent development evidence under the speed amendment, not relabeled as a fresh release run.

The separate T023 candidate `19c0e7868a15dc6574b213bf2706dc976c0be2b8` is not used as broad T040 evidence. Its narrow merge/reproduction and shadow results do not establish a full candidate gate; no broad-pass claim is made for it.

## Completed implementation and focused contracts

- T045 final-platform contract implementation is recorded in `evidence/h9-contract-implementation.md` at implementation commits `ce991646e` and `a528302372373f334f8e289b588bc85a170dbf1b`. The contract requires all fourteen H9 rows, both runtime classes, exact fixture/repetition identities, finite raw samples, recomputed summaries, fixed targets, and physical peak-footprint trace identity.
- The Stage 2 verifier is wired to require both the identity-resolved physical scenario and the locked numeric packet. The focused command `node scripts/run-quiet-command.mjs --label h9-stage2-reviewed -- node tests/final-platform/run.mjs` passed in 0.9 seconds. These are contract fixtures and verifier tests; they are not physical measurements.
- T026 implementation is recorded in `evidence/t026-implementation.md`. Node 22 focused contracts pass: repository scorecard 3/3 and workload-twin/benchmark contracts 13/13. Missing current-head P5/P6/native-P8 producers, external BattleCats/TsumTsum/YWP source/compiler/debug identities, and P-COMPETITIVE threshold acceptance remain explicit `UNMEASURED` release debt.

## Reused exact local product evidence

The exact source `8e045342d` passed the canonical local gate once:

```text
node scripts/run-quiet-command.mjs --label check -- npm run check
check: PASS (2254.7s)
```

The command includes the package's nested `npm test` and `benchmark:baseline`. Summary log: `/mnt/workspace/.dev-state/hex-development-batch/t021-check-8e045342d.log`; SHA-256 `1e39dd53f873466500284de5f60c463acd35fca593702d2c5453f98327a1e0c2`.

The applicable browser command absent from that chain also passed once in the task browser environment:

```text
$HEX_NODE22 node scripts/run-quiet-command.mjs --label t021-ui-browser -- node tests/ui/browser.mjs
t021-ui-browser: PASS (88.6s)
```

Summary log: `/mnt/workspace/.dev-state/hex-development-batch/t021-ui-browser-8e045342d.log`; SHA-256 `704a41bc1c6343113a6dd59fd24f7e580fe7c005f3d89c07bcad4efaef95bf1b`. This is local browser evidence and does not prove an active deployed build or a physical iPad.

## Generated and identity evidence available for handoff

The generated files in primary `b75874dbf` are byte-identical to the generated files at `a5209e5bd` (`git diff --quiet` for all three tracked outputs). Their current SHA-256 values are:

| Artifact | SHA-256 |
| --- | --- |
| `userscript/hex.user.template.js` | `26cfa1b07ce5e2b46f1bbf0ab0f10855f1a2b81b4bee97fb1ac6dbad66abd31b` |
| `userscript/release-version.json` | `ac86ea81dff1a850e86b1c342c83d1c02f59055b31e23c10e1b3ad402c22976d` |
| `js/userscript/deployment-identity.generated.js` | `3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252` |

The existing stage-a evidence records two canonical builds with no second-run tracked diff for the `a5209e5bd` generated commit and `npm run userscript:test` PASS (49.1s). This is a source-equivalent handoff fact, not proof that a final candidate has been deployed or activated.

## Remaining T040 fields

1. Run the frozen fourteen-row H9 collector on the exact final candidate, recording both required runtime classes, raw samples, summaries, target/operator/unit, fixture/build/device identities, and denominator preservation.
2. Produce current-head P-COMPETITIVE/P5/P6/native-P8 measurements and threshold acceptance with the external source/compiler/debug identities required by T026. Existing captures remain historical or `UNMEASURED`.
3. Bind production-faithful WebKit/runtime observations to the exact generated build and active deployment identity. Local browser PASS is not activation proof.
4. Preserve the known performance debt: the retained Node 22 T013 observation at `f853691e56504eed35b3893ab8f7dbc573816fe4` failed cold and optimizer thresholds (1571.855 ms > 250 ms; 340.907 ms > 150 ms). It is not relabeled as a result for `b75874dbf` or `19c0e786`.
5. Physical iPad execution is **DEFERRED** under the owner-authorized guardrail amendment. No physical PASS is claimed.

T040 remains pending until the exact final-product measurement and required runtime/device identity fields are present; no threshold or denominator is waived here.


## Current c32 constituent evidence — 2026-09-08

The current generated candidate is `c32ba8db0f93a98af084be52c67a263a7f2eaa00`,
tree `86509430e5bbd40fc66ef09176cb324ecc3ad5d4`; its generated-output parent
and source authority is `78c9163af92ac69551833c11ef674c988ebcc109`.

The current exact-head local browser packet
(`/mnt/workspace/.dev-state/hex-development-batch/t040-browser-c32ba8-evidence/receipt.md`)
records `tests/ui/browser.mjs` PASS, exit 0, in 102.1 seconds with Node
22.20.0, Playwright 1.62.1, and the task-owned browser environment. The
current exact-source T039/T045 shadow packet
(`/mnt/workspace/.dev-state/hex-development-batch/t023-t039-shadow-c32ba8db-receipt.md`)
records six locked projection MATCH results and seven zero counters. These
are current local/browser/shadow constituent proofs; neither is deployment or
physical-device activation evidence.

The c32 generated artifact packet records these current hashes and local build
identity:

| Artifact | SHA-256 |
| --- | --- |
| `userscript/hex.user.template.js` | `c163b4df69884a9c84c40c80d418d57aa59d19107df355248319fb00ee09d2af` |
| `userscript/release-version.json` | `07dc2f6cd20268890a0964b033ea6af1fe08303e0fd64bc9888064e3315c607e` |
| `js/userscript/deployment-identity.generated.js` | `3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252` |

The release file identifies build `ebc8b17d089137d2a79c8e98` and release
identity `58779cf6aea475b3a00b07e8f0a134e86c5ee3dd41fa713015574d0e7d316710`;
the local generated deployment binding remains `DEPLOYMENT_COMMIT = null`.
The exact captured hashes are also retained at
`/mnt/workspace/.dev-state/hex-development-batch/t043-github-c32ba8/generated-hashes.json`.

The post-c32 canonical userscript build retained the same tracked generated
files, and `git diff --exit-code` over the two generated paths exited 0. The
build output is retained at
`/mnt/workspace/.dev-state/hex-development-batch/t023-userscript-build-second-c32ba8db0.log`.
This second-build result is bound to c32; the later 5d46 source repair requires
a new generated refresh.

T040 remains **PENDING**. The fourteen H9 numeric rows, current-head
P-COMPETITIVE/P5/P6/native-P8 measurements and external provenance, and
production-faithful active deployment/runtime identity are still absent.
Physical iPad execution remains **DEFERRED_BY_OWNER** under the guardrail
amendment; no physical PASS is claimed. The c32 canonical full-check command
terminated **FAIL after 709.9 seconds** at issue #5990
(`tests/issue-5990-riscv-identity-string-coercion.mjs`) after Phase 6 corpus
334/334; this is a real current-head failure, not a measurement or gate PASS.

## Successor after c32 failure — 2026-09-08

The focused successor fix is integrated locally at
`5d46d550f5b999e662f07a70c5407b2877c8d82e`. Node 22 evidence records 10
focused passing subtests across #5990, #6026, and #5994, plus direct Phase 10
suffix passes for #5755 and #5760. The focused logs are
`/mnt/workspace/.dev-state/hex-development-batch/t023-issue5990-repair-c32-focused.log`
and `/mnt/workspace/.dev-state/hex-development-batch/t023-phase10-suffix-5d46.log`.
Generated output must be refreshed for this successor before any new exact-head
candidate gate; T040 remains **PENDING**.


## Completed CPU measurement on repaired source 5d46 — 2026-09-08

The immutable repaired source `5d46d550f5b999e662f07a70c5407b2877c8d82e`,
tree `c992886c4a15a30fb2fcd759a578c6f232c7cdf9`, completed the canonical
`performanceMetrics({ repetitions: 3, corpus })` timing API in 324.629 seconds
with Node 22.20.0 and LLVM/Clang 18.1.3. The worktree remained clean.
`current-cpu-performance.json` retains all 405 raw samples, the frozen 135-function
and 125-applicable-function denominators, runtime/profile identities, and the
full observation digest. Aggregate values were recomputed from those samples.

| Metric | Median | Limit | Result |
| --- | ---: | ---: | --- |
| Cold active function | 359.341 ms | 250 ms | FAIL |
| Interactive Phase 8 | 0.445 ms | 5 ms | PASS |
| Optimizer Phase 8 | 93.683 ms | 150 ms | PASS |

The unpublished optimizer count is zero. The remaining CPU performance defect
is cold decompilation; profiling and its production repair precede the next full
performance measurement. This observation supersedes older CPU timings for this
source without asserting a controlled speedup or changing thresholds. It does not
close T040's external-binary, H9, or deployed-runtime requirements. Physical-device
execution remains deferred by the owner.


## Combined-source CPU measurement 97621 — 2026-09-08

After integrating the FNV arithmetic, provenance cache/sort, and CIL repairs,
source `97621a38e2f7fd18556faeaee79b6e1f97b8a8af` (tree
`dffc125f95794237327b9c3ce3d6e10f752e3b43`) completed the same 405-sample
measurement in 351.668 seconds. Both the 135-function and 125-applicable-function
denominators are unchanged. The source remained clean.

- Cold median: **379.479 ms > 250 ms — FAIL**.
- Interactive median: **0.467 ms <= 5 ms — PASS**.
- Optimizer median: **106.739 ms <= 150 ms — PASS**.
- Unpublished optimizer count: **0**.

`current-cpu-performance.json` now records this observation and all raw samples.
The full packet SHA-256 is
`1031b672a1a537dc6916345849b5e4ab4681a5274766356291289b90efd457a0`.
Aggregate improvement has not been established. The next action is to profile
the repaired source and verify a causal cold-path improvement before another
complete measurement. No threshold, denominator, or release claim changed.

The collector's output-directory argument was corrected by temporarily relocating
its open log directory while the process continued; the completed JSON was then
restored without changing its content. The command completed with exit 0. The
external `output-path-recovery.txt` preserves that recovery, and the corrected
reusable launcher fixes the output filename before starting expensive work.
