# T041–T042 final-candidate evidence

**Observation date:** 2026-09-08
**Disposition:** `PENDING` — this record supplies exact local gate, browser, generated-output, and convergence inputs; it does not claim final-candidate acceptance.

## Candidate identity and source scope

Current primary: commit `b75874dbfb8d64167e84b1c83c8fbffdd0b54d91`, tree `9e7b1c164e69283a01a55dcdeaf19a5205142ec9`. The source/test/generated paths are unchanged from the exact product proof at `8e045342db6bd9596056942d49b994aad55b895e`, tree `df2fb9e524d960977d78b17d7667d792ca478f17`; the intervening diff is documentation/evidence only.

The T023 candidate `19c0e7868a15dc6574b213bf2706dc976c0be2b8` is a separate moving-main reconciliation candidate. Its narrow conflict and shadow proofs are retained separately. No full `npm run check`, release, or broad candidate PASS is inferred for that head.

## T041 generated-output evidence

The current primary tracked generated files match the outputs of `a5209e5bd` exactly. Current SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `userscript/hex.user.template.js` | `26cfa1b07ce5e2b46f1bbf0ab0f10855f1a2b81b4bee97fb1ac6dbad66abd31b4` |
| `userscript/release-version.json` | `ac86ea81dff1a850e86b1c342c83d1c02f59055b31e23c10e1b3ad402c22976d` |
| `js/userscript/deployment-identity.generated.js` | `3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252` |

The existing stage-a evidence records canonical generation twice with zero second-run tracked diff at the `a5209e5bd` generated-output transaction and `npm run userscript:test` PASS (49.1s). A final T041 closure still requires rerunning the canonical generator twice after the final candidate is fixed, recording the exact generated commit, deployment/build identity, and active deployment binding. This record does not promote the source-equivalent reuse to final-candidate proof.

## T042 exact local gate and browser evidence

The exact source `8e045342d` passed the canonical quiet local gate:

```text
node scripts/run-quiet-command.mjs --label check -- npm run check
check: PASS (2254.7s)
```

This includes the nested `npm test` and `benchmark:baseline`. Summary log: `/mnt/workspace/.dev-state/hex-development-batch/t021-check-8e045342d.log`; SHA-256 `1e39dd53f873466500284de5f60c463acd35fca593702d2c5453f98327a1e0c2`.

The applicable browser command omitted from the canonical chain passed once under the task browser environment:

```text
$HEX_NODE22 node scripts/run-quiet-command.mjs --label t021-ui-browser -- node tests/ui/browser.mjs
t021-ui-browser: PASS (88.6s)
```

Summary log: `/mnt/workspace/.dev-state/hex-development-batch/t021-ui-browser-8e045342d.log`; SHA-256 `704a41bc1c6343113a6dd59fd24f7e580fe7c005f3d89c07bcad4efaef95bf1b`.

These are exact source-equivalent development results for `b75874dbf`, because only evidence/docs changed afterward. They do not close T042 while the final candidate, release performance, external provenance, and protected-main chain remain incomplete.

## Convergence and final admission fields still open

- The 23-row roadmap implementation state is complete under the development-speed amendment. T042 remains pending because its exact final-candidate local gate and Spec Kit convergence evidence have not been produced on the final candidate; downstream T043/T044 admission and post-merge work are separate release steps.
- T040 must first provide current final-platform measurements and exact runtime/device/deployment identities. Physical iPad execution remains **DEFERRED**; no device PASS is claimed.
- T041 must regenerate and verify the final candidate after all source/candidate fixes, including zero second-run tracked diff and deployment identity.
- T043 still needs current exact-head CI/review/candidate-tree evidence. PR #7097 is currently open and Draft at head `b75874dbfb8d64167e84b1c83c8fbffdd0b54d91`, base `a5de478d7b74cf7d38946fecc9a24a22675c710d`, merge state `DIRTY`; six CircleCI contexts are successful, while CodeRabbit's success is a draft-review skip and `reviewDecision` is empty. No protected-main admission is inferred.
- T044 remains blocked on T043 and requires a protected merge, refetched-main ancestry, post-merge smoke/generated/runtime proof, and original-workspace/recovery-ref preservation.

This record intentionally records completed local evidence and exact remaining dependencies without changing task checkboxes or representing local development proof as release acceptance.


