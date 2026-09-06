# T061 maintenance transfer

This evidence records the bounded T061 maintenance transaction on the current
integration line. The original T052 handoff and accepted checkpoint ledger are
retained; only the reviewed T052 fixture and its Phase 12 denominator marker
contract receive the maintenance owner after publication.

| identity | value |
|---|---|
| current main | `d8fcdce58dfe03b15cfddcf23415ae01b088b647` |
| integration I | `291639bfc427a3e06236305672ab65997ceb3b44` |
| component C (final) | `ba8a5fd4f21ab085003d7ed788897b572c5c6219` |
| candidate merge M | `3f227eaff4ef06c6f999f6045578c7f201505fae` |
| M tree | `ecbca3d344e2a929bdcd444b78ea464724396f51` |
| generated product G | `5ddefee55942385cac41c4f7e67badd18c7c4577` |
| G tree | `7b1b5c345edd43e9cb50ec92e403afb35bd0dafc` |
| original T052 handoff | `0a521b282c6aa93afc94e0dfbfe701e705ccdf2a` |
| transferred fixture | `tests/final-closure/t052/canonical-operation-registry.test.mjs` |
| denominator contract | `tools/validation/phase12/denominator-inventory.json` |
| transfer preimage blob | `e808eb0ba83611ea3c147645f6070fcc3cd48823` |
| transfer postimage blob | `09a715039737d98ddef107ad477055b37bdde465` |

M has the ordered parents `[I, C]`. G has the single parent M and contains only
canonical generated-output changes (`userscript/hex.user.template.js` and
`userscript/release-version.json`). The generator was run twice; the second
tracked diff was empty. E is this evidence-only child of G.

The focused T052 canonical-operation suite passed 6/6. The actual-Git T061
maintenance fixture passed 25/25 with Git 2.49.1. The Phase 12 denominator
regression passed with 68 units, 63 exact, 5 normative exclusions, and zero
blocking gaps; the full Phase 12 suite passed 48/48. The handoff verifier
regression covers exact current-main blob replacement and addition, plus
arbitrary replacement rejection; the latter remains sealed. The current-main
replacement rule requires an authenticated `currentMainSha` and exact
integration/main blob identity; when the sealed snapshot already contains the
path, its blob must differ. It does not authorize generated paths or arbitrary
integration blobs.
