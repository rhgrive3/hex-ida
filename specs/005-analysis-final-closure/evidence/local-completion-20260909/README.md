# Local development completion — 2026-09-09

**COMPLETE: 53/53 applicable tasks.** Four retired administrative and four
external-release task IDs remain as explicit non-checkbox history. They are
excluded by the owner's scope, not represented as executed or passing tests.

Performance improvement, profiling, and 250 ms target work are finished. External
CI/review, protected-main promotion, deployment, external provenance, and physical
device acceptance are outside this development handoff.

## Delivered product

The supplied ZIP was compared file-by-file with the fixed handoff and its four-file
patch integrated without conflict. Only verified bug fixes followed: origin mapper
validation, malformed ELF extended symbol-index tables, obsolete shared-cache
epochs, and superseded symbol-generation producers. Existing assertions were not
weakened. Original input and all successive file hashes are in [import.json](import.json).

- Input ZIP SHA-256: `f56ecdfb29b7b147e69abc85df459483130e6e16e6032a63f9574aeceab57612`.
- Final source: `f9cb38d33e7ba5e199ff8e4f648eb19edae7b015`.
- Final generated candidate: `4b04bfa266e9d00a0c6ededd7899de3e1327968d`.
- Candidate tree: `edef6fbb43bf07df4b7a2301ad11ea0679be83cd`.
- Release identity: `2ab05c3b257914eee7c3ba3db25773e8761cd23b4487a422658c0a16bddcf049`; build `7ba7dc0a5a1dcc52228f58b0`.
- Local deployment identity remains null. No deployment is claimed.

## Verification

| Check | Result |
| --- | --- |
| Origin regression tests | PASS 16/16; core contracts PASS |
| Existing ELF #4472 / #4475 regressions | PASS 3/3 and 2/2 |
| Corrected shared-cache Phase7 suite | PASS, 162.5 s |
| Final `npm test` at `4b04bfa26` | PASS, 182.0 s |
| Final lint | PASS, 3.8 s |
| Final userscript build / test | PASS, 7.6 s / 61.6 s |
| Repeat generated template/release-version comparison | Zero tracked diff |
| Final Chromium/WebKit UI browser suite | PASS, 87.2 s |
| Final-platform numeric evidence contract | PASS, 2.1 s; no fresh measurements |
| Canonical command constituents | 18/18 passing source-bound outcomes, with corrected Phase7 and final regression |
| Local task / requirements-quality consistency | 53/53 applicable; all 61 IDs retained; quality checklists 44/44 |

[Command coverage](command-coverage.json) records which source each check tested.
The only product-source change after `bedca214a` was the shared-app-artifacts repair;
its Phase7 suite, final regression chain, generated output and UI/userscript runtime
were revalidated. Unchanged subsystem results are retained under the development
amendment. **No single exact-final `npm run check` or release-admission PASS is
claimed.** Earlier serial whole-check failures remain recorded as failures at
subsequently repaired defects. Supplier timings describe the supplier's environment
and source; they are not fresh measurements of this repaired candidate.

## Resolved setup and failure history

The imported candidate's initial whole run was stopped after local review found
the mapper bug. A later isolated run lacked `origin/main`; restoring the recorded
already-integrated base `5ba6f468e7fc2ff59f383146a1ebe3a2ca50cf71` made the exact
failing oracle test pass (12.7 s). The retained [launcher](run-recorded-local-check.sh)
preflights source/base identity, ancestry, a clean tracked tree, Node 22 and dependencies.
This pinned local reference is not a fresh-main admission claim.

Subsequent full runs exposed the ELF and shared-cache regressions; their fixes
passed existing regressions and affected suites. Remaining canonical commands were
then all executed without fail-fast interruption. The final source received the
regression and runtime checks above. Test-only deployment overlays were preserved
locally and restored to the committed null identity before accepted browser runs.

## Publication

Delivery branch: `perf/development-gate-policy` on `github`. Publication is recorded
by the final evidence commit and remote-ref verification. The original workspace
and supplied ZIP are preserved. The older performance handoff remains fixed at
`1b6d3eebf14e59a051169b1eb86220b05d303acf`.

A helper accidentally applied the shared-cache patch to the original workspace
through a relative edit path. The helper confirmed ownership of that diff; it
was backed up, verified against the observed hash and unchanged original HEAD
blob, then only that file was restored. The accepted implementation remains in
this development branch. The supplied ZIP was verified byte-unchanged.