## Current c32 readiness binding — 2026-09-08

The final-candidate evidence now has a current identity packet for generated
head `c32ba8db0f93a98af084be52c67a263a7f2eaa00`, tree
`86509430e5bbd40fc66ef09176cb324ecc3ad5d4`, with source/generated parent
`78c9163af92ac69551833c11ef674c988ebcc109`.

The exact c32 browser receipt
(`/mnt/workspace/.dev-state/hex-development-batch/t040-browser-c32ba8-evidence/receipt.md`)
records the local UI browser gate PASS (102.1 seconds, exit 0). The exact c32
shadow receipt
(`/mnt/workspace/.dev-state/hex-development-batch/t023-t039-shadow-c32ba8db-receipt.md`)
records the six-case T045 proof and seven zero counters.

The committed generated outputs at c32 have these hashes:

| Artifact | SHA-256 |
| --- | --- |
| `userscript/hex.user.template.js` | `c163b4df69884a9c84c40c80d418d57aa59d19107df355248319fb00ee09d2af` |
| `userscript/release-version.json` | `07dc2f6cd20268890a0964b033ea6af1fe08303e0fd64bc9888064e3315c607e` |
| `js/userscript/deployment-identity.generated.js` | `3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252` |

The local release identity is `58779cf6aea475b3a00b07e8f0a134e86c5ee3dd41fa713015574d0e7d316710`,
build `ebc8b17d089137d2a79c8e98`, and local
`DEPLOYMENT_COMMIT` is `null`. The first and post-c32 generation logs are
retained at
`/mnt/workspace/.dev-state/hex-development-batch/t023-userscript-build-78c9163af.log`
and
`/mnt/workspace/.dev-state/hex-development-batch/t023-userscript-build-second-c32ba8db0.log`;
they agree on release/build identity, and the post-c32 `git diff --exit-code`
over the two tracked generated paths exited 0. This second-build result is
bound to c32. The local deployment binding remains absent, so T041 remains
**PENDING** rather than being promoted from these constituent facts; the 5d46
source successor also requires a new generated refresh.

PR #7097 is open and Draft at c32 against base
`8847eaa04e69fb528d6ebe6825a15d1dd4257f04`; its captured status/review packet
is `/mnt/workspace/.dev-state/hex-development-batch/t043-github-c32ba8/`.
No protected-main admission is inferred.

The c32 canonical full-check command terminated **FAIL after 709.9 seconds** at issue #5990 (`tests/issue-5990-riscv-identity-string-coercion.mjs`) after the Phase 6 corpus reached 334/334. No c32 full-check PASS is claimed. The focused repair is integrated locally at `5d46d550f5b999e662f07a70c5407b2877c8d82e`; T042 remains **PENDING** until the repaired candidate receives a new exact-head canonical result and Spec Kit convergence is recorded. That result would close only the local-gate constituent of T042, subject to the task contract's T040 and T041 dependencies; it would not waive missing performance, deployment, external-provenance, or deferred-device evidence.

## Successor after c32 failure — 2026-09-08

The 5d46 successor has 10 focused passing subtests across #5990, #6026, and
#5994, plus direct Phase 10 suffix passes for #5755 and #5760. Evidence is
retained at `/mnt/workspace/.dev-state/hex-development-batch/t023-issue5990-repair-c32-focused.log`
and `/mnt/workspace/.dev-state/hex-development-batch/t023-phase10-suffix-5d46.log`.
Generated refresh and the repaired-candidate canonical gate remain pending.

## Combined 97621 product observations — 2026-09-08

The generated successor is `97621a38e2f7fd18556faeaee79b6e1f97b8a8af`,
tree `dffc125f95794237327b9c3ce3d6e10f752e3b43`, with source parent
`9d0512cc620757f69d7abe044f3fcfa4b9193e22`. This supersedes the pending
generated-refresh observation above. The independent Luna review approves the
`5d46..97621` code delta, including focused FNV, provenance and CIL regressions.

- Local browser PASS: Chromium 254 checks and WebKit 126 checks, 380 total;
  `node tests/ui/browser.mjs` exited 0 on Node 22.20.0.
  Log: `/mnt/workspace/.dev-state/hex-development-batch/t040-browser-97621-evidence/browser.log`,
  SHA-256 `1f719524ddace92721727911a4f004693ed57424960e4173988e3bab2ef5d0ab`.
