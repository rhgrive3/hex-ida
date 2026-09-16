# X-02 F-48 producer-pinned arm64e evidence

`X02-F-48` previously remained an evidence gap because the repository had no compiler-pinned real arm64e binary and the existing PAC fixtures were hand-layout inputs.

This checkpoint adds a compiler-produced Mach-O object generated from ordinary C with Clang 17.0.0 targeting `arm64e-apple-macos13.0` and `-msign-return-address=all`. The source and object are SHA-256 pinned in `tests/scpa/fixtures/x02-arm64e-authenticated-provenance.json`. A second compile from the same source and arguments produced the identical object hash before publication.

`tests/scpa/x02-arm64e-real-producer-evidence.test.mjs` verifies the source contains no inline assembly or encoded PAC constants, the raw Mach-O header identifies ARM64E with the PAC capability bit, the production loader reports `macho` / `arm64e` and the declared macOS 13.0 deployment target, and the compiler output contains PACIASP plus an authenticated return path.

This closes only the finite `X02-F-48` producer-pinned corpus evidence gap. It does **not** claim PAC authentication executed on Apple hardware, OS launch success, valid Apple signing, or an independent external oracle. `X02-F-47` remains environment-excluded, and the other external-evidence gaps remain open. With the prior six product-gap remediations unchanged, the finite 120-row current classification advances from `114 pass / 0 product-gap / 4 evidence-gap / 2 environment-excluded` to `115 pass / 0 product-gap / 3 evidence-gap / 2 environment-excluded`; the frozen historical matrix itself is not rewritten.
