# HEX-C3-02 Validation Quickstart

Run from the repository worktree at the exact intended head.

## Baseline proof

Historical baseline at `8a614ccd0184d6c25257c25d930b68af7e9ac81f`:

```sh
node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
```

Expected pre-fix result: `FAIL` (exit 1). The RISC-V row receives hard-coded
`AAPCS64` convention/locations, and the unsupported row lacks an explicit
`conventionKnown: false` contract.

Historical pre-implementation baseline at live main
`48a0b42913e63f33a03783f9676994268d8a06e8`:

```sh
node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
```

The first command fails 2 of 4 subtests (stale ABI identity and aggregate
piece grouping). The second command covers 66 rows and reports `54 PASS,
12 FAIL`; all failures are current prototype identity/aggregate projection
gaps, while direct canonical profile rows pass.

## Focused post-fix proof

Run the identical commands after implementation. They pass, and the tests also
assert that a selected profile's identity, argument/return pieces, hidden sret,
and completeness reach the prototype consumer. Paired negatives for unsupported,
stale, malformed, incomplete, conflict, cancellation, truncation, and
budget-limited evidence remain non-exact.

The implementation proof additionally runs:

```sh
node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
```

Expected result: 49 passing tests (45 boundary + 4 profile). The locked matrix
remains `66 PASS, 0 FAIL`.

The downstream-inclusive focused command adds the ABI prototype integration
regression and reports 50 passing tests (45 boundary + 4 profile + 1
integration):

```sh
node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs tests/phase8/integration/issue-2478-abi-prototype-recovery.test.mjs
```

The correction acceptance run also includes the profile-matrix file directly:

```sh
node --test tests/phase8/abi/hex-c3-02-boundaries.test.mjs \
  tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs \
  tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
```

The required-profile script is a separate locked harness and reports
`MATRIX_SUMMARY total=66 passed=66 failed=0`. The boundary/profile pair reports
49 passing tests; the boundary/profile/downstream pair reports 50 when the
profile-matrix test is included alongside the integration test. Use the
literal command and summary recorded by the final implementation ledger if a
future test file changes these counts.

## Profile and subsystem gates

Use the repository's existing phase commands after the focused test:

```sh
npm run phase5:test
npm run phase6:test
npm run phase8:test
```

Select the owning ABI/decompiler subsets during iteration; run all required
release/truth gates only after Spec Kit converge is CLEAN and both independent
reviews pass. Exact-head CI must reference the final PR head, not a historical
green SHA.

The correction run completed with Phase 5 `44/44` files and `279` tests,
Phase 6 `23/23` files and `116` tests, and Phase 8 `30/30` files and `327`
tests. The requested implementation base is
`42d472c310c12685e59dbf13a59e7572e8429ae2`; latest fetched `origin/main` is
the descendant `1645b4e4a2b5cd9baf37e2efe5b2e6045481b1aa` of requested
checkpoint `66a5640359c5b39526fb89f6937e023294e54bdd`. Their moving-main
comparison and candidate-tree result must be recorded before delivery.

## Generated and merge validation

The generated applicability decision is YES. The
`js/analysis/semantic-function-base.js` semantic path reaches the bundled
worker entrypoint used by `scripts/build-userscript.mjs`; generated consumers
therefore remain in scope even when the source change is in the shared
adapter. Restore the canonical dependency tree and run the canonical build
transaction only after the final source/candidate context is fixed:

```sh
npm ci
npm run userscript:build
git diff -- userscript/hex.user.template.js userscript/release-version.json
first_diff="$(git diff --binary -- userscript/hex.user.template.js userscript/release-version.json | sha256sum)"
npm run userscript:build
second_diff="$(git diff --binary -- userscript/hex.user.template.js userscript/release-version.json | sha256sum)"
test "$first_diff" = "$second_diff"
```

The first run may change only those canonical generated paths; matching diff
digests on the second run prove zero additional diff. Never hand-edit generated
output. If the build environment is unavailable, report the exact dependency/
build error as a blocker after attempting `npm ci`; do not relabel applicability
as N/A.

The C3-02 ownership gate is separate from the Phase 8 lane manifest and checks
the explicit 38-path inventory plus generated/governance ownership:

```sh
node tools/validation/c3-02-ownership.mjs --check-manifest
node tools/validation/c3-02-ownership.mjs \
  --base-sha 3ac625938333636bcc6c00634d2e21648778ce0f \
  --head-sha <c3-02-head>
```

Fetch newest live main and validate the exact candidate merge tree before
delivery. After delivery, run the focused and owning subsystem tests against
live main and verify production, regressions, generated state, and the Spec
Kit ledger are all present.
