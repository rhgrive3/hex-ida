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