- T039/T045 shadow PASS: six locked cases MATCH; seven scoped counters are
  `0/1, 0/1, 0/1, 0/1, 0/6, 0/1, 0/1`, bound to the source parent above.
  Packet: `/mnt/workspace/.dev-state/hex-development-batch/t040-t039-shadow-97621-evidence/stdout.json`,
  SHA-256 `2bb92b38b61831172f83a8dcdcf4c8b8bf7e03ac68897ecadc7eb04ee5208c9f`.
- All six CircleCI contexts PASS on the documentation successor
  `92bbe2f1161e185c87f1098949585756ae8580f5`. The separate CodeRabbit success
  explicitly means draft review skipped; it is not review approval.
  API packet: `/mnt/workspace/.dev-state/hex-development-batch/t043-github-92bbe2f11/`.

The canonical full check on immutable 97621 completed **PASS in 2655.3 seconds**,
exit 0, with the same clean tree after the run. Owner session 72914 retained the
terminal PASS result. This canonical command includes `npm test` and
`benchmark:baseline`; neither requires a duplicate run. The successful quiet
wrapper deleted its temporary full log as designed. This closes the outstanding
97621 local full-check constituent, not a later source's exact-head release gate.

The later jsonSafe source change is integrated at `98a606df7`; its combined
`core:test` passed in 3.5 seconds. The handoff build passed in 3.8 seconds and
`userscript:test` passed in 135.0 seconds. The frozen performance handoff branch
`handoff/performance-20260908` is published at
`1b6d3eebf14e59a051169b1eb86220b05d303acf`, with the order in
`prompts/orders/2026-09-08-performance-improvement.ja.md` and a verified ZIP.

The owner transferred remaining performance work to another local AI. Local
performance optimization and collection are stopped; the unfinished origin.js
experiment stays outside the published handoff. The existing measured cold
result remains 379.479 ms against 250 ms and is not relabeled as a result for the
handoff source. T040–T044 retain their remaining performance/runtime/admission
requirements. Physical-device verification is DEFERRED until development ends.

## Non-performance reconciliation batch — 2026-09-08

Source merge `2d1d1b14b9943aedbda5d847d8d2e123cd05c0ac` incorporated pinned
main `5ba6f468e7fc2ff59f383146a1ebe3a2ca50cf71` into the development branch.
Six conflicts and the additional ABI/symbolic regressions were resolved; the
focused results and review inventory are recorded in `final-github.md`.

The generated product tested afterward is
`374a95719b4c67c872fcb6af92cd9faafb66c394`, tree
`a922116252a24601585152270f6a70efc0a89669`:

| Check | Result |
| --- | --- |
| Canonical lint | PASS, 7.2s |
| Local Chromium/WebKit browser matrix | PASS, 86.2s |
| Canonical userscript tests in an isolated copy | PASS, 50.6s |
| Template/release metadata after the test's canonical rebuild | Zero tracked diff against 374a95719 |

Browser summary: `/mnt/workspace/.dev-state/hex-development-batch/reconciled-374a95719-browser-summary.log`,
SHA-256 `60ea65d7d551c42ac8544567826b116e1414d20ad5e057c56c08e5c65d7b14ab`.
Userscript summary: `/mnt/workspace/.dev-state/hex-development-batch/reconciled-374a95719-userscript-ready-summary.log`,
SHA-256 `81f826ad1c7e563031341be88bef2b2a207c4aaf6ce03549f997f637cf163847`.
The first isolated userscript attempt stopped after 7.4s because its clone lacked
esbuild; after connecting the existing matching dependencies and verifying the
import, the canonical command was rerun and passed. No test was skipped.
The test's null-deployment comment-format overlay was preserved externally and
restored to the tracked local-unbound form; no deployed identity was assigned.
Primary remained clean during browser execution; the isolated test copy was
clean after that cleanup.

No new full `npm run check` or performance collector was run for this batch.
The earlier canonical full PASS remains bound to 97621. The next final full
verification belongs to the combined candidate after the external performance
work returns, not to repeated documentation commits or unrelated main movement.
The published performance handoff remains fixed at 1b6d3eebf. Performance work
and physical-device execution are not resumed by goal continuation.
