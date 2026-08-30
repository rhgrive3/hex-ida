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

Current pre-implementation baseline at live main
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

Expected result: 33 passing tests. The locked matrix remains `66 PASS, 0 FAIL`.

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

## Generated and merge validation

If the final changed input surface has generated consumers, invoke the canonical
generator once, verify the expected diff, invoke it a second time, and require
zero additional diff. Fetch newest live main and validate the exact candidate
merge tree before merge. After merge, run the focused and owning subsystem tests
against live main and verify production, regressions, generated state, and Spec
Kit ledger are all present.
