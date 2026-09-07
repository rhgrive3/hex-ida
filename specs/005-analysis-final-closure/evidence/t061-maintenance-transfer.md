# T061 maintenance transfer

This evidence records the bounded T061 maintenance transaction on the current
integration line. The original T052 handoff and accepted checkpoint ledger are
retained; only the reviewed T052 fixture and its Phase 12 denominator marker
contract receive the maintenance owner after publication.

| identity | value |
|---|---|
| current main | `d8fcdce58dfe03b15cfddcf23415ae01b088b647` |
| integration I | `fbd4b7c96901ae32c23a2e8b477c0e3e7cd0c713` |
| component C (final) | `44416c0f24f28059482c5b72e0c40bae620978cb` |
| candidate merge M | `d1c31fafb9703be57a00b522c453bbd0ffbee610` |
| M tree | `98a08df7ebcde46038e83db81c21341eeba0e6a5` |
| generated product G | `6dd9c614d2eb638156ca5984619790ff25733435` |
| G tree | `593d39ff8d7569399a25ede761de9743a4d28be0` |
| original T052 handoff | `0a521b282c6aa93afc94e0dfbfe701e705ccdf2a` |
| transferred fixture | `tests/final-closure/t052/canonical-operation-registry.test.mjs` |
| denominator contract | `tools/validation/phase12/denominator-inventory.json` |
| transfer preimage blob | `e808eb0ba83611ea3c147645f6070fcc3cd48823` |
| transfer postimage blob | `09a715039737d98ddef107ad477055b37bdde465` |

M has the ordered parents [I, C]. G has the single parent M and contains only
canonical generated-output changes (`userscript/hex.user.template.js` and
`userscript/release-version.json`). The generator was run twice; the second
tracked diff was empty. E is this evidence-only child of G.

The focused T052 canonical-operation suite, the actual-Git T061 maintenance
counterexamples, the existing final-closure regressions, and the full Phase 12
denominator suite passed in the isolated candidate. The maintenance transfer
verifier covers exact current-main blob replacement and addition, plus
arbitrary replacement rejection; the latter remains sealed. The current-main
replacement rule requires authenticated current-main and integration blob
identity and does not authorize generated paths or arbitrary blobs.

The LLVM 18 resolver wrapper was used for the Phase 12 binary inspection in this
local environment. No analysis markdown was entered or modified.
